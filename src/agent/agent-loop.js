import {
  parseToolCallsFromText, buildPromptFromMessages,
  consumeQwenStream, streamDeltasWithMessageId
} from "../bridge.js";
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
      return `FILE-READ: ${result.path}\n${content}`;
    }
    case "file-write": {
      return result.success
        ? `FILE-WRITE: ${result.path}\n${result.message || ""}`
        : `写入失败: ${result.error}`;
    }
    case "file-search": {
      if (result.error) return `搜索失败: ${result.error}`;
      if (result.type === "filename") {
        const files = (result.files || []).slice(0, 20).join("\n");
        return `SEARCH: ${result.pattern}\n找到 ${result.count} 个文件:\n${files}`;
      }
      if (result.type === "content") {
        const lines = (result.matches || []).slice(0, 20)
          .map((m) => `${m.file}:${m.line}  ${m.text}`).join("\n");
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

// ── 续聊 prompt 构建 ──

/**
 * 构建续聊 prompt：思考内容 + 本轮所有工具结果。
 * 发送前剥离思考中的工具调用预演（避免 AI 混淆）。
 */
function buildContinuationPrompt(thinking, toolResults) {
  const parts = [];

  // 附上思考内容（剥离工具调用预演）
  if (thinking && thinking.trim()) {
    const cleanThinking = stripToolXml(thinking).trim();
    if (cleanThinking) {
      parts.push(`以下是上一轮的思考内容：\n\n<think>\n${cleanThinking}\n</think>`);
    }
  }

  // 所有工具结果
  if (toolResults.length > 0) {
    // parts.push("工具执行结果：\n");
    for (const r of toolResults) {
      parts.push(r);
      parts.push("");
    }
  }

  return parts.join("\n").trim();
}

// ── 流消费者（分离 thinking / response，捕获 messageId）──

function createAgentStreamConsumer(provider, resp) {
  if (provider.name === "qwen") {
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
//  Agent 循环（Session 复用 + 思考保留 + 多工具结果）
// ═══════════════════════════════════════════════

export async function* runAgentLoop(userInput, context) {
  const {
    mainProvider, composite, workingDir,
    maxIterations = 15, signal
  } = context;

  appendMessage(composite, { role: "user", content: userInput, source: "user" });

  let iteration = 0;
  let sessionId = null;
  let parentMessageId = null;

  while (iteration < maxIterations) {
    if (signal?.aborted) {
      yield { type: "done", text: "已中断" };
      return;
    }

    iteration++;

    const messages = buildMessagesForMain(composite, workingDir);

    // 首轮：完整 prompt；续聊：思考 + 所有工具结果
    let prompt;
    if (sessionId) {
      // 续聊：收集本轮新消息（思考 + 工具结果）构建续聊 prompt
      const newMsgs = composite.messages.slice(composite._turnStartIdx || 0);
      const thinking = newMsgs.find((m) => m.role === "assistant")?.thinking || "";
      const toolResults = newMsgs
        .filter((m) => m.role === "tool")
        .map((m) => m.content || "");
      prompt = buildContinuationPrompt(thinking, toolResults);
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

      if (!sessionId && resp._sessionId) {
        sessionId = resp._sessionId;
      }

      // ── 流式消费：分离 thinking / response ──
      const consumer = createAgentStreamConsumer(mainProvider, resp);
      let thinkingText = "";
      let responseText = "";

      for await (const event of consumer.deltas()) {
        if (event.type === "thinking") {
          thinkingText += event.text;
        } else {
          responseText += event.text;
        }
        yield event; // 渲染给 UI
      }

      if (consumer.messageId) {
        parentMessageId = consumer.messageId;
      }

      // ── 只从 response 中解析工具调用（thinking 中的预演不算）──
      const parsedCalls = parseToolCallsFromText(responseText);

      if (parsedCalls.length > 0) {
        // 标记本轮起始位置（续聊时从这里取消息）
        composite._turnStartIdx = composite.messages.length;

        // 保存 AI 响应（含思考，后续续聊会用到）
        appendMessage(composite, {
          role: "assistant",
          content: responseText,
          thinking: thinkingText,   // 保留思考供续聊使用
          source: "main"
        });

        // 执行所有工具，收集结果
        const toolResultTexts = [];

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
          toolResultTexts.push(resultText);

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

        continue;
      }

      // 无工具调用 → 最终响应
      const cleanText = stripToolXml(responseText);
      if (cleanText.trim()) {
        appendMessage(composite, {
          role: "assistant",
          content: cleanText,
          thinking: thinkingText,
          source: "main"
        });
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

// ── 辅助 AI 调用 ──

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
