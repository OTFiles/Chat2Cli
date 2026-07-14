import {
  parseToolCallsFromText, buildPromptFromMessages,
  consumeQwenStream
} from "../bridge.js";
import { streamDeltasWithMessageId } from "../providers/deepseek/chat.js";
import { executeToolCall, TOOL_DEFINITIONS } from "./tools/registry.js";
import { buildMainSystemPrompt } from "./prompts/main-system.js";
import { buildAuxSystemPrompt } from "./prompts/aux-system.js";
import { appendMessage, updateTaskList } from "./storage/composite.js";

// ── 工具结果紧凑格式化（发送给 AI）──

function formatToolResultCompact(toolName, result) {
  if (!result) return "";

  switch (toolName) {
    case "shell": {
      const out = result.stderr || result.stdout || (result.error ? `错误: ${result.error}` : "(无输出)");
      return `SHELL: ${result.command || ""}\n${out.slice(0, 4000)}`;
    }
    case "file-read": {
      if (!result.success) return `读取失败: ${result.error}`;
      const content = (result.content || "").slice(0, 3000);
      return `(行 ${result.offset || 0}-${(result.offset || 0) + (result.lines || 0)} / 共 ${result.totalLines || "?"} 行)\n${content}`;
    }
    case "file-write": {
      return result.success
        ? `已写入: ${result.path}\n${result.message || ""}`
        : `写入失败: ${result.error}`;
    }
    case "file-search": {
      if (result.error) return `搜索失败: ${result.error}`;
      if (result.type === "filename") {
        const files = (result.files || []).slice(0, 20).join("\n");
        return `找到 ${result.count} 个文件:\n${files}`;
      }
      if (result.type === "content") {
        const lines = (result.matches || []).slice(0, 20)
          .map((m) => `${m.file}:${m.line}  ${m.text}`).join("\n");
        return `找到 ${result.count} 处匹配:\n${lines}`;
      }
      return `找到 ${result.count || 0} 个结果`;
    }
    case "todo": {
      if (result.action === "list") {
        const items = (result.tasks || []).map((t) => `[${t.status}] ${t.content}`).join("\n");
        return items || "(空)";
      }
      if (result.action === "update") {
        const items = (result.tasks || []).map((t) => `[${t.status}] ${t.content}`).join("\n");
        return `${result.message || "任务清单:"}\n${items}`;
      }
      return JSON.stringify(result).slice(0, 500);
    }
    default:
      return JSON.stringify(result).slice(0, 1000);
  }
}

// ── 消息构建 ──

function buildMessagesForMain(composite, workingDir) {
  const systemPrompt = buildMainSystemPrompt({
    workingDir,
    taskList: composite.taskList || [],
    toolDefinitions: TOOL_DEFINITIONS
  });

  const messages = [{ role: "system", content: systemPrompt }];

  const recentMessages = (composite.messages || []).slice(-40);
  for (const msg of recentMessages) {
    if (msg.role === "tool") {
      const content = typeof msg.content === "string" ? msg.content.slice(0, 4000) : msg.content;
      messages.push({ role: "tool", content });
    } else if (msg.role === "assistant") {
      messages.push({ role: "assistant", content: stripToolXml(msg.content) });
    } else if (msg.role === "user") {
      if (msg.content?.startsWith("[辅助AI任务]")) continue;
      messages.push({ role: "user", content: msg.content });
    }
  }

  return messages;
}

function buildMessagesForAux(composite, workingDir, task) {
  const systemPrompt = buildAuxSystemPrompt({
    workingDir,
    toolDefinitions: TOOL_DEFINITIONS
  });

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: task }
  ];
}

function stripToolXml(text) {
  if (!text) return "";
  return text
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "")
    .replace(/<tool_call[\s\S]*?<\/tool_call>/g, "")
    .trim();
}

// ── 流消费（带 messageId 捕获，用于 Agent 循环）──

/**
 * 消费 provider 响应流，yield { type, text } 事件。
 * DeepSeek：同时捕获 response_message_id 用于续聊。
 * Qwen：直接消费 SSE 流。
 *
 * 返回 { deltas, messageId }，messageId 在流消费完后可用。
 */
function createAgentStreamConsumer(provider, resp) {
  if (provider.name === "qwen") {
    // Qwen：收集所有 deltas 后一次性 yield
    return {
      async *deltas() {
        const pending = [];
        await consumeQwenStream(resp.body, (delta) => {
          pending.push({ type: delta.kind, text: delta.text });
        });
        for (const d of pending) yield d;
      },
      get messageId() { return null; }
    };
  }

  // DeepSeek：流式消费 + 捕获 messageId
  const stream = streamDeltasWithMessageId(resp);
  return {
    async *deltas() {
      for await (const delta of stream.deltas) {
        yield { type: delta.kind, text: delta.text };
      }
    },
    get messageId() { return stream.messageId; }
  };
}

// ═══════════════════════════════════════════════
//  Agent 循环（含 Session 复用）
// ═══════════════════════════════════════════════

/**
 * 启动 Agent 循环
 * 首轮创建会话发送完整 prompt；后续轮复用同一个会话仅发送工具结果。
 */
export async function* runAgentLoop(userInput, context) {
  const {
    mainProvider, composite, workingDir,
    maxIterations = 15, signal
  } = context;

  appendMessage(composite, { role: "user", content: userInput, source: "user" });

  let iteration = 0;
  let sessionId = null;       // DeepSeek session / Qwen chatId
  let parentMessageId = null; // DeepSeek response_message_id（续聊用）

  while (iteration < maxIterations) {
    if (signal?.aborted) {
      yield { type: "done", text: "已中断" };
      return;
    }

    iteration++;

    // 构建消息列表
    const messages = buildMessagesForMain(composite, workingDir);

    // 首轮：完整 prompt；续聊：仅发送最后一条消息（工具结果）
    let prompt;
    if (sessionId) {
      const lastMsg = messages[messages.length - 1];
      prompt = lastMsg?.content || "";
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

      if (!resp || !resp.ok) {
        yield { type: "error", text: `${mainProvider.label} 请求失败 (HTTP ${resp?.status || "?"})` };
        return;
      }

      // 首轮保存 sessionId
      if (!sessionId && resp._sessionId) {
        sessionId = resp._sessionId;
      }

      // 流式消费 + 捕获 messageId
      const consumer = createAgentStreamConsumer(mainProvider, resp);
      let fullText = "";

      for await (const event of consumer.deltas()) {
        fullText += event.text || "";
        yield event; // { type: "thinking"|"response", text }
      }

      // DeepSeek：保存 messageId 供下次续聊
      if (consumer.messageId) {
        parentMessageId = consumer.messageId;
      }

      // 解析工具调用
      const parsedCalls = parseToolCallsFromText(fullText);

      if (parsedCalls.length > 0) {
        // 保存 AI 完整响应
        appendMessage(composite, { role: "assistant", content: fullText, source: "main" });

        for (const call of parsedCalls) {
          if (signal?.aborted) {
            yield { type: "done", text: "已中断" };
            return;
          }

          const toolName = call.name;

          let params = {};
          try {
            params = typeof call.input === "string"
              ? JSON.parse(call.input)
              : (call.input || {});
          } catch {
            params = {};
          }

          yield { type: "tool_start", toolName, text: `🔧 ${toolName}` };

          const toolResult = await executeToolCall(toolName, params, {
            workingDir,
            taskList: composite.taskList || []
          });

          if (toolResult.requiresApproval) {
            yield {
              type: "tool_start",
              toolName,
              requiresApproval: true,
              toolResult: toolResult.result
            };
            continue;
          }

          const resultText = formatToolResultCompact(toolName, toolResult.result);
          appendMessage(composite, {
            role: "tool",
            content: resultText,
            source: "tool",
            toolName,
            toolResult: toolResult.result
          });

          yield { type: "tool_result", toolName, toolResult: toolResult.result, text: resultText };

          if (toolName === "todo" && toolResult.result?.action === "update") {
            updateTaskList(composite, toolResult.result.tasks);
          }
        }

        // 继续循环让 AI 处理工具结果
        continue;
      }

      // 无工具调用 → 最终响应
      const cleanText = stripToolXml(fullText);
      if (cleanText.trim()) {
        appendMessage(composite, { role: "assistant", content: cleanText, source: "main" });
      }
      yield { type: "done", text: cleanText };
      return;

    } catch (err) {
      yield { type: "error", text: err.message };
      return;
    }
  }

  yield { type: "error", text: `达到最大迭代次数 (${maxIterations})，请简化任务` };
}

// ── 辅助 AI 调用（单轮，不复用 session）──

/**
 * 辅助 AI 调用
 */
export async function* runAuxCall(userInput, context) {
  const { auxProvider, composite, workingDir } = context;

  appendMessage(composite, { role: "user", content: `[辅助AI任务] ${userInput}`, source: "user" });

  const messages = buildMessagesForAux(composite, workingDir, userInput);
  const prompt = buildPromptFromMessages(messages);

  try {
    const resp = await auxProvider.startCompletion(messages, {
      prompt,
      model: context.auxModel || undefined,
      accountId: composite.aux.accountId
    });

    if (!resp || !resp.ok) {
      yield { type: "error", text: `辅助 AI (${auxProvider.label}) 请求失败` };
      return;
    }

    const consumer = createAgentStreamConsumer(auxProvider, resp);
    let fullText = "";

    for await (const event of consumer.deltas()) {
      fullText += event.text || "";
      yield { ...event, source: "aux" };
    }

    appendMessage(composite, { role: "assistant", content: fullText, source: "aux" });
    yield { type: "done", text: fullText, source: "aux" };
  } catch (err) {
    yield { type: "error", text: err.message };
  }
}
