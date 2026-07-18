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
- [禁用扩展](#禁用扩展)
- [完整示例](#完整示例)

---

## 快速上手

创建 `~/.chat2cli/extensions/my-ext.js`：

```js
export default {
  name: "my-ext",
  version: "1.0.0",

  // 启动时执行
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
    └── helpers.js      # 可以被 index.js import
```

---

## 扩展接口契约

一个扩展文件 `export default` 一个对象，包含以下可选字段：

```js
{
  name: string,                    // 必填：唯一标识
  version?: string,
  onLoad?(ctx): void,              // 生命周期：加载完成
  onUnload?(): void,               // 生命周期：即将卸载

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
  hooks?: HookRegistration[],     // 生命周期钩子
  serverRoutes?: RouteDefinition[], // HTTP API 路由
}
```

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
      get name() { return "myai"; }
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

> ⚠️ 扩展 provider 不能与内置 provider 重名（deepseek、openai、qwen、glm）。

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

> ⚠️ 扩展工具不能与内置工具重名（shell、file-read、file-write、file-search、todo）。

### 添加 CLI 命令

添加 `chat2cli <命令>` 级别的子命令：

```js
export default {
  name: "my-commands",
  commands: [
    {
      name: "status",
      description: "显示系统状态",
      options: [
        { flags: "-v, --verbose", description: "详细输出" }
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
        // ctx = { composite, workingDir, mainProvider, auxProvider }
        console.log("pong! 参数:", args || "(无)");
      }
    }
  ]
};
```

在 Agent 对话中输入 `/ping hello` 触发。

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

在关键节点插入自定义逻辑：

```js
export default {
  name: "my-hooks",
  hooks: [
    {
      event: "pre:tool_execute",
      handler(payload, ctx) {
        console.log("即将执行:", payload.toolName);
        // 可以修改参数
        // return { payload: { params: { ...payload.params, extra: true } } };
      }
    },
    {
      event: "post:tool_execute",
      handler(payload) {
        // 可以修改结果
        if (payload.toolName === "shell" && payload.result.stdout) {
          // return { payload: { result: { ...payload.result, processed: true } } };
        }
      }
    }
  ]
};
```

钩子处理器返回值：
- `undefined` — 不影响执行
- `{ block: true, reason: "原因" }` — 阻止执行
- `{ payload: { ... } }` — 修改 payload

### 添加 HTTP 路由

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

## 钩子事件一览

| 事件名 | 触发时机 | payload | 可阻止 |
|--------|----------|---------|--------|
| `pre:tool_execute` | 工具执行前 | `{ toolName, params }` | ✅ |
| `post:tool_execute` | 工具执行后 | `{ toolName, params, result }` | ❌ |

> 更多钩子事件将在后续版本中陆续开放。

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
