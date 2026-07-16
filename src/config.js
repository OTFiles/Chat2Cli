import { getStore, updateStore } from "./storage/store.js";

export function getConfig() {
  return getStore().config;
}

export function setConfigKey(key, value) {
  return updateStore((state) => ({
    ...state,
    config: { ...state.config, [key]: value }
  }));
}

export function getProviderConfig(providerName) {
  const config = getConfig();
  return config?.providers?.[providerName] || {};
}

export function setProviderConfigKey(providerName, key, value) {
  return updateStore((state) => {
    const config = { ...state.config };
    if (!config.providers) config.providers = {};
    config.providers[providerName] = {
      ...(config.providers[providerName] || {}),
      [key]: value
    };
    return { ...state, config };
  });
}

/** 获取当前 provider 的默认模型（per-provider 优先，fallback 到全局 defaultModel） */
export function getModelForProvider(providerName) {
  const config = getConfig();
  const providerModels = config?.providerModels || {};
  return providerModels[providerName] || config?.defaultModel || null;
}

/** 保存当前 provider 选择的模型（持久化到 providerModels） */
export function setModelForProvider(providerName, modelId) {
  return updateStore((state) => {
    const config = { ...state.config };
    const providerModels = { ...(config.providerModels || {}) };
    providerModels[providerName] = modelId;
    config.providerModels = providerModels;
    return { ...state, config };
  });
}

export function getCurrentProviderName() {
  return getConfig().defaultProvider;
}

export function getCurrentModel() {
  return getConfig().defaultModel;
}

// ── Agent 配置 ──

export function getAgentConfig() {
  const config = getConfig();
  return config.agent || {};
}

export function setAgentConfigKey(key, value) {
  return updateStore((state) => {
    const agent = { ...(state.config.agent || {}) };
    agent[key] = value;
    return { ...state, config: { ...state.config, agent } };
  });
}

// ── 聊天参数配置 ──

/** 获取聊天选项（thinking_enabled, enable_search 等），支持 per-provider fallback */
export function getChatOptions(providerName) {
  const config = getConfig();
  const chatOpts = config?.chatOptions || {};
  const providerOpts = chatOpts[providerName] || {};
  return {
    thinkingEnabled: providerOpts.thinkingEnabled ?? chatOpts._global?.thinkingEnabled ?? true,
    enableSearch: providerOpts.enableSearch ?? chatOpts._global?.enableSearch ?? false,
    keepSession: providerOpts.keepSession ?? chatOpts._global?.keepSession ?? true,
  };
}

export function setChatOption(providerName, key, value) {
  return updateStore((state) => {
    const config = { ...state.config };
    const chatOptions = { ...(config.chatOptions || {}) };
    if (!chatOptions[providerName]) chatOptions[providerName] = {};
    chatOptions[providerName] = { ...chatOptions[providerName], [key]: value };
    config.chatOptions = chatOptions;
    return { ...state, config };
  });
}
