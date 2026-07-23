/**
 * 子 Agent 管理器
 *
 * 负责：
 * - 生成子 agent 系统提示词 + 任务 prompt
 * - 调用 aux provider 执行子任务
 * - 收集子 agent 结果
 * - 支持并发执行多个子 agent
 * - 支持超时和取消
 */

import { createId } from "../../utils/id.js";
import { buildSubAgentSystemPrompt } from "./prompts.js";
import { buildPromptFromMessages, parseToolCallsFromText, createToolSieve } from "../../bridge.js";
import { executeToolCall, TOOL_DEFINITIONS } from "../tools/registry.js";
import { getExtensionPromptSections, getExtensionTools } from "../../extensions/index.js";

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
 * @property {string} status - 状态：pending/running/completed/failed/cancelled/timed_out
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
   * @param {object} opts.auxProvider - 辅助 AI provider
   * @param {string} opts.auxModel - 辅助 AI 模型
   * @param {string} opts.workingDir - 工作目录
   * @param {number} [opts.maxTurns=5] - 子 agent 最大工具调用轮次
   * @param {number} [opts.timeoutMs=120000] - 单个子 agent 超时（毫秒）
   * @param {Function} [opts.onEvent] - 事件回调 (runId, eventType, data)
   */
  constructor(opts = {}) {
    this.auxProvider = opts.auxProvider;
    this.auxModel = opts.auxModel;
    this.workingDir = opts.workingDir || process.cwd();
    this.maxTurns = opts.maxTurns ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 120000;
    this.onEvent = opts.onEvent || null;

    /** @type {Map<string, SubagentRun>} */
    this.runs = new Map();
  }

  /**
   * 生成子 agent 运行 ID
   */
  _genRunId() {
    return `sub_${createId()}`;
  }

  /**
   * 触发事件回调
   */
  _emit(runId, type, data = {}) {
    if (this.onEvent) {
      try { this.onEvent(runId, type, data); } catch { /* ignore */ }
    }
  }

  /**
   * 生成子 agent 的 messages 数组
   */
  _buildMessages(task, allowedTools) {
    const tools = allowedTools || ["shell", "file-read", "file-search"];

    // 获取扩展提示词片段（aux 类型）
    const extSections = getExtensionPromptSections ? getExtensionPromptSections("aux") : [];

    let systemPrompt = buildSubAgentSystemPrompt({
      workingDir: this.workingDir,
      allowedTools: tools,
      toolDefinitions: TOOL_DEFINITIONS
    });

    // 追加扩展提示词
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
   * @returns {Promise<string>} 子 agent 结果文本
   */
  async _executeSubAgent(runId, task, opts = {}) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`子 agent ${runId} 不存在`);

    const allowedTools = opts.tools || ["shell", "file-read", "file-search"];
    const signal = run.abortController?.signal;
    const maxTurns = opts.maxTurns ?? this.maxTurns;

    const messages = this._buildMessages(task, allowedTools);
    const toolResults = []; // 累积工具结果用于最终输出

    let sessionId = null;
    let parentMessageId = null;
    let turns = 0;

    while (turns < maxTurns) {
      if (signal?.aborted) {
        run.status = RUN_STATES.CANCELLED;
        run.completedAt = Date.now();
        this._emit(runId, "cancelled", { turns });
        return "[已取消]";
      }

      turns++;

      const prompt = sessionId
        ? task  // 续聊时用原始任务作为 prompt（简化）
        : buildPromptFromMessages(messages);

      const providerOpts = {
        prompt,
        model: this.auxModel || undefined,
        accountId: this.auxProvider.getDefaultAccount?.()?.id
      };
      if (sessionId) {
        providerOpts.sessionId = sessionId;
        providerOpts.parentMessageId = parentMessageId;
      }

      try {
        const resp = await this.auxProvider.startCompletion(messages, providerOpts);

        if (!resp || !resp.ok) {
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

        let thinkingText = "";
        let responseText = "";

        if (this.auxProvider.name === "qwen") {
          const pending = [];
          let done = false, error = null;
          const consumePromise = consumeQwenStream(resp.body, (delta) => {
            pending.push(delta);
          }).then(() => { done = true; }).catch((err) => { error = err; done = true; });

          let idx = 0;
          while (!done || idx < pending.length) {
            if (signal?.aborted) {
              run.status = RUN_STATES.CANCELLED;
              run.completedAt = Date.now();
              return "[已取消]";
            }
            while (idx < pending.length) {
              const delta = pending[idx++];
              if (delta.kind === "thinking") thinkingText += delta.text;
              else responseText += delta.text;
            }
            if (done) break;
            await new Promise((r) => setTimeout(r, 10));
          }
          if (error) throw error;
          await consumePromise;
        } else if (this.auxProvider.name === "deepseek") {
          // DeepSeek: 使用 streamDeltasWithMessageId
          const { streamDeltasWithMessageId } = await import("../../providers/deepseek/chat.js");
          const stream = streamDeltasWithMessageId(resp);
          for await (const delta of stream.deltas) {
            if (signal?.aborted) {
              run.status = RUN_STATES.CANCELLED;
              run.completedAt = Date.now();
              return "[已取消]";
            }
            if (delta.kind === "thinking") thinkingText += delta.text;
            else responseText += delta.text;
          }
          if (stream.messageId) {
            parentMessageId = stream.messageId;
          }
        } else {
          // GLM / 其他: 使用通用 SSE 流消费
          const { consumeGlmStream } = await import("../../bridge.js");
          await consumeGlmStream(resp.body, (delta) => {
            if (delta.kind === "thinking") thinkingText += delta.text;
            else responseText += delta.text;
          });
        }

        // 解析工具调用
        const parsedCalls = parseToolCallsFromText(responseText);

        if (parsedCalls.length > 0) {
          // 执行工具调用
          for (const call of parsedCalls) {
            if (signal?.aborted) {
              run.status = RUN_STATES.CANCELLED;
              run.completedAt = Date.now();
              return "[已取消]";
            }

            const toolName = call.name;
            let params = {};
            try {
              params = typeof call.input === "string" ? JSON.parse(call.input) : (call.input || {});
            } catch { params = {}; }

            // 检查工具是否在允许列表中
            if (!allowedTools.includes(toolName)) {
              toolResults.push(`[跳过] 工具 ${toolName} 不在允许列表中`);
              continue;
            }

            this._emit(runId, "tool_start", { toolName, params });

            const toolResult = await executeToolCall(toolName, params, {
              workingDir: this.workingDir,
              taskList: [],
              shellTimeout: 60000
            });

            const resultText = formatToolResultCompact(toolName, toolResult.result);
            toolResults.push(`--- ${toolName} ---\n${resultText}`);

            this._emit(runId, "tool_result", { toolName, result: toolResult.result });

            // 如果是 shell 且有错误，记录到 toolResults
            if (toolName === "shell" && toolResult.result?.error) {
              toolResults.push(`Shell 执行错误: ${toolResult.result.error}`);
            }
          }

          // 更新 messages 以继续循环（续聊）
          messages.push({ role: "assistant", content: responseText });
          for (const call of parsedCalls) {
            const callResult = toolResults[toolResults.length - 1] || "";
            messages.push({ role: "tool", content: callResult });
          }
          // 续聊：使用 sessionId 继续
          continue;
        }

        // 无工具调用 → 子 agent 完成
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
        // 检查是否是取消
        if (signal?.aborted) {
          run.status = RUN_STATES.CANCELLED;
          run.completedAt = Date.now();
          this._emit(runId, "cancelled", { turns });
          return "[已取消]";
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
    run.status = RUN_STATES.COMPLETED;
    run.result = `达到最大轮次 (${maxTurns})，停止执行`;
    run.completedAt = Date.now();
    this._emit(runId, "completed", { result: run.result, turns });
    return `[达到最大轮次] 子 agent 执行了 ${maxTurns} 轮工具调用，结果：\n${toolResults.join("\n\n")}`;
  }

  /**
   * 生成一个子 agent 并等待完成
   * @param {string} task - 任务描述
   * @param {object} [opts]
   * @param {string[]} [opts.tools] - 允许的工具列表
   * @param {number} [opts.maxTurns] - 最大工具调用轮次
   * @returns {Promise<{ id: string, task: string, status: string, result: string, error?: string }>}
   */
  async spawnAndWait(task, opts = {}) {
    const runId = this._genRunId();
    const abortController = new AbortController();

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

    // 设置超时
    let timeoutHandle = null;
    if (this.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (run.status === RUN_STATES.PENDING || run.status === RUN_STATES.RUNNING) {
          abortController.abort();
          run.status = RUN_STATES.TIMED_OUT;
          run.error = `子 agent 超时 (${this.timeoutMs}ms)`;
          run.completedAt = Date.now();
          this._emit(runId, "timed_out", { timeoutMs: this.timeoutMs });
        }
      }, this.timeoutMs);
    }

    this._emit(runId, "spawned", { task, tools: opts.tools });

    try {
      run.status = RUN_STATES.RUNNING;
      this._emit(runId, "running", {});

      const result = await this._executeSubAgent(runId, task, opts);

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
   * @param {Array<{ task: string, tools?: string[], maxTurns?: number }>} tasks
   * @param {number} [concurrency=3] - 最大并发数
   * @returns {Promise<Array<{ id: string, task: string, status: string, result: string, error?: string }>>}
   */
  async spawnParallel(tasks, concurrency = 3) {
    if (!tasks || tasks.length === 0) return [];
    if (tasks.length === 1) {
      const r = await this.spawnAndWait(tasks[0].task, tasks[0]);
      return [r];
    }

    // 分批执行
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

  /**
   * 取消指定的子 agent
   * @param {string} runId
   * @returns {boolean}
   */
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

  /**
   * 取消所有运行中的子 agent
   */
  cancelAll() {
    let count = 0;
    for (const [id, run] of this.runs) {
      if (this.cancel(id)) count++;
    }
    return count;
  }

  /**
   * 获取运行状态
   * @param {string} runId
   * @returns {SubagentRun | undefined}
   */
  get(runId) {
    return this.runs.get(runId);
  }

  /**
   * 列出所有运行
   * @param {string} [status] - 过滤状态
   * @returns {SubagentRun[]}
   */
  list(status) {
    const all = [...this.runs.values()];
    if (status) return all.filter((r) => r.status === status);
    return all;
  }

  /**
   * 清理已完成的运行（释放内存）
   * @param {number} [olderThanMs=300000] - 清理多久前完成的（默认 5 分钟）
   */
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

export { RUN_STATES };
