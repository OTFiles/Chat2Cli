import chalk from "chalk";
import { runAgentLoop, runAuxCall } from "./agent-loop.js";
import {
  printFooter, printUserMsg, printThinkingLabel
} from "../utils/format.js";
import { renderMarkdown, resetMarkdownRenderer } from "../utils/markdown.js";

// ═══════════════════════════════════════════════
//  Agent TUI — 复用 chat.js 的 raw mode 输入模式
// ═══════════════════════════════════════════════

/**
 * 启动 Agent TUI 循环
 * @param {object} context - { mainProvider, auxProvider, composite, workingDir }
 */
export async function agentTui(context) {
  const { composite, mainProvider, auxProvider, workingDir } = context;

  // 显示头部
  printAgentHeader(mainProvider, auxProvider, composite);

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

  function redrawPrompt() {
    process.stdout.write("\r");
    process.stdout.write("   ❯ ");
    process.stdout.write(currentInput);
    process.stdout.write("\x1b[0K");
    if (cursor < currentInput.length) {
      const left = Array.from(currentInput.slice(cursor));
      const cols = left.reduce((s, c) => s + charWidth(c), 0);
      if (cols > 0) process.stdout.write(`\x1b[${cols}D`);
    }
  }

  function clearFooter() {
    process.stdout.write("\x1b[2A\r\x1b[J");
  }

  function drawFooter() {
    printFooter();
    process.stdout.write("\x1b[3A\r");
    process.stdout.write("   ❯ ");
  }

  // 初始绘制
  drawFooter();

  // ── 按键处理 ──
  const onData = (buf) => {
    const str = buf.toString();
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

      // Enter
      if (code === 13) {
        clearFooter();
        const input = currentInput.trim();
        if (input) {
          inputHistory.push(currentInput);
          histIdx = -1;
        }
        currentInput = "";
        cursor = 0;
        process.stdout.write("\r\x1b[J\n");

        if (input) {
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

      // 可打印字符
      if (code >= 32) {
        const arr = Array.from(currentInput);
        arr.splice(cursor, 0, ch);
        currentInput = arr.join("");
        cursor++;
        redrawPrompt();
      }
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

    printUserMsg(input);
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
        printAgentHeader(mainProvider, auxProvider, composite);
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
      if (event.source === "aux") return; // aux 事件单独处理
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
      process.stdout.write("\n   " + chalk.cyan.bold(event.text) + "\n");
      break;
    }

    case "tool_result": {
      const summary = summarizeToolResult(event.toolName, event.toolResult);
      process.stdout.write("   " + chalk.green("✓ ") + chalk.gray(summary) + "\n\n");
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

/** 工具结果摘要 */
function summarizeToolResult(toolName, result) {
  if (!result) return "";
  switch (toolName) {
    case "shell":
      return result.success
        ? `命令执行成功 (${(result.stdout || "").length} 字符输出)`
        : `命令执行失败: ${result.error || ""}`;
    case "file-read":
      return result.success
        ? `读取 ${result.path} (行 ${result.offset}-${result.offset + result.lines})`
        : result.error || "";
    case "file-write":
      return result.success
        ? result.message || `文件已写入: ${result.path}`
        : result.error || "";
    case "file-search":
      return `找到 ${result.count} 个结果`;
    case "todo":
      return result.message || `任务清单 ${result.tasks?.length || 0} 项`;
    default:
      return JSON.stringify(result).slice(0, 100);
  }
}

// ── 头部和帮助 ──

function printAgentHeader(mainProvider, auxProvider, composite) {
  process.stdout.write("\n" + chalk.bold.cyan("  ╭── Agent 模式 ──────────────────────") + "\n");
  process.stdout.write("  │" + chalk.gray(`  主AI: ${mainProvider.label}`) + "\n");
  process.stdout.write("  │" + chalk.gray(`  辅助: ${auxProvider.label}`) + "\n");
  process.stdout.write("  │" + chalk.gray(`  项目: ${composite.name}`) + "\n");
  process.stdout.write("  │" + chalk.gray(`  目录: ${composite.workingDir || process.cwd()}`) + "\n");
  process.stdout.write("  ╰" + "─".repeat(38) + "\n\n");
}

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
