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
node bin/chat2cli.js models             # 列出/刷新模型列表
node bin/chat2cli.js models refresh -p qwen  # 强制刷新 Qwen 模型列表
node bin/chat2cli.js apikey create      # 创建 API Key
node bin/chat2cli.js serve -p 3000      # 启动 OpenAI 兼容 API 服务
```

没有测试脚本和 lint 配置。

## 核心架构

```
bin/chat2cli.js          CLI 入口（commander 路由 + 全局错误处理）
    ↓
src/commands/*.js        命令实现（login / chat / history / config / apikey / agent / serve / models）
    ↓
src/extensions/          扩展系统（钩子、自定义工具/命令/路由、提示词注入）
    ↓
src/providers/registry.js Provider 注册中心（Map<name, instance>）
    ↓
src/providers/deepseek/  DeepSeek Provider
src/providers/openai/    OpenAI Provider
src/providers/qwen/      Qwen Provider（单文件）
src/providers/glm/       GLM Provider（单文件，手机号+验证码）
    ↓
src/bridge.js            OpenAI ↔ DeepSeek/Qwen/GLM 协议桥接（prompt 构建、SSE 流转换、模型配置）
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
- `createDeepseekDeltaDecoder` 从 JSON payload 中提取 `{ kind: "thinking" | "response", text }`，并在跳过 `response.created` 前先提取 `response_id`（供 agent-loop 续聊）
- `bridge.js` 中的 `createThinkingTagger` 在 thinking/response 切换时插入 `<think>` / `</think>` 标签

## `<invoke>` 工具调用解析

`bridge.js` 的 `findInvokeTags` 使用**状态机解析器**（非正则），追踪 `"` 和 `'` 引号状态，只在引号外识别 `/>` 和 `>` 为标签终止符。支持 shell 重定向（`>`、`<`）、heredoc（`<<`）等含特殊字符的命令。流式拦截器 `consumeCapturedToolBlock`/`findPartialToolTagStart` 同理。

## Qwen Provider 数据流

Qwen 通过邮箱 + 密码调用登录 API 获取 JWT token，后续聊天请求携带 token。

```
login → 邮箱 + 密码(SHA256) → POST /api/v2/auths/signin → JWT token
chat  → create session → build payload → POST /api/v2/chat/completions → SSE stream
```

关键实现（`src/providers/qwen/index.js`）：
- `buildHeaders(token)` — 构建通用请求 headers，包含 Chrome 124 UA、sec-ch-ua、Accept-Language 等
- `_loginByPassword(email, password)` — 密码 SHA256 哈希后调用登录 API，包含 Version/source/bx-v 等登录专用 headers
- `createChatSession(token, model)` — 创建 Qwen 会话
- `buildQwenPayload(chatId, model, prompt)` — 构建聊天请求 payload（含 feature_config）
- `parseQwenSseData(jsonStr)` — 参照 qwen2API 的 ParseQwenEvent()，全面解析 SSE 响应（详见实现）

### 模型列表拉取与持久化

Qwen 的真实模型列表通过 `GET /api/models` 拉取（响应 `{ data: [...] }`，字段 `id`/`name`/`info.meta.chat_type`）。关键设计：

- `_fetchModels(token, { force })` — 拉取成功后**持久化到 store**（`providers.qwen.models` + `modelsUpdatedAt`）+ 内存缓存；失败**抛出带可读原因的错误**（区分 401/网络/非 JSON/空列表），不再静默回落虚构兜底列表。复用原有解析与能力后缀变体扩展逻辑。
- `refreshModels({ force })` — 公开入口，取默认账号 + `_withAutoRefresh` 自动续期 + 拉取 + 持久化。供 login 后、`/model` 校验、server 校验调用。
- `getModels()` — **同步**（保持 `BaseProvider` 同步契约），顺序：内存缓存 → store 持久化 → 静态兜底 `QWEN_MODELS`。不触发网络。
- `_getRealModelsOrFallback(account)` — 对话路径用，拉取失败降级到 `getModels()` 不中断对话。
- `login()` 成功后主动 `_fetchModels(force)` 持久化。
- `chat()`/`startCompletion()`/`generateImage()` 对传入的过时模型（不在真实列表）降级到第一个真实模型，避免上游 400。

`/model`（chat.js）与 server chat completion 校验：模型不在当前列表时先 `await provider.refreshModels()` 再校验，仍不存在才拒绝。

## GLM Provider 数据流

GLM 通过 `chatglm_refresh_token` 换取 accessToken，后续请求携带 accessToken（需签名）。

```
login → refreshToken → POST /user-api/user/refresh → accessToken（游客用 /user-api/guest/access）
chat  → build payload → POST /backend-api/assistant/stream → SSE stream
```

关键实现（`src/providers/glm/index.js`）：
- `login(credentials.refreshToken)` — 存储 refresh token；也可走游客模式（无 token）
- `_getAccessToken(account)` — 缓存 + 自动用 refreshToken 刷新 accessToken
- `chat(messages, options)` — 请求体用固定 `assistant_id`（不发送 model 字段），本地 `model` 仅用于解析 `chat_mode`/`is_networking`
- 模型选择由 `assistant_id` 决定（硬编码常量），本地 `GLM_MODELS` 静态列表用于展示与开关解析，无公开模型列表 API

## 扩展系统

`src/extensions/` 提供可插拔的扩展机制：

- **加载器** (`loader.js`) — 从 `~/.chat2cli/extensions/` 目录自动发现并加载扩展
- **钩子系统** (`hooks.js`) — `pre:response_start` 等生命周期钩子，扩展可注册回调
- **注册中心** (`registry.js`) — 统一管理 Provider、工具、TUI 命令、路由、提示词片段
- 示例见 `examples/extensions/hello-world.js` 和 `chat-timestamp.js`

## Agent UI 渲染

`src/utils/format.js`:
- `printUserMsg` — 用户消息输出 3 行全宽背景块（`USER_MSG_BG = bgRgb(40,40,40)`）；chat 和 agent 共用
- `visualWidth` — 视觉宽度计算（CJK=2, ASCII=1），用于背景填充

`src/agent/tui.js`:
- `TOOL_BG = bgRgb(0,45,5)` — 工具执行深绿色背景
- `SUBAGENT_BG = bgRgb(40,0,60)` — 子 Agent 运行紫色背景
- `APPROVAL_BG = bgRgb(60,50,0)` — 审批提示暗黄色背景
- `ASK_BG = bgRgb(0,40,50)` — 用户提问暗青色背景
- `tool_start` — 输出 3 行绿色背景块（空白+标签+空白）
- `tool_result` — `\x1b[3A` 上跳覆盖 `tool_start` 块，`renderToolResultLines(..., true)` 包裹每行全宽背景
- Shell 结果 `\t` → 8 空格，避免 `visualWidth` 低估导致背景错位
- 交互式审批 UI：`showInteractivePrompt` → `showApprovalPrompt`（A批准/D拒绝/E编辑）或 `showAskPrompt`（选项/自由输入）
- 子 Agent 进度事件通过 `process.stdout.write` 输出（[Sub]/[..]/[>>]/[OK]/[FAIL]/[TIMEOUT]）

## Agent 架构：子 Agent 系统

`src/agent/` 下的 agent 模式已从 **v1 双 AI（主+辅）** 重构为 **v2 单 AI + 子 Agent 委派**：

### 核心变化

| 维度 | v1 (旧) | v2 (新) |
|------|---------|---------|
| AI 实例数 | 2 个（main + aux） | 1 个（main） |
| 辅助 AI 触发 | 用户手动 `/aux` 命令 | AI 自动 `delegate` 工具 |
| 工具限制 | aux 固定工具集 | 按 profile 可配置 |
| Shell 安全 | 无 | 白名单 + 危险模式 |
| 并发 | 不支持 | 最多 3 并发（分批复用） |
| 超时/取消 | 无 | 有（AbortController） |
| 审批 | 仅 shell 危险检测 | 审批 + ask 双模式 |

### 关键文件

```
src/agent/subagents/
├── config.js       # Profile 配置（~/.chat2cli/subagents.json）
├── manager.js      # SubagentManager — 生命周期 + 白名单 + 并发
└── prompts.js      # 子 Agent 系统提示词（含 OS 检测、白名单注入）
```

### SubagentManager

`src/agent/subagents/manager.js` — `SubagentManager` 类：

- `constructor({ provider, model, workingDir, maxTurns, timeoutMs, onEvent })`
- `spawnAndWait(task, { profile, tools, maxTurns, model })` → `{ id, status, result, error }`
- `spawnParallel(tasks[], concurrency=3)` — 分批并发执行
- `cancel(runId)` / `cancelAll()` — AbortController 取消
- `get(runId)` / `list(status?)` / `cleanup(olderThanMs)` — 状态管理
- `onEvent(runId, eventType, data)` — 事件：spawned/running/tool_start/tool_blocked/tool_result/completed/failed/cancelled/timed_out

子 Agent 内部是多轮工具调用循环（受 profile.maxTurns 限制），复用主 AI provider 和 model。支持 Qwen（consumeQwenStream）、DeepSeek（streamDeltasWithMessageId）、GLM（consumeGlmStream）三种流消费方式。流消费时过滤元数据 delta（`__messageId`/`__sessionId` 等，不混入 responseText）。

Braille spinner（`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`）在子 Agent 工作时每 80ms 旋转。

### search 子 Agent

`search` profile 专为联网搜索设计，**不注入任何工具调用格式**（`tools: []`）。原因：本环境不提供 `web_search` 工具，若注入 `<invoke>` 格式，AI 会尝试用厂商不识别的格式调用原生搜索。改为靠 provider 原生能力（`enableSearch: true` + 自动推导 search 模型变体）完成，单轮返回固定轻量格式。

- `buildSearchSubAgentPrompt({ workingDir })` — 专用提示词，无 `<invoke>` 段、无工具列表，只定义返回格式：
  ```
  <search query="查询词"><hit source="url" info="摘要" /><answer>结论</answer></search>
  ```
  失败：`<search-failed reason="..." />`
- `resolveSearchModel(provider, model)` — 推导 search 模型变体（qwen/deepseek 追加 `-search`，glm 原样）
- `extractSearchResult(text)` — 从响应提取 `<search>...</search>` 或 `<search-failed />`（容错：未命中则原样返回）
- `_executeSubAgent` 在 search 模式下单轮短路，不调用 `parseToolCallsFromText`

### Profile 配置

`src/agent/subagents/config.js` — 配置文件 `~/.chat2cli/subagents.json`：

- `default`（5轮/只读）、`explorer`（10轮/搜索增强）、`builder`（15轮/可写）、`search`（联网搜索，无工具，单轮，无整体超时，`promptMode:"search"`/`enableSearch:true`）
- 每 profile 定义：`tools[]`、`allowedShellCommands[]`、`blockUnlistedCommands`、`maxTurns`、`timeoutMs`（search 为 0=不限时）、`requireApprovalForWrite`，search profile 额外有 `promptMode`、`enableSearch`
- 公开 API：`getProfile()`、`listProfiles()`、`saveProfile()`、`deleteProfile()`、`resetConfig()`、`resolveProfile()`

### Shell 白名单

`SubagentManager.checkShellWhitelist(cmd, profile)` — 两层检查：

1. **危险模式检查**（不可绕过）：`rm -rf`、`git push --force`、`git reset --hard`、`git clean -f/d/x`、`chmod 777`、`dd if=`、`mkfs.*`、`> /dev/*`
2. **白名单检查**：`extractBaseCommand()` 处理 sudo/env/路径前缀，提取基础命令名，在白名单中放行

### delegate 工具

`src/agent/tools/registry.js` 中的 `executeDelegate()`：

- 单任务：`delegate({ task, profile, tools, model, max_turns })`
- 并发：`delegate({ tasks: [{ task, profile, model }, ...] })` — 调用 `manager.spawnParallel(tasks, 3)`
- `model` 参数：覆盖子 Agent 模型；search profile 未指定时自动推导主模型的 search 变体
- 依赖 `context.subagentManager`（在 agent-loop 中初始化）

## 工具审批 & ask 交互

### 审批流程（agent-loop.js + tui.js）

`runAgentLoop` 中的 Promise 桥接模式：

```
executeToolCall() → { requiresApproval: true, approvalType: "shell"|"ask" }
  ↓
yield { type: "approval_required" | "ask_user", resolve: (decision) => {} }
  ↓ TUI 渲染交互式 UI
showInteractivePrompt() → showApprovalPrompt() | showAskPrompt()
  ↓ 用户选择
resolve({ approved: true/false, answer?, modifiedParams? })
  ↓ agent-loop 继续
重新执行（_approved=true 绕过二次审批）或使用用户回答
```

### 审批 UI（showApprovalPrompt）

- 暗黄色背景块（`APPROVAL_BG`）
- 三选项：`[A]` 批准执行 / `[D]` 拒绝 / `[E]` 编辑命令后执行
- 编辑模式（showEditCommandPrompt）：内联键盘编辑，Enter 确认，Ctrl+C 取消
- 上下键 + 首字母快捷键导航

### ask UI（showAskPrompt）

- 暗青色背景块（`ASK_BG`）
- 有选项时：列表选择器（↑↓ 导航 + Enter 确认），含"自定义输入..."选项
- 无选项时：自由文本输入（showAskFreeInput），Enter 确认

### shell 工具审批触发条件

`executeShell()` 在以下情况返回 `requiresApproval`：
- `requires_approval: true`（AI 主动标注）或 `isDangerous(command)`（危险模式匹配）
- `_approved` 标记的存在绕过二次审批（重新执行时使用）

## 已移除的辅助 AI（aux）

旧版 `runAuxCall()`、`buildMessagesForAux()`、`aux-system.js`、`composite.aux` 字段、`/aux` 命令、`auxModel`、aux provider 选择已全部移除。

## Server 模式（OpenAI 兼容 API）

`src/server.js` 启动 HTTP 服务，将 OpenAI 格式请求桥接到后端 Provider：
- API Key 认证 → 通过 `resolveApiKey()` 查找已绑定的 Provider 账号
- 消息 → `buildPromptFromMessages()` 转为纯文本 prompt
- Function Calling → `buildOpenAiPrompt()` 注入工具定义到 prompt，`streamOpenAiResponse()` 解析 XML 工具调用为 OpenAI 格式的 tool_calls delta

端点：`GET /v1/models`、`POST /v1/chat/completions`

## 数据存储

所有数据保存在 `~/.chat2cli/data.json`：
- `config` — defaultProvider, defaultModel, shellTimeout（0=不限时，默认 120000）, markdown, newChatOnStart 等
- `providers.deepseek.accounts[]` — 多账号凭据（token, userId, deviceId）
- `providers.openai` — API Key + baseUrl
- `providers.qwen.accounts[]` — 多账号凭据（token, email）
- `apiKeys[]` — 分发的 API Key（可绑定到 DeepSeek 账号）
- `conversations[]` — 本地对话历史
- `composites[]` — Agent 复合对话（只含 main 字段，aux 已移除）

子 Agent 配置独立存储在 `~/.chat2cli/subagents.json`：
- `profiles.default/explorer/builder` — 内置 profile（tools, allowedShellCommands, maxTurns, timeoutMs 等）
- 支持用户自定义 profile 增删改

## 技术栈

- Node.js >= 18, ESM (`"type": "module"`)
- commander — CLI 框架
- inquirer — 交互式提示
- chalk — 终端着色
- ora — 加载 spinner
- 零外部 HTTP 库 — 全部使用 `fetch` (Node 18 内置)
