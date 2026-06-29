import { BaseProvider } from "../base.js";
import { getStore, updateStore } from "../../storage/store.js";

const OPENAI_MODELS = [
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini" },
  { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
  { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
  { id: "o1", label: "o1" },
  { id: "o3-mini", label: "o3-mini" }
];

export class OpenAIProvider extends BaseProvider {
  get name() { return "openai"; }
  get label() { return "OpenAI"; }

  async login(credentials) {
    const { apiKey, baseUrl } = credentials;

    const account = {
      apiKey,
      baseUrl: baseUrl || "https://api.openai.com",
      createdAt: new Date().toISOString()
    };

    updateStore((state) => ({
      ...state,
      providers: {
        ...state.providers,
        openai: account
      }
    }));

    return account;
  }

  getAccountInfo() {
    const state = getStore();
    return state.providers.openai || null;
  }

  isAuthenticated() {
    const info = this.getAccountInfo();
    return !!(info && info.apiKey);
  }

  async *chat(messages, options = {}) {
    const account = this.getAccountInfo();
    if (!account?.apiKey) throw new Error("未配置 OpenAI API Key，请先运行 chat2cli login");

    const baseUrl = account.baseUrl || "https://api.openai.com";
    const url = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

    const body = {
      model: options.model || "gpt-4o-mini",
      messages: messages.map(({ role, content }) => ({ role, content })),
      stream: options.stream !== false
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${account.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `HTTP ${response.status}`);
    }

    if (!body.stream) {
      const data = await response.json();
      const choice = data.choices?.[0];
      if (choice?.message?.content) {
        yield { kind: "response", text: choice.message.content };
      }
      return;
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));

      for (const line of lines) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            yield { kind: "response", text: delta.content };
          }
        } catch {
          // 跳过无法解析的行
        }
      }
    }
  }

  getModels() {
    return OPENAI_MODELS;
  }

  async createChatSession() {
    return null;
  }

  async deleteChatSession() {
    return null;
  }
}
