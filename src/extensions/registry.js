/**
 * 扩展注册中心
 *
 * 管理所有已加载的扩展实例，提供按类型查询的能力。
 * 与 src/providers/registry.js 类似的 Map 注册模式。
 */

const registry = new Map();

/**
 * 注册一个扩展实例
 * @param {object} extension - 扩展对象，必须符合扩展契约
 * @returns {object} 注册后的扩展实例
 */
export function registerExtension(extension) {
  if (!extension || !extension.name) {
    throw new Error("扩展必须提供 name 属性");
  }

  if (registry.has(extension.name)) {
    // 已在其他扩展目录同名注册过（非内置冲突），跳过
    return registry.get(extension.name);
  }

  registry.set(extension.name, extension);
  return extension;
}

/**
 * 注销扩展
 * @param {string} name
 */
export function unregisterExtension(name) {
  registry.delete(name);
}

/**
 * 获取所有扩展
 * @returns {Array<object>}
 */
export function listExtensions() {
  return [...registry.values()];
}

/**
 * 获取单个扩展
 * @param {string} name
 * @returns {object|null}
 */
export function getExtension(name) {
  return registry.get(name) || null;
}

/**
 * 清空注册中心（用于测试/重载）
 */
export function clearExtensions() {
  registry.clear();
}

// ── 分类查询 ──

/** 获取所有扩展提供的 Provider 类 */
export function getExtensionProviders() {
  const providers = [];
  for (const ext of registry.values()) {
    if (Array.isArray(ext.providers)) {
      providers.push(...ext.providers);
    }
  }
  return providers;
}

/** 获取所有扩展提供的工具定义 */
export function getExtensionTools() {
  const tools = [];
  for (const ext of registry.values()) {
    if (Array.isArray(ext.tools)) {
      tools.push(...ext.tools);
    }
  }
  return tools;
}

/** 获取所有扩展提供的工具执行器 Map<toolName, executor> */
export function getExtensionToolExecutors() {
  const executors = new Map();
  for (const ext of registry.values()) {
    if (Array.isArray(ext.toolExecutors)) {
      for (const { name, fn } of ext.toolExecutors) {
        executors.set(name, fn);
      }
    }
  }
  return executors;
}

/** 获取所有扩展提供的 CLI 命令 */
export function getExtensionCommands() {
  const commands = [];
  for (const ext of registry.values()) {
    if (Array.isArray(ext.commands)) {
      commands.push(...ext.commands);
    }
  }
  return commands;
}

/** 获取所有扩展提供的 TUI 命令 */
export function getExtensionTuiCommands() {
  const commands = [];
  for (const ext of registry.values()) {
    if (Array.isArray(ext.tuiCommands)) {
      commands.push(...ext.tuiCommands);
    }
  }
  return commands;
}

/** 获取所有扩展的钩子注册 */
export function getExtensionHooks() {
  const hooks = [];
  for (const ext of registry.values()) {
    if (Array.isArray(ext.hooks)) {
      hooks.push(...ext.hooks);
    }
  }
  return hooks;
}

/** 获取所有扩展的 HTTP 路由 */
export function getExtensionRoutes() {
  const routes = [];
  for (const ext of registry.values()) {
    if (Array.isArray(ext.serverRoutes)) {
      routes.push(...ext.serverRoutes);
    }
  }
  return routes;
}

/**
 * 获取所有扩展的提示词片段
 * @param {"main"|"aux"} role - 目标角色
 * @returns {string[]} 片段列表
 */
export function getExtensionPromptSections(role = "main") {
  const sections = [];
  for (const ext of registry.values()) {
    const ps = ext.promptSections;
    if (ps && typeof ps[role] === "string" && ps[role].trim()) {
      sections.push(ps[role].trim());
    }
  }
  return sections;
}
