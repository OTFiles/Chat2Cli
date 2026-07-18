/**
 * 扩展加载器
 *
 * 扫描指定目录中的 .js 扩展文件，动态 import 并验证契约。
 * 支持全局路径 (~/.chat2cli/extensions/) 和项目本地路径 (./.chat2cli/extensions/)。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { registerExtension, clearExtensions } from "./registry.js";
import { getStore } from "../storage/store.js";

const GLOBAL_EXT_DIR = join(homedir(), ".chat2cli", "extensions");

/**
 * 验证扩展对象必须字段
 */
function validateExtension(ext) {
  if (!ext || typeof ext !== "object") {
    return { valid: false, error: "扩展必须导出对象" };
  }
  if (!ext.name || typeof ext.name !== "string") {
    return { valid: false, error: "扩展缺少 name 字段" };
  }
  return { valid: true };
}

/**
 * 验证 Provider 类是否实现必要方法
 */
function validateProvider(providerClass, extName) {
  const required = ["name", "label", "login", "getModels", "isAuthenticated"];
  const missing = [];

  // 如果是类（构造函数），检查 prototype
  const proto = providerClass.prototype || providerClass;
  for (const method of required) {
    if (typeof proto[method] !== "function" && typeof providerClass[method] !== "function") {
      missing.push(method);
    }
  }

  if (missing.length > 0) {
    console.warn(`[扩展:${extName}] Provider 缺少必要方法: ${missing.join(", ")}`);
    return false;
  }
  return true;
}

/**
 * 验证工具定义
 */
function validateTool(tool, extName) {
  if (!tool.name || !tool.description) {
    console.warn(`[扩展:${extName}] 工具缺少 name 或 description，已跳过`);
    return false;
  }
  return true;
}

/**
 * 检查名称冲突（内置优先）
 * @param {string} name - 要检查的名称
 * @param {Set<string>} builtinNames - 内置名称集合
 * @param {string} extName - 扩展名（用于日志）
 * @param {string} type - 类型（"provider" | "tool" | "command"）
 * @returns {boolean} true 表示可用（无冲突）
 */
function checkNameConflict(name, builtinNames, extName, type) {
  if (builtinNames.has(name)) {
    console.warn(`[扩展:${extName}] ${type} "${name}" 与内置同名，已跳过`);
    return false;
  }
  return true;
}

/**
 * 加载单个扩展文件
 * @param {string} filePath - .js 文件的绝对路径
 * @param {Set<string>} [builtinProviderNames] - 内置 provider 名称
 * @param {Set<string>} [builtinToolNames] - 内置工具名称
 * @returns {object|null} 加载成功返回扩展对象，失败返回 null
 */
async function loadExtensionFile(filePath, builtinProviderNames, builtinToolNames) {
  try {
    const url = pathToFileURL(filePath).href;
    const mod = await import(url);

    // 支持 export default 或 export default function()
    const ext = typeof mod.default === "function"
      ? await mod.default()
      : mod.default;

    const validation = validateExtension(ext);
    if (!validation.valid) {
      console.warn(`[扩展加载] ${filePath}: ${validation.error}`);
      return null;
    }

    // 过滤 provider
    if (Array.isArray(ext.providers) && builtinProviderNames) {
      ext.providers = ext.providers.filter((p) => {
        const name = p.prototype?.name || p.name;
        if (!validateProvider(p, ext.name)) return false;
        if (!checkNameConflict(name, builtinProviderNames, ext.name, "provider")) return false;
        return true;
      });
    }

    // 过滤工具
    if (Array.isArray(ext.tools) && builtinToolNames) {
      ext.tools = ext.tools.filter((t) => {
        if (!validateTool(t, ext.name)) return false;
        if (!checkNameConflict(t.name, builtinToolNames, ext.name, "tool")) return false;
        return true;
      });
    }

    return ext;
  } catch (err) {
    console.warn(`[扩展加载] 加载 ${filePath} 失败: ${err.message}`);
    return null;
  }
}

/**
 * 扫描目录中的扩展文件
 * @param {string} dir - 目录路径
 * @returns {string[]} .js 文件路径列表
 */
function scanExtensionDir(dir) {
  if (!existsSync(dir)) return [];

  try {
    const entries = readdirSync(dir);
    const results = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const st = statSync(fullPath);
        if (st.isFile() && entry.endsWith(".js") && !entry.startsWith("_")) {
          results.push(fullPath);
        } else if (st.isDirectory()) {
          // 支持子目录中的 index.js
          const indexPath = join(fullPath, "index.js");
          if (existsSync(indexPath)) {
            results.push(indexPath);
          }
        }
      } catch {
        // 跳过无权限的文件
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * 获取搜索路径列表
 *
 * 顺序：
 * 1. 项目本地 .chat2cli/extensions/
 * 2. 全局 ~/.chat2cli/extensions/
 * 3. data.json 中配置的额外路径
 *
 * @param {string} [cwd] - 当前工作目录
 * @returns {string[]}
 */
export function getSearchPaths(cwd) {
  const paths = [];

  // 项目本地
  if (cwd) {
    paths.push(join(cwd, ".chat2cli", "extensions"));
  }

  // 全局
  paths.push(GLOBAL_EXT_DIR);

  // 从存储读取配置的额外路径
  try {
    const store = getStore();
    const configured = store.extensions?.paths;
    if (Array.isArray(configured)) {
      paths.push(...configured.filter(Boolean));
    }
  } catch {
    // 存储不可用时忽略
  }

  return paths;
}

/**
 * 获取禁用扩展列表
 * @returns {Set<string>}
 */
function getDisabledExtensions() {
  try {
    const store = getStore();
    const disabled = store.extensions?.disabled;
    if (Array.isArray(disabled)) {
      return new Set(disabled.filter(Boolean));
    }
  } catch {}
  return new Set();
}

/**
 * 加载所有扩展
 *
 * @param {object} opts
 * @param {string} [opts.cwd] - 当前工作目录（用于发现项目本地扩展）
 * @param {Set<string>} [opts.builtinProviderNames] - 内置 provider 名称集合
 * @param {Set<string>} [opts.builtinToolNames] - 内置工具名称集合
 * @returns {Promise<object[]>} 成功加载的扩展列表
 */
export async function loadExtensions(opts = {}) {
  const { cwd, builtinProviderNames, builtinToolNames } = opts;

  // 清理旧扩展
  clearExtensions();

  const searchPaths = getSearchPaths(cwd);
  const disabled = getDisabledExtensions();
  const loaded = [];

  // 去重（同一文件可能在多个搜索路径中出现）
  const seenFiles = new Set();

  for (const dir of searchPaths) {
    const files = scanExtensionDir(dir);
    for (const file of files) {
      const key = resolve(file);
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);

      const ext = await loadExtensionFile(
        file,
        builtinProviderNames || new Set(),
        builtinToolNames || new Set()
      );

      if (!ext) continue;

      // 检查是否被禁用
      if (disabled.has(ext.name)) {
        console.warn(`[扩展加载] "${ext.name}" 已被禁用，跳过`);
        continue;
      }

      // 检查是否已注册（同名的后续加载被忽略）
      try {
        registerExtension(ext);
        loaded.push(ext);

        // 调用 onLoad 钩子
        if (typeof ext.onLoad === "function") {
          try {
            await ext.onLoad({ cwd });
          } catch (err) {
            console.warn(`[扩展:${ext.name}] onLoad 失败: ${err.message}`);
          }
        }
      } catch (err) {
        console.warn(`[扩展:${ext.name}] 注册失败: ${err.message}`);
      }
    }
  }

  return loaded;
}

/**
 * 卸载所有扩展（调用 onUnload）
 */
export async function unloadExtensions() {
  for (const ext of listAll()) {
    if (typeof ext.onUnload === "function") {
      try {
        await ext.onUnload();
      } catch (err) {
        console.warn(`[扩展:${ext.name}] onUnload 失败: ${err.message}`);
      }
    }
  }
  clearExtensions();
}

// 需要从 registry 导入 listExtensions
import { listExtensions as listAll } from "./registry.js";
