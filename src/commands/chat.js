import chalk from "chalk";
import { initProviders, getProvider, listProviders } from "../providers/registry.js";
import { getConfig, getModelForProvider, setModelForProvider, getChatOptions, setChatOption } from "../config.js";
import { getStore, updateStore } from "../storage/store.js";
import { createId } from "../utils/id.js";
import {
  printSuccess, printError, printInfo,
  printChatHeader, printFooter,
  printUserMsg, printThinkingLabel, accountLabel
} from "../utils/format.js";
import { renderMarkdown, resetMarkdownRenderer } from "../utils/markdown.js";

function resolveProvider() {
  return getProvider(getConfig().defaultProvider);
}

/** 获取当前 provider 的默认模型 */
function resolveModel(provider, modelOverride) {
  if (modelOverride) return modelOverride;
  const providerModel = getModelForProvider(provider.name);
  if (providerModel) return providerModel;
  return getConfig().defaultModel || provider.getModels()[0]?.id || "qwen-max";
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

/** 构建条目显示文本（截断到单行） */
function buildEntryLine(entry, index, selected) {
  const cursor = selected ? chalk.green.bold("❯ ") : "  ";
  const num = String(index).padStart(2, " ");
  const bg = selected ? chalk.bgCyan.black : chalk.reset;
  const maxCols = (process.stdout.columns || 80) - 1; // 预留 1 列防止换行
  // 前缀: " " + cursor(2) + num(2) + " " = ~5 chars + time(16) + padding = ~25 fixed
  const prefixLen = 7; // " " + cursor + num + spaces
  const suffixLen = 18; // " " + time(16) + " "
  const maxTitle = maxCols - prefixLen - suffixLen;

  if (entry.type === "local") {
    const tag = chalk.cyan("[本地]");
    const full = (entry.conv.title || "未命名");
    const title = fitOneLine(full, maxTitle - 7); // -7 for tag
    const time = formatTime(entry.conv.updatedAt || entry.conv.createdAt);
    return bg(` ${cursor}${num} ${tag} ${title}`) + chalk.gray(" ".repeat(Math.max(1, maxTitle - [...title].reduce((s, c) => s + (c.charCodeAt(0) > 127 ? 2 : 1), 0) - 7)) + " " + time);
  }
  if (entry.type === "ds") {
    const tag = chalk.magenta("[云端]");
    const pinned = entry.session.pinned ? chalk.yellow("★") : " ";
    const full = (entry.session.title || "未命名");
    // pinned char (+1)
    const pinW = pinned.trim() ? 1 : 0;
    const title = fitOneLine(full, maxTitle - 7 - pinW);
    const time = formatTime(entry.sortTime);
    return bg(` ${cursor}${num} ${tag} ${pinned}${title}`) + chalk.gray(" ".repeat(Math.max(1, maxTitle - [...title].reduce((s, c) => s + (c.charCodeAt(0) > 127 ? 2 : 1), 0) - 7 - pinW)) + " " + time);
  }
  return "";
}

/** 截断文本到 maxCols 列（中文字符计 2 列） */
function fitOneLine(text, maxLen) {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const cw = text.charCodeAt(i) > 127 ? 2 : 1;
    if (w + cw > maxLen) return text.slice(0, i) + "...";
    w += cw;
  }
  return text;
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

function echoMessages(messages, markdown = true) {
  for (const msg of messages) {
    if (msg.role === "user") {
      printUserMsg(msg.content);
    } else {
      if (msg.thinking) {
        process.stdout.write(chalk.gray.dim("   " + msg.thinking.replace(/\n/g, "\n   ") + "\n"));
      }
      const rendered = markdown ? renderMarkdown(msg.content, true) : msg.content;
      // markdown renderer 已处理缩进，这里加空白行分隔
      process.stdout.write(rendered.replace(/\n/g, "\n") + "\n\n");
    }
  }
}

/**
 * 流式响应，直接向 stdout 写入（AI 输出每行带 3 空格缩进，与 ❯ 对齐）
 */
async function streamResponse(provider, messages, opts) {
  const useMarkdown = opts.markdown !== false;
  let thinking = "";
  let response = "";
  let firstChunk = true;
  /** 继聊时 service 返回的 response_message_id / 新会话 ID */
  let messageId = null;
  let sessionId = null;
  // 流式 markdown 行缓冲
  let mdLineBuf = "";

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
      if (thinking === t) t = "   " + t;
      t = t.replace(/\n/g, "\n   ");
      process.stdout.write(chalk.gray(t));
    } else {
      response += delta.text;
      if (!useMarkdown) {
        let text = delta.text;
        if (response === delta.text) {
          text = (thinking ? "\n   " : "   ") + text;
        }
        text = text.replace(/\n/g, "\n   ");
        process.stdout.write(chalk.white(text));
        continue;
      }

      // Markdown: 按行缓冲渲染
      mdLineBuf += delta.text;
      let newlineIdx;
      while ((newlineIdx = mdLineBuf.indexOf("\n")) >= 0) {
        const line = mdLineBuf.slice(0, newlineIdx);
        mdLineBuf = mdLineBuf.slice(newlineIdx + 1);
        process.stdout.write(renderLine(line, thinking, response));
        thinking = ""; // 只首次缩进
      }
    }
  }

  // 最后一行
  if (useMarkdown && mdLineBuf) {
    process.stdout.write(renderLine(mdLineBuf, thinking, response));
  }

  if (firstChunk) return null;
  process.stdout.write("\n\n");
  return { thinking, response, messageId, sessionId };
}

/** 渲染单行 markdown */
const _globalState = { responseStarted: false };
function renderLine(line, needsIndent, fullResponse) {
  let out = "";
  if (!_globalState.responseStarted) {
    _globalState.responseStarted = true;
    if (needsIndent) out += "\n";
    if (!line.trim() || line.startsWith("```")) {
      out += (needsIndent ? "" : "   ");
    } else {
      out += "   ";
    }
  }
  const rendered = renderMarkdown(line, true);
  out += rendered + "\n";
  return out;
}

// 每次新对话重置状态
export function resetMarkdownState() {
  _globalState.responseStarted = false;
  resetMarkdownRenderer();
}

async function chatLoop(provider, messages, currentModel, accountId, sessionId = null, parentMessageId = null, markdown = true, chatOverrides = {}) {
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

  /** 字符终端列宽（CJK 计 2 列） */
  function charWidth(c) { return c.charCodeAt(0) > 127 ? 2 : 1; }

  /**
   * raw mode 等待输入 — 支持历史导航、行内编辑、CJK 退格。
   */
  function waitForInput() {
    return new Promise((resolve) => {
      let input = "";
      let cursor = 0;         // 字符位置（0-index）
      let historyIdx = -1;    // 当前历史位置（-1 = 正在输入）
      let escState = 0;

      function redrawPrompt() {
        // 清除当前行从 prompt 开始的所有内容
        process.stdout.write("\r");
        process.stdout.write("   > ");
        process.stdout.write(input);
        process.stdout.write("\x1b[0K"); // 清除到行尾
        // 将光标移到正确位置（从 prompt "   > " 之后开始计算）
        if (cursor < input.length) {
          const leftChars = Array.from(input.slice(cursor));
          const leftCols = leftChars.reduce((s, c) => s + charWidth(c), 0);
          process.stdout.write(`\x1b[${leftCols}D`);
        }
      }

      function insertChar(char) {
        const chars = Array.from(input);
        chars.splice(cursor, 0, char);
        input = chars.join("");
        cursor++;
      }

      function deleteBefore() {
        if (cursor <= 0) return;
        const chars = Array.from(input);
        const removed = chars[cursor - 1];
        chars.splice(cursor - 1, 1);
        input = chars.join("");
        cursor--;
        // 用正确宽度覆盖已删除字符
        const w = charWidth(removed);
        process.stdout.write("\b".repeat(w) + " ".repeat(w) + "\b".repeat(w));
      }

      function deleteAfter() {
        const chars = Array.from(input);
        if (cursor >= chars.length) return;
        chars.splice(cursor, 1);
        input = chars.join("");
        redrawPrompt();
      }

      process.stdin.setRawMode(true);
      process.stdin.resume();

      const onData = (chunk) => {
        const str = chunk.toString("utf-8");
        for (const char of str) {
          const code = char.codePointAt(0);

          // ESC 序列
          if (escState > 0) {
            if (char === "[" && escState === 1) { escState = 2; continue; }
            if (escState === 2) {
              if (char === "A") { // 上：历史回溯
                if (history.length > 0 && (historyIdx < history.length - 1)) {
                  if (historyIdx === -1) savedInput = input;
                  historyIdx++;
                  input = history[history.length - 1 - historyIdx];
                  cursor = input.length;
                  redrawPrompt();
                }
              } else if (char === "B") { // 下：历史前进
                if (historyIdx >= 0) {
                  historyIdx--;
                  input = historyIdx >= 0 ? history[history.length - 1 - historyIdx] : (savedInput || "");
                  cursor = input.length;
                  if (historyIdx < 0) savedInput = "";
                  redrawPrompt();
                }
              } else if (char === "C") { // 右
                if (cursor < Array.from(input).length) {
                  const c = Array.from(input)[cursor];
                  process.stdout.write(`\x1b[${charWidth(c)}C`);
                  cursor++;
                }
              } else if (char === "D") { // 左
                if (cursor > 0) {
                  const c = Array.from(input)[cursor - 1];
                  process.stdout.write(`\x1b[${charWidth(c)}D`);
                  cursor--;
                }
              } else if (char === "H") { // Home
                const cols = cursorPosToCol();
                process.stdout.write(`\x1b[${cols}D`);
                cursor = 0;
              } else if (char === "F") { // End
                redrawPrompt();
              }
              escState = 0;
              continue;
            }
            escState = 0;
            continue;
          }
          if (code === 27) { escState = 1; continue; }

          // Enter
          if (code === 13) {
            process.stdout.write("\r\n");
            cleanup();
            const text = input.trim();
            if (text) history = [...history, text];
            resolve(text);
            return;
          }

          // Backspace
          if (code === 127 || code === 8) {
            if (cursor > 0) { deleteBefore(); redrawPrompt(); }
            continue;
          }

          // Delete (ESC[3~ is handled via ESC + [ + 3 + ~)
          // ─ handled inline below

          // Ctrl+C
          if (code === 3) { cleanup(); resolve("/exit"); return; }
          // Ctrl+D
          if (code === 4) { cleanup(); resolve("/exit"); return; }
          // Ctrl+A → Home
          if (code === 1) {
            const cols = cursorPosToCol();
            process.stdout.write(`\x1b[${cols}D`);
            cursor = 0;
            continue;
          }
          // Ctrl+E → End
          if (code === 5) { cursor = input.length; redrawPrompt(); continue; }
          // Ctrl+K → 删除到行尾
          if (code === 11) {
            const chars = Array.from(input);
            input = chars.slice(0, cursor).join("");
            redrawPrompt();
            continue;
          }
          // Ctrl+U → 删除到行首
          if (code === 21) {
            const chars = Array.from(input);
            const before = chars.slice(0, cursor).join("");
            const after = chars.slice(cursor).join("");
            const cols = cursorPosToCol();
            process.stdout.write(`\x1b[${cols}D`);
            process.stdout.write(" ".repeat(cols));
            process.stdout.write(`\x1b[${cols}D`);
            process.stdout.write(after);
            input = after;
            cursor = 0;
            redrawPrompt();
            continue;
          }

          // 可打印字符
          if (code >= 32 || code === 10) {
            insertChar(char);
            redrawPrompt();
          }
        }
      };

      function cursorPosToCol() {
        return Array.from(input).slice(0, cursor).reduce((s, c) => s + charWidth(c), 0);
      }

      function cleanup() {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
      }

      let savedInput = "";
      process.stdin.on("data", onData);
    });
  }

  function redrawFooter() {
    drawFooter();
  }

  let history = []; // 命令/对话历史
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
          setModelForProvider(provider.name, m);  // 持久化到配置文件
          process.stdout.write("   " + chalk.green("✓ ") + `模型已切换为: ${chalk.bold(m)}` + chalk.gray("  (已保存)") + "\n\n");
        } else {
          process.stdout.write("   " + chalk.red("✗ ") + `未知模型: ${m}\n\n`);
        }
        redrawFooter();
        continue;
      }
      if (input === "/config") {
        printUserMsg(input);
        const opts = getChatOptions(provider.name);
        process.stdout.write("   " + chalk.bold("当前配置:\n"));
        process.stdout.write("     thinking:  " + (opts.thinkingEnabled ? chalk.green("on") : chalk.gray("off")) + "\n");
        process.stdout.write("     search:    " + (opts.enableSearch ? chalk.green("on") : chalk.gray("off")) + "\n");
        process.stdout.write("\n   " + chalk.gray("用法: /config thinking on|off   /config search on|off\n\n"));
        redrawFooter();
        continue;
      }
      if (input.startsWith("/config ")) {
        const parts = input.slice(8).trim().split(/\s+/);
        const key = parts[0];
        const val = parts[1]?.toLowerCase();
        printUserMsg(input);
        if ((key === "thinking" || key === "search") && (val === "on" || val === "off" || val === "true" || val === "false")) {
          const configKey = key === "thinking" ? "thinkingEnabled" : "enableSearch";
          const boolVal = val === "on" || val === "true";
          setChatOption(provider.name, configKey, boolVal);
          process.stdout.write("   " + chalk.green("✓ ") + `${key} = ${boolVal ? chalk.green("on") : chalk.gray("off")}` + chalk.gray("  (已保存)") + "\n\n");
        } else {
          process.stdout.write("   " + chalk.red("✗ ") + `用法: /config thinking on|off   /config search on|off\n\n`);
        }
        redrawFooter();
        continue;
      }
      if (input === "/switch") {
        printUserMsg(input);
        const state = getStore();
        const convs = state.conversations
          .filter(c => c.provider === provider.name && c.messages?.length > 0)
          .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        if (convs.length === 0) {
          process.stdout.write("   " + chalk.gray("没有历史对话，输入内容开始新对话\n\n"));
        } else {
          process.stdout.write("   " + chalk.bold("对话列表:\n"));
          for (let i = 0; i < Math.min(convs.length, 20); i++) {
            const c = convs[i];
            const t = (c.title || "未命名").slice(0, 45);
            const tm = formatTime(c.updatedAt || c.createdAt);
            process.stdout.write(`     ${chalk.cyan(String(i+1).padStart(2))} ${t}  ${chalk.dim(tm)}\n`);
          }
          process.stdout.write(`     ${chalk.cyan(" 0")} 新对话\n`);
          process.stdout.write(chalk.gray("   输入 /conv <序号> 切换  (例: /conv 1)\n\n"));
        }
        redrawFooter();
        continue;
      }
      if (input.startsWith("/conv ")) {
        const num = parseInt(input.slice(6).trim(), 10);
        const state = getStore();
        const convs = state.conversations
          .filter(c => c.provider === provider.name && c.messages?.length > 0)
          .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        printUserMsg(input);
        if (num === 0) {
          // 保存当前对话（如果有内容）
          if (messages.length > 0) {
            saveConversation({
              id: createId(), provider: provider.name, model: currentModel,
              title: buildConversationTitle(messages), messages: [...messages],
              accountId: accountId || "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
            });
          }
          messages.length = 0;
          sessionId = null;
          parentMessageId = null;
          process.stdout.write("   " + chalk.green("✓ ") + "已开始新对话\n\n");
        } else if (num > 0 && num <= convs.length) {
          // 保存当前对话
          if (messages.length > 0) {
            saveConversation({
              id: createId(), provider: provider.name, model: currentModel,
              title: buildConversationTitle(messages), messages: [...messages],
              accountId: accountId || "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
            });
          }
          const conv = convs[num - 1];
          messages.length = 0;
          messages.push(...conv.messages);
          sessionId = conv.dsSessionId || null;
          accountId = conv.accountId || accountId;
          currentModel = conv.model || currentModel;
          process.stdout.write("   " + chalk.green("✓ ") + `已切换到: ${chalk.bold(conv.title || "未命名")}\n\n`);
          echoMessages(conv.messages, useMarkdown);
        } else {
          process.stdout.write("   " + chalk.red("✗ ") + `无效序号: ${num}  使用 /switch 查看列表\n\n`);
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

      const chatOpts = getChatOptions(provider.name);
      const result = await streamResponse(
        provider, messages, { model: currentModel, accountId, sessionId, parentMessageId, markdown, ...chatOpts, ...chatOverrides }
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
  const config = getConfig();
  const useMarkdown = opts.markdown !== false && config.markdown !== false;  // CLI --no-markdown 或配置均可关闭
  const skipPicker = opts.skipPicker || config.newChatOnStart === true;  // --new 或配置均可跳过历史
  resetMarkdownState();

  // 收集所有服务商的已登录账号
  const allProviders = listProviders();
  const providerAccounts = [];
  for (const p of allProviders) {
    if (!p.isAuthenticated()) continue;
    if (typeof p.listAccounts === "function") {
      for (const a of p.listAccounts()) {
        providerAccounts.push({ provider: p, account: a });
      }
    } else {
      const a = p.getAccountInfo();
      if (a) providerAccounts.push({ provider: p, account: a });
    }
  }

  if (!providerAccounts.length) {
    printError("没有已登录的账号。请运行: chat2cli login");
    return;
  }

  // 选择账号和服务商
  let chatProvider = provider;
  let accountId = null;

  if (providerAccounts.length === 1) {
    chatProvider = providerAccounts[0].provider;
    accountId = providerAccounts[0].account.id || null;
  } else {
    const { default: inquirer } = await import("inquirer");
    const ans = await inquirer.prompt([{
      type: "list", name: "accountIndex", message: "选择账号:",
      choices: providerAccounts.map((pa, i) => ({
        name: `${accountLabel(pa.account)}  [${pa.provider.label}]`,
        value: i
      }))
    }]);
    chatProvider = providerAccounts[ans.accountIndex].provider;
    accountId = providerAccounts[ans.accountIndex].account.id || null;
  }

  if (!chatProvider.isAuthenticated()) {
    printError("所选账号未登录。");
    return;
  }

  // 显示历史记录选择器（--new / -n 参数跳过）
  if (skipPicker) {
    // 直接新对话
    const currentModel = modelOverride || resolveModel(chatProvider);
    const convId = createId();
    printChatHeader(chatProvider.label, currentModel, convId.slice(0, 8));
    const messages = [];
    await chatLoop(chatProvider, messages, currentModel, accountId, null, null, useMarkdown);
    if (messages.length > 0) {
      const conv = {
        id: convId, provider: chatProvider.name, model: currentModel,
        title: buildConversationTitle(messages), messages: [...messages],
        accountId: accountId || "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      saveConversation(conv);
      printSuccess(`对话已保存 (id: ${chalk.dim(convId.slice(0, 8))})`);
    }
    return;
  }

  const picked = await pickConversation(chatProvider, accountId);

  if (picked.action === "exit") return;  // Ctrl+C 取消

  if (picked.action === "new") {
    // 全新对话
    const currentModel = modelOverride || resolveModel(chatProvider);
    const convId = createId();

    printChatHeader(chatProvider.label, currentModel, convId.slice(0, 8));
    const messages = [];
    await chatLoop(chatProvider, messages, currentModel, accountId, null, null, useMarkdown);

    if (messages.length > 0) {
      const conv = {
        id: convId, provider: chatProvider.name, model: currentModel,
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
    const currentModel = modelOverride || conv.model || resolveModel(chatProvider);
    const messages = [...conv.messages];
    const convAccountId = conv.accountId || accountId;

    printChatHeader(chatProvider.label, currentModel, conv.id.slice(0, 8));
    echoMessages(messages, useMarkdown);

    await chatLoop(chatProvider, messages, currentModel, convAccountId, null, null, useMarkdown);

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
    const currentModel = modelOverride || resolveModel(chatProvider);
    const sessionId = picked.sessionId;
    const messages = [...picked.messages];
    const dsAccountId = picked.account?.id || accountId;
    // 使用 API 返回的 current_message_id 作为新消息的 parent
    const parentMsgId = picked.currentMessageId || null;

    printChatHeader(chatProvider.label, currentModel, sessionId.slice(0, 8));
    echoMessages(messages, useMarkdown);

    await chatLoop(chatProvider, messages, currentModel, dsAccountId, sessionId, parentMsgId, useMarkdown);

    if (messages.length > picked.messages.length) {
      // 保存到本地（暂存为本地对话副本）
      const convId = createId();
      const conv = {
        id: convId, provider: chatProvider.name, model: currentModel,
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
  const currentModel = modelOverride || resolveModel(provider);
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
