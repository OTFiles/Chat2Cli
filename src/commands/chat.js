import chalk from "chalk";
import { initProviders, getProvider, listProviders } from "../providers/registry.js";
import { getConfig, getModelForProvider, setModelForProvider, getChatOptions, setChatOption } from "../config.js";
import { getStore, updateStore } from "../storage/store.js";
import { createId } from "../utils/id.js";
import {
  printSuccess, printError, printInfo,
  printChatHeader,
  printUserMsg, printThinkingLabel, accountLabel,
  termWidth
} from "../utils/format.js";
import { renderMarkdown, resetMarkdownRenderer } from "../utils/markdown.js";

function resolveProvider() {
  return getProvider(getConfig().defaultProvider);
}

/** 获取当前 provider 的默认模型 */
function resolveModel(provider, modelOverride) {
  if (modelOverride) return modelOverride;
  const validIds = provider.getModels().map(m => m.id);
  // 1. per-provider 模型偏好（/model 命令持久化）
  const providerModel = getModelForProvider(provider.name);
  if (providerModel && validIds.includes(providerModel)) return providerModel;
  // 2. 全局默认模型（仅当对当前 provider 有效时）
  const defaultModel = getConfig().defaultModel;
  if (defaultModel && validIds.includes(defaultModel)) return defaultModel;
  // 3. provider 的第一个模型
  return validIds[0] || "gpt-3.5-turbo";
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

  const isDs = entry.type === "ds";
  const full = isDs
    ? (entry.session.title || "未命名")
    : (entry.conv.title || "未命名");
  const time = formatTime(isDs ? entry.sortTime : (entry.conv.updatedAt || entry.conv.createdAt));
  const tag = isDs ? chalk.magenta("[云端]") : chalk.cyan("[本地]");
  const pinned = isDs && entry.session.pinned ? chalk.yellow("★") : " ";

  // visible layout: " " + cursor + num + " " + tag + " " + pinned + title + pad + " " + time
  //                    1      2       2     1      4      1       1     titleW   pad    1     16
  const fixedBefore = 1 + 2 + 2 + 1 + 6 + 1 + 1; // 12 = " ❯01 [云端] ★"
  const fixedAfter = 1 + 16;                     // 17 = " 2026/07/14 12:00"
  const maxTitleW = maxCols - fixedBefore - fixedAfter;

  const title = fitOneLine(full, maxTitleW);
  const titleW = visualWidth(title);
  const pad = Math.max(0, maxTitleW - titleW);

  return bg(` ${cursor}${num} ${tag} ${pinned}${title}`) +
    chalk.gray(" ".repeat(pad) + " " + time);
}

/** 截断文本到 maxW 宽（含 "..."），中文/emoji 占 2 */
function fitOneLine(text, maxW) {
  const chars = [...text];
  let w = 0;
  const dotsW = 3;
  for (let i = 0; i < chars.length; i++) {
    const cw = (chars[i].codePointAt(0) || 0) > 127 ? 2 : 1;
    if (w + cw > maxW - dotsW) return chars.slice(0, i).join("") + "...";
    w += cw;
  }
  return text;
}

/** 计算可见宽度（ASCII 1，其他 2） */
function visualWidth(s) {
  let w = 0;
  for (const c of s) {
    w += (c.codePointAt(0) || 0) > 127 ? 2 : 1;
  }
  return w;
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

async function chatLoop(provider, messages, currentModel, accountId, sessionId = null, parentMessageId = null, markdown = true, chatOverrides = {}, sessionRef = null) {
  // 输入文本占用的终端行数
  const PROMPT_CHAT = "   > ";
  const CONT_CHAT = "    "; // 续行前缀，与 PROMPT_CHAT 等宽（4 列）

  // ── 粘贴标记存储 ──
  const pasteStore = {};
  let nextPasteId = 1;

  function insertPasteMarker(text) {
    const id = nextPasteId++;
    pasteStore[id] = text;
    return `[paste:${id}]`;
  }

  function markerAt(str, pos) {
    const re = /\[paste:(\d+)\]/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      const start = m.index, end = m.index + m[0].length;
      if (pos > start && pos <= end) return { id: +m[1], start, end };
    }
    return null;
  }

  function expandMarkers(s) {
    return s.replace(/\[paste:(\d+)\]/g, (_, id) => pasteStore[id] || `[paste:${id}]`);
  }

  function clearPasteStore() {
    for (const k of Object.keys(pasteStore)) delete pasteStore[k];
    nextPasteId = 1;
  }
  function totalInputLines(val) {
    let w = PROMPT_CHAT.length;
    const s = val || "";
    const re = /\[paste:\d+\]/g;
    let lastIdx = 0, m;
    while ((m = re.exec(s)) !== null) {
      for (let i = lastIdx; i < m.index; i++) w += (s.charCodeAt(i) > 127 ? 2 : 1);
      w += m[0].length; // 标记全 ASCII
      lastIdx = m.index + m[0].length;
    }
    for (let i = lastIdx; i < s.length; i++) w += (s.charCodeAt(i) > 127 ? 2 : 1);
    return Math.max(1, Math.ceil(w / termWidth()));
  }
  const maxVisible = Math.max(3, Math.min(8, Math.floor((process.stdout.rows || 24) * 0.2)));
  let scrollOffset = 0;
  let footerVis = 1;
  let cursorRelLine = 0;
  let cursorRelCol = 0;

  function visibleInputLines(val) {
    return Math.max(1, Math.min(totalInputLines(val || ""), maxVisible));
  }

  function drawInputFooter(val) {
    const vis = visibleInputLines(val);
    footerVis = vis;
    const W = termWidth();
    process.stdout.write("\r\x1b[J");
    _drawBorderChat(W, 0, val || "");
    for (let i = 0; i < vis; i++) process.stdout.write("\n");
    _drawBorderChat(W, 1, val || "");
    process.stdout.write("   " + chalk.dim("输入 /help 查看帮助") + "\n");
    const up = 2 + vis;
    process.stdout.write(`\x1b[${up}A\r`);
    process.stdout.write(PROMPT_CHAT);
    cursorRelLine = 0;
    cursorRelCol = 0;
  }

  function _drawBorderChat(W, type, val) {
    const above = type === 0 ? scrollOffset : Math.max(0, totalInputLines(val) - (scrollOffset + visibleInputLines(val)));
    if (above > 0) {
      const label = type === 0 ? ` ↑ ${above} more ` : ` ↓ ${above} more `;
      const avail = Math.max(1, W - label.length);
      process.stdout.write(chalk.dim("─".repeat(avail) + label) + "\n");
    } else {
      process.stdout.write(chalk.dim("─".repeat(W)) + "\n");
    }
  }

  function clearInputFooter(val) {
    // 回到 prompt 行，从那里清到屏底，再跳到 footer 下方
    process.stdout.write(`\x1b[${footerVis + 1}A`);
    process.stdout.write(`\x1b[${footerVis + 3}M`);
    // process.stdout.write(`\x1b[${footerVis + 2}E`); // AI写的，不知道何意味
  }

  // ── 绘制 footer + 定位到 prompt 行 ──
  function drawFooter() { drawInputFooter(""); }
  function clearFooter() { clearInputFooter(""); }

  /** 字符终端列宽（CJK 计 2 列） */
  function charWidth(c) { return c.charCodeAt(0) > 127 ? 2 : 1; }

  /** 按视觉宽度截断字符串（CJK 计 2 列），避免终端自动换行残留 */
  function truncateByVisualWidth(s, maxW) {
    let w = 0;
    const chars = [...s];
    for (let i = 0; i < chars.length; i++) {
      const cw = charWidth(chars[i]);
      if (w + cw > maxW) return chars.slice(0, i).join("");
      w += cw;
    }
    return s;
  }

  /**
   * raw mode 等待输入 — 支持历史导航、行内编辑、CJK 退格。
   */
  function waitForInput() {
    return new Promise((resolve) => {
      let input = "";
      let cursor = 0;         // 字符位置（0-index）
      let historyIdx = -1;    // 当前历史位置（-1 = 正在输入）
      let escState = 0;

      let cursorRelLine = 0;
      let cursorRelCol = 0;

      function redrawPrompt() {
        const newVis = visibleInputLines(input);

        // 如果可见行数变了，需要重绘 footer（边框也会变）
        if (newVis !== footerVis) {
          if (cursorRelLine > 0) process.stdout.write(`\x1b[${cursorRelLine}A`);
          process.stdout.write("\r");
          process.stdout.write("\x1b[J");
          footerVis = newVis;
          const W = termWidth();
          _drawBorderChat(W, 0, input);
          for (let i = 0; i < newVis; i++) process.stdout.write("\n");
          _drawBorderChat(W, 1, input);
          process.stdout.write("   " + chalk.dim("输入 /help 查看帮助") + "\n");
          const up = 2 + newVis;
          process.stdout.write(`\x1b[${up}A\r`);
          cursorRelLine = 0;
          cursorRelCol = 0;
        } else {
          if (cursorRelLine > 0) process.stdout.write(`\x1b[${cursorRelLine}A`);
          process.stdout.write("\r");
          // 如果正在滚动，重绘上/下边框指示器
          if (scrollOffset > 0 || totalInputLines(input) > maxVisible) {
            const W = termWidth();
            process.stdout.write(`\x1b[${newVis + 2}A\r`);
            _drawBorderChat(W, 0, input);
            process.stdout.write(`\x1b[${newVis + 1}E\r`);
            _drawBorderChat(W, 1, input);
            process.stdout.write(`\x1b[${newVis + 2}A\r`);
          }
        }

        const vis = newVis;
        const tw = termWidth() - PROMPT_CHAT.length;       // 折行宽度
        const safeW = Math.max(0, tw);                 // 折行已保证 ≤ tw
        const allChars = [...input];
        const wrapLines = [];
        let line = "", lineW = 0, i = 0;
        while (i < allChars.length) {
          const remaining = allChars.slice(i).join("");
          const mm = remaining.match(/^\[paste:(\d+)\]/);
          if (mm) {
            const marker = mm[0];
            const mw = marker.length; // 全部 ASCII
            if (lineW + mw > tw && line.length > 0) { wrapLines.push(line); line = ""; lineW = 0; }
            line += marker; lineW += mw;
            i += marker.length;
            continue;
          }
          const ch = allChars[i];
          const cw = charWidth(ch);
          if (lineW + cw > tw && line.length > 0) { wrapLines.push(line); line = ""; lineW = 0; }
          line += ch; lineW += cw;
          i++;
        }
        wrapLines.push(line);

        // 自动调整 scrollOffset 使光标可见
        let cursorLine = 0, charCount = 0;
        for (let i = 0; i < wrapLines.length; i++) {
          const len = Array.from(wrapLines[i]).length;
          if (charCount + len >= cursor) { cursorLine = i; break; }
          charCount += len;
          if (i === wrapLines.length - 1) cursorLine = i;
        }

        const maxOff = Math.max(0, wrapLines.length - vis);
        if (scrollOffset > maxOff) scrollOffset = maxOff;
        if (scrollOffset < 0) scrollOffset = 0;
        if (cursorLine < scrollOffset) scrollOffset = cursorLine;
        else if (cursorLine >= scrollOffset + vis) scrollOffset = cursorLine - vis + 1;
        scrollOffset = Math.max(0, Math.min(scrollOffset, maxOff));

        const visible = wrapLines.slice(scrollOffset, scrollOffset + vis);
        // 单遍渲染：每行 \r\x1b[K 清整行再写内容
        for (let i = 0; i < vis; i++) {
          if (i < visible.length) {
            const pre = (i === 0 && scrollOffset === 0) ? PROMPT_CHAT : CONT_CHAT;
            process.stdout.write("\r\x1b[K" + pre + truncateByVisualWidth(visible[i], safeW) + "\n");
          } else {
            process.stdout.write("\r\x1b[K\n");
          }
        }
        // 光标回到首行 + 定位
        process.stdout.write(`\x1b[${vis}A`);
        positionCursorChat(wrapLines, vis);
      }

      function clearAfterPrompt() {
        const vis = visibleInputLines(input);
        process.stdout.write(`\x1b[${vis}E\x1b[J\r`);
      }

      /** 将光标移到当前字符位置对应的视觉位置 */
      function positionCursorChat(wrapLines, vis) {
        let cursorLine = 0, charCount = 0;
        for (let i = 0; i < wrapLines.length; i++) {
          const len = Array.from(wrapLines[i]).length;
          if (charCount + len >= cursor) { cursorLine = i; break; }
          charCount += len;
          if (i === wrapLines.length - 1) cursorLine = i;
        }
        const lineBefore = wrapLines[cursorLine].slice(0, cursor - charCount);
        let col = (cursorLine === 0 && scrollOffset === 0) ? PROMPT_CHAT.length : CONT_CHAT.length;
        for (const ch of lineBefore) col += charWidth(ch);
        const relLine = cursorLine - scrollOffset;
        if (relLine < 0 || relLine >= vis) return;
        if (relLine > 0) process.stdout.write(`\x1b[${relLine}B`);
        process.stdout.write(`\x1b[${col + 1}G`);
        cursorRelLine = relLine;
        cursorRelCol = col;
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

        // 粘贴检测：将大段文本替换为标记
        if (chunk.length > 20) {
          const marker = insertPasteMarker(str);
          const chars = Array.from(input);
          chars.splice(cursor, 0, ...marker);
          input = chars.join("");
          cursor += marker.length;
          redrawPrompt();
          return; // 原子插入，跳过后面的逐字循环
        }

        for (const char of str) {
          const code = char.codePointAt(0);

          // ESC 序列
          if (escState > 0) {
            if (char === "[" && escState === 1) { escState = 2; continue; }
            if (escState === 2) {
              if (char === "A") { // 上：历史回溯 → 无历史时滚动
                if (history.length > 0 && (historyIdx < history.length - 1)) {
                  if (historyIdx === -1) savedInput = input;
                  historyIdx++;
                  input = history[history.length - 1 - historyIdx];
                  cursor = input.length;
                } else if (scrollOffset > 0) {
                  scrollOffset--;
                }
                redrawPrompt();
              } else if (char === "B") { // 下：历史前进 → 无历史时滚动
                if (historyIdx >= 0) {
                  historyIdx--;
                  input = historyIdx >= 0 ? history[history.length - 1 - historyIdx] : (savedInput || "");
                  cursor = input.length;
                  if (historyIdx < 0) savedInput = "";
                } else {
                  const tw = termWidth() - 4;
                  const allChars = Array.from(input);
                  const wrapLines = [];
                  let line = "", lw = 0;
                  for (const c of allChars) { const cw = charWidth(c); if (lw + cw > tw && line.length) { wrapLines.push(line); line = ""; lw = 0; } line += c; lw += cw; }
                  wrapLines.push(line);
                  const maxOff = Math.max(0, wrapLines.length - visibleInputLines(input));
                  if (scrollOffset < maxOff) scrollOffset++;
                }
                redrawPrompt();
              } else if (char === "C") { // 右：跳过标记
                if (cursor < [...input].length) {
                  const m = markerAt(input, cursor + 1);
                  const allChars = [...input];
                  if (m && cursor === m.start) {
                    cursor = m.end;
                    redrawPrompt();
                  } else {
                    process.stdout.write(`\x1b[${charWidth(allChars[cursor])}C`);
                    cursor++;
                  }
                }
              } else if (char === "D") { // 左：跳过标记
                if (cursor > 0) {
                  const m = markerAt(input, cursor);
                  const allChars = [...input];
                  if (m && cursor === m.end) {
                    cursor = m.start;
                    redrawPrompt();
                  } else {
                    process.stdout.write(`\x1b[${charWidth(allChars[cursor - 1])}D`);
                    cursor--;
                  }
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

          // Enter：发送时展开标记
          if (code === 13) {
            process.stdout.write("\r\n");
            cleanup();
            const raw = input.trim();
            const text = expandMarkers(raw);
            clearPasteStore();
            if (text) history = [...history, raw];
            resolve(text);
            return;
          }

          // Backspace：标记内 → 整块删除
          if (code === 127 || code === 8) {
            if (cursor > 0) {
              const m = markerAt(input, cursor);
              if (m) {
                const chars = Array.from(input);
                chars.splice(m.start, m.end - m.start);
                input = chars.join("");
                cursor = m.start;
                delete pasteStore[m.id];
              } else {
                deleteBefore();
              }
              redrawPrompt();
            }
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
            clearPasteStore();
            const chars = Array.from(input);
            input = chars.slice(0, cursor).join("");
            redrawPrompt();
            continue;
          }
          // Ctrl+U → 删除到行首
          if (code === 21) {
            clearPasteStore();
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

          // 可打印字符 + 换行（粘贴已在前面处理，这里都是正常输入）
          if (code >= 32) {
            insertChar(char);
            redrawPrompt();
          } else if (code === 10) {
            insertChar(" ");
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
      if (input === "/exut") {
        process.stdout.write(chalk.gray("是\"/exit\"而不是\"/exut\"哦～\n再见～\n"));
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
        process.stdout.write("     keep:      " + (opts.keepSession ? chalk.green("on") : chalk.gray("off")) + "\n");
        process.stdout.write("\n   " + chalk.gray("用法: /config thinking on|off   /config search on|off   /config keep on|off\n\n"));
        redrawFooter();
        continue;
      }
      if (input.startsWith("/config ")) {
        const parts = input.slice(8).trim().split(/\s+/);
        const key = parts[0];
        const val = parts[1]?.toLowerCase();
        printUserMsg(input);
        if ((key === "thinking" || key === "search" || key === "keep") && (val === "on" || val === "off" || val === "true" || val === "false")) {
          const configKey = key === "thinking" ? "thinkingEnabled" : key === "search" ? "enableSearch" : "keepSession";
          const boolVal = val === "on" || val === "true";
          setChatOption(provider.name, configKey, boolVal);
          process.stdout.write("   " + chalk.green("✓ ") + `${key} = ${boolVal ? chalk.green("on") : chalk.gray("off")}` + chalk.gray("  (已保存)") + "\n\n");
        } else {
          process.stdout.write("   " + chalk.red("✗ ") + `用法: /config thinking on|off   /config search on|off   /config keep on|off\n\n`);
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
          parentMessageId = conv.parentMessageId || null;
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

      // 每次请求后更新 sessionId（可能因旧 session 失效而被上游重建）
      if (result.sessionId && result.sessionId !== sessionId) {
        sessionId = result.sessionId;
        if (sessionRef) sessionRef.sessionId = sessionId;
      }

      // 更新 parentMessageId 供下次继聊使用
      if (result.messageId) {
        parentMessageId = result.messageId;
        if (sessionRef) sessionRef.messageId = result.messageId;
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
    const sessionRef = { sessionId: null, messageId: null };
    await chatLoop(chatProvider, messages, currentModel, accountId, null, null, useMarkdown, {}, sessionRef);
    if (messages.length > 0) {
      const conv = {
        id: convId, provider: chatProvider.name, model: currentModel,
        title: buildConversationTitle(messages), messages: [...messages],
        accountId: accountId || "", dsSessionId: sessionRef.sessionId || undefined, parentMessageId: sessionRef.messageId || undefined,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
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
    const sessionRef = { sessionId: null, messageId: null };
    await chatLoop(chatProvider, messages, currentModel, accountId, null, null, useMarkdown, {}, sessionRef);

    if (messages.length > 0) {
      const conv = {
        id: convId, provider: chatProvider.name, model: currentModel,
        title: buildConversationTitle(messages), messages: [...messages],
        accountId: accountId || "", dsSessionId: sessionRef.sessionId || undefined, parentMessageId: sessionRef.messageId || undefined,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
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

    const sessionRef = { sessionId: conv.dsSessionId || null, messageId: conv.parentMessageId || null };
    await chatLoop(chatProvider, messages, currentModel, convAccountId, conv.dsSessionId || null, conv.parentMessageId || null, useMarkdown, {}, sessionRef);

    if (messages.length > conv.messages.length) {
      updateStore((state) => ({
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === conv.id
            ? { ...c, model: currentModel, messages, dsSessionId: sessionRef.sessionId || c.dsSessionId, parentMessageId: sessionRef.messageId || c.parentMessageId, updatedAt: new Date().toISOString() }
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
