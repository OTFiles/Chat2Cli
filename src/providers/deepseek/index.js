import { BaseProvider } from "../base.js";
import { loginToDeepseek } from "./auth.js";
import { startDeepseekCompletion, streamRawDeltas } from "./chat.js";
import { createChatSession, deleteChatSession, fetchSessionPage, fetchSessionMessages } from "./proxy.js";
import { createId } from "../../utils/id.js";
import { getStore, updateStore } from "../../storage/store.js";
import { buildPromptFromMessages, buildChatCompletionBody } from "../../bridge.js";

const DEEPSEEK_MODELS = [
  { id: "deepseek-chat-fast", label: "DeepSeek Chat Fast" },
  { id: "deepseek-chat-fast-search", label: "DeepSeek Chat Fast (联网)" },
  { id: "deepseek-reasoner-fast", label: "DeepSeek Reasoner Fast" },
  { id: "deepseek-reasoner-fast-search", label: "DeepSeek Reasoner Fast (联网)" },
  { id: "deepseek-chat-expert", label: "DeepSeek Chat Expert" },
  { id: "deepseek-chat-expert-search", label: "DeepSeek Chat Expert (联网)" },
  { id: "deepseek-reasoner-expert", label: "DeepSeek Reasoner Expert" },
  { id: "deepseek-reasoner-expert-search", label: "DeepSeek Reasoner Expert (联网)" }
];

export class DeepSeekProvider extends BaseProvider {
  get name() { return "deepseek"; }
  get label() { return "DeepSeek"; }

  async login(credentials) {
    const { loginValue, password } = credentials;
    const deviceId = createId();
    const loginResult = await loginToDeepseek({ loginValue, password, deviceId });
    const user = loginResult.data.biz_data.user;

    const account = {
      id: createId(),
      loginValue,
      password,
      deviceId,
      token: user.token,
      deepseekUserId: user.id,
      displayName: user.email || user.mobile_number || loginValue,
      emailMasked: user.email || "",
      mobileMasked: user.mobile_number || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    updateStore((state) => {
      const providers = { ...state.providers };
      if (!providers.deepseek) providers.deepseek = { accounts: [] };
      const existingIdx = providers.deepseek.accounts.findIndex(
        (a) => a.deepseekUserId === account.deepseekUserId
      );
      if (existingIdx >= 0) {
        providers.deepseek.accounts[existingIdx] = account;
      } else {
        providers.deepseek.accounts.push(account);
      }
      return { ...state, providers };
    });

    return account;
  }

  /** 列出所有已保存的账号 */
  listAccounts() {
    const state = getStore();
    return state.providers?.deepseek?.accounts || [];
  }

  /** 获取默认账号（第一个） */
  getAccountInfo(accountId) {
    const accounts = this.listAccounts();
    if (accountId) return accounts.find((a) => a.id === accountId) || null;
    return accounts[0] || null;
  }

  /** 获取默认账号用于快速检查 */
  getDefaultAccount() {
    return this.getAccountInfo();
  }

  isAuthenticated() {
    const info = this.getDefaultAccount();
    return !!(info && info.token);
  }

  /** 异步聊天（CLI 用） */
  async *chat(messages, options = {}) {
    const account = this.getAccountInfo(options.accountId);
    if (!account) throw new Error("未登录 DeepSeek，请先运行 chat2cli login");

    const model = options.model || "deepseek-chat-fast";

    // 继聊：只发送最后一条消息，设置 parent_message_id
    let prompt, parentId;
    const sessionId = options.sessionId || await createChatSession(account);

    if (options.sessionId && options.parentMessageId) {
      // 继续已有会话：只发新用户消息，引用上次回复
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      prompt = lastUser?.content || "";
      parentId = options.parentMessageId;
    } else {
      // 新会话或无父消息引用：发送完整历史
      prompt = buildPromptFromMessages(messages);
      parentId = null;
    }

    const body = buildChatCompletionBody({ sessionId, prompt, model });
    if (parentId) body.parent_message_id = parentId;

    const { response } = await startDeepseekCompletion({ account, body });
    yield* streamRawDeltas(response);
  }

  /** Server 用
   *  options.prompt 可覆盖自动构建的 prompt（用于注入工具调用提示）
   *  options.accountId 可指定使用特定 DeepSeek 账号
   */
  async startCompletion(messages, options = {}) {
    const account = options.accountId
      ? this.getAccountInfo(options.accountId)
      : this.getDefaultAccount();
    if (!account) throw new Error("未登录 DeepSeek，请先运行 chat2cli login");

    const model = options.model || "deepseek-chat-fast";
    const prompt = options.prompt || buildPromptFromMessages(messages);
    const sessionId = await createChatSession(account);
    const body = buildChatCompletionBody({ sessionId, prompt, model });

    const { response } = await startDeepseekCompletion({ account, body });
    return response;
  }

  /** 获取 DS 会话列表（游标分页，单页）
   *  cursor: 游标时间戳（秒），不传则默认当前时间+300 */
  async fetchSessionPage(accountId, cursor) {
    const account = this.getAccountInfo(accountId);
    if (!account) throw new Error("账号未找到");
    return fetchSessionPage(account, cursor);
  }

  /** 获取 DS 会话列表（游标分页，自动页到底）
   *  参照 deepseek2api session-workspace.js fetchAllSessions */
  async fetchSessions(accountId, count = 0) {
    const account = this.getAccountInfo(accountId);
    if (!account) throw new Error("账号未找到");

    const maxCount = count || 10000; // 不传 limit 时加载全部
    const all = [];
    const seen = new Set();
    let cursor = Math.floor(Date.now() / 1000) + 300;

    while (all.length < maxCount) {
      const { sessions, hasMore, lastUpdatedAt } = await fetchSessionPage(account, cursor);
      for (const s of sessions) {
        if (!seen.has(s.id)) {
          seen.add(s.id);
          all.push(s);
          if (all.length >= maxCount) break;
        }
      }
      if (!hasMore || !lastUpdatedAt || all.length >= maxCount) break;
      cursor = lastUpdatedAt;
    }
    return { sessions: all, total: all.length };
  }

  /** 获取 DS 会话的消息，返回 { messages, currentMessageId } */
  async fetchMessages(accountId, sessionId) {
    const account = this.getAccountInfo(accountId);
    if (!account) throw new Error("账号未找到");
    return fetchSessionMessages(account, sessionId);
  }

  /** 获取 DS 会话的纯消息数组（向后兼容） */
  async fetchMessageList(accountId, sessionId) {
    const { messages } = await this.fetchMessages(accountId, sessionId);
    return messages;
  }

  /** 继续已有会话（使用已有 sessionId） */
  async *continueSession(accountId, sessionId, model, messages) {
    const account = this.getAccountInfo(accountId);
    if (!account) throw new Error("账号未找到");

    const prompt = buildPromptFromMessages(messages);
    const body = buildChatCompletionBody({ sessionId, prompt, model: model || "deepseek-chat-fast" });

    const { response } = await startDeepseekCompletion({ account, body });
    yield* streamRawDeltas(response);
  }

  getModels() {
    return DEEPSEEK_MODELS;
  }

  async deleteSession(accountId, sessionId) {
    const account = this.getAccountInfo(accountId);
    if (!account) throw new Error("账号未找到");
    return deleteChatSession(account, sessionId);
  }
}
