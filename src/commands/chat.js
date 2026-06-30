import chalk from "chalk";
import { initProviders, getProvider } from "../providers/registry.js";
import { getConfig } from "../config.js";
import { getStore, updateStore } from "../storage/store.js";
import { createId } from "../utils/id.js";
import {
  printSuccess, printError, printInfo,
  printChatHeader, printFooter,
  printUserMsg, printThinkingLabel
} from "../utils/format.js";

const PAGE_SIZE = 20;

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

// ─── 历史记录选择器 ───

function formatTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadDsSessionMessages(provider, account, sessionId) {
  try {
    return await provider.fetchMessages(account.id, sessionId) || [];
  } catch (err) {
    process.stdout.write(chalk.yellow(`  加载云端消息失败: ${err.message}\n`));
    return [];
  }
}

/**
 * 显示历史记录列表，让用户选择新对话或继续已有对话。
 * @returns {{ action: "new", model: string } | { action: "local", conv, model: string } | { action: "ds", account, sessionId, model: string, messages } | null}
 */
async function pickConversation(provider, accountId) {
  const { default: inquirer } = await import("inquirer");
  const state = getStore();
  const providerName = provider.name;

  // 收集可继续的条目
  const allEntries = [];

  // 本地对话
  for (const conv of state.conversations) {
    if (conv.provider === providerName && conv.messages?.length > 0) {
      allEntries.push({
        type: "local",
        conv,
        sortTime: conv.updatedAt || conv.createdAt || "",
      });
    }
  }

  // DeepSeek 云端会话
  let dsHasMore = false;
  let dsAccount = null;

  if (providerName === "deepseek" && provider.isAuthenticated()) {
    // 获取默认账号
    dsAccount = accountId ? provider.getAccountInfo(accountId) : provider.getDefaultAccount();
    if (dsAccount) {
      try {
        const result = await provider.fetchSessions(dsAccount.id);
        dsSessions = result.sessions || [];
        dsHasMore = (result.total || 0) > dsSessions.length;
        for (const s of dsSessions) {
          allEntries.push({
            type: "ds",
            session: s,
            account: dsAccount,
            sortTime: typeof s.updatedAt === "number"
              ? new Date(s.updatedAt * 1000).toISOString()
              : (s.updatedAt || ""),
          });
        }
      } catch {
        // 云端会话加载失败，只显示本地
      }
    }
  }

  // 按时间排序（新 → 旧）
  allEntries.sort((a, b) => (b.sortTime || "").localeCompare(a.sortTime || ""));

  // 构建 inquirer 选择列表
  function buildChoiceList(pageOffset) {
    const start = pageOffset * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const page = allEntries.slice(start, end);
    const hasMore = end < allEntries.length;

    const choices = [
      { name: chalk.green.bold("＋ 新对话"), value: { action: "new" }, short: "新对话" },
      new inquirer.Separator(chalk.gray("─".repeat(60))),
    ];

    for (const entry of page) {
      if (entry.type === "local") {
        const title = (entry.conv.title || "未命名").slice(0, 50);
        choices.push({
          name: `${chalk.cyan("[本地]")}  ${title.padEnd(50)}  ${chalk.gray(formatTime(entry.conv.updatedAt || entry.conv.createdAt))}`,
          value: { action: "local", conv: entry.conv },
          short: entry.conv.title || "本地对话",
        });
      } else if (entry.type === "ds") {
        const title = (entry.session.title || "未命名").slice(0, 50);
        const pinned = entry.session.pinned ? "★ " : "";
        choices.push({
          name: `${chalk.magenta("[云端]")}  ${pinned}${title.padEnd(49 - pinned.length)}  ${chalk.gray(formatTime(entry.sortTime))}`,
          value: { action: "ds", session: entry.session, account: entry.account },
          short: entry.session.title || "云端会话",
        });
      }
    }

    if (hasMore) {
      choices.push(new inquirer.Separator(" "));
      choices.push({
        name: chalk.gray(`  加载更多... (已显示 ${end}/${allEntries.length})`),
        value: { action: "load_more", page: pageOffset + 1 },
        short: "加载更多",
      });
    }

    return choices;
  }

  if (allEntries.length === 0 && !dsHasMore) {
    // 没有任何可继续的对话，直接进入新对话
    return { action: "new" };
  }

  let pageOffset = 0;

  while (true) {
    const choices = buildChoiceList(pageOffset);
    const { selected } = await inquirer.prompt([{
      type: "list",
      name: "selected",
      message: "选择对话:",
      choices,
      pageSize: Math.min(25, choices.length),
    }]);

    if (selected.action === "new") {
      return { action: "new" };
    }

    if (selected.action === "load_more") {
      pageOffset = selected.page;
      continue; // 重新显示，加载下一页
    }

    if (selected.action === "local") {
      return { action: "local", conv: selected.conv };
    }

    if (selected.action === "ds") {
      // 加载云端会话的消息
      process.stdout.write(chalk.gray("正在加载云端消息...\n"));
      const messages = await loadDsSessionMessages(provider, selected.account, selected.session.id);
      if (!messages.length) {
        printInfo("该会话无消息记录，请选择其他会话。");
        continue;
      }
      return {
        action: "ds",
        account: selected.account,
        sessionId: selected.session.id,
        messages,
      };
    }
  }
}

// ─── 显示已有消息（继续对话时回显）───

function echoMessages(messages) {
  for (const msg of messages) {
    if (msg.role === "user") {
      process.stdout.write(chalk.cyan("你: ") + msg.content + "\n");
    } else {
      if (msg.thinking) {
        process.stdout.write(chalk.gray("[思考过程]\n" + msg.thinking + "\n"));
      }
      process.stdout.write(chalk.green("AI: ") + msg.content + "\n\n");
    }
  }
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

async function chatLoop(provider, messages, currentModel, accountId, sessionId = null) {
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
        provider, messages, { model: currentModel, accountId, sessionId }
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
  if (typeof provider.listAccounts === "function") {
    const accounts = provider.listAccounts();
    if (accounts.length > 1) {
      const { default: inquirer } = await import("inquirer");
      const ans = await inquirer.prompt([{
        type: "list", name: "accountIndex", message: `选择 ${provider.label} 账号:`,
        choices: accounts.map((a, i) => ({
          name: a.displayName || a.loginValue || a.email || a.token?.slice(0, 12) + "..." || `账号 ${i + 1}`,
          value: i
        }))
      }]);
      accountId = accounts[ans.accountIndex].id;
    } else if (accounts.length === 1) {
      accountId = accounts[0].id;
    }
  }

  // 显示历史记录选择器
  const picked = await pickConversation(provider, accountId);

  if (picked.action === "new") {
    // 全新对话
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
    return;
  }

  if (picked.action === "local") {
    // 继续本地对话
    const conv = picked.conv;
    const currentModel = modelOverride || conv.model || getConfig().defaultModel;
    const messages = [...conv.messages];
    const convAccountId = conv.accountId || accountId;

    printChatHeader(provider.label, currentModel, conv.id.slice(0, 8));
    echoMessages(messages);

    await chatLoop(provider, messages, currentModel, convAccountId);

    if (messages.length > conv.messages.length) {
      updateStore((state) => ({
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === conv.id
            ? { ...c, model: currentModel, messages, updatedAt: new Date().toISOString() }
            : c
        ),
      }));
      printSuccess("对话已更新");
    }
    return;
  }

  if (picked.action === "ds") {
    // 继续云端会话
    const currentModel = modelOverride || getConfig().defaultModel;
    const sessionId = picked.sessionId;
    const messages = [...picked.messages];
    const dsAccountId = picked.account?.id || accountId;

    printChatHeader(provider.label, currentModel, sessionId.slice(0, 8));
    echoMessages(messages);

    await chatLoop(provider, messages, currentModel, dsAccountId, sessionId);

    if (messages.length > picked.messages.length) {
      // 保存到本地（暂存为本地对话副本）
      const convId = createId();
      const conv = {
        id: convId, provider: provider.name, model: currentModel,
        title: buildConversationTitle(messages), messages: [...messages],
        accountId: dsAccountId || "", dsSessionId: sessionId,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      saveConversation(conv);
      printSuccess(`对话已保存 (id: ${chalk.dim(convId.slice(0, 8))})`);
    }
    return;
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
