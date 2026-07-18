/**
 * hello-world 扩展示例
 *
 * 演示 chat2cli 扩展系统的核心能力：
 * - 添加 Agent 工具
 * - 添加 TUI 命令
 * - 注入提示词片段
 * - 注册生命周期钩子
 *
 * 安装方式：复制到 ~/.chat2cli/extensions/hello-world.js
 */

export default {
  name: "hello-world",
  version: "1.0.0",

  // ═══════════════════════════════════════════
  // 1. 提示词片段：追加到系统提示词末尾
  // ═══════════════════════════════════════════
  promptSections: {
    main: `
## 额外规则（来自 hello-world 扩展）
- 在所有代码注释中使用中文
- 回复结尾加上 🚀 表情
`,
    aux: `
## 辅助 AI 额外规则（来自 hello-world 扩展）
- 回答控制在 100 字以内
`
  },

  // ═══════════════════════════════════════════
  // 2. 工具定义
  // ═══════════════════════════════════════════
  tools: [
    {
      name: "greet",
      description: "向指定的人打招呼。返回问候语。",
      parameters: {
        name: { type: "string", required: true, description: "要问候的名字" },
        language: { type: "string", required: false, description: "语言：zh/en，默认 zh" }
      }
    },
    {
      name: "datetime",
      description: "获取当前日期和时间。",
      parameters: {
        format: { type: "string", required: false, description: "格式：iso/locale，默认 locale" }
      }
    }
  ],

  // ═══════════════════════════════════════════
  // 3. 工具执行器
  // ═══════════════════════════════════════════
  toolExecutors: [
    {
      name: "greet",
      fn(params) {
        const name = params.name || "世界";
        const lang = params.language || "zh";
        const greeting = lang === "en" ? `Hello, ${name}!` : `你好，${name}！`;
        return {
          result: { success: true, greeting, name, language: lang }
        };
      }
    },
    {
      name: "datetime",
      fn(params) {
        const now = new Date();
        const format = params.format || "locale";
        const text = format === "iso"
          ? now.toISOString()
          : now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
        return {
          result: { success: true, datetime: text, timestamp: now.getTime(), format }
        };
      }
    }
  ],

  // ═══════════════════════════════════════════
  // 4. TUI 命令
  // ═══════════════════════════════════════════
  tuiCommands: [
    {
      name: "hello",
      description: "显示来自扩展的问候",
      handler(args) {
        console.log("   " + "👋 你好！这是来自 hello-world 扩展的问候。");
        if (args) console.log("   " + `你说: ${args}`);
        console.log("");
      }
    },
    {
      name: "time",
      description: "显示当前时间",
      handler() {
        const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
        console.log("   " + `🕐 当前时间: ${now}`);
        console.log("");
      }
    }
  ],

  // ═══════════════════════════════════════════
  // 5. 生命周期钩子
  // ═══════════════════════════════════════════
  hooks: [
    {
      event: "pre:tool_execute",
      handler(payload) {
        // 记录所有工具调用
        console.log("   " + `[hello-world] 工具调用: ${payload.toolName}`);
      }
    },
    {
      event: "post:tool_execute",
      handler(payload) {
        // 可以为工具结果添加额外信息
        if (payload.toolName === "shell" && payload.result?.success) {
          console.log("   " + `[hello-world] shell 命令执行成功 ✓`);
        }
      }
    }
  ],

  // ═══════════════════════════════════════════
  // 6. 生命周期回调
  // ═══════════════════════════════════════════
  onLoad(ctx) {
    console.log(`   [hello-world] 扩展已加载 (cwd: ${ctx.cwd || "?"})`);
  },

  onUnload() {
    console.log("   [hello-world] 扩展已卸载");
  }
};
