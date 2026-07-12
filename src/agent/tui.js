import chalk from "chalk";
import { runAgentLoop, runAuxCall } from "./agent-loop.js";
import {
  printFooter, printUserMsg, BOX, termWidth
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

  // 计算当前输入占用的终端行数
  function inputLines() {
    const promptW = 4; // "   ❯ " = 4 chars
    let w = promptW;
    for (const ch of currentInput) w += charWidth(ch);
    const tw = termWidth();
    return Math.max(1, Math.ceil(w / tw));
  }

  function redrawPrompt() {
    const lines = inputLines();
    // 多行时先上移到首行
    if (lines > 1) {
      process.stdout.write(`\x1b[${lines - 1}A`);
    }
    process.stdout.write("\r   ❯ ");

    // 超过 300 字符时显示摘要
    if (currentInput.length > 300) {
      process.stdout.write(chalk.gray(`[共 ${currentInput.length} 个字符]`));
    } else {
      process.stdout.write(currentInput);
    }
    process.stdout.write("\x1b[0K");
    if (cursor < currentInput.length) {
      const left = Array.from(currentInput.slice(cursor));
      const cols = left.reduce((s, c) => s + charWidth(c), 0);
      if (cols > 0) process.stdout.write(`\x1b[${cols}D`);
    }
  }

  function clearFooter() {
    const lines = inputLines();
    process.stdout.write(`\x1b[${lines + 1}A\r\x1b[J`);
  }

  function drawFooter() {
    const lines = inputLines();
    printFooter();
    process.stdout.write(`\x1b[${lines + 1}A\r`);
    process.stdout.write("   ❯ ");
  }

  // 初始绘制
  drawFooter();

  // ── 按键处理 ──
  const onData = (buf) => {
    const str = buf.toString();

    // 粘贴检测：单次 data 事件超过 3 个字符视为粘贴
    const isPaste = str.length > 3;

    for (const ch of str) {
      const code = ch.charCodeAt(0);

      // Ctrl+C: 中断 agent 循环
      if (code === 3) {
        if (abortController) {
          abortController.abort();
          abortController = null;
          process.stdout.write("\n   " + chalk.yellow("⚠ 已中断，进入人工指导模式（输入指令或空行继续）") + "\n\n");
          currentInput = "";
          cursor = 0;
          drawFooter();
          return;
        }
        // 正常退出
        process.stdout.write("\n\n");
        process.stdin.setRawMode(wasRaw);
        process.stdin.removeListener("data", onData);
        process.exit(0);
        return;
      }

      // 退出: Ctrl+D 在空行
      if (code === 4 && !currentInput) {
        process.stdout.write("\n");
        process.stdin.setRawMode(wasRaw);
        process.stdin.removeListener("data", onData);
        return;
      }

      // Enter: 粘贴时忽略（避免 \r 截断），正常输入时发送
      if (code === 13) {
        if (isPaste) continue;
        clearFooter();
        const input = currentInput.trim();
        currentInput = "";
        cursor = 0;
        process.stdout.write("\r\x1b[J\n");

        if (input) {
          inputHistory.push(input);
          histIdx = -1;
          handleInput(input);
        } else {
          // 空行：如果在中断模式，恢复
          drawFooter();
        }
        return;
      }

      // Escape sequences
      if (code === 27) { escState = 1; continue; }
      if (escState === 1 && ch === "[") { escState = 2; continue; }

      if (escState === 2) {
        escState = 0;

        // Up arrow
        if (ch === "A") {
          if (inputHistory.length > 0 && histIdx < inputHistory.length - 1) {
            histIdx++;
            currentInput = inputHistory[inputHistory.length - 1 - histIdx];
            cursor = currentInput.length;
            redrawPrompt();
          }
          continue;
        }
        // Down arrow
        if (ch === "B") {
          if (histIdx > 0) {
            histIdx--;
            currentInput = inputHistory[inputHistory.length - 1 - histIdx];
            cursor = currentInput.length;
          } else if (histIdx === 0) {
            histIdx = -1;
            currentInput = "";
            cursor = 0;
          }
          redrawPrompt();
          continue;
        }
        // Left arrow
        if (ch === "D") {
          if (cursor > 0) cursor--;
          redrawPrompt();
          continue;
        }
        // Right arrow
        if (ch === "C") {
          if (cursor < currentInput.length) cursor++;
          redrawPrompt();
          continue;
        }
        // Home
        if (ch === "H") { cursor = 0; redrawPrompt(); continue; }
        // End
        if (ch === "F") { cursor = currentInput.length; redrawPrompt(); continue; }
        continue;
      }
      escState = 0;

      // Backspace
      if (code === 127) {
        if (cursor > 0) {
          const arr = Array.from(currentInput);
          arr.splice(cursor - 1, 1);
          currentInput = arr.join("");
          cursor--;
          redrawPrompt();
        }
        continue;
      }

      // Ctrl+K: 删除到行尾
      if (code === 11) {
        currentInput = Array.from(currentInput).slice(0, cursor).join("");
        redrawPrompt();
        continue;
      }

      // Ctrl+U: 删除到行首
      if (code === 21) {
        currentInput = Array.from(currentInput).slice(cursor).join("");
        cursor = 0;
        redrawPrompt();
        continue;
      }

      // Ctrl+A: 行首
      if (code === 1) { cursor = 0; redrawPrompt(); continue; }

      // Ctrl+E: 行尾
      if (code === 5) { cursor = currentInput.length; redrawPrompt(); continue; }

      // Tab: 忽略
      if (code === 9) continue;

      // 换行符：粘贴时插入空格，非粘贴时忽略
      if (code === 10) {
        if (isPaste) {
          const arr = Array.from(currentInput);
          arr.splice(cursor, 0, " ");
          currentInput = arr.join("");
          cursor++;
        }
        if (!isPaste) redrawPrompt();
        continue;
      }

      // 可打印字符（包含空格）
      if (code >= 32) {
        const arr = Array.from(currentInput);
        arr.splice(cursor, 0, ch);
        currentInput = arr.join("");
        cursor++;
        if (!isPaste) redrawPrompt();
        continue;
      }
    }

    // 粘贴结束后一次性重绘
    if (isPaste && currentInput.length > 0) {
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

    // 显示用户消息（超长则截断显示）
    if (input.length > 300) {
      process.stdout.write("   " + chalk.green("❯") + " " + chalk.gray(`[共 ${input.length} 个字符]`) + "\n");
    } else {
      printUserMsg(input);
    }
    resetMarkdownRenderer();

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

// ── 渲染 Agent 事件 ──

function renderAgentEvent(event, mainProvider, auxProvider) {
  switch (event.type) {
    case "thinking": {
      const text = (event.text || "").replace(/\n/g, "\n   ");
      process.stdout.write(chalk.gray("   " + text));
      break;
    }

    case "response": {
      if (event.source === "aux") return;
      const text = (event.text || "").replace(/\n/g, "\n   ");
      process.stdout.write("   " + chalk.white(text));
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
      if (event.text?.trim()) {
        process.stdout.write("   " + event.text.replace(/\n/g, "\n   ") + "\n\n");
      }
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
