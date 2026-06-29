# chat2cli

> 多 AI 终端聊天工具 - 在命令行中与 DeepSeek、OpenAI 等 AI 对话

## 功能特性

- **多 AI 服务商支持** - DeepSeek、OpenAI，架构设计支持扩展更多
- **多账号登录** - DeepSeek 支持多个账号并存，聊天时可选
- **流式输出** - 实时显示 AI 回复，支持思考过程展示
- **云端会话同步** - 查看/继续 DeepSeek 网页端的会话历史
- **OpenAI 兼容 API** - 启动 HTTP 服务，提供 `/v1/models` 和 `/v1/chat/completions` 接口
- **API Key 管理** - 生成分发 API Key，不暴露原始凭据
- **对话历史** - 自动保存本地对话，支持查看、搜索、继续、删除
- **模型切换** - 对话中随时切换模型
- **本地存储** - 数据保存在 `~/.chat2cli/` 目录，纯 JSON 格式

## 快速开始

### 安装依赖

```bash
cd cli
npm install
```

### 运行

```bash
# 直接运行
node bin/chat2cli.js --help

# 或使用 npm link 全局安装
npm link
chat2cli --help
```

## 命令说明

### `chat2cli login` — 登录 AI 服务商

```bash
chat2cli login
```

- **DeepSeek**: 输入邮箱/手机号和密码，自动获取 token，支持多账号
- **OpenAI**: 输入 API Key，可选自定义 base URL

### `chat2cli chat` — 开始对话

```bash
# 交互式对话
chat2cli chat

# 单条消息
chat2cli chat -m "用中文解释什么是递归"

# 指定模型
chat2cli chat -m "hello" --model deepseek-reasoner-fast
```

对话模式内置命令：

| 命令 | 说明 |
|------|------|
| `/exit` | 保存并退出 |
| `/clear` | 清空上下文 |
| `/model <名称>` | 切换模型 |
| `/models` | 列出可用模型 |
| `/help` | 显示帮助 |

### `chat2cli history` — 管理对话历史

```bash
chat2cli history                    # 本地对话列表
chat2cli history show <id>          # 查看详情
chat2cli history delete <id>        # 删除
chat2cli history continue <id>      # 继续对话
chat2cli history search <关键词>     # 搜索
chat2cli history clear              # 清空

# DeepSeek 云端会话
chat2cli history ds                 # 获取 DS 云端会话列表
chat2cli history ds-continue <id>   # 继续云端会话
chat2cli history ds-delete <id>     # 删除云端会话
```

### `chat2cli config` — 配置管理

```bash
chat2cli config                         # 查看配置（含多账号）
chat2cli config set defaultProvider openai
chat2cli config set defaultModel deepseek-chat-fast
```

### `chat2cli apikey` — API Key 管理

```bash
chat2cli apikey                    # 列表
chat2cli apikey create             # 创建（选择服务商 + 备注）
chat2cli apikey show <id>          # 查看完整 key
chat2cli apikey delete <id>        # 删除
```

### `chat2cli serve` — 启动 OpenAI 兼容 API 服务

```bash
chat2cli serve                     # 默认 3000 端口
chat2cli serve -p 8080             # 指定端口
```

端点：
- `GET  /v1/models`
- `POST /v1/chat/completions`

## 支持的模型

### DeepSeek

| 模型 ID | 说明 |
|---------|------|
| deepseek-chat-fast | 快速对话 |
| deepseek-chat-fast-search | 快速对话（联网）|
| deepseek-reasoner-fast | 快速推理 |
| deepseek-reasoner-fast-search | 快速推理（联网）|
| deepseek-chat-expert | 专家对话 |
| deepseek-chat-expert-search | 专家对话（联网）|
| deepseek-reasoner-expert | 专家推理 |
| deepseek-reasoner-expert-search | 专家推理（联网）|

### OpenAI

| 模型 ID | 说明 |
|---------|------|
| gpt-4o | GPT-4o |
| gpt-4o-mini | GPT-4o Mini |
| gpt-4-turbo | GPT-4 Turbo |
| gpt-3.5-turbo | GPT-3.5 Turbo |
| o1 | o1 |
| o3-mini | o3-mini |

## 数据存储

所有数据保存在 `~/.chat2cli/data.json`，包括：

- 服务商凭据（DeepSeek token、OpenAI API Key 等）
- API Keys
- 本地对话历史
- 用户配置

## 项目结构

```
cli/
├── bin/chat2cli.js               # CLI 入口
├── src/
│   ├── bridge.js                 # OpenAI ↔ DeepSeek 协议桥接
│   ├── config.js                 # 全局配置
│   ├── server.js                 # HTTP API 服务
│   ├── commands/
│   │   ├── login.js              # 登录
│   │   ├── chat.js               # 交互式对话
│   │   ├── history.js            # 历史管理
│   │   ├── config.js             # 配置管理
│   │   ├── apikey.js             # API Key 管理
│   │   └── serve.js              # API 服务入口
│   ├── providers/
│   │   ├── base.js               # Provider 抽象基类
│   │   ├── registry.js           # Provider 注册中心
│   │   ├── deepseek/
│   │   │   ├── index.js          # DeepSeekProvider
│   │   │   ├── auth.js           # 登录 / Token
│   │   │   ├── proxy.js          # 代理请求 + 会话管理
│   │   │   ├── chat.js           # 对话请求
│   │   │   └── pow-solver.js     # PoW 挑战求解
│   │   └── openai/index.js       # OpenAIProvider
│   ├── storage/store.js          # JSON 文件存储
│   └── utils/
│       ├── id.js                 # ID 生成
│       ├── sse.js                # SSE 流解析
│       └── format.js             # 终端格式化
└── package.json
```

## 扩展新的 AI 服务商

继承 `BaseProvider` 并实现必要方法：

```javascript
import { BaseProvider } from "./base.js";

export class MyProvider extends BaseProvider {
  get name() { return "my-provider"; }
  get label() { return "My AI"; }

  async login(credentials) { /* ... */ }
  async *chat(messages, options) { /* ... */ }
  getModels() { /* ... */ }
  getAccountInfo() { /* ... */ }
  isAuthenticated() { /* ... */ }
}
```

然后在 `src/providers/registry.js` 中注册即可。

## 运行要求

- Node.js 18+
- DeepSeek 需要能够访问 chat.deepseek.com
- OpenAI 需要能够访问 api.openai.com

## 致谢

本项目 DeepSeek Provider 的核心代码参考自 [TQZHR/deepseek2api](https://github.com/TQZHR/deepseek2api)，包括：

- DeepSeek 登录认证与 Token 管理
- PoW 挑战求解与代理请求
- SSE 流式响应解析
- OpenAI 格式的协议桥接设计

特此感谢 TQZHR 的开源贡献。

## License

MIT
