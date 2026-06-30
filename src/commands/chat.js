import chalk from "chalk";
import { initProviders, getProvider } from "../providers/registry.js";
import { getConfig } from "../config.js";
import { updateStore } from "../storage/store.js";
import { createId } from "../utils/id.js";
import {
  printSuccess, printError,
  printChatHeader, printFooter,
  printUserMsg, printThinkingLabel
} from "../utils/format.js";

function resolveProvider() {
  return getProvider(getConfig().defaultProvider);
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
    if (idx >= 0) { const u = [...state.conversations]; u[idx] = conversation; return { ...state, conversations: u }; }
    return { ...state, conversations: [conversation, ...state.conversations] };
  });
}

/**
 * 流式响应，直接向 stdout 写入（AI 输出每行带 3 空格缩进，与 ❯ 对齐）
 */
async function streamResponse(provider, messages, opts) {
  let thinking = "";
  let response = "";
  let firstChunk = true;

  for await (const delta of provider.chat(messages, opts)) {
    if (firstChunk) {
      if (opts.model?.includes("reasoner")) {
        printThinkingLabel();
      }
      firstChunk = false;
    }
    if (delta.kind === "thinking") {
      thinking += delta.text;
      // 思考文本：行首缩进 + 换行后也缩进
      process.stdout.write("   " + chalk.gray(delta.text.replace(/\n/g, "\n   ")));
    } else {
      let text = delta.text;
      // 判断是否第一次输出响应内容（之前有思考或刚开头）
      if (response.length === 0) {
        if (thinking) {
          text = "\n   " + text;   // 思考之后 ，换行 + 缩进
        } else {
          text = "   " + text;     // 没有思考，直接缩进开头
        }
      }
      // 后续换行也缩进
      text = text.replace(/\n/g, "\n   ");
      response += delta.text;
      process.stdout.write(chalk.white(text));
    }
  }

  if (firstChunk) return null;
  process.stdout.write("\n\n");  // 结束换行
  return { thinking, response };
}

async function chatLoop(provider, messages, currentModel, accountId) {
  // ── 绘制 footer + 定位到 prompt 行 ──
  function drawFooter() {
    printFooter();
    // printFooter 输出 4 行后光标在第 5 行；上移 3 到空白 prompt 行
    process.stdout.write("\x1b[3A\r");
    process.stdout.write("   > ");
  }

  // 清除旧 footer：Enter 后光标在下分隔线行，上移 2 回到上分隔线行清屏
  function clearFooter() {
    process.stdout.write("\x1b[2A\r\x1b[J");
  }

  /**
   * raw mode 等待输入 — 手动控制回显，不依赖 readline prompt。
   * 这样可以保证 prompt 行下方的内容（下分隔线、帮助）不被清除。
   */
  function waitForInput() {
    return new Promise((resolve) => {
      let input = "";
      let escState = 0; // 0=normal, 1=saw ESC, 2=saw [, 3=got letter (skip)

      process.stdin.setRawMode(true);
      process.stdin.resume();

      const onData = (chunk) => {
        const str = chunk.toString("utf-8");
        for (const char of str) {
          const code = char.codePointAt(0);

          // ESC 序列（箭头键等），跳过
          if (escState > 0) {
            if (escState === 2 && char === "[") { escState = 3; continue; }
            escState--;
            continue;
          }
          if (code === 27) { escState = 2; continue; }

          // Enter
          if (code === 13) {
            process.stdout.write("\r\n");
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener("data", onData);
            resolve(input.trim());
            return;
          }
          // Backspace
          if (code === 127 || code === 8) {
            if (input.length > 0) {
              input = input.slice(0, -1);
              process.stdout.write("\b \b");
            }
            continue;
          }
          // Ctrl+C → exit
          if (code === 3) {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener("data", onData);
            resolve("/exit");
            return;
          }
          // Ctrl+D → exit (EOF)
          if (code === 4) {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener("data", onData);
            resolve("/exit");
            return;
          }
          // 可打印字符
          if (code >= 32 || code === 10) {
            input += char;
            process.stdout.write(char);
          }
          // 其他控制字符忽略
        }
      };

      process.stdin.on("data", onData);
    });
  }

  function redrawFooter() {
    drawFooter();
  }

  try {
    // 初始显示 footer
    drawFooter();

    while (true) {
      const input = await waitForInput();

      // 清除旧 footer 全部 4 行
      clearFooter();

      // ── 内置命令 ──
      if (input === "/exit") {
        process.stdout.write(chalk.gray("再见。\n"));
        return;
      }
      if (input === "/clear") {
        messages.length = 0;
        redrawFooter();
        continue;
      }
      if (input === "/help") {
        const { printHelp } = await import("../utils/format.js");
        printUserMsg(input);
        printHelp();
        redrawFooter();
        continue;
      }
      if (input === "/models") {
        const models = provider.getModels();
        printUserMsg(input);
        for (const m of models) {
          process.stdout.write((m.id === currentModel ? chalk.green("   * ") : "     ") + chalk.bold(m.id) + "  " + chalk.gray(m.label) + "\n");
        }
        process.stdout.write("\n");
        redrawFooter();
        continue;
      }
      if (input.startsWith("/model ")) {
        const m = input.slice(7).trim();
        printUserMsg(input);
        if (provider.getModels().some((mod) => mod.id === m)) {
          currentModel = m;
          process.stdout.write("   " + chalk.green("✓ ") + `模型已切换为: ${chalk.bold(m)}\n\n`);
        } else {
          process.stdout.write("   " + chalk.red("✗ ") + `未知模型: ${m}\n\n`);
        }
        redrawFooter();
        continue;
      }
      if (!input) {
        redrawFooter();
        continue;
      }

      // === 发送消息 ===
      printUserMsg(input);

      messages.push({ role: "user", content: input });

      const result = await streamResponse(
        provider, messages, { model: currentModel, accountId }
      ).catch((err) => {
        process.stdout.write("   " + chalk.red("✗ ") + err.message + "\n\n");
        return null;
      });

      if (!result) {
        process.stdout.write("   " + chalk.red("✗ ") + "未收到回复\n\n");
        messages.pop();
        redrawFooter();
        continue;
      }

      const assistantMsg = { role: "assistant", content: result.response };
      if (result.thinking) assistantMsg.thinking = result.thinking;
      messages.push(assistantMsg);

      redrawFooter();
    }
  } finally {
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
    process.stdin.pause();
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
  if (provider.name === "deepseek") {
    const accounts = provider.listAccounts();
    if (accounts.length > 1) {
      const { default: inquirer } = await import("inquirer");
      const ans = await inquirer.prompt([{
        type: "list", name: "accountIndex", message: "选择 DeepSeek 账号:",
        choices: accounts.map((a, i) => ({ name: `${a.displayName} (${a.loginValue})`, value: i }))
      }]);
      accountId = accounts[ans.accountIndex].id;
    } else if (accounts.length === 1) {
      accountId = accounts[0].id;
    }
  }

  const currentModel = modelOverride || getConfig().defaultModel;
  const convId = createId();

  printChatHeader(provider.label, currentModel, convId.slice(0, 8));

  const messages = [];

  await chatLoop(provider, messages, currentModel, accountId);

  if (messages.length > 0) {
    const conv = {
      id: convId, provider: provider.name, model: currentModel,
      title: buildConversationTitle(messages), messages: [...messages],
      accountId: accountId || "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    saveConversation(conv);
    printSuccess(`对话已保存 (id: ${chalk.dim(convId.slice(0, 8))})`);
  }
}

async function runOneshotChat(provider, message, opts = {}) {
  const { model: modelOverride } = opts;
  const currentModel = modelOverride || getConfig().defaultModel;
  const messages = [{ role: "user", content: message }];

  if (!provider.isAuthenticated()) { printError("尚未登录。请运行: chat2cli login"); return; }

  printUserMsg(message);

  const result = await streamResponse(provider, messages, { model: currentModel }).catch((err) => {
    process.stdout.write("   " + chalk.red("✗ ") + err.message + "\n\n");
    return null;
  });

  if (result) {
    const m = { role: "assistant", content: result.response };
    if (result.thinking) m.thinking = result.thinking;
    saveConversation({
      id: createId(), provider: provider.name, model: currentModel,
      title: buildConversationTitle([{ role: "user", content: message }, m]),
      messages: [{ role: "user", content: message }, m],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
  }
}

export async function runChat(opts = {}) {
  initProviders();
  const provider = resolveProvider();
  if (!provider) { printError("未找到可用的服务商。请先运行: chat2cli login"); return; }
  if (opts.message) await runOneshotChat(provider, opts.message, opts);
  else await runInteractiveChat(provider, opts);
}
