import {
  parseToolCallsFromText, buildPromptFromMessages,
  consumeQwenStream, createToolSieve
} from "../bridge.js";
import { streamDeltasWithMessageId } from "../providers/deepseek/chat.js";
import { executeToolCall, TOOL_DEFINITIONS } from "./tools/registry.js";
import { buildMainSystemPrompt } from "./prompts/main-system.js";
import { appendMessage, updateTaskList, saveComposite } from "./storage/composite.js";
import { getExtensionPromptSections } from "../extensions/index.js";
import { SubagentManager } from "./subagents/manager.js";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";
import chalk from "chalk";

// ═══════════════════════════════════════════════
//  图片生成结果处理（agent 模式）
// ═══════════════════════════════════════════════

const GENERATED_DIR = "generated";

/**
 * 下载图片到 workingDir/generated/ 目录
 * @returns {Promise<string>} 本地文件路径
 */
async function downloadImageToDir(url, workingDir) {
  const dir = join(workingDir, GENERATED_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`);

  const mime = resp.headers.get("content-type") || "image/png";
  const extMap = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
  const ext = extMap[mime] || extname(url) || ".png";

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `image_${ts}${ext}`;
  const filepath = join(dir, filename);

  const buf = Buffer.from(await resp.arrayBuffer());
  const ws = createWriteStream(filepath);
  await new Promise((resolve, reject) => {
    ws.on("finish", resolve);
    ws.on("error", reject);
    ws.end(buf);
  });

  return filepath;
}

/**
 * 处理图片生成结果：下载到本地并产出相关 yield 事件
 */
async function* handleImageResult(resp, workingDir, role) {
  try {
    const filepath = await downloadImageToDir(resp.url, workingDir);
    const relPath = `${GENERATED_DIR}/${filepath.split("/").pop()}`;
    const text = `已生成图片，保存至 ${relPath}（原始URL: ${resp.url}）`;
    yield { type: "info", text, source: role };
  } catch (err) {
    // 下载失败时至少返回原始 URL
    yield { type: "info", text: `已生成图片: ${resp.url}（自动下载失败: ${err.message}）`, source: role };
  }
}

// ═══════════════════════════════════════════════
//  Token 计数
// ═══════════════════════════════════════════════

/** 粗略 token 估算：英文字符 ~0.3 token，中文字符 ~0.6 token */
function countTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    tokens += ch.codePointAt(0) > 127 ? 0.6 : 0.3;
  }
  return Math.ceil(tokens);
}

function countMessagesTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += countTokens(msg.content || "");
    total += countTokens(msg.thinking || "");
    total += countTokens(msg.toolName || "");
  }
  return total;
}

const DEFAULT_MAX_TOKENS = 1000000;  // 1M
const SUMMARIZE_THRESHOLD = 0.7;

// ── 工具结果紧凑格式化 ──

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
    case "file-write": {
      return result.success ? `FILE-WRITE: ${result.path}\n${result.message || ""}` : `写入失败: ${result.error}`;
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
    case "todo": {
      if (result.action === "list") {
        const items = (result.tasks || []).map((t) => `[${t.status}] ${t.content}`).join("\n");
        return items || "(空)";
      }
      if (result.action === "update") {
        const items = (result.tasks || []).map((t) => `[${t.status}] ${t.content}`).join("\n");
        return `TODO: ${result.message || "任务清单"}\n${items}`;
      }
      return JSON.stringify(result).slice(0, 500);
    }
    case "delegate": {
      if (result.summary) return `DELEGATE: ${result.summary.slice(0, 4000)}`;
      if (result.result) return `DELEGATE: ${String(result.result).slice(0, 4000)}`;
      return `DELEGATE: ${result.status || "完成"}`;
    }
    default: return JSON.stringify(result).slice(0, 1000);
  }
}

// ── 消息构建 ──

function buildMessagesForMain(composite, workingDir) {
  // 合并内置工具 + 扩展工具（TOOL_DEFINITIONS 已在 initExtensions 时扩充）
  const allTools = TOOL_DEFINITIONS;

  // 获取扩展提示词片段
  const extSections = getExtensionPromptSections("main");

  let systemPrompt = buildMainSystemPrompt({
    workingDir,
    taskList: composite.taskList || [],
    toolDefinitions: allTools
  });

  // 追加扩展提示词片段
  if (extSections.length > 0) {
    systemPrompt += "\n\n" + extSections.join("\n\n");
  }

  const messages = [{ role: "system", content: systemPrompt }];
  const recentMessages = (composite.messages || []).slice(-40);
  for (const msg of recentMessages) {
    if (msg.role === "tool") {
      messages.push({ role: "tool", content: (msg.content || "").slice(0, 4000) });
    } else if (msg.role === "assistant") {
      messages.push({ role: "assistant", content: stripToolXml(msg.content) });
    } else if (msg.role === "user") {
      if (msg.content?.startsWith("[辅助AI任务]")) continue;
      messages.push({ role: "user", content: msg.content });
    }
  }
  return messages;
}

function stripToolXml(text) {
  if (!text) return "";
  return text.replace(/<invoke\b[^>]*\/>/gi, "").replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "").trim();
}

// ── 续聊 prompt 构建 ──

function buildContinuationPrompt(thinking, toolResults) {
  const parts = [];
  if (thinking && thinking.trim()) {
    const cleanThinking = stripToolXml(thinking).trim();
    if (cleanThinking) parts.push(`上一轮的思考内容：\n\n<think>\n${cleanThinking}\n</think>`);
  }
  if (toolResults.length > 0) {
    parts.push("工具执行结果：\n");
    for (const r of toolResults) {
      const content = (r || "").trim();
      if (content) parts.push(content + "\n");
    }
  }
  const result = parts.join("\n").trim();
  // 兜底：如果结果为空，返回一个最小有效 prompt
  return result || "请继续。";
}

// ── 流消费者 ──

function createAgentStreamConsumer(provider, resp) {
  if (provider.name === "qwen") {
    // 渐进式流消费（Qwen 不需要 messageId，会话由 chat_id 维护）
    const pending = [];
    let done = false;
    let error = null;

    // 在后台消费流，边收边填充 pending
    const consumePromise = consumeQwenStream(resp.body, (delta) => {
      pending.push({ type: delta.kind, text: delta.text });
    }).then(() => { done = true; }).catch((err) => { error = err; done = true; });

    return {
      async *deltas() {
        let idx = 0;
        while (!done || idx < pending.length) {
          while (idx < pending.length) {
            yield pending[idx++];
          }
          if (done) break;
          // 让出控制权，等待更多 delta 到达
          await new Promise((r) => setTimeout(r, 10));
        }
        if (error) throw error;
        await consumePromise;
      },
      get messageId() { return null; }
    };
  }
  const stream = streamDeltasWithMessageId(resp);
  return {
    async *deltas() {
      for await (const delta of stream.deltas) yield { type: delta.kind, text: delta.text };
    },
    get messageId() { return stream.messageId; }
  };
}

// ═══════════════════════════════════════════════
//  Agent 循环
// ═══════════════════════════════════════════════

export async function* runAgentLoop(userInput, context) {
  const {
    mainProvider, composite, workingDir,
    maxTokens = DEFAULT_MAX_TOKENS,
    shellTimeout = 120000,
    signal
  } = context;

  // ── 创建子 Agent 管理器（使用主 AI provider）──
  const subagentManager = mainProvider ? new SubagentManager({
    provider: mainProvider,
    model: context.mainModel || null,
    workingDir,
    timeoutMs: 120000,
    maxTurns: 5,
    onEvent: (runId, eventType, data) => {
      // 子 agent 内部进度回调 — 在 executeDelegate 的 await 期间
      // 直接输出到 stdout 提供实时反馈
      if (eventType === "spawned") {
        process.stdout.write(`  ${chalk.dim("[Sub]")} 子Agent已启动: ${(data.task || "").slice(0, 60)}...\n`);
      } else if (eventType === "running") {
        process.stdout.write(`  ${chalk.dim("[..]")} 子Agent工作中...\n`);
      } else if (eventType === "tool_start") {
        process.stdout.write(`  ${chalk.dim("[>>]")} 子Agent调用: ${data.toolName}\n`);
      } else if (eventType === "completed") {
        process.stdout.write(`  ${chalk.dim("[OK]")} 子Agent完成 (${data.turns} 轮, ${data.toolCount || 0} 次工具调用)\n`);
      } else if (eventType === "failed") {
        process.stdout.write(`  ${chalk.red("[FAIL]")} 子Agent失败: ${(data.error || "").slice(0, 100)}\n`);
      } else if (eventType === "cancelled") {
        process.stdout.write(`  ${chalk.yellow("[!]")} 子Agent已取消\n`);
      } else if (eventType === "timed_out") {
        process.stdout.write(`  ${chalk.yellow("[TIMEOUT]")} 子Agent超时 (${data.timeoutMs}ms)\n`);
      }
    }
  }) : null;

  // 子 agent 事件回调（用于 executeDelegate 内部转发事件）
  const onSubagentEvent = (runId, eventType, data) => {
    // 这些事件在 executeDelegate 的 Promise 内部触发
    // 由于我们在 async generator 中，无法直接 yield
    // 所以通过 process.stdout 直接输出（简单方案）
    // TUI 中的渲染通过 SubagentManager 的 onEvent 回调处理
  };

  let sessionId = composite.main?.sessionId || null;
  let parentMessageId = composite.main?.parentMessageId || null;

  // ── Token 超限 → 自动总结 ──
  const currentTokens = countMessagesTokens(composite.messages || []);
  if (currentTokens > maxTokens * SUMMARIZE_THRESHOLD) {
    yield { type: "info", text: `对话上下文已达 ${Math.round(currentTokens / maxTokens * 100)}% token，正在总结...` };

    try {
      const summaryPrompt = "请用 1000 字左右的中文总结以上对话的关键内容、已完成的步骤和当前进度。只输出总结，不要做其他回应。";
      const msgs = sessionId
        ? [{ role: "user", content: summaryPrompt }]
        : [...buildMessagesForMain(composite, workingDir), { role: "user", content: summaryPrompt }];

      const summaryResp = await mainProvider.startCompletion(msgs, {
        prompt: summaryPrompt,
        model: context.mainModel,
        accountId: composite.main.accountId,
        sessionId,
        parentMessageId
      });

      if (summaryResp && summaryResp.ok) {
        if (!sessionId && summaryResp._sessionId) {
          // 临时 session，用完即弃
        }
        const consumer = createAgentStreamConsumer(mainProvider, summaryResp);
        let summaryText = "";
        for await (const event of consumer.deltas()) {
          if (event.type !== "thinking") summaryText += event.text;
        }

        if (summaryText.trim()) {
          // 保存总结到本地
          appendMessage(composite, { role: "assistant", content: `[自动总结] ${summaryText.trim()}`, thinking: "", source: "main" });

          // 开启新会话
          sessionId = null;
          parentMessageId = null;
          composite.main.sessionId = null;
          composite.main.parentMessageId = null;
          composite._turnStartIdx = composite.messages.length;
          saveComposite(composite);

          yield { type: "info", text: "总结完成，已开启新会话" };
        }
      }
    } catch (err) {
      yield { type: "info", text: `总结失败: ${err.message}，继续当前会话` };
    }
  }

  // ── 正常处理用户输入 ──
  appendMessage(composite, { role: "user", content: userInput, source: "user" });
  composite._turnStartIdx = composite.messages.length;

  while (true) {
    if (signal?.aborted) {
      yield { type: "done", text: "已中断" };
      return;
    }

    const messages = buildMessagesForMain(composite, workingDir);

    let prompt;
    if (sessionId) {
      const newMsgs = composite.messages.slice(composite._turnStartIdx || 0);
      const toolResults = newMsgs.filter((m) => m.role === "tool");
      if (toolResults.length > 0) {
        const thinking = newMsgs.find((m) => m.role === "assistant")?.thinking || "";
        prompt = buildContinuationPrompt(thinking, toolResults.map((m) => m.content || ""));
      } else {
        prompt = userInput;
      }
    } else {
      prompt = buildPromptFromMessages(messages);
    }

    const providerOpts = {
      prompt,
      model: context.mainModel || undefined,
      accountId: composite.main.accountId,
    };
    if (sessionId) {
      providerOpts.sessionId = sessionId;
      providerOpts.parentMessageId = parentMessageId;
    }

    try {
      const resp = await mainProvider.startCompletion(messages, providerOpts);

      // 图片/视频生成结果（非 Response 流）
      if (resp && resp._isImageResult) {
        for await (const event of handleImageResult(resp, workingDir, "main")) {
          yield event;
        }
        appendMessage(composite, {
          role: "assistant", content: `[图片生成] ${resp.url}`,
          source: "main"
        });
        yield { type: "done", text: resp.url };
        return;
      }

      if (!resp || !resp.ok) {
        yield { type: "error", text: `${mainProvider.label} 请求失败 (HTTP ${resp?.status || "?"})` };
        return;
      }

      if (!sessionId && resp._sessionId) {
        sessionId = resp._sessionId;
        composite.main.sessionId = sessionId;
        saveComposite(composite);
      }

      const consumer = createAgentStreamConsumer(mainProvider, resp);
      const toolSieve = createToolSieve([]);
      let thinkingText = "";
      let responseText = "";

      for await (const event of consumer.deltas()) {
        if (event.type === "thinking") {
          thinkingText += event.text;
          yield event;
        } else {
          responseText += event.text;
          const sieveEvents = toolSieve.push(event.text);
          for (const se of sieveEvents) {
            if (se.type === "text" && se.text) {
              yield { type: "response", text: se.text };
            }
          }
        }
      }

      if (toolSieve) {
        const tailEvents = toolSieve.flush();
        for (const se of tailEvents) {
          if (se.type === "text" && se.text) {
            yield { type: "response", text: se.text };
          }
        }
      }

      if (consumer.messageId) {
        parentMessageId = consumer.messageId;
        composite.main.parentMessageId = consumer.messageId;
      }

      const parsedCalls = parseToolCallsFromText(responseText);

      // 检查是否有工具调用结果需要继续（即使 responseText 为空）
      // 场景：纯 reasoning 模型可能仅输出 thinking，但仍需处理之前的工具结果

      if (parsedCalls.length > 0) {
        composite._turnStartIdx = composite.messages.length;

        appendMessage(composite, {
          role: "assistant", content: responseText,
          thinking: thinkingText, source: "main"
        });

        for (const call of parsedCalls) {
          if (signal?.aborted) {
            yield { type: "done", text: "已中断" };
            return;
          }

          const toolName = call.name;
          let params = {};
          try {
            params = typeof call.input === "string" ? JSON.parse(call.input) : (call.input || {});
          } catch { params = {}; }

          // ── 钩子: pre:tool_execute ──
          if (context.hooks) {
            const hookResult = await context.hooks.emit("pre:tool_execute", { toolName, params }, { cwd: workingDir });
            if (hookResult.blocked) {
              yield { type: "info", text: `工具 ${toolName} 被扩展阻止: ${hookResult.reason}` };
              continue;
            }
            if (hookResult.modified) {
              params = hookResult.payload?.params || params;
            }
          }

          // ── 委托工具特殊处理：yield subagent_spawn 事件 ──
          if (toolName === "delegate") {
            const taskDesc = params.task || (params.tasks ? `${params.tasks.length} 个并发子任务` : "未知任务");
            yield { type: "subagent_spawn", task: taskDesc, params };
          } else if (toolName === "ask") {
            // ask 工具不走正常 tool_start，直接在这里处理
          } else {
            yield { type: "tool_start", toolName, toolParams: params };
          }

          // ── 执行工具 ──
          let toolResult = await executeToolCall(toolName, params, {
            workingDir,
            taskList: composite.taskList || [],
            shellTimeout,
            subagentManager,
            onSubagentEvent
          });

          // ── 审批 / ask 处理（Promise 桥接）──
          if (toolResult.requiresApproval) {
            const approvalType = toolResult.approvalType || "shell";
            let resolution;
            const approvalPromise = new Promise((r) => { resolution = r; });

            if (approvalType === "ask") {
              yield {
                type: "ask_user",
                question: toolResult.result.question,
                options: toolResult.result.options,
                toolName,
                params,
                resolve: resolution
              };
            } else {
              yield {
                type: "approval_required",
                toolName,
                approvalType,
                params,
                warning: toolResult.result.warning || "此操作需要审批",
                command: toolResult.result.command || params.command || "",
                resolve: resolution
              };
            }

            const decision = await approvalPromise;
            if (!decision || !decision.approved) {
              const denyMsg = approvalType === "ask"
                ? "用户未回答"
                : `工具 ${toolName} 被用户拒绝${decision?.reason ? `: ${decision.reason}` : ""}`;
              const denyText = `[拒绝] ${denyMsg}`;
              appendMessage(composite, {
                role: "tool", content: denyText, source: "tool",
                toolName, toolResult: { error: denyMsg }
              });
              if (toolName !== "delegate") {
                yield { type: "info", text: denyText };
              }
              continue;
            }

            // 批准：ask 类直接使用用户回答作为结果
            if (approvalType === "ask") {
              toolResult = { result: { answer: decision.answer || "", type: "ask" } };
            } else {
              // shell 等：用修改后的参数重新执行，_approved 标记绕过二次审批
              const redoParams = decision.modifiedParams
                ? { ...decision.modifiedParams, _approved: true }
                : { ...params, _approved: true };
              toolResult = await executeToolCall(toolName, redoParams, {
                workingDir,
                taskList: composite.taskList || [],
                shellTimeout,
                subagentManager,
                onSubagentEvent
              });
            }
          }

          // ── 委托工具特殊处理：yield subagent_result 事件 ──
          if (toolName === "delegate") {
            yield { type: "subagent_result", toolName, toolResult: toolResult.result, text: formatToolResultCompact(toolName, toolResult.result) };
          }

          // ── 钩子: post:tool_execute ──
          if (context.hooks) {
            const postResult = await context.hooks.emit("post:tool_execute",
              { toolName, params, result: toolResult.result },
              { cwd: workingDir }
            );
            if (postResult.modified && postResult.payload?.result) {
              toolResult.result = postResult.payload.result;
            }
          }

          const resultText = formatToolResultCompact(toolName, toolResult.result);
          appendMessage(composite, {
            role: "tool", content: resultText, source: "tool",
            toolName, toolResult: toolResult.result
          });

          // 非委托工具：yield tool_result；委托工具已在上面 yield subagent_result
          if (toolName !== "delegate") {
            yield { type: "tool_result", toolName, toolResult: toolResult.result, text: resultText };
          }

          if (toolName === "todo" && toolResult.result?.action === "update") {
            updateTaskList(composite, toolResult.result.tasks);
          }
        }
        continue;
      }

      const cleanText = stripToolXml(responseText);
      if (cleanText.trim()) {
        appendMessage(composite, {
          role: "assistant", content: cleanText, thinking: thinkingText, source: "main"
        });
      }
      yield { type: "done", text: cleanText };
      return;

    } catch (err) {
      yield { type: "error", text: err.message };
      return;
    }
  }
}
