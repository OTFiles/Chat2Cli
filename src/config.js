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

export function getCurrentProviderName() {
  return getConfig().defaultProvider;
}

export function getCurrentModel() {
  return getConfig().defaultModel;
}
