import { createServer } from "node:http";
import { initProviders, getProvider, listProviders } from "./providers/registry.js";
import { getStore } from "./storage/store.js";
import { getConfig } from "./config.js";
import {
  streamOpenAiResponse, collectOpenAiResponse,
  streamQwenOpenAiResponse, collectQwenOpenAiResponse,
  buildOpenAiPrompt
} from "./bridge.js";

// ── 尺寸映射（OpenAI 格式 → Qwen 格式）──
const OPENAI_SIZE_MAP = {
  "1024x1024": "1:1",
  "1536x1024": "4:3",
  "1024x1536": "3:4",
  "1792x1024": "16:9",
  "1024x1792": "9:16",
};

function normalizeSize(size) {
  if (!size) return undefined;
  return OPENAI_SIZE_MAP[size] || size;
}

// ── 图片 URL 下载为 base64 ──
async function downloadAsBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const mime = resp.headers.get("content-type") || "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// 通过 API Key 查找对应的服务商账号
function resolveApiKey(apiKey) {
  const state = getStore();
  const record = state.apiKeys?.find((k) => k.key === apiKey);
  if (!record) return null;

  const provider = getProvider(record.provider);
  if (!provider || !provider.isAuthenticated()) return null;

  // 如果绑定了具体账号，验证账号仍存在
  let accountId = record.accountId || null;
  if (accountId) {
    const account = provider.getAccountInfo(accountId);
    if (!account) accountId = null;
  }

  return { provider, record, accountId };
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.byteLength
  });
  res.end(data);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message, type: "server_error" } });
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const b = Buffer.concat(chunks);
        resolve(b.byteLength ? JSON.parse(b.toString("utf8")) : {});
      } catch (e) { reject(new Error("请求体 JSON 解析失败")); }
    });
    req.on("error", reject);
  });
}

function getBearerToken(req) {
  const v = req.headers.authorization || "";
  return v.startsWith("Bearer ") ? v.slice(7) : "";
}

async function handleModels(req, res) {
  const token = getBearerToken(req);

  if (token) {
    // 有 API Key：仅返回该 Key 绑定的 provider 的模型
    const resolved = resolveApiKey(token);
    if (!resolved) return sendError(res, 401, "无效的 API Key，请运行 chat2cli apikey create 创建");

    const { provider } = resolved;
    const models = [];
    if (typeof provider.getModels === "function") {
      for (const m of provider.getModels()) {
        models.push({ id: m.id, object: "model", created: 0, owned_by: provider.name });
      }
    }
    sendJson(res, 200, { object: "list", data: models });
  } else {
    // 无 API Key：仅返回已认证服务商的模型
    const providers = listProviders();
    const models = [];
    for (const provider of providers) {
      if (!provider.isAuthenticated()) continue;
      if (typeof provider.getModels === "function") {
        for (const m of provider.getModels()) {
          models.push({ id: m.id, object: "model", created: 0, owned_by: provider.name });
        }
      }
    }
    sendJson(res, 200, { object: "list", data: models });
  }
}

async function handleChatCompletions(req, res) {
  const token = getBearerToken(req);
  if (!token) return sendError(res, 401, "缺少认证信息，请在 Authorization 头中提供 Bearer API Key");

  const resolved = resolveApiKey(token);
  if (!resolved) return sendError(res, 401, "无效的 API Key，请运行 chat2cli apikey create 创建");
  const { provider, accountId } = resolved;

  if (!accountId) {
    return sendError(res, 403,
      `此 API Key 未绑定 ${provider.label} 账号，请运行: chat2cli apikey bind <keyId>`);
  }

  let body;
  try { body = await parseRequestBody(req); }
  catch (e) { return sendError(res, 400, e.message); }

  if (!body.messages || !Array.isArray(body.messages)) {
    return sendError(res, 400, "缺少 messages 字段");
  }

  const model = body.model || getConfig().defaultModel;

  // 校验 model 是否属于当前 API Key 绑定的 provider
  const providerModels = provider.getModels();
  if (!providerModels.some((m) => m.id === model)) {
    return sendError(res, 400, `模型 "${model}" 不属于 ${provider.label} 服务商`);
  }

  const streaming = body.stream !== false;

  // 检查是否需要工具调用支持
  const tools = body.tools || null;
  const toolChoice = body.tool_choice;
  const hasToolMessages = body.messages?.some(
    (m) => m.role === "tool" || m.role === "function" || Array.isArray(m.tool_calls)
  );
  const needsTooling = (Array.isArray(tools) && tools.length > 0) || hasToolMessages;

  let providerOptions = { model, accountId };
  let toolNames = [];

  if (needsTooling) {
    try {
      const openAiPrompt = buildOpenAiPrompt({ messages: body.messages, tools, toolChoice });
      providerOptions.prompt = openAiPrompt.prompt;
      toolNames = openAiPrompt.toolNames;
    } catch (e) {
      return sendError(res, 400, `工具配置错误: ${e.message}`);
    }
  }

  try {
    // 通过 provider 发起 completion
    const result = await provider.startCompletion(body.messages, providerOptions);

    // 图片/视频生成结果（非 Response 流，是 { url, _isImageResult } 对象）
    if (result && result._isImageResult) {
      const content = `![image](${result.url})`;
      if (streaming) {
        const completionId = `chatcmpl-${Date.now()}`;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({
          id: completionId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
          model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: completionId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
          model, choices: [{ index: 0, delta: { content }, finish_reason: null }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: completionId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
          model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        sendJson(res, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop"
          }]
        });
      }
      return;
    }

    const isQwen = provider.name === "qwen";
    if (!result || !result.ok) {
      return sendError(res, 502, `${provider.label} 请求失败`);
    }

    if (streaming) {
      if (isQwen) {
        await streamQwenOpenAiResponse({ bodyStream: result.body, model, response: res, toolNames });
      } else {
        await streamOpenAiResponse({ bodyStream: result.body, model, response: res, toolNames });
      }
    } else {
      const collected = isQwen
        ? await collectQwenOpenAiResponse({ bodyStream: result.body, model, toolNames })
        : await collectOpenAiResponse({ bodyStream: result.body, model, toolNames });
      sendJson(res, 200, collected);
    }
  } catch (err) {
    if (!res.headersSent) {
      sendError(res, 500, err.message);
    } else {
      res.destroy(err);
    }
  }
}

// ── /v1/images/generations ──
async function handleImagesGenerations(req, res) {
  const token = getBearerToken(req);
  if (!token) return sendError(res, 401, "缺少认证信息");

  const resolved = resolveApiKey(token);
  if (!resolved) return sendError(res, 401, "无效的 API Key");
  const { provider, accountId } = resolved;

  if (provider.name !== "qwen") {
    return sendError(res, 400, "图片生成仅支持 Qwen 服务商");
  }

  let body;
  try { body = await parseRequestBody(req); } catch (e) { return sendError(res, 400, e.message); }

  if (!body.prompt) return sendError(res, 400, "缺少 prompt 参数");

  try {
    const result = await provider.generateImage({
      model: body.model,
      prompt: body.prompt,
      size: normalizeSize(body.size),
      chatType: "t2i",
      accountId,
    });

    if (body.response_format === "b64_json") {
      const b64 = await downloadAsBase64(result.url);
      sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64 }] });
    } else {
      sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ url: result.url }] });
    }
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

// ── /v1/images/edits ──
async function handleImagesEdits(req, res) {
  const token = getBearerToken(req);
  if (!token) return sendError(res, 401, "缺少认证信息");

  const resolved = resolveApiKey(token);
  if (!resolved) return sendError(res, 401, "无效的 API Key");
  const { provider, accountId } = resolved;

  if (provider.name !== "qwen") {
    return sendError(res, 400, "图片编辑仅支持 Qwen 服务商");
  }

  let body;
  try { body = await parseRequestBody(req); } catch (e) { return sendError(res, 400, e.message); }

  // 支持 JSON body：{ prompt, image: "url or data URI", model?, size? }
  const imageUrl = body.image || "";
  if (!imageUrl) return sendError(res, 400, "缺少 image 参数");

  const files = [{ type: "image", url: imageUrl }];

  try {
    const result = await provider.generateImage({
      model: body.model,
      prompt: body.prompt || "请基于上传图片完成编辑",
      size: normalizeSize(body.size),
      chatType: "image_edit",
      files,
      accountId,
    });

    if (body.response_format === "b64_json") {
      const b64 = await downloadAsBase64(result.url);
      sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64 }] });
    } else {
      sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ url: result.url }] });
    }
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

export function createApiServer() {
  initProviders();

  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      if (!req.url || req.url === "/") {
        sendJson(res, 200, { product: "chat2cli API Server", version: "1.0.0" });
        return;
      }
      if (url.pathname === "/v1/models" && req.method === "GET") {
        await handleModels(req, res);
        return;
      }
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        await handleChatCompletions(req, res);
        return;
      }
      if (url.pathname === "/v1/images/generations" && req.method === "POST") {
        await handleImagesGenerations(req, res);
        return;
      }
      if (url.pathname === "/v1/images/edits" && req.method === "POST") {
        await handleImagesEdits(req, res);
        return;
      }
      sendError(res, 404, `未知端点: ${url.pathname}`);
    } catch (err) {
      if (!res.headersSent) sendError(res, 500, err.message);
      else res.destroy(err);
    }
  });
}
