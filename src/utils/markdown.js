import chalk from "chalk";

const HR_CHAR = "─";

// ── 全局流式渲染状态（跨 renderMarkdown 调用持久化）──

let _codeBlock = false;
let _codeLang = "";
let _codeLineNum = 0;
let _tableLines = [];

/** 重置流式渲染状态（新对话开始时调用） */
export function resetMarkdownRenderer() {
  _codeBlock = false;
  _codeLang = "";
  _codeLineNum = 0;
  _tableLines = [];
}

// ── 内联渲染 ──

function renderInline(text) {
  // 转义：\*, \`, \_, \\
  text = text.replace(/\\([*_`\\])/g, "$1");
  // ~~删除线~~
  text = text.replace(/~~(.+?)~~/g, (_, c) => chalk.strikethrough(c));
  // **粗体**
  text = text.replace(/\*\*(.+?)\*\*/g, (_, c) => chalk.bold(c));
  // `行内代码`
  text = text.replace(/`([^`]+)`/g, (_, c) => chalk.cyan(c));
  // [链接](url)
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, (_, c) => chalk.blue.underline(c));
  // *斜体* → 深蓝
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, c) => chalk.rgb(0, 100, 180)(c));
  // _斜体_ → 深蓝
  text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, (_, c) => chalk.rgb(0, 100, 180)(c));
  return text;
}

// ── 表格渲染 ──

function renderTable(lines) {
  if (lines.length < 2) return lines.map((l) => "   " + l).join("\n");

  // 解析列宽
  const rows = [];
  let hasHeaderSep = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").filter((c, idx, arr) => idx > 0 && idx < arr.length - 1 || (idx === 0 && line.startsWith("|")));
    const trimmed = cells.map((c) => c.trim());
    if (trimmed.every((c) => /^[-:]+$/.test(c.replace(/\s/g, "")))) {
      hasHeaderSep = true;
      continue;
    }
    rows.push(trimmed);
  }

  if (!rows.length) return lines.map((l) => "   " + l).join("\n");

  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = new Array(colCount).fill(3);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const stripped = chalk.stripColor ? chalk.stripColor(row[i] || "") : (row[i] || "");
      // 粗糙估算：中文字符算 2 宽度
      const w = [...stripped].reduce((sum, c) => sum + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
      widths[i] = Math.max(widths[i], w + 2);
    }
  }

  const pad = (s, w, i) => {
    const stripped = chalk.stripColor ? chalk.stripColor(s) : s;
    const len = [...stripped].reduce((sum, c) => sum + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
    const padding = w - len;
    const left = i === 0 ? 4 : 1;
    const right = i === colCount - 1 ? 1 : padding;
    return " ".repeat(left) + s + " ".repeat(Math.max(0, right));
  };

  const result = [];
  // 表头分隔线
  const sep = widths.map((w) => HR_CHAR.repeat(w)).join("");
  result.push("   " + sep);

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const rendered = row.map((c, i) => pad(c, widths[i], i));
    result.push(rendered.join("") + (r === 0 && hasHeaderSep ? "\n   " + sep : ""));
  }

  result.push("   " + sep);
  return result.join("\n");
}

// ── 块级渲染 ──

/**
 * 将 markdown 文本渲染为带 ANSI 样式的字符串。
 * @param {string} text 原始 markdown
 * @param {boolean} enabled 是否启用 markdown 渲染
 */
export function renderMarkdown(text, enabled = true) {
  if (!enabled) return text;

  const lines = text.split("\n");
  const output = [];
  let i = 0;

  function flushTable() {
    if (_tableLines.length > 0) {
      // 检查是否真的是表格（有 | 分隔符行）
      const hasSep = _tableLines.some((l) => /^\|[\s\-:|]+\|$/.test(l.trim()) || /^\|[-\s:|]+\|$/.test(l.trim()));
      if (hasSep) {
        output.push(renderTable(_tableLines));
      } else {
        output.push(..._tableLines.map((l) => "   " + renderInline(l)));
      }
      _tableLines = [];
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (line.trimStart().startsWith("```")) {
      flushTable();
      if (!_codeBlock) {
        _codeLang = line.trimStart().slice(3).trim().toUpperCase();
        _codeBlock = true;
        _codeLineNum = 0;
        const hr = HR_CHAR.repeat(process.stdout.columns - 3 || 72);
        const langLabel = _codeLang ? " " + chalk.bold(_codeLang) + " " : " ";
        output.push(chalk.dim("   " + langLabel + hr.slice(langLabel.length + 3)));
      } else {
        const hr = HR_CHAR.repeat(process.stdout.columns - 3 || 72);
        output.push(chalk.dim("   " + hr));
        _codeBlock = false;
        _codeLang = "";
        _codeLineNum = 0;
      }
      i++;
      continue;
    }

    if (_codeBlock) {
      _codeLineNum++;
      const num = chalk.gray(String(_codeLineNum).padStart(3, " "));
      output.push("     " + num + " " + chalk.white(line.replace(/^ {0,3}/, "")));
      i++;
      continue;
    }

    let trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // 水平线
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(trimmed)) {
      flushTable();
      output.push(chalk.dim("  " + HR_CHAR.repeat(60)));
      i++;
      continue;
    }

    // 表格行（检测 | 开头的行）
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushTable();
      _tableLines.push(line);
      i++;
      // 收集连续表格行
      while (i < lines.length && lines[i].trimStart().startsWith("|") && lines[i].trim().endsWith("|")) {
        _tableLines.push(lines[i]);
        i++;
      }
      continue;
    }

    // 表格行可能在中间（有 --- | --- 分隔符）
    if (_tableLines.length > 0 && !trimmed.startsWith("|")) {
      flushTable();
    }

    // 引用块
    if (trimmed.startsWith(">")) {
      flushTable();
      let qContent = trimmed.slice(1).trimStart();
      if (!qContent) qContent = " ";
      output.push(chalk.bgBlack.gray("  " + renderInline(qContent)));
      i++;
      continue;
    }

    // 标题（必须在引用检查和代码块检查之后）
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      flushTable();
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const prefix = " ".repeat(level - 1); // 每级多缩进 1 空格
      if (level <= 2) {
        output.push(prefix + chalk.hex("#c084fc").bold(text) + chalk.reset(""));
      } else {
        output.push(prefix + chalk.hex("#c084fc")(text) + chalk.reset(""));
      }
      i++;
      continue;
    }

    // 无序列表
    if (/^(\s*)[-*+]\s/.test(trimmed)) {
      flushTable();
      const match = trimmed.match(/^([-*+])\s+(.+)/);
      if (match) {
        const content = match[2];
        // 任务列表 [x] 或 [ ]
        const taskMatch = content.match(/^\[(.)\]\s+(.+)/);
        if (taskMatch) {
          const done = taskMatch[1].toLowerCase() === "x";
          const taskText = taskMatch[2];
          if (done) {
            output.push("   " + chalk.green("✓") + " " + chalk.strikethrough(chalk.dim(renderInline(taskText))));
          } else {
            output.push("   " + chalk.dim("○") + " " + renderInline(taskText));
          }
        } else {
          output.push("   • " + renderInline(content));
        }
      }
      i++;
      continue;
    }

    // 有序列表
    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (olMatch) {
      flushTable();
      output.push("   " + olMatch[1] + ". " + renderInline(olMatch[2]));
      i++;
      continue;
    }

    // 空行
    if (!trimmed) {
      flushTable();
      output.push("");
      i++;
      continue;
    }

    // 普通段落
    flushTable();
    output.push("   " + renderInline(trimmed));
    i++;
  }

  flushTable();

  return output.join("\n");
}
