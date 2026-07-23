import { execSync } from "node:child_process";
import { existsSync, statSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, relative, resolve, dirname, basename } from "node:path";

// ═══════════════════════════════════════════════
//  工具注册表
// ═══════════════════════════════════════════════

/** 用于追踪内置工具名称（扩展工具冲突检测） */
const builtinToolNames = new Set();

/** 自定义工具执行器注册表 */
const toolExecutors = new Map();

/** 所有工具的元数据定义（用于注入 AI 提示词） */
export const TOOL_DEFINITIONS = [
  {
    name: "shell",
    description: "执行 Shell 命令。返回 stdout 和 stderr。危险操作（删除、强制推送等）需设 requires_approval:true。超时 120 秒。",
    parameters: {
      command: { type: "string", required: true, description: "要执行的 shell 命令" },
      requires_approval: { type: "boolean", required: false, description: "是否需要用户确认（危险命令设为 true）" },
      working_dir: { type: "string", required: false, description: "工作目录，默认为项目根目录" }
    }
  },
  {
    name: "file-read",
    description: "读取文件内容。支持指定行范围。",
    parameters: {
      path: { type: "string", required: true, description: "文件路径（绝对路径或相对于工作目录）" },
      offset: { type: "number", required: false, description: "起始行号（0-based）" },
      limit: { type: "number", required: false, description: "最多读取行数" }
    }
  },
  {
    name: "file-write",
    description: "写入/修改文件。mode=create 创建新文件，mode=replace 替换文件中的指定内容（需精确匹配 old_string）。",
    parameters: {
      path: { type: "string", required: true, description: "文件路径" },
      mode: { type: "string", required: true, description: "create（创建/覆盖）或 replace（内容替换）" },
      content: { type: "string", required: false, description: "mode=create 时：要写入的完整内容" },
      old_string: { type: "string", required: false, description: "mode=replace 时：要替换的原始文本（需精确匹配）" },
      new_string: { type: "string", required: false, description: "mode=replace 时：替换后的新文本" },
      keep_leading_blank: { type: "boolean", required: false, description: "mode=create 时：是否保留首行空行（默认 false，自动去除首行空白行）" }
    }
  },
  {
    name: "file-search",
    description: "搜索文件。type=content 搜索文件内容（grep），type=filename 搜索文件名（glob）。",
    parameters: {
      type: { type: "string", required: true, description: "content（搜索文件内容）或 filename（搜索文件名）" },
      pattern: { type: "string", required: true, description: "搜索模式（content 模式支持正则，filename 模式支持 glob）" },
      path: { type: "string", required: false, description: "搜索目录，默认为工作目录" }
    }
  },
  {
    name: "todo",
    description: "管理任务清单。action=list 查看，action=update 批量更新（替换整个清单）。",
    parameters: {
      action: { type: "string", required: true, description: "list（查看）或 update（更新）" },
      tasks: { type: "array", required: false, description: "action=update 时的任务数组 [{id, content, status}]，status: pending|in_progress|completed" }
    }
  },
  {
    name: "delegate",
    description: "将子任务委托给子 Agent 执行。子 Agent 是独立的 AI，受 profile 配置约束（工具列表、shell 白名单等）。适合独立、不需上下文的探索/搜索/检查类任务。可并发委托多个子任务。",
    parameters: {
      task: { type: "string", required: true, description: "子任务描述（要具体、可验证）" },
      tasks: { type: "array", required: false, description: "并发委托多个子任务时的任务数组 [{ task: '描述', profile: 'explorer' }]" },
      profile: { type: "string", required: false, description: "子 Agent 配置名称。内置: default（默认，只读）、explorer（搜索增强）、builder（可写）。可自定义。" },
      tools: { type: "array", required: false, description: "覆盖 profile 中的工具列表" },
      max_turns: { type: "number", required: false, description: "覆盖 profile 中的最大工具调用轮次" }
    }
  },
  {
    name: "ask",
    description: "向用户提问并等待回复。用于需要用户决策的场景（端口号、确认操作、选择方案等）。",
    parameters: {
      question: { type: "string", required: true, description: "要询问用户的问题" },
      options: { type: "array", required: false, description: "可选的候选项列表，如 ['选项A','选项B','自定义输入']。不提供则自由输入。" }
    }
  }
];

/** 根据工具名查找定义 */
export function getToolDefinition(name) {
  return TOOL_DEFINITIONS.find((t) => t.name === name) || null;
}

/**
 * 注册新工具定义（扩展工具）
 * @param {object} definition - { name, description, parameters }
 */
export function registerTool(definition) {
  if (!definition || !definition.name) return;
  if (builtinToolNames.has(definition.name)) {
    console.warn(`[工具] 扩展工具 "${definition.name}" 与内置同名，已跳过`);
    return;
  }
  if (TOOL_DEFINITIONS.some((t) => t.name === definition.name)) {
    console.warn(`[工具] 工具 "${definition.name}" 已存在，已跳过`);
    return;
  }
  TOOL_DEFINITIONS.push(definition);
}

/**
 * 注册工具执行器
 * @param {string} name - 工具名
 * @param {Function} fn - 执行函数 (params, context) => { result, requiresApproval? }
 */
export function registerToolExecutor(name, fn) {
  if (!name || typeof fn !== "function") return;
  toolExecutors.set(name, fn);
}

/** 获取内置工具名称集合（用于扩展冲突检测） */
export function getBuiltinToolNames() {
  return new Set(builtinToolNames);
}

// ═══════════════════════════════════════════════
//  工具执行函数
// ═══════════════════════════════════════════════

/**
 * 执行工具调用
 * @param {string} toolName
 * @param {object} params
 * @param {object} context - { workingDir, pendingApprovals }
 * @returns {{ result: any, requiresApproval?: boolean }}
 */
export async function executeToolCall(toolName, params, context = {}) {
  // 优先查扩展执行器
  const extExecutor = toolExecutors.get(toolName);
  if (extExecutor) {
    try {
      return await extExecutor(params, context);
    } catch (err) {
      return { result: { error: `扩展工具执行失败: ${err.message}` } };
    }
  }

  // 内置工具
  switch (toolName) {
    case "shell":
      return executeShell(params, context);
    case "file-read":
      return executeFileRead(params, context);
    case "file-write":
      return executeFileWrite(params, context);
    case "file-search":
      return executeFileSearch(params, context);
    case "todo":
      return executeTodo(params, context);
    case "delegate":
      return executeDelegate(params, context);
    case "ask":
      return executeAsk(params, context);
    default:
      return { result: { error: `未知工具: ${toolName}` } };
  }
}

// ── shell ──

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\b/, /\bgit\s+push\s+--force\b/, /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\s+-[fdx]/, /\bchmod\s+777\b/,
  /\bdd\s+if=/, /\bmkfs\./, /\b>[\s]*\/dev\//
];

function isDangerous(cmd) {
  return DANGEROUS_PATTERNS.some((p) => p.test(cmd));
}

function executeShell(params, context) {
  const { command, requires_approval, working_dir, _approved } = params;
  if (!command) return { result: { error: "缺少 command 参数" } };

  // 审批触发：已批准的操作(_approved)直接放行，否则检查
  if (!_approved && (requires_approval || isDangerous(command))) {
    const warning = requires_approval
      ? `Agent 请求审批: ${command}`
      : `命令可能危险: ${command}`;
    return {
      requiresApproval: true,
      approvalType: "shell",
      result: { warning, needsConfirm: true, command }
    };
  }

  const cwd = working_dir || context.workingDir || process.cwd();
  const timeoutMs = context.shellTimeout;
  const execOpts = {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8" }
  };
  // timeoutMs === 0 表示无超时限制
  if (timeoutMs && timeoutMs > 0) execOpts.timeout = timeoutMs;

  try {
    const stdout = execSync(command, execOpts);
    return {
      result: {
        success: true,
        command,
        stdout: stdout || "(无输出)",
        stderr: ""
      }
    };
  } catch (err) {
    return {
      result: {
        success: false,
        command,
        stdout: err.stdout || "",
        stderr: err.stderr || "",
        error: err.message,
        exitCode: err.status
      }
    };
  }
}

// ── file-read ──

function executeFileRead(params, context) {
  const { path, offset, limit } = params;
  const cwd = context.workingDir || process.cwd();
  const filePath = resolve(cwd, path || "");

  if (!existsSync(filePath)) {
    return { result: { error: `文件不存在: ${filePath}` } };
  }

  try {
    const stat = statSync(filePath);
    const MAX_SIZE = 5 * 1024 * 1024; // 5MB
    if (stat.size > MAX_SIZE) {
      return { result: { error: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，超过 5MB 限制` } };
    }

    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const totalLines = lines.length;

    const start = Math.max(0, offset || 0);
    const end = limit ? Math.min(start + limit, totalLines) : totalLines;

    return {
      result: {
        success: true,
        path: filePath,
        totalLines,
        offset: start,
        lines: end - start,
        content: lines.slice(start, end).join("\n")
      }
    };
  } catch (err) {
    return { result: { error: `读取失败: ${err.message}` } };
  }
}

// ── file-write ──

function executeFileWrite(params, context) {
  const { path: filePath, mode, content, old_string, new_string, keep_leading_blank } = params;
  const cwd = context.workingDir || process.cwd();
  const absPath = resolve(cwd, filePath || "");

  if (mode === "create") {
    if (!content && content !== "") {
      return { result: { error: "mode=create 需要 content 参数" } };
    }
    try {
      const dir = dirname(absPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      // 默认去除第一行空行，keep_leading_blank=true 时保留
      const finalContent = keep_leading_blank ? content : (typeof content === "string" ? content.replace(/^\r?\n/, "") : content);
      writeFileSync(absPath, finalContent, "utf8");
      return {
        result: {
          success: true,
          mode: "create",
          path: absPath,
          message: `文件已创建: ${relative(cwd, absPath)}`
        }
      };
    } catch (err) {
      return { result: { error: `创建文件失败: ${err.message}` } };
    }
  }

  if (mode === "replace") {
    if (!old_string && old_string !== "") {
      return { result: { error: "mode=replace 需要 old_string 参数" } };
    }
    if (!existsSync(absPath)) {
      return { result: { error: `文件不存在: ${absPath}` } };
    }
    try {
      const original = readFileSync(absPath, "utf8");
      const idx = original.indexOf(old_string);
      if (idx === -1) {
        return { result: { error: `未找到匹配的 old_string。请确保 old_string 与文件中的内容精确匹配（含空格和换行）。` } };
      }
      const updated = original.slice(0, idx) + (new_string || "") + original.slice(idx + old_string.length);
      writeFileSync(absPath, updated, "utf8");
      return {
        result: {
          success: true,
          mode: "replace",
          path: absPath,
          message: `已替换 1 处匹配`
        }
      };
    } catch (err) {
      return { result: { error: `替换失败: ${err.message}` } };
    }
  }

  return { result: { error: `未知 mode: ${mode}，支持 create 和 replace` } };
}

// ── file-search ──

function executeFileSearch(params, context) {
  const { type, pattern, path: searchDir } = params;
  const cwd = context.workingDir || process.cwd();
  const baseDir = resolve(cwd, searchDir || ".");

  if (!type || !pattern) {
    return { result: { error: "需要 type 和 pattern 参数" } };
  }

  if (!existsSync(baseDir)) {
    return { result: { error: `目录不存在: ${baseDir}` } };
  }

  if (type === "filename") {
    return searchByFilename(baseDir, pattern, cwd);
  }
  if (type === "content") {
    return searchByContent(baseDir, pattern, cwd);
  }
  return { result: { error: `type 只支持 content 或 filename，收到: ${type}` } };
}

function searchByFilename(baseDir, pattern, cwd) {
  const results = [];
  const MAX = 200;

  function globToRegex(glob) {
    // 简单转换：** → .*, * → [^/]*, ? → [^/]
    let r = glob
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "<<<GLOBSTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<{3}GLOBSTAR>{3}/g, ".*")
      .replace(/\?/g, "[^/]");
    return new RegExp("^" + r + "$", "i");
  }

  const regex = globToRegex(pattern);

  function walk(dir, depth) {
    if (results.length >= MAX || depth > 20) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (results.length >= MAX) return;
        const full = join(dir, e.name);
        const rel = relative(cwd, full);
        // 跳过 node_modules 和 .git
        if (e.name === "node_modules" || e.name === ".git") continue;

        if (regex.test(rel) || regex.test(e.name)) {
          results.push(rel);
        }

        if (e.isDirectory()) {
          walk(full, depth + 1);
        }
      }
    } catch { /* 跳过无权限目录 */ }
  }

  walk(baseDir, 0);

  return {
    result: {
      success: true,
      type: "filename",
      pattern,
      count: results.length,
      files: results.slice(0, MAX),
      truncated: results.length >= MAX
    }
  };
}

function searchByContent(baseDir, pattern, cwd) {
  try {
    // 排除 node_modules、.git 和二进制文件
    const safePattern = pattern.replace(/'/g, "'\\''");
    const includes = ["*.js","*.ts","*.json","*.md","*.txt","*.yml","*.yaml","*.html","*.css","*.py","*.sh"]
      .map(ext => `--include='${ext}'`).join(" ");
    const cmd = `grep -rnI ${includes} -e '${safePattern}' '${baseDir}' 2>/dev/null | head -200`;
    const stdout = execSync(cmd, { cwd, timeout: 30000, maxBuffer: 5 * 1024 * 1024, encoding: "utf8" });
    const lines = stdout.trim().split("\n").filter(Boolean);
    const results = lines.map((line) => {
      const idx = line.indexOf(":");
      const file = line.slice(0, idx);
      const rest = line.slice(idx + 1);
      const idx2 = rest.indexOf(":");
      const lineNum = rest.slice(0, idx2);
      const text = rest.slice(idx2 + 1);
      return { file: relative(cwd, file), line: parseInt(lineNum), text: text.slice(0, 200) };
    });

    return {
      result: {
        success: true,
        type: "content",
        pattern,
        count: results.length,
        matches: results,
        truncated: results.length >= 200
      }
    };
  } catch (err) {
    if (err.status === 1) {
      // grep 没有匹配结果
      return { result: { success: true, type: "content", pattern, count: 0, matches: [] } };
    }
    return { result: { error: `搜索失败: ${err.message}` } };
  }
}

// ── delegate ──

async function executeDelegate(params, context) {
  const manager = context.subagentManager;
  if (!manager) {
    return { result: { error: "子 Agent 管理器未初始化，无法委托任务" } };
  }

  const { task, tasks, profile, tools, max_turns } = params;
  const profileName = profile || "default";

  // 并发委托模式
  if (tasks && Array.isArray(tasks) && tasks.length > 0) {
    const taskItems = tasks.map((t) => ({
      task: typeof t === "string" ? t : t.task,
      profile: t.profile || profileName,
      tools: t.tools || tools || undefined,
      maxTurns: t.max_turns || max_turns || undefined
    }));

    if (context.onSubagentEvent) {
      context.onSubagentEvent(null, "parallel_start", { count: taskItems.length, tasks: taskItems.map(t => t.task) });
    }

    const results = await manager.spawnParallel(taskItems, 3);

    const summary = results.map((r, i) => {
      const status = r.status === "completed" ? "[OK]" : r.status === "failed" ? "[FAIL]" : "[..]";
      return `${status} 子任务 ${i + 1}: ${r.task.slice(0, 80)}\
结果: ${(r.result || r.error || "无").slice(0, 500)}`;
    }).join("\
\
");

    return {
      result: {
        success: true,
        type: "delegate_parallel",
        count: results.length,
        completed: results.filter(r => r.status === "completed").length,
        failed: results.filter(r => r.status === "failed" || r.status === "timed_out" || r.status === "cancelled").length,
        summary,
        details: results.map(r => ({
          id: r.id,
          task: r.task.slice(0, 120),
          status: r.status,
          result: (r.result || r.error || "").slice(0, 1000)
        }))
      }
    };
  }

  // 单任务委托模式
  if (!task) {
    return { result: { error: "需要 task（任务描述）或 tasks（任务数组）参数" } };
  }

  if (context.onSubagentEvent) {
    context.onSubagentEvent(null, "spawn_single", { task, profile: profileName });
  }

  const result = await manager.spawnAndWait(task, {
    profile: profileName,
    tools: tools || undefined,
    maxTurns: max_turns || undefined
  });

  return {
    result: {
      success: result.status === "completed",
      type: "delegate",
      profile: profileName,
      task: task.slice(0, 200),
      status: result.status,
      result: result.result || result.error || "",
      error: result.error || null
    }
  };
}

/**
 * executeAsk — 向用户提问并等待回复
 * 返回 requiresApproval 让 Agent 循环暂停并等待 TUI 收集用户输入
 */
function executeAsk(params, context) {
  const { question, options } = params;
  if (!question) {
    return { result: { error: "需要 question 参数" } };
  }

  return {
    requiresApproval: true,
    approvalType: "ask",
    result: {
      type: "ask",
      question,
      options: options || null
    }
  };
}

// ── todo ──

function executeTodo(params, context) {
  const { action, tasks } = params;

  if (action === "list") {
    return {
      result: {
        action: "list",
        tasks: context.taskList || []
      }
    };
  }

  if (action === "update") {
    if (!Array.isArray(tasks)) {
      return { result: { error: "action=update 需要 tasks 数组" } };
    }
    // 确保每个任务有 id
    const normalized = tasks.map((t, i) => ({
      id: t.id || `task_${i + 1}`,
      content: t.content || "",
      status: t.status || "pending"
    }));
    return {
      result: {
        action: "update",
        tasks: normalized,
        message: `任务清单已更新 (${normalized.length} 项)`
      }
    };
  }

  return { result: { error: `未知 action: ${action}，支持 list 和 update` } };
}

// ── 初始化内置工具名集合 ──
for (const t of TOOL_DEFINITIONS) {
  builtinToolNames.add(t.name);
}
