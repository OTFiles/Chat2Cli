import chalk from "chalk";
import { runAgentLoop, runAuxCall } from "./agent-loop.js";
import {
  printUserMsg, printThinkingLabel, BOX, termWidth,
  USER_MSG_BG
} from "../utils/format.js";

const TOOL_BG = chalk.bgRgb(0, 45, 5);
import { renderMarkdown, resetMarkdownRenderer } from "../utils/markdown.js";

// ═══════════════════════════════════════════════
//  Agent TUI — 复用 chat.js 的 raw mode 输入模式
// ═══════════════════════════════════════════════

/**
 * 启动 Agent TUI 循环
 * @param {object} context - { mainProvider, auxProvider, composite, workingDir, mainModel, auxModel }
 */
export async function agentTui(context) {
  const { composite, mainProvider, auxProvider, workingDir, mainModel, auxModel,
    hooks, extTuiCommands = [] } = context;

  // 显示头部（含 CHAT2CLI logo）
  printAgentHeader({
    mainLabel: mainProvider.label,
    auxLabel: auxProvider.label,
    mainModel,
    auxModel,
    projectName: composite.name,
    workingDir: workingDir || composite.workingDir
  });

  // ── 回显已有对话历史 ──
  if (composite.messages && composite.messages.length > 0) {
    for (const msg of composite.messages) {
      if (msg.role === "user") {
        printUserMsg(msg.content.length > 500 ? `[共 ${msg.content.length} 个字符]` : msg.content);
      } else if (msg.role === "assistant") {
        // 显示思考内容
        if (msg.thinking) {
          const t = msg.thinking.replace(/\n/g, "\n   ");
          process.stdout.write(chalk.gray("   " + t) + "\n");
        }
        // 显示正文
        if (msg.content) {
          const rendered = renderMarkdown(msg.content, true);
          if (rendered) process.stdout.write(rendered + "\n");
        }
        process.stdout.write("\n");
      } else if (msg.role === "tool") {
        // 工具结果
        renderToolResult(msg.toolName, msg.toolResult);
      }
    }
    resetMarkdownRenderer();
  }

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
  // 工作状态（Agent 执行中禁止输入）
  let agentWorking = false;

  function charWidth(c) {
    return (c.charCodeAt(0) > 127) ? 2 : 1;
  }

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


  // 输入文本的终端行数
  const PW = 6; // "   ❯ " 视觉宽度（❯ = 双列宽）
  const PROMPT = "   ❯ ";
  const CONT   = "      "; // 续行前缀，与 PROMPT 等宽
  const CONT_CHAT = "    "; // chat 模式用（> 是单列宽）


  function totalInputLines() {
    let textW = 0;
    // 标记 [paste:N] 全部为 ASCII，视觉宽度 = 字符串长度
    const re = /\[paste:\d+\]/g;
    let lastIdx = 0, m;
    while ((m = re.exec(currentInput)) !== null) {
      for (let i = lastIdx; i < m.index; i++) textW += charWidth(currentInput[i]);
      textW += m[0].length;
      lastIdx = m.index + m[0].length;
    }
    for (let i = lastIdx; i < currentInput.length; i++) textW += charWidth(currentInput[i]);
    const avail = termWidth() - PW;
    if (avail <= 0) return 1;
    return Math.max(1, Math.ceil(textW / avail));
  }

  // 可见区域：最多显示 5 行，超出则滚动
  let maxVisible = 5;
  let scrollOffset = 0; // 已滚出屏幕顶部的行数
  let footerVis = 1;    // 当前 footer 绘制时用的可见行数

  function visibleInputLines() {
    return Math.max(1, Math.min(totalInputLines(), maxVisible));
  }

  /** 构建折行信息（标记原子化），供 redrawPrompt 和 ↑↓ handler 复用 */
  function getLineInfo() {
    const allChars = [...currentInput];
    const tw = Math.max(1, termWidth() - PW);
    const wrapLines = [];
    let line = "", lineW = 0, i = 0;
    while (i < allChars.length) {
      const remaining = allChars.slice(i).join("");
      const mm = remaining.match(/^\[paste:(\d+)\]/);
      if (mm) {
        const marker = mm[0];
        const mw = marker.length; // 全部 ASCII，视觉宽度 = 长度
        if (lineW + mw > tw && line.length > 0) {
          wrapLines.push(line); line = ""; lineW = 0;
        }
        line += marker; lineW += mw;
        i += marker.length;
        continue;
      }
      const ch = allChars[i];
      const cw = charWidth(ch);
      if (lineW + cw > tw && line.length > 0) {
        wrapLines.push(line); line = ""; lineW = 0;
      }
      line += ch; lineW += cw;
      i++;
    }
    wrapLines.push(line);

    let cursorLine = 0, charCount = 0;
    for (let j = 0; j < wrapLines.length; j++) {
      const len = Array.from(wrapLines[j]).length;
      if (charCount + len >= cursor) { cursorLine = j; break; }
      charCount += len;
      if (j === wrapLines.length - 1) cursorLine = j;
    }

    return { wrapLines, cursorLine, charCount };
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
    // 以当前 footer 高度 + 1 行删到当前下两行
    process.stdout.write(`\x1b[${footerVis + 1}A`);
    process.stdout.write(`\x1b[${footerVis + 3}M`);
  }

  function redrawPrompt() {
    const newVis = visibleInputLines();

    // 如果可见行数变了，需要重绘 footer（边框也会变）
    if (newVis !== footerVis) {
      // 先回到输入区顶部，再上移一行覆盖旧上边框，然后清除
      if (cursorRelLine > 0) process.stdout.write(`\x1b[${cursorRelLine}A`);
      process.stdout.write("\r");
      process.stdout.write(`\x1b[1A`);   // 上移到旧上边框行
      process.stdout.write(`\x1b[J`);    // 从旧上边框开始清除到底部
      footerVis = newVis;
      // 根据新输入尺寸 clamp scrollOffset，避免边框显示过期的溢出指示器
      const maxOff = Math.max(0, totalInputLines() - newVis);
      if (scrollOffset > maxOff) scrollOffset = maxOff;
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
      // 回到输入区顶部，始终重绘边框（溢出状态可能已改变）
      moveToTop();
      const W = termWidth();
      // prompt → top border: up 1
      process.stdout.write(`\x1b[1A\r`);
      _drawBorder(W, 0);
      // top border → bottom border: down vis (现在在 prompt 行，再往下 vis 行到 bottom border)
      process.stdout.write(`\x1b[${newVis}E\r`);
      _drawBorder(W, 1);
      // bottom border → prompt: up (vis + 1)，因为 _drawBorder 末尾的 \n 让光标在 help 行
      process.stdout.write(`\x1b[${newVis + 1}A\r`);
    }

    const vis = newVis;
    const tw = Math.max(1, termWidth() - PW);       // 折行宽度
    const safeW = Math.max(0, tw); // 折行已保证每行 ≤ tw，无需再 -1

    // 正常模式：按视觉宽度折行
    {
      const { wrapLines, cursorLine, charCount } = getLineInfo();

      // 自动调整 scrollOffset 使光标可见
      const maxOff = Math.max(0, wrapLines.length - vis);
      if (scrollOffset > maxOff) scrollOffset = maxOff;
      if (scrollOffset < 0) scrollOffset = 0;
      if (cursorLine < scrollOffset) scrollOffset = cursorLine;
      else if (cursorLine >= scrollOffset + vis) scrollOffset = cursorLine - vis + 1;
      scrollOffset = Math.max(0, Math.min(scrollOffset, maxOff));

      const visible = wrapLines.slice(scrollOffset, scrollOffset + vis);

      for (let i = 0; i < vis; i++) {
        if (i < visible.length) {
          const pre = (i === 0 && scrollOffset === 0) ? PROMPT : CONT;
          process.stdout.write("\r\x1b[K" + pre + truncateByVisualWidth(visible[i], safeW) + "\n");
        } else {
          process.stdout.write("\r\x1b[K\n");
        }
      }
      process.stdout.write(`\x1b[${vis}A`);

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
  //  粘贴标记存储
  // ═══════════════════════════════════════════════

  let lastDataTime = 0;

  // 粘贴存储：键值对 { id: 内容 }，标记 [paste:id] 代替全量文本
  const pasteStore = {};
  let nextPasteId = 1;

  /** 在当前位置插入粘贴标记 */
  function insertPasteMarker(text) {
    const id = nextPasteId++;
    pasteStore[id] = text;
    const marker = `[paste:${id}]`;
    const arr = Array.from(currentInput);
    arr.splice(cursor, 0, ...marker);
    currentInput = arr.join("");
    cursor += marker.length;
  }

  /** 找出 cursor 所在标记（如有），返回 { id, start, end } 或 null */
  function markerAt(pos) {
    const re = /\[paste:(\d+)\]/g;
    let m;
    while ((m = re.exec(currentInput)) !== null) {
      const start = m.index, end = m.index + m[0].length;
      if (pos > start && pos <= end) return { id: +m[1], start, end };
    }
    return null;
  }

  /** 展开所有标记，用于发送 */
  function expandMarkers(s) {
    return s.replace(/\[paste:(\d+)\]/g, (_, id) => pasteStore[id] || `[paste:${id}]`);
  }

  // ── 按键处理 ──
  const onData = (buf) => {
    const now = Date.now();
    const str = buf.toString();

    // ── 工作状态：仅允许 Ctrl+C 中断 ──
    if (agentWorking) {
      if (buf.length === 1 && buf[0] === 3) {
        if (abortController) {
          abortController.abort();
          abortController = null;
          currentInput = ""; cursor = 0; scrollOffset = 0;
        }
      }
      return;
    }

    // 粘贴检测：终端的 raw mode 单次 read 不会超过 ~9 字节的打字
    if (buf.length > 20) {
      insertPasteMarker(str);
      redrawPrompt();
      lastDataTime = now;
      return; // 粘贴作为原子标记插入，跳过逐字循环
    }
    lastDataTime = now;

    for (const ch of str) {
      const code = ch.charCodeAt(0);

      // Ctrl+C
      if (code === 3) {
        if (abortController) {
          abortController.abort();
          abortController = null;
          currentInput = ""; cursor = 0; scrollOffset = 0;
          // handleInput 完成后会自动调用 drawFooter() 并渲染中断消息
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

      // Enter：展开标记后发送
      if (code === 13) {
        clearFooter();
        const raw = currentInput.trim();
        const input = expandMarkers(raw);
        // 清理粘贴存储
        for (const k of Object.keys(pasteStore)) delete pasteStore[k];
        nextPasteId = 1;
        currentInput = ""; cursor = 0;
        process.stdout.write("\r\x1b[J\n");
        if (input) {
          // 历史存原始文本（含标记），导航时标记作为普通文本显示
          inputHistory.push(raw); histIdx = -1;
          handleInput(input);
        } else {
          drawFooter();
        }
        return;
      }

      // Ctrl+U/K：清空输入
      if (code === 21 || code === 11) {
        for (const k of Object.keys(pasteStore)) delete pasteStore[k];
        nextPasteId = 1;
      }

      // Escape
      if (code === 27) { escState = 1; continue; }
      if (escState === 1 && ch === "[") { escState = 2; continue; }

      if (escState === 2) {
        escState = 0;
        if (ch === "A") {
          // ↑ 键：三级逻辑 — 1) 滚视口  2) 移光标  3) 历史
          const { wrapLines, cursorLine, charCount } = getLineInfo();
          const total = wrapLines.length;
          const visLine = cursorLine - scrollOffset;
          const scrollable = total > maxVisible;
          const isHandleRow = scrollable && visLine === 2;

          if (isHandleRow && scrollOffset > 0) {
            scrollOffset--;
          } else if (cursorLine > 0) {
            const colInLine = cursor - charCount;
            const prevLine = wrapLines[cursorLine - 1];
            const prevLen = Array.from(prevLine).length;
            const newCol = Math.min(colInLine, prevLen);
            const prevCharCount = charCount - Array.from(wrapLines[cursorLine - 1]).length;
            cursor = prevCharCount + newCol;
          } else if (scrollOffset > 0) {
            scrollOffset--;
          } else if (inputHistory.length > 0 && histIdx < inputHistory.length - 1) {
            for (const k of Object.keys(pasteStore)) delete pasteStore[k];
            nextPasteId = 1;
            histIdx++;
            currentInput = inputHistory[inputHistory.length - 1 - histIdx];
            cursor = currentInput.length; scrollOffset = 0;
          }
          redrawPrompt();
          continue;
        }
        if (ch === "B") {
          // ↓ 键
          const { wrapLines: wl, cursorLine: cl, charCount: cc } = getLineInfo();
          const total = wl.length;
          const visLine = cl - scrollOffset;
          const scrollable = total > maxVisible;
          const isHandleRow = scrollable && visLine === 2;
          const maxOff = Math.max(0, total - visibleInputLines());

          if (isHandleRow && scrollOffset < maxOff) {
            scrollOffset++;
          } else if (cl < total - 1) {
            const colInLine = cursor - cc;
            const nextLine = wl[cl + 1];
            const nextLen = Array.from(nextLine).length;
            const newCol = Math.min(colInLine, nextLen);
            const nextCharCount = cc + Array.from(wl[cl]).length;
            cursor = nextCharCount + newCol;
          } else if (scrollOffset < maxOff) {
            scrollOffset++;
          } else if (histIdx > 0) {
            for (const k of Object.keys(pasteStore)) delete pasteStore[k];
            nextPasteId = 1;
            histIdx--; currentInput = inputHistory[inputHistory.length - 1 - histIdx];
            cursor = currentInput.length; scrollOffset = 0;
          } else if (histIdx === 0) {
            for (const k of Object.keys(pasteStore)) delete pasteStore[k];
            nextPasteId = 1;
            histIdx = -1; currentInput = ""; cursor = 0; scrollOffset = 0;
          }
          redrawPrompt();
          continue;
        }
        // ←→：跳过标记
        if (ch === "D") {
          if (cursor > 0) {
            const m = markerAt(cursor);
            cursor--;
            if (m && cursor === m.start) cursor = m.end; // 从标记内跳到标记尾
          }
          redrawPrompt(); continue;
        }
        if (ch === "C") {
          if (cursor < currentInput.length) {
            const m = markerAt(cursor + 1);
            if (m && cursor === m.start) cursor = m.end;
            else cursor++;
          }
          redrawPrompt(); continue;
        }
        if (ch === "H") { cursor = 0; redrawPrompt(); continue; }
        if (ch === "F") { cursor = currentInput.length; redrawPrompt(); continue; }
        continue;
      }
      escState = 0;

      // Backspace：标记内 → 整块删除；否则单字符删除
      if (code === 127) {
        if (cursor > 0) {
          const m = markerAt(cursor);
          if (m) {
            // 删除整个标记
            const arr = Array.from(currentInput);
            arr.splice(m.start, m.end - m.start);
            currentInput = arr.join("");
            cursor = m.start;
            delete pasteStore[m.id];
            redrawPrompt();
            continue;
          }
          // 普通单字删除
          const arr = Array.from(currentInput);
          arr.splice(cursor - 1, 1);
          currentInput = arr.join(""); cursor--;
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

      // \n：普通换行（不再区分 burst）
      if (code === 10) {
        const arr = Array.from(currentInput); arr.splice(cursor, 0, " ");
        currentInput = arr.join(""); cursor++;
        redrawPrompt();
        continue;
      }

      // 可打印字符
      if (code >= 32) {
        const arr = Array.from(currentInput); arr.splice(cursor, 0, ch);
        currentInput = arr.join(""); cursor++;
        redrawPrompt();
        continue;
      }
    }
  };

  process.stdin.on("data", onData);

  // 崩溃恢复：确保 raw mode 被正确还原
  const cleanup = () => {
    try { process.stdin.setRawMode(wasRaw); } catch {}
    process.stdin.removeListener("data", onData);
    process.stdout.write("\r\x1b[J\n");
  };
  process.on("uncaughtException", (err) => {
    cleanup();
    console.error("FATAL:", err.message);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    cleanup();
    console.error("FATAL:", reason?.message || reason);
    process.exit(1);
  });

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

    // 中止可能仍在运行的旧循环
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();

    // 进入工作状态：锁定输入
    agentWorking = true;

    try {
      for await (const event of runAgentLoop(input, {
        ...context,
        hooks,
        signal: abortController.signal
      })) {
        renderAgentEvent(event, mainProvider, auxProvider);
      }
    } catch (err) {
      process.stdout.write("   " + chalk.red("✗ ") + err.message + "\n\n");
    }

    // 退出工作状态
    agentWorking = false;
    abortController = null;
    drawFooter();
  }

  // ── 命令处理 ──
  async function handleCommand(input) {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    // 先查扩展 TUI 命令
    for (const extCmd of extTuiCommands) {
      const extName = "/" + (extCmd.name || "");
      if (cmd === extName.toLowerCase()) {
        printUserMsg(input);
        try {
          const args = input.slice(extName.length).trim();
          await extCmd.handler(args, { composite, workingDir, mainProvider, auxProvider });
        } catch (err) {
          process.stdout.write("   " + chalk.red("✗ ") + err.message + "\n\n");
        }
        return;
      }
    }

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
              if (event.type === "thinking") {
                process.stdout.write(chalk.gray.dim(event.text));
              } else if (event.type === "response" || event.type === "done") {
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

// ── Thinking 状态管理（参照 chat.js：简单追加，不用 ANSI 重绘）──

let thinkingBuf = "";
let thinkingActive = false;
let thinkingFirstChunk = false;

// ── Response 行缓冲（参照 chat.js：逐完整行渲染 markdown）──

let responseLineBuf = "";

function flushResponseLines() {
  if (!responseLineBuf) return;
  const lines = responseLineBuf.split("\n");
  responseLineBuf = lines.pop() || "";  // 最后不完整行保留
  for (const line of lines) {
    const rendered = renderMarkdown(line, true);
    if (rendered) process.stdout.write(rendered + "\n");
  }
}

function flushResponseRemaining() {
  if (responseLineBuf) {
    const rendered = renderMarkdown(responseLineBuf, true);
    if (rendered) process.stdout.write(rendered + "\n");
    responseLineBuf = "";
  }
}

function resetThinkingState() {
  thinkingBuf = "";
  thinkingActive = false;
  thinkingFirstChunk = false;
  responseLineBuf = "";
}

// ── 渲染 Agent 事件 ──

function renderAgentEvent(event, mainProvider, auxProvider) {
  switch (event.type || event.kind) {
    case "thinking": {
      if (!thinkingActive) {
        printThinkingLabel();
        thinkingActive = true;
        thinkingFirstChunk = true;
      }
      thinkingBuf += event.text;
      // 简单逐字追加灰度文本
      let t = event.text;
      if (thinkingFirstChunk) {
        t = "   " + t;       // 首段缩进
        thinkingFirstChunk = false;
      }
      t = t.replace(/\n/g, "\n   ");  // 换行保持缩进
      process.stdout.write(chalk.gray(t));
      break;
    }

    case "response": {
      if (event.source === "aux") return;
      if (thinkingActive) {
        // thinking→response 切换：立即换行，让用户看到响应开始了
        process.stdout.write("\n");
        thinkingActive = false;
      }
      // 行缓冲：积累到完整行再渲染（参照 chat.js）
      responseLineBuf += event.text;
      flushResponseLines();
      break;
    }

    case "tool_start": {
      flushResponseLines();
      flushResponseRemaining();
      if (event.requiresApproval) {
        process.stdout.write("\n   " + chalk.yellow.bold("⚠ 需要确认:"));
        process.stdout.write("\n   " + chalk.yellow(JSON.stringify(event.toolResult, null, 2)));
        process.stdout.write("\n   " + chalk.gray("(审批功能开发中，操作将继续运行)\n\n"));
        return;
      }
      // 3 行绿色背景块：空白行 + 标签行 + 空白行
      const W = termWidth();
      const fill = " ".repeat(W);
      const label = toolLabel(event.toolName, event.toolParams);
      const prefix = "   " + chalk.dim(label);
      const pad = Math.max(0, W - 3 - visualWidth(label));
      process.stdout.write("\n" + TOOL_BG(fill) + "\n");
      process.stdout.write(TOOL_BG(prefix + " ".repeat(pad)) + "\n");
      process.stdout.write(TOOL_BG(fill) + "\n");
      break;
    }

    case "tool_result": {
      // 覆盖 tool_start 的 3 行绿色背景块
      process.stdout.write("\x1b[3A\r\x1b[J");
      const W = termWidth();
      const fill = " ".repeat(W);
      const doneLabel = toolDoneLabel(event.toolName, event.toolResult);
      const doneClean = doneLabel.replace(/\x1b\[[0-9;]*m/g, "");
      const pad = Math.max(0, W - 3 - visualWidth(doneClean));
      process.stdout.write(TOOL_BG(fill) + "\n");
      process.stdout.write(TOOL_BG("   " + doneLabel + " ".repeat(pad)) + "\n");
      renderToolResultLines(event.toolName, event.toolResult, true);
      process.stdout.write(TOOL_BG(fill) + "\n\n");
      break;
    }

    case "error": {
      flushResponseLines();
      flushResponseRemaining();
      process.stdout.write("\n   " + chalk.red("✗ ") + event.text + "\n\n");
      break;
    }

    case "info": {
      flushResponseLines();
      flushResponseRemaining();
      process.stdout.write("\n   " + chalk.cyan("ℹ ") + event.text + "\n\n");
      break;
    }

    case "done": {
      if (event.source === "aux") return;
      thinkingActive = false;
      flushResponseRemaining();
      process.stdout.write("\n");
      break;
    }
  }
}

// ── 工具结果渲染 ──

/** 工具调用中标签（灰色） */
function toolLabel(toolName, params) {
  switch (toolName) {
    case "shell":
      return `SHELL: ${params?.command || "..."}`;
    case "file-read":
      return `FILE-READ: ${params?.path || "..."}`;
    case "file-write":
      return `FILE-WRITE: ${params?.path || "..."}`;
    case "file-search":
      return `SEARCH: ${params?.pattern || "..."}`;
    default:
      return `${toolName}`;
  }
}

/** 工具完成标签（绿色勾） */
function toolDoneLabel(toolName, result) {
  const prefix = chalk.green("✓ ");
  switch (toolName) {
    case "shell":
      return prefix + chalk.bold("SHELL: ") + chalk.white(result?.command || "");
    case "file-read":
      return prefix + chalk.bold("FILE-READ: ") + chalk.gray(result?.path || "");
    case "file-write":
      return prefix + chalk.bold("FILE-WRITE: ") + chalk.gray(result?.message || result?.path || "");
    case "file-search":
      return prefix + chalk.bold("SEARCH: ") + chalk.gray(`${result?.type}: ${result?.pattern}`);
    default:
      return prefix + toolName;
  }
}

/** 渲染工具结果内容（不含标签，标签已在 tool_result case 中输出）。useBg=true 时每行包裹 TOOL_BG 全宽背景 */
function renderToolResultLines(toolName, result, useBg) {
  if (!result) return;
  const W = termWidth();
  const wrapBg = (s) => {
    if (!useBg) return s;
    const clean = s.replace(/\x1b\[[0-9;]*m/g, "");
    const padW = Math.max(0, W - visualWidth(clean));
    return TOOL_BG(s + " ".repeat(padW));
  };
  const out = (s) => process.stdout.write(wrapBg(s) + "\n");

  switch (toolName) {
    case "shell": {
      const output = result.stderr || result.stdout || "(无输出)";
      const lines = output.split("\n");
      for (const line of lines) {
        out("   " + (result.stderr ? chalk.red(line) : chalk.white(line)));
      }
      if (result.error && !result.stderr) {
        out("   " + chalk.red(result.error.slice(0, 200)));
      }
      break;
    }
    case "file-read": {
      if (!result.success) {
        out("   " + chalk.red(result.error || "读取失败"));
      } else {
        out("   " + chalk.dim(`(行 ${result.offset || 0}-${(result.offset || 0) + (result.lines || 0)} / 共 ${result.totalLines || "?"} 行)`));
      }
      break;
    }
    case "file-write": {
      if (!result.success) {
        out("   " + chalk.red(result.error || "写入失败"));
      }
      break;
    }
    case "file-search": {
      if (result.error) {
        out("   " + chalk.red(result.error));
        return;
      }
      out("   " + chalk.dim(`(${result.count || 0} 个结果${result.truncated ? "，已截断" : ""})`));
      if (result.type === "filename" && result.files) {
        for (const f of result.files.slice(0, 10)) {
          out(chalk.gray("   │ ") + f);
        }
        if (result.files.length > 10) {
          out(chalk.gray("   │ ") + chalk.dim(`… 还有 ${result.files.length - 10} 个`));
        }
      }
      if (result.type === "content" && result.matches) {
        for (const m of result.matches.slice(0, 10)) {
          out(chalk.gray(`   │ ${m.file}:${m.line}`) + "  " + m.text.slice(0, 120));
        }
        if (result.matches.length > 10) {
          out(chalk.gray("   │ ") + chalk.dim(`… 还有 ${result.matches.length - 10} 个`));
        }
      }
      break;
    }
    case "todo": {
      const tasks = result.tasks || [];
      if (tasks.length) {
        for (const t of tasks) {
          const icon = t.status === "completed" ? chalk.green("✓") :
                       t.status === "in_progress" ? chalk.yellow("▶") : chalk.gray("○");
          out(`     ${icon} ${t.content}`);
        }
      }
      break;
    }
    default:
      out("   " + chalk.gray(JSON.stringify(result).slice(0, 120)));
  }
  process.stdout.write("\n");
}

// ── 旧渲染函数（echoMessages 复用）──

function renderToolResult(toolName, result) {
  if (!result) return;
  // echo 时仍用旧格式
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

/** Shell 结果：✓ SHELL: cmd + 直接输出 */
function renderShellResult(result) {
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const output = stderr || stdout || "(无输出)";

  process.stdout.write("   " + toolDoneLabel("shell", result) + "\n");
  if (output) {
    const lines = output.split("\n");
    for (const line of lines) {
      process.stdout.write("   " + (stderr ? chalk.red(line) : chalk.white(line)) + "\n");
    }
  }
  if (result.error && !stderr) {
    process.stdout.write("   " + chalk.red(result.error.slice(0, 200)) + "\n");
  }
}

/** 文件读取：只显示路径+行范围 */
function renderFileReadResult(result) {
  if (!result.success) {
    process.stdout.write("   " + chalk.red("✗ FILE-READ: ") + chalk.gray(result.error || "读取失败") + "\n");
    return;
  }
  process.stdout.write("   " + toolDoneLabel("file-read", result) +
    "  " + chalk.dim(`(行 ${result.offset || 0}-${(result.offset || 0) + (result.lines || 0)} / 共 ${result.totalLines || "?"} 行)`) + "\n");
}

/** 文件写入 */
function renderFileWriteResult(result) {
  if (!result.success) {
    process.stdout.write("   " + chalk.red("✗ FILE-WRITE: ") + chalk.gray(result.error || "写入失败") + "\n");
    return;
  }
  process.stdout.write("   " + toolDoneLabel("file-write", result) + "\n");
}

/** 文件搜索 */
function renderFileSearchResult(result) {
  if (!result.success && result.error) {
    process.stdout.write("   " + chalk.red("✗ SEARCH: ") + chalk.gray(result.error) + "\n");
    return;
  }
  process.stdout.write("   " + toolDoneLabel("file-search", result) +
    "  " + chalk.dim(`(${result.count || 0} 个结果${result.truncated ? "，已截断" : ""})`) + "\n");
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
  // 扩展 TUI 命令的列表行
  const extLines = extTuiCommands.length > 0
    ? extTuiCommands.map((c) => `    /${c.name.padEnd(14)} ${c.description || ""}`).join("\n")
    : "    (无)";

  process.stdout.write(chalk.gray(`
  内置命令:
    /help          显示帮助
    /clear         清屏
    /exit          退出
    /todo          查看任务清单
    /context       查看当前对话上下文
    /aux <任务>    委托任务给辅助 AI

  扩展命令:
${extLines}

  快捷键:
    Ctrl+C         中断当前 agent 循环
    ↑↓             历史输入导航
    Ctrl+A/E       行首/行尾
    Ctrl+K/U       删除到行尾/行首

`) + "\n");
}
