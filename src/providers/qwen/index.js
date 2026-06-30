import { randomUUID, randomBytes, createHash } from "node:crypto";
import { BaseProvider } from "../base.js";
import { getStore, updateStore } from "../../storage/store.js";
import { createId } from "../../utils/id.js";
import { buildPromptFromMessages } from "../../bridge.js";

const QWEN_BASE_URL = "https://chat.qwen.ai";

const QWEN_MODELS = [
  { id: "qwen-max", label: "Qwen Max" },
  { id: "qwen-plus", label: "Qwen Plus" },
  { id: "qwen-turbo", label: "Qwen Turbo" },
  { id: "qwen3.5-coder", label: "Qwen3.5 Coder" },
  { id: "qwq-plus", label: "QwQ Plus" },
  { id: "qwq-plus-latest", label: "QwQ Plus Latest" },
];

function genRequestId() {
  return randomUUID();
}

function genFid() {
  return randomBytes(16).toString("hex");
}

function buildHeaders(token) {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-request-id": genRequestId(),
    Origin: QWEN_BASE_URL,
    Referer: `${QWEN_BASE_URL}/`,
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
function buildQwenPayload(chatId, model, prompt, thinkingEnabled = true, enableSearch = false) {
  const ts = Math.floor(Date.now() / 1000);
  const fid = genFid();
  const childId = genFid();

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
 */
function parseQwenSseData(jsonStr) {
  try {
    const obj = JSON.parse(jsonStr);
    const choice = obj?.choices?.[0];
    if (!choice) return null;
    const delta = choice.delta;
    if (!delta) return null;

    // reasoning_content → thinking
    if (delta.reasoning_content) {
      return { kind: "thinking", text: delta.reasoning_content };
    }
    // content → response
    if (delta.content) {
      return { kind: "response", text: delta.content };
    }
    return null;
  } catch {
    return null;
  }
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

    const resp = await fetch(`${QWEN_BASE_URL}/api/v2/auths/signin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (Android 10; Mobile; rv:150.0) Gecko/150.0 Firefox/150.0",
        Referer: "https://chat.qwen.ai/auth?action=signin",
        Version: "0.2.68",
        source: "h5",
        "X-Request-Id": genRequestId(),
        "bx-v": "2.5.36",
        Origin: QWEN_BASE_URL,
      },
      body: JSON.stringify({ email, password: passwordHash }),
      timeout: 15000,
    });

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

  isAuthenticated() {
    const info = this.getDefaultAccount();
    return !!(info && info.token);
  }

  // ── models ──

  getModels() {
    return QWEN_MODELS;
  }

  // ── CLI 聊天 ──

  async *chat(messages, options = {}) {
    const account = this.getAccountInfo(options.accountId);
    if (!account) throw new Error("未登录 Qwen，请先运行 chat2cli login");

    const model = options.model || "qwen-max";
    const prompt = buildPromptFromMessages(messages);

    const chatId = await createChatSession(account.token, model);
    const payload = buildQwenPayload(chatId, model, prompt);

    const resp = await fetch(
      `${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`,
      {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify(payload),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      await deleteChatSession(account.token, chatId);
      throw new Error(`Qwen 请求失败 HTTP ${resp.status}: ${errText.slice(0, 200)}`);
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

          const delta = parseQwenSseData(data);
          if (delta) yield delta;
        }
      }
    } finally {
      reader.releaseLock?.();
      await deleteChatSession(account.token, chatId);
    }
  }

  // ── Server 桥接 ──

  async startCompletion(messages, options = {}) {
    const account = options.accountId
      ? this.getAccountInfo(options.accountId)
      : this.getDefaultAccount();
    if (!account) throw new Error("未登录 Qwen，请先运行 chat2cli login");

    const model = options.model || "qwen-max";
    const prompt = options.prompt || buildPromptFromMessages(messages);

    const chatId = await createChatSession(account.token, model);
    const payload = buildQwenPayload(chatId, model, prompt);

    const resp = await fetch(
      `${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`,
      {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify(payload),
      }
    );

    // 后台删除会话
    deleteChatSession(account.token, chatId);

    return resp;
  }
}
