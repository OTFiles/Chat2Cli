import { proxyDeepseekRequest } from "./proxy.js";
import { consumeRawStream } from "../../bridge.js";
import { createSseParser, createDeepseekDeltaDecoder } from "../../utils/sse.js";

const JSON_HEADERS = Object.freeze({ "content-type": "application/json" });

/**
 * 发起 DeepSeek chat completion 请求
 * 返回原始 Response 对象，由上层决定如何处理（流式/非流式）
 */
export async function startDeepseekCompletion({ account, body }) {
  return proxyDeepseekRequest({
    account,
    method: "POST",
    path: "/api/v0/chat/completion",
    body: Buffer.from(JSON.stringify(body)),
    headers: JSON_HEADERS
  });
}

/**
 * 流式消费 DeepSeek SSE 响应，yield 原始 deltas
 * 供 CLI 交互式对话使用
 */
export async function* streamRawDeltas(response) {
  if (!response || !response.body) {
    throw new Error("DeepSeek 返回空响应");
  }
  yield* consumeRawStream(response.body);
}

/**
 * 流式消费 DeepSeek SSE 响应，同时捕获 event:ready 的 response_message_id。
 * 返回 { deltas } 的可迭代对象 + messageId。
 * 供继聊场景使用（需更新 parent_message_id）。
 */
export function streamDeltasWithMessageId(response) {
  if (!response || !response.body) {
    throw new Error("DeepSeek 返回空响应");
  }

  let messageId = null;
  const pending = [];
  const decoder = new TextDecoder();
  const deltaDecoder = createDeepseekDeltaDecoder();

  const parser = createSseParser(({ event, data }) => {
    if (!data) return;
    // 捕获 event:ready 中的 response_message_id
    if (event === "ready") {
      try {
        const payload = JSON.parse(data);
        if (payload.response_message_id) {
          messageId = payload.response_message_id;
        }
      } catch { /* skip */ }
      return;
    }
    if (event !== "message") return;
    try {
      const delta = deltaDecoder.consume(data);
      if (delta) pending.push(delta);
    } catch { /* skip */ }
  });

  async function* deltas() {
    for await (const chunk of response.body) {
      pending.length = 0;
      parser.push(decoder.decode(chunk, { stream: true }));
      for (const d of pending) yield d;
    }
    pending.length = 0;
    parser.flush();
    for (const d of pending) yield d;
  }

  return Object.freeze({
    deltas: deltas(),
    get messageId() { return messageId; }
  });
}
