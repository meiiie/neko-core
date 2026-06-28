---
name: computer-use
description: Drive the computer like a person when there is no programmatic path — see the screen, then click/type/scroll. For "open this app and do X", "click the button", "fill this form in the GUI", "automate this desktop/web flow", controlling software that has no API/CLI. (điều khiển máy tính, thao tác giao diện, tự bấm/điền, automate desktop). PREFER code/CLI first; fall back to GUI only when necessary. Needs a vision-capable model for the GUI parts.
---

# Skill: Computer use (code-first, GUI-fallback)

Distilled from the 2026 SOTA (UI-TARS, OpenCUA, Aguvis, **CoAct-1**, OSWorld). The hard truth first, then
the method.

## The hard truth (read this)
- **GUI clicking needs a GUI-grounding vision model.** A text-only model (e.g. gpt-oss) cannot see the
  screen or locate where to click. The GUI loop below works only with a **vision-capable model** (set
  `vision: true` + a vision model) — ideally a GUI-trained one (UI-TARS/OpenCUA class).
- **Even frontier agents top out ~72% on OSWorld** (real desktop tasks); open models ~42-45%. Treat GUI
  actions as **fallible** — verify after every step, never assume.
- **It can break things.** Mouse/keyboard on the real machine is destructive. Guardrails below are not
  optional.

## Principle 1 — CODE FIRST (Neko's edge, from CoAct-1)
The strongest computer-use agents mix **coding actions** with GUI clicks: a shell command or script is
**faster and far more reliable** than clicking through a UI. Neko is already a code/shell agent — so:

> Before reaching for the GUI, ask: *is there a programmatic path?* File ops, system config, data
> transforms, downloads, even many "web" tasks (an API / `curl` / a CLI / a script) — do those with
> `bash` and tools. **Only fall to GUI when the software genuinely has no API/CLI/scriptable path.**

This alone solves a large share of "computer use" tasks without ever touching the mouse.

## Principle 2 — the GUI perception-action loop (only when code can't)
When you truly must use the GUI, run the SOTA loop. Each step:

1. **Observe** — take a screenshot (e.g. `bash` a screenshot util), then `read_file` it (vision) to SEE
   the current screen. If the tool provides an **accessibility tree** or **Set-of-Marks** (numbered boxes
   on interactive elements), use it — picking a numbered mark is far more reliable than raw coordinates.
2. **Plan** — state the next concrete sub-goal in one line (planning + reflection are where quality lives).
3. **Ground** — locate the target element. Prefer a Set-of-Marks number / accessibility node. For raw
   coordinates on a dense/high-res screen, **zoom in** (crop the region, re-read) before committing — small
   elements are where grounding fails.
4. **Act** — one action via the input tool: `click(x,y)` / `type(text)` / `scroll` / `key` / `wait`.
5. **Reflect** — take a NEW screenshot and check: did it do what you intended? If not, diagnose from what
   you now SEE and adjust. Never chain blind actions.

Keep steps minimal (each screenshot+reason is slow); stop when the goal is visibly achieved.

## Guardrails (safety — mandatory)
- **Confirm before anything destructive or irreversible** (delete, send, submit, pay, post, overwrite,
  change settings). The human approves.
- **Never enter credentials, card numbers, OTPs, or payment details** — stop and hand control back.
- **Sandbox when you can** — a VM / disposable profile / test account, not the user's primary environment.
- **Uncertain? Stop and ask**, with a screenshot of where you are. A wrong click that executes is the
  most expensive failure mode (OSWorld data: bad grounding → confidently wrong action).

## Wiring it (config-first, no core change)
- **Perception** is already possible: `bash` takes a screenshot → `read_file` reads it with vision.
- **Action (mouse/keyboard)** needs an input tool — connect a **computer-use MCP** (desktop screenshot +
  click/type) via `mcp_servers`, the same way the browser MCP is wired. Tools then appear as
  `mcp__<server>__*`.
- **For WEB specifically** (the most common case), prefer a browser tool: `@playwright/mcp`
  (`browser_snapshot` is an accessibility tree = DOM-grounded, the reliable path), or a dedicated
  web-agent like **browser-use** behind an MCP bridge. Web grounding via the DOM beats raw-pixel clicking.

## Quick start — WEB (validated, works today with a text model)
The web case needs NO vision: `@playwright/mcp`'s snapshot is a DOM/accessibility tree, so a text model
grounds via the DOM (the browser-use insight: DOM beats pixels). Add it to config:
```json
{ "mcp_servers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--headless", "--isolated"] } } }
```
(One-time: `npx playwright install chromium`.) Neko then drives the page via `browser_navigate` /
`browser_type` / `browser_click` / `browser_snapshot` / `browser_evaluate`. **Verified end-to-end with the
default gpt-oss-120b:** navigate -> type a query into the search box + submit -> open the result -> read it,
AND self-correct when a tool call errored (retried with a better selector). Drop `--headless` to watch it;
add stealth (`--device "Desktop Chrome"`, or CloakBrowser via `--cdp-endpoint`) for anti-bot sites — see
the `procurement` skill.

## Quick start — DESKTOP (Windows: WORKS via a vision sub-call)
Native apps have no DOM, so it's the screenshot -> ground -> click loop. No single available model does
vision + GUI-grounding + tool-calling together, so SEPARATE them: the text driver (gpt-oss, reliable
tool-calls) orchestrates and calls a vision model as a sub-step to "see". Three bundled scripts in
`skills/computer-use/scripts/`:
- **Screenshot** — `screenshot.ps1 <out.jpg> [width]` captures + downscales (under NVIDIA's ~180 KB inline
  image cap) and prints `scale` so the driver maps `real = vision / scale`. NOTE: some antivirus flags
  screen-capture scripts as malicious (a false positive) -- if blocked, capture with a trusted tool / allow it.
- **See / ground** — `bun see.ts <image> "<question>"` sends the image to a vision model ($NEKO_VISION_MODEL,
  default `microsoft/phi-3-vision-128k-instruct`) and prints its answer/coordinates. The driver calls this via
  `bash` to look. **Verified end-to-end:** gpt-oss orchestrated `see.ts` to ground a window's close button to
  ~20-40 px of truth, then said it would `mouse.ps1 click` there.
- **Control** — `mouse.ps1 <pos|move|click|dblclick> [x] [y]`. `pos`/`move` harmless; `click` is gated (approval).
- **Loop**: `screenshot.ps1` -> `see.ts` (ground in view px) -> scale to real px -> `mouse.ps1 click` -> re-shot -> reflect.
- **Multi-monitor**: coordinates are the virtual desktop; map per display (Clicky's `screenN`).

General-VLM grounding is APPROXIMATE (tens of px) -- fine for big targets; zoom + re-ask for small ones. The
key enabler: NVIDIA NIM vision needs the `<img>`-tag image format (handled automatically, see `image_format`).
(For keyboard, `WScript.Shell.SendKeys` works but is global/focus-sensitive -- see `tui-self-test`.)

## Huge pages — read in PARTS, like a human (SOTA: agentic chunking + sub-agent)
A heavy page's full snapshot can be tens of thousands of tokens; dumping it whole is slow, costly, and
risks overflowing the window. Read strategically instead:
- **Extract targeted data** with `browser_evaluate` (the one selector / the specific value), not the whole
  accessibility tree.
- **Read in chunks** when you must see raw content — page through it a section at a time (the same idea as
  `read_file`'s offset/limit), not all at once.
- **Delegate the bulk to a sub-agent** (`task`): it reads the heavy page and returns just the answer, so the
  main context stays clean (the SOTA sub-agent-summarization pattern).

Neko also self-protects so a giant page can't crash a turn: a single tool result is capped, and a long
turn compresses its OLDEST observations in place before the window overflows. That's a safety net — reading
in parts is still faster and cheaper.

## Honest scope (tested, 2026-06)
**Desktop autonomy WORKS on NVIDIA** via the driver + vision-sub-call split above -- verified: gpt-oss drove
`see.ts`, which had `microsoft/phi-3-vision-128k-instruct` ground a close button to ~20-40 px, then chose to
`mouse.ps1` it. Earlier I wrongly concluded "no NVIDIA model is viable" -- that was a FORMAT bug, not a model
limit: NVIDIA NIM vision needs the `<img>`-tag image format (the OpenAI `image_url` part is silently ignored),
now handled by `image_format` auto. `phi-3-vision` and `nvidia/neva-22b` see + ground accurately; `maverick`
sees but hallucinates; `gemma-3`/`vila`/`llama-3.2-vision` also work once the format is right.

Real caveats that remain (state them, don't hide them):
- **Grounding is approximate** (general VLM, not GUI-trained): ~tens of px. Fine for big targets; zoom/re-ask
  for small ones. A GUI-trained model (UI-TARS/OpenCUA/Claude CU class) would be pixel-tight.
- **Vision models don't tool-call** -- that's why the driver (gpt-oss) orchestrates and `see.ts` is a sub-call.
- **Screenshot capture** may be blocked by antivirus on some machines (false positive on screen-capture
  scripts); use a trusted capture path. Downscale to stay under NVIDIA's ~180 KB inline-image cap.
- **Web** computer-use (DOM via `@playwright/mcp`, no vision) is still the most reliable autonomous path.
