import chalk from "chalk";

// ── 用户消息背景色：深色底 + 绿色 ──
export const USER_MSG_BG = chalk.bgRgb(0, 55, 10);

// ── Box drawing ──

export const BOX = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│", vl: "├", vr: "┤"
};

export function termWidth() {
  return process.stdout.columns || 80;
}

/** 返回字符的终端显示宽度（全角/CJK/emoji = 2，半角 = 1） */
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp == null) return 0;
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
    (cp >= 0x1f300 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

// ── Visual width helper ──

function visualWidth(s) {
  const clean = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of clean) w += charWidth(ch);
  return w;
}

// ── Date formatting ──

export function formatDate(isoString) {
  try {
    return new Date(isoString).toLocaleString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  } catch {
    return isoString;
  }
}

export function formatLatency(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function truncate(text, maxLen = 40) {
  if (!text) return "";
  const cleaned = text.replace(/\n/g, " ").trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 3) + "..." : cleaned;
}

// ── Print helpers ──

export function printSuccess(msg) {
  process.stdout.write(chalk.green("✓ ") + msg + "\n");
}

export function printError(msg) {
  process.stdout.write(chalk.red("✗ ") + msg + "\n");
}

export function printInfo(msg) {
  process.stdout.write(chalk.blue("ℹ ") + msg + "\n");
}

export function printWarn(msg) {
  process.stdout.write(chalk.yellow("⚠ ") + msg + "\n");
}

export function printAiContent(text, isThinking) {
  process.stdout.write(isThinking ? chalk.gray(text) : chalk.white(text));
}

// ── Table ──

export function printTable(headers, rows) {
  if (!rows.length) {
    printInfo("暂无记录。");
    return;
  }
  const colWidths = headers.map((h, i) => {
    const maxData = rows.reduce((max, row) => Math.max(max, String(row[i] || "").length), 0);
    return Math.max(h.length, maxData);
  });
  const sep = "─".repeat(colWidths.reduce((s, w) => s + w + 3, 1));
  const hl = "│ " + headers.map((h, i) => chalk.bold(h.padEnd(colWidths[i]))).join(" │ ") + " │";
  process.stdout.write("┌" + sep.slice(1) + "┐\n");
  process.stdout.write(hl + "\n");
  process.stdout.write("├" + sep.slice(1) + "┤\n");
  for (const row of rows) {
    const line = "│ " + row.map((cell, i) => String(cell || "").padEnd(colWidths[i])).join(" │ ") + " │";
    process.stdout.write(line + "\n");
  }
  process.stdout.write("└" + sep.slice(1) + "┘\n");
}

// ── Help ──

export function printHelp() {
  process.stdout.write("\n");
  process.stdout.write(chalk.bold("对话模式可用命令:") + "\n");
  process.stdout.write("  " + chalk.cyan("/exit") + "    保存并退出对话\n");
  process.stdout.write("  " + chalk.cyan("/switch") + "  列出历史对话，输入 /conv <序号> 切换\n");
  process.stdout.write("  " + chalk.cyan("/clear") + "   清空当前上下文\n");
  process.stdout.write("  " + chalk.cyan("/model") + "   切换模型 (例: /model qwen-max)\n");
  process.stdout.write("  " + chalk.cyan("/models") + "  列出可用模型\n");
  process.stdout.write("  " + chalk.cyan("/config") + "  查看/修改聊天参数 (thinking, search, keep on|off)\n");
  process.stdout.write("  " + chalk.cyan("/help") + "    显示此帮助\n");
  process.stdout.write("\n");
}

// ── Chat header ──

export function printChatHeader(providerLabel, model, sessionLabel) {
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

  const info = `  Chat 2 CLI  v1.0 [${chalk.cyan("服务商:")} ${chalk.bold(providerLabel)}] [${chalk.cyan("模型:")} ${chalk.bold(model)}] [${chalk.cyan("Session:")} ${chalk.dim(sessionLabel)}]`;

  // Draw top border
  process.stdout.write("\n");
  process.stdout.write(chalk.cyan(BOX.tl + BOX.h.repeat(inner) + BOX.tr) + "\n");

  // Empty line
  process.stdout.write(chalk.cyan(BOX.v) + " ".repeat(inner) + chalk.cyan(BOX.v) + "\n");

  // Logo lines (centered by visual width)
  for (const line of logo) {
    const vw = visualWidth(line);
    const padL = Math.max(0, Math.floor((inner - vw) / 2));
    const padR = Math.max(0, inner - padL - vw);
    process.stdout.write(chalk.cyan(BOX.v) + " ".repeat(padL) + chalk.bold(line) + " ".repeat(padR) + chalk.cyan(BOX.v) + "\n");
  }

  // Empty line
  process.stdout.write(chalk.cyan(BOX.v) + " ".repeat(inner) + chalk.cyan(BOX.v) + "\n");

  // Info line
  const infoVW = visualWidth(info);
  const infoPad = Math.max(0, inner - infoVW);
  process.stdout.write(chalk.cyan(BOX.v) + info + " ".repeat(infoPad) + chalk.cyan(BOX.v) + "\n");

  // Bottom border
  process.stdout.write(chalk.cyan(BOX.bl + BOX.h.repeat(inner) + BOX.br) + "\n");
}

// ── Footer ──

export function printFooter() {
  const W = termWidth();
  process.stdout.write(chalk.dim("─".repeat(W)) + "\n");   // 上分隔线
  process.stdout.write("\n");                               // 空白行 — 供 prompt
  process.stdout.write(chalk.dim("─".repeat(W)) + "\n");   // 下分隔线
  process.stdout.write("   " + chalk.dim("输入 /help 查看帮助") + "\n");  // 帮助提示
}

// ── User message ──

export function printUserMsg(text) {
  const W = termWidth();
  const fill = " ".repeat(W);
  // prefix: 3空格 + ❯(双列宽) + 1空格 = 视觉宽度 6
  const prefix = "   " + chalk.green("❯") + " ";
  const prefixVW = 6;
  const textVW = visualWidth(text);
  const padding = Math.max(0, W - prefixVW - textVW);

  process.stdout.write("\n" + USER_MSG_BG(fill) + "\n");
  process.stdout.write(USER_MSG_BG(prefix + text + " ".repeat(padding)) + "\n");
  process.stdout.write(USER_MSG_BG(fill) + "\n\n");
}

// ── Thinking label ──

export function printThinkingLabel() {
  process.stdout.write("   " + chalk.magenta("✻") + " " + chalk.gray("Thinking") + "\n");
}

/**
 * 获取账号的显示标签。有 nickname 则用 nickname，
 * 否则按手机号/邮箱脱敏展示。
 */
export function accountLabel(account) {
  if (account?.nickname) return account.nickname;
  if (!account) return "未登录";
  const loginValue = account.loginValue || account.email || "";
  if (/^\d{11}$/.test(loginValue)) {
    return loginValue.replace(/^(\d{3})\d{6}(\d{2})$/, "$1******$2");
  }
  if (loginValue.includes("@")) {
    return loginValue.replace(/^(.{1,3}).*(@.*)$/, "$1***$2");
  }
  return account.displayName || loginValue || "未命名";
}
