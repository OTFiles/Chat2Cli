---
name: raw-mode-tui-paste-multiline
description: Fix paste truncation, multi-line wrapping, CJK ghost text, and burst-mode UX in Node.js raw-mode TUI input handlers. Covers burst detection, atomic paste deletion, multi-line scroll, visual-width truncation, single-pass \x1b[0G\x1b[K rendering, prompt prefix on first line only, cursor positioning after redraw, burst chunk persistence, and footer adaptation.
source: auto-skill
extracted_at: '2026-07-13T02:33:53.133Z'
updated_at: '2026-07-13T05:02:45.808Z'
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

### 1. Burst Detection (Time-Based)

Simple `str.length > 3` per event is too coarse — normal fast typing of 4+ chars also triggers it.
Use **time-based** burst detection instead:

```js
let lastDataTime = 0;
let burstMode = false;
const pasteChunks = []; // [{start, end}] — atomic paste units for deletion

const onData = (buf) => {
  const now = Date.now();
  const str = buf.toString();

  // 50ms 内连续多个字符 → burst (likely a paste)
  if (str.length > 1 && now - lastDataTime < 50) {
    burstMode = true;
    if (str.length > 2) {
      pasteChunks.push({ start: cursor, end: cursor + str.length });
    }
  // 300ms 间隔单字符 → normal typing (exit burst)
  } else if (str.length <= 2 && now - lastDataTime > 300) {
    burstMode = false;
    pasteChunks.length = 0;
  }
  lastDataTime = now;
  // ... process characters
};
```

### 2. Filter CR During Burst

```js
if (code === 13) {
  if (burstMode) continue;       // ← paste-CR is NOT Enter
  // ... normal send logic, then resetPasteMode()
}
```

### 3. Replace LF With Space During Burst

Pasted `\n` (LF, code 10) becomes a space to preserve readability without
inserting literal newlines that break single-line input flow:

```js
if (code === 10) {
  if (burstMode) {
    insertChar(" ");              // "line1\nline2" → "line1 line2"
  } else {
    insertChar("\n");             // normal literal newline
  }
  continue;
}
```

### 4. Atomic Paste Deletion

Each paste is tracked as an atomic chunk in `pasteChunks[]`. When backspacing
at a chunk boundary, the entire paste is deleted in one keystroke:

```js
function deleteChunkAt(cursorPos) {
  const idx = pasteChunks.findIndex(c => c.end === cursorPos);
  if (idx === -1) return false;  // no chunk boundary here
  const c = pasteChunks[idx];
  // delete the entire chunk
  currentInput = currentInput.slice(0, c.start) + currentInput.slice(c.end);
  cursor = c.start;
  // adjust remaining chunk positions
  adjustChunksAfterDelete(c.start, c.end - c.start);
  pasteChunks.splice(idx, 1);
  return true;
}

// In backspace handler:
if (cursor > 0) {
  if (deleteChunkAt(cursor)) { redrawPrompt(); continue; }
  // ... normal single-char deletion, then adjustChunksAfterDelete(cursor, 1)
}
```

**`adjustChunksAfterDelete(pos, len)`**: Shift all chunk boundaries that come
after the deletion point. Chunks that overlap the deletion get their `end`
trimmed. This keeps chunk coordinates correct after any edit.

### 5. Multi-line Scroll-Cap (max 5 visible lines)

When input exceeds 5 visual lines, cap the visible area to 5 lines and use
`scrollOffset` to allow the user to scroll with ↑↓ keys:

```js
const MAX_VISIBLE = 5;
let scrollOffset = 0;

function redrawPrompt() {
  // Compute wrapLines from input (array of visual lines)
  const wrapLines = computeWrapLines(input, termWidth() - 4);
  const vis = Math.min(MAX_VISIBLE, Math.max(1, wrapLines.length));

  // Clamp scrollOffset
  const maxOff = Math.max(0, wrapLines.length - vis);
  if (scrollOffset > maxOff) scrollOffset = maxOff;

  // Move cursor to first visible line, redraw vis lines
  process.stdout.write(`\x1b[${vis}A\r`);
  const visible = wrapLines.slice(scrollOffset, scrollOffset + vis);
  for (let i = 0; i < vis; i++) {
    process.stdout.write("\r   ❯ " + (visible[i] || ""));
    process.stdout.write("\x1b[K\n");
  }
  process.stdout.write(`\x1b[${vis}A`); // cursor back to top
}

// ↑↓ arrows (when NOT navigating history):
if (ch === "A" && scrollOffset > 0) { scrollOffset--; redrawPrompt(); }
if (ch === "B") {
  const maxOff = Math.max(0, wrapLines.length - vis);
  if (scrollOffset < maxOff) scrollOffset++;
  redrawPrompt();
}
```

**Burst mode truncation**: When `burstMode` is active and input > 300 chars,
show pre-paste typed text + collapsed paste indicator (not hiding everything):

```js
if (burstMode && input.length > 300 && pasteChunks.length > 0) {
  const prePasteStart = pasteChunks[0].start;
  const prePaste = input.slice(0, prePasteStart);          // text typed BEFORE first paste
  const pasteLen = pasteChunks.reduce((s, c) => s + (c.end - c.start), 0);

  let prefix = prePaste;
  if (prePaste.length > 40) prefix = "…" + prePaste.slice(-40);
  const label = gray(` […${pasteLen} 字符 …]`);            // only count pasted chars
  const display = prefix + label;

  // Render display text (may wrap if prefix + label is long)
  // … wrapLines computation, then two-pass clear+write with truncateByVisualWidth
}
```

**Why show pre-paste text:** If the user typed e.g. "请分析这段代码：" then pasted
5000 chars, hiding ALL input makes them lose context. Showing the prefix +
paste count lets them verify "yes, this is pasted after the right prompt."

**Burst-mode backspace (delete entire chunk):** When the `[…]` placeholder is shown,
per-character backspace is useless (cursor position is invisible). Instead, delete
the last pasteChunk atomically:

```js
// In backspace handler:
if (burstMode && pasteChunks.length > 0 && input.length > 300) {
  const lastChunk = pasteChunks.pop();
  const arr = Array.from(input);
  arr.splice(lastChunk.start, lastChunk.end - lastChunk.start);
  input = arr.join("");
  cursor = lastChunk.start;
  adjustChunksAfterDelete(lastChunk.start, lastChunk.end - lastChunk.start);
  if (pasteChunks.length === 0) resetPasteMode();
  redrawPrompt();
  continue;
}
```

### 7. CJK Visual-Width Truncation (Critical)

**Problem:** When CJK text is mixed with ASCII, `.slice(0, safeW)` truncates by
**character count**, not visual width. A CJK character occupies 2 terminal columns.
So `.slice(0, 78)` on CJK text can render up to 156 columns — way past the
terminal width — triggering the terminal's own auto-wrap mechanism. The resulting
wrapped ghost line persists because `\x1b[K` only clears to the end of the
*current* (logical) line, not the auto-wrapped continuation.

**Symptom:** Text from previous render frames appears as ghost duplicates on the
line below the real content, especially at terminal edge columns.

**Fix:** Truncate by cumulative visual width, not character index:

```js
/** 按视觉宽度截断字符串（CJK/emoji 计 2 列），杜绝终端自动换行残留 */
function truncateByVisualWidth(s, maxW) {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const cw = charWidth(s[i]);   // CJK → 2, ASCII → 1
    if (w + cw > maxW) return s.slice(0, i);
    w += cw;
  }
  return s;
}

// In redrawPrompt (two-pass clear-then-write):
const safeW = Math.max(0, termWidth - promptWidth - 2); // -2 safety margin
for (const line of visibleLines) {
  process.stdout.write("\r   ❯ " + truncateByVisualWidth(line, safeW) + "\x1b[K\n");
}
```

**Why 2-column safety margin:** Even with visual-width truncation, a CJK character
whose right half lands exactly on the terminal's last column can trigger auto-wrap.
Subtracting 2 columns prevents this edge case.

**Two-pass rendering is still required** to clear previous-frame content before
writing new content — do NOT skip the clear pass.

### 6. Multi-line Aware Footer

**CRITICAL: Use fixed MAX_VISIBLE height, not dynamic `visibleInputLines()`.**

Draw footer with **fixed** blank rows (always MAX_VISIBLE, e.g. 5), not
dynamically based on current input length. Otherwise when the user types text
that wraps into more lines, the input rendering overwrites the separator and
help text that were positioned assuming fewer input lines.

```js
function drawFooter() {
  const W = termWidth();
  process.stdout.write(dim("─".repeat(W)) + "\n");         // top separator
  for (let i = 0; i < MAX_VISIBLE; i++) process.stdout.write("\n"); // ALWAYS 5 blank rows
  process.stdout.write(dim("─".repeat(W)) + "\n");         // bottom separator
  process.stdout.write("   " + dim("help text") + "\n");   // help line
  // Back to first input row
  process.stdout.write(`\x1b[${2 + MAX_VISIBLE}A\x1b[0G`);
  process.stdout.write("   ❯ ");
}

function clearFooter() {
  process.stdout.write(`\x1b[${MAX_VISIBLE + 1}E\x1b[J\x1b[0G`);
}
```

And `visibleInputLines()` must always return `MAX_VISIBLE`:

```js
const MAX_VISIBLE = 5;

function visibleInputLines() {
  return MAX_VISIBLE; // NEVER use Math.min(MAX_VISIBLE, totalInputLines())
}
```

**Why this matters:** If `visibleInputLines()` returns 1 when input is empty and
5 when input wraps, `drawFooter()` allocates only 1 blank row initially. When
the user types text that wraps to 5 rows, `redrawPrompt()` renders 5 rows over
the footer's separator and help text. Fixed allocation prevents this entirely.

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
- In raw mode, `\r` behavior varies across terminals (e.g., Termux on Android);
  `\x1b[0G` (cursor horizontal absolute) is more reliable

## When to Apply

Any Node.js CLI tool with:
- `process.stdin.setRawMode(true)` for interactive input
- Character-by-character input processing in a `data` event handler
- A fixed-position footer or status bar below the input area
- Users who paste multi-line text (code snippets, URLs, logs)

## Single-Pass Rendering with `\x1b[0G\x1b[K`

**Problem:** Two-pass rendering (clear pass then write pass using `\r\x1b[K\n`
+ `\r` + text + `\x1b[K\n`) can cause frame overlap on terminals where `\n`
in raw mode does not reset the column to 0. The cursor drifts rightward
across successive lines, creating ghost text from previous frames.

**Solution:** Single-pass — each line self-clears before writing:

```js
// ── DO THIS (single-pass) ──
for (let i = 0; i < vis; i++) {
  if (i < visible.length) {
    const pre = (i === 0 && scrollOffset === 0) ? PROMPT : CONT;
    process.stdout.write("\x1b[0G\x1b[K" + pre + truncateByVisualWidth(visible[i], safeW) + "\n");
  } else {
    process.stdout.write("\x1b[0G\x1b[K\n");
  }
}
process.stdout.write(`\x1b[${vis}A`); // move back to top

// ── DO NOT use two-pass on unreliable terminals ──
// for (let i = 0; i < vis; i++) process.stdout.write("\r\x1b[K\n");   // clear pass
// process.stdout.write(`\x1b[${vis}A`);
// for (let i = 0; i < vis; i++) { ... }                                 // write pass
```

**Why `\x1b[0G` not `\r`:** `\x1b[0G` (cursor horizontal absolute, column 0) is
explicit and works identically on all terminals. `\r` (carriage return, code 13)
can be intercepted or behave differently in raw mode (some terminals treat it
as CRLF, others as just CR). Always prefer `\x1b[0G` in raw-mode rendering.

**safeW calculation:** Use `termWidth - promptWidth - 1` (not `- 2`):
- The `-1` margin is relative to `tw` (the wrapping width), not the full terminal width
- `tw = termWidth - promptWidth` determines where text wraps
- `safeW = tw - 1` ensures rendered text never reaches the terminal's last column
- A CJK character whose right half lands on the last column triggers auto-wrap;
  subtracting just 1 column (not 2) is sufficient because `truncateByVisualWidth`
  already prevents half-characters at the boundary

## Prompt Prefix on First Line Only

For multi-line input, show the prompt symbol (`❯ `, `> `) only on the first
visible line. Continuation lines use spaces of the same visual width:

```js
const PROMPT = "   ❯ ";    // visual width = PW (e.g., 6 for ❯ which is double-width)
const CONT   = "      ";   // same visual width as PROMPT, all spaces

// In rendering loop:
const pre = (i === 0 && scrollOffset === 0) ? PROMPT : CONT;
//                ^^^^^^    ^^^^^^^^^^^^^^^^
//                first     AND   not scrolled
//                visible         past start
//                line
```

**Conditions:** Both `i === 0` (first visible line) AND `scrollOffset === 0`
(not scrolled past the beginning) must be true. If the user has scrolled up
(`scrollOffset > 0`), even the first visible line is a continuation.

```js
function totalInputLines() {
  let w = PW;  // must match visual width of PROMPT
  for (const ch of currentInput) w += charWidth(ch);
  return Math.max(1, Math.ceil(w / termWidth()));
}
```

## Cursor Positioning After Redraw

After rendering the input area, compute the cursor's visual position from its
character index and move the terminal cursor there.

### The moveToTop() Problem (Critical)

**Bug:** `positionCursor()` moves the cursor to the edit position (e.g., line 2
of the input area). The NEXT call to `redrawPrompt()` starts rendering from that
position, NOT from the top of the input area. Lines 0-1 from the previous frame
are NOT cleared, causing ghost text and old `❯` prompts to persist.

**Fix:** Track the cursor's relative line offset and move back to the top before
every render:

```js
let cursorRelLine = 0;

/** Always call at the start of redrawPrompt(), before any rendering */
function moveToTop() {
  if (cursorRelLine > 0) process.stdout.write(`\x1b[${cursorRelLine}A`);
  process.stdout.write("\x1b[0G");
}

function positionCursor(wrapLines) {
  // ... find cursorLine, col, relLine ...

  process.stdout.write(`\x1b[${relLine}B`);
  process.stdout.write(`\x1b[${col}G`);
  cursorRelLine = relLine;   // ← save for next moveToTop()
}

function redrawPrompt() {
  moveToTop();               // ← MUST be the first thing

  // ... compute wrapLines, render vis lines ...
  // ... positionCursor(wrapLines) ...
}

// Reset in drawFooter() and burst view branches:
function drawFooter() {
  // ... draw ...
  cursorRelLine = 0;
}
```

**Also reset `cursorRelLine = 0`** in `drawFooter()`, all burst view branches
of `redrawPrompt()`, and after Ctrl+C abort handlers. Any path that repositions
the cursor to the top of the input area must reset the tracking variable.

### Full positionCursor Implementation

```js
function positionCursor(wrapLines) {
  // 1. Find which wrap line contains the cursor
  let cursorLine = 0, charCount = 0;
  for (let i = 0; i < wrapLines.length; i++) {
    const len = Array.from(wrapLines[i]).length;
    if (charCount + len >= cursor) { cursorLine = i; break; }
    charCount += len;
    if (i === wrapLines.length - 1) cursorLine = i;
  }

  // 2. Column offset within that line (visual cols)
  const lineBefore = wrapLines[cursorLine].slice(0, cursor - charCount);
  let col = (cursorLine === 0 && scrollOffset === 0) ? PW : CONT.length;
  for (const ch of lineBefore) col += charWidth(ch);

  // 3. Relative to visible area
  const relLine = cursorLine - scrollOffset;
  if (relLine < 0 || relLine >= vis) return;

  // 4. Move cursor
  process.stdout.write(`\x1b[${relLine}B`);  // down relLine rows
  process.stdout.write(`\x1b[${col}G`);      // absolute column (1-based)
  cursorRelLine = relLine;                    // save for next moveToTop()
}
```

**Call `positionCursor` at the end of `redrawPrompt`** (not during burst view).

## Burst Chunk Persistence (Don't Clear on Timeout)

**Problem:** Clearing `pasteChunks` when the burst timeout fires (300ms
after last paste event) causes the `[…]` collapsed view to immediately
expand when the user types or deletes a single character.

**Fix:** Separate `burstMode` (transient — "are we currently receiving a
paste burst?") from paste chunk storage (durable — "was any text pasted
in this input session?"). Only clear pasteChunks on Enter or Ctrl+C.

```js
// Burst detection
if (str.length > 1) {
  burstMode = true;
  pasteChunks.push({ start: cursor, end: cursor + str.length });
} else if (now - lastDataTime > 300) {
  burstMode = false;
  // DO NOT clear pasteChunks here — the collapsed view should persist
}

// Display condition: based on pasteChunks, not burstMode
const inBurstView = pasteChunks.length > 0 && currentInput.length > 300;

// Backspace during burst view: delete last chunk atomically
if (pasteChunks.length > 0 && currentInput.length > 300) {
  const lastChunk = pasteChunks.pop();
  // ... splice out lastChunk from input ...
  if (pasteChunks.length === 0) resetPasteMode(); // only clear when all gone
  redrawPrompt();
  continue;
}
```
