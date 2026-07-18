import { DeepSeekProvider } from "./deepseek/index.js";
import { OpenAIProvider } from "./openai/index.js";
import { QwenProvider } from "./qwen/index.js";
import { GlmProvider } from "./glm/index.js";

const registry = new Map();

/** 已经注册的内置 provider 名称集合（用于扩展冲突检测） */
const builtinNames = new Set();

export function registerProvider(providerClass) {
  const instance = new providerClass();
  registry.set(instance.name, instance);
  return instance;
}

/**
 * 注册一个已实例化的 provider（扩展 provider 已经通过 new 创建）
 */
export function registerProviderInstance(instance) {
  if (!instance || !instance.name) return null;

  if (builtinNames.has(instance.name)) {
    console.warn(`[Provider] 扩展 provider "${instance.name}" 与内置同名，已跳过`);
    return null;
  }

  if (registry.has(instance.name)) {
    console.warn(`[Provider] provider "${instance.name}" 已注册，已跳过`);
    return null;
  }

  registry.set(instance.name, instance);
  return instance;
}

export function initProviders() {
  registerProvider(DeepSeekProvider);
  registerProvider(OpenAIProvider);
  registerProvider(QwenProvider);
  registerProvider(GlmProvider);

  // 记录内置名称
  for (const name of registry.keys()) {
    builtinNames.add(name);
  }
}

/**
 * 注册所有扩展提供的 provider 实例
 * @param {Array<object>} instances - 已实例化的 provider 对象数组
 */
export function registerExtensionProviders(instances) {
  for (const inst of instances) {
    registerProviderInstance(inst);
  }
}

export function getBuiltinProviderNames() {
  return new Set(builtinNames);
}

export function getProvider(name) {
  return registry.get(name) || null;
}

export function listProviders() {
  return [...registry.values()];
}
