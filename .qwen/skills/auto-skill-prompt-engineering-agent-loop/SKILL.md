---
name: prompt-engineering-agent-loop
description: Build agent loops with tool calling via prompt engineering (XML-injected tool definitions) for LLM providers that lack native function-calling APIs. Includes the iteration pattern, composite conversation storage, dual-AI delegation, boxed CLI header with ASCII logo, and explicit tool-result rendering in TUI.
source: auto-skill
extracted_at: '2026-07-11T23:36:20.974Z'
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

### 5. Tool Result Format — COMPACT (not JSON)

**Critical insight:** Sending full JSON tool results back to the AI causes token exhaustion. The AI wastes output tokens echoing the JSON structure in its thinking, and the cumulative prompt size from 40 messages of 2000-char JSON can exceed 80K chars.

**Solution:** Format each tool result as compact human-readable text with NO JSON wrapper:

```js
function formatToolResultCompact(toolName, result) {
  switch (toolName) {
    case "shell":
      return `命令: ${result.command}\n退出: ${result.exitCode}\nstdout:\n${result.stdout.slice(-3000)}`;
    case "file-read":
      return `(行 ${result.offset}-${result.offset + result.lines} / 共 ${result.totalLines} 行)\n${result.content.slice(0, 3000)}`;
    case "file-write":
      return result.success ? `已写入: ${result.path}` : `写入失败: ${result.error}`;
    case "file-search":
      return `找到 ${result.count} 处匹配:\n${matches.slice(0, 20).map(m => `${m.file}:${m.line}  ${m.text}`).join('\n')}`;
    case "todo":
      return (result.tasks || []).map(t => `[${t.status}] ${t.content}`).join('\n');
  }
}

// Then:
const resultText = formatToolResultCompact(toolName, toolResult.result);
appendMessage(composite, { role: "tool", content: resultText, ... });
```

And in `buildMessagesForMain`, tool messages no longer need the redundant `工具 xxx 结果:\n` prefix — just send the compact content directly, with `slice(0, 4000)` for safety.

**Why this prevents thinking interruption:** The AI receives 500-1500 chars of useful text per tool result instead of 2000+ chars of JSON with structural overhead. It spends fewer output tokens "thinking" about tool results, leaving headroom for actual reasoning.

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

## Boxed Header with ASCII Logo

When the agent TUI needs a branded header matching the existing chat mode, build a box that scales to terminal width and houses the project's ASCII logo plus agent-specific info rows.

**Pattern** (from `src/agent/tui.js` `printAgentHeader`):

```js
function printAgentHeader({ mainLabel, auxLabel, mainModel, auxModel, projectName, workingDir }) {
  const W = termWidth();       // process.stdout.columns || 80
  const inner = W - 2;         // subtract border chars ╭...╮

  // Reuse the project's existing ASCII art logo (6 lines)
  const logo = [ /* 6 lines of ASCII art */ ];

  // Info rows replace the chat header's single model/session line
  const infoRows = [
    `  主AI: ${bold(mainLabel)}  ${cyan(mainModel)}`,
    `  辅助: ${bold(auxLabel)}  ${cyan(auxModel)}`,
    `  项目: ${bold(projectName)}  ${dim(workingDir)}`
  ];

  // Draw border:  BOX.tl + BOX.h.repeat(inner) + BOX.tr
  // Logo lines:  BOX.v + padL + line + padR + BOX.v  (centered by visualWidth)
  // Gap line:    BOX.v + spaces + BOX.v
  // Info rows:   BOX.v + "  " + row + padR + BOX.v  (left-aligned, 2-space indent)
  // Bottom:      BOX.bl + BOX.h.repeat(inner) + BOX.br
}
```

**Key points:**
- Import `BOX` and `termWidth` from the project's `utils/format.js`
- `visualWidth(s)` must strip ANSI escape codes before measuring; CJK/emoji = 2 cols, ASCII = 1 col
- `BOX` provides corner and edge characters (╭╮╰╯─│)
- The logo is statically defined (does not change per session) so hardcode it
- Info rows should include both the AI provider name AND the selected model so the user can see the full configuration at a glance

## Tool Result Rendering in TUI

Every external tool call must leave a visible trace in the terminal UI. Use distinct renderers per tool type.

### Shell

```
    ✓ SHELL  $ ls -la /tmp                     ← icon + SHELL + command all on SAME line
   drwx------  2 root root 4096 ...            ← output last 5 lines below
   -rw-r--r--  1 root root   42 ...
```

**Rules:**
- Command and SHELL label on the **same line**: `icon + bold("SHELL") + "  $ " + gray(cmdShort)`
- Command truncated to 120 chars, `\n` replaced with space
- Output from `stderr || stdout`, last 5 lines, max 500 chars
- Icon: green ` ✓ ` on success, red ` ✗ ` on failure

### File Read / File Write

```
   ✓ FILE-READ  /path/to/file  (行 0-42 / 共 200 行)   ← path + line range ONLY, no content
```

**Rules:**
- Show **only path + line range**, do NOT emit file content in the UI (the AI sees it via the agent loop; the user gets the compact path + range summary)
- Write: `✓ FILE-WRITE  已写入: /path` in one line

### Thinking Display Pattern

When the AI is reasoning, show a labeled indicator with a rolling tail of the last 4 thinking lines:

```js
let thinkingBuf = "", thinkingActive = false;

case "thinking":
  if (!thinkingActive) { printThinkingLabel(); thinkingActive = true; }
  thinkingBuf += event.text;
  redrawThinkingTail(4);  // in-place refresh of last 4 lines, gray
  break;

case "response":
  clearThinkingDisplay();  // remove thinking tail from screen
  renderMarkdown(event.text, true);
  break;
```

**`redrawThinkingTail`**: Calculate the last 4 lines of `thinkingBuf`, move cursor up by that many rows, clear to bottom of screen, redraw them in `chalk.gray`, cursor back to start.

**`clearThinkingDisplay`**: Move up by the tail line count and clear to bottom. Called before rendering response text to avoid overlap.

### File Search

```
   ✓ SEARCH  content: pattern  (15 个结果)
   │ src/foo.js:42  matching text...
   │ src/bar.js:7   matching text...
   │ … 还有 5 个
```

**Rules:**
- Cap at **10 results**; show remainder count
- Content matches show `file:line` + first 120 chars of matching text
- Filename matches show relative path only

### Todo

```
   ✓ TODO  任务清单已更新 (3 项)
     ○ pending task
     ▶ in-progress task        ← icons: ✓ green / ▶ yellow / ○ gray
     ✓ completed task
```

**Rules:**
- Always show the full task list (no truncation — task lists are small)
- `list` action: print as `TODO:` header followed by items
- `update` action: print success line followed by the new items

## Per-Provider Model Selection

When the agent uses multiple providers, each AI needs its own model selection. Store them separately rather than sharing one model field.

**Pattern** (from `src/commands/agent.js`):

```js
// After selecting main account:
const mainModel = await selectModel(mainProvider, "主AI", composite.mainModel || null);

// After selecting aux account:
const auxModel = await selectModel(auxProvider, "辅助AI", composite.auxModel || null);

// Persist in composite
setModels(composite, mainModel, auxModel);
```

**`selectModel`** lists `provider.getModels()` via inquirer. If only 1 model exists, auto-select it. If continuing an existing composite, restore from `composite.mainModel`/`composite.auxModel`.

**Storage:** `composite.mainModel` and `composite.auxModel` (replacing a single `composite.model`). Backward-compatible — old composites with only `model` get the interactive prompt on next use.

**Propagation:** Pass `mainModel` and `auxModel` through the TUI context to `agent-loop.js`, which passes them as `model:` in `provider.startCompletion()` calls.
