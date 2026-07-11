import { parseToolCallsFromText, buildPromptFromMessages, consumeQwenStream, consumeRawStream } from "../../bridge.js";
import { executeToolCall, TOOL_DEFINITIONS } from "../tools/registry.js";
import { buildMainSystemPrompt } from "../prompts/main-system.js";
import { buildAuxSystemPrompt } from "../prompts/aux-system.js";
import { appendMessage, updateTaskList } from "../storage/composite.js";

// ── 消息构建 ──

function buildMessagesForMain(composite, workingDir) {
  const systemPrompt = buildMainSystemPrompt({
    workingDir,
    taskList: composite.taskList || [],
    toolDefinitions: TOOL_DEFINITIONS
  });

  const messages = [{ role: "system", content: systemPrompt }];

  // 添加最近的对话历史（限制长度，避免超 context）
  const recentMessages = (composite.messages || []).slice(-40);
  for (const msg of recentMessages) {
    if (msg.role === "tool") {
      const content = typeof msg.content === "string" ? msg.content.slice(0, 2000) : msg.content;
      messages.push({ role: "tool", content: `工具 ${msg.toolName} 结果:\n${content}` });
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

/** 去除文本中的工具调用 XML，保留纯文本 */
function stripToolXml(text) {
  if (!text) return "";
  return text
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "")
    .replace(/<tool_call[\s\S]*?<\/tool_call>/g, "")
    .trim();
}

// ── 流消费 ──

async function* yieldStreamResponse(provider, resp) {
  if (provider.name === "qwen") {
    const pending = [];
    await consumeQwenStream(resp.body, (delta) => {
      pending.push(delta);
    });
    for (const d of pending) yield d;
  } else {
    for await (const delta of consumeRawStream(resp.body)) {
      yield delta;
    }
  }
}

// ═══════════════════════════════════════════════
//  Agent 循环
// ═══════════════════════════════════════════════

/**
 * 启动 Agent 循环
 * @param {string} userInput - 用户输入
 * @param {object} context
 * @param {object} context.mainProvider - 主 AI provider
 * @param {object} context.auxProvider - 辅助 AI provider
 * @param {object} context.composite - 复合对话对象
 * @param {string} context.workingDir
 * @param {number} [context.maxIterations=15]
 * @param {AbortSignal} [context.signal]
 * @returns {AsyncGenerator<{type, text?, toolName?, toolResult?, requiresApproval?, source?}>}
 */
export async function* runAgentLoop(userInput, context) {
  const {
    mainProvider, auxProvider, composite, workingDir,
    maxIterations = 15, signal
  } = context;

  // 添加用户消息
  appendMessage(composite, { role: "user", content: userInput, source: "user" });

  let iteration = 0;

  while (iteration < maxIterations) {
    if (signal?.aborted) {
      yield { type: "done", text: "已中断" };
      return;
    }

    iteration++;

    const messages = buildMessagesForMain(composite, workingDir);
    const prompt = buildPromptFromMessages(messages);

    try {
      const resp = await mainProvider.startCompletion(messages, {
        prompt,
        model: composite.model || undefined,
        accountId: composite.main.accountId
      });

      if (!resp || !resp.ok) {
        yield { type: "error", text: `${mainProvider.label} 请求失败 (HTTP ${resp?.status || "?"})` };
        return;
      }

      // 流式输出 + 收集完整文本
      let fullText = "";
      for await (const delta of yieldStreamResponse(mainProvider, resp)) {
        fullText += delta.text || "";
        yield delta; // { kind: "thinking"|"response", text }
      }

      // 解析工具调用
      const toolNames = [];
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
          toolNames.push(toolName);

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
            // 不执行，等待外部审批
            continue;
          }

          const resultText = JSON.stringify(toolResult.result, null, 2);
          appendMessage(composite, {
            role: "tool",
            content: resultText,
            source: "tool",
            toolName,
            toolResult: toolResult.result
          });

          yield { type: "tool_result", toolName, toolResult: toolResult.result, text: resultText };

          // todo 工具的特殊处理
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
      accountId: composite.aux.accountId
    });

    if (!resp || !resp.ok) {
      yield { type: "error", text: `辅助 AI (${auxProvider.label}) 请求失败` };
      return;
    }

    let fullText = "";
    for await (const delta of yieldStreamResponse(auxProvider, resp)) {
      fullText += delta.text || "";
      yield { ...delta, source: "aux" };
    }

    appendMessage(composite, { role: "assistant", content: fullText, source: "aux" });
    yield { type: "done", text: fullText, source: "aux" };
  } catch (err) {
    yield { type: "error", text: err.message };
  }
}
