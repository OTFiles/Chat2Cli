# 子 Agent 系统

> chat2cli Agent 模式的子 Agent 委托执行系统

## 概述

子 Agent（Sub-agent）是 Agent 模式下的一种任务委托机制。主 AI 通过 `delegate` 工具将独立的、不需上下文的子任务委派给子 Agent 执行，子 Agent 是独立的 AI 实例，受 profile 配置约束。

### 架构变迁

- **v1（已废弃）**: 双 AI 协作模式 — 主 AI + 辅助 AI（aux），用户手动通过 `/aux` 命令委托任务
- **v2（当前）**: 单 AI + 子 Agent 委派 — 主 AI 通过 `delegate` 工具自动选择子 Agent profile 执行子任务

### 核心文件

```
src/agent/subagents/
├── config.js      # Profile 配置管理（~/.chat2cli/subagents.json）
├── manager.js     # SubagentManager — 生命周期管理
└── prompts.js     # 子 Agent 系统提示词构建
```

## Profile 系统

子 Agent 的行为由 **profile** 控制。每个 profile 定义了一组约束：

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `tools` | `string[]` | 允许使用的工具列表 |
| `allowedShellCommands` | `string[]` | Shell 命令白名单 |
| `blockUnlistedCommands` | `boolean` | 是否阻止白名单外的命令（默认 true） |
| `maxTurns` | `number` | 最大工具调用轮次 |
| `timeoutMs` | `number` | 超时时间（毫秒） |
| `requireApprovalForWrite` | `boolean` | 是否需要审批才能写入 |

### 内置 Profile

| Profile | 工具 | 特点 | 轮次 | 超时 |
|---------|------|------|------|------|
| `default` | shell, file-read, file-search | 基础只读，安全白名单 | 5 | 120s |
| `explorer` | shell, file-read, file-search | 搜索增强（rg, fd, tree 等），10 轮 | 10 | 60s |
| `builder` | shell, file-read, file-search, file-write | 可写文件，构建类命令（npm, git, cargo 等） | 15 | 300s |

### Shell 命令白名单详情

**default** 白名单:
```
ls, cat, grep, find, wc, head, tail, sort, uniq, echo, pwd,
which, stat, file, du, df, env, date, dirname, basename,
node, npm, npx, python, python3, git
```

**explorer** 额外命令: `rg, tree, locate, fd, awk, sed, cut, xargs`

**builder** 额外命令: `yarn, pnpm, pip, make, cargo, go, mkdir, touch, cp, mv, rm, chmod, diff, patch`

### 自定义 Profile

配置文件位于 `~/.chat2cli/subagents.json`，首次使用时自动生成默认配置。

```json
{
  "profiles": {
    "default": { ... },
    "explorer": { ... },
    "builder": { ... },
    "my-profile": {
      "tools": ["shell", "file-read"],
      "allowedShellCommands": ["ls", "cat", "node", "npm"],
      "blockUnlistedCommands": true,
      "maxTurns": 8,
      "timeoutMs": 60000,
      "requireApprovalForWrite": true
    }
  }
}
```

内置 profile（default/explorer/builder）不可删除，但可通过同名自定义覆盖。

## SubagentManager

`SubagentManager` 管理子 Agent 的完整生命周期。

### 构造函数

```js
new SubagentManager({
  provider,       // AI provider 实例
  model,          // 可选，AI 模型
  workingDir,     // 工作目录
  maxTurns: 5,    // 默认最大轮次（可由 profile 覆盖）
  timeoutMs: 120000, // 默认超时
  onEvent         // 事件回调 (runId, eventType, data) => void
})
```

### 运行状态

```
pending → running → completed
                  → failed
                  → cancelled
                  → timed_out
```

### 主要方法

| 方法 | 说明 |
|------|------|
| `spawnAndWait(task, opts)` | 生成子 Agent 并等待完成 |
| `spawnParallel(tasks, concurrency)` | 并发执行多个子 Agent（分组批处理，默认并发 3） |
| `cancel(runId)` | 取消指定运行 |
| `cancelAll()` | 取消所有运行 |
| `get(runId)` | 获取运行状态 |
| `list(status?)` | 列出所有运行（可按状态过滤） |
| `cleanup(olderThanMs)` | 清理已完成的旧运行（默认 5 分钟） |

### spawnAndWait 选项

```js
manager.spawnAndWait("搜索所有 TODO 注释", {
  profile: "explorer",    // 使用哪个 profile
  tools: ["shell", "file-search"],  // 可选，覆盖 profile 的 tools
  maxTurns: 8             // 可选，覆盖 profile 的 maxTurns
})
```

返回值：
```js
{
  id: "sub_xxx",       // 运行 ID
  task: "搜索...",     // 任务描述
  status: "completed", // completed | failed | timed_out | cancelled
  result: "...",       // 结果文本
  error: null          // 错误信息
}
```

### 事件系统

事件通过构造函数的 `onEvent` 回调触发：

| 事件 | data | 触发时机 |
|------|------|----------|
| `spawned` | `{ task, profile }` | 子 Agent 被创建 |
| `running` | `{ profile }` | 子 Agent 开始执行 |
| `tool_start` | `{ toolName, params }` | 子 Agent 调用工具 |
| `tool_blocked` | `{ toolName, reason }` | 工具被白名单/安全检查阻止 |
| `tool_result` | `{ toolName, result }` | 工具执行完成 |
| `completed` | `{ result, turns, toolCount }` | 子 Agent 成功完成 |
| `failed` | `{ error, turns }` | 子 Agent 执行失败 |
| `cancelled` | `{ turns }` | 被取消 |
| `timed_out` | `{ timeoutMs }` | 超时 |

## Shell 安全机制

子 Agent 执行 shell 命令时经过两层检查：

### 1. 危险模式检查（不可绕过）

以下模式即使在白名单中也一律拒绝：

```
rm -rf, git push --force, git push -f, git reset --hard,
git clean -f/d/x, chmod 777, dd if=, mkfs.*, > /dev/*
```

### 2. 白名单检查

提取命令的基础名称（处理 `sudo`、`env`、路径前缀），检查是否在白名单中。

### 工作流程

```
子 Agent 请求执行 shell 命令
  → extractBaseCommand(cmd) → 提取基础命令名
  → 危险模式检查 → 拒绝？
  → 白名单检查 → 允许/拒绝
  → executeToolCall → 执行或标记为拒绝
```

## delegate 工具

主 AI 通过 `delegate` 工具使用子 Agent：

### 单任务委托

```xml
<invoke name="delegate" task="搜索项目中所有 TODO 注释" profile="explorer" />
```

### 并发委托

```xml
<invoke name="delegate" tasks='[
  {"task": "检查 auth.js 语法错误", "profile": "explorer"},
  {"task": "运行 npm test", "profile": "builder"},
  {"task": "搜索未使用的导入"}
]' />
```

并发委托使用 `spawnParallel`，每批最多 3 个并发。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task` | string | 是* | 单个子任务描述 |
| `tasks` | array | 是* | 并发任务数组（与 task 二选一） |
| `profile` | string | 否 | Profile 名称（默认 "default"） |
| `tools` | array | 否 | 覆盖 profile 的工具列表 |
| `max_turns` | number | 否 | 覆盖最大轮次 |

## ask 工具

主 AI 使用 `ask` 工具向用户提问：

```xml
<!-- 自由输入 -->
<invoke name="ask" question="使用哪个端口启动？" />

<!-- 带选项 -->
<invoke name="ask" question="选择部署环境" options='["生产","测试","开发"]' />
```

系统暂停 Agent 循环，显示交互式 UI 收集用户输入后恢复。

## TUI 渲染

### 子 Agent 进度

在子 Agent 执行期间，TUI 通过 stdout 输出进度信息：

```
  [Sub] 子Agent已启动: 搜索所有 TODO 注释...
  [..] 子Agent工作中...
  [>>] 子Agent调用: shell
  [OK] 子Agent完成 (3 轮, 2 次工具调用)
```

### 审批提示

危险命令触发审批 UI（暗黄色背景块）：

```
┌──────────────────────────────────┐
│  [!] shell: rm -rf node_modules  │
│  命令可能危险: rm -rf node_modules│
│                                  │
│  > [A] 批准执行                   │
│    [D] 拒绝                       │
│    [E] 编辑命令后执行              │
│                                  │
│  ^v 选择  Enter 确认              │
└──────────────────────────────────┘
```

- **A** — 批准，立即执行
- **D** — 拒绝，工具调用返回被拒绝
- **E** — 编辑命令后重新提交审批

### ask 提示

ask 工具触发交互式提问 UI（暗青色背景块），支持选项选择和自由输入。

## 与旧版 aux 模式的区别

| 特性 | 旧版 aux | 新版 subagent |
|------|----------|---------------|
| AI 实例 | 需要第二个独立账号 | 复用主 AI 的 provider |
| 触发方式 | 用户手动 `/aux` 命令 | AI 自动 `delegate` 工具 |
| 工具限制 | 固定工具集 | 按 profile 可配置 |
| Shell 安全 | 无 | 白名单 + 危险模式检查 |
| 并发 | 不支持 | 支持（最多 3 并发） |
| 超时 | 无 | 可配置 |
| 进度反馈 | 无 | Braille spinner + 事件回调 |
| 取消 | 不支持 | AbortController |
