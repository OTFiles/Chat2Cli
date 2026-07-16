import {
  parseToolCallsFromText, buildPromptFromMessages,
  consumeQwenStream, createToolSieve
} from "../bridge.js";
import { streamDeltasWithMessageId } from "../providers/deepseek/chat.js";
import { executeToolCall, TOOL_DEFINITIONS } from "./tools/registry.js";
import { buildMainSystemPrompt } from "./prompts/main-system.js";
import { buildAuxSystemPrompt } from "./prompts/aux-system.js";
import { appendMessage, updateTaskList, saveComposite } from "./storage/composite.js";

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
    default: return JSON.stringify(result).slice(0, 1000);
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

function buildMessagesForAux(composite, workingDir, task) {
  return [
    { role: "system", content: buildAuxSystemPrompt({ workingDir, toolDefinitions: TOOL_DEFINITIONS }) },
    { role: "user", content: task }
  ];
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

          yield { type: "tool_start", toolName, toolParams: params };

          const toolResult = await executeToolCall(toolName, params, {
            workingDir,
            taskList: composite.taskList || [],
            shellTimeout
          });

          if (toolResult.requiresApproval) {
            yield { type: "tool_start", toolName, requiresApproval: true, toolResult: toolResult.result };
            continue;
          }

          const resultText = formatToolResultCompact(toolName, toolResult.result);
          appendMessage(composite, {
            role: "tool", content: resultText, source: "tool",
            toolName, toolResult: toolResult.result
          });

          yield { type: "tool_result", toolName, toolResult: toolResult.result, text: resultText };

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

// ── 辅助 AI ──

export async function* runAuxCall(userInput, context) {
  const { auxProvider, composite, workingDir } = context;
  appendMessage(composite, { role: "user", content: `[辅助AI任务] ${userInput}`, source: "user" });
  const messages = buildMessagesForAux(composite, workingDir, userInput);
  const prompt = buildPromptFromMessages(messages);

  try {
    const resp = await auxProvider.startCompletion(messages, {
      prompt, model: context.auxModel, accountId: composite.aux.accountId
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
