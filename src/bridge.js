/**
 * OpenAI ↔ DeepSeek 协议桥接层
 * 参考 deepseek2api 项目的 openai-bridge.js + openai-completion-runner.js
 */
import { randomUUID } from "node:crypto";
import { createDeepseekDeltaDecoder, createSseParser } from "./utils/sse.js";

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

// --- Prompt 构建 ---

export function buildPromptFromMessages(messages) {
  return messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content ?? ""}`)
    .join("\n\n");
}

// --- 模型解析 ---

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

// --- Thinking 标签包装 ---

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

// --- Chat completion body (DeepSeek 格式) ---

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

// --- 流式响应消费者（带 thinking 标签）---

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

// --- 流式响应（原始 deltas，无标签，供 CLI 使用）---

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

// --- OpenAI 兼容响应构建 ---

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

/**
 * 流式响应（OpenAI SSE 格式）
 */
export async function streamOpenAiResponse({ bodyStream, model, response }) {
  const completionId = createCompletionId();

  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no"
  });
  response.flushHeaders?.();

  // 第一个 chunk: role
  response.write(`data: ${JSON.stringify(buildChunkPayload(completionId, model, { role: "assistant" }))}\n\n`);

  await consumeTaggedStream(bodyStream, (text) => {
    response.write(`data: ${JSON.stringify(buildChunkPayload(completionId, model, { content: text }))}\n\n`);
  });

  // 最终 chunk
  response.write(`data: ${JSON.stringify(buildChunkPayload(completionId, model, {}, "stop"))}\n\n`);
  response.end("data: [DONE]\n\n");
}

/**
 * 收集完整响应（非流式）
 */
export async function collectOpenAiResponse({ bodyStream, model }) {
  let content = "";

  await consumeTaggedStream(bodyStream, (text) => {
    content += text;
  });

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
