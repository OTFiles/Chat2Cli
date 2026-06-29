import chalk from "chalk";

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

export function truncate(text, maxLen = 40) {
  if (!text) return "";
  const cleaned = text.replace(/\n/g, " ").trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 3) + "..." : cleaned;
}

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

export function printAiContent(text, isThinking = false) {
  if (isThinking) {
    process.stdout.write(chalk.gray(text));
  } else {
    process.stdout.write(chalk.white(text));
  }
}

export function printTable(headers, rows) {
  if (!rows.length) {
    printInfo("暂无记录。");
    return;
  }
  const colWidths = headers.map((h, i) => {
    const maxData = rows.reduce((max, row) => Math.max(max, String(row[i] || "").length), 0);
    return Math.max(h.length, maxData);
  });

  const separator = "─".repeat(colWidths.reduce((s, w) => s + w + 3, 1));

  const headerLine = "│ " + headers.map((h, i) => chalk.bold(h.padEnd(colWidths[i]))).join(" │ ") + " │";
  process.stdout.write("┌" + separator.slice(1) + "┐\n");
  process.stdout.write(headerLine + "\n");
  process.stdout.write("├" + separator.slice(1) + "┤\n");

  for (const row of rows) {
    const line = "│ " + row.map((cell, i) => String(cell || "").padEnd(colWidths[i])).join(" │ ") + " │";
    process.stdout.write(line + "\n");
  }
  process.stdout.write("└" + separator.slice(1) + "┘\n");
}

export function printHelp() {
  process.stdout.write("\n");
  process.stdout.write(chalk.bold("对话模式可用命令:") + "\n");
  process.stdout.write("  " + chalk.cyan("/exit") + "    - 保存并退出对话\n");
  process.stdout.write("  " + chalk.cyan("/clear") + "   - 清空当前上下文\n");
  process.stdout.write("  " + chalk.cyan("/model") + "   - 切换模型 (例: /model deepseek-chat-fast)\n");
  process.stdout.write("  " + chalk.cyan("/models") + "  - 列出可用模型\n");
  process.stdout.write("  " + chalk.cyan("/help") + "    - 显示此帮助\n");
  process.stdout.write("\n");
}
