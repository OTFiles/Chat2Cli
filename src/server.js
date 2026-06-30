import { createServer } from "node:http";
import { initProviders, getProvider } from "./providers/registry.js";
import { getStore } from "./storage/store.js";
import { getConfig } from "./config.js";
import { streamOpenAiResponse, collectOpenAiResponse, buildOpenAiPrompt } from "./bridge.js";

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

async function handleModels(res) {
  const provider = getProvider("deepseek");
  const models = provider?.getModels().map((m) => ({
    id: m.id, object: "model", created: 0, owned_by: "deepseek"
  })) || [];
  sendJson(res, 200, { object: "list", data: models });
}

async function handleChatCompletions(req, res) {
  const token = getBearerToken(req);
  if (!token) return sendError(res, 401, "缺少认证信息，请在 Authorization 头中提供 Bearer API Key");

  const resolved = resolveApiKey(token);
  if (!resolved) return sendError(res, 401, "无效的 API Key，请运行 chat2cli apikey create 创建");
  const { provider, accountId } = resolved;

  if (!accountId) {
    return sendError(res, 403,
      "此 API Key 未绑定 DeepSeek 账号，请运行: chat2cli apikey bind <keyId>");
  }

  let body;
  try { body = await parseRequestBody(req); }
  catch (e) { return sendError(res, 400, e.message); }

  if (!body.messages || !Array.isArray(body.messages)) {
    return sendError(res, 400, "缺少 messages 字段");
  }

  const model = body.model || getConfig().defaultModel;
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
    // 通过 provider 发起 completion，获取原始 Response
    const dsResponse = await provider.startCompletion(body.messages, providerOptions);

    if (!dsResponse || !dsResponse.ok) {
      return sendError(res, 502, "DeepSeek 请求失败");
    }

    if (streaming) {
      await streamOpenAiResponse({ bodyStream: dsResponse.body, model, response: res, toolNames });
    } else {
      const result = await collectOpenAiResponse({ bodyStream: dsResponse.body, model, toolNames });
      sendJson(res, 200, result);
    }
  } catch (err) {
    if (!res.headersSent) {
      sendError(res, 500, err.message);
    } else {
      res.destroy(err);
    }
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
        await handleModels(res);
        return;
      }
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        await handleChatCompletions(req, res);
        return;
      }
      sendError(res, 404, `未知端点: ${url.pathname}`);
    } catch (err) {
      if (!res.headersSent) sendError(res, 500, err.message);
      else res.destroy(err);
    }
  });
}
