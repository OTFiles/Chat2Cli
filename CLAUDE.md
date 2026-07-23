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
src/commands/*.js        命令实现（login / chat / history / config / apikey / agent / serve）
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
- `createDeepseekDeltaDecoder` 从 JSON payload 中提取 `{ kind: "thinking" | "response", text }`
- `bridge.js` 中的 `createThinkingTagger` 在 thinking/response 切换时插入 `<think>` / `</think>` 标签

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
- `parseQwenSseData(jsonStr)` — 参照 qwen2API 的 ParseQwenEvent()，全面解析 SSE 响应：
  - 支持 `choices[0].delta` 中多种 reasoning 字段（reasoning_content, reasoning, reasoning_text, thinking, thoughts）
  - 支持 `delta.extra` 子对象中的 reasoning
  - 支持顶层 content/answer/text/delta 和 reasoning_content/reasoning/thinking
  - 递归解析 `data` 和 `message` 子对象
  - 返回 `Array<{ kind: "thinking" | "response", text }>`

## GLM Provider 数据流

GLM 通过手机号 + 验证码登录，后续请求携带 accessToken。

```
login → 手机号 → POST /api/v1/sms/send → 验证码 → POST /api/v1/oauth/token → accessToken
chat  → build payload → POST /api/chatgpt/chat/completions → SSE stream
```

关键实现（`src/providers/glm/index.js`）：
- `sendSms(phone)` — 发送短信验证码
- `loginWithSms(phone, code)` — 验证码登录获取 accessToken
- `chat(messages, options)` — 直接调用 chat completions API，无需创建 session

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
- `spawnAndWait(task, { profile, tools, maxTurns })` → `{ id, status, result, error }`
- `spawnParallel(tasks[], concurrency=3)` — 分批并发执行
- `cancel(runId)` / `cancelAll()` — AbortController 取消
- `get(runId)` / `list(status?)` / `cleanup(olderThanMs)` — 状态管理
- `onEvent(runId, eventType, data)` — 事件：spawned/running/tool_start/tool_blocked/tool_result/completed/failed/cancelled/timed_out

子 Agent 内部是多轮工具调用循环（受 profile.maxTurns 限制），复用主 AI provider 和 model。支持 Qwen（consumeQwenStream）、DeepSeek（streamDeltasWithMessageId）、GLM（consumeGlmStream）三种流消费方式。

Braille spinner（`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`）在子 Agent 工作时每 80ms 旋转。

### Profile 配置

`src/agent/subagents/config.js` — 配置文件 `~/.chat2cli/subagents.json`：

- 内置 3 个 profile：`default`（5轮/只读）、`explorer`（10轮/搜索增强）、`builder`（15轮/可写）
- 每 profile 定义：`tools[]`、`allowedShellCommands[]`、`blockUnlistedCommands`、`maxTurns`、`timeoutMs`、`requireApprovalForWrite`
- 公开 API：`getProfile()`、`listProfiles()`、`saveProfile()`、`deleteProfile()`、`resetConfig()`、`resolveProfile()`

### Shell 白名单

`SubagentManager.checkShellWhitelist(cmd, profile)` — 两层检查：

1. **危险模式检查**（不可绕过）：`rm -rf`、`git push --force`、`git reset --hard`、`git clean -f/d/x`、`chmod 777`、`dd if=`、`mkfs.*`、`> /dev/*`
2. **白名单检查**：`extractBaseCommand()` 处理 sudo/env/路径前缀，提取基础命令名，在白名单中放行

### delegate 工具

`src/agent/tools/registry.js` 中的 `executeDelegate()`：

- 单任务：`delegate({ task, profile, tools, max_turns })`
- 并发：`delegate({ tasks: [{ task, profile }, ...] })` — 调用 `manager.spawnParallel(tasks, 3)`
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
- `config` — defaultProvider, defaultModel
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
