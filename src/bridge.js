/**
 * OpenAI ↔ DeepSeek 协议桥接层
 * 参考 deepseek2api 项目：
 *   openai-bridge.js + openai-completion-runner.js
 *   openai-tool-prompt.js + openai-tool-parser.js + openai-tool-sieve.js
 */
import { randomUUID } from "node:crypto";
import { createDeepseekDeltaDecoder, createSseParser } from "./utils/sse.js";

// ── Constants ──

const THINK_OPEN = "<think>\n";
const THINK_CLOSE = "\n</think>\n";

// ── Prompt 构建（基本）──

export function buildPromptFromMessages(messages) {
  return messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content ?? ""}`)
    .join("\n\n");
}

// ── 模型解析 ──

const MODEL_MAP = {
  "deepseek-chat-fast": { modelType: "default", thinkingEnabled: false },
  "deepseek-chat-fast-search": { modelType: "default", thinkingEnabled: false, searchEnabled: true },
  "deepseek-reasoner-fast": { modelType: "default", thinkingEnabled: true },
  "deepseek-reasoner-fast-search": { modelType: "default", thinkingEnabled: true, searchEnabled: true },
  "deepseek-chat-expert": { modelType: "expert", thinkingEnabled: false },
  "deepseek-chat-expert-search": { modelType: "expert", thinkingEnabled: false, searchEnabled: true },
  "deepseek-reasoner-expert": { modelType: "expert", thinkingEnabled: true },
  "deepseek-reasoner-expert-search": { modelType: "expert", thinkingEnabled: true, searchEnabled: true }
};

export function resolveModelConfig(modelId) {
  const id = modelId || "deepseek-chat-fast";
  return MODEL_MAP[id] || MODEL_MAP["deepseek-chat-fast"];
}

// ── Chat completion body (DeepSeek 格式) ──

export function buildChatCompletionBody({ sessionId, prompt, model }) {
  const config = resolveModelConfig(model);
  return {
    chat_session_id: sessionId,
    parent_message_id: null,
    model_type: config.modelType,
    prompt,
    ref_file_ids: [],
    thinking_enabled: config.thinkingEnabled,
    search_enabled: config.searchEnabled || false,
    preempt: false
  };
}

// ── Thinking 标签包装（已添加换行支持）──

function createThinkingTagger() {
  let currentKind = "response";

  return {
    flush() {
      if (currentKind === "thinking") {
        currentKind = "response";
        return THINK_CLOSE;
      }
      return "";
    },
    push(delta) {
      if (!delta?.text) return "";
      let prefix = "";
      if (delta.kind !== currentKind) {
        if (currentKind === "thinking") prefix += THINK_CLOSE;
        if (delta.kind === "thinking") prefix += THINK_OPEN;
        currentKind = delta.kind;
      }
      return prefix + delta.text;
    }
  };
}

// ── 流式响应消费者（带 thinking 标签）──

async function consumeTaggedStream(bodyStream, onText) {
  if (!bodyStream) return;

  const decoder = new TextDecoder();
  const deltaDecoder = createDeepseekDeltaDecoder();
  const tagger = createThinkingTagger();
  const parser = createSseParser(({ data }) => {
    if (!data) return;
    try {
      const delta = deltaDecoder.consume(data);
      const text = tagger.push(delta);
      if (text) onText(text);
    } catch {
      // skip unparseable frames
    }
  });

  for await (const chunk of bodyStream) {
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.flush();
  const suffix = tagger.flush();
  if (suffix) onText(suffix);
}

// ── 流式响应（原始 deltas，无标签，供 CLI 使用）──

export async function* consumeRawStream(bodyStream) {
  if (!bodyStream) return;

  const decoder = new TextDecoder();
  const deltaDecoder = createDeepseekDeltaDecoder();
  const pending = [];

  const parser = createSseParser(({ data }) => {
    if (!data) return;
    try {
      const delta = deltaDecoder.consume(data);
      if (delta) pending.push(delta);
    } catch {
      // skip unparseable frames
    }
  });

  for await (const chunk of bodyStream) {
    pending.length = 0;
    parser.push(decoder.decode(chunk, { stream: true }));
    for (const d of pending) yield d;
  }
  pending.length = 0;
  parser.flush();
  for (const d of pending) yield d;
}

// ═══════════════════════════════════════════════════
//  Qwen SSE 解码器和流消费
// ═══════════════════════════════════════════════════

/**
 * 将 Qwen SSE 数据行（choices[0].delta）解析为 { kind, text } delta。
 * - reasoning_content → { kind: "thinking", text }
 * - content → { kind: "response", text }
 */
export function createQwenDeltaDecoder() {
  return {
    consume(jsonStr) {
      try {
        const obj = JSON.parse(jsonStr);
        const choice = obj?.choices?.[0];
        if (!choice) return null;
        const delta = choice.delta;
        if (!delta) return null;

        if (delta.reasoning_content) {
          return { kind: "thinking", text: delta.reasoning_content };
        }
        if (delta.content) {
          return { kind: "response", text: delta.content };
        }
        return null;
      } catch {
        return null;
      }
    }
  };
}

/**
 * 消费 Qwen 的 SSE 流，在 thinking / response 切换时插入 <think> 标签。
 */
export async function consumeQwenStream(bodyStream, onText) {
  if (!bodyStream) return;

  const decoder = new TextDecoder();
  const deltaDecoder = createQwenDeltaDecoder();
  const tagger = createThinkingTagger();
  const parser = createSseParser(({ data }) => {
    if (!data) return;
    try {
      const delta = deltaDecoder.consume(data);
      const text = tagger.push(delta);
      if (text) onText(text);
    } catch {
      // skip unparseable frames
    }
  });

  for await (const chunk of bodyStream) {
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.flush();
  const suffix = tagger.flush();
  if (suffix) onText(suffix);
}

// ═══════════════════════════════════════════════════
//  Tool / function-call 支持
//  参考 deepseek2api 项目的 openai-tool-prompt.js
//  + openai-tool-parser.js + openai-tool-sieve.js
// ═══════════════════════════════════════════════════

// ── 通用 helpers ──

function toStringSafe(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function toJsonText(value, fallback = "{}") {
  if (typeof value === "string") return value.trim() || fallback;
  try { return JSON.stringify(value ?? {}) || fallback; } catch { return fallback; }
}

function normalizeContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.output_text === "string") return item.output_text;
      if (typeof item.content === "string") return item.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function getToolFunction(tool) {
  if (!tool || typeof tool !== "object") return null;
  return tool.function && typeof tool.function === "object" ? tool.function : tool;
}

function getToolName(tool) {
  return toStringSafe(getToolFunction(tool)?.name).trim();
}

// ── Prompt 构建：工具调用历史格式化 ──

function toCdata(text) {
  return toStringSafe(text).replaceAll("]]>", "]]]]><![CDATA[>");
}

function formatPromptToolCalls(toolCalls, toolNameById) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return "";

  const blocks = toolCalls
    .map((call) => {
      const name = getToolName(call);
      const callId = toStringSafe(call?.id).trim();
      const fn = getToolFunction(call);
      const argumentsText = toJsonText(fn?.arguments ?? fn?.input);

      if (!name) return "";
      if (callId) toolNameById.set(callId, name);

      return [
        "  <tool_call>",
        `    <tool_name>${name}</tool_name>`,
        `    <parameters><![CDATA[${toCdata(argumentsText)}]]></parameters>`,
        "  </tool_call>"
      ].join("\n");
    })
    .filter(Boolean);

  return blocks.length ? `<tool_calls>\n${blocks.join("\n")}\n</tool_calls>` : "";
}

function normalizeAssistantPromptContent(message, toolNameById) {
  const content = normalizeContentText(message?.content).trim();
  const toolHistory = formatPromptToolCalls(message?.tool_calls, toolNameById);

  if (!content) return toolHistory;
  if (!toolHistory) return content;
  return `${content}\n\n${toolHistory}`;
}

function normalizeToolPromptContent(message, toolNameById) {
  const content = normalizeContentText(message?.content).trim() || "null";
  const toolName = toolNameById.get(toStringSafe(message?.tool_call_id).trim())
    || toStringSafe(message?.name).trim();
  return toolName ? `Tool result for ${toolName}:\n${content}` : content;
}

function normalizeMessagesForPrompt(messages) {
  const toolNameById = new Map();

  return (messages ?? []).flatMap((message) => {
    const role = toStringSafe(message?.role).trim().toLowerCase() || "user";

    if (role === "assistant") {
      const content = normalizeAssistantPromptContent(message, toolNameById);
      return content ? [{ role, content }] : [];
    }

    if (role === "tool" || role === "function") {
      return [{ role: "tool", content: normalizeToolPromptContent(message, toolNameById) }];
    }

    if (role === "system") {
      return [{ role, content: normalizeContentText(message?.content) }];
    }

    return [{ role: role === "developer" ? "system" : role, content: normalizeContentText(message?.content) }];
  });
}

// ── Prompt 构建：工具 schema 注入 ──

function formatToolSchema(tool) {
  const definition = getToolFunction(tool);
  const name = getToolName(tool);
  if (!name) return "";

  return [
    `Tool: ${name}`,
    `Description: ${toStringSafe(definition?.description).trim() || "No description available"}`,
    `Parameters: ${toJsonText(definition?.parameters)}`
  ].join("\n");
}

function buildToolPrompt(allowedToolNames, tools) {
  const allowed = new Set(allowedToolNames);
  const toolSchemas = (tools ?? [])
    .filter((tool) => allowed.has(getToolName(tool)))
    .map(formatToolSchema)
    .filter(Boolean);

  if (!toolSchemas.length) return "";

  return [
    "You have access to these tools:",
    "",
    toolSchemas.join("\n\n"),
    "",
    "When calling tools, emit raw XML inline at the exact point where the tool call should appear.",
    "You may include normal assistant text before and/or after the XML block when appropriate.",
    "Do not wrap the XML in markdown code fences.",
    "",
    "<tool_calls>",
    "  <tool_call>",
    "    <tool_name>TOOL_NAME_HERE</tool_name>",
    "    <parameters>{\"key\":\"value\"}</parameters>",
    "  </tool_call>",
    "</tool_calls>",
    "",
    "RULES:",
    "1) Output raw XML block exactly where the tool call should happen.",
    "2) <parameters> MUST contain a strict JSON object with double-quoted keys.",
    "3) Multiple tools go inside one <tool_calls> root.",
    "4) Use only declared tool names and exact schema field names.",
    "5) If you do not need a tool, answer normally without XML."
  ].join("\n");
}

function injectToolPrompt(messages, tools, allowedToolNames) {
  if (!allowedToolNames?.length) return messages;

  const toolPrompt = buildToolPrompt(allowedToolNames, tools);
  if (!toolPrompt) return messages;

  const systemIndex = messages.findIndex((m) => m.role === "system");
  if (systemIndex === -1) {
    return [{ role: "system", content: toolPrompt }, ...messages];
  }

  const updated = [...messages];
  updated[systemIndex] = {
    ...updated[systemIndex],
    content: [updated[systemIndex].content, toolPrompt].filter(Boolean).join("\n\n")
  };
  return updated;
}

/**
 * 构建带工具支持的 OpenAI 风格 prompt。
 * @returns {{ prompt: string, toolNames: string[] }}
 */
export function buildOpenAiPrompt({ messages, tools, toolChoice }) {
  const declaredToolNames = Array.isArray(tools) ? tools.map(getToolName).filter(Boolean) : [];

  // 解析 tool_choice
  let allowedToolNames = [];
  if (declaredToolNames.length > 0) {
    if (toolChoice === undefined || toolChoice === null || toolChoice === "auto") {
      allowedToolNames = declaredToolNames;
    } else if (toolChoice === "none") {
      allowedToolNames = [];
    } else if (toolChoice === "required") {
      allowedToolNames = declaredToolNames;
    } else if (toolChoice && typeof toolChoice === "object" && toStringSafe(toolChoice.type).trim() === "function") {
      const forcedName = toStringSafe(toolChoice.function?.name ?? toolChoice.name).trim();
      if (forcedName && declaredToolNames.includes(forcedName)) {
        allowedToolNames = [forcedName];
      }
    }
  }

  // 也检查消息中是否有 tool_calls / tool role（历史工具调用）
  const hasToolHistory = Array.isArray(messages) && messages.some(
    (m) => toStringSafe(m?.role).trim().toLowerCase() === "tool" || Array.isArray(m?.tool_calls)
  );
  const needsToolInjection = allowedToolNames.length > 0 || hasToolHistory;

  let normalized = normalizeMessagesForPrompt(messages ?? []);
  if (needsToolInjection) {
    normalized = injectToolPrompt(normalized, tools ?? [], allowedToolNames);
  }

  return {
    prompt: buildPromptFromMessages(normalized),
    toolNames: allowedToolNames
  };
}

// ── 工具调用解析（从 XML 响应中提取 tool_calls）──
//  参考 openai-tool-parser.js

const TOOL_BLOCK_PATTERN = /<(?:[a-z0-9_:-]+:)?(tool_call|function_call|invoke)\b([^>]*)>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?\1>/gi;
const TOOL_SELFCLOSE_PATTERN = /<(?:[a-z0-9_:-]+:)?invoke\b([^>]*)\/>/gi;
const TOOL_KV_PATTERN = /<(?:[a-z0-9_:-]+:)?([a-z0-9_.-]+)\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?\1>/gi;
const TOOL_NAME_PATTERNS = Object.freeze([
  /<(?:[a-z0-9_:-]+:)?tool_name\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?tool_name>/i,
  /<(?:[a-z0-9_:-]+:)?function_name\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?function_name>/i,
  /<(?:[a-z0-9_:-]+:)?name\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?name>/i,
  /<(?:[a-z0-9_:-]+:)?function\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?function>/i
]);
const TOOL_ARGS_PATTERNS = Object.freeze([
  /<(?:[a-z0-9_:-]+:)?input\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?input>/i,
  /<(?:[a-z0-9_:-]+:)?arguments\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?arguments>/i,
  /<(?:[a-z0-9_:-]+:)?argument\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?argument>/i,
  /<(?:[a-z0-9_:-]+:)?parameters\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?parameters>/i,
  /<(?:[a-z0-9_:-]+:)?parameter\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?parameter>/i,
  /<(?:[a-z0-9_:-]+:)?args\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?args>/i,
  /<(?:[a-z0-9_:-]+:)?params\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?params>/i
]);
const TOOL_ATTR_PATTERN = /(name|function|tool)\s*=\s*"([^"]+)"/i;

function stripFencedCodeBlocks(text) {
  return toStringSafe(text).replace(/```[\s\S]*?```/g, " ");
}

function decodeXmlText(text) {
  const raw = toStringSafe(text).trim();
  const cdataMatch = raw.match(/^<!\[CDATA\[([\s\S]*?)]]>$/i);
  const source = cdataMatch?.[1] ?? raw;
  return source
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#039;", "'")
    .replaceAll("&#x27;", "'");
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function findTagValue(text, patterns) {
  const source = toStringSafe(text);
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1] !== undefined) return decodeXmlText(match[1]);
  }
  return "";
}

function appendMarkupValue(output, key, value) {
  if (!Object.hasOwn(output, key)) { output[key] = value; return; }
  const current = output[key];
  output[key] = Array.isArray(current) ? [...current, value] : [current, value];
}

function parseMarkupValue(raw) {
  const text = decodeXmlText(raw);
  if (!text.trim()) return "";
  if (text.includes("<") && text.includes(">")) {
    const nested = parseMarkupInput(text);
    if (nested && Object.keys(nested).length > 0) return nested;
  }
  const parsedJson = parseJsonObject(text);
  if (parsedJson) return parsedJson;
  try { return JSON.parse(text); } catch { return text; }
}

function parseMarkupObject(text) {
  const output = {};
  for (const match of toStringSafe(text).matchAll(TOOL_KV_PATTERN)) {
    const key = toStringSafe(match[1]).trim();
    if (!key) continue;
    appendMarkupValue(output, key, parseMarkupValue(match[2]));
  }
  return output;
}

function parseMarkupInput(raw) {
  const text = decodeXmlText(raw);
  const markupObject = parseMarkupObject(text);
  if (Object.keys(markupObject).length > 0) return markupObject;
  return parseJsonObject(text) ?? {};
}

function buildParsedToolCall(name, argumentsText) {
  const normalized = argumentsText.trim() ? argumentsText.trim() : "{}";
  return {
    id: `call_${randomUUID().replaceAll("-", "")}`,
    name,
    argumentsText: normalized,
    input: parseJsonObject(normalized) ?? parseMarkupInput(normalized)
  };
}

function parseMarkupBlock(attrs, inner) {
  const jsonTool = parseJsonObject(inner);
  if (jsonTool?.name) {
    return buildParsedToolCall(jsonTool.name, JSON.stringify(jsonTool.input ?? {}));
  }

  const attrName = attrs.match(TOOL_ATTR_PATTERN)?.[2] ?? "";
  const name = attrName.trim() || findTagValue(inner, TOOL_NAME_PATTERNS).trim();
  if (!name) return null;

  const argsRaw = findTagValue(inner, TOOL_ARGS_PATTERNS);
  const parsedInput = argsRaw ? parseMarkupInput(argsRaw) : parseMarkupObject(inner);
  const argumentsText = JSON.stringify(parsedInput && Object.keys(parsedInput).length ? parsedInput : {});
  return buildParsedToolCall(name, argumentsText);
}

function parseMarkupToolCalls(text) {
  const output = [];
  const source = toStringSafe(text).trim();

  for (const match of source.matchAll(TOOL_BLOCK_PATTERN)) {
    const parsed = parseMarkupBlock(toStringSafe(match[2]).trim(), toStringSafe(match[3]).trim());
    if (parsed) output.push(parsed);
  }

  for (const match of source.matchAll(TOOL_SELFCLOSE_PATTERN)) {
    const parsed = parseMarkupBlock(toStringSafe(match[1]).trim(), "");
    if (parsed) output.push(parsed);
  }

  return output;
}

function filterAllowedToolCalls(calls, allowedToolNames) {
  if (!allowedToolNames?.length) return calls;
  const allowed = new Set(allowedToolNames.map((n) => toStringSafe(n).trim()).filter(Boolean));
  return calls.filter((call) => allowed.has(call.name));
}

export function parseToolCallsFromText(text, allowedToolNames = []) {
  const source = toStringSafe(text);
  if (!source.trim()) return [];
  if (!stripFencedCodeBlocks(source).match(/<(tool_calls|tool_call|function_call|invoke|tool_use)\b/i)) {
    return [];
  }
  return filterAllowedToolCalls(parseMarkupToolCalls(source), allowedToolNames);
}

// ── 流式工具调用拦截器（Tool Sieve）──
//  参考 openai-tool-sieve.js

const TOOL_CAPTURE_PAIRS = Object.freeze([
  { open: "<tool_calls", close: "</tool_calls>" },
  { open: "<function_calls", close: "</function_calls>" },
  { open: "<tool_call", close: "</tool_call>" },
  { open: "<function_call", close: "</function_call>" },
  { open: "<invoke", close: "</invoke>" },
  { open: "<tool_use", close: "</tool_use>" }
]);

function isInsideCodeFence(state, prefix) {
  const combined = `${state.emittedText}${prefix}`;
  return (combined.match(/```/g)?.length ?? 0) % 2 === 1;
}

function findPartialToolTagStart(text) {
  const lastIndex = text.lastIndexOf("<");
  if (lastIndex < 0 || text.slice(lastIndex).includes(">")) return -1;
  const tail = text.slice(lastIndex).toLowerCase();
  return TOOL_CAPTURE_PAIRS.some(({ open }) => open.startsWith(tail)) ? lastIndex : -1;
}

function findToolSegmentStart(state, text) {
  const lower = text.toLowerCase();
  let offset = 0;

  while (offset < lower.length) {
    let bestIndex = -1;
    let matchedOpen = "";

    for (const { open } of TOOL_CAPTURE_PAIRS) {
      const index = lower.indexOf(open, offset);
      if (index >= 0 && (bestIndex === -1 || index < bestIndex)) {
        bestIndex = index;
        matchedOpen = open;
      }
    }

    if (bestIndex === -1) return -1;
    if (!isInsideCodeFence(state, text.slice(0, bestIndex))) return bestIndex;
    offset = bestIndex + matchedOpen.length;
  }

  return -1;
}

function splitSafeContent(state, text) {
  const partialStart = findPartialToolTagStart(text);
  if (partialStart < 0 || isInsideCodeFence(state, text.slice(0, partialStart))) {
    return { safe: text, hold: "" };
  }
  return { safe: text.slice(0, partialStart), hold: text.slice(partialStart) };
}

function consumeCapturedToolBlock(captured, allowedToolNames) {
  const lower = captured.toLowerCase();

  for (const pair of TOOL_CAPTURE_PAIRS) {
    const openIndex = lower.indexOf(pair.open);
    if (openIndex < 0) continue;

    const closeIndex = lower.lastIndexOf(pair.close);
    if (closeIndex < openIndex) return { ready: false };

    const closeEnd = closeIndex + pair.close.length;
    return {
      ready: true,
      prefix: captured.slice(0, openIndex),
      calls: parseToolCallsFromText(captured.slice(openIndex, closeEnd), allowedToolNames),
      suffix: captured.slice(closeEnd)
    };
  }

  return { ready: true, prefix: captured, calls: [], suffix: "" };
}

function pushTextEvent(state, events, text) {
  if (!text) return;
  state.emittedText += text;
  events.push({ type: "text", text });
}

function createToolSieve(allowedToolNames = []) {
  const state = {
    allowedToolNames,
    capture: "",
    capturing: false,
    emittedText: "",
    pending: ""
  };

  function drain() {
    const events = [];

    while (true) {
      if (state.capturing) {
        if (state.pending) {
          state.capture += state.pending;
          state.pending = "";
        }

        const consumed = consumeCapturedToolBlock(state.capture, state.allowedToolNames);
        if (!consumed.ready) break;

        state.capture = "";
        state.capturing = false;
        pushTextEvent(state, events, consumed.prefix ?? "");
        if (consumed.calls?.length) {
          events.push({ type: "tool_calls", calls: consumed.calls });
        }
        state.pending = `${consumed.suffix ?? ""}${state.pending}`;
        continue;
      }

      if (!state.pending) break;

      const start = findToolSegmentStart(state, state.pending);
      if (start >= 0) {
        pushTextEvent(state, events, state.pending.slice(0, start));
        state.capture = state.pending.slice(start);
        state.pending = "";
        state.capturing = true;
        continue;
      }

      const { safe, hold } = splitSafeContent(state, state.pending);
      state.pending = hold;
      pushTextEvent(state, events, safe);
      break;
    }

    return events;
  }

  return Object.freeze({
    flush() {
      const events = drain();

      if (state.capturing) {
        const consumed = consumeCapturedToolBlock(state.capture, state.allowedToolNames);
        if (consumed.ready) {
          pushTextEvent(state, events, consumed.prefix ?? "");
          if (consumed.calls?.length) {
            events.push({ type: "tool_calls", calls: consumed.calls });
          }
          pushTextEvent(state, events, consumed.suffix ?? "");
        } else {
          pushTextEvent(state, events, state.capture);
        }
      }

      pushTextEvent(state, events, state.pending);
      state.capture = "";
      state.capturing = false;
      state.pending = "";
      return events;
    },
    push(chunk) {
      state.pending += typeof chunk === "string" ? chunk : String(chunk ?? "");
      return drain();
    }
  });
}

function extractToolAwareOutput(text, allowedToolNames = []) {
  const sieve = createToolSieve(allowedToolNames);
  const rawEvents = [...sieve.push(text), ...sieve.flush()];

  // 合并相邻的 text 事件
  const events = rawEvents.reduce((output, event) => {
    if (!output.length || event.type !== "text" || output.at(-1).type !== "text") {
      output.push(event);
      return output;
    }
    output[output.length - 1] = { type: "text", text: `${output.at(-1).text}${event.text}` };
    return output;
  }, []);

  return {
    events,
    content: events.filter((e) => e.type === "text").map((e) => e.text).join(""),
    toolCalls: events.flatMap((e) => e.type === "tool_calls" ? e.calls ?? [] : [])
  };
}

// ── OpenAI 兼容响应 payload 构建 ──

function createCompletionId() {
  return `chatcmpl-${randomUUID()}`;
}

function buildChunkPayload(completionId, model, delta, finishReason) {
  const choice = finishReason
    ? { index: 0, delta: {}, finish_reason: finishReason }
    : { index: 0, delta };
  return {
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice]
  };
}

function createChatToolCalls(calls, startIndex = 0) {
  return calls.map((call, offset) => ({
    index: startIndex + offset,
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: call.argumentsText || ""
    }
  }));
}

// ── 流式响应（OpenAI SSE 格式, 支持工具调用）──

export async function streamOpenAiResponse({ bodyStream, model, response, toolNames = [] }) {
  const completionId = createCompletionId();
  const hasTools = toolNames.length > 0;
  const toolSieve = hasTools ? createToolSieve(toolNames) : null;
  let toolCallIndex = 0;
  let sawToolCall = false;

  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no"
  });
  response.flushHeaders?.();

  function writeSse(payload) {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  // 第一个 chunk: role
  writeSse(buildChunkPayload(completionId, model, { role: "assistant" }));

  const emitToolCalls = (calls) => {
    if (!calls.length) return;
    sawToolCall = true;
    writeSse(buildChunkPayload(completionId, model, {
      tool_calls: createChatToolCalls(calls, toolCallIndex)
    }));
    toolCallIndex += calls.length;
  };

  await consumeTaggedStream(bodyStream, (text) => {
    if (!toolSieve) {
      writeSse(buildChunkPayload(completionId, model, { content: text }));
      return;
    }

    const events = toolSieve.push(text);
    for (const event of events) {
      if (event.type === "tool_calls") {
        emitToolCalls(event.calls ?? []);
      } else if (event.text) {
        writeSse(buildChunkPayload(completionId, model, { content: event.text }));
      }
    }
  });

  // sieve flush
  if (toolSieve) {
    const tailEvents = toolSieve.flush();
    for (const event of tailEvents) {
      if (event.type === "tool_calls") {
        emitToolCalls(event.calls ?? []);
      } else if (event.text) {
        writeSse(buildChunkPayload(completionId, model, { content: event.text }));
      }
    }
  }

  // 最终 chunk
  writeSse(buildChunkPayload(completionId, model, {}, sawToolCall ? "tool_calls" : "stop"));
  response.end("data: [DONE]\n\n");
}

// ── 收集完整响应（非流式, 支持工具调用）──

export async function collectOpenAiResponse({ bodyStream, model, toolNames = [] }) {
  let rawContent = "";

  await consumeTaggedStream(bodyStream, (text) => {
    rawContent += text;
  });

  const hasTools = toolNames.length > 0;
  let content = rawContent;
  let toolCalls = [];

  if (hasTools) {
    const parsed = extractToolAwareOutput(rawContent, toolNames);
    content = parsed.content;
    toolCalls = parsed.toolCalls;
  }

  if (toolCalls.length > 0) {
    return {
      id: createCompletionId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: content.length ? content : null,
          tool_calls: createChatToolCalls(toolCalls)
        }
      }]
    };
  }

  return {
    id: createCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content }
    }]
  };
}

// ═══════════════════════════════════════════════════
//  Qwen 兼容的 OpenAI SSE 响应（使用 Qwen SSE 解码器）
// ═══════════════════════════════════════════════════

export async function streamQwenOpenAiResponse({ bodyStream, model, response, toolNames = [] }) {
  const completionId = createCompletionId();
  const hasTools = toolNames.length > 0;
  const toolSieve = hasTools ? createToolSieve(toolNames) : null;
  let toolCallIndex = 0;
  let sawToolCall = false;

  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no"
  });
  response.flushHeaders?.();

  function writeSse(payload) {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  writeSse(buildChunkPayload(completionId, model, { role: "assistant" }));

  const emitToolCalls = (calls) => {
    if (!calls.length) return;
    sawToolCall = true;
    writeSse(buildChunkPayload(completionId, model, {
      tool_calls: createChatToolCalls(calls, toolCallIndex)
    }));
    toolCallIndex += calls.length;
  };

  await consumeQwenStream(bodyStream, (text) => {
    if (!toolSieve) {
      writeSse(buildChunkPayload(completionId, model, { content: text }));
      return;
    }

    const events = toolSieve.push(text);
    for (const event of events) {
      if (event.type === "tool_calls") {
        emitToolCalls(event.calls ?? []);
      } else if (event.text) {
        writeSse(buildChunkPayload(completionId, model, { content: event.text }));
      }
    }
  });

  if (toolSieve) {
    const tailEvents = toolSieve.flush();
    for (const event of tailEvents) {
      if (event.type === "tool_calls") {
        emitToolCalls(event.calls ?? []);
      } else if (event.text) {
        writeSse(buildChunkPayload(completionId, model, { content: event.text }));
      }
    }
  }

  writeSse(buildChunkPayload(completionId, model, {}, sawToolCall ? "tool_calls" : "stop"));
  response.end("data: [DONE]\n\n");
}

export async function collectQwenOpenAiResponse({ bodyStream, model, toolNames = [] }) {
  let rawContent = "";

  await consumeQwenStream(bodyStream, (text) => {
    rawContent += text;
  });

  const hasTools = toolNames.length > 0;
  let content = rawContent;
  let toolCalls = [];

  if (hasTools) {
    const parsed = extractToolAwareOutput(rawContent, toolNames);
    content = parsed.content;
    toolCalls = parsed.toolCalls;
  }

  if (toolCalls.length > 0) {
    return {
      id: createCompletionId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: content.length ? content : null,
          tool_calls: createChatToolCalls(toolCalls)
        }
      }]
    };
  }

  return {
    id: createCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content }
    }]
  };
}
