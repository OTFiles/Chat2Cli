import chalk from "chalk";
import { initProviders, getProvider } from "../providers/registry.js";
import { getConfig } from "../config.js";
import { getStore, updateStore } from "../storage/store.js";
import { createId } from "../utils/id.js";
import {
  printSuccess, printError, printInfo,
  printChatHeader, printFooter,
  printUserMsg, printThinkingLabel, accountLabel
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

// ─── 历史记录选择器 ───

function formatTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadDsSessionMessages(provider, account, sessionId) {
  try {
    const result = await provider.fetchMessages(account.id, sessionId);
    return result || { messages: [], currentMessageId: null };
  } catch (err) {
    process.stdout.write(chalk.yellow(`  加载云端消息失败: ${err.message}\n`));
    return { messages: [], currentMessageId: null };
  }
}

/** 构建条目显示文本 */
function buildEntryLine(entry, index, selected) {
  const cursor = selected ? chalk.green.bold("❯ ") : "  ";
  const num = String(index).padStart(2, " ");
  const bg = selected ? chalk.bgCyan.black : chalk.reset;
  if (entry.type === "local") {
    const tag = chalk.cyan("[本地]");
    const title = (entry.conv.title || "未命名").slice(0, 40);
    const time = formatTime(entry.conv.updatedAt || entry.conv.createdAt);
    return bg(` ${cursor}${num} ${tag} ${title.padEnd(40)} ${chalk.gray(time)} `);
  }
  if (entry.type === "ds") {
    const tag = chalk.magenta("[云端]");
    const pinned = entry.session.pinned ? chalk.yellow("★") : " ";
    const title = (entry.session.title || "未命名").slice(0, 40);
    const time = formatTime(entry.sortTime);
    return bg(` ${cursor}${num} ${tag} ${pinned}${title.padEnd(40)} ${chalk.gray(time)} `);
  }
  return "";
}

/** 原始模式终端列表选择器，支持底部自动加载更多 */
function interactiveListPicker(allEntries, loadMore, noMore) {
  const VISIBLE = 18; // 可视区域条目数（不含表头）

  if (allEntries.length === 0 && noMore()) return Promise.resolve(null);

  return new Promise((resolve) => {
    let cursor = 0;
    let scroll = 0;
    let escState = 0;
    let loading = false;

    function clearScreen() {
      const visible = Math.min(VISIBLE, allEntries.length - scroll);
      process.stdout.write(`\x1b[${visible + 3}A\x1b[J`);
    }

    function render() {
      const total = allEntries.length;
      const end = Math.min(scroll + VISIBLE, total);
      const moreHint = noMore() ? "" : chalk.yellow(`  更多 (${total}条)`);

      process.stdout.write(chalk.gray(`选择对话  ↑↓导航  Enter确认  Ctrl+C取消${moreHint}\n`));

      // 新对话
      if (cursor === -1) {
        process.stdout.write(chalk.bgCyan.black.bold(" ❯ ") + chalk.bgCyan.black.bold("新对话") + "\x1b[0m\n");
      } else {
        process.stdout.write(`   ${chalk.green.bold("＋ 新对话")}\n`);
      }
      process.stdout.write(`  ${chalk.gray("─".repeat(56))}\n`);

      for (let i = scroll; i < end; i++) {
        const selected = i === cursor;
        process.stdout.write(buildEntryLine(allEntries[i], i, selected) + "\n");
      }

      if (loading) {
        process.stdout.write(chalk.yellow("\n  ⏳ 加载中..."));
      } else {
        process.stdout.write("");
      }
    }

    function scrollToCursor() {
      if (cursor < scroll) scroll = cursor;
      else if (cursor >= scroll + VISIBLE) scroll = cursor - VISIBLE + 1;
      if (cursor < 0) { cursor = -1; scroll = 0; }
    }

    function triggerLoadMore() {
      if (noMore() || loading) return;
      loading = true;
      clearScreen();
      render();
      loadMore().then(() => {
        loading = false;
        clearScreen();
        render();
      }).catch(() => {
        loading = false;
        clearScreen();
        render();
      });
    }

    function onData(chunk) {
      const str = chunk.toString("utf-8");
      for (const char of str) {
        const code = char.codePointAt(0);

        if (escState > 0) {
          if (char === "[" && escState === 1) { escState = 2; continue; }
          if (escState === 2) {
            if (char === "A") { if (cursor > 0) cursor--; else cursor = -1; }
            else if (char === "B") { if (cursor === -1) cursor = 0; else if (cursor < allEntries.length - 1) cursor++; }
            else if (char === "D") { if (cursor > 0) cursor = Math.max(0, cursor - 10); else cursor = -1; }
            else if (char === "C") { if (cursor === -1) cursor = 0; else cursor = Math.min(allEntries.length - 1, cursor + 10); }
            escState = 0;

            // 接近底部（最后 3 项）自动加载
            if (cursor >= allEntries.length - 3 && !noMore()) {
              triggerLoadMore();
              continue;
            }

            scrollToCursor();
            clearScreen();
            render();
            continue;
          }
          escState = 0;
          continue;
        }

        if (code === 27) { escState = 1; continue; }
        if (code === 13) {
          cleanup();
          process.stdout.write("\n");
          resolve(cursor);
          return;
        }
        if (code === 3) {
          cleanup();
          process.stdout.write("\n");
          resolve("exit");
          return;
        }
        // Page Up
        if (code === 21) {
          cursor = Math.max(-1, cursor - VISIBLE);
          scrollToCursor();
          clearScreen();
          render();
          continue;
        }
        // Page Down
        if (code === 4) {
          cursor = Math.min(allEntries.length - 1, cursor + VISIBLE);
          scrollToCursor();
          clearScreen();
          render();
          continue;
        }
      }
    }

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    }

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
      render();
    } catch (err) {
      cleanup();
      resolve(null);
    }
  });
}

/**
 * 显示历史记录列表，让用户选择新对话或继续已有对话。
 */
async function pickConversation(provider, accountId) {
  const state = getStore();
  const providerName = provider.name;

  // 收集本地对话（全部加载，数量有限）
  const allEntries = [];
  for (const conv of state.conversations) {
    if (conv.provider === providerName && conv.messages?.length > 0) {
      allEntries.push({
        type: "local",
        conv,
        sortTime: conv.updatedAt || conv.createdAt || "",
      });
    }
  }
  allEntries.sort((a, b) => (b.sortTime || "").localeCompare(a.sortTime || ""));

  // 云端会话按需分页加载（游标分页）
  let dsAccount = null;
  let dsCursor = null;
  let dsNoMore = true;

  if (providerName === "deepseek" && provider.isAuthenticated()) {
    dsAccount = accountId ? provider.getAccountInfo(accountId) : provider.getDefaultAccount();
    if (dsAccount) {
      dsNoMore = false;
      try {
        const result = await provider.fetchSessionPage(dsAccount.id);
        const sessions = result.sessions || [];
        dsNoMore = !result.hasMore;
        dsCursor = result.lastUpdatedAt;
        for (const s of sessions) {
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
        dsNoMore = true;
      }
    }
  }

  if (allEntries.length === 0) return { action: "new" };

  const loadMore = async () => {
    if (dsNoMore || !dsAccount) return;
    try {
      const result = await provider.fetchSessionPage(dsAccount.id, dsCursor);
      const sessions = result.sessions || [];
      dsNoMore = !result.hasMore;
      dsCursor = result.lastUpdatedAt;
      for (const s of sessions) {
        if (allEntries.some((e) => e.type === "ds" && e.session.id === s.id)) continue;
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
      dsNoMore = true;
    }
  };

  while (true) {
    const cursor = await interactiveListPicker(allEntries, loadMore, () => dsNoMore);
    if (cursor === "exit") { process.stdout.write(chalk.gray("已取消。\n")); return { action: "exit" }; }
    if (cursor === null || cursor === -1) return { action: "new" };

    const entry = allEntries[cursor];
    if (!entry) continue;

    if (entry.type === "local") {
      return { action: "local", conv: entry.conv };
    }

    if (entry.type === "ds") {
      process.stdout.write(chalk.gray("\n正在加载云端消息...\n"));
      const result = await loadDsSessionMessages(provider, entry.account, entry.session.id);
      const dsMessages = result.messages || result;
      if (!Array.isArray(dsMessages) || !dsMessages.length) {
        printInfo("该会话无消息记录，请选择其他会话。");
        continue;
      }
      return {
        action: "ds",
        account: entry.account,
        sessionId: entry.session.id,
        messages: dsMessages,
        currentMessageId: result.currentMessageId || null,
      };
    }
  }
}

// ─── 显示已有消息（继续对话时回显）───

function echoMessages(messages) {
  for (const msg of messages) {
    if (msg.role === "user") {
      printUserMsg(msg.content);
    } else {
      if (msg.thinking) {
        process.stdout.write(chalk.gray.dim("   " + msg.thinking.replace(/\n/g, "\n   ") + "\n"));
      }
      process.stdout.write("   " + msg.content.replace(/\n/g, "\n   ") + "\n\n");
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
  /** 继聊时 service 返回的 response_message_id / 新会话 ID */
  let messageId = null;
  let sessionId = null;

  for await (const delta of provider.chat(messages, opts)) {
    // 内部元数据
    if (delta.kind === "__messageId") { messageId = delta.text; continue; }
    if (delta.kind === "__sessionId") { sessionId = delta.text; continue; }

    if (firstChunk) {
      if (opts.model?.includes("reasoner")) {
        printThinkingLabel();
      }
      firstChunk = false;
    }
    if (delta.kind === "thinking") {
      thinking += delta.text;
      let t = delta.text;
      if (thinking === t) t = "   " + t;           // 首个 thinking delta 缩进
      t = t.replace(/\n/g, "\n   ");                // 段内换行也缩进
      process.stdout.write(chalk.gray(t));
    } else {
      let text = delta.text;
      if (response.length === 0) {
        if (thinking) {
          text = "\n   " + text;
        } else {
          text = "   " + text;
        }
      }
      text = text.replace(/\n/g, "\n   ");
      response += delta.text;
      process.stdout.write(chalk.white(text));
    }
  }

  if (firstChunk) return null;
  process.stdout.write("\n\n");
  return { thinking, response, messageId, sessionId };
}

async function chatLoop(provider, messages, currentModel, accountId, sessionId = null, parentMessageId = null) {
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
      // 未知 / 命令：报错而不发送给 AI
      if (input.startsWith("/")) {
        process.stdout.write("   " + chalk.red("✗ ") + `未知命令: ${input.split(" ")[0]}  输入 /help 查看可用命令\n\n`);
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
        provider, messages, { model: currentModel, accountId, sessionId, parentMessageId }
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

      // 新会话首次创建后复用 sessionId（后续消息不再新开会话）
      if (!sessionId && result.sessionId) {
        sessionId = result.sessionId;
      }

      // 更新 parentMessageId 供下次继聊使用（参照 deepseek2api onReady 更新）
      if (result.messageId && sessionId) {
        parentMessageId = result.messageId;
      }

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
          name: accountLabel(a),
          value: i
        }))
      }]);
      accountId = accounts[ans.accountIndex].id;
    } else if (accounts.length === 1) {
      accountId = accounts[0].id;
    }
  }

  // 显示历史记录选择器（--new / -n 参数跳过）
  if (opts.skipPicker) {
    // 直接新对话
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

  const picked = await pickConversation(provider, accountId);

  if (picked.action === "exit") return;  // Ctrl+C 取消

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
    // 使用 API 返回的 current_message_id 作为新消息的 parent
    const parentMsgId = picked.currentMessageId || null;

    printChatHeader(provider.label, currentModel, sessionId.slice(0, 8));
    echoMessages(messages);

    await chatLoop(provider, messages, currentModel, dsAccountId, sessionId, parentMsgId);

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

export { chatLoop, echoMessages, formatTime };

export async function runChat(opts = {}) {
  initProviders();
  const provider = resolveProvider();
  if (!provider) { printError("未找到可用的服务商。请先运行: chat2cli login"); return; }
  if (opts.message) await runOneshotChat(provider, opts.message, opts);
  else await runInteractiveChat(provider, opts);
}
