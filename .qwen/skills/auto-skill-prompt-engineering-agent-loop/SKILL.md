---
name: prompt-engineering-agent-loop
description: Build agent loops with tool calling via prompt engineering (XML-injected tool definitions) for LLM providers that lack native function-calling APIs. Includes the iteration pattern — send, parse tool calls, execute, append results, loop — plus composite conversation storage and dual-AI delegation.
source: auto-skill
extracted_at: '2026-07-11T03:17:12.694Z'
---

# Prompt-Engineering Agent Loop

Use when building an AI agent that needs tool support but the target LLM provider (e.g. DeepSeek web API, Qwen web API) does not expose native function-calling. The agent calls tools by injecting tool definitions into the system prompt and parsing XML tool-call blocks from the response.

## Core Pattern

```
User Input
  → Build prompt (system prompt + tool definitions + task list + message history)
  → Send to AI via provider.startCompletion(messages, { prompt })
  → Stream & collect full response text
  → Parse for <tool_calls> XML blocks using bridge.js parseToolCallsFromText()
  → If tool calls found:
      Execute each tool → append tool results to messages → loop back to send
  → If no tool calls: return final response to user
```

## Key Decisions

### 1. Tool Format: XML matching bridge.js parser

The project's `parseToolCallsFromText()` expects:

```xml
<tool_calls>
  <tool_call>
    <tool_name>shell</tool_name>
    <parameters>{"command":"ls","requires_approval":false}</parameters>
  </tool_call>
</tool_calls>
```

The system prompt MUST teach the AI this exact format. Rules to include:
- Output raw XML (no markdown fences)
- `<parameters>` is strict JSON with double-quoted keys
- Multiple tools in one `<tool_calls>` block are allowed
- Can interleave text before/after XML blocks

### 2. Stateless Calls → Always Send Full Context

**Why:** The agent loop may run 5-15 iterations per user turn. Using `provider.chat()` with sessionId continuation only sends the last user message — but tool results need to be sent as context too.

**How to apply:** Use `provider.startCompletion(messages, { prompt, accountId })` instead of `provider.chat()`. This creates a fresh session each iteration but the full message history is included in the prompt. The per-iteration session overhead is acceptable.

### 3. Composite Conversation Storage

For agents that need multiple remote sessions (main AI + auxiliary AI), store the compound state locally:

```js
{
  id, name,
  main:  { provider, accountId, sessionId },  // main AI session
  aux:   { provider, accountId, sessionId },  // auxiliary AI session
  messages: [],  // aggregated log of ALL interactions
  taskList: [],  // current todo items
  workingDir
}
```

Each file in `~/.chat2cli/agent/<id>.json`. The `messages` array is the single source of truth — it contains user messages, AI responses, and tool results from both AIs.

### 4. Dual-AI Delegation

Main AI handles planning and complex tool use. Auxiliary AI handles simple, independent sub-tasks.

**Delegation trigger:** User types `/aux <task>` or main AI's response contains `@aux <task>`.

**Aux prompt:** Lightweight system prompt that strips out planning instructions and only includes read-only tools (shell, file-read, file-search). Aux responses are appended to the composite conversation.

### 5. Tool Result Format

Tool results must be appended as structured messages so the AI can continue reasoning:

```js
messages.push({
  role: "tool",
  content: JSON.stringify(toolResult.result, null, 2),
  toolName, toolResult
});
```

The `tool` role is recognized by `buildPromptFromMessages()` which prepends `Tool result for <name>:` to the content.

### 6. Iteration Limit

Set a hard limit (15-20 iterations) to prevent infinite loops. If the AI keeps calling tools without converging, yield an error and let the user intervene.

## Integration Points

- **System prompt builder:** Function that accepts `{ workingDir, taskList, toolDefinitions }` and returns a string. Tool definitions should include name, description, and typed parameters.
- **Tool executor:** `executeToolCall(name, params, context)` that dispatches to individual tool handlers and returns `{ result }` or `{ requiresApproval: true, result: {...} }`.
- **Stream adapter:** Different providers have different SSE formats. Use provider-specific consumers (e.g. `consumeQwenStream` for Qwen, `consumeRawStream` for DeepSeek) to collect the full response text before parsing tool calls.

## TUI Considerations

When building a terminal UI for the agent loop:
- Reuse raw mode input patterns (escape sequence handling, CJK-aware cursor, history navigation)
- Stream AI `thinking` and `response` deltas in real-time
- Show tool execution as separate events (`tool_start`, `tool_result`)
- Support Ctrl+C to abort the current loop iteration without exiting the TUI
- After interruption, enter "manual guidance mode" — user can type new instructions before resuming
