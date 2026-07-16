import { randomUUID, randomBytes, createHash } from "node:crypto";
import { BaseProvider } from "../base.js";
import { getStore, updateStore } from "../../storage/store.js";
import { createId } from "../../utils/id.js";
import { buildPromptFromMessages } from "../../bridge.js";

// ═══════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════

const GLM_BASE_URL = "https://chatglm.cn/chatglm";
const SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";
const DEFAULT_ASSISTANT_ID = "65940acff94777010aa6b796";
const IMAGE_ASSISTANT_ID = "65a232c082ff90a2ad2f15e2";
const ACCESS_TOKEN_EXPIRES_SECONDS = 3600;

const GLM_MODELS = [
  { id: "glm-5.2", label: "GLM 5.2" },
  { id: "glm-5.1", label: "GLM 5.1" },
  { id: "glm-5v-turbo", label: "GLM 5V Turbo" },
  { id: "glm-5-turbo", label: "GLM 5 Turbo" },
  { id: "glm-5", label: "GLM 5" },
  { id: "glm-4.7-flash", label: "GLM 4.7 Flash" },
  { id: "glm-4.7", label: "GLM 4.7" },
  { id: "glm-4.6v-flash", label: "GLM 4.6V Flash" },
  { id: "glm-4.6", label: "GLM 4.6" },
  { id: "glm-4.5", label: "GLM 4.5" },
  { id: "glm-4.1v-thinking-flashx", label: "GLM 4.1V Thinking FlashX" },
  { id: "glm-4", label: "GLM 4" },
  { id: "glm-4-flash", label: "GLM 4 Flash" },
  { id: "glm-4-air", label: "GLM 4 Air" },
  { id: "glm-4v", label: "GLM 4V" },
  { id: "glm-4-flashx-250414", label: "GLM 4 FlashX" },
  { id: "glm-4-flash-250414", label: "GLM 4 Flash (250414)" },
  { id: "glm-zero-preview", label: "GLM Zero Preview" },
  { id: "glm-deep-research", label: "GLM Deep Research" },
  { id: "glm-image-1", label: "GLM Image 1" },
  { id: "cogView-4-250304", label: "CogView 4" },
];

/** 基础模型名（不含后缀变体） */
const BASE_MODEL_NAMES = new Set(GLM_MODELS.map(m => m.id));

// ── 能力后缀 ──
const CAPABILITY_SUFFIXES = ["-think-search", "-think", "-search"];

/**
 * 拆分模型 ID 为基础模型 + 后缀
 */
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
 * 解析聊天模式（chat_mode）
 *  -think / thinking → "zero"
 *  -deep-research / deep-research → "deep_research"
 *  其他 → ""
 */
function resolveChatMode(modelId, options = {}) {
  if (options.deepResearch || (modelId || "").includes("deep-research")) {
    return "deep_research";
  }
  if (options.thinkingEnabled !== false && (
    (modelId || "").includes("-think") ||
    (modelId || "").includes("zero")
  )) {
    return "zero";
  }
  return "";
}

/**
 * 解析是否联网搜索
 */
function resolveNetworking(modelId, options = {}) {
  return options.enableSearch === true || (modelId || "").includes("-search");
}

/**
 * 解析上游模型 ID（去掉后缀变体）
 */
function resolveUpstreamModel(modelId) {
  if (!modelId) return "glm-4";
  const { baseModel } = splitModelSuffix(modelId);
  return BASE_MODEL_NAMES.has(baseModel) ? baseModel : modelId;
}

// ═══════════════════════════════════════════════════
//  Auth helpers
// ═══════════════════════════════════════════════════

function genRequestId() {
  return randomUUID();
}

function genDeviceId() {
  return randomBytes(16).toString("hex");
}

/**
 * 构建 MD5 签名（防 CSRF）
 * glm2api build_sign()
 */
function buildSign() {
  const now = String(Math.floor(Date.now()));
  // 按 glm2api 算法: 最后两位数字独立校验
  const digits = [...now].map(Number);
  const checksum = (digits.reduce((a, b) => a + b, 0) - digits[digits.length - 2]) % 10;
  const timestamp = now.slice(0, -2) + String(checksum) + now.slice(-1);
  const nonce = randomUUID().replaceAll("-", "");
  const sign = createHash("md5")
    .update(`${timestamp}-${nonce}-${SIGN_SECRET}`)
    .digest("hex");
  return { timestamp, nonce, sign };
}

/**
 * 生成随机 X-Forwarded-For（降低风控）
 */
function buildRandomXForwardedFor() {
  while (true) {
    const first = Math.floor(Math.random() * 223) + 1;
    if ([10, 127, 169, 172, 192].includes(first)) continue;
    const rest = Array.from({ length: 3 }, () => Math.floor(Math.random() * 256));
    return [first, ...rest].join(".");
  }
}

/**
 * 构建浏览器级请求头（仿 chatglm.cn 网页端）
 * @param {string} accessToken - Bearer token
 * @param {object} extra - 额外配置
 * @param {string} [extra.accept] - Accept 头，默认 "text/event-stream"
 * @param {string} [extra.contentType] - Content-Type，默认 "application/json"
 * @param {string} [extra.referer] - Referer
 * @param {string} [extra.appFr] - X-App-Fr，默认 "browser_extension"
 * @param {object} [extra.headers] - 额外的覆盖头
 */
function buildHeaders(accessToken, extra = {}) {
  const appFr = extra.appFr || "browser_extension";
  return {
    "Accept": extra.accept || "text/event-stream",
    "Accept-Encoding": appFr === "default" ? "gzip, deflate" : "identity",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "App-Name": "chatglm",
    "Authorization": `Bearer ${accessToken}`,
    "Cache-Control": "no-cache",
    "Content-Type": extra.contentType || "application/json",
    "Origin": "https://chatglm.cn",
    "Pragma": "no-cache",
    "Priority": "u=1, i",
    "Referer": extra.referer || "https://chatglm.cn/main/alltoolsdetail",
    "Sec-Ch-Ua": '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
    "X-App-Fr": appFr,
    "X-App-Platform": "pc",
    "X-App-Version": "0.0.1",
    "X-Device-Brand": "",
    "X-Device-Model": "",
    "X-Device-Id": genDeviceId(),
    "X-Forwarded-For": buildRandomXForwardedFor(),
    "X-Lang": "zh",
    ...extra.headers,
  };
}

// ═══════════════════════════════════════════════════
//  SSE 解析
// ═══════════════════════════════════════════════════

/**
 * 解析 GLM SSE 事件，提取 thinking / response deltas。
 * GLM SSE 格式（每行 data: 后是完整 JSON）：
 *   data: {"status":"streaming","parts":[{"logic_id":"...","content":[{"type":"think","think":"..."},{"type":"text","text":"..."}]}]}
 *
 * 返回 Array<{kind: "thinking"|"response", text: string}>
 */
function parseGlmSsePayload(payload) {
  if (!payload || typeof payload !== "object") return [];

  const parts = payload.parts;
  if (!Array.isArray(parts)) return [];

  const results = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const contentItems = part.content;
    if (!Array.isArray(contentItems)) continue;

    for (const item of contentItems) {
      if (!item || typeof item !== "object") continue;
      const itemType = item.type;

      if (itemType === "think") {
        const text = String(item.think || item.text || item.content || "");
        if (text) results.push({ kind: "thinking", text });
      } else if (itemType === "text") {
        const text = String(item.text || item.content || "");
        if (text) results.push({ kind: "response", text });
      } else if (itemType === "code") {
        const code = String(item.code || "");
        if (code) results.push({ kind: "response", text: "```python\n" + code + "\n```" });
      } else if (itemType === "execution_output") {
        const output = String(item.content || "");
        if (output) results.push({ kind: "response", text: output });
      }
    }
  }

  // 顶层 fallback
  if (results.length === 0) {
    if (typeof payload.content === "string" && payload.content) {
      results.push({ kind: "response", text: payload.content });
    }
    if (typeof payload.text === "string" && payload.text) {
      results.push({ kind: "response", text: payload.text });
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════
//  GlmProvider
// ═══════════════════════════════════════════════════

export class GlmProvider extends BaseProvider {
  // 内存 token 缓存（key: accountId）
  _tokenCache = new Map();

  get name() {
    return "glm";
  }

  get label() {
    return "GLM (智谱清言)";
  }

  // ── 账号管理 ──

  listAccounts() {
    const state = getStore();
    return state.providers?.glm?.accounts || [];
  }

  getAccountInfo(accountId) {
    const accounts = this.listAccounts();
    if (accountId) return accounts.find((a) => a.id === accountId) || null;
    return accounts[0] || null;
  }

  getDefaultAccount() {
    return this.getAccountInfo();
  }

  isAuthenticated() {
    const info = this.getDefaultAccount();
    return !!(info && (info.refreshToken || info.isGuest));
  }

  /**
   * 登录
   * @param {object} credentials
   * @param {string} [credentials.refreshToken] - 从 chatglm.cn 浏览器获取的 refresh_token
   * @param {boolean} [credentials.guest] - 使用游客模式
   */
  async login(credentials = {}) {
    const isGuest = credentials.guest === true;
    let refreshToken = credentials.refreshToken || "";
    let displayName = "";

    if (isGuest) {
      displayName = "游客账号";
      // 立即获取游客 access_token 验证
      try {
        const token = await this._fetchGuestAccessToken();
        // 游客模式仅在内存中持有 token，不持久化 refresh_token
      } catch (e) {
        throw new Error(`获取游客 token 失败: ${e.message}`);
      }
    } else if (refreshToken) {
      // 用 refresh_token 获取 access_token 进行验证
      try {
        const token = await this._refreshAccessToken(refreshToken);
        displayName = "智谱清言账号";
      } catch (e) {
        throw new Error(`refresh_token 无效: ${e.message}`);
      }
    } else {
      throw new Error("请提供 refresh_token 或使用 --guest 游客模式");
    }

    const account = {
      id: createId(),
      refreshToken: isGuest ? "" : refreshToken,
      isGuest,
      displayName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // 内存中的缓存 token（不持久化）
      _cachedToken: isGuest ? null : undefined,
      _tokenExpiresAt: 0,
    };

    updateStore((state) => {
      const providers = { ...state.providers };
      if (!providers.glm) providers.glm = { accounts: [] };
      const existingIdx = providers.glm.accounts.findIndex(
        (a) => a.isGuest === isGuest && (!isGuest ? a.refreshToken === refreshToken : false)
      );
      if (existingIdx >= 0) {
        providers.glm.accounts[existingIdx] = {
          ...account,
          createdAt: providers.glm.accounts[existingIdx].createdAt || account.createdAt,
        };
      } else {
        providers.glm.accounts.push(account);
      }
      return { ...state, providers };
    });

    return account;
  }

  deleteAccount(accountId) {
    let removed = null;
    updateStore((state) => {
      const providers = { ...state.providers };
      const existing = providers.glm?.accounts || [];
      const idx = existing.findIndex((a) => a.id === accountId);
      if (idx < 0) return state;
      removed = existing[idx];
      providers.glm = { ...providers.glm, accounts: existing.filter((_, i) => i !== idx) };
      return { ...state, providers };
    });
    return removed;
  }

  // ── Token 管理 ──

  /**
   * 获取当前账号的有效 access_token（带内存缓存）
   * 正式账号：用 refresh_token 换 access_token（缓存 ~1h）
   * 游客账号：请求失败时重新拉取（最多 3 次）
   */
  async _getAccessToken(account) {
    const cacheKey = account.id;
    let cached = this._tokenCache.get(cacheKey);

    const now = Date.now();
    if (cached && now < cached.expiresAt - 60000) {
      return cached.accessToken;
    }

    if (account.isGuest) {
      const token = await this._fetchGuestAccessToken();
      cached = {
        accessToken: token.accessToken,
        expiresAt: now + ACCESS_TOKEN_EXPIRES_SECONDS * 1000,
      };
      this._tokenCache.set(cacheKey, cached);
      return cached.accessToken;
    }

    // 正式账号：用 refresh_token 换取
    const token = await this._refreshAccessToken(account.refreshToken);
    cached = {
      accessToken: token.accessToken,
      expiresAt: now + ACCESS_TOKEN_EXPIRES_SECONDS * 1000,
    };
    this._tokenCache.set(cacheKey, cached);

    // 如果上游返回了新的 refresh_token，写回存储
    if (token.refreshToken && token.refreshToken !== account.refreshToken) {
      account.refreshToken = token.refreshToken;
      updateStore((state) => {
        const providers = { ...state.providers };
        if (providers.glm?.accounts) {
          const idx = providers.glm.accounts.findIndex((a) => a.id === account.id);
          if (idx >= 0) {
            providers.glm.accounts[idx] = {
              ...providers.glm.accounts[idx],
              refreshToken: token.refreshToken,
              updatedAt: new Date().toISOString(),
            };
          }
        }
        return { ...state, providers };
      });
    }

    return cached.accessToken;
  }

  /**
   * POST /user-api/user/refresh 用 refresh_token 换取 access_token
   */
  async _refreshAccessToken(refreshToken) {
    const { timestamp, nonce, sign } = buildSign();
    const deviceId = genDeviceId();
    const requestId = genRequestId();

    // 使用与 glm2api 完全一致的头（app_fr="browser_extension" 模式）
    const headers = buildHeaders(refreshToken, {
      accept: "text/event-stream",
      contentType: "application/json",
      referer: "https://chatglm.cn/",
      appFr: "browser_extension",
      headers: {
        "X-Device-Id": deviceId,
        "X-Nonce": nonce,
        "X-Request-Id": requestId,
        "X-Sign": sign,
        "X-Timestamp": timestamp,
      },
    });

    const resp = await fetch(`${GLM_BASE_URL}/user-api/user/refresh`, {
      method: "POST",
      headers,
      body: "{}",
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`刷新 token 失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    const code = data.code ?? data.status;
    const result = data.result || {};
    const accessToken = result.access_token;
    const newRefreshToken = result.refresh_token || refreshToken;

    if (code !== 0 && code !== null && code !== undefined) {
      throw new Error(`刷新 token 失败: ${JSON.stringify(data)}`);
    }
    if (!accessToken) {
      throw new Error(`刷新 token 失败：未返回 access_token`);
    }

    return { accessToken, refreshToken: newRefreshToken };
  }

  /**
   * POST /user-api/guest/access 获取游客 access_token
   */
  async _fetchGuestAccessToken() {
    const { timestamp, nonce, sign } = buildSign();
    const deviceId = genDeviceId();
    const requestId = genRequestId();

    // 游客 token 使用 app_fr="default" 模式
    const headers = buildHeaders("", {
      accept: "application/json, text/plain, */*",
      contentType: "application/json",
      referer: "https://chatglm.cn/",
      appFr: "default",
      headers: {
        "Content-Length": "0",
        "X-Device-Id": deviceId,
        "X-Nonce": nonce,
        "X-Request-Id": requestId,
        "X-Sign": sign,
        "X-Timestamp": timestamp,
      },
    });

    const resp = await fetch(`${GLM_BASE_URL}/user-api/guest/access`, {
      method: "POST",
      headers,
      body: "",
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`获取游客 token 失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    const code = data.code ?? data.status;
    const result = data.result || {};
    const accessToken = result.access_token;
    const refreshToken = result.refresh_token;

    if (code !== 0 && code !== null && code !== undefined) {
      throw new Error(`获取游客 token 失败: ${JSON.stringify(data)}`);
    }
    if (!accessToken) {
      throw new Error("获取游客 token 失败：未返回 access_token");
    }

    return { accessToken, refreshToken: refreshToken || "" };
  }

  // ── 上下文恢复 ──

  /**
   * 确保账号的 access_token 已就绪（预热或续期）
   */
  async _ensureTokenReady(account) {
    const cached = this._tokenCache.get(account.id);
    if (!cached || Date.now() >= cached.expiresAt - 60000) {
      await this._getAccessToken(account);
    }
  }

  // ── 模型 ──

  getModels() {
    // 返回基础模型 + thinking/search 变体
    return GLM_MODELS;
  }

  /**
   * 返回扩展后的模型列表（含后缀变体），供 server /v1/models 使用
   */
  getExpandedModels() {
    const models = [];
    for (const m of GLM_MODELS) {
      models.push(m);
      const id = m.id;
      // 图片模型和 deep-research 不扩展
      if (id === "glm-image-1" || id === "cogView-4-250304" || id === "glm-deep-research") continue;
      models.push(
        { id: `${id}-think`, label: `${m.label} (思考)` },
        { id: `${id}-search`, label: `${m.label} (搜索)` },
        { id: `${id}-think-search`, label: `${m.label} (思考+搜索)` },
      );
    }
    return models;
  }

  // ── CLI 聊天 ──

  async *chat(messages, options = {}) {
    const account = options.accountId
      ? this.getAccountInfo(options.accountId)
      : this.getDefaultAccount();
    if (!account) throw new Error("未登录 GLM，请先运行 chat2cli login");

    await this._ensureTokenReady(account);

    const model = options.model || "glm-4.7";
    const chatMode = resolveChatMode(model, options);
    const isNetworking = resolveNetworking(model, options);
    const upstreamModel = resolveUpstreamModel(model);
    const prompt = options.prompt || buildPromptFromMessages(messages);

    const assistantId = DEFAULT_ASSISTANT_ID;

    const requestBody = JSON.stringify({
      assistant_id: assistantId,
      conversation_id: "",
      project_id: "",
      chat_type: "user_chat",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      ],
      meta_data: {
        channel: "",
        chat_mode: chatMode,
        draft_id: "",
        if_plus_model: true,
        input_question_type: "xxxx",
        is_networking: isNetworking,
        is_test: false,
        platform: "pc",
        quote_log_id: "",
        cogview: { rm_label_watermark: false },
      },
    });

    const { timestamp, nonce, sign } = buildSign();
    const deviceId = genDeviceId();
    const requestId = genRequestId();

    const accessToken = await this._getAccessToken(account);

    const resp = await fetch(`${GLM_BASE_URL}/backend-api/assistant/stream`, {
      method: "POST",
      headers: buildHeaders(accessToken, {
        accept: "text/event-stream",
        contentType: "application/json",
        referer: "https://chatglm.cn/main/alltoolsdetail",
        headers: {
          "X-Device-Id": deviceId,
          "X-Nonce": nonce,
          "X-Request-Id": requestId,
          "X-Sign": sign,
          "X-Timestamp": timestamp,
        },
      }),
      body: requestBody,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      // 429 且包含"请等待其他对话生成完毕"
      if (resp.status === 429 && errText.includes("请等待其他对话生成完毕")) {
        throw new Error("GLM 正在处理其他对话，请稍后重试");
      }
      throw new Error(`GLM 请求失败 HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream") && !contentType.includes("application/json")) {
      const fullBody = await resp.text().catch(() => "");
      throw new Error(`GLM 非预期响应: ${fullBody.slice(0, 150)}`);
    }

    let conversationId = "";
    let lastThinkingLen = 0;
    let lastTextLen = 0;
    let errorEncountered = false;

    const decoder = new TextDecoder();
    const reader = resp.body.getReader();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE 事件由 \n\n 分隔
        while (buffer.includes("\n\n")) {
          const idx = buffer.indexOf("\n\n");
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          // 提取所有 data: 行并拼接
          const lines = block.split("\n").filter((l) => l.startsWith("data:"));
          if (lines.length === 0) continue;
          const payloadText = lines.map((l) => l.slice(5).trimStart()).join("\n");

          if (!payloadText || payloadText === "[DONE]") continue;

          let payload;
          try {
            payload = JSON.parse(payloadText);
          } catch {
            continue;
          }

          // 提取 conversation_id
          if (!conversationId && payload.conversation_id) {
            conversationId = String(payload.conversation_id);
            yield { kind: "__sessionId", text: conversationId };
          }

          // 检查错误
          const status = payload.status;
          if (status === "error") {
            const lastError = payload.last_error;
            const errMsg = lastError?.err_msg || lastError?.message || "GLM 上游错误";
            errorEncountered = true;
            throw new Error(errMsg);
          }

          // 收集当前 accumulated thinking / text
          const deltas = parseGlmSsePayload(payload);
          let currentThinking = "";
          let currentText = "";

          for (const d of deltas) {
            if (d.kind === "thinking") currentThinking += d.text;
            else currentText += d.text;
          }

          // 计算增量
          if (currentThinking.length > lastThinkingLen) {
            const delta = currentThinking.slice(lastThinkingLen);
            lastThinkingLen = currentThinking.length;
            yield { kind: "thinking", text: delta };
          }
          if (currentText.length > lastTextLen) {
            const delta = currentText.slice(lastTextLen);
            lastTextLen = currentText.length;
            yield { kind: "response", text: delta };
          }

          // 完成
          if (status === "finish" || status === "intervene") {
            // 流结束
          }
        }
      }
    } finally {
      reader.releaseLock?.();
      // 删除会话（默认开启）
      if (conversationId && !errorEncountered) {
        await this._deleteConversation(account, conversationId, assistantId).catch(() => {});
      }
    }
  }

  // ── Server / Agent 桥接 ──

  /**
   * 发起 completion 请求，返回 Response 流（含 _sessionId 和 _conversationId）。
   * 由 server.js 中的 bridge 层做 OpenAI SSE 转换。
   */
  async startCompletion(messages, options = {}) {
    const account = options.accountId
      ? this.getAccountInfo(options.accountId)
      : this.getDefaultAccount();
    if (!account) throw new Error("未登录 GLM，请先运行 chat2cli login");

    await this._ensureTokenReady(account);

    const model = options.model || "glm-4.7";
    const chatMode = resolveChatMode(model, options);
    const isNetworking = resolveNetworking(model, options);
    const upstreamModel = resolveUpstreamModel(model);
    const prompt = options.prompt || buildPromptFromMessages(messages);
    const assistantId = DEFAULT_ASSISTANT_ID;

    const requestBody = JSON.stringify({
      assistant_id: assistantId,
      conversation_id: options.sessionId || "",
      project_id: "",
      chat_type: "user_chat",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      ],
      meta_data: {
        channel: "",
        chat_mode: chatMode,
        draft_id: "",
        if_plus_model: true,
        input_question_type: "xxxx",
        is_networking: isNetworking,
        is_test: false,
        platform: "pc",
        quote_log_id: "",
        cogview: { rm_label_watermark: false },
      },
    });

    const { timestamp, nonce, sign } = buildSign();
    const deviceId = genDeviceId();
    const requestId = genRequestId();

    const accessToken = await this._getAccessToken(account);

    const resp = await fetch(`${GLM_BASE_URL}/backend-api/assistant/stream`, {
      method: "POST",
      headers: buildHeaders(accessToken, {
        accept: "text/event-stream",
        contentType: "application/json",
        referer: "https://chatglm.cn/main/alltoolsdetail",
        headers: {
          "X-Device-Id": deviceId,
          "X-Nonce": nonce,
          "X-Request-Id": requestId,
          "X-Sign": sign,
          "X-Timestamp": timestamp,
        },
      }),
      body: requestBody,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      if (resp.status === 429 && errText.includes("请等待其他对话生成完毕")) {
        const err = new Error("GLM 正在处理其他对话，请稍后重试");
        err.status = 429;
        throw err;
      }
      const err = new Error(`GLM 请求失败 HTTP ${resp.status}: ${errText.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }

    // 将 account 和 assistantId 附加到 response 上，供调用方清理会话
    resp._account = account;
    resp._assistantId = assistantId;
    resp._conversationId = "";
    resp._provider = this;

    return resp;
  }

  /**
   * 从 SSE 流中提取 conversation_id（由 bridge 层在消费流时调用）
   */
  extractConversationIdFromPayload(payload) {
    if (payload && typeof payload === "object" && payload.conversation_id) {
      return String(payload.conversation_id);
    }
    return null;
  }

  /**
   * 删除 GLM 云端会话
   */
  async _deleteConversation(account, conversationId, assistantId) {
    if (!conversationId) return;

    const { timestamp, nonce, sign } = buildSign();
    const deviceId = genDeviceId();
    const requestId = genRequestId();

    const accessToken = await this._getAccessToken(account).catch(() => null);
    if (!accessToken) return;

    const body = JSON.stringify({
      assistant_id: assistantId || DEFAULT_ASSISTANT_ID,
      conversation_id: conversationId,
    });

    try {
      const resp = await fetch(`${GLM_BASE_URL}/backend-api/assistant/conversation/delete`, {
        method: "POST",
        headers: buildHeaders(accessToken, {
          contentType: "application/json",
          referer: "https://chatglm.cn/main/alltoolsdetail",
          headers: {
            "X-Device-Id": deviceId,
            "X-Nonce": nonce,
            "X-Request-Id": requestId,
            "X-Sign": sign,
            "X-Timestamp": timestamp,
          },
        }),
        body,
      });

      if (!resp.ok) {
        console.error("[GLM] 删除会话失败:", conversationId, resp.status);
      }
    } catch (e) {
      console.error("[GLM] 删除会话异常:", conversationId, e.message);
    }
  }

  async deleteChatSession(sessionId, accountId) {
    const account = accountId
      ? this.getAccountInfo(accountId)
      : this.getDefaultAccount();
    if (!account || !sessionId) return;
    await this._deleteConversation(account, sessionId, DEFAULT_ASSISTANT_ID);
  }

  // ── 图片生成 ──

  /**
   * 图片生成
   * @param {object} options
   * @param {string} options.prompt - 提示词
   * @param {string} [options.model] - 模型 ID，默认 glm-image-1
   * @param {string} [options.size] - "1024x1024"|"1024x1536"|"1536x1024"|"1024x1792"|"1792x1024"
   * @param {string} [options.style] - 风格
   * @param {number} [options.n] - 生成数量，默认 1
   * @param {string} [options.accountId] - 账号 ID
   * @returns {Promise<{urls: string[], conversationId: string}>}
   */
  async generateImage(options = {}) {
    const account = options.accountId
      ? this.getAccountInfo(options.accountId)
      : this.getDefaultAccount();
    if (!account) throw new Error("未登录 GLM，请先运行 chat2cli login");

    await this._ensureTokenReady(account);

    const prompt = options.prompt || "";
    if (!prompt) throw new Error("缺少 prompt 参数");

    const size = String(options.size || "1024x1024").trim();
    const aspectRatio = this._resolveAspectRatio(size);
    const style = String(options.style || "none").trim();
    const scene = String(options.scene || "none").trim();

    const requestBody = JSON.stringify({
      assistant_id: IMAGE_ASSISTANT_ID,
      conversation_id: "",
      project_id: "",
      chat_type: "user_chat",
      meta_data: {
        cogview: {
          aspect_ratio: aspectRatio,
          style,
          scene,
          chat_model: "",
          rm_label_watermark: false,
        },
        is_test: false,
        input_question_type: "xxxx",
        channel: "",
        draft_id: "",
        chat_mode: "",
        is_networking: false,
        quote_log_id: "",
        platform: "pc",
      },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      ],
    });

    const { timestamp, nonce, sign } = buildSign();
    const deviceId = genDeviceId();
    const requestId = genRequestId();

    const accessToken = await this._getAccessToken(account);

    const resp = await fetch(`${GLM_BASE_URL}/backend-api/assistant/stream`, {
      method: "POST",
      headers: buildHeaders(accessToken, {
        accept: "text/event-stream",
        contentType: "application/json",
        referer: "https://chatglm.cn/main/alltoolsdetail",
        headers: {
          "X-Device-Id": deviceId,
          "X-Nonce": nonce,
          "X-Request-Id": requestId,
          "X-Sign": sign,
          "X-Timestamp": timestamp,
        },
      }),
      body: requestBody,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`GLM 图片生成失败 HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    // 收集流式响应，提取图片 URL
    const decoder = new TextDecoder();
    const reader = resp.body.getReader();
    let buffer = "";
    let conversationId = "";
    const imageUrls = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (buffer.includes("\n\n")) {
          const idx = buffer.indexOf("\n\n");
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const lines = block.split("\n").filter((l) => l.startsWith("data:"));
          if (lines.length === 0) continue;
          const payloadText = lines.map((l) => l.slice(5).trimStart()).join("\n");
          if (!payloadText || payloadText === "[DONE]") continue;

          let payload;
          try { payload = JSON.parse(payloadText); } catch { continue; }

          if (!conversationId && payload.conversation_id) {
            conversationId = String(payload.conversation_id);
          }

          const parts = payload.parts;
          if (!Array.isArray(parts)) continue;

          for (const part of parts) {
            if (!part || typeof part !== "object") continue;
            const contentItems = part.content;
            if (!Array.isArray(contentItems)) continue;

            for (const item of contentItems) {
              if (!item || typeof item !== "object") continue;
              if (item.type === "image") {
                const images = item.image || [];
                for (const img of Array.isArray(images) ? images : []) {
                  if (img && img.image_url) {
                    imageUrls.push(String(img.image_url));
                  }
                }
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock?.();
      if (conversationId) {
        await this._deleteConversation(account, conversationId, IMAGE_ASSISTANT_ID).catch(() => {});
      }
    }

    if (imageUrls.length === 0) {
      throw new Error("GLM 图片生成完成但未返回图片 URL");
    }

    return { urls: imageUrls, conversationId };
  }

  /**
   * 将 OpenAI 尺寸映射为 GLM 宽高比
   */
  _resolveAspectRatio(size) {
    const map = {
      "1024x1024": "1:1",
      "1024x1536": "2:3",
      "1536x1024": "3:2",
      "1024x1792": "9:16",
      "1792x1024": "16:9",
    };
    const normalized = size.trim().toLowerCase();
    if (map[normalized]) return map[normalized];
    // 如果已经是 "W:H" 格式
    if (/^\d+:\d+$/.test(normalized)) return normalized;
    return "1:1";
  }

  // ── 会话列表 ──

  /**
   * 获取当前账号的远端会话列表
   * GLM 网页端似乎没有公开的会话列表 API，返回空列表
   */
  async listSessions(accountId) {
    return [];
  }
}
