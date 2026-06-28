---
name: computer-use
description: Drive the computer like a person when there is no programmatic path — see the screen, then click/type/scroll. For "open this app and do X", "click the button", "fill this form in the GUI", "automate this desktop/web flow", controlling software that has no API/CLI. (điều khiển máy tính, thao tác giao diện, tự bấm/điền, automate desktop). PREFER code/CLI first; then the accessibility tree (web=DOM, desktop=Windows UIA) which a plain text model drives with no vision; raw-pixel vision only for custom-drawn UIs.
---

# Skill: Computer use (code-first, GUI-fallback)

Distilled from the 2026 SOTA (UI-TARS, OpenCUA, Aguvis, **CoAct-1**, OSWorld). The hard truth first, then
the method.

## The hard truth (read this)
- **Most "GUI" control needs NO vision.** The screen is already structured data — the OS accessibility
  tree (web=DOM, desktop=Windows UIA) exposes every control's name + role + exact coordinates as TEXT, so a
  plain text model (gpt-oss) grounds reliably and pixel-perfect. **Raw-pixel vision is the LAST resort**
  (custom-drawn UIs with no tree) — only THAT wants a GUI-trained model. See "Grounding without a
  GUI-trained model" below; this is the spine of the skill.
- **Even frontier *pixel-vision* agents top out ~72% on OSWorld**; open models ~42-45%. That ceiling is the
  pixel path — the accessibility-tree path is deterministic, not a guess. Either way, **verify after every
  step**.
- **It can break things.** Mouse/keyboard/`invoke` on the real machine is destructive. Guardrails below are
  not optional.

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

## Quick start — DESKTOP (Windows: WORKS with plain gpt-oss, NO vision — via UIA)
Native apps have no DOM, but Windows UI Automation (UIA) IS the desktop's accessibility tree — the desktop
DOM. **This is the primary path; use it first.** `uia.ps1` lets a text model perceive + act + verify with
no vision and (for pattern actions) no cursor movement:

```
# perceive: list actionable elements (name + role + verb + exact coords)
NEKO_UIA_WINDOW="<window title>" pwsh uia.ps1 list
#   [Edit] 'Input' (setvalue) -> 960,432
#   [Button] 'Greet' (invoke) -> 794,494
# act by NAME (programmatic UIA pattern -> no cursor, no focus steal, works occluded):
pwsh uia.ps1 setvalue "Input" "Neko"      # ValuePattern (type without keyboard)
pwsh uia.ps1 invoke   "Greet"             # InvokePattern (click without moving the mouse); falls back to a
                                          #   real coord-click only if no pattern is exposed
pwsh uia.ps1 toggle   "Show advanced"     # TogglePattern (checkbox/switch)
# verify (no vision): read a value/state back
pwsh uia.ps1 get "Input"                  # -> value 'Input' = 'Neko'
# read a whole page/doc as TEXT (Text/Document/Hyperlink names) -- summarize a web page, no vision:
pwsh uia.ps1 read                          # dumps readable content (list = actionable; read = content)
# Unicode targets (Vietnamese/CJK/emoji): the cp1252 console mangles non-ASCII args -> pass @<utf8-file>:
pwsh uia.ps1 invoke "@C:\tmp\name.txt"     # reads the exact element name from a UTF-8 file (round-trips clean)
```
WEB note: a browser exposes the page to UIA only when accessibility is on -- launch Chrome with
`--force-renderer-accessibility` (reuses the logged-in profile, no CDP) so `uia.ps1 read` sees the feed/DOM
as text. **VERIFIED:** gpt-oss autonomously read + summarized a live Facebook feed via `read`, scrolled with
`inject.ps1`, and opened + composed a post by invoking the composer BY NAME (`@file`) -- coordinate taps on a
feed are fragile (the layout reflows between `list` and `tap`); invoke-by-name is layout-independent. For a
heavy page, lower `reasoning_effort` so the model emits the answer instead of over-reasoning into the token cap.
**VERIFIED end-to-end** on a real .NET window: `list` -> `setvalue Input=Neko` -> `invoke Greet` ->
screenshot showed `Hello, Neko!`, and `get` read the value back — all with the default gpt-oss, zero vision,
zero cursor movement. The loop is **perceive (`list`) → act (`invoke`/`setvalue`/`toggle`) → verify
(`get`/`list`)**, all text.

Performance + reliability are SOTA-grade: a CacheRequest bulk-fetches every property+pattern in ONE
cross-process call (a naive `FindAll` makes one COM round-trip per node and TIMES OUT on rich WinUI/WPF
trees), and actions use server-side `FindFirst(Name=…)`. Target a window by `$env:NEKO_UIA_WINDOW` (title
substring; UIA acts without focus) or default to the foreground window.

**App-type matrix (honest — UIA quality varies by app framework):**
| App kind | UIA quality | Note |
|---|---|---|
| WPF, WinForms (compiled), most LOB apps | first-class | `invoke`/`setvalue`/`toggle` work, no cursor |
| Win32 classic (Office, Explorer dialogs) | good | stays alive when backgrounded |
| UWP (Calculator, Settings) | good but **suspends** | tree collapses when fully hidden — keep it VISIBLE |
| WinUI (Win11 Notepad) | good but frame-hosted | content is a child of an outer frame; target the content |
| Pre-UIA legacy (charmap) / custom-drawn (games, canvas) | poor/none | no element tree → fall to OCR / Set-of-Marks / pixel-vision |

So: prefer UIA; drop to the vision sub-call below ONLY for the last row (no accessibility tree).

### Vision fallback (custom-drawn UIs with no tree)
When there's genuinely no accessibility tree, it's the screenshot -> ground -> click loop. No single
available model does vision + GUI-grounding + tool-calling together, so SEPARATE them: the text driver
(gpt-oss) orchestrates and calls a vision model as a sub-step to "see". Bundled scripts in
`skills/computer-use/scripts/`:
- **Screenshot** — `screenshot.ps1 <out.gif> [width]` captures + downscales to a small **GIF** and prints
  `scale` (driver maps `real = view / scale`). Why GIF, not JPEG/PNG: NVIDIA's gateway counts the image's
  base64 toward the prompt-token budget, so it MUST stay small (base64 < ~180 KB or the request 400s with a
  negative `max_tokens`). GIF's indexed colour is tiny for UI and -- unlike the JPEG encoder -- does NOT trip
  antivirus screen-capture heuristics. If a capture script is still blocked, split it: a simple `CopyFromScreen`
  -> `Save(png)` (scans clean) then a FILE resize -> `Save(...,Gif)` (no screen capture, scans clean).
- **See / ground** — `bun see.ts <image> "<question>"` (one-shot) sends the image to a vision model
  ($NEKO_VISION_MODEL, default `microsoft/phi-3-vision-128k-instruct`) and prints its answer/coordinates.
  For a precise CLICK target, `bun ground.ts "<target>" [full.png]` runs the **2-pass crop-and-zoom**
  (captures, grounds rough, crops a high-res region, re-grounds, maps to real px) and prints `x,y`.
  **Verified:** gpt-oss orchestrated `see.ts` to ground a corner button to ~10-20 px.
- **Control** — `mouse.ps1 <pos|move|click|dblclick> [x] [y]`. `pos`/`move` harmless; `click` is gated (approval).
- **Loop**: `screenshot.ps1` -> `see.ts` (ground in view px) -> scale to real px -> `mouse.ps1 click` -> re-shot -> reflect.
- **Multi-monitor**: coordinates are the virtual desktop; map per display (Clicky's `screenN`).

**Honest ceiling — the model, not the machinery.** `ground.ts` implements the SOTA crop-and-zoom
(ScreenSpot-Pro / iterative focus refinement) correctly, but real-world precision is capped by the available
VLM's grounding: `phi-3-vision` is decent on distinctive / corner targets (~10-20 px) but UNRELIABLE on dense
or centred ones (it placed a centred search box at x=92 when truth was ~890) -- and when pass-1 is far off,
the crop is around the wrong place, so pass-2 can't recover. It's also SLOW (2 vision calls + NVIDIA latency).
But raw-pixel grounding is the LAST resort -- see "Grounding without a GUI-trained model" below: the
accessibility tree (`uia.ps1`) gives exact OS coordinates as TEXT, so a plain text model grounds reliably +
pixel-perfect with no vision at all. `ground.ts` (pixel-vision) is only for custom-drawn UIs with no tree,
and only THAT benefits from a GUI-trained model (UI-TARS/OpenCUA/Claude CU; none on NVIDIA). For pixel-vision:
treat coords as approximate, verify after the click, don't fire irreversible clicks on a low-confidence
ground; keep each image small (GIF) under NVIDIA's token budget (`<img>` conversion is automatic).
(For keyboard, `WScript.Shell.SendKeys` works but is global/focus-sensitive -- see `tui-self-test`.)

## Grounding without a GUI-trained model (the key technique)
"Everything is data" -- the screen ALREADY is structured data; don't make the model estimate pixels. Ground
in order of reliability (only the last needs a GUI-trained model):
1. **Code / CLI / API** (CoAct-1) -- no grounding at all, most reliable (Neko's code-first principle).
2. **Accessibility tree** -- `uia.ps1` reads AND acts on a window via Windows UI Automation: NAME + ROLE +
   EXACT bounding rect FROM THE OS, plus the assistive-tech action patterns. A plain text model (gpt-oss)
   `list`s elements, then acts BY NAME: `invoke` (InvokePattern -- click with NO cursor movement / no focus
   steal / works occluded), `setvalue` (ValuePattern -- type with no keyboard), `toggle`, and `get` to verify
   -- pixel/element-perfect, <100 ms, private, NO vision, NO GUI-training. Falls back to a real coord-click
   only if an element exposes no pattern. This is exactly why WEB works with gpt-oss (the DOM); UIA is the
   desktop DOM. **VERIFIED end-to-end:** list -> setvalue -> invoke -> screenshot/get confirmed the action,
   default gpt-oss, no vision. See the DESKTOP quick-start for the loop + the app-type matrix (works on
   WPF/WinForms/Win32/UWP/WinUI; only pre-UIA-legacy & custom-drawn UIs need the lower rungs).
3. **OCR** -- for a text target with no UIA, OCR the screen (Tesseract / NVIDIA NeMo-OCR NIM) -> exact box.
4. **Set-of-Marks** (OmniParser-style) -- custom/canvas UIs: detect elements, overlay NUMBERED marks, ask
   "which number?" -> click its known box. Turns "estimate coords" into "pick #N" (easy text reasoning).
5. **Raw-pixel VLM** (`ground.ts`) -- LAST resort; the only path that wants a GUI-trained model.
Microsoft UFO2, Windows-Use, DirectShell, OmniParser all LEAD with the accessibility tree + scripts and use
pixel-vision only to fill gaps. So Neko controls standard desktop apps RELIABLY today with plain gpt-oss +
`uia.ps1` -- no GUI-trained model required. For the rare pointer action (canvas/drag/non-UIA target), act with
`inject.ps1` (touch -- does NOT move the user's mouse) or `mouse.ps1` (SendInput -- legacy); see Agent presence
(A2) for the config-first backend switch.

## Agent presence + control isolation (clicky-style)
Three composable layers: **(A) SEE it** (overlay), **(A2) ACT without hijacking your mouse** (touch
injection — its own pointer channel), **(B) ISOLATE it** (separate desktop/VM — for hidden/background or
any-app incl. games). Key fact: the OS has ONE *mouse* cursor, but SEPARATE *pen/touch* input channels —
that is how the agent gets its own pointer on the same screen without taking yours.

**(A) Overlay — works now, same desktop.** `overlay.ps1 [stopFile] [maxSeconds] [targetFile] [shotFile] [activeWinFile]`
(v4) paints a **flicker-free** (custom double-buffered Form: OptimizedDoubleBuffer + no OnPaintBackground, clear
in OnPaint), transparent, click-through, always-on-top layer, pixel-faithful to Clicky's `OverlayWindow.swift`:
- a coloured **rounded** screen border (or a frame around the specific window Neko uses) + a rounded banner
  with a status dot; **UI strings live in `overlay.i18n.txt` (UTF-8, Vietnamese with diacritics)** -- read at
  runtime because PS 5.1 parses `.ps1` as cp1252, so diacritics must NOT be literals in the script;
- a **blue (#3380FF) glowing triangle cursor** (tilted -35 deg, drop-shadow + white outline) that is an
  **INDEPENDENT agent cursor**: the agent writes `targetFile` (`x,y` or `x,y|label`) and the triangle **flies
  there on an EASE-IN-OUT bezier ARC** (control = midpoint lifted by `min(dist*0.22, 90)`, scale-pop mid-flight),
  then a **click-pulse ripple** marks the arrival -- INDEPENDENT of the user's real cursor (verified: triangle
  sat at the target while the system cursor was in a far corner). With NO target it **follows the user's
  cursor** as a buddy beside it (DeepMind Magic-Pointer / Clicky pattern);
- a rounded **label bubble** beside it (from `targetFile`, e.g. what the agent is doing);
- a low-level mouse hook that, on a REAL (non-injected, `LLMHF_INJECTED`) user click, flips to PAUSED and
  writes `stopFile` so the loop yields.
Run it in the background for a session (`overlay.ps1` takes an optional 4th arg `shotFile` to self-capture
from inside its own process for verification). Limit: the overlay only SHOWS presence + yields on touch; for
the agent to ACT without moving your mouse, pair it with (A2) injection; for a fully separate input queue use
(B). **Verified pixel-aligned:** an in-process
self-capture put the marker exactly on the hovered tab. A CROSS-process screenshot of the overlay may show
the marker offset on a scaled display -- that is a capture artifact (the capturing process has a different
DPI-awareness context than the overlay), NOT what the user sees on the real screen.

**Activation (config-first, extensible).** Set `computer_use_overlay: true` in config -> the bash tool runs
desktop helpers with `NEKO_PRESENCE=1`, so `mouse.ps1` / `ground.ts` automatically: (1) auto-launch the
overlay if its heartbeat (`%TEMP%\neko_overlay.run`) is stale, (2) write the target (`%TEMP%\neko_cursor.txt`
= `x,y|label`) as they act -- the independent cursor flies to where Neko is working and shows what it's
doing, (3) honour takeover -- if the user clicked, the helper reads the stop-file and yields ("paused: you
took control"). Off by default = zero overhead. The 3-file protocol (run/target/stop) is the extension
point: ANY tool (or an external agent) that writes the target file drives the same agent cursor -- a uniform
presence layer across web + desktop, beyond Clicky's point-only macOS app.

**(A2) Independent ACTING pointer — touch injection (no mouse hijack).** `inject.ps1 tap|dbltap|stroke
<coords>` acts via Windows TOUCH INJECTION (`InitializeTouchInjection`/`InjectTouchInput`) — a SEPARATE
pointer channel, so the agent clicks/drags/draws on the VISIBLE desktop while the user's MOUSE stays put.
**VERIFIED:** drew lines in Paint with the real cursor parked in a corner (unmoved before == after); no
driver, no admin, unpackaged P/Invoke, Win11-Home OK. Pair with (A) overlay = Clicky's "instructor pointer"
but it actually ACTS: the overlay shows WHERE, injection DOES it, your mouse is free. **Config-first:** set
`computer_use_input: "inject"` -> bash gets `NEKO_INPUT=inject` -> `mouse.ps1`'s `click`/`dblclick`/`stroke`
transparently route to `inject.ps1` (agent code unchanged); `"sendinput"` forces the legacy cursor-moving
path; a NEW backend is a config value + a script, not a rewrite. Honest scope: touch lands on the TOPMOST
window at the point, so the target must be VISIBLE (raise it with `NEKO_DRAW_WINDOW=<title>`); a few legacy
mouse-only apps ignore touch -> fall back to `mouse.ps1` (SendInput) or, for controls, UIA. This is the
visible-desktop "don't hijack my mouse" answer; controlling a HIDDEN/background app is (B). And for CONTROLS,
**UIA invoke already needs no pointer at all** -- prefer it; injection is for canvas/drag/non-UIA targets.

**(B) True input isolation (own cursor + own input queue) — for HIDDEN/background or ANY app incl. games.**
Why isolation, not injection, here: Win32 has ONE input queue and delivers real input only to the ACTIVE
window, and client Windows allows ONE interactive session -- so reaching a hidden window needs either
focus-steal (takes your screen) or a separate desktop/session. The honest landscape on Windows 11 **Home**:
- **Separate Desktop object** (`CreateDesktop` + `SetThreadDesktop`) — native, Home-OK, lightest: run the app
  + a local input helper on a HIDDEN desktop; you keep using the default desktop. Good for plain Win32/GDI
  apps; **fails for GPU/DirectX games and DWM-composited apps** (render black / can't capture).
- **VM (VirtualBox/VMware)** — the robust, GENERAL answer (what Pig API / Claude CU / Power-Automate-unattended
  use): the app/game runs in the guest with its OWN screen+cursor+input; watch via the VM window while the host
  is untouched. Heavy (Windows ISO, GBs); anti-cheat may detect VMs.
- **NOT available on Home:** RDP host & UFO2-style RDP-loopback PiP (Home can't host RDP); a 2nd concurrent
  interactive session (client Windows = single session). These need Pro/Enterprise/Server.
Pick by need: teach/help on the user's real config -> (A)+(A2), same visible desktop. Do isolated/risky/
background work or "play this game while I watch YouTube" -> (B) VM. Don't put teaching in a VM (wrong machine).

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
