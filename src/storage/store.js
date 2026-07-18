import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA_DIR = join(homedir(), ".chat2cli");
const DATA_FILE = join(DATA_DIR, "data.json");

mkdirSync(DATA_DIR, { recursive: true });

function defaultState() {
  return {
    config: {
      defaultProvider: "deepseek",
      defaultModel: "deepseek-chat-fast"
    },
    providers: {},
    apiKeys: [],
    conversations: [],
    extensions: {
      paths: [],
      disabled: []
    }
  };
}

function normalizeApiKeys(value) {
  if (!Array.isArray(value)) return [];
  return value.map((k) => ({
    id: k.id || "",
    key: k.key || "",
    provider: k.provider || "",
    accountId: k.accountId || null,
    label: k.label || "",
    toolCallsEnabled: Boolean(k.toolCallsEnabled),
    createdAt: k.createdAt || new Date().toISOString()
  }));
}

function normalizeExtensions(value) {
  if (!value || typeof value !== "object") return { paths: [], disabled: [] };
  return {
    paths: Array.isArray(value.paths) ? value.paths.filter(Boolean) : [],
    disabled: Array.isArray(value.disabled) ? value.disabled.filter(Boolean) : []
  };
}

function normalizeConversations(value) {
  if (!Array.isArray(value)) return [];
  return value.map((conv) => ({
    id: conv.id || "",
    provider: conv.provider || "",
    model: conv.model || "",
    title: conv.title || "未命名",
    messages: Array.isArray(conv.messages) ? conv.messages : [],
    createdAt: conv.createdAt || new Date().toISOString(),
    updatedAt: conv.updatedAt || new Date().toISOString()
  }));
}

function normalizeState(value) {
  if (!value || typeof value !== "object") return defaultState();
  return {
    config: {
      ...value.config,
      defaultProvider: value.config?.defaultProvider || "deepseek",
      defaultModel: value.config?.defaultModel || "deepseek-chat-fast"
    },
    providers: value.providers && typeof value.providers === "object" ? value.providers : {},
    apiKeys: normalizeApiKeys(value.apiKeys),
    conversations: normalizeConversations(value.conversations),
    extensions: normalizeExtensions(value.extensions)
  };
}

function readStore() {
  if (!existsSync(DATA_FILE)) {
    const state = defaultState();
    writeStore(state);
    return state;
  }
  const raw = readFileSync(DATA_FILE, "utf8");
  return normalizeState(JSON.parse(raw));
}

function writeStore(state) {
  writeFileSync(DATA_FILE, JSON.stringify(normalizeState(state), null, 2));
}

export function updateStore(updater) {
  const current = readStore();
  const next = updater(current);
  writeStore(next);
  return next;
}

export function getStore() {
  return readStore();
}
