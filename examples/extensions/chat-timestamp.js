/**
 * chat-timestamp 扩展
 *
 * 在 chat 模式和 agent 模式下，在 AI 输出前面添加时间戳。
 *
 * 安装方式：复制到 ~/.chat2cli/extensions/chat-timestamp.js
 */

export default {
  name: "chat-timestamp",
  version: "1.0.0",

  // ═══════════════════════════════════════════
  // 钩子：监听 AI 响应开始事件
  // ═══════════════════════════════════════════
  hooks: [
    {
      event: "pre:response_start",
      handler(payload, ctx) {
        const now = new Date();
        const ts = now.toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        });

        // 直接输出时间戳到终端
        process.stdout.write(`\n   ${"\x1b[90m"}[${ts}]\x1b[0m\n`);

        // 不返回任何值，让输出正常继续
      }
    }
  ],

  // ═══════════════════════════════════════════
  // 启动日志
  // ═══════════════════════════════════════════
  onLoad() {
    // 静默加载，不打印额外信息
  }
};
