/**
 * 扩展钩子系统
 *
 * 提供事件发射能力，支持扩展在关键生命周期节点注入逻辑。
 * 钩子处理器按注册顺序同步/异步执行。
 */

import { getExtensionHooks } from "./registry.js";

/**
 * 初始化钩子系统
 * @returns {object} 钩子 API
 */
export function createHookSystem() {
  // 从扩展注册表加载钩子
  const extensionHooks = getExtensionHooks();

  /**
   * 触发指定事件
   * @param {string} event - 事件名
   * @param {object} payload - 传递给处理器的可变对象
   * @param {object} ctx - 上下文（cwd, role 等）
   * @returns {Promise<object>} 汇总结果 { blocked: boolean, reason?: string, modified: boolean }
   */
  async function emit(event, payload = {}, ctx = {}) {
    const handlers = extensionHooks.filter((h) => h.event === event);
    let blocked = false;
    let reason = "";
    let modified = false;

    for (const hook of handlers) {
      if (blocked) break;

      try {
        const result = await hook.handler(payload, ctx);

        if (result === null || result === undefined) continue;

        // 阻止信号
        if (result.block) {
          blocked = true;
          reason = result.reason || "被扩展阻止";
          continue;
        }

        // 修改 payload
        if (result.payload) {
          Object.assign(payload, result.payload);
          modified = true;
        }

        // 提示词处理（pre:build_system_prompt 返回 string）
        if (typeof result === "string") {
          // 特殊处理：如果钩子返回字符串，视为对 prompt 的追加
          if (event === "pre:build_system_prompt") {
            payload.prompt = (payload.prompt || "") + "\n\n" + result;
            modified = true;
          }
        }
      } catch (err) {
        console.warn(`[钩子:${hook.event}:${event}] 执行失败: ${err.message}`);
      }
    }

    return { blocked, reason, modified };
  }

  return { emit };
}
