---
name: tui-self-test
description: Verify Neko's terminal UI (TUI) renders correctly at the pixel level — diffs, colors, glyphs, spinner, layout — instead of guessing. Two complementary techniques: a SAFE deterministic render harness (ink-testing-library) for layout/structure, and a LIVE screenshot loop (launch Neko in a real console, screenshot, read with vision) for actual fonts/colors. Use when changing the UI (transcript/markdown/approval/diff rendering) or auditing how Neko looks on Windows. (test giao diện, kiểm tra render, chụp màn hình, dogfood UI).
---

# Skill: TUI self-test (verify the render, don't guess)

You cannot eyeball a TUI change from source. Verify it. Two techniques, cheapest first.

## A. SAFE deterministic render (default — use this first)
`ink-testing-library` is a devDependency. Render any component to text and read the frame. No windows,
no input, deterministic, can't leak anywhere.

```tsx
// _uitest.tsx at repo root (delete after). Run: bun _uitest.tsx
import React from "react";
import { render } from "ink-testing-library";
import { TranscriptLine } from "./src/ui/transcript.tsx";
import { Markdown } from "./src/ui/markdown.tsx";
const cfg: any = { model: "x", provider: "y", profile: "d", effort: "high" };
const { lastFrame } = render(<TranscriptLine cfg={cfg} line={{ id: 1, kind: "tool_result", text: "Edited f  (+1 -1)\n   1   a\n   2 - b\n   2 + B\n   3   c" } as any} />);
console.log(lastFrame());
```
- Good for: layout, spacing, glyphs-as-codepoints, collapse/truncation logic, "does it crash".
- **Caveat — colors:** non-TTY disables ANSI, so `lastFrame()` has NO colors. To see them, prefix
  `FORCE_COLOR=1`, or replace `\x1b` with `\\e` to print the codes (`[32m` green, `[31m` red), or verify
  colors LIVE (technique B). Build a real diff via `ToolRegistry.execute("edit", ...)` so you test the
  actual `editDiff` output, not a hand-typed string.

## B. LIVE screenshot loop (for real fonts + colors — the dogfood)
Drive the actual Neko TUI in a real console and read a screenshot with vision. This is the only way to
see what the user's terminal FONT and colors actually produce (e.g. a glyph that the font lacks).

1. **Launch fresh** (a fresh window is reliably foreground):
   `Start-Process -FilePath cmd -ArgumentList '/k','bun bin/neko.ts' -WorkingDirectory '<repo>'`
2. **Screenshot the screen** (PowerShell, validated):
   ```powershell
   Add-Type -AssemblyName System.Windows.Forms,System.Drawing
   $w=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; $h=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
   $b=New-Object System.Drawing.Bitmap $w,$h; $g=[System.Drawing.Graphics]::FromImage($b)
   $g.CopyFromScreen(0,0,0,0,$b.Size); $b.Save('<out>.png'); $g.Dispose(); $b.Dispose()
   ```
3. **Read** the PNG with vision (the Read tool) to SEE the render. Compare against the target.
4. **Drive input** (only if needed) with `WScript.Shell.SendKeys` IMMEDIATELY after a fresh launch:
   `+{TAB}` = shift+tab (cycle permission mode, e.g. to accept-edits), then the prompt text, then `{ENTER}`.
   Wait for the model turn (~10-30s), screenshot again.
5. **Restart to pick up code changes**: `Get-Process bun | Stop-Process -Force`, then relaunch.

### Safety — learned the hard way (READ THIS)
- **SendKeys is GLOBAL** — it goes to whatever window is focused. With multiple terminals open (e.g. your
  own agent session AND Neko), it can **leak destructive keystrokes into the wrong window**.
- **NEVER `AppActivate` to focus an already-open window** — it grabbed the wrong terminal and the keys
  landed in the operator's own session. Instead **relaunch fresh** (new window = foreground), or prefer
  technique A which can't leak.
- Keep prompts **ASCII** for SendKeys (it doesn't type Vietnamese diacritics reliably) and avoid SendKeys
  meta chars unescaped (`+ ^ % ~ ( ) { } [ ]`).
- Clean up: delete throwaway files the test created; the spawned console windows can be closed by the user.

### Glyph/font probe (does the font have this codepoint?)
To check one glyph without Neko's full flow, print it in a throwaway window you control, then screenshot:
`Start-Process cmd '/k','bun -e "console.log(\"`u{2717}`u{2514}`u{25CF}\")"'`. On the test machine: `└`
(U+2514), `●`, `│`, `▽`, `…`, `·`, `✓` all render; `✗` (U+2717) shows as a plain "X" (fine); the old
`⎿` (U+23BF) read as an "L" — which is why the connector is now `└`.

## Verify loop after any UI change
`bun run typecheck` → `bun test test/chat-ui.test.tsx test/ux.test.tsx test/ui.test.tsx test/markdown.test.tsx`
→ technique A for structure → technique B for fonts/colors on the real change.
