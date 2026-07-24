# chat2cli 扩展开发指南

chat2cli 支持通过 JavaScript 扩展文件（ESM）来定制和增强功能。

## 目录

- [快速上手](#快速上手)
- [扩展文件位置](#扩展文件位置)
- [扩展接口契约](#扩展接口契约)
- [能力说明](#能力说明)
  - [添加 Provider](#添加-provider)
  - [添加 Agent 工具](#添加-agent-工具)
  - [添加 CLI 命令](#添加-cli-命令)
  - [添加 TUI 命令](#添加-tui-命令)
  - [注入提示词片段](#注入提示词片段)
  - [注册生命周期钩子](#注册生命周期钩子)
  - [添加 HTTP 路由](#添加-http-路由)
- [钩子事件一览](#钩子事件一览)
- [访问内部 API](#访问内部-api)
- [`onLoad` 的触发时机](#onload-的触发时机)
- [禁用扩展](#禁用扩展)
- [完整示例](#完整示例)

---

## 快速上手

创建 `~/.chat2cli/extensions/my-ext.js`：

```js
export default {
  name: "my-ext",
  version: "1.0.0",

  // 启动时执行（注意：每条 chat2cli 命令都会触发，详见下文）
  onLoad(ctx) {
    console.log("我的扩展已加载！工作目录:", ctx.cwd);
  },

  // 给主 AI 增加规则
  promptSections: {
    main: "## 自定义规则\n- 所有代码注释用中文\n- 回复末尾加 🚀"
  },

  // 注册 TUI 命令
  tuiCommands: [
    {
      name: "hello",
      description: "打招呼",
      handler(args) {
        console.log("你好世界！" + (args ? " 参数: " + args : ""));
      }
    }
  ]
};
```

在 Agent 模式下输入 `/hello` 即可看到效果。

---

## 扩展文件位置

chat2cli 按以下顺序扫描扩展（后发现的同名扩展被忽略）：

| 路径 | 作用域 |
|------|--------|
| `./.chat2cli/extensions/*.js` | 项目本地 |
| `~/.chat2cli/extensions/*.js` | 全局 |
| `data.json` 中 `extensions.paths` | 自定义路径 |

支持单文件或子目录中的 `index.js`：

```
~/.chat2cli/extensions/
├── my-ext.js           # 单文件扩展
└── my-package/
    ├── index.js        # 子目录入口
    ├── _config.js      # _ 开头的文件会被扫描器跳过（适合作内部辅助模块）
    └── helpers.js       # 可被 index.js import
```

> **`_` 前缀跳过：** 扫描器会跳过文件名以 `_` 开头的 `.js` 文件（如 `_config.js`、`_install.js`）。这些文件不会被当作扩展入口，但可以被 `index.js` 通过 `import` 使用。

### 通过 `data.json` 添加自定义路径

在 `~/.chat2cli/data.json` 中配置：

```json
{
  "extensions": {
    "paths": [
      "/absolute/path/to/my-extensions",
      "../relative/from/home/also/works"
    ],
    "disabled": []
  }
}
```

`paths` 中的每一项是一个目录，chat2cli 会扫描其中的 `.js` 文件和子目录。

---

## 扩展接口契约

一个扩展文件 `export default` 一个对象，包含以下可选字段：

```js
{
  name: string,                              // 必填：唯一标识
  version?: string,
  onLoad?(ctx): void | Promise<void>,         // 生命周期：加载完成
  onUnload?(): void | Promise<void>,          // 生命周期：即将卸载

  // 能力提供
  providers?: ProviderClass[],     // AI 服务商类
  tools?: ToolDefinition[],        // Agent 工具定义
  toolExecutors?: ExecutorEntry[], // 工具执行器
  commands?: CommandDefinition[],  // CLI 命令
  tuiCommands?: TuiCommandDef[],   // Agent TUI 命令
  promptSections?: {               // 提示词片段
    main?: string,
    aux?: string,
  },
  hooks?: HookRegistration[],      // 生命周期钩子
  serverRoutes?: RouteDefinition[], // HTTP API 路由
}
```

> **`onLoad` / `onUnload` 可以是 async：** 两者都支持返回 Promise，chat2cli 会 `await`。`onLoad` 内抛出的异常不会中断 CLI 启动，只会打印警告。

---

## `onLoad` 的触发时机

> ⚠️ **这是最容易踩坑的地方。**

`onLoad` 在扩展系统初始化时被调用，而扩展系统初始化发生在**每条 chat2cli 命令执行前**（`chat`、`agent`、`login`、`serve` 等都会触发）。

这意味着：

- ✅ `onLoad` 适合做：读取配置文件、初始化内存状态、注册回调
- ❌ `onLoad` 不适合做：连接外部服务（数据库、WebSocket、Bot）、阻塞式交互（扫码、等待用户输入）、启动后台任务

如果你需要连接外部服务或做阻塞式交互，应该注册一个 **CLI 命令**（见下文），把重逻辑放在命令的 `handler` 里——`handler` 只在用户显式执行该命令时才触发。

```js
export default {
  name: "my-bot",

  // ✅ 轻量：只读配置
  onLoad(ctx) {
    this.config = readConfig();
  },

  // ✅ 重逻辑放在命令 handler 里
  commands: [{
    name: "start-bot",
    async handler(opts) {
      await myBot.connect();   // 只在 chat2cli start-bot 时执行
      await new Promise(() => {}); // 保持进程存活
    }
  }]
};
```

`onLoad` 收到的 `ctx` 对象：

| 字段 | 类型 | 说明 |
|------|------|------|
| `cwd` | `string` | 当前工作目录 |

---

## 能力说明

### 添加 Provider

注册新的 AI 服务商，供 login / chat / agent / serve 使用。

Provider 类必须实现 `BaseProvider` 的所有方法（见 `src/providers/base.js`）：

```js
export default {
  name: "my-provider",
  providers: [
    class MyAiProvider {
      get name() { return "myai"; }       // 不能与内置重名
      get label() { return "MyAI"; }
      async login(credentials) { /* 保存凭据 */ }
      async *chat(messages, options) { /* yield { kind, text } */ }
      getModels() { return [{ id: "myai-v1", label: "MyAI v1" }]; }
      getAccountInfo() { return null; }
      isAuthenticated() { return false; }
    }
  ]
};
```

> ⚠️ 扩展 provider 不能与内置 provider 重名（deepseek、openai、qwen、glm）。冲突的 provider 会被静默跳过并打印警告。

### 添加 Agent 工具

工具由两部分组成：**定义**（注入系统提示词）和**执行器**（运行逻辑）。

```js
export default {
  name: "my-tools",
  tools: [
    {
      name: "weather",                   // 工具名（AI 在 <invoke> 中使用）
      description: "查询指定城市的天气。",
      parameters: {
        city: { type: "string", required: true, description: "城市名" }
      }
    }
  ],
  toolExecutors: [
    {
      name: "weather",
      async fn(params, context) {
        // context = { workingDir, taskList, shellTimeout }
        const city = params.city;
        // ... 调用天气 API ...
        return {
          result: { success: true, city, temp: "22°C", condition: "晴" }
        };
      }
    }
  ]
};
```

> ⚠️ 扩展工具不能与内置工具重名（shell、file-read、file-write、file-search、todo）。冲突的会被静默跳过。

### 添加 CLI 命令

添加 `chat2cli <命令>` 级别的子命令。命令通过 commander 注册，支持 options 和 async handler：

```js
export default {
  name: "my-commands",
  commands: [
    {
      name: "status",
      description: "显示系统状态",
      options: [
        { flags: "-v, --verbose", description: "详细输出", defaultValue: false }
      ],
      async handler(opts) {
        console.log("状态: 正常");
        if (opts.verbose) console.log("详细: ...");
      }
    }
  ]
};
```

运行：`chat2cli status` 或 `chat2cli status -v`

#### `options` 字段

每个 option 对象支持：

| 字段 | 类型 | 说明 |
|------|------|------|
| `flags` | `string` | commander 风格的 flag 定义，如 `"-v, --verbose"` 或 `"--port <num>"` |
| `description` | `string` | 帮助文本 |
| `defaultValue` | `any` | 可选，默认值 |

#### handler 语义

- `handler(opts)` 接收 commander 解析后的选项对象。
- `handler` 被 `await`，支持 async。
- 如果 handler **不返回**（例如维持 WebSocket 连接、`await new Promise(() => {})`），进程会保持存活——适合需要长驻的扩展（如 Bot 监听）。
- `this` **不指向**扩展对象——handler 是普通函数调用。如需访问扩展状态，使用模块级变量或闭包引用：

```js
const ext = {
  name: "my-bot",
  state: null,

  onLoad() { ext.state = "ready"; },   // onLoad 里 this === ext，但用闭包更安全

  commands: [{
    name: "bot",
    async handler(opts) {
      // ❌ this.state 不可用（this 不指向 ext）
      // ✅ 通过模块级变量引用
      console.log(ext.state);
    }
  }]
};
export default ext;
```

> ⚠️ 命令名不能与内置命令重名（chat、agent、login、serve、history、config、apikey）。冲突的会被跳过。

### 添加 TUI 命令

添加 Agent 模式下的 `/` 命令：

```js
export default {
  name: "my-tui-cmds",
  tuiCommands: [
    {
      name: "ping",
      description: "测试连通性",
      handler(args, ctx) {
        // ctx = { composite, workingDir, mainProvider }
        console.log("pong! 参数:", args || "(无)");
      }
    }
  ]
};
```

在 Agent 对话中输入 `/ping hello` 触发。

#### handler 签名

```
handler(args: string, ctx: { composite, workingDir, mainProvider })
```

| 参数 | 说明 |
|------|------|
| `args` | 用户输入中命令名之后的原始文本（已 trim） |
| `ctx.composite` | 当前 Agent 的复合对话对象 |
| `ctx.workingDir` | 工作目录 |
| `ctx.mainProvider` | 当前主 AI 服务商实例 |

### 注入提示词片段

直接追加文本到系统提示词末尾，无需手动拼接：

```js
export default {
  name: "team-rules",
  promptSections: {
    main: `
## 团队规范
- 缩进 2 空格
- 函数必须有 JSDoc
- 禁止 console.log 用于调试（用 debug 模块）
`,
    aux: `
## 辅助 AI 规范
- 回答不超过 100 字
`
  }
};
```

- `main` — 追加到主 AI 系统提示词
- `aux` — 追加到辅助 AI 系统提示词

### 注册生命周期钩子

在关键节点插入自定义逻辑。钩子按注册顺序执行，前一个的返回值会影响后续流程：

```js
export default {
  name: "my-hooks",
  hooks: [
    {
      event: "pre:tool_execute",
      handler(payload, ctx) {
        // payload = { toolName, params }
        // ctx = { cwd }
        console.log("即将执行:", payload.toolName);

        // 修改参数（会传递给工具执行器）
        // return { payload: { params: { ...payload.params, extra: true } } };

        // 阻止执行
        // return { block: true, reason: "该工具被禁用" };
      }
    },
    {
      event: "post:tool_execute",
      handler(payload, ctx) {
        // payload = { toolName, params, result }
        // 可以修改 result
        // return { payload: { result: { ...payload.result, processed: true } } };
      }
    }
  ]
};
```

#### 钩子处理器返回值

| 返回值 | 效果 |
|--------|------|
| `undefined` / `null` | 不影响执行，继续下一个钩子 |
| `{ block: true, reason: "..." }` | 阻止工具执行，AI 收到阻止提示 |
| `{ payload: { ... } }` | 合并到 payload，修改后续行为（`params` 或 `result`） |

> 钩子 handler 支持 async（返回 Promise）。钩子内抛出的异常不会中断 Agent 循环，只会打印警告。

---

## 钩子事件一览

| 事件名 | 触发时机 | payload | ctx | 可阻止 |
|--------|----------|---------|-----|--------|
| `pre:tool_execute` | 工具执行前 | `{ toolName, params }` | `{ cwd }` | ✅ |
| `post:tool_execute` | 工具执行后 | `{ toolName, params, result }` | `{ cwd }` | ❌ |
| `pre:response_start` | AI 开始输出前 | `{ model }` | `{}` | ❌ |

> 更多钩子事件将在后续版本中陆续开放。

---

## 访问内部 API

扩展可以通过 `import` 直接使用 chat2cli 的内部模块。这对需要深度集成的扩展（如自己运行 Agent 循环、管理复合对话存储）非常有用。

### 可用模块

| 模块路径（相对扩展文件） | 导出 | 用途 |
|--------------------------|------|------|
| `agent-loop.js` | `runAgentLoop(userInput, opts)` | 运行完整 Agent 循环（工具调用、审批、子 Agent） |
| `storage/composite.js` | `createComposite`, `getComposite`, `saveComposite`, `appendMessage` | 复合对话的创建/读取/追加 |
| `providers/registry.js` | `getProvider(name)`, `listProviders()` | 查询已登录的 AI 服务商 |

> 模块路径需要根据扩展文件的实际位置调整。例如扩展在 `~/.chat2cli/extensions/` 下时，CLI 源码的相对路径可能是 `../../cli/src/...` 或通过 `createRequire` 解析。

### 示例：在扩展中运行 Agent 循环

```js
import { runAgentLoop } from "../../cli/src/agent/agent-loop.js";
import { getComposite, createComposite, saveComposite } from "../../cli/src/agent/storage/composite.js";

export default {
  name: "my-agent-runner",
  commands: [{
    name: "run-task",
    async handler(opts) {
      const provider = /* 获取已登录的 provider */;
      const composite = getComposite("my-task") || createComposite({ name: "My Task" });
      composite.main.provider = provider.name;

      for await (const event of runAgentLoop("帮我创建一个文件", {
        mainProvider: provider,
        composite,
        workingDir: process.cwd(),
      })) {
        if (event.type === "response") console.log(event.text);
        if (event.type === "approval_required") event.resolve({ approved: true });
      }
      saveComposite(composite);
    }
  }]
};
```

`runAgentLoop` 产出的事件类型包括：`tool_start`、`tool_result`、`response`、`approval_required`、`ask_user`、`subagent_spawn`、`subagent_result`、`info`、`done`、`error`。

---

## 添加 HTTP 路由

为 OpenAI 兼容 API 服务器添加自定义端点：

```js
export default {
  name: "my-routes",
  serverRoutes: [
    {
      method: "GET",
      path: "/v1/health",
      async handler(req, res) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      }
    }
  ]
};
```

启动 `chat2cli serve` 后访问 `http://127.0.0.1:3000/v1/health`。

> 扩展路由在 `/v1/*` 下检查，不会覆盖内置端点。

---

## 禁用扩展

在 `~/.chat2cli/data.json` 中配置：

```json
{
  "extensions": {
    "disabled": ["hello-world", "my-ext"]
  }
}
```

被禁用的扩展不会被加载（`onLoad` 不会触发）。

或通过 CLI 管理（计划中）：

```bash
chat2cli config ext disable hello-world
chat2cli config ext enable hello-world
```

---

## 完整示例

参见 `examples/extensions/hello-world.js`，演示了所有支持的能力：

- ✅ 2 个 Agent 工具（greet、datetime）
- ✅ 2 个 TUI 命令（/hello、/time）
- ✅ 提示词片段注入（main + aux）
- ✅ 生命周期钩子（pre/post tool_execute）
- ✅ onLoad / onUnload 生命周期

安装方式：

```bash
cp examples/extensions/hello-world.js ~/.chat2cli/extensions/
chat2cli agent    # 启动后在对话中输入 /hello
```
