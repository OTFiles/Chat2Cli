import { createBaseHeaders, DEEPSEEK_BASE_URL, refreshAccountToken } from "./auth.js";
import { solvePowChallenge } from "./pow-solver.js";
import { createSseParser } from "../../utils/sse.js";

const POW_PROTECTED_PATHS = new Set(["/api/v0/chat/completion", "/api/v0/file/upload_file"]);

function buildTargetUrl(path, query) {
  const url = new URL(path, DEEPSEEK_BASE_URL);
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  return url;
}

async function createPowHeader(account, path) {
  const response = await fetch(`${DEEPSEEK_BASE_URL}/api/v0/chat/create_pow_challenge`, {
    method: "POST",
    headers: createBaseHeaders(account.token, { "content-type": "application/json" }),
    body: JSON.stringify({ target_path: path })
  });
  const payload = await response.json();
  const challenge = payload.data.biz_data.challenge;
  const solved = await solvePowChallenge({ ...challenge, expireAt: challenge.expire_at });
  return Buffer.from(JSON.stringify({
    algorithm: solved.algorithm, challenge: solved.challenge,
    salt: solved.salt, answer: solved.answer, signature: solved.signature, target_path: path
  })).toString("base64");
}

async function performRequest({ account, method, path, query, body, headers }) {
  const finalHeaders = createBaseHeaders(account.token, headers);
  if (POW_PROTECTED_PATHS.has(path)) finalHeaders["x-ds-pow-response"] = await createPowHeader(account, path);
  return fetch(buildTargetUrl(path, query), { method, headers: finalHeaders, body });
}

async function maybeRefreshAccount(response, account) {
  const contentType = response.headers.get("content-type") ?? "";
  // SSE 流：直接放行（调用方消费流）
  if (contentType.includes("text/event-stream")) {
    // 仍需验证 body 可读（clone 避免消费原始流）
    if (!response.body) {
      throw new Error("DeepSeek 返回空响应体");
    }
    return { refreshedAccount: account, response };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const payloadText = buffer.toString("utf8").trim();

  // 空响应或非 JSON 响应不触发 token 刷新（HttpError 由调用方处理）
  let payload = null;
  if (contentType.includes("application/json") && payloadText) {
    try { payload = JSON.parse(payloadText); } catch { /* ignore malformed JSON */ }
  }
  const shouldRefresh = payload?.code === 40002 || payload?.code === 40003;
  if (!shouldRefresh) return { refreshedAccount: account, response: new Response(buffer, { headers: response.headers, status: response.status }) };
  const refreshedAccount = await refreshAccountToken(account);
  return { refreshedAccount, response: null };
}

export async function proxyDeepseekRequest(options) {
  const { account } = options;
  const initialResponse = await performRequest(options);
  const firstPass = await maybeRefreshAccount(initialResponse, account);
  if (firstPass.response) return firstPass;
  const retriedResponse = await performRequest({ ...options, account: firstPass.refreshedAccount });
  const secondPass = await maybeRefreshAccount(retriedResponse, firstPass.refreshedAccount);
  if (!secondPass.response) throw new Error("DeepSeek Token 刷新失败，请重新登录");
  return secondPass;
}

// --- Session 操作 ---

const JSON_HEADERS = Object.freeze({ "content-type": "application/json" });

async function readPayload(response) {
  // 先尝试获取原始文本，避免 JSON 解析空 body 时报 "Unexpected end of JSON input"
  let text;
  try { text = await response.text(); } catch { text = ""; }
  if (!text || !text.trim()) {
    throw new Error(`DeepSeek 返回空响应 (HTTP ${response.status})`);
  }
  if (!response.ok) {
    // 尝试解析错误消息
    try {
      const errPayload = JSON.parse(text);
      const msg = errPayload?.data?.biz_msg || errPayload?.msg || errPayload?.message || JSON.stringify(errPayload).slice(0, 200);
      throw new Error(`DeepSeek 请求失败 HTTP ${response.status}: ${msg}`);
    } catch (e) {
      if (e.message.includes("DeepSeek")) throw e;
      throw new Error(`DeepSeek 请求失败 HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
  }
  let p;
  try { p = JSON.parse(text); } catch { throw new Error(`DeepSeek 响应解析失败: ${text.slice(0, 200)}`); }
  if (p.data?.biz_code !== 0) {
    throw new Error(p.data?.biz_msg || p.msg || `DeepSeek 请求失败 (biz_code=${p.data?.biz_code})`);
  }
  return p;
}

export async function createChatSession(account) {
  const { response } = await proxyDeepseekRequest({ account, method: "POST", path: "/api/v0/chat_session/create", body: Buffer.from(JSON.stringify({})), headers: JSON_HEADERS });
  const p = await readPayload(response);
  return p.data.biz_data.chat_session.id;
}

export async function deleteChatSession(account, chatSessionId) {
  const { response } = await proxyDeepseekRequest({ account, method: "POST", path: "/api/v0/chat_session/delete", body: Buffer.from(JSON.stringify({ chat_session_id: chatSessionId })), headers: JSON_HEADERS });
  await readPayload(response);
}

export async function deleteAllChatSessions(account) {
  const { response } = await proxyDeepseekRequest({ account, method: "POST", path: "/api/v0/chat_session/delete_all" });
  await readPayload(response);
}

// --- 搜索 ---

/** 将 parts 数组拼接为纯文本 */
function partsToText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => p?.text ?? "").join("");
}

/** 将 parts 数组转为带高亮标记的片段列表 */
function partsToSnippets(parts, maxLen = 120) {
  if (!Array.isArray(parts)) return [{ text: "", highlights: [] }];
  const result = [];
  let total = 0;
  for (const p of parts) {
    const text = p?.text ?? "";
    if (!text) continue;
    const remaining = maxLen - total;
    if (remaining <= 0) break;
    const truncated = text.length > remaining ? text.slice(0, remaining) + "…" : text;
    result.push({ text: truncated, highlight: Boolean(p?.highlight) });
    total += truncated.length;
    if (text.length > remaining) break;
  }
  if (!result.length) result.push({ text: "", highlight: false });
  return result;
}

/**
 * 搜索 DeepSeek 会话索引
 * POST /api/v0/index/query 返回 SSE (text/event-stream)
 * 返回搜索结果数组
 */
export async function searchIndexSessions(account, query) {
  const { response } = await proxyDeepseekRequest({
    account,
    method: "POST",
    path: "/api/v0/index/query",
    body: Buffer.from(JSON.stringify({ query, before_seq_id: null })),
    headers: JSON_HEADERS
  });

  const results = [];
  const decoder = new TextDecoder();

  const parser = createSseParser(({ event, data }) => {
    if (!data) return;
    if (event !== "item") return;
    try {
      const item = JSON.parse(data);
      const title = item.chat_session_title ? partsToText(item.chat_session_title.parts) : "";
      const contentSnippet = item.content ? partsToText(item.content.parts) : "";
      results.push({
        sessionId: item.chat_session_id || "",
        title: title || "未命名",
        titleSnippets: item.chat_session_title ? partsToSnippets(item.chat_session_title.parts, 80) : [{ text: title || "未命名", highlight: false }],
        contentSnippet: contentSnippet.slice(0, 200),
        contentSnippets: item.content ? partsToSnippets(item.content.parts, 150) : [{ text: contentSnippet.slice(0, 150), highlight: false }],
        messageRole: item.message_role || "",
        messageId: item.message_id,
        isThink: Boolean(item.is_think),
        timestamp: item.timestamp,
        seqId: item.seq_id
      });
    } catch { /* skip malformed items */ }
  });

  if (!response.body) return results;

  for await (const chunk of response.body) {
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.flush();

  return results;
}

/**
 * 获取 DeepSeek 账号的会话列表（一页）
 * 参照 deepseek2api session-workspace.js fetchSessionsPage
 * 使用游标分页：lte_cursor.updated_at
 */
export async function fetchSessionPage(account, updatedAtCursor) {
  const now = Math.floor(Date.now() / 1000);
  const cursor = updatedAtCursor ?? (now + 300);
  const path = "/api/v0/chat_session/fetch_page";
  const query = {
    "lte_cursor.pinned": false,
    "lte_cursor.updated_at": cursor,
    count: 50
  };
  const { response } = await proxyDeepseekRequest({
    account, method: "GET", path, query, headers: JSON_HEADERS
  });
  const p = await readPayload(response);
  const bizData = p.data?.biz_data || {};
  const list = (bizData.chat_sessions || []).map((s) => ({
    id: s.id,
    title: s.title || s.last_message_summary || "未命名",
    pinned: Boolean(s.pinned),
    updatedAt: s.last_update_time || s.updated_at || ""
  }));
  return {
    sessions: list,
    hasMore: Boolean(bizData.has_more),
    lastUpdatedAt: list.length > 0 ? list[list.length - 1].updatedAt : null
  };
}

/**
 * 将 DeepSeek 的 fragments 解析为 thinking / response 文本
 * 参考 deepseek2api public/deepseek-message.js: mapHistoryMessage
 */
function fragmentsToParts(fragments) {
  if (!Array.isArray(fragments)) return { content: "", thinking: "" };
  let content = "", thinking = "";
  for (const f of fragments) {
    if (!f?.content) continue;
    const kind = f.type === "THINK" ? "thinking" : "response";
    if (kind === "thinking") thinking += f.content;
    else content += f.content;
  }
  return { content, thinking };
}

/**
 * 获取某个 DS 会话的历史消息
 * GET /api/v0/chat/history_messages?chat_session_id=xxx
 * 参考 deepseek2api: session-workspace.js loadHistory()
 * 返回 { messages, currentMessageId }
 */
export async function fetchSessionMessages(account, chatSessionId) {
  const path = "/api/v0/chat/history_messages";
  const { response } = await proxyDeepseekRequest({
    account, method: "GET", path,
    query: { chat_session_id: chatSessionId },
    headers: JSON_HEADERS
  });
  const p = await readPayload(response);
  const bizData = p.data?.biz_data || {};

  // 参考 deepseek2api: biz_data.chat_messages (数组) + biz_data.chat_session.current_message_id
  const rawMessages = bizData.chat_messages || [];
  const currentMessageId = bizData.chat_session?.current_message_id || null;

  const messages = rawMessages.map((m) => {
    const { content, thinking } = fragmentsToParts(m.fragments);
    return {
      role: m.role === "USER" ? "user" : "assistant",
      content: m.content || content || "",
      thinking,
      messageId: m.message_id || null,
    };
  });

  return { messages, currentMessageId };
}
