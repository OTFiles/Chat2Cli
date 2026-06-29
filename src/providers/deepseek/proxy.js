import { createBaseHeaders, DEEPSEEK_BASE_URL, refreshAccountToken } from "./auth.js";
import { solvePowChallenge } from "./pow-solver.js";

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
  if (contentType.includes("text/event-stream")) return { refreshedAccount: account, response };
  const buffer = Buffer.from(await response.arrayBuffer());
  const payloadText = buffer.toString("utf8");
  const payload = contentType.includes("application/json") ? JSON.parse(payloadText) : null;
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
  const p = await response.json();
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

/**
 * 获取 DeepSeek 账号的会话列表页
 * 参照原项目 session-workspace.js 的调用方式：
 * GET /api/v0/chat_session/fetch_page?lte_cursor.pinned=false&lte_cursor.updated_at=xxx&count=50
 */
export async function fetchSessionPage(account) {
  const path = "/api/v0/chat_session/fetch_page";
  const query = {
    "lte_cursor.pinned": false,
    "lte_cursor.updated_at": Math.floor(Date.now() / 1000) + 300,
    count: 50
  };
  const { response } = await proxyDeepseekRequest({
    account,
    method: "GET",
    path,
    query,
    headers: JSON_HEADERS
  });
  const p = await response.json();
  if (!p?.data?.biz_data) throw new Error("无法解析会话列表响应");
  const list = p.data.biz_data.chat_sessions || [];
  return {
    sessions: list.map((s) => ({
      id: s.id,
      title: s.title || s.last_message_summary || "未命名",
      pinned: Boolean(s.pinned),
      updatedAt: s.last_update_time || s.updated_at || ""
    })),
    total: p.data.biz_data.total || list.length
  };
}

/**
 * 获取某个 DS 会话的历史消息
 */
export async function fetchSessionMessages(account, chatSessionId) {
  const path = "/api/v0/chat/history_messages";
  const { response } = await proxyDeepseekRequest({
    account, method: "POST", path,
    body: Buffer.from(JSON.stringify({ chat_session_id: chatSessionId })),
    headers: JSON_HEADERS
  });
  const p = await readPayload(response);
  const msgs = p.data?.biz_data || [];
  return msgs.map((m) => ({
    role: m.role === "USER" ? "user" : "assistant",
    content: m.content || "",
    thinking: m.sections?.filter((s) => s.kind === "thinking").map((s) => s.content).join("") || "",
    messageId: m.message_id || null
  }));
}
