/**
 * 子 Agent 管理器
 *
 * 负责：
 * - 读取 profile 配置
 * - 生成子 agent 系统提示词 + 任务 prompt
 * - 调用 aux provider 执行子任务
 * - shell 命令白名单检查
 * - 收集子 agent 结果
 * - 支持超时和取消
 * - Braille spinner 进度动画
 */

import { createId } from "../../utils/id.js";
import { buildSubAgentSystemPrompt, buildSearchSubAgentPrompt } from "./prompts.js";
import { buildPromptFromMessages, parseToolCallsFromText } from "../../bridge.js";
import { executeToolCall, TOOL_DEFINITIONS } from "../tools/registry.js";
import { getExtensionPromptSections } from "../../extensions/index.js";
import { resolveProfile } from "./config.js";

// ── Braille spinner ──

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startSpinner(label) {
  let frame = 0;
  let running = true;
  const interval = setInterval(() => {
    if (!running) return;
    process.stdout.write(`\r  ${SPINNER_FRAMES[frame]} ${label}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  }, 80);
  return {
    update(newLabel) {
      label = newLabel;
    },
    stop(finalText) {
      running = false;
      clearInterval(interval);
      if (finalText) {
        process.stdout.write(`\r  ${finalText}\n`);
      } else {
        process.stdout.write(`\r\x1b[K`);
      }
    }
  };
}

// ── 子 agent 结果紧凑格式化 ──

function formatToolResultCompact(toolName, result) {
  if (!result) return "";
  switch (toolName) {
    case "shell": {
      const out = result.stderr || result.stdout || (result.error ? `错误: ${result.error}` : "(无输出)");
      return `SHELL: ${result.command || ""}\n${out.slice(0, 4000)}`;
    }
    case "file-read": {
      if (!result.success) return `读取失败: ${result.error}`;
      return `FILE-READ: ${result.path}\n${(result.content || "").slice(0, 3000)}`;
    }
    case "file-search": {
      if (result.error) return `搜索失败: ${result.error}`;
      if (result.type === "filename") {
        return `SEARCH: ${result.pattern}\n找到 ${result.count} 个文件:\n${(result.files || []).slice(0, 20).join("\n")}`;
      }
      if (result.type === "content") {
        const lines = (result.matches || []).slice(0, 20).map((m) => `${m.file}:${m.line}  ${m.text}`).join("\n");
        return `SEARCH: ${result.pattern}\n找到 ${result.count} 处匹配:\n${lines}`;
      }
      return `SEARCH: ${result.pattern}\n找到 ${result.count || 0} 个结果`;
    }
    default: return JSON.stringify(result).slice(0, 1000);
  }
}

// ── Shell 白名单检查 ──

/**
 * 提取 shell 命令的基础命令名（处理 sudo、env、路径等前缀）
 */
function extractBaseCommand(cmd) {
  if (!cmd) return "";
  // 去掉前导空格、管道/重定向后的内容，取第一个词
  const firstPart = cmd.trim().split(/\s+/)[0] || "";
  // 处理 sudo / env / 路径
  if (firstPart === "sudo" || firstPart === "env") {
    const parts = cmd.trim().split(/\s+/).slice(1);
    // 跳过 KEY=VALUE 形式
    for (const p of parts) {
      if (!p.includes("=")) return p;
    }
  }
  // 处理 /usr/bin/ls 这种路径
  const basename = firstPart.split("/").pop() || firstPart;
  return basename;
}

/**
 * 检查命令是否在子 Agent 白名单中
 * @param {string} cmd - 完整命令
 * @param {object} profile - 子 Agent 配置
 * @returns {{ allowed: boolean, baseCommand: string, reason?: string }}
 */
function checkShellWhitelist(cmd, profile) {
  const base = extractBaseCommand(cmd);
  if (!base) return { allowed: false, baseCommand: "", reason: "空命令" };

  const whitelist = profile.allowedShellCommands || [];
  const blockUnlisted = profile.blockUnlistedCommands !== false;

  // 检查危险模式（即使在白名单也拒绝）
  const DANGEROUS = [
    /\brm\s+-rf?\b/, /\bgit\s+push\s+--force\b/, /\bgit\s+push\s+-f\b/,
    /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\s+-[fdx]/, /\bchmod\s+777\b/,
    /\bdd\s+if=/, /\bmkfs\./, /\b>[\s]*\/dev\//
  ];
  const isDangerous = DANGEROUS.some((p) => p.test(cmd));

  if (isDangerous) {
    return { allowed: false, baseCommand: base, reason: `命令 "${cmd.slice(0, 80)}" 属于危险操作，子Agent不允许执行` };
  }

  if (whitelist.includes(base)) {
    return { allowed: true, baseCommand: base };
  }

  if (blockUnlisted) {
    return {
      allowed: false,
      baseCommand: base,
      reason: `命令 "${base}" 不在子Agent白名单中 (允许: ${whitelist.join(", ")})`
    };
  }

  return { allowed: true, baseCommand: base };
}

// ── Search 模型变体推导 ──

/**
 * 根据主模型推导其 search 变体（联网搜索模型）。
 * - qwen: model + "-search"（已带 -search/-thinking-search 则原样；-thinking → -thinking-search）
 * - deepseek: model + "-search"（resolveModelConfig 自动开 search_enabled）
 * - glm/其它: 不支持原生 web 搜索，原样返回
 * @param {object} provider
 * @param {string} model
 * @returns {string}
 */
function resolveSearchModel(provider, model) {
  if (!model) return model;
  const name = provider?.name;
  if (name === "qwen") {
    if (model.endsWith("-thinking-search") || model.endsWith("-search")) return model;
    if (model.endsWith("-thinking")) return `${model}-search`;
    return `${model}-search`;
  }
  if (name === "deepseek") {
    if (model.endsWith("-search")) return model;
    return `${model}-search`;
  }
  // glm / openai 等不支持原生搜索变体
  return model;
}

/**
 * 从 search 子 agent 的响应文本中提取 <search>...</search> 或 <search-failed /> 块。
 * 容错：若未命中标签，原样返回全文。
 * @param {string} text
 * @returns {string}
 */
function extractSearchResult(text) {
  if (!text) return text;
  const m = text.match(/<search[\s\S]*?<\/search>|<search-failed[^>]*\/>/);
  return m ? m[0] : text.trim();
}

// ── 子 agent 运行状态 ──

const RUN_STATES = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out"
};

/**
 * @typedef {object} SubagentRun
 * @property {string} id - 运行 ID
 * @property {string} task - 任务描述
 * @property {string} status - 状态
 * @property {string} [result] - 结果文本
 * @property {string} [error] - 错误信息
 * @property {number} startedAt - 开始时间戳
 * @property {number} [completedAt] - 完成时间戳
 * @property {AbortController} [abortController] - 取消控制器
 */

/**
 * SubagentManager — 管理子 agent 的完整生命周期
 */
export class SubagentManager {
  /**
   * @param {object} opts
   * @param {object} opts.provider - AI provider
   * @param {string} opts.model - AI 模型
   * @param {string} opts.workingDir - 工作目录
   * @param {number} [opts.maxTurns=5] - 默认最大轮次（可由 profile 覆盖）
   * @param {number} [opts.timeoutMs=120000] - 默认超时（可由 profile 覆盖；0=不限时）
   * @param {number} [opts.shellTimeout=120000] - 子 agent 执行 shell 命令的超时（0=不限时）
   * @param {Function} [opts.onEvent] - 事件回调 (runId, eventType, data)
   */
  constructor(opts = {}) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.workingDir = opts.workingDir || process.cwd();
    this.defaultMaxTurns = opts.maxTurns ?? 5;
    this.defaultTimeoutMs = opts.timeoutMs ?? 120000;
    this.shellTimeout = opts.shellTimeout ?? 120000;
    this.onEvent = opts.onEvent || null;

    /** @type {Map<string, SubagentRun>} */
    this.runs = new Map();

    /** @type {object|null} Braille spinner 引用 */
    this._spinner = null;
  }

  /** 生成运行 ID */
  _genRunId() {
    return `sub_${createId()}`;
  }

  /** 触发事件的便捷方法 */
  _emit(runId, type, data = {}) {
    if (this.onEvent) {
      try { this.onEvent(runId, type, data); } catch { /* ignore */ }
    }
  }

  /**
   * abort 时的统一处理：区分超时/取消，并保底返回已积累内容。
   * - 超时（run.status 已被超时定时器设为 TIMED_OUT）：保持语义，不覆盖为取消
   * - 真取消（仍处于 RUNNING/PENDING，即 Ctrl+C）：设 CANCELLED 并 emit
   * - 已积累 responseText 时保底返回（search 模式下提取 <search>），避免丢弃结果
   * @returns {string|null} 应返回的文本；null 表示非 abort 终态（不应中止）
   */
  _handleAbort(run, runId, responseText, isSearch, turns) {
    if (run.status === RUN_STATES.TIMED_OUT) {
      this._spinner?.stop(`[TIMEOUT] ${run.error || "超时"}`);
      this._spinner = null;
      const t = (responseText || "").trim();
      if (t) return isSearch ? extractSearchResult(t) : t;
      return `[超时] ${run.error || "子 agent 超时"}`;
    }
    if (run.status === RUN_STATES.RUNNING || run.status === RUN_STATES.PENDING) {
      this._spinner?.stop("[!] 子Agent已取消");
      this._spinner = null;
      run.status = RUN_STATES.CANCELLED;
      run.completedAt = Date.now();
      this._emit(runId, "cancelled", { turns });
      const t = (responseText || "").trim();
      if (t) return isSearch ? extractSearchResult(t) : t;
      return "[已取消]";
    }
    return null;
  }

  /**
   * 生成子 agent 的 messages 数组
   * @param {string} task
   * @param {object} profile - 子 Agent 配置
   * @param {object} [extra]
   * @param {boolean} [extra.isSearch] - 是否为 search 模式
   */
  _buildMessages(task, profile, extra = {}) {
    const extSections = getExtensionPromptSections ? getExtensionPromptSections("aux") : [];

    let systemPrompt;
    if (extra.isSearch) {
      // search 模式：专用提示词，不注入任何工具/工具调用格式
      systemPrompt = buildSearchSubAgentPrompt({ workingDir: this.workingDir });
    } else {
      const tools = profile.tools || ["shell", "file-read", "file-search"];
      systemPrompt = buildSubAgentSystemPrompt({
        workingDir: this.workingDir,
        allowedTools: tools,
        toolDefinitions: TOOL_DEFINITIONS,
        allowedShellCommands: profile.allowedShellCommands || [],
        blockUnlistedCommands: profile.blockUnlistedCommands !== false
      });
    }

    if (extSections.length > 0) {
      systemPrompt += "\n\n" + extSections.join("\n\n");
    }

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: task }
    ];
  }

  /**
   * 执行单个子 agent（内部方法）
   * @param {string} runId
   * @param {string} task
   * @param {object} opts
   * @param {object} opts.profile - 子 Agent profile 配置
   * @returns {Promise<string>} 子 agent 结果文本
   */
  async _executeSubAgent(runId, task, opts = {}) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`子 agent ${runId} 不存在`);

    const profile = opts.profile || resolveProfile("default");
    const allowedTools = profile.tools || ["shell", "file-read", "file-search"];
    const signal = run.abortController?.signal;
    const maxTurns = profile.maxTurns ?? this.defaultMaxTurns;
    const isSearch = profile.promptMode === "search";

    const messages = this._buildMessages(task, profile, { isSearch });
    const toolResults = [];

    let sessionId = null;
    let parentMessageId = null;
    let turns = 0;

    // abort 时的统一处理（转发到实例方法，便于测试与复用）
    const handleAbort = (responseText) => this._handleAbort(run, runId, responseText, isSearch, turns);

    // 启动 spinner
    this._spinner = startSpinner("子Agent工作中...");

    while (turns < maxTurns) {
      let thinkingText = "";
      let responseText = "";

      if (signal?.aborted) {
        const r = handleAbort(responseText);
        if (r !== null) return r;
      }

      turns++;

      const prompt = sessionId
        ? task
        : buildPromptFromMessages(messages);

      const providerOpts = {
        prompt,
        model: (opts.model || (isSearch ? resolveSearchModel(this.provider, this.model) : this.model)) || undefined,
        accountId: this.provider.getDefaultAccount?.()?.id
      };
      if (isSearch) providerOpts.enableSearch = true;
      if (sessionId) {
        providerOpts.sessionId = sessionId;
        providerOpts.parentMessageId = parentMessageId;
      }

      try {
        const resp = await this.provider.startCompletion(messages, providerOpts);

        if (!resp || !resp.ok) {
          this._spinner?.stop("[FAIL] 请求失败");
          this._spinner = null;
          run.status = RUN_STATES.FAILED;
          run.error = `子 agent 请求失败 (HTTP ${resp?.status || "?"})`;
          run.completedAt = Date.now();
          this._emit(runId, "failed", { error: run.error, turns });
          return `[错误] ${run.error}`;
        }

        if (!sessionId && resp._sessionId) {
          sessionId = resp._sessionId;
        }

        // 消费流
        const { consumeQwenStream } = await import("../../bridge.js");

        // 累加 delta，过滤 __messageId / __sessionId 等元数据（不混入文本）
        const accumulate = (delta) => {
          if (!delta || typeof delta.kind !== "string") return;
          if (delta.kind === "thinking") thinkingText += delta.text;
          else if (delta.kind === "response") responseText += delta.text;
          // 其它 kind（__messageId/__sessionId/__tokenExpired 等）忽略
        };

        if (this.provider.name === "qwen") {
          const pending = [];
          let done = false, error = null;
          const consumePromise = consumeQwenStream(resp.body, (delta) => {
            pending.push(delta);
          }).then(() => { done = true; }).catch((err) => { error = err; done = true; });

          let idx = 0;
          while (!done || idx < pending.length) {
            if (signal?.aborted) {
              const r = handleAbort(responseText);
              if (r !== null) return r;
            }
            while (idx < pending.length) {
              accumulate(pending[idx++]);
            }
            if (done) break;
            await new Promise((r) => setTimeout(r, 10));
          }
          if (error) throw error;
          await consumePromise;
        } else if (this.provider.name === "deepseek") {
          const { streamDeltasWithMessageId } = await import("../../providers/deepseek/chat.js");
          const stream = streamDeltasWithMessageId(resp);
          for await (const delta of stream.deltas) {
            if (signal?.aborted) {
              const r = handleAbort(responseText);
              if (r !== null) return r;
            }
            accumulate(delta);
          }
          if (stream.messageId) {
            parentMessageId = stream.messageId;
          }
        } else {
          const { consumeGlmStream } = await import("../../bridge.js");
          await consumeGlmStream(resp.body, (delta) => {
            // 回调内无法中断流消费；abort 时停止累加，由流结束后的检查统一处理
            if (signal?.aborted) return;
            accumulate(delta);
          });
          if (signal?.aborted) {
            const r = handleAbort(responseText);
            if (r !== null) return r;
          }
        }

        // search 模式：单轮，不解析工具调用，直接提取搜索结果
        if (isSearch) {
          this._spinner?.stop("[OK] 搜索完成");
          this._spinner = null;
          run.status = RUN_STATES.COMPLETED;
          run.result = extractSearchResult(responseText);
          run.completedAt = Date.now();
          this._emit(runId, "completed", { result: run.result, turns, toolCount: 0 });
          return run.result;
        }

        // 解析工具调用
        const parsedCalls = parseToolCallsFromText(responseText);

        if (parsedCalls.length > 0) {
          // 更新 spinner
          const toolNames = parsedCalls.map(c => c.name).join(", ");
          this._spinner?.update(`子Agent调用: ${toolNames}`);

          for (const call of parsedCalls) {
            if (signal?.aborted) {
              const r = handleAbort(responseText);
              if (r !== null) return r;
            }

            const toolName = call.name;
            let params = {};
            try {
              params = typeof call.input === "string" ? JSON.parse(call.input) : (call.input || {});
            } catch { params = {}; }

            // 检查工具是否在允许列表中
            if (!allowedTools.includes(toolName)) {
              toolResults.push(`[跳过] 工具 ${toolName} 不在当前 profile (${profile._name || "default"}) 允许列表中`);
              continue;
            }

            // shell 白名单检查
            if (toolName === "shell" && params.command) {
              const check = checkShellWhitelist(params.command, profile);
              if (!check.allowed) {
                const msg = `[拒绝] ${check.reason}`;
                toolResults.push(msg);
                this._emit(runId, "tool_blocked", { toolName, reason: check.reason });
                continue;
              }
            }

            this._emit(runId, "tool_start", { toolName, params });

            const toolResult = await executeToolCall(toolName, params, {
              workingDir: this.workingDir,
              taskList: [],
              shellTimeout: this.shellTimeout,
              isSubAgent: true,
              subagentProfile: profile
            });

            // 子 agent autonomous，不交互审批：需要审批的工具调用直接拒绝
            // 避免把 "需要审批" 的 warning 文本当结果寒给 AI
            if (toolResult.requiresApproval) {
              const msg = `[拒绝] 工具 ${toolName} 需要用户审批，子 agent 无权执行`;
              toolResults.push(`--- ${toolName} ---\n${msg}`);
              this._emit(runId, "tool_blocked", { toolName, reason: "需要审批" });
              continue;
            }

            const resultText = formatToolResultCompact(toolName, toolResult.result);
            toolResults.push(`--- ${toolName} ---\n${resultText}`);

            this._emit(runId, "tool_result", { toolName, result: toolResult.result });

            if (toolName === "shell" && toolResult.result?.error) {
              toolResults.push(`Shell 执行错误: ${toolResult.result.error}`);
            }
          }

          messages.push({ role: "assistant", content: responseText });
          for (const call of parsedCalls) {
            const callResult = toolResults[toolResults.length - 1] || "";
            messages.push({ role: "tool", content: callResult });
          }
          continue;
        }

        // 无工具调用 → 子 agent 完成
        this._spinner?.stop("[OK] 子Agent完成");
        this._spinner = null;
        run.status = RUN_STATES.COMPLETED;
        run.result = responseText.trim();
        run.completedAt = Date.now();

        const toolSection = toolResults.length > 0
          ? `\n\n【工具执行记录】\n${toolResults.join("\n\n")}`
          : "";

        const finalResult = responseText.trim() + toolSection;
        this._emit(runId, "completed", { result: finalResult, turns, toolCount: toolResults.length });
        return finalResult;

      } catch (err) {
        this._spinner?.stop(`[FAIL] ${err.message.slice(0, 60)}`);
        this._spinner = null;

        if (signal?.aborted) {
          const r = handleAbort(responseText);
          if (r !== null) return r;
        }

        run.status = RUN_STATES.FAILED;
        run.error = err.message;
        run.completedAt = Date.now();
        this._emit(runId, "failed", { error: err.message, turns });

        const toolSection = toolResults.length > 0
          ? `\n\n【工具执行记录】\n${toolResults.join("\n\n")}`
          : "";

        return `[错误] ${err.message}${toolSection}`;
      }
    }

    // 达到最大轮次
    this._spinner?.stop("[OK] 已达最大轮次");
    this._spinner = null;
    run.status = RUN_STATES.COMPLETED;
    run.result = `达到最大轮次 (${maxTurns})`;
    run.completedAt = Date.now();
    this._emit(runId, "completed", { result: run.result, turns });
    return `[达到最大轮次] 子 agent 执行了 ${maxTurns} 轮工具调用，结果：\n${toolResults.join("\n\n")}`;
  }

  /**
   * 生成一个子 agent 并等待完成
   * @param {string} task
   * @param {object} [opts]
   * @param {string} [opts.profile="default"] - profile 名称
   * @param {string[]} [opts.tools] - 覆盖 profile 中的工具列表
   * @param {number} [opts.maxTurns] - 覆盖最大轮次
   * @param {string} [opts.model] - 覆盖使用的模型（search profile 未指定时自动推导 search 变体）
   * @returns {Promise<{ id: string, task: string, status: string, result: string, error?: string }>}
   */
  async spawnAndWait(task, opts = {}) {
    const profileName = opts.profile || "default";
    const profile = resolveProfile(profileName);
    profile._name = profileName;

    // 允许调用方覆盖部分 profile 字段
    if (opts.tools) profile.tools = opts.tools;
    if (opts.maxTurns) profile.maxTurns = opts.maxTurns;

    const runId = this._genRunId();
    const abortController = new AbortController();
    const timeoutMs = profile.timeoutMs ?? this.defaultTimeoutMs;

    /** @type {SubagentRun} */
    const run = {
      id: runId,
      task,
      status: RUN_STATES.PENDING,
      result: null,
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      abortController
    };

    this.runs.set(runId, run);

    let timeoutHandle = null;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (run.status === RUN_STATES.PENDING || run.status === RUN_STATES.RUNNING) {
          abortController.abort();
          run.status = RUN_STATES.TIMED_OUT;
          run.error = `子 agent 超时 (${timeoutMs}ms)`;
          run.completedAt = Date.now();
          this._emit(runId, "timed_out", { timeoutMs });
        }
      }, timeoutMs);
    }

    this._emit(runId, "spawned", { task, profile: profileName });

    try {
      run.status = RUN_STATES.RUNNING;
      this._emit(runId, "running", { profile: profileName });

      const result = await this._executeSubAgent(runId, task, { profile, model: opts.model });

      if (timeoutHandle) clearTimeout(timeoutHandle);

      return {
        id: runId,
        task,
        status: run.status,
        result: run.result || result,
        error: run.error || null
      };
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);

      run.status = RUN_STATES.FAILED;
      run.error = err.message;
      run.completedAt = Date.now();

      return {
        id: runId,
        task,
        status: run.status,
        result: null,
        error: err.message
      };
    }
  }

  /**
   * 并发执行多个子 agent
   * @param {Array<{ task: string, profile?: string, tools?: string[], maxTurns?: number }>} tasks
   * @param {number} [concurrency=3]
   * @returns {Promise<Array>}
   */
  async spawnParallel(tasks, concurrency = 3) {
    if (!tasks || tasks.length === 0) return [];
    if (tasks.length === 1) {
      const r = await this.spawnAndWait(tasks[0].task, tasks[0]);
      return [r];
    }

    const results = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((t) => this.spawnAndWait(t.task, t))
      );
      results.push(...batchResults);
    }
    return results;
  }

  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (run.status === RUN_STATES.COMPLETED || run.status === RUN_STATES.FAILED ||
        run.status === RUN_STATES.CANCELLED || run.status === RUN_STATES.TIMED_OUT) {
      return false;
    }
    run.abortController?.abort();
    return true;
  }

  cancelAll() {
    let count = 0;
    for (const [id] of this.runs) {
      if (this.cancel(id)) count++;
    }
    return count;
  }

  get(runId) {
    return this.runs.get(runId);
  }

  list(status) {
    const all = [...this.runs.values()];
    if (status) return all.filter((r) => r.status === status);
    return all;
  }

  cleanup(olderThanMs = 300000) {
    const cutoff = Date.now() - olderThanMs;
    let count = 0;
    for (const [id, run] of this.runs) {
      if (
        (run.status === RUN_STATES.COMPLETED || run.status === RUN_STATES.FAILED ||
         run.status === RUN_STATES.CANCELLED || run.status === RUN_STATES.TIMED_OUT) &&
        run.completedAt && run.completedAt < cutoff
      ) {
        this.runs.delete(id);
        count++;
      }
    }
    return count;
  }
}

export { RUN_STATES, checkShellWhitelist, extractBaseCommand };
