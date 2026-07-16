import { randomUUID, randomBytes, createHash } from "node:crypto";
import { BaseProvider } from "../base.js";
import { getStore, updateStore } from "../../storage/store.js";
import { createId } from "../../utils/id.js";
import { buildPromptFromMessages } from "../../bridge.js";

const QWEN_BASE_URL = "https://chat.qwen.ai";

/** 静态兜底模型列表（失效时使用动态拉取的列表覆盖） */
let QWEN_MODELS = [
  { id: "qwen3.7-max", label: "Qwen 3.7 Max" },
  { id: "qwen3.7-plus", label: "Qwen 3.7 Plus" },
  { id: "qwen3.6-plus", label: "Qwen 3.6 Plus" },
  { id: "qwen3.5-plus", label: "Qwen 3.5 Plus" },
  { id: "qwen3.5-flash", label: "Qwen 3.5 Flash" },
];

// ── 能力后缀常量 ──
const CAPABILITY_SUFFIXES = ["-thinking-search", "-image-edit", "-deep-research", "-thinking", "-search", "-video", "-image"];

function genRequestId() {
  return randomUUID();
}

function genFid() {
  return randomBytes(16).toString("hex");
}

function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/json",
    "x-request-id": genRequestId(),
    Referer: `${QWEN_BASE_URL}/`,
    Origin: QWEN_BASE_URL,
    Connection: "keep-alive",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
}

// ═══════════════════════════════════════════════════
//  模型名解析（拆分基础模型 + 能力后缀）
// ═══════════════════════════════════════════════════

function splitModelSuffix(modelId) {
  const name = String(modelId || "");
  for (const suffix of CAPABILITY_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return { baseModel: name.slice(0, -suffix.length), suffix };
    }
  }
  return { baseModel: name, suffix: "" };
}

/**
 * 从模型后缀确定 chat_type
 *  -image → t2i
 *  -video → t2v
 *  -image-edit → image_edit
 *  -search → search
 *  其他 → t2t
 */
function resolveChatType(modelId) {
  if (!modelId) return "t2t";
  if (modelId.includes("-image-edit")) return "image_edit";
  if (modelId.includes("-video")) return "t2v";
  if (modelId.includes("-image")) return "t2i";
  if (modelId.includes("-search")) return "search";
  return "t2t";
}

/** 返回 strip 后缀后的上游模型 ID */
function resolveUpstreamModelId(modelId, cachedModels) {
  if (!modelId) return modelId;
  const { baseModel } = splitModelSuffix(modelId);
  // 尝试在缓存中匹配
  const models = cachedModels || QWEN_MODELS;
  const match = models.find(m => {
    const normalized = String(m.id || "").trim().toLowerCase();
    return normalized === baseModel.trim().toLowerCase()
      || normalized === modelId.trim().toLowerCase();
  });
  return match?.id || baseModel;
}

// ═══════════════════════════════════════════════════
//  会话管理
// ═══════════════════════════════════════════════════

/** 创建 Qwen 会话 */
async function createChatSession(token, model, chatType = "t2t") {
  const ts = Math.floor(Date.now() / 1000);
  const body = {
    title: `api_${ts}`,
    models: [model],
    chat_mode: "normal",
    chat_type: chatType,
    timestamp: ts,
  };

  const resp = await fetch(`${QWEN_BASE_URL}/api/v2/chats/new`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 401 || resp.status === 403) {
      const err = new Error("Qwen token 已失效");
      err.status = resp.status;
      err._tokenExpired = true;
      throw err;
    }
    throw new Error(`创建 Qwen 会话失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const chatId = data?.data?.id;
  if (!chatId) {
    throw new Error("Qwen 创建会话失败：未返回 chat_id");
  }
  return chatId;
}

/** 删除 Qwen 会话 */
async function deleteChatSession(token, chatId) {
  if (!token || !chatId) return;
  try {
    await fetch(`${QWEN_BASE_URL}/api/v2/chats/${chatId}`, {
      method: "DELETE",
      headers: buildHeaders(token),
    });
  } catch {
    // 静默忽略删除错误
  }
}

// ═══════════════════════════════════════════════════
//  Payload 构建
// ═══════════════════════════════════════════════════

/** 从 options 中解析搜索/思考开关 */
function resolveThinkingSearch(options, modelId) {
  const thinkingEnabled = options.thinkingEnabled !== false
    && !(modelId || "").includes("-thinking");
  const thinkingEnabledBySuffix = (modelId || "").includes("-thinking");
  const finalThinking = thinkingEnabledBySuffix || thinkingEnabled;

  const searchEnabled = options.enableSearch === true
    || (modelId || "").includes("-search");

  return { finalThinking, searchEnabled };
}

/** 构建 Qwen 聊天请求 payload */
function buildQwenPayload(chatId, model, prompt, options = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const fid = genFid();
  const childId = genFid();

  const { finalThinking, searchEnabled } = resolveThinkingSearch(options, model);

  const featureConfig = {
    thinking_enabled: finalThinking,
    output_schema: "phase",
    research_mode: "normal",
    auto_thinking: finalThinking,
    thinking_mode: finalThinking ? "Auto" : "Disabled",
    thinking_format: "detail",
    auto_search: searchEnabled,
    code_interpreter: false,
    plugins_enabled: false,
    function_calling: false,
    enable_tools: false,
    enable_function_call: false,
    tool_choice: "none",
  };

  return {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model,
    parent_id: null,
    messages: [
      {
        fid,
        parentId: null,
        childrenIds: [childId],
        role: "user",
        content: prompt,
        user_action: "chat",
        files: [],
        timestamp: ts,
        models: [model],
        chat_type: "t2t",
        feature_config: featureConfig,
        extra: { meta: { subChatType: "t2t" } },
        sub_chat_type: "t2t",
        parent_id: null,
      },
    ],
    timestamp: ts,
  };
}

// ═══════════════════════════════════════════════════
//  图片/视频生成
// ═══════════════════════════════════════════════════

/**
 * 从 SSE 响应中提取图片/视频 URL
 * 参照 Qwen2API chat.image.video.js
 */
function extractResourceUrlFromText(text) {
  if (!text) return null;
  // Markdown 图片
  const mdMatch = text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i);
  if (mdMatch) return mdMatch[1];
  // 普通 URL
  const urlMatch = text.match(/https?:\/\/[^\s<>"')\]]+/i);
  return urlMatch ? urlMatch[0] : null;
}

function extractResourceUrlFromPayload(payload) {
  if (!payload) return null;
  if (typeof payload === "string") {
    try {
      return extractResourceUrlFromPayload(JSON.parse(payload));
    } catch {
      return extractResourceUrlFromText(payload);
    }
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const url = extractResourceUrlFromPayload(item);
      if (url) return url;
    }
    return null;
  }
  if (typeof payload !== "object") return null;

  // 直接候选字段
  for (const key of ["content", "url", "image", "video", "video_url", "download_url", "file_url", "resource_url", "output_url", "result_url"]) {
    const url = extractResourceUrlFromPayload(payload[key]);
    if (url) return url;
  }
  // extra.image_list
  const imageList = payload?.extra?.image_list;
  if (Array.isArray(imageList)) {
    for (const img of imageList) {
      if (img?.image) return img.image;
    }
  }
  // 递归嵌套
  for (const key of ["data", "message", "delta", "extra", "choices", "output", "result", "urls"]) {
    const url = extractResourceUrlFromPayload(payload[key]);
    if (url) return url;
  }
  return null;
}

/**
 * 从 SSE 流中收集完整文本并提取资源 URL
 */
async function collectStreamResult(bodyStream) {
  const decoder = new TextDecoder();
  const reader = bodyStream.getReader();
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trimStart();
        if (!data || data === "[DONE]") continue;

        fullText += data + "\n";

        // 边收边解析，尽早拿到 URL
        try {
          const url = extractResourceUrlFromPayload(JSON.parse(data));
          if (url) return { url, fullText, contentType: "image" };
        } catch {}
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  // 最后整体解析
  const url = extractResourceUrlFromPayload(fullText) || extractResourceUrlFromText(fullText);
  return { url, fullText, contentType: "image" };
}

/**
 * 发送图片/视频生成请求
 * 参照 Qwen2API generateImageVideoResult()
 */
async function generateImageVideo(account, model, prompt, options = {}) {
  const token = account.token;
  const chatType = options.chatType || resolveChatType(model);
  const upstreamModel = resolveUpstreamModelId(model, null);

  // 创建会话（图片/视频生成有不同的 chat_type）
  const chatId = await createChatSession(token, upstreamModel, chatType);

  const messages = [{
    role: "user",
    content: prompt,
    chat_type: chatType,
    feature_config: { output_schema: "phase" },
  }];

  // 处理图片编辑的文件
  if (chatType === "image_edit" && options.files && options.files.length > 0) {
    messages[0].files = options.files.map(f => ({
      type: "image",
      url: f.url || f.image || f,
    }));
  } else {
    messages[0].files = [];
  }

  // 非流式（图片/视频生成上游可能不支持 stream=true）
  const payload = {
    stream: chatType === "t2i" || chatType === "image_edit",
    version: "2.1",
    incremental_output: true,
    chat_id: chatId,
    model: upstreamModel,
    messages,
  };

  // 尺寸参数
  if (options.size && (chatType === "t2i" || chatType === "t2v")) {
    payload.size = options.size;
  }

  const headers = buildHeaders(token);
  headers.Accept = payload.stream ? "text/event-stream" : "application/json";

  const resp = await fetch(
    `${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    await deleteChatSession(token, chatId).catch(() => {});
    if (resp.status === 401 || resp.status === 403) {
      const err = new Error("Qwen token 已失效");
      err.status = resp.status;
      err._tokenExpired = true;
      throw err;
    }
    throw new Error(`Qwen 图片/视频生成失败 HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }

  // 如果是 stream，从 SSE 中提取 URL
  if (payload.stream) {
    const result = await collectStreamResult(resp.body);
    if (result.url) {
      return { url: result.url, chatType, chatId };
    }

    // 流中没有拿到 URL，尝试从会话详情获取
    if (chatId) {
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 800));
        try {
          const detailResp = await fetch(`${QWEN_BASE_URL}/api/v2/chats/${chatId}`, {
            headers: buildHeaders(token),
          });
          if (detailResp.ok) {
            const detail = await detailResp.json();
            const url = extractResourceUrlFromPayload(detail);
            if (url) return { url, chatType, chatId };
          }
        } catch {}
      }
    }

    throw new Error("上游未返回图片/视频链接");
  }

  // 非流式：直接从 JSON 提取
  const json = await resp.json();
  const url = extractResourceUrlFromPayload(json);
  if (!url) throw new Error("上游未返回图片/视频链接");
  return { url, chatType, chatId };
}

// ═══════════════════════════════════════════════════
//  SSE 解析
// ═══════════════════════════════════════════════════

function parseQwenSseData(jsonStr) {
  try {
    const obj = JSON.parse(jsonStr);
    const events = [];

    // 跳过元数据事件
    if (obj["response.created"]) return null;

    // 严格对齐 Qwen2API：只处理 choices[0].delta，且必须有 phase
    const choice = obj?.choices?.[0];
    if (!choice?.delta) return null;

    const delta = choice.delta;
    const phase = delta.phase || "";
    const content = delta.content;

    // 无 phase 或 phase 非 think/answer → 丢弃（对齐 Qwen2API）
    if (!content || (phase !== "think" && phase !== "answer")) return null;

    if (phase === "think") {
      events.push({ kind: "thinking", text: content });
    } else {
      events.push({ kind: "response", text: content });
    }

    return events.length > 0 ? events : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════
//  QwenProvider 类
// ═══════════════════════════════════════════════════

export class QwenProvider extends BaseProvider {
  get name() {
    return "qwen";
  }

  get label() {
    return "Qwen (通义千问)";
  }

  // ── 账号管理 ──

  /** 通过邮箱 + 密码调用 Qwen API 获取 token */
  async _loginByPassword(email, password) {
    const passwordHash = createHash("sha256").update(password).digest("hex");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(`${QWEN_BASE_URL}/api/v2/auths/signin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "User-Agent": "Mozilla/5.0 (Android 10; Mobile; rv:150.0) Gecko/150.0 Firefox/150.0",
        Referer: "https://chat.qwen.ai/auth?action=signin",
        Version: "0.2.68",
        source: "h5",
        "X-Request-Id": genRequestId(),
        Timezone: new Date().toString().replace(/^.*?GMT/, "GMT"),
        "bx-v": "2.5.36",
        Origin: QWEN_BASE_URL,
        Connection: "keep-alive",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        Priority: "u=0",
      },
      body: JSON.stringify({ email, password: passwordHash }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      try {
        const err = JSON.parse(text);
        throw new Error(err.message || err.details || `登录失败 HTTP ${resp.status}`);
      } catch (e) {
        if (e.message.startsWith("登录失败")) throw e;
        throw new Error(`登录失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
    }

    const data = await resp.json();
    if (!data?.success || !data?.data?.token) {
      throw new Error(data?.message || "登录失败：未获取到 token");
    }

    return {
      token: data.data.token,
      name: data.data.name || email,
      email: data.data.email || email,
    };
  }

  /**
   * 使用存储的邮箱+密码重新获取 token（自动续期）
   * @returns {object|null} 新的 token 信息，失败返回 null
   */
  async _refreshToken(account) {
    if (!account || !account.email || !account.password) return null;

    try {
      const result = await this._loginByPassword(account.email, account.password);
      // 更新存储
      updateStore((state) => {
        const providers = { ...state.providers };
        const accounts = [...(providers.qwen?.accounts || [])];
        const idx = accounts.findIndex(a => a.id === account.id);
        if (idx >= 0) {
          accounts[idx] = {
            ...accounts[idx],
            token: result.token,
            updatedAt: new Date().toISOString(),
          };
          providers.qwen = { ...providers.qwen, accounts };
        }
        return { ...state, providers };
      });

      // 更新内存中的 account 引用
      account.token = result.token;
      account.updatedAt = new Date().toISOString();

      console.error("[Qwen] Token 自动续期成功:", account.email);
      return result;
    } catch (e) {
      console.error("[Qwen] Token 自动续期失败:", account.email, e.message);
      return null;
    }
  }

  /**
   * 执行带自动续期的请求
   * 如果请求因 401/403 失败且账号有密码，自动重登录后重试一次
   */
  async _withAutoRefresh(account, fn) {
    try {
      return await fn(account.token);
    } catch (err) {
      if (err._tokenExpired || err.status === 401 || err.status === 403) {
        // 尝试自动续期
        if (account.email && account.password) {
          console.error("[Qwen] Token 过期，尝试自动续期...");
          const refreshed = await this._refreshToken(account);
          if (refreshed) {
            // 重试请求
            return await fn(account.token);
          }
        }
        // 无密码或续期失败
        throw new Error(
          account.email && account.password
            ? "Qwen token 已失效，自动续期失败，请重新运行 chat2cli login"
            : "Qwen token 已失效，且未存储账号密码无法自动续期。请重新运行 chat2cli login 使用邮箱+密码登录"
        );
      }
      throw err;
    }
  }

  async login(credentials) {
    let token, email, displayName, password;

    // 方式一：直接提供 token
    if (credentials.token) {
      token = credentials.token;
      email = credentials.email || "";

      // 验证 token 有效性
      try {
        const resp = await fetch(`${QWEN_BASE_URL}/api/v2/user/info`, {
          headers: buildHeaders(token),
        });
        if (resp.ok) {
          const info = await resp.json().catch(() => null);
          if (info?.data) {
            email = info.data.email || email;
            displayName = info.data.name || info.data.email || email;
          }
        }
      } catch {
        // 验证失败不阻塞登录
      }
    }

    // 方式二：邮箱 + 密码登录
    if (credentials.email && credentials.password) {
      const result = await this._loginByPassword(credentials.email, credentials.password);
      token = result.token;
      email = result.email;
      displayName = result.name;
      password = credentials.password; // 存储密码用于自动续期
    }

    if (!token) throw new Error("请提供 token 或邮箱+密码");

    displayName = displayName || email || token.slice(0, 12) + "...";

    const account = {
      id: createId(),
      token,
      email,
      displayName,
      // 存储密码用于自动续期（兼容旧版数据：旧账号没有 password 字段）
      password: password || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    updateStore((state) => {
      const providers = { ...state.providers };
      if (!providers.qwen) providers.qwen = { accounts: [] };
      const existingIdx = providers.qwen.accounts.findIndex(
        (a) => a.email && a.email === email
      );
      if (existingIdx >= 0) {
        // 保留已有的 password（如果新登录没带密码但旧账号有）
        const oldAccount = providers.qwen.accounts[existingIdx];
        providers.qwen.accounts[existingIdx] = {
          ...account,
          password: account.password || oldAccount.password,
          createdAt: oldAccount.createdAt || account.createdAt,
        };
      } else {
        providers.qwen.accounts.push(account);
      }
      return { ...state, providers };
    });

    return account;
  }

  listAccounts() {
    const state = getStore();
    return state.providers?.qwen?.accounts || [];
  }

  getAccountInfo(accountId) {
    const accounts = this.listAccounts();
    if (accountId) return accounts.find((a) => a.id === accountId) || null;
    return accounts[0] || null;
  }

  getDefaultAccount() {
    return this.getAccountInfo();
  }

  removeAccount(accountId) {
    let removed = null;
    updateStore((state) => {
      const providers = { ...state.providers };
      const existing = providers.qwen?.accounts || [];
      const idx = existing.findIndex((a) => a.id === accountId);
      if (idx < 0) return state;
      removed = existing[idx];
      providers.qwen = { ...providers.qwen, accounts: existing.filter((_, i) => i !== idx) };
      return { ...state, providers };
    });
    return removed;
  }

  isAuthenticated() {
    const info = this.getDefaultAccount();
    return !!(info && info.token);
  }

  // ── 会话列表 ──

  /**
   * 获取当前账号的会话列表
   * 参照 Qwen2API GET /api/v2/chats
   * @param {string} [accountId] - 账号 ID，不传则使用默认账号
   * @returns {Promise<Array<{id, title, createdAt, updatedAt, model, chatType}>>}
   */
  async listSessions(accountId) {
    const account = accountId
      ? this.getAccountInfo(accountId)
      : this.getDefaultAccount();
    if (!account) throw new Error("未登录 Qwen，请先运行 chat2cli login");

    const doFetch = async (token) => {
      const resp = await fetch(`${QWEN_BASE_URL}/api/v2/chats`, {
        headers: buildHeaders(token),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        if (resp.status === 401 || resp.status === 403) {
          const err = new Error("Qwen token 已失效");
          err.status = resp.status;
          err._tokenExpired = true;
          throw err;
        }
        throw new Error(`获取 Qwen 会话列表失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }

      const data = await resp.json();
      // 响应格式: { data: { chats: [...] } } 或 { data: [...] }
      const chats = data?.data?.chats || data?.data || data?.chats || [];
      if (!Array.isArray(chats)) return [];

      return chats.map(c => ({
        id: c.id || c.chat_id || "",
        title: c.title || c.name || "未命名会话",
        createdAt: c.created_at || c.createdAt || c.timestamp || "",
        updatedAt: c.updated_at || c.updatedAt || c.last_message_at || "",
        model: (c.models && c.models[0]) || c.model || "",
        chatType: c.chat_type || c.chatType || "t2t",
      }));
    };

    return await this._withAutoRefresh(account, doFetch);
  }

  /**
   * 获取单个会话详情（包含消息历史）
   * @param {string} chatId - 会话 ID
   * @param {string} [accountId] - 账号 ID
   */
  async getSessionDetail(chatId, accountId) {
    const account = accountId
      ? this.getAccountInfo(accountId)
      : this.getDefaultAccount();
    if (!account) throw new Error("未登录 Qwen");
    if (!chatId) throw new Error("缺少 chatId");

    const doFetch = async (token) => {
      const resp = await fetch(`${QWEN_BASE_URL}/api/v2/chats/${chatId}`, {
        headers: buildHeaders(token),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        if (resp.status === 401 || resp.status === 403) {
          const err = new Error("Qwen token 已失效");
          err.status = resp.status;
          err._tokenExpired = true;
          throw err;
        }
        throw new Error(`获取 Qwen 会话详情失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }

      return await resp.json();
    };

    return await this._withAutoRefresh(account, doFetch);
  }

  /**
   * 删除云端会话（带 token 自动续期）
   * @param {string} chatId - 会话 ID
   * @param {string} [accountId] - 账号 ID
   */
  async deleteChatSession(chatId, accountId) {
    const account = accountId
      ? this.getAccountInfo(accountId)
      : this.getDefaultAccount();
    if (!account) throw new Error("未登录 Qwen");
    if (!chatId) throw new Error("缺少 chatId");

    const doDelete = async (token) => {
      const resp = await fetch(`${QWEN_BASE_URL}/api/v2/chats/${chatId}`, {
        method: "DELETE",
        headers: buildHeaders(token),
      });
      if (!resp.ok && resp.status !== 404) {
        const text = await resp.text().catch(() => "");
        throw new Error(`删除会话失败 HTTP ${resp.status}: ${text.slice(0, 100)}`);
      }
    };

    return await this._withAutoRefresh(account, doDelete);
  }

  // ── models ──

  _cachedModels = null;
  _modelsLastFetch = 0;

  async _fetchModels(token) {
    const now = Date.now();
    if (this._cachedModels && (now - this._modelsLastFetch) < 30 * 60 * 1000) {
      return this._cachedModels;
    }
    try {
      const resp = await fetch(`${QWEN_BASE_URL}/api/models`, {
        headers: buildHeaders(token),
      });
      if (resp.ok) {
        const raw = await resp.json();
        const list = Array.isArray(raw) ? raw : (raw?.data || raw?.models || []);
        if (Array.isArray(list) && list.length > 0) {
          const models = list.map(item => {
            const id = item.id || item.model || item.name || "";
            const label = item.display_name || item.displayName || item.name || item.id || "";
            const chatTypes = item?.info?.meta?.chat_type || [];

            // 生成能力变体后缀模型
            const variants = [{ id, label }];

            // 从上游元数据判断图片/视频能力
            const hasImage = chatTypes.includes("t2i");
            const hasImageEdit = chatTypes.includes("image_edit");
            const hasVideo = chatTypes.includes("t2v");

            // 兜底：omni 系列模型硬编码支持图片/视频（上游元数据可能缺失）
            const isOmni = id.toLowerCase().includes("omni");
            if (hasImage || isOmni) {
              variants.push({ id: `${id}-image`, label: `${label} (图片生成)` });
            }
            if (hasImageEdit || isOmni) {
              variants.push({ id: `${id}-image-edit`, label: `${label} (图片编辑)` });
            }
            if (hasVideo || isOmni) {
              variants.push({ id: `${id}-video`, label: `${label} (视频生成)` });
            }
            // 所有模型都可加 thinking / search
            variants.push(
              { id: `${id}-thinking`, label: `${label} (思考)` },
              { id: `${id}-search`, label: `${label} (搜索)` },
              { id: `${id}-thinking-search`, label: `${label} (思考+搜索)` },
            );
            return variants;
          }).flat();
          if (models.length > 0) {
            this._cachedModels = models;
            this._modelsLastFetch = now;
            return models;
          }
        }
      }
    } catch (e) {
      console.error("[Qwen] Failed to fetch models:", e.message);
    }
    return QWEN_MODELS;
  }

  getModels() {
    if (this._cachedModels) return this._cachedModels;
    return QWEN_MODELS;
  }

  // ── CLI 聊天 ──

  async *chat(messages, options = {}) {
    const account = this.getAccountInfo(options.accountId);
    if (!account) throw new Error("未登录 Qwen，请先运行 chat2cli login");

    const realModels = await this._fetchModels(account.token);
    const model = options.model || realModels[0]?.id;
    const chatType = resolveChatType(model);
    const upstreamModel = resolveUpstreamModelId(model, realModels);

    // 图片/视频生成走专用路径
    if (chatType === "t2i" || chatType === "t2v" || chatType === "image_edit") {
      const prompt = buildPromptFromMessages(messages);
      const result = await this._withAutoRefresh(account, () =>
        generateImageVideo(account, model, prompt, { chatType, size: options.size })
      );
      yield { kind: "response", text: `![image](${result.url})` };
      return;
    }

    const prompt = buildPromptFromMessages(messages);

    // CLI chat 默认 keepSession=true（保留会话用于续聊）
    const keepSession = options.keepSession !== false;
    // 续聊时只发最后一条用户消息（不打包历史）
    const isContinuation = !!(options.sessionId && options.parentMessageId);
    const finalPrompt = isContinuation
      ? (messages.filter(m => m.role === "user").pop()?.content || prompt)
      : prompt;

    const doChat = async (token) => {
      const chatId = options.sessionId || await createChatSession(token, upstreamModel, chatType);
      const payload = buildQwenPayload(chatId, upstreamModel, finalPrompt, options);
      if (options.parentMessageId) {
        payload.messages[0].parentId = options.parentMessageId;
        payload.messages[0].parent_id = options.parentMessageId;
        payload.parent_id = options.parentMessageId;
      }

      const headers = buildHeaders(token);
      headers.Accept = "text/event-stream";

      const resp = await fetch(
        `${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`,
        { method: "POST", headers, body: JSON.stringify(payload) }
      );

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        await deleteChatSession(token, chatId);
        if (resp.status === 401 || resp.status === 403) {
          const err = new Error("Qwen token 已失效");
          err.status = resp.status;
          err._tokenExpired = true;
          throw err;
        }
        throw new Error(`Qwen 请求失败 HTTP ${resp.status}: ${errText.slice(0, 200)}`);
      }

      const contentType = resp.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        const fullBody = await resp.text().catch(() => "<read failed>");
        await deleteChatSession(token, chatId);
        throw new Error(`Qwen 请求错误: ${fullBody.slice(0, 150)}`);
      }

      return { resp, chatId };
    };

    const { resp, chatId } = await this._withAutoRefresh(account, doChat);

    // 产出会话 ID，供 chatLoop 续聊复用
    yield { kind: "__sessionId", text: chatId };

    const decoder = new TextDecoder();
    const reader = resp.body.getReader();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trimStart();
          if (!data || data === "[DONE]") continue;

          // 提取 response_id 作为 messageId（供续聊 parentMessageId 使用）
          try {
            const obj = JSON.parse(data);
            const rid = obj?.response?.created?.response_id || obj?.response_id;
            if (rid) yield { kind: "__messageId", text: rid };
          } catch {}

          const deltas = parseQwenSseData(data);
          if (deltas) {
            for (const delta of deltas) {
              yield delta;
            }
          }
        }
      }
    } finally {
      reader.releaseLock?.();
      if (!keepSession) {
        await deleteChatSession(account.token, chatId);
      }
    }
  }

  // ── 图片生成（公开方法，供 server.js /v1/images/generations 调用）──

  /**
   * 图片/视频生成
   * @param {object} options
   * @param {string} options.prompt - 提示词
   * @param {string} [options.model] - 模型 ID
   * @param {string} [options.size] - 尺寸 "1:1"|"4:3"|"3:4"|"16:9"|"9:16"
   * @param {string} [options.chatType] - "t2i"|"t2v"|"image_edit"
   * @param {Array} [options.files] - 图片编辑的文件列表 [{url: "..."}]
   * @param {string} [options.accountId] - 账号 ID
   * @returns {Promise<{url: string, chatType: string}>}
   */
  async generateImage(options = {}) {
    const account = this.getAccountInfo(options.accountId);
    if (!account) throw new Error("未登录 Qwen，请先运行 chat2cli login");

    const realModels = await this._fetchModels(account.token);
    const model = options.model || realModels[0]?.id;
    const chatType = options.chatType || resolveChatType(model);
    const prompt = options.prompt || "";

    if (!prompt && chatType !== "image_edit") {
      throw new Error("缺少 prompt 参数");
    }

    return await this._withAutoRefresh(account, () =>
      generateImageVideo(account, model, prompt, { ...options, chatType })
    );
  }

  // ── Server / Agent 桥接 ──

  async startCompletion(messages, options = {}) {
    const account = options.accountId
      ? this.getAccountInfo(options.accountId)
      : this.getDefaultAccount();
    if (!account) throw new Error("未登录 Qwen，请先运行 chat2cli login");

    const realModels = await this._fetchModels(account.token);
    const model = options.model || realModels[0]?.id;
    const chatType = resolveChatType(model);
    const upstreamModel = resolveUpstreamModelId(model, realModels);
    const fullPrompt = options.prompt || buildPromptFromMessages(messages);
    // 续聊时只发最后一条用户消息（不打包历史）
    const isContinuation = !!(options.sessionId && options.parentMessageId);
    const prompt = isContinuation
      ? (messages.filter(m => m.role === "user").pop()?.content || fullPrompt)
      : fullPrompt;

    // 图片/视频生成走专用路径
    if (chatType === "t2i" || chatType === "t2v" || chatType === "image_edit") {
      const result = await this._withAutoRefresh(account, () =>
        generateImageVideo(account, model, prompt, {
          chatType,
          size: options.size,
          files: options.files,
        })
      );
      // 返回一个包装对象，让 server.js 的 image 端点处理
      result._isImageResult = true;
      result._model = upstreamModel;
      return result;
    }

    const doStartCompletion = async (token) => {
      const chatId = options.sessionId || await createChatSession(token, upstreamModel, chatType);
      const payload = buildQwenPayload(chatId, upstreamModel, prompt, options);
      if (options.parentMessageId) {
        payload.messages[0].parentId = options.parentMessageId;
        payload.messages[0].parent_id = options.parentMessageId;
        payload.parent_id = options.parentMessageId;
      }

      const headers = buildHeaders(token);
      headers.Accept = "text/event-stream";

      const resp = await fetch(
        `${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`,
        { method: "POST", headers, body: JSON.stringify(payload) }
      );

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        await deleteChatSession(token, chatId).catch(() => {});
        if (resp.status === 401 || resp.status === 403) {
          const err = new Error("Qwen token 已失效");
          err.status = resp.status;
          err._tokenExpired = true;
          throw err;
        }
        const err = new Error(`Qwen 请求失败 HTTP ${resp.status}: ${errText.slice(0, 200)}`);
        err.status = resp.status;
        err._sessionId = chatId;
        throw err;
      }

      const contentType = resp.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        const fullBody = await resp.text().catch(() => "<read failed>");
        await deleteChatSession(token, chatId).catch(() => {});
        const err = new Error(`Qwen 请求错误 (非 SSE 响应): ${fullBody.slice(0, 150)}`);
        err.status = resp.status;
        err._sessionId = chatId;
        throw err;
      }

      resp._sessionId = chatId;
      resp._keepSession = options.keepSession === true;
      resp._account = account;
      resp._provider = this;
      return resp;
    };

    return await this._withAutoRefresh(account, doStartCompletion);
  }
}
