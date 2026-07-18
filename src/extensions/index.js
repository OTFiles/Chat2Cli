/**
 * chat2cli 扩展系统
 *
 * 用法：
 *   import { initExtensions } from "./extensions/index.js";
 *   const { hooks, loaded } = await initExtensions({ cwd: process.cwd() });
 */

import { loadExtensions } from "./loader.js";
import { createHookSystem } from "./hooks.js";
import {
  getExtensionProviders, getExtensionTools, getExtensionToolExecutors,
  getExtensionCommands, getExtensionTuiCommands, getExtensionRoutes,
  getExtensionPromptSections, listExtensions
} from "./registry.js";
import { registerExtensionProviders, getBuiltinProviderNames } from "../providers/registry.js";
import { registerTool, registerToolExecutor, getBuiltinToolNames } from "../agent/tools/registry.js";

export { registerExtension, unregisterExtension, listExtensions, getExtension,
  getExtensionProviders, getExtensionTools, getExtensionToolExecutors,
  getExtensionCommands, getExtensionTuiCommands, getExtensionHooks,
  getExtensionRoutes, getExtensionPromptSections, clearExtensions } from "./registry.js";

export { loadExtensions, unloadExtensions, getSearchPaths } from "./loader.js";
export { createHookSystem } from "./hooks.js";

/**
 * 初始化扩展系统（一站式入口）
 *
 * 执行顺序：
 * 1. 扫描并加载扩展文件
 * 2. 注册扩展 provider
 * 3. 注册扩展工具（定义 + 执行器）
 * 4. 创建钩子系统
 *
 * @param {object} opts
 * @param {string} [opts.cwd] - 工作目录
 * @returns {Promise<{ hooks: object, loaded: object[], promptSections: { main: string[], aux: string[] } }>}
 */
export async function initExtensions(opts = {}) {
  const { cwd } = opts;

  // 步骤 1: 加载扩展文件
  const loaded = await loadExtensions({
    cwd,
    builtinProviderNames: getBuiltinProviderNames(),
    builtinToolNames: getBuiltinToolNames()
  });

  // 步骤 2: 注册扩展 provider
  const extProviders = [];
  for (const ext of loaded) {
    if (Array.isArray(ext.providers)) {
      for (const ProviderClass of ext.providers) {
        try {
          const instance = new ProviderClass();
          extProviders.push(instance);
        } catch (err) {
          console.warn(`[扩展:${ext.name}] Provider 实例化失败: ${err.message}`);
        }
      }
    }
  }
  registerExtensionProviders(extProviders);

  // 步骤 3: 注册扩展工具
  for (const tool of getExtensionTools()) {
    registerTool(tool);
  }
  for (const [name, fn] of getExtensionToolExecutors()) {
    registerToolExecutor(name, fn);
  }

  // 步骤 4: 创建钩子系统
  const hooks = createHookSystem();

  // 步骤 5: 收集提示词片段
  const promptSections = {
    main: getExtensionPromptSections("main"),
    aux: getExtensionPromptSections("aux")
  };

  return { hooks, loaded, promptSections, extProviders };
}
