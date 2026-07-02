# chat2cli

> 多 AI 终端聊天工具 - 支持在命令行中与 DeepSeek、OpenAI、Qwen(通义千问) 等 AI 对话，同时提供 OpenAI 兼容的 HTTP API 桥接服务。

## 功能特性

- **多 AI 服务商支持** - DeepSeek、OpenAI、Qwen(通义千问)
- **多账号登录** - DeepSeek / Qwen 支持多个账号并存，聊天时可选
- **流式输出** - 实时显示 AI 回复，支持思考过程展示
- **对话历史** - 自动保存本地对话，支持查看、搜索、继续、删除
- **历史记录选择器** - `chat` 命令默认展示历史列表，上下键选择新对话或继续已有对话，支持云端会话滚动加载
- **云端会话同步** - 查看/继续/删除 DeepSeek 网页端的会话历史
- **OpenAI 兼容 API** - 启动 HTTP 服务，提供 `/v1/models` 和 `/v1/chat/completions` 接口
- **Function Calling** - API 服务支持 OpenAI 兼容的 `tools`/`tool_choice` 工具调用
- **API Key 管理** - 生成分发 API Key，支持自定义 Key 值，每个 Key 可绑定到独立账号
- **模型切换** - 对话中随时切换模型
- **Markdown 渲染** - 支持标题/代码块/表格/列表等，可通过 `--no-markdown` 关闭
- **批量管理** - 多选删除本地对话和云端会话
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
- **Qwen (通义千问)**:
  - 邮箱 + 密码登录（推荐）— 自动调用 Qwen 登录 API 获取 token
  - 或手动输入 Bearer Token

### `chat2cli chat` — 开始对话

```bash
# 交互式对话（默认展示历史列表，上下键选择）
chat2cli chat

# 直接开始新对话
chat2cli chat -n
chat2cli chat --new

# 禁用 Markdown 渲染
chat2cli chat --no-markdown

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

**历史记录选择器**：运行 `chat2cli chat`（不带 `-m`）时，会展示所有本地对话和 DeepSeek 云端会话列表。第一行 "新对话"，用 ↑↓ 导航、Enter 确认、Ctrl+C 取消。滚动到底部附近会自动加载更多云端会话。

### `chat2cli history` — 管理对话历史

```bash
chat2cli history                         # 本地对话列表
chat2cli history show <id>               # 查看详情
chat2cli history delete <id>             # 删除
chat2cli history continue <id>           # 继续对话
chat2cli history search <关键词>          # 搜索
chat2cli history clear                   # 清空

# DeepSeek 云端会话
chat2cli history ds                      # 获取 DS 云端会话列表（默认 50 条）
chat2cli history ds --limit 100          # 获取 100 条
chat2cli history ds-continue <id>        # 继续云端会话
chat2cli history ds-continue --limit 70 <id>  # 扩大搜索范围
chat2cli history ds-delete <id>          # 删除云端会话
chat2cli history ds-delete --limit 70 <id>   # 扩大搜索范围

# 批量操作（多选 UI：空格选择，上下键切换，Enter 确认）
chat2cli history batch-local           # 多选删除本地对话
chat2cli history batch-ds              # 多选删除云端会话
chat2cli history batch-ds --limit 100  # 扩大云端会话加载范围
```

会话 ID 支持前缀匹配，只需输入前几位即可。

### `chat2cli config` — 配置管理

```bash
chat2cli config                             # 查看配置（含多账号）
chat2cli config set defaultProvider qwen    # 切换默认服务商
chat2cli config set defaultProvider deepseek
chat2cli config set defaultProvider openai
chat2cli config set defaultModel deepseek-chat-fast
```

### `chat2cli apikey` — API Key 管理

```bash
chat2cli apikey                        # 列表（含绑定状态）
chat2cli apikey create                 # 创建（支持自定义 Key 值）
chat2cli apikey show <id>              # 查看完整 key 及绑定信息
chat2cli apikey bind <id>              # 绑定 Key 到指定账号
chat2cli apikey unbind <id>            # 解除 Key 的账号绑定
chat2cli apikey delete <id>            # 删除
```

**API Key → 账号 绑定关系**: 每个 API Key 必须绑定到一个具体的服务商账号才能通过 API 服务使用。未绑定的 Key 在请求时会返回 403 错误。

创建时支持**自定义 Key 值**（留空则自动生成 `sk-` 前缀的随机字符串）。

### `chat2cli serve` — 启动 OpenAI 兼容 API 服务

```bash
chat2cli serve                     # 默认 3000 端口
chat2cli serve -p 8080             # 指定端口
```

**前置条件**: API Key 必须先通过 `chat2cli apikey bind <id>` 绑定到账号，否则请求会返回 403。

端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 模型列表（聚合所有服务商）|
| POST | `/v1/chat/completions` | 对话补全（流式/非流式）|

**工具调用 (Function Calling)**: 支持 OpenAI 兼容的 `tools` 和 `tool_choice` 参数，模型会以 XML 格式输出工具调用，服务端自动解析为标准的 `tool_calls` delta 块。

```bash
# 使用示例：带工具的流式对话
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat-fast",
    "messages": [{"role": "user", "content": "北京今天天气如何？"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string", "description": "城市名称"}
          },
          "required": ["city"]
        }
      }
    }],
    "stream": true
  }'
```

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

### Qwen (通义千问)

| 模型 ID | 说明 |
|---------|------|
| qwen-max | Qwen Max |
| qwen-plus | Qwen Plus |
| qwen-turbo | Qwen Turbo |
| qwen3-max | Qwen3 Max |
| qwen3-plus | Qwen3 Plus |
| qwen3-turbo | Qwen3 Turbo |
| qwen3-coder | Qwen3 Coder |
| qwen3.5-coder | Qwen3.5 Coder |
| qwen-coder-plus | Qwen Coder Plus |
| qwen-coder-turbo | Qwen Coder Turbo |
| qwen2.5-coder | Qwen2.5 Coder |
| qwq-plus | QwQ Plus |
| qwq-plus-latest | QwQ Plus Latest |
| qwq | QwQ |
| qwen-vl-max | Qwen VL Max |
| qwen-vl-plus | Qwen VL Plus |

## 数据存储

所有数据保存在 `~/.chat2cli/data.json`，包括：

- 服务商凭据（DeepSeek token、OpenAI API Key、Qwen token 等）
- API Keys
- 本地对话历史
- 用户配置

## 项目结构

```
cli/
├── bin/chat2cli.js               # CLI 入口
├── src/
│   ├── bridge.js                 # OpenAI ↔ DeepSeek/Qwen 协议桥接
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
│   │   ├── openai/index.js       # OpenAIProvider
│   │   └── qwen/index.js         # QwenProvider
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
- Qwen 需要能够访问 chat.qwen.ai

## 致谢

本项目核心代码参考了以下开源项目：

**DeepSeek Provider**: 参考 [TQZHR/deepseek2api](https://github.com/TQZHR/deepseek2api)：
- DeepSeek 登录认证与 Token 管理
- PoW 挑战求解与代理请求
- SSE 流式响应解析
- OpenAI 格式的协议桥接设计
- XML 工具调用解析 (Tool Parser) 与流式拦截 (Tool Sieve)
- Function Calling prompt 构建与消息规范化

**Qwen Provider**: 参考 [qwen2API](https://github.com/YuJunZhiXue/qwen2API)：
- SSE 流式响应解析（ParseQwenEvent）
- 聊天 payload 构建格式
- 基于邮箱和密码登录由我实现(小小的骄傲一下www)

特此感谢 TQZHR 及 qwen2API 的开源贡献。

## License

MIT
