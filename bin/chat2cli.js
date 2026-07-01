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
import { runLogin } from "../src/commands/login.js";
import { runChat } from "../src/commands/chat.js";
import { runHistory } from "../src/commands/history.js";
import { runConfig } from "../src/commands/config.js";
import { runApiKey } from "../src/commands/apikey.js";
import { runServe } from "../src/commands/serve.js";

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
  .option("--model <name>", "指定使用的模型")
  .option("--no-stream", "禁用流式输出")
  .action(async (opts) => {
    try {
      await runChat({
        message: opts.message,
        model: opts.model,
        stream: opts.stream,
        skipPicker: opts.new
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
  ${chalk.cyan("                          可设置: defaultProvider, defaultModel")}
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
  ${chalk.cyan("POST /v1/chat/completions")}    发送对话请求

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

program.parse();
