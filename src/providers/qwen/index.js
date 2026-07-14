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
      throw new Error("Qwen token 已失效，请重新登录");
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

/** 构建 Qwen 聊天请求 payload */
function buildQwenPayload(chatId, model, prompt, options = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const fid = genFid();
  const childId = genFid();

  const thinkingEnabled = options.thinkingEnabled !== false;
  const enableSearch = options.enableSearch === true;

  const thinking = thinkingEnabled;
  const autoThinking = thinkingEnabled;
  const thinkingMode = thinkingEnabled ? "Auto" : "Disabled";

  const featureConfig = {
    thinking_enabled: thinking,
    output_schema: "phase",
    research_mode: "normal",
    auto_thinking: autoThinking,
    thinking_mode: thinkingMode,
    thinking_format: "summary",
    auto_search: enableSearch,
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

/**
 * 解析 Qwen SSE 数据行，提取 thinking / response delta
 * 参照 qwen2API ParseQwenEvent() 支持多种响应格式
 * @returns {Array<{kind: string, text: string}>|null}
 */
/** 将 extra 中的 summary_title / summary_thought 的 content 数组展开为 thinking 文本 */
function extractSummaryThinking(extra) {
  if (!extra) return "";
  const parts = [];
  for (const key of ["summary_title", "summary_thought"]) {
    const val = extra[key];
    if (!val) continue;
    const items = val?.content;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item === "string" && item.trim()) parts.push(item.trim());
      }
    } else if (typeof items === "string" && items.trim()) {
      parts.push(items.trim());
    }
  }
  return parts.join("\n");
}

function parseQwenSseData(jsonStr) {
  try {
    const obj = JSON.parse(jsonStr);
    const events = [];

    // 跳过 response.created 等元数据事件
    if (obj["response.created"]) return null;

    // 1. 处理 choices[0].delta
    const choice = obj?.choices?.[0];
    if (choice?.delta) {
      const delta = choice.delta;
      const extra = delta.extra;

      // reasoning 字段（多种变体）
      const reasoning = firstString(delta.reasoning_content, delta.reasoning,
        delta.reasoning_text, delta.thinking, delta.thoughts,
        extra?.reasoning_content, extra?.reasoning,
        extra?.reasoning_text, extra?.thinking, extra?.thoughts);

      // thinking_summary 阶段：extra.summary_title / extra.summary_thought
      const summaryThinking = extractSummaryThinking(extra);
      const allThinking = [reasoning, summaryThinking].filter(Boolean).join("\n");

      const content = delta.content || "";

      if (allThinking) events.push({ kind: "thinking", text: allThinking });
      if (content) events.push({ kind: "response", text: content });
    }

    // 2. 处理顶层 content/reasoning 字段
    const topReasoning = firstString(obj.reasoning_content, obj.reasoning, obj.thinking);
    const topContent = firstString(obj.content, obj.answer, obj.text, obj.delta);
    if (topReasoning) events.push({ kind: "thinking", text: topReasoning });
    if (topContent) events.push({ kind: "response", text: topContent });

    // 3. 递归解析 data 和 message 子对象
    if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
      const subEvents = parseQwenSseData(JSON.stringify(obj.data));
      if (subEvents) events.push(...subEvents);
    }
    if (obj.message && typeof obj.message === "object" && !Array.isArray(obj.message)) {
      const subEvents = parseQwenSseData(JSON.stringify(obj.message));
      if (subEvents) events.push(...subEvents);
    }

    return events.length > 0 ? events : null;
  } catch {
    return null;
  }
}

/** 返回第一个非空字符串值 */
function firstString(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return "";
}

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

  async login(credentials) {
    let token, email, displayName;

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
    }

    if (!token) throw new Error("请提供 token 或邮箱+密码");

    displayName = displayName || email || token.slice(0, 12) + "...";

    const account = {
      id: createId(),
      token,
      email,
      displayName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    updateStore((state) => {
      const providers = { ...state.providers };
      if (!providers.qwen) providers.qwen = { accounts: [] };
      const existingIdx = providers.qwen.accounts.findIndex(
        (a) => a.token === account.token
      );
      if (existingIdx >= 0) {
        providers.qwen.accounts[existingIdx] = account;
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

  // ── models ──

  /** 缓存从 Qwen API 动态拉取的模型列表 */
  _cachedModels = null;
  _modelsLastFetch = 0;

  /**
   * 从 Qwen API 动态获取真实模型列表（参照 qwen2API /api/models）
   * 结果缓存 30 分钟。失败时回退到硬编码列表。
   */
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
        // 响应可能是 { data: [...] } 或直接数组
        const list = Array.isArray(raw) ? raw : (raw?.data || raw?.models || []);
        if (Array.isArray(list) && list.length > 0) {
          const models = list.map(item => ({
            id: item.id || item.model || item.name || "",
            label: item.display_name || item.displayName || item.name || item.id || "",
          })).filter(m => m.id);
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
    // 回退到硬编码列表
    return QWEN_MODELS;
  }

  getModels() {
    // 同步返回：优先用缓存，否则用硬编码（异步版本通过 _fetchModels 获取）
    if (this._cachedModels) return this._cachedModels;
    return QWEN_MODELS;
  }

  // ── CLI 聊天 ──

  async *chat(messages, options = {}) {
    const account = this.getAccountInfo(options.accountId);
    if (!account) throw new Error("未登录 Qwen，请先运行 chat2cli login");

    // 懒拉取真实模型列表，确保模型 ID 有效
    const realModels = await this._fetchModels(account.token);
    const model = options.model || realModels[0]?.id;
    const prompt = buildPromptFromMessages(messages);

    const chatId = await createChatSession(account.token, model);
    const payload = buildQwenPayload(chatId, model, prompt, options);

    const headers = buildHeaders(account.token);
    headers.Accept = "text/event-stream";  // streaming 请求必须的 Accept

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
      await deleteChatSession(account.token, chatId);
      throw new Error(`Qwen 请求失败 HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const contentType = resp.headers.get("content-type") || "";

    // 若返回的不是 SSE 流，读取完整 body 并报错
    if (!contentType.includes("text/event-stream")) {
      const fullBody = await resp.text().catch(() => "<read failed>");
      console.error("[Qwen] Non-SSE response:", fullBody.slice(0, 500));
      await deleteChatSession(account.token, chatId);
      throw new Error(`Qwen 请求错误: ${fullBody.slice(0, 150)}`);
    }

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
      await deleteChatSession(account.token, chatId);
    }
  }

  // ── Server / Agent 桥接 ──

  async startCompletion(messages, options = {}) {
    const account = options.accountId
      ? this.getAccountInfo(options.accountId)
      : this.getDefaultAccount();
    if (!account) throw new Error("未登录 Qwen，请先运行 chat2cli login");

    const realModels = await this._fetchModels(account.token);
    const model = options.model || realModels[0]?.id;
    const prompt = options.prompt || buildPromptFromMessages(messages);

    // 续聊时复用已有 chatId，否则创建新的
    const chatId = options.sessionId || await createChatSession(account.token, model);
    const payload = buildQwenPayload(chatId, model, prompt, options);
    // 续聊时设置 parent_id
    if (options.parentMessageId) {
      payload.messages[0].parent_id = options.parentMessageId;
    }

    const headers = buildHeaders(account.token);
    headers.Accept = "text/event-stream";  // streaming 请求必须的 Accept

    const resp = await fetch(
      `${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }
    );

    // Agent 循环用：附加 sessionId 供后续续聊
    resp._sessionId = chatId;
    return resp;
  }
}
