# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

chat2cli 是一个多 AI 终端聊天工具，支持在命令行中与 DeepSeek、OpenAI 等 AI 对话，同时提供 OpenAI 兼容的 HTTP API 桥接服务。

## 常用命令

```bash
# 安装依赖
npm install

# 运行 CLI（查看帮助）
node bin/chat2cli.js --help

# 常用子命令
node bin/chat2cli.js login              # 登录 AI 服务商
node bin/chat2cli.js chat               # 交互式对话
node bin/chat2cli.js chat -m "你好"     # 单条消息
node bin/chat2cli.js history            # 查看对话历史
node bin/chat2cli.js config             # 查看配置
node bin/chat2cli.js apikey create      # 创建 API Key
node bin/chat2cli.js serve -p 3000      # 启动 OpenAI 兼容 API 服务
```

没有测试脚本和 lint 配置。

## 核心架构

```
bin/chat2cli.js          CLI 入口（commander 路由 + 全局错误处理）
    ↓
src/commands/*.js        命令实现（login / chat / history / config / apikey / serve）
    ↓
src/providers/registry.js Provider 注册中心（Map<name, instance>）
    ↓
src/providers/deepseek/  DeepSeek Provider（主要 provider）
src/providers/openai/    OpenAI Provider（简单封装）
    ↓
src/bridge.js            OpenAI ↔ DeepSeek 协议桥接（prompt 构建、SSE 流转换、模型配置）
    ↓
src/storage/store.js     JSON 文件存储（~/.chat2cli/data.json）
```

## Provider 模式

所有 AI 服务商继承 `src/providers/base.js` 中的 `BaseProvider`，必须实现：

- `name` / `label` — 标识和显示名
- `login(credentials)` — 保存凭据到 store
- `chat(messages, options)` — async generator，yield `{ kind, text }`（kind: "thinking" | "response"）
- `getModels()` — 返回可用模型列表
- `getAccountInfo(accountId?)` — 获取当前账号信息
- `isAuthenticated()` — 是否已登录

新增 provider 需在 `src/providers/registry.js` 中调用 `registerProvider()` 注册。

## DeepSeek Provider 数据流

DeepSeek 需要先登录获取 token，后续所有 API 请求携带 token + PoW challenge。

```
login → 邮箱/手机 + 密码 → POST /api/v0/users/login → token + userId
chat  → create session → build body → POST /api/v0/chat/completion → SSE stream
         ↑ 需要 x-ds-pow-response header（WASM 求解 PoW challenge）
```

关键文件：
- `auth.js` — 登录、token 刷新、基础 header 构建
- `proxy.js` — 通用 HTTP 代理（自动 PoW + token 过期重试）、会话 CRUD
- `chat.js` — `startDeepseekCompletion` + `streamRawDeltas`
- `pow-solver.js` — WebAssembly 求解 DeepSeek 的 PoW 质询

## DeepSeek SSE 协议

DeepSeek 返回 text/event-stream，内部 payload 是 JSON，用 `src/utils/sse.js` 解析：
- `createSseParser` 解析标准 SSE 事件
- `createDeepseekDeltaDecoder` 从 JSON payload 中提取 `{ kind: "thinking" | "response", text }`
- `bridge.js` 中的 `createThinkingTagger` 在 thinking/response 切换时插入 `<think>` / `</think>` 标签

## Server 模式（OpenAI 兼容 API）

`src/server.js` 启动 HTTP 服务，将 OpenAI 格式请求桥接到 DeepSeek：
- API Key 认证 → 通过 `resolveApiKey()` 查找已绑定的 DeepSeek 账号
- 消息 → `buildPromptFromMessages()` 转为纯文本 prompt
- Function Calling → `buildOpenAiPrompt()` 注入工具定义到 prompt，`streamOpenAiResponse()` 解析 XML 工具调用为 OpenAI 格式的 tool_calls delta

端点：`GET /v1/models`、`POST /v1/chat/completions`

## 数据存储

所有数据保存在 `~/.chat2cli/data.json`：
- `config` — defaultProvider, defaultModel
- `providers.deepseek.accounts[]` — 多账号凭据（token, userId, deviceId）
- `providers.openai` — API Key + baseUrl
- `apiKeys[]` — 分发的 API Key（可绑定到 DeepSeek 账号）
- `conversations[]` — 本地对话历史

## 技术栈

- Node.js >= 18, ESM (`"type": "module"`)
- commander — CLI 框架
- inquirer — 交互式提示
- chalk — 终端着色
- ora — 加载 spinner
- 零外部 HTTP 库 — 全部使用 `fetch` (Node 18 内置)
