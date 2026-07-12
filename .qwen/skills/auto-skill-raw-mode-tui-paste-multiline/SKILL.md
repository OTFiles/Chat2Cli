---
name: raw-mode-tui-paste-multiline
description: Fix paste truncation and multi-line wrapping in Node.js raw-mode TUI input handlers. Use when pasted text gets cut at newlines or long input pushes the terminal footer off-screen.
source: auto-skill
extracted_at: '2026-07-12T02:36:32.506Z'
---

# Raw Mode TUI Paste & Multi-line Fix

## Problem

In Node.js CLIs using `process.stdin.setRawMode(true)` for interactive input,
two bugs are common:

1. **Paste truncation**: pasted multi-line text gets cut at `\r` (CR, code 13),
   sending only the first line as a message immediately.
2. **Multi-line footer corruption**: long single-line input wraps across terminal
   rows, but `redrawPrompt()` only clears one line, leaving visual artifacts and
   pushing the footer out of view.

## Root Cause

| Symptom | Cause |
|---------|-------|
| Paste cut at CR | `\r` (code 13) in paste data hits the Enter handler, which sends the partial input before the rest of the paste arrives |
| Footer pushed off | `redrawPrompt` uses `\r` (carriage return) which only moves to the start of the *current* line — wrapped lines above are left uncleared |

## Solution

### 1. Paste Detection

Detect paste by checking if multiple characters arrived in a single `data` event:

```js
const onData = (buf) => {
  const str = buf.toString("utf-8");
  const isPaste = str.length > 3;   // heuristic: >3 chars in one event = paste

  for (const ch of str) {
    const code = ch.charCodeAt(0);
    // ...
  }
};
```

### 2. Filter CR During Paste

Skip the Enter handler when `\r` arrives as part of a paste:

```js
// Enter: skip during paste, normal send otherwise
if (code === 13) {
  if (isPaste) continue;          // ← KEY FIX: don't treat paste-CR as Enter
  // ... normal send logic
}
```

### 3. Replace LF With Space During Paste

Pasted `\n` (LF, code 10) becomes a space to preserve readability without
inserting literal newlines that break single-line input flow:

```js
// LF: space during paste, literal newline during normal typing
if (code === 10) {
  if (isPaste) {
    insertChar(" ");              // "line1\nline2" → "line1 line2"
  } else {
    insertChar("\n");
  }
  continue;
}
```

### 4. Multi-line Aware Redraw

Calculate how many visual lines the input occupies, move cursor to the first
line, then redraw from there:

```js
function redrawPrompt() {
  // Count visual lines (accounting for CJK double-width chars)
  const promptW = 4; // "   > "  prompt prefix
  let w = promptW;
  for (const ch of input) w += charWidth(ch);   // charWidth: CJK=2, ASCII=1
  const lines = Math.max(1, Math.ceil(w / termWidth()));

  // Multi-line: move cursor to the first line of the input block
  if (lines > 1) {
    process.stdout.write(`\x1b[${lines - 1}A`);
  }

  // Redraw from the first line
  process.stdout.write("\r");
  process.stdout.write("   > ");
  process.stdout.write(input);
  process.stdout.write("\x1b[0K");   // clear to end of current line
  // ... cursor positioning ...
}
```

### 5. Footer Clear / Draw With Variable Height

```js
const inputLines = Math.max(1, Math.ceil(inputVisualWidth / termWidth()));

function clearFooter() {
  process.stdout.write(`\x1b[${inputLines + 1}A\r\x1b[J`);
}

function drawFooter() {
  printFooterMsg();
  process.stdout.write(`\x1b[${inputLines + 1}A\r`);
  process.stdout.write("   ❯ ");
}
```

### 6. Long-input Truncation (Optional)

When input exceeds ~300 chars, show a compact summary in the prompt:

```js
if (input.length > 300) {
  process.stdout.write(`[共 ${input.length} 个字符]`);
} else {
  process.stdout.write(input);
}
```

Same for the echo line after Enter is pressed (the "   ❯ user message" line).

## Why

- `\r` (CR, 0x0D) is part of CRLF (`\r\n`) line endings common in clipboard
  data from Windows apps and many terminal paste implementations
- Raw mode sends paste data as a character burst — the Enter handler fires
  on the first `\r`, discarding the rest
- Terminal `\r` only moves to column 0 of the *current* line; wrapped lines
  above remain visible, causing visual corruption

## When to Apply

Any Node.js CLI tool with:
- `process.stdin.setRawMode(true)` for interactive input
- Character-by-character input processing in a `data` event handler
- A fixed-position footer or status bar below the input area
- Users who paste multi-line text (code snippets, URLs, logs)
