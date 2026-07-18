#!/usr/bin/env node

// 全局错误处理，防止进程异常退出
process.on("uncaughtException", (err) => {
  process.stderr.write(`\n[致命错误] ${err.message}\n${err.stack?.split("\n").slice(1, 4).join("\n")}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`\n[未处理的 Promise 拒绝] ${reason?.message || reason}\n`);
  process.exit(1);
});

import { Command } from "commander";
import chalk from "chalk";
import { initProviders } from "../src/providers/registry.js";
import { initExtensions } from "../src/extensions/index.js";
import { runLogin } from "../src/commands/login.js";
import { runChat } from "../src/commands/chat.js";
import { runHistory } from "../src/commands/history.js";
import { runConfig } from "../src/commands/config.js";
import { runApiKey } from "../src/commands/apikey.js";
import { runServe } from "../src/commands/serve.js";
import { runAgent } from "../src/commands/agent.js";

// 初始化 Provider（在扩展加载前，用于冲突检测）
initProviders();

// 初始化扩展系统（异步，在 CLI 解析前执行）
let _extReady = null;
function ensureExtensions() {
  if (!_extReady) {
    _extReady = initExtensions({ cwd: process.cwd() }).catch((err) => {
      console.warn("[扩展] 初始化失败:", err.message);
      return { hooks: { emit: async () => ({}) }, loaded: [], promptSections: { main: [], aux: [] } };
    });
  }
  return _extReady;
}

const program = new Command();

program
  .name("chat2cli")
  .description("多 AI 终端聊天工具 - 在命令行中与 DeepSeek、OpenAI 等 AI 对话")
  .version("1.0.0")
  .addHelpText("after", `
${chalk.bold("快速开始:")}
  ${chalk.cyan("chat2cli login")}         登录 AI 服务商
  ${chalk.cyan("chat2cli chat")}          开始交互式对话
  ${chalk.cyan("chat2cli chat -m \"你好\"")} 发送单条消息
  ${chalk.cyan("chat2cli apikey create")} 创建 API Key
  ${chalk.cyan("chat2cli serve")}         启动 OpenAI 兼容 API 服务

${chalk.bold("更多命令:")}
  ${chalk.cyan("chat2cli history")}       查看对话历史
  ${chalk.cyan("chat2cli config")}        查看/修改配置
  `);

program
  .command("login")
  .description("登录 AI 服务商")
  .action(async () => {
    try {
      await runLogin();
    } catch (err) {
      process.stderr.write(chalk.red("错误: " + err.message + "\n"));
      process.exit(1);
    }
  });

program
  .command("chat")
  .description("开始交互式对话或发送单条消息")
  .option("-m, --message <text>", "发送单条消息（非交互模式）")
  .option("-n, --new", "跳过历史记录，直接开始新对话")
  .option("--no-markdown", "禁用 Markdown 渲染")
  .option("--model <name>", "指定使用的模型")
  .option("--no-stream", "禁用流式输出")
  .action(async (opts) => {
    try {
      await runChat({
        message: opts.message,
        model: opts.model,
        stream: opts.stream,
        skipPicker: opts.new,
        markdown: opts.markdown
      });
    } catch (err) {
      process.stderr.write(chalk.red("错误: " + err.message + "\n"));
      process.exit(1);
    }
  });

program
  .command("history [action]")
  .description("管理对话历史记录")
  .argument("[args...]", "额外参数")
  .option("--limit <number>", "云端会话获取数量（默认 50）")
  .addHelpText("after", `
${chalk.dim("可用操作:")}
  ${chalk.cyan("history")}               列出所有本地对话
  ${chalk.cyan("history show <id>")}      查看单条对话详情
  ${chalk.cyan("history delete <id>")}    删除单条对话
  ${chalk.cyan("history continue <id>")}  继续之前的对话
  ${chalk.cyan("history search <关键词>")}  搜索对话
  ${chalk.cyan("history clear")}          清空所有历史

${chalk.dim("DeepSeek 云端会话:")}
  ${chalk.cyan("history ds")}             获取 DS 账号的云端会话列表
  ${chalk.cyan("history ds-continue <id>")} 继续云端会话
  ${chalk.cyan("history ds-delete <id>")}   删除云端会话
  ${chalk.cyan("history ds-clear")}        删除全部云端会话
  ${chalk.cyan("history ds-search <关键词>")}  搜索云端会话内容

${chalk.dim("Qwen 云端会话:")}
  ${chalk.cyan("history qw")}             获取 Qwen 账号的云端会话列表
  ${chalk.cyan("history qw-continue <id>")} 继续云端会话
  ${chalk.cyan("history qw-delete <id>")}   删除云端会话

${chalk.dim("批量操作:")}
  ${chalk.cyan("history batch-local")}     多选删除本地对话
  ${chalk.cyan("history batch-ds")}        多选删除云端会话
  `)
  .action(function (action) {
    // commander v12: this.args 包含所有已解析的位置参数
    // action 是第一个位置参数，this.args.slice(1) 是 [args...] 的剩余部分
    const restArgs = (this.args || []).slice(1);
    const opts = this.opts();
    const limit = Number(opts.limit) || 0;
    runHistory(action || "", { limit }, ...restArgs).catch((err) => {
      process.stderr.write(chalk.red("错误: " + err.message + "\n"));
      process.exit(1);
    });
  });

program
  .command("config [cmd] [key] [value]")
  .description("查看或修改配置")
  .addHelpText("after", `
${chalk.dim("用法:")}
  ${chalk.cyan("config")}                 查看当前配置
  ${chalk.cyan("config set <键> <值>")}    设置配置项
  ${chalk.cyan("                          defaultProvider / defaultModel")}
  ${chalk.cyan("                          newChatOnStart  / markdown (true|false)")}
  ${chalk.cyan("config account-name")}    给已登录的账号命名
  `)
  .action(async (cmd, key, value) => {
    try {
      await runConfig(cmd || "", key, value);
    } catch (err) {
      process.stderr.write(chalk.red("错误: " + err.message + "\n"));
      process.exit(1);
    }
  });

program
  .command("apikey [action]")
  .description("管理 API Key")
  .argument("[args...]", "额外参数")
  .addHelpText("after", `
${chalk.dim("可用操作:")}
  ${chalk.cyan("apikey")}             列出所有 API Key
  ${chalk.cyan("apikey create")}      创建新 API Key
  ${chalk.cyan("apikey show <id>")}    查看 API Key 详情（含完整 key）
  ${chalk.cyan("apikey delete <id>")}  删除 API Key

${chalk.dim("说明:")}
  API Key 用于 ${chalk.cyan("chat2cli serve")} 服务的认证。
  创建后可分发给其他应用，无需暴露原始服务商凭据。
  `)
  .action(async (action, args) => {
    try {
      await runApiKey(action || "", ...args);
    } catch (err) {
      process.stderr.write(chalk.red("错误: " + err.message + "\n"));
      process.exit(1);
    }
  });

program
  .command("serve")
  .description("启动 OpenAI 兼容 API 服务")
  .option("-p, --port <number>", "监听端口", "3000")
  .addHelpText("after", `
${chalk.dim("说明:")}
  启动后将提供 OpenAI 兼容的 HTTP API 接口。
  使用前请先创建 API Key: ${chalk.cyan("chat2cli apikey create")}

${chalk.dim("端点:")}
  ${chalk.cyan("GET  /v1/models")}              列出可用模型
  ${chalk.cyan("POST /v1/chat/completions")}    发送对话请求（含图片生成模型）
  ${chalk.cyan("POST /v1/images/generations")}  图片生成（OpenAI 兼容）
  ${chalk.cyan("POST /v1/images/edits")}        图片编辑（OpenAI 兼容）

${chalk.dim("认证:")}
  需在 Authorization 头中提供 Bearer API Key

${chalk.dim("使用示例:")}
  ${chalk.dim("# 1. 创建 API Key")}
  ${chalk.dim("chat2cli apikey create")}
  ${chalk.dim("")}
  ${chalk.dim("# 2. 启动服务")}
  ${chalk.dim("chat2cli serve")}
  ${chalk.dim("")}
  ${chalk.dim("# 3. 调用 API")}
  ${chalk.dim("curl -s http://127.0.0.1:3000/v1/models")}
  ${chalk.dim("curl http://127.0.0.1:3000/v1/chat/completions \\")}
  ${chalk.dim("  -H \"Authorization: Bearer <API_KEY>\" \\")}
  ${chalk.dim("  -H \"Content-Type: application/json\" \\")}
  ${chalk.dim("  -d '{\"model\":\"deepseek-chat-fast\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'")}
  `)
  .action(async (opts) => {
    try {
      await runServe({ port: opts.port });
    } catch (err) {
      process.stderr.write(chalk.red("错误: " + err.message + "\n"));
      process.exit(1);
    }
  });

program
  .command("agent")
  .description("AI Agent 模式 — 自动规划并执行任务（支持工具调用）")
  .option("--new [name]", "强制新建复合对话")
  .option("--list", "列出所有复合对话")
  .option("--continue <id>", "继续指定复合对话")
  .option("--delete <id>", "删除指定复合对话")
  .option("--dir <path>", "指定工作目录")
  .addHelpText("after", `
${chalk.dim("说明:")}
  Agent 模式使用主 AI + 辅助 AI 双账号协作，能自动使用工具完成编程任务。
  支持的工具有: shell 命令执行、文件读写、文件搜索、任务清单管理。

${chalk.dim("用法:")}
  ${chalk.cyan("chat2cli agent")}           新建或继续复合对话
  ${chalk.cyan("chat2cli agent --new")}     强制新建复合对话
  ${chalk.cyan("chat2cli agent --list")}    列出所有复合对话
  ${chalk.cyan("chat2cli agent --continue <id>")}  继续指定对话
  ${chalk.cyan("chat2cli agent --delete <id>")}    删除指定对话

${chalk.dim("TUI 内置命令:")}
  ${chalk.cyan("/help")}       显示帮助
  ${chalk.cyan("/todo")}       查看任务清单
  ${chalk.cyan("/context")}    查看当前上下文
  ${chalk.cyan("/aux <任务>")}  委托任务给辅助 AI
  ${chalk.cyan("/clear")}      清屏
  ${chalk.cyan("/exit")}       退出

${chalk.dim("快捷键:")}
  ${chalk.cyan("Ctrl+C")}   中断当前 agent 循环
  ${chalk.cyan("↑↓")}       历史输入导航
  `)
  .action(async (opts) => {
    try {
      await runAgent({
        new: opts.new,
        list: opts.list,
        continue: opts.continue,
        delete: opts.delete,
        dir: opts.dir
      });
    } catch (err) {
      process.stderr.write(chalk.red("错误: " + err.message + "\n"));
      process.exit(1);
    }
  });

// ── 注册扩展 CLI 命令 ──
// 在 parse 前动态注册，使 commander 能识别它们
const _extCtx = await ensureExtensions();
const { getExtensionCommands } = await import("../src/extensions/index.js");
const extCommands = getExtensionCommands();

// 获取已注册的命令名（避免冲突）
const registeredNames = new Set(program.commands.map((c) => c.name()));

for (const cmd of extCommands) {
  if (registeredNames.has(cmd.name)) {
    console.warn(`[扩展] 命令 "${cmd.name}" 与内置命令冲突，已跳过`);
    continue;
  }

  const sub = program
    .command(cmd.name)
    .description(cmd.description || "");

  if (Array.isArray(cmd.options)) {
    for (const opt of cmd.options) {
      sub.option(opt.flags, opt.description || "", opt.defaultValue);
    }
  }

  sub.action(async (...args) => {
    try {
      // 最后一个参数是 commander Command 对象
      const cmdObj = args[args.length - 1];
      const opts = typeof cmdObj === "object" && cmdObj.opts ? cmdObj.opts() : {};
      await cmd.handler(opts, ...args.slice(0, -1));
    } catch (err) {
      process.stderr.write(chalk.red("错误: " + err.message + "\n"));
      process.exit(1);
    }
  });

  registeredNames.add(cmd.name);
}

program.parse();
