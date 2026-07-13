import chalk from "chalk";
import { runAgentLoop, runAuxCall } from "./agent-loop.js";
import {
  printUserMsg, printThinkingLabel, BOX, termWidth
} from "../utils/format.js";
import { renderMarkdown, resetMarkdownRenderer } from "../utils/markdown.js";

// ═══════════════════════════════════════════════
//  Agent TUI — 复用 chat.js 的 raw mode 输入模式
// ═══════════════════════════════════════════════

/**
 * 启动 Agent TUI 循环
 * @param {object} context - { mainProvider, auxProvider, composite, workingDir, mainModel, auxModel }
 */
export async function agentTui(context) {
  const { composite, mainProvider, auxProvider, workingDir, mainModel, auxModel } = context;

  // 显示头部（含 CHAT2CLI logo）
  printAgentHeader({
    mainLabel: mainProvider.label,
    auxLabel: auxProvider.label,
    mainModel,
    auxModel,
    projectName: composite.name,
    workingDir: workingDir || composite.workingDir
  });

  // 设置 raw mode
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // 输入历史
  const inputHistory = [];
  let histIdx = -1;
  let currentInput = "";
  let cursor = 0;
  let escState = 0;

  // 中断控制
  let abortController = null;

  function charWidth(c) {
    return (c.charCodeAt(0) > 127) ? 2 : 1;
  }

  /** 按视觉宽度截断字符串（CJK 计 2 列），避免终端自动换行残留 */
  function truncateByVisualWidth(s, maxW) {
    let w = 0;
    for (let i = 0; i < s.length; i++) {
      const cw = charWidth(s[i]);
      if (w + cw > maxW) return s.slice(0, i);
      w += cw;
    }
    return s;
  }

  // 输入文本的终端行数
  const PW = 6; // "   ❯ " 视觉宽度（❯ = 双列宽）
  const PROMPT = "   ❯ ";
  const CONT   = "      "; // 续行前缀，与 PROMPT 等宽
  const CONT_CHAT = "    "; // chat 模式用（> 是单列宽）

  function totalInputLines() {
    let w = PW;
    for (const ch of currentInput) w += charWidth(ch);
    return Math.max(1, Math.ceil(w / termWidth()));
  }

  // 可见区域：动态高度（默认 1 行，最大为终端高度的 20%，至少 3 行）
  const maxVisible = Math.max(3, Math.min(8, Math.floor((process.stdout.rows || 24) * 0.2)));
  let scrollOffset = 0; // 已滚出屏幕顶部的行数
  let footerVis = 1;    // 当前 footer 绘制时用的可见行数

  function visibleInputLines() {
    return Math.max(1, Math.min(totalInputLines(), maxVisible));
  }

  function drawFooter() {
    const vis = visibleInputLines();
    footerVis = vis;
    const W = termWidth();
    // 清除当前位置到屏底
    process.stdout.write("\r\x1b[J");
    // 上边框
    _drawBorder(W, 0);
    // 输入行
    for (let i = 0; i < vis; i++) process.stdout.write("\n");
    // 下边框
    _drawBorder(W, 1);
    process.stdout.write("   " + chalk.dim("输入 /help 查看帮助") + "\n");
    // 回到 prompt 行
    const up = 2 + vis;
    process.stdout.write(`\x1b[${up}A\r`);
    process.stdout.write(PROMPT);
    cursorRelLine = 0;
    cursorRelCol = 0;
  }

  /** type: 0=上边框, 1=下边框 */
  function _drawBorder(W, type) {
    const above = type === 0 ? scrollOffset : Math.max(0, totalInputLines() - (scrollOffset + visibleInputLines()));
    if (above > 0) {
      const label = type === 0 ? ` ↑ ${above} more ` : ` ↓ ${above} more `;
      const avail = Math.max(1, W - label.length);
      process.stdout.write(chalk.dim("─".repeat(avail) + label) + "\n");
    } else {
      process.stdout.write(chalk.dim("─".repeat(W)) + "\n");
    }
  }

  function clearFooter() {
    // 以当前 footer 高度 + 1 行刷新到屏底
    process.stdout.write(`\x1b[${footerVis + 2}E\x1b[J\r`);
  }

  function redrawPrompt() {
    const newVis = visibleInputLines();

    // 如果可见行数变了，需要重绘 footer（边框也会变）
    if (newVis !== footerVis) {
      // 先回到输入区顶部，清除旧 footer，再画新的
      if (cursorRelLine > 0) process.stdout.write(`\x1b[${cursorRelLine}A`);
      process.stdout.write("\r");
      // 清除旧 footer（footerVis + 2 边框 + 1 help）
      process.stdout.write(`\x1b[J`);
      footerVis = newVis;
      const W = termWidth();
      _drawBorder(W, 0);
      for (let i = 0; i < newVis; i++) process.stdout.write("\n");
      _drawBorder(W, 1);
      process.stdout.write("   " + chalk.dim("输入 /help 查看帮助") + "\n");
      const up = 2 + newVis;
      process.stdout.write(`\x1b[${up}A\r`);
      cursorRelLine = 0;
      cursorRelCol = 0;
    } else {
      // 回到输入区顶部
      moveToTop();
      // 如果正在滚动，重绘上/下边框指示器
      if (scrollOffset > 0 || totalInputLines() > maxVisible) {
        const W = termWidth();
        // 上移到上边框行
        process.stdout.write(`\x1b[${newVis + 2}A\r`);
        _drawBorder(W, 0);
        // 下移到下边框行
        process.stdout.write(`\x1b[${newVis + 1}E\r`);
        _drawBorder(W, 1);
        // 回到输入区首行
        process.stdout.write(`\x1b[${newVis + 2}A\r`);
      }
    }

    const vis = newVis;
    const tw = termWidth() - PW;       // 折行宽度
    const safeW = Math.max(0, tw - 1); // 渲染宽度留 1 列防自动折行

    const inBurstView = pasteChunks.length > 0 && currentInput.length > 300;

    if (inBurstView) {
      // burst 模式：显示粘贴前 + 折叠标记 + 粘贴后
      const prePasteStart = pasteChunks[0].start;
      const lastEnd = pasteChunks[pasteChunks.length - 1].end;
      const prePaste = currentInput.slice(0, prePasteStart);
      const postPaste = currentInput.slice(lastEnd);
      const pasteLen = pasteChunks.reduce((s, c) => s + (c.end - c.start), 0);
      let prefix = prePaste;
      if (prePaste.length > 30) prefix = "…" + prePaste.slice(-30);
      let suffix = postPaste;
      if (postPaste.length > 30) suffix = postPaste.slice(0, 30) + "…";
      const label = chalk.gray(` […${pasteLen} 字符 …] `);
      const displayText = prefix + label + suffix;

      // 对 displayText 折行（label 是 ANSI 字符串，不计宽度时应去色计算）
      const wrapLines = [];
      let line = "", lineW = 0;
      for (const ch of displayText) {
        const cw = ch === "\x1b" ? 0 : charWidth(ch);
        if (lineW + cw > tw && line.length > 0) { wrapLines.push(line); line = ""; lineW = 0; }
        line += ch; lineW += cw;
      }
      // 去掉 chalk 色码再计宽：纯文本宽度可能超过 tw, 折行时忽略色码
      wrapLines.push(line);

      // 确保光标可见（burst view 中光标通常在 prefix 末尾）
      let cursorLine = 0;
      if (cursor >= prePasteStart && cursor < lastEnd) {
        // 光标在粘贴块内，显示在 prefix 末尾
        cursorLine = 0;
      }
      const maxOff = Math.max(0, wrapLines.length - vis);
      if (scrollOffset > maxOff) scrollOffset = maxOff;
      if (cursorLine < scrollOffset) scrollOffset = cursorLine;
      else if (cursorLine >= scrollOffset + vis) scrollOffset = cursorLine - vis + 1;

      const visible = wrapLines.slice(scrollOffset, scrollOffset + Math.min(vis, wrapLines.length));
      for (let i = 0; i < vis; i++) {
        if (i < visible.length) {
          const pre = (i === 0 && scrollOffset === 0) ? PROMPT : CONT;
          process.stdout.write("\r\x1b[K" + pre + truncateByVisualWidth(visible[i], safeW) + "\n");
        } else {
          process.stdout.write("\r\x1b[K\n");
        }
      }
      process.stdout.write(`\x1b[${vis}A`);
      cursorRelLine = 0;
      cursorRelCol = 0;
    } else if (burstMode && currentInput.length > 300) {
      // 无 pasteChunk 时的降级显示
      const visAlt = Math.min(vis, 1);
      process.stdout.write("\r\x1b[K" + PROMPT + chalk.gray(`[… ${currentInput.length} 字符 …]`) + "\n");
      for (let i = 1; i < visAlt; i++) process.stdout.write("\r\x1b[K\n");
      process.stdout.write(`\x1b[${visAlt}A`);
      cursorRelLine = 0;
      cursorRelCol = 0;
    } else {
      // 正常模式：按视觉宽度折行
      const allChars = Array.from(currentInput);
      const wrapLines = [];
      let line = "", lineW = 0;
      for (const ch of allChars) {
        const cw = charWidth(ch);
        if (lineW + cw > tw && line.length > 0) {
          wrapLines.push(line);
          line = ""; lineW = 0;
        }
        line += ch; lineW += cw;
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
      // 光标不可见时调整 scroll
      if (cursorLine < scrollOffset) scrollOffset = cursorLine;
      else if (cursorLine >= scrollOffset + vis) scrollOffset = cursorLine - vis + 1;
      scrollOffset = Math.max(0, Math.min(scrollOffset, maxOff));

      const visible = wrapLines.slice(scrollOffset, scrollOffset + vis);

      // 单遍渲染：每行先 \r\x1b[K 清整行，再写内容
      for (let i = 0; i < vis; i++) {
        if (i < visible.length) {
          const pre = (i === 0 && scrollOffset === 0) ? PROMPT : CONT;
          process.stdout.write("\r\x1b[K" + pre + truncateByVisualWidth(visible[i], safeW) + "\n");
        } else {
          process.stdout.write("\r\x1b[K\n");
        }
      }
      process.stdout.write(`\x1b[${vis}A`);

      // 光标定位
      positionCursor(wrapLines, vis);
    }
  }

  /** 将光标移到当前字符位置对应的视觉位置，记录相对于输入区顶部的行偏移 */
  let cursorRelLine = 0;
  let cursorRelCol = 0;
  function positionCursor(wrapLines, vis) {
    // 找出光标在哪一行
    let cursorLine = 0, charCount = 0;
    for (let i = 0; i < wrapLines.length; i++) {
      const len = Array.from(wrapLines[i]).length;
      if (charCount + len >= cursor) { cursorLine = i; break; }
      charCount += len;
      if (i === wrapLines.length - 1) cursorLine = i;
    }

    // 该行上光标前的视觉列数（考虑滚动后首行前缀）
    const lineBefore = wrapLines[cursorLine].slice(0, cursor - charCount);
    let col = (cursorLine === 0 && scrollOffset === 0) ? PW : CONT.length;
    for (const ch of lineBefore) col += charWidth(ch);

    // 相对可见区的位置
    const relLine = cursorLine - scrollOffset;
    if (relLine < 0 || relLine >= vis) return;

    if (relLine > 0) process.stdout.write(`\x1b[${relLine}B`);
    process.stdout.write(`\x1b[${col + 1}G`); // 1-based ANSI column
    cursorRelLine = relLine;
    cursorRelCol = col;
  }

  /** 从编辑位置回到输入区顶部（行首） */
  function moveToTop() {
    if (cursorRelLine > 0) process.stdout.write(`\x1b[${cursorRelLine}A`);
    process.stdout.write("\r");
  }

  // 初始绘制
  drawFooter();

  // ═══════════════════════════════════════════════
  //  Burst 检测 + pasteChunks
  // ═══════════════════════════════════════════════

  let lastDataTime = 0;
  let burstMode = false;
  const pasteChunks = []; // [{start, end}] — 原子删除单元

  function resetPasteMode() {
    burstMode = false;
    pasteChunks.length = 0;
    scrollOffset = 0;
  }

  function adjustChunksAfterDelete(pos, len) {
    for (const c of pasteChunks) {
      if (c.start >= pos) { c.start -= len; c.end -= len; }
      else if (c.end > pos) { c.end -= len; }
    }
  }

  function deleteChunkAt(pos) {
    const idx = pasteChunks.findIndex(c => c.end === pos);
    if (idx === -1) return false;
    const c = pasteChunks[idx];
    const arr = Array.from(currentInput);
    arr.splice(c.start, c.end - c.start);
    currentInput = arr.join("");
    cursor = c.start;
    const removed = c.end - c.start;
    pasteChunks.splice(idx, 1);
    adjustChunksAfterDelete(c.start, removed);
    return true;
  }

  // ── 按键处理 ──
  const onData = (buf) => {
    const now = Date.now();
    const str = buf.toString();

    // Burst 检测：多字节事件必定是粘贴，单字节慢速则退出 burst（但保留 chunks）
    if (str.length > 1) {
      burstMode = true;
      pasteChunks.push({ start: cursor, end: cursor + str.length });
    } else if (now - lastDataTime > 300) {
      burstMode = false;
      // 不清理 pasteChunks — 折叠视图由 currentInput.length > 300 控制
    }
    lastDataTime = now;

    for (const ch of str) {
      const code = ch.charCodeAt(0);

      // Ctrl+C
      if (code === 3) {
        if (abortController) {
          abortController.abort();
          abortController = null;
          process.stdout.write("\n   " + chalk.yellow("⚠ 已中断，进入人工指导模式（输入指令或空行继续）") + "\n\n");
          currentInput = ""; cursor = 0; scrollOffset = 0;
          drawFooter();
          return;
        }
        process.stdout.write("\n\n");
        process.stdin.setRawMode(wasRaw);
        process.stdin.removeListener("data", onData);
        process.exit(0);
        return;
      }

      // Ctrl+D
      if (code === 4 && !currentInput) {
        process.stdout.write("\n");
        process.stdin.setRawMode(wasRaw);
        process.stdin.removeListener("data", onData);
        return;
      }

      // Enter：burst 中跳过 \r
      if (code === 13) {
        if (burstMode) continue;
        clearFooter();
        const input = currentInput.trim();
        resetPasteMode();
        currentInput = ""; cursor = 0;
        process.stdout.write("\r\x1b[J\n");
        if (input) {
          inputHistory.push(input); histIdx = -1;
          handleInput(input);
        } else {
          drawFooter();
        }
        return;
      }

      // Ctrl+U/K：删除时退出 burst
      if (code === 21 || code === 11) {
        burstMode = false; pasteChunks.length = 0;
      }

      // Escape
      if (code === 27) { escState = 1; continue; }
      if (escState === 1 && ch === "[") { escState = 2; continue; }

      if (escState === 2) {
        escState = 0;
        if (ch === "A") {
          // ↑：先尝试历史回溯，否则滚动可见区
          if (inputHistory.length > 0 && histIdx < inputHistory.length - 1) {
            histIdx++;
            currentInput = inputHistory[inputHistory.length - 1 - histIdx];
            cursor = currentInput.length; scrollOffset = 0;
          } else if (!burstMode && scrollOffset > 0) {
            scrollOffset--;
          }
          redrawPrompt();
          continue;
        }
        if (ch === "B") {
          if (histIdx > 0) {
            histIdx--; currentInput = inputHistory[inputHistory.length - 1 - histIdx];
            cursor = currentInput.length; scrollOffset = 0;
          } else if (histIdx === 0) {
            histIdx = -1; currentInput = ""; cursor = 0; scrollOffset = 0;
          } else if (!burstMode) {
            const maxOff = Math.max(0, totalInputLines() - visibleInputLines());
            if (scrollOffset < maxOff) scrollOffset++;
          }
          redrawPrompt();
          continue;
        }
        if (ch === "D") { if (cursor > 0) cursor--; redrawPrompt(); continue; }
        if (ch === "C") { if (cursor < currentInput.length) cursor++; redrawPrompt(); continue; }
        if (ch === "H") { cursor = 0; redrawPrompt(); continue; }
        if (ch === "F") { cursor = currentInput.length; redrawPrompt(); continue; }
        continue;
      }
      escState = 0;

      // Backspace：有粘贴块时删除整块；正常模式按字符删除
      if (code === 127) {
        if (cursor > 0) {
          if (pasteChunks.length > 0 && currentInput.length > 300) {
            // 删除最后一块粘贴
            const lastChunk = pasteChunks.pop();
            const arr = Array.from(currentInput);
            arr.splice(lastChunk.start, lastChunk.end - lastChunk.start);
            currentInput = arr.join("");
            cursor = lastChunk.start;
            adjustChunksAfterDelete(lastChunk.start, lastChunk.end - lastChunk.start);
            if (pasteChunks.length === 0) resetPasteMode();
            redrawPrompt();
            continue;
          }
          if (deleteChunkAt(cursor)) {
            redrawPrompt(); continue;
          }
          const arr = Array.from(currentInput);
          arr.splice(cursor - 1, 1);
          currentInput = arr.join(""); cursor--;
          adjustChunksAfterDelete(cursor, 1);
          redrawPrompt();
        }
        continue;
      }

      // Ctrl+K / Ctrl+U
      if (code === 11) {
        currentInput = Array.from(currentInput).slice(0, cursor).join("");
        redrawPrompt(); continue;
      }
      if (code === 21) {
        currentInput = Array.from(currentInput).slice(cursor).join("");
        cursor = 0; redrawPrompt(); continue;
      }

      // Ctrl+A/E
      if (code === 1) { cursor = 0; redrawPrompt(); continue; }
      if (code === 5) { cursor = currentInput.length; redrawPrompt(); continue; }

      // Tab
      if (code === 9) continue;

      // \n：burst → 空格
      if (code === 10) {
        if (burstMode) {
          const arr = Array.from(currentInput); arr.splice(cursor, 0, " ");
          currentInput = arr.join(""); cursor++;
          adjustChunksAfterDelete(cursor - 1, -1);
        }
        if (!burstMode) redrawPrompt();
        continue;
      }

      // 可打印字符
      if (code >= 32) {
        const arr = Array.from(currentInput); arr.splice(cursor, 0, ch);
        currentInput = arr.join(""); cursor++;
        if (burstMode) {
          // 更新最后一个 pasteChunk 的 end
          const last = pasteChunks.at(-1);
          if (last) last.end++;
        } else {
          redrawPrompt();
        }
        continue;
      }
    }

    // 粘贴/大块输入结束：重设 scroll 到底
    if (str.length > 1) {
      scrollOffset = Math.max(0, totalInputLines() - visibleInputLines());
      redrawPrompt();
    }
  };

  process.stdin.on("data", onData);

  // ── 输入处理 ──
  async function handleInput(input) {
    // 内置命令
    if (input.startsWith("/")) {
      await handleCommand(input);
      drawFooter();
      return;
    }

    // 显示用户消息
    printUserMsg(input.length > 500 ? `[共 ${input.length} 个字符]` : input);
    resetMarkdownRenderer();
    resetThinkingState();

    abortController = new AbortController();

    try {
      for await (const event of runAgentLoop(input, {
        ...context,
        signal: abortController.signal
      })) {
        renderAgentEvent(event, mainProvider, auxProvider);
      }
    } catch (err) {
      process.stdout.write("   " + chalk.red("✗ ") + err.message + "\n\n");
    }

    abortController = null;
    drawFooter();
  }

  // ── 命令处理 ──
  async function handleCommand(input) {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case "/exit":
        process.stdin.setRawMode(wasRaw);
        process.stdin.removeListener("data", onData);
        process.exit(0);
        break;

      case "/help":
        printUserMsg(input);
        printAgentHelp();
        break;

      case "/clear":
        printUserMsg(input);
        process.stdout.write("\x1b[2J\x1b[H");
        printAgentHeader({
          mainLabel: mainProvider.label,
          auxLabel: auxProvider.label,
          mainModel,
          auxModel,
          projectName: composite.name,
          workingDir: workingDir || composite.workingDir
        });
        break;

      case "/todo":
        printUserMsg(input);
        const tl = composite.taskList || [];
        if (tl.length === 0) {
          process.stdout.write("   " + chalk.gray("任务清单为空\n\n"));
        } else {
          process.stdout.write("   " + chalk.bold("任务清单:\n"));
          for (const t of tl) {
            const icon = t.status === "completed" ? chalk.green("✓") :
                         t.status === "in_progress" ? chalk.yellow("▶") : chalk.gray("○");
            process.stdout.write(`     ${icon} ${t.content}\n`);
          }
          process.stdout.write("\n");
        }
        break;

      case "/aux": {
        const auxTask = input.slice(5).trim();
        if (!auxTask) {
          process.stdout.write("   " + chalk.yellow("用法: /aux <任务描述>\n\n"));
          return;
        }
        printUserMsg(`/aux ${auxTask}`);
        process.stdout.write("   " + chalk.magenta("[辅助AI] ") + chalk.gray("处理中...\n\n"));
        try {
          for await (const event of runAuxCall(auxTask, context)) {
            if (event.source === "aux") {
              if (event.kind === "thinking") {
                process.stdout.write(chalk.gray.dim(event.text));
              } else if (event.kind === "response" || event.type === "done") {
                process.stdout.write("   " + event.text + "\n\n");
              }
            }
            if (event.type === "error") {
              process.stdout.write("   " + chalk.red("✗ ") + event.text + "\n\n");
            }
          }
        } catch (err) {
          process.stdout.write("   " + chalk.red("✗ ") + err.message + "\n\n");
        }
        break;
      }

      case "/context":
        printUserMsg(input);
        const msgs = composite.messages || [];
        process.stdout.write(`   ${chalk.bold("复合对话")}: ${composite.name}\n`);
        process.stdout.write(`   ${chalk.gray("消息数")}: ${msgs.length}\n`);
        process.stdout.write(`   ${chalk.gray("主AI")}: ${mainProvider.label} (session: ${composite.main.sessionId ? "已创建" : "未创建"})\n`);
        process.stdout.write(`   ${chalk.gray("辅助AI")}: ${auxProvider.label} (session: ${composite.aux.sessionId ? "已创建" : "未创建"})\n\n`);
        break;

      default:
        printUserMsg(input);
        process.stdout.write("   " + chalk.red("✗ ") + `未知命令: ${cmd}  输入 /help 查看帮助\n\n`);
    }
  }
}

// ── Thinking 状态管理 ──

let thinkingBuf = "";
let thinkingActive = false;

function resetThinkingState() {
  thinkingBuf = "";
  thinkingActive = false;
}

/** 重绘最后 N 行 thinking 内容（原地刷新） */
function redrawThinkingTail(maxLines = 4) {
  if (!thinkingBuf) return;
  const lines = thinkingBuf.split("\n");
  const tail = lines.slice(-maxLines);
  // 上移以覆盖之前绘制的行
  process.stdout.write(`\x1b[${Math.max(0, tail.length)}A`);
  process.stdout.write("\x1b[J"); // 清到屏底
  for (const l of tail) {
    process.stdout.write(chalk.gray("   " + l) + "\n");
  }
  // 光标回到末尾行下方
}

/** 清除 thinking 显示 */
function clearThinkingDisplay() {
  if (!thinkingActive) return;
  // 清除最后绘制的 thinking 行
  const tailCount = Math.min(4, thinkingBuf.split("\n").length);
  process.stdout.write(`\x1b[${tailCount}A\x1b[J`);
  thinkingActive = false;
  thinkingBuf = "";
}

// ── 渲染 Agent 事件 ──

function renderAgentEvent(event, mainProvider, auxProvider) {
  switch (event.type) {
    case "thinking": {
      if (!thinkingActive) {
        printThinkingLabel();
        thinkingActive = true;
      }
      thinkingBuf += event.text;
      redrawThinkingTail(4);
      break;
    }

    case "response": {
      if (event.source === "aux") return;
      clearThinkingDisplay();
      renderMarkdown(event.text, true);
      break;
    }

    case "tool_start": {
      if (event.requiresApproval) {
        process.stdout.write("\n   " + chalk.yellow.bold("⚠ 需要确认:"));
        process.stdout.write("\n   " + chalk.yellow(JSON.stringify(event.toolResult, null, 2)));
        process.stdout.write("\n   " + chalk.gray("(审批功能开发中，已跳过此操作)\n\n"));
        return;
      }
      // shell 工具：显示命令
      if (event.toolName === "shell") {
        process.stdout.write("\n");
        // 命令本身不在这里显示，等 tool_result 一起显示
      }
      break;
    }

    case "tool_result": {
      renderToolResult(event.toolName, event.toolResult);
      break;
    }

    case "error": {
      process.stdout.write("\n   " + chalk.red("✗ ") + event.text + "\n\n");
      break;
    }

    case "done": {
      if (event.source === "aux") return;
      clearThinkingDisplay();
      if (event.text?.trim()) {
        renderMarkdown(event.text, true);
      }
      process.stdout.write("\n");
      break;
    }
  }
}

// ── 工具结果渲染 ──

function renderToolResult(toolName, result) {
  if (!result) { process.stdout.write("\n"); return; }

  switch (toolName) {
    case "shell":
      renderShellResult(result);
      break;

    case "file-read":
      renderFileReadResult(result);
      break;

    case "file-write":
      renderFileWriteResult(result);
      break;

    case "file-search":
      renderFileSearchResult(result);
      break;

    case "todo":
      renderTodoResult(result);
      break;

    default:
      process.stdout.write("   " + chalk.green("✓") + " " + chalk.gray(JSON.stringify(result).slice(0, 120)) + "\n\n");
  }
}

/** Shell 结果：命令(SHELL 同行) + 结果(后5行) */
function renderShellResult(result) {
  const success = result.success;
  const cmd = result.command || "";
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";

  // 截取命令显示（同行用）
  const cmdShort = cmd.replace(/\n/g, " ").slice(0, 120);

  // 结果取最后 5 行
  const output = stderr || stdout || "(无输出)";
  const outLines = output.split("\n");
  const tailLines = outLines.slice(-5);
  const tailDisplay = tailLines.join("\n").slice(0, 500);

  // 状态图标 + SHELL + 命令（同一行）
  const icon = success ? chalk.green(" ✓ ") : chalk.red(" ✗ ");
  process.stdout.write("   " + icon + chalk.bold("SHELL") + "  " + chalk.gray.dim("$ ") + chalk.gray.dim(cmdShort));

  // 结果另起一行
  if (tailDisplay) {
    process.stdout.write("\n   " + chalk.white(tailDisplay.replace(/\n/g, "\n   ")));
  }
  if (result.error && !stderr) {
    process.stdout.write("\n   " + chalk.red(result.error.slice(0, 200)));
  }
  process.stdout.write("\n\n");
}

/** 文件读取：只显示路径+行范围，不展示内容 */
function renderFileReadResult(result) {
  if (!result.success) {
    process.stdout.write("   " + chalk.red("✗") + " " + chalk.gray(result.error || "读取失败") + "\n\n");
    return;
  }

  const path = result.path || "";
  const offset = result.offset || 0;
  const lines = result.lines || 0;
  process.stdout.write("   " + chalk.green("✓") + chalk.bold(" FILE-READ") +
    "  " + chalk.gray(path) +
    "  " + chalk.dim(`(行 ${offset}-${offset + lines} / 共 ${result.totalLines || "?"} 行)`) + "\n\n");
}

/** 文件写入：显示内容，最多 50 行 */
function renderFileWriteResult(result) {
  if (!result.success) {
    process.stdout.write("   " + chalk.red("✗") + " " + chalk.gray(result.error || "写入失败") + "\n\n");
    return;
  }

  process.stdout.write("   " + chalk.green("✓") + chalk.bold(" FILE-WRITE") +
    "  " + chalk.gray(result.message || result.path || "") + "\n\n");
}

/** 文件搜索：显示匹配列表，最多 10 条 */
function renderFileSearchResult(result) {
  if (!result.success && result.error) {
    process.stdout.write("   " + chalk.red("✗") + " " + chalk.gray(result.error) + "\n\n");
    return;
  }

  const count = result.count || 0;
  process.stdout.write("   " + chalk.green("✓") + chalk.bold(" SEARCH") +
    "  " + chalk.gray(`${result.type}: ${result.pattern}`) +
    "  " + chalk.dim(`(${count} 个结果${result.truncated ? "，已截断" : ""})`) + "\n");

  if (result.type === "filename" && result.files) {
    for (const f of result.files.slice(0, 10)) {
      process.stdout.write(chalk.gray("   │ ") + f + "\n");
    }
    if (result.files.length > 10) {
      process.stdout.write(chalk.gray("   │ ") + chalk.dim(`… 还有 ${result.files.length - 10} 个`) + "\n");
    }
  }
  if (result.type === "content" && result.matches) {
    for (const m of result.matches.slice(0, 10)) {
      process.stdout.write(chalk.gray(`   │ ${m.file}:${m.line}`) + "  " + m.text.slice(0, 120) + "\n");
    }
    if (result.matches.length > 10) {
      process.stdout.write(chalk.gray("   │ ") + chalk.dim(`… 还有 ${result.matches.length - 10} 个`) + "\n");
    }
  }
  process.stdout.write("\n");
}

/** 任务清单：显示完整列表 */
function renderTodoResult(result) {
  if (result.action === "list") {
    const tasks = result.tasks || [];
    if (!tasks.length) {
      process.stdout.write("   " + chalk.gray("任务清单为空") + "\n\n");
    } else {
      process.stdout.write("   " + chalk.bold("TODO:") + "\n");
      for (const t of tasks) {
        const icon = t.status === "completed" ? chalk.green("✓") :
                     t.status === "in_progress" ? chalk.yellow("▶") : chalk.gray("○");
        process.stdout.write(`     ${icon} ${t.content}\n`);
      }
      process.stdout.write("\n");
    }
    return;
  }

  if (result.action === "update") {
    process.stdout.write("   " + chalk.green("✓") + chalk.bold(" TODO") +
      "  " + chalk.gray(result.message || "") + "\n");
    const tasks = result.tasks || [];
    for (const t of tasks) {
      const icon = t.status === "completed" ? chalk.green("✓") :
                   t.status === "in_progress" ? chalk.yellow("▶") : chalk.gray("○");
      process.stdout.write(`     ${icon} ${t.content}\n`);
    }
    process.stdout.write("\n");
    return;
  }

  process.stdout.write("\n");
}

// ═══════════════════════════════════════════════
//  Agent Header — CHAT2CLI logo + agent 信息
// ═══════════════════════════════════════════════

function printAgentHeader({ mainLabel, auxLabel, mainModel, auxModel, projectName, workingDir }) {
  const W = termWidth();
  const inner = W - 2;

  const logo = [
    "   ██████╗██╗  ██╗ █████╗ ████████╗   ██████╗     ██████╗██╗     ██╗ ",
    "  ██╔════╝██║  ██║██╔══██╗╚══██╔══╝   ╚════██╗   ██╔════╝██║     ██║ ",
    "  ██║     ███████║███████║   ██║       █████╔╝   ██║     ██║     ██║ ",
    "  ██║     ██╔══██║██╔══██║   ██║      ██╔═══╝    ██║     ██║     ██║ ",
    "  ╚██████╗██║  ██║██║  ██║   ██║      ███████╗   ╚██████╗███████╗██║ ",
    "   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝      ╚══════╝    ╚═════╝╚══════╝╚═╝ "
  ];

  const mainStr = `${mainLabel}  ${chalk.cyan(mainModel || "")}`;
  const auxStr  = `${auxLabel}  ${chalk.cyan(auxModel || "")}`;
  const projStr = `${projectName || "-"}`;

  // Build info rows
  const infoRows = [
    `  主AI: ${chalk.bold(mainStr)}`,
    `  辅助: ${chalk.bold(auxStr)}`,
    `  项目: ${chalk.bold(projStr)}  ${chalk.dim(workingDir || "")}`
  ];

  // Top border
  process.stdout.write("\n");
  process.stdout.write(chalk.cyan(BOX.tl + BOX.h.repeat(inner) + BOX.tr) + "\n");

  // Logo lines
  for (const line of logo) {
    const vw = visualWidth(line);
    const padL = Math.max(0, Math.floor((inner - vw) / 2));
    const padR = Math.max(0, inner - padL - vw);
    process.stdout.write(chalk.cyan(BOX.v) + " ".repeat(padL) + chalk.bold(line) + " ".repeat(padR) + chalk.cyan(BOX.v) + "\n");
  }

  // Empty gap
  process.stdout.write(chalk.cyan(BOX.v) + " ".repeat(inner) + chalk.cyan(BOX.v) + "\n");

  // Info rows
  for (const row of infoRows) {
    const rw = visualWidth(row);
    const padR = Math.max(0, inner - rw - 2); // left pad 2
    process.stdout.write(chalk.cyan(BOX.v) + "  " + row + " ".repeat(padR) + chalk.cyan(BOX.v) + "\n");
  }

  // Bottom border
  process.stdout.write(chalk.cyan(BOX.bl + BOX.h.repeat(inner) + BOX.br) + "\n\n");
}

function visualWidth(s) {
  let w = 0;
  // strip ANSI
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    if (cp == null) continue;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2329 && cp <= 0x232a) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f680 && cp <= 0x1f6ff) ||
      (cp >= 0x2600 && cp <= 0x26ff)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

// ── 帮助 ──

function printAgentHelp() {
  process.stdout.write(chalk.gray(`
  内置命令:
    /help          显示帮助
    /clear         清屏
    /exit          退出
    /todo          查看任务清单
    /context       查看当前对话上下文
    /aux <任务>    委托任务给辅助 AI

  快捷键:
    Ctrl+C         中断当前 agent 循环
    ↑↓             历史输入导航
    Ctrl+A/E       行首/行尾
    Ctrl+K/U       删除到行尾/行首

`) + "\n");
}
