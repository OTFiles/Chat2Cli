/**
 * OpenAI ↔ DeepSeek 协议桥接层
 * 参考 deepseek2api 项目：
 *   openai-bridge.js + openai-completion-runner.js
 *   openai-tool-prompt.js + openai-tool-parser.js + openai-tool-sieve.js
 */
import { randomUUID } from "node:crypto";
import { createDeepseekDeltaDecoder, createSseParser } from "./utils/sse.js";

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

// ── 流式响应消费者（yield { kind, text } deltas）──

async function consumeStream(bodyStream, onDelta) {
  if (!bodyStream) return;

  const decoder = new TextDecoder();
  const deltaDecoder = createDeepseekDeltaDecoder();
  const parser = createSseParser(({ data }) => {
    if (!data) return;
    try {
      const deltas = deltaDecoder.consume(data);
      if (deltas && deltas.length > 0) {
        for (const d of deltas) onDelta(d);
      }
    } catch {
      // skip unparseable frames
    }
  });

  for await (const chunk of bodyStream) {
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.flush();
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
      const deltas = deltaDecoder.consume(data);
      if (deltas && deltas.length > 0) pending.push(...deltas);
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
 * 将 Qwen SSE 数据行解析为 { kind, text } delta 数组。
 * 严格对齐 Qwen2API：只处理 choices[0].delta.phase === 'think'|'answer'
 */
export function createQwenDeltaDecoder() {
  return {
    consume(jsonStr) {
      try {
        const obj = JSON.parse(jsonStr);

        // 先提取 response_id（必须在跳过 response.created 之前，否则会漏掉）
        const rid = obj?.response?.created?.response_id || obj?.response_id;

        // 跳过元数据事件（但已提取 rid）
        if (obj["response.created"]) {
          if (rid) return [{ kind: "__messageId", text: rid }];
          return [];
        }

        // 严格对齐 Qwen2API：只处理 choices[0].delta，且必须有 phase
        const delta = obj?.choices?.[0]?.delta;
        if (!delta) {
          if (rid) return [{ kind: "__messageId", text: rid }];
          return [];
        }

        const phase = delta.phase || "";
        const content = delta.content;

        // 无 phase 或 phase 非 think/answer → 丢弃（但仍提取 messageId）
        if (!content || (phase !== "think" && phase !== "answer")) {
          if (rid) return [{ kind: "__messageId", text: rid }];
          return [];
        }

        const result = [];
        if (rid) result.push({ kind: "__messageId", text: rid });
        if (phase === "think") {
          result.push({ kind: "thinking", text: content });
        } else {
          result.push({ kind: "response", text: content });
        }
        return result;
      } catch {
        return [];
      }
    }
  };
}

/**
 * 消费 Qwen 的 SSE 流，yield { kind, text } deltas。
 * 严格对齐 Qwen2API：只处理 choices[0].delta.phase === 'think'|'answer'
 */
export async function consumeQwenStream(bodyStream, onDelta) {
  if (!bodyStream) return;

  const decoder = new TextDecoder();
  const deltaDecoder = createQwenDeltaDecoder();
  const parser = createSseParser(({ data }) => {
    if (!data) return;
    try {
      const deltas = deltaDecoder.consume(data);
      if (deltas && deltas.length > 0) {
        for (const delta of deltas) onDelta(delta);
      }
    } catch {
      // skip unparseable frames
    }
  });

  for await (const chunk of bodyStream) {
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.flush();
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

      return `<invoke name="${name}">\n<![CDATA[${toCdata(argumentsText)}]]>\n</invoke>`;
    })
    .filter(Boolean);

  return blocks.join("\n");
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
    "<invoke name=\"TOOL_NAME\" param1=\"value1\" />",
    "",
    "For tools that need a content body (e.g. file-write), put the content between tags:",
    "<invoke name=\"file-write\" path=\"file.txt\" mode=\"create\">",
    "content here",
    "</invoke>",
    "",
    "RULES:",
    "1) Output raw XML block exactly where the tool call should happen.",
    "2) Attribute values containing double-quotes should use single-quote delimiters.",
    "3) Use only declared tool names and exact schema field names.",
    "4) If you do not need a tool, answer normally without XML."
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

// ── 工具调用解析（invoke 格式）──

/**
 * 引号感知的 <invoke> 标签查找器。
 * 追踪 " 和 ' 引号状态，只在引号外才识别 /> 和 > 为标签终止符。
 * 解决命令中包含 > (重定向), < (heredoc) 等 shell 运算符导致解析失败的问题。
 */
function findInvokeTags(text) {
  const results = [];
  const lower = text.toLowerCase();
  let pos = 0;

  while (pos < text.length) {
    const invokeStart = lower.indexOf("<invoke", pos);
    if (invokeStart === -1) break;

    // 确保 invoke 后是词边界，避免误匹配 <invoke-xxx>
    const afterName = invokeStart + 7;
    if (afterName < text.length && /[a-z0-9_-]/i.test(text[afterName])) {
      pos = afterName;
      continue;
    }

    // 追踪引号状态扫描属性区，找到真正的标签终止位置
    let i = afterName;
    let inDq = false, inSq = false;
    let selfClose = false;
    let bodyStart = -1;
    let attrEnd = -1;

    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length) { i += 2; continue; }
      if (ch === '"' && !inSq) { inDq = !inDq; i++; continue; }
      if (ch === "'" && !inDq) { inSq = !inSq; i++; continue; }
      // 只在引号外识别标签终止
      if (!inDq && !inSq) {
        if (ch === "/" && text[i + 1] === ">") { attrEnd = i; selfClose = true; i += 2; break; }
        if (ch === ">") { attrEnd = i; bodyStart = i + 1; i++; break; }
      }
      i++;
    }

    if (attrEnd === -1) { pos = afterName; continue; }

    const attrs = text.slice(afterName, attrEnd).trim();
    let inner = "";
    let endPos = i;

    if (!selfClose) {
      const closeIdx = lower.indexOf("</invoke>", bodyStart);
      if (closeIdx === -1) { pos = afterName; continue; }
      inner = text.slice(bodyStart, closeIdx);
      endPos = closeIdx + "</invoke>".length;
    }

    results.push({ attrs, inner, start: invokeStart, end: endPos });
    pos = endPos;
  }

  return results;
}

/** 引号感知的 /> 查找：在引号外找到第一个 /> 的位置，找不到返回 -1 */
function findSelfCloseIdx(text) {
  let inDq = false, inSq = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) { i++; continue; }
    if (ch === '"' && !inSq) { inDq = !inDq; continue; }
    if (ch === "'" && !inDq) { inSq = !inSq; continue; }
    if (!inDq && !inSq && ch === "/" && text[i + 1] === ">") return i;
  }
  return -1;
}

const ALL_ATTR_PATTERN = /([a-z0-9_.:-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi;

/** 解码 XML 实体（不 trim，用于属性值） */
function decodeXmlText(text) {
  return toStringSafe(text)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&#x27;", "'");
}

/** 解码实体 + 保留原样（用于标签体内容） */
function decodeBodyText(text) {
  return text
    .replace(/^<!\[CDATA\[([\s\S]*?)]]>$/i, "$1")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&#x27;", "'");
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/**
 * 从 XML 属性字符串中提取所有 key="value" / key='value' 对。
 * 使用状态机解析，智能处理 AI 常见错误：属性值内嵌套的引号
 * （例如 command="echo "hello"" → command 正确解析为 echo "hello"）
 */
function parseAllAttributes(attrs) {
  const s = toStringSafe(attrs).trim();
  const len = s.length;
  const result = {};

  // 快速路径：无嵌套引号时用原正则，性能更好
  if (!hasNestedQuotes(s)) {
    for (const match of s.matchAll(ALL_ATTR_PATTERN)) {
      const key = match[1].trim();
      if (!key || Object.hasOwn(result, key)) continue;
      const unquoted = match[2].slice(1, -1);
      const text = decodeXmlText(unquoted);
      try { result[key] = JSON.parse(text); } catch { result[key] = text; }
    }
    return result;
  }

  // 慢速路径：状态机解析，容忍值内嵌套引号
  return parseAttributesWithNestedQuotes(s);
}

/**
 * 探测属性字符串是否含嵌套引号。
 * 策略：用简易状态机追踪引号状态，当在引号值内遇到同种引号时，
 * 调用 wouldCloseAttribute 判断是否为真正的闭合。如果不是闭合，则是嵌套引号。
 */
function hasNestedQuotes(s) {
  let inDq = false, inSq = false;
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < len) { i++; continue; }
    if (ch === '"') {
      if (!inSq) {
        if (inDq && !wouldCloseAttribute(s, i, len)) return true;
        inDq = !inDq;
      }
    } else if (ch === "'") {
      if (!inDq) {
        if (inSq && !wouldCloseAttribute(s, i, len)) return true;
        inSq = !inSq;
      }
    }
  }
  return false;
}

/** 从 f 位置开始跳过空白，返回第一个非空白字符位置，-1 表达到末尾 */
function peekNextNonWs(s, from) {
  for (let j = from; j < s.length; j++) {
    if (!/\s/.test(s[j])) return j;
  }
  return -1;
}

/**
 * 状态机属性解析器，容忍双引号值内嵌套的双引号。
 * 判断"是否为真正的闭合引号的规则：
 *   " 后紧跟字母/数字（无空白）→ 值内嵌套引号
 *   " 后紧跟空白，且空白后是字母/数字 → 值内嵌套引号（如 echo "hello" world）
 *   " 后紧跟空白，且空白后是字母，再往后看是否有 = → 真正的闭合（下一个属性）
 *   " 后紧跟 /> 或 > → 真正的闭合
 *   " 后紧跟空白，且空白后是 /> 或 > → 真正的闭合
 */
function parseAttributesWithNestedQuotes(s) {
  const result = {};
  const len = s.length;
  let i = 0;

  while (i < len) {
    // 跳过空白
    while (i < len && /\s/.test(s[i])) i++;
    if (i >= len) break;

    // 解析 key
    const keyStart = i;
    while (i < len && /[a-z0-9_.:-]/i.test(s[i])) i++;
    const key = s.slice(keyStart, i).trim();
    if (!key) break;

    // 跳过 = 和空白
    while (i < len && /\s/.test(s[i])) i++;
    if (i >= len || s[i] !== '=') break;
    i++;
    while (i < len && /\s/.test(s[i])) i++;

    if (i >= len) break;
    const quote = s[i];
    let value;

    if (quote === '"' || quote === "'") {
      i++; // 跳过开始引号
      value = '';
      while (i < len) {
        // 转义字符
        if (s[i] === '\\' && i + 1 < len) {
          value += s[i + 1];
          i += 2;
          continue;
        }

        if (s[i] === quote) {
          // 探测：这是真正的闭合引号还是值内嵌套？
          if (wouldCloseAttribute(s, i, len)) {
            i++; // 真正的闭合
            break;
          }
          // 值内嵌套引号，保留
          value += s[i++];
        } else {
          value += s[i++];
        }
      }
    } else {
      // 无引号值
      const vStart = i;
      while (i < len && !/\s/.test(s[i]) && s[i] !== '/' && s[i] !== '>') i++;
      value = s.slice(vStart, i);
    }

    if (Object.hasOwn(result, key)) continue;
    const decoded = decodeXmlText(value);
    try { result[key] = JSON.parse(decoded); } catch { result[key] = decoded; }
  }

  return result;
}

/**
 * 判断 s[pos] 上的引号字符是否是属性的闭合引号。
 * 规则：引号后紧跟或跳过空白后出现以下模式之一即为闭合：
 *   1. /> 或 >（标签结束）
 *   2. [a-zA-Z]（下一个属性名）→ 进一步检查：如果后续在遇到下一个引号前能找到 = 号
 *   3. 到达字符串末尾
 * 如果后续先遇到同种引号（没有 = 号），说明当前引号是值内嵌套。
 */
function wouldCloseAttribute(s, pos, len) {
  if (pos + 1 >= len) return true; // 末尾 → 闭合

  const quote = s[pos];

  // 跳过空白
  let peek = pos + 1;
  while (peek < len && /\s/.test(s[peek])) peek++;

  if (peek >= len) return true; // 只有尾随空白 → 闭合

  const nextCh = s[peek];

  // /> 或 > → 闭合
  if (nextCh === '/' || nextCh === '>') return true;

  // 同种引号紧跟 → 值内嵌套（如 "" 空字符串场景，或相邻嵌套）
  if (nextCh === quote) return false;

  // 字母开头 → 可能是下一个属性名，也可能只是值内的英文内容
  if (/[a-zA-Z]/.test(nextCh)) {
    // 向前扫描：在遇到下一个同种引号之前，如果找到 = 号则是真闭合
    // 如果先遇到同种引号（没有中间的 =），则是值内嵌套
    for (let j = peek; j < len; j++) {
      if (s[j] === '\\' && j + 1 < len) { j++; continue; }
      if (s[j] === '/' || s[j] === '>') return false; // 标签结束前无 =，值内
      if (s[j] === quote) return false; // 遇到同种引号 → 当前引号是值内嵌套
      if (s[j] === '=') return true;    // 确认是下一个属性名
    }
    // 扫描完也没找到 = 或引号，保守当作闭合
    return true;
  }

  // 数字或其他字符 → 值内嵌套（如 echo "hello" 中的 "）
  return false;
}

function buildParsedToolCall(name, argumentsText) {
  const normalized = argumentsText.trim() || "{}";
  return {
    id: `call_${randomUUID().replaceAll("-", "")}`,
    name,
    argumentsText: normalized,
    input: parseJsonObject(normalized) ?? {}
  };
}

function parseMarkupBlock(attrs, inner) {
  const attrParams = parseAllAttributes(attrs);
  const name = (attrParams.name ?? "").trim();
  if (!name) return null;

  const { name: _, ...params } = attrParams;

  // 标签体文本 → content 参数（不 trim，保留首行空行给 file-write 处理）
  const innerText = inner.trim();
  if (innerText && !params.content) {
    params.content = decodeBodyText(inner);
  }

  return buildParsedToolCall(name, JSON.stringify(Object.keys(params).length ? params : {}));
}

function parseMarkupToolCalls(text) {
  const output = [];
  const source = toStringSafe(text).trim();
  for (const tag of findInvokeTags(source)) {
    const parsed = parseMarkupBlock(tag.attrs, tag.inner);
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
  if (!source.match(/<invoke\b/i)) return [];
  return filterAllowedToolCalls(parseMarkupToolCalls(source), allowedToolNames);
}

// ── 流式工具调用拦截器（Tool Sieve）──
//  参考 openai-tool-sieve.js

const TOOL_CAPTURE_PAIRS = Object.freeze([
  { open: "<invoke", close: "</invoke>" }
]);

function isInsideCodeFence(state, prefix) {
  const combined = `${state.emittedText}${prefix}`;
  return (combined.match(/```/g)?.length ?? 0) % 2 === 1;
}

function findPartialToolTagStart(text) {
  const lastIndex = text.lastIndexOf("<");
  if (lastIndex < 0) return -1;
  // 使用引号感知检查：从最后一个 < 开始，跳过多行引号内容后是否还有 >
  const tail = text.slice(lastIndex);
  if (hasUnquotedGt(tail)) return -1;
  const tailLower = tail.toLowerCase();
  return TOOL_CAPTURE_PAIRS.some(({ open }) => open.startsWith(tailLower)) ? lastIndex : -1;
}

/** 引号感知检查字符串中是否存在引号外的 >（即标签已闭合） */
function hasUnquotedGt(text) {
  let inDq = false, inSq = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) { i++; continue; }
    if (ch === '"' && !inSq) { inDq = !inDq; continue; }
    if (ch === "'" && !inDq) { inSq = !inSq; continue; }
    if (!inDq && !inSq && ch === ">") return true;
  }
  return false;
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

    // 引号感知的自闭合检测：/> 可能在引号外（真终止）或引号内（值的一部分）
    const afterOpen = captured.slice(openIndex + pair.open.length);
    const scIdx = findSelfCloseIdx(afterOpen);
    if (scIdx >= 0) {
      const closeEnd = openIndex + pair.open.length + scIdx + 2;
      return {
        ready: true,
        prefix: captured.slice(0, openIndex),
        calls: parseToolCallsFromText(captured.slice(openIndex, closeEnd), allowedToolNames),
        suffix: captured.slice(closeEnd)
      };
    }

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

export function createToolSieve(allowedToolNames = []) {
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

  await consumeStream(bodyStream, (delta) => {
    if (delta.kind === "thinking") {
      writeSse(buildChunkPayload(completionId, model, { reasoning_content: delta.text }));
      return;
    }

    // response kind: 内容文本，需经过工具拦截器处理
    if (!toolSieve) {
      writeSse(buildChunkPayload(completionId, model, { content: delta.text }));
      return;
    }

    const events = toolSieve.push(delta.text);
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
  let reasoningContent = "";
  let rawContent = "";

  await consumeStream(bodyStream, (delta) => {
    if (delta.kind === "thinking") {
      reasoningContent += delta.text;
    } else {
      rawContent += delta.text;
    }
  });

  const hasTools = toolNames.length > 0;
  let content = rawContent;
  let toolCalls = [];

  if (hasTools) {
    const parsed = extractToolAwareOutput(rawContent, toolNames);
    content = parsed.content;
    toolCalls = parsed.toolCalls;
  }

  const message = {
    role: "assistant",
    content: content.length ? content : null
  };
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
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
          ...message,
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
      message
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

  await consumeQwenStream(bodyStream, (delta) => {
    if (delta.kind === "__messageId") return;  // 元数据，不转发给 HTTP 客户端
    if (delta.kind === "thinking") {
      writeSse(buildChunkPayload(completionId, model, { reasoning_content: delta.text }));
      return;
    }

    // response kind: 内容文本，需经过工具拦截器处理
    if (!toolSieve) {
      writeSse(buildChunkPayload(completionId, model, { content: delta.text }));
      return;
    }

    const events = toolSieve.push(delta.text);
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
  let reasoningContent = "";
  let rawContent = "";

  await consumeQwenStream(bodyStream, (delta) => {
    if (delta.kind === "__messageId") return;  // 元数据，不混入 content
    if (delta.kind === "thinking") {
      reasoningContent += delta.text;
    } else {
      rawContent += delta.text;
    }
  });

  const hasTools = toolNames.length > 0;
  let content = rawContent;
  let toolCalls = [];

  if (hasTools) {
    const parsed = extractToolAwareOutput(rawContent, toolNames);
    content = parsed.content;
    toolCalls = parsed.toolCalls;
  }

  const message = {
    role: "assistant",
    content: content.length ? content : null
  };
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
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
          ...message,
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
      message
    }]
  };
}

// ═══════════════════════════════════════════════════
//  GLM SSE 解码器和流消费
//  GLM SSE 格式：每行 data: 后是完整 JSON 对象
//  {"status":"streaming","parts":[{"content":[{"type":"think","think":"..."},{"type":"text","text":"..."}]}]}
// ═══════════════════════════════════════════════════

/**
 * GLM SSE delta 解码器。
 * 解析 GLM parts[].content[] 中的 think / text / code 条目。
 * 返回 Array<{kind: string, text: string}>。
 */
export function createGlmDeltaDecoder() {
  return {
    consume(payloadText) {
      try {
        const payload = JSON.parse(payloadText);
        const results = [];

        if (!payload || typeof payload !== "object") return results;

        const parts = payload.parts;
        if (!Array.isArray(parts)) return results;

        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          const contentItems = part.content;
          if (!Array.isArray(contentItems)) continue;

          for (const item of contentItems) {
            if (!item || typeof item !== "object") continue;

            if (item.type === "think") {
              const text = String(item.think || item.text || item.content || "");
              if (text) results.push({ kind: "thinking", text });
            } else if (item.type === "text") {
              const text = String(item.text || item.content || "");
              if (text) results.push({ kind: "response", text });
            } else if (item.type === "code") {
              const code = String(item.code || "");
              if (code) results.push({ kind: "response", text: "```python\n" + code + "\n```" });
            } else if (item.type === "execution_output") {
              const output = String(item.content || "");
              if (output) results.push({ kind: "response", text: output });
            }
          }
        }

        return results;
      } catch {
        return [];
      }
    }
  };
}

/**
 * 消费 GLM 的 SSE 流，调用 onDelta 回调处理每个 {kind, text} delta。
 * options.onConversationId(convId) — 提取到会话 ID 时回调
 */
export async function consumeGlmStream(bodyStream, onDelta, options = {}) {
  if (!bodyStream) return;

  const decoder = new TextDecoder();
  const deltaDecoder = createGlmDeltaDecoder();
  const onConversationId = options.onConversationId;
  let convIdReported = false;

  const parser = createSseParser(({ data }) => {
    if (!data) return;

    // 提取 conversation_id
    if (!convIdReported && onConversationId) {
      try {
        const raw = JSON.parse(data);
        if (raw && raw.conversation_id) {
          convIdReported = true;
          onConversationId(String(raw.conversation_id));
        }
      } catch {}
    }

    const deltas = deltaDecoder.consume(data);
    if (!deltas || deltas.length === 0) return;

    for (const d of deltas) {
      onDelta(d);
    }
  });

  for await (const chunk of bodyStream) {
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.flush();
}

// ── GLM OpenAI 兼容 SSE 响应 ──

export async function streamGlmOpenAiResponse({ bodyStream, model, response, toolNames = [], onConversationId }) {
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

  await consumeGlmStream(bodyStream, (delta) => {
    if (delta.kind === "thinking") {
      writeSse(buildChunkPayload(completionId, model, { reasoning_content: delta.text }));
      return;
    }

    if (!toolSieve) {
      writeSse(buildChunkPayload(completionId, model, { content: delta.text }));
      return;
    }

    const events = toolSieve.push(delta.text);
    for (const event of events) {
      if (event.type === "tool_calls") {
        emitToolCalls(event.calls ?? []);
      } else if (event.text) {
        writeSse(buildChunkPayload(completionId, model, { content: event.text }));
      }
    }
  }, { onConversationId });

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

export async function collectGlmOpenAiResponse({ bodyStream, model, toolNames = [] }) {
  let reasoningContent = "";
  let rawContent = "";

  await consumeGlmStream(bodyStream, (delta) => {
    if (delta.kind === "thinking") {
      reasoningContent += delta.text;
    } else {
      rawContent += delta.text;
    }
  });

  const hasTools = toolNames.length > 0;
  let content = rawContent;
  let toolCalls = [];

  if (hasTools) {
    const parsed = extractToolAwareOutput(rawContent, toolNames);
    content = parsed.content;
    toolCalls = parsed.toolCalls;
  }

  const message = {
    role: "assistant",
    content: content.length ? content : null
  };
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
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
          ...message,
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
      message
    }]
  };
}
