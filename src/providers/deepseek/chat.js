import { proxyDeepseekRequest } from "./proxy.js";
import { consumeRawStream } from "../../bridge.js";

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
