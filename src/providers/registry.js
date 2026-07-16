import { DeepSeekProvider } from "./deepseek/index.js";
import { OpenAIProvider } from "./openai/index.js";
import { QwenProvider } from "./qwen/index.js";
import { GlmProvider } from "./glm/index.js";

const registry = new Map();

export function registerProvider(providerClass) {
  const instance = new providerClass();
  registry.set(instance.name, instance);
  return instance;
}

export function initProviders() {
  registerProvider(DeepSeekProvider);
  registerProvider(OpenAIProvider);
  registerProvider(QwenProvider);
  registerProvider(GlmProvider);
}

export function getProvider(name) {
  return registry.get(name) || null;
}

export function listProviders() {
  return [...registry.values()];
}
