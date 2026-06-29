import { createInterface } from "node:readline";
import chalk from "chalk";
import { initProviders, getProvider } from "../providers/registry.js";
import { getConfig } from "../config.js";
import { updateStore } from "../storage/store.js";
import { createId } from "../utils/id.js";
import { printSuccess, printError, printInfo, printAiContent, printHelp } from "../utils/format.js";

function resolveProvider() {
  const config = getConfig();
  return getProvider(config.defaultProvider);
}

function buildConversationTitle(messages) {
  const firstUserMsg = messages.find((m) => m.role === "user");
  if (!firstUserMsg) return "未命名";
  const text = firstUserMsg.content.replace(/\n/g, " ").trim();
  return text.length > 50 ? text.slice(0, 47) + "..." : text;
}

function saveConversation(conversation) {
  updateStore((state) => {
    const idx = state.conversations.findIndex((c) => c.id === conversation.id);
    if (idx >= 0) {
      const updated = [...state.conversations];
      updated[idx] = conversation;
      return { ...state, conversations: updated };
    }
    return { ...state, conversations: [conversation, ...state.conversations] };
  });
}

/**
 * 流式获取并输出响应。spinner 状态由调用方管理。
 * 返回 { thinking, response } 或 null（无内容）。
 */
async function streamResponse(provider, messages, opts, onFirstChunk) {
  let thinking = "";
  let response = "";
  let firstChunk = true;

  for await (const delta of provider.chat(messages, opts)) {
    if (firstChunk) {
      if (onFirstChunk) onFirstChunk();
      process.stdout.write("\n" + chalk.green("AI: "));
      firstChunk = false;
    }
    if (delta.kind === "thinking") {
      thinking += delta.text;
      printAiContent(delta.text, true);
    } else {
      response += delta.text;
      printAiContent(delta.text, false);
    }
  }

  if (firstChunk) return null;
  process.stdout.write("\n\n");
  return { thinking, response };
}

/**
 * 核心循环：同步 rl.on("line") + 手动 Promise 队列。
 * 避免 async handler / rl.question 在不同 Node.js 版本下的兼容问题。
 */
async function chatLoop(provider, messages, currentModel, accountId, sessionId) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  // 使用队列模式：输入线到达时 resolve 等待中的 Promise
  let pendingResolve = null;
  let running = false;

  rl.on("line", (line) => {
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(line);
    }
  });

  rl.on("close", () => {
    if (pendingResolve) pendingResolve("/exit");
  });

  function waitForLine() {
    return new Promise((resolve) => {
      pendingResolve = resolve;
      rl.prompt();
    });
  }

  try {
    rl.prompt();

    while (true) {
      const line = await waitForLine();
      const input = line.trim();

      // 内置命令
      if (input === "/exit") {
        process.stdout.write(chalk.gray("再见。\n"));
        return;
      }
      if (input === "/clear") {
        messages.length = 0;
        process.stdout.write(chalk.gray("上下文已清空。\n\n"));
        continue;
      }
      if (input === "/help") { printHelp(); continue; }
      if (input === "/models") {
        const models = provider.getModels();
        for (const m of models) {
          process.stdout.write((m.id === currentModel ? chalk.green(" * ") : "   ") + chalk.bold(m.id) + "  " + chalk.gray(m.label) + "\n");
        }
        process.stdout.write("\n");
        continue;
      }
      if (input.startsWith("/model ")) {
        const m = input.slice(7).trim();
        if (provider.getModels().some((mod) => mod.id === m)) {
          currentModel = m;
          printSuccess(`模型已切换为: ${chalk.bold(m)}`);
        } else {
          printError(`未知模型: ${m}`);
        }
        continue;
      }
      if (!input) continue;

      // === 发送消息 ===
      running = true;
      process.stdout.write(chalk.yellow("思考中...\n"));

      messages.push({ role: "user", content: input });

      const result = await streamResponse(
        provider, messages,
        { model: currentModel, accountId, sessionId },
        null
      ).catch((err) => {
        process.stdout.write("\n");
        printError(err.message);
        return null;
      });

      if (!result) {
        printError("未收到回复");
        messages.pop();
        running = false;
        continue;
      }

      const assistantMsg = { role: "assistant", content: result.response };
      if (result.thinking) assistantMsg.thinking = result.thinking;
      messages.push(assistantMsg);
      running = false;
    }
  } finally {
    rl.close();
    // 等待 rl 完全关闭
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runInteractiveChat(provider, opts = {}) {
  const { model: modelOverride } = opts;

  if (!provider.isAuthenticated()) {
    printError("尚未登录。请运行: chat2cli login");
    return;
  }

  // 多账号选择
  let accountId = null;
  let accountLabel = "";
  if (provider.name === "deepseek") {
    const accounts = provider.listAccounts();
    if (accounts.length > 1) {
      const { default: inquirer } = await import("inquirer");
      const { accountIndex } = await inquirer.prompt([{
        type: "list",
        name: "accountIndex",
        message: "选择 DeepSeek 账号:",
        choices: accounts.map((a, i) => ({ name: `${a.displayName} (${a.loginValue})`, value: i }))
      }]);
      accountId = accounts[accountIndex].id;
      accountLabel = accounts[accountIndex].displayName;
    } else if (accounts.length === 1) {
      accountId = accounts[0].id;
      accountLabel = accounts[0].displayName;
    }
  }

  const currentModel = modelOverride || getConfig().defaultModel;
  printInfo(`服务商: ${chalk.bold(provider.label)}`);
  if (accountLabel) printInfo(`账号: ${chalk.bold(accountLabel)}`);
  printInfo(`模型: ${chalk.bold(currentModel)}`);
  process.stdout.write(chalk.gray("输入 /help 查看可用命令。\n\n"));

  const messages = [];
  const convId = createId();

  await chatLoop(provider, messages, currentModel, accountId, null);

  // 保存对话
  if (messages.length > 0) {
    const conv = {
      id: convId,
      provider: provider.name,
      model: currentModel,
      title: buildConversationTitle(messages),
      messages: [...messages],
      accountId: accountId || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    saveConversation(conv);
    printSuccess(`对话已保存 (id: ${chalk.dim(convId.slice(0, 8))})`);
  }
}

async function runOneshotChat(provider, message, opts = {}) {
  const { model: modelOverride } = opts;
  const currentModel = modelOverride || getConfig().defaultModel;
  const messages = [{ role: "user", content: message }];

  if (!provider.isAuthenticated()) {
    printError("尚未登录。请运行: chat2cli login");
    return;
  }

  process.stdout.write(chalk.yellow("思考中...\n"));

  const result = await streamResponse(provider, messages, { model: currentModel }, null).catch((err) => {
    printError(err.message);
    return null;
  });

  if (result) {
    const assistantMsg = { role: "assistant", content: result.response };
    if (result.thinking) assistantMsg.thinking = result.thinking;
    const conv = {
      id: createId(), provider: provider.name, model: currentModel,
      title: buildConversationTitle([{ role: "user", content: message }, assistantMsg]),
      messages: [{ role: "user", content: message }, assistantMsg],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    saveConversation(conv);
  }
}

export async function runChat(opts = {}) {
  initProviders();
  const provider = resolveProvider();
  if (!provider) { printError("未找到可用的服务商。请先运行: chat2cli login"); return; }

  if (opts.message) {
    await runOneshotChat(provider, opts.message, opts);
  } else {
    await runInteractiveChat(provider, opts);
  }
}
