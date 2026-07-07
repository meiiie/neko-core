# TASK-01: Input rendering windowing (fix long-input lag)

## Context (why — read this first)
`src/ui/text-input.tsx` line 108-126 renders the ENTIRE input buffer on every keystroke:
```jsx
const cps = [...value];
const shown = mask ? cps.map(() => "•") : cps;
...
return (
  <Text>
    {shown.slice(0, i).join("")}
    {caret}
    {shown.slice(i).join("")}
  </Text>
);
```
Measured cost (perf-lag.ts): typing 20 keys into a 50-char buffer = 34fps; into a 2050-char buffer
= 12fps. Render is O(n) in buffer size — Ink layouts + wraps the whole string each keystroke. This is
the #1 reported "input text dài thì lag".

## Goal
Make rendering O(viewport width) instead of O(buffer length): only render the chars NEAR the cursor
that fit in the visible width (a horizontal window like a real editor/text-field). Typing/pasting/holding
a 2000-char line must stay at the same fps as a 50-char line.

## HOW (the design — follow it)
The `<Text>` that TextInput returns is rendered inside a box of a known width. Compute a window
`[winStart, winEnd)` of codepoints around `cur.current` that fits in ~`width` columns (with a small
margin so the caret never sits flush at the edge — ~4 codepoints of lead/lag). Render only:
```jsx
{shown.slice(winStart, i).join("")}{caret}{shown.slice(i, winEnd).join("")}
```
Key constraints:
- Width: pass a `width` prop from chat.tsx (the input box width — there's already a `contentCols` /
  measured width in chat.tsx around line 1627). Add `width?: number` to props; default to a large
  number (e.g. 9999) when not provided so behavior is unchanged where untested.
- The window must ALWAYS contain the caret position `i`, and when `i` is near the edges, shift the
  window so the caret stays visible with a small margin (editor-style horizontal scroll).
- `mask` mode: window applies to the `•` array too (same length, so identical logic).
- When buffer fits entirely in width, render the whole thing (== today's behavior, no visual change
  for short inputs — this is critical: short-input appearance/ caret position must be byte-identical).

## INVARIANTS — these MUST still pass (do NOT break)
1. `bun test test/text-input.test.tsx` — ALL tests green. Especially:
   - caret `▏` flush before char at cursor: empty=`▏`, `ab`=`ab▏`, cursor-mid=`a▏b`, never `ab |`.
   - IME/Vietnamese NFC (last test), paste handling, Ctrl+A/E/W, backspace, escape-residue guard.
   - caret blink (solid while typing, blinks off when idle), mouse doesn't keep it solid.
2. `bun run typecheck:stable` PASS.
3. `bun test test/chat-ui.test.tsx` and `bun test test/ux.test.tsx` PASS (they render ChatApp with the input).
4. For SHORT inputs (< width): the rendered output must be IDENTICAL to before (same string, same caret
   position). Verify by eyeballing the test frames still contain `ab▏` etc.

## Files to change
- `src/ui/text-input.tsx` — add windowing to the render block + accept `width` prop.
- `src/ui/chat.tsx` — pass `width={contentCols}` (or the measured input-box width) to `<TextInput>`.

## Do NOT
- Do not touch `useInput`, the ref/tick mechanism, or IME/paste/NFC logic — that's a separate fence.
- Do not change the caret glyph `▏`, blink logic, or the space-gapped guard.
- Do not add new dependencies.
- Do not touch any other file.

## How to verify yourself before reporting done
```
bun test test/text-input.test.tsx
bun test test/chat-ui.test.tsx
bun run typecheck:stable
```
Then report: which lines changed, the test results, and whether short-input frames are visually identical.
