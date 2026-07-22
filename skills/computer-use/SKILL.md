---
name: computer-use
description: Drive the computer like a person when there is no programmatic path — see the screen, then click/type/scroll. For "open this app and do X", "click the button", "fill this form in the GUI", "automate this desktop/web flow", controlling software that has no API/CLI. (điều khiển máy tính, thao tác giao diện, tự bấm/điền, automate desktop). PREFER code/CLI first; then the accessibility tree (web=DOM, desktop=Windows UIA) which a plain text model drives with no vision; raw-pixel vision only for custom-drawn UIs.
---

# Skill: Computer use (code-first, GUI-fallback)

Distilled from the 2026 SOTA (UI-TARS-2, OpenCUA, Agent S2, **CoAct-1**, OSWorld 2.0, OSGuard). The hard
truth first, then the method.

## The hard truth (read this)
- **Most "GUI" control needs NO vision.** The screen is already structured data — the OS accessibility
  tree (web=DOM, desktop=Windows UIA) exposes every control's name + role + exact coordinates as TEXT, so a
  plain text model (gpt-oss) grounds reliably and pixel-perfect. **Raw-pixel vision is the LAST resort**
  (custom-drawn UIs with no tree) — only THAT wants a GUI-trained model. See "Grounding without a
  GUI-trained model" below; this is the spine of the skill.
- **Even frontier *pixel-vision* agents top out ~75% on OSWorld-Verified**; open models ~42-45%. On the
  108 long-horizon tasks in OSWorld 2.0, the best tested agent completes only **20.6%**. The dominant failures
  are lost constraints/state and skipped verification, not a missing click primitive. That ceiling is the
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
- **Perception** is already possible: `bash` takes a screenshot → `read_file` reads it with vision. (That
  read needs a VISION model — gpt-oss is text-only. On the NVIDIA key, `NEKO_MODEL=nvidia/llama-3.1-nemotron-nano-vl-8b-v1`
  is a strong reader, verified; avoid llama-3.2-vision. But prefer UIA `read`/`list` — no vision needed.)
- **Action (Windows)** is built in: the gated `computer` tool exposes UIA, touch, Unicode typing, shortcuts,
  scrolling, waits, launching, and screenshots. A **computer-use MCP** remains the extension path for
  macOS/Linux, remote desktops, or a provider-specific sandbox; its tools appear as `mcp__<server>__*`.
- **For WEB specifically** (the most common case), prefer a browser tool: `@playwright/mcp`
  (`browser_snapshot` is an accessibility tree = DOM-grounded, the reliable path), or a dedicated
  web-agent like **browser-use** behind an MCP bridge. Web grounding via the DOM beats raw-pixel clicking.

## Quick start — WEB (validated, works today with a text model)
The web case needs NO vision: `@playwright/mcp`'s snapshot is a DOM/accessibility tree, so a text model
grounds via the DOM (the browser-use insight: DOM beats pixels). Run `neko setup browser`: its dedicated
Chrome profile persists cookies and local storage, so the user signs in once. `neko setup browser attach`
reuses an existing signed-in Chrome tab through Microsoft's Playwright Extension. Reserve
`neko setup browser isolated` for tests/untrusted pages because closing it deliberately erases all state.
(One-time: `npx playwright install chromium`.) Neko then drives the page via `browser_navigate` /
`browser_type` / `browser_click` / `browser_snapshot` / `browser_evaluate`. **Verified end-to-end with the
default gpt-oss-120b:** navigate -> type a query into the search box + submit -> open the result -> read it,
AND self-correct when a tool call errored (retried with a better selector). The setup is headed so the user
can take over passwords/OTP/passkeys;
add stealth (`--device "Desktop Chrome"`, or CloakBrowser via `--cdp-endpoint`) for anti-bot sites — see
the `procurement` skill.

## Quick start — DESKTOP (Windows: WORKS with plain gpt-oss, NO vision — via UIA)
Native apps have no DOM, but Windows UI Automation (UIA) IS the desktop's accessibility tree — the desktop
DOM. **This is the primary path; use it first.**

**Prefer the first-class `computer` tool** over bash-ing the scripts: `computer({action, window, ...})` —
`action` is `list | read | get | display | activate | invoke | setvalue | toggle | click | stroke | type | key |
scroll | wait | watch | open | screenshot`. `watch` waits inside the resident UIA process until readable state
changes and stays stable, then returns `elapsed_ms`, `detected_ms`, a compact state id, and the fresh text
without model-side polling.

**A MINIMIZED window enumerates as 0 elements.** If `list`/`read` on a `window` returns nothing (or "0
elements"), the app is almost certainly minimized or hidden — call `activate` with that `window` FIRST
(it restores + foregrounds it via the native handle), then `list`. Never hand-roll ShowWindow/
SetForegroundWindow P/Invoke through bash: use `computer({action:"activate", window})`.

**CHROMIUM / ELECTRON apps (Zalo, Discord, Slack, Spotify, VS Code, WhatsApp...) hide their UI from
UIA.** The tell: `list`/`read` shows ONLY `Chrome Legacy Window` (`Chrome_RenderWidgetHostHWND`) and an
`Intermediate D3D Window` — the real buttons/lists/inputs live inside the Chromium renderer and are NOT
in the UIA tree. Handle it like this:
- Use **`ocr`** — `computer({action:"ocr", window:"Zalo"})`. It runs the built-in Windows OCR engine on
  the window and returns every on-screen text line with its screen-pixel centre: `'the text' @ x,y`.
  Then `click` those coordinates, `type`/`key` to enter text. **No vision model needed** (a text-only
  model works), no download, no network. This is the FIRST thing to try on an Electron app. Flow:
  `activate` (if minimized) → `ocr` → `click x,y` → `ocr` again to verify. It runs in the warm resident
  host, so after the first perception each `ocr` is ~0.5s/frame — perceive freely, re-`ocr` after every
  action to verify instead of assuming.
- Do NOT loop on `--force-renderer-accessibility`, env vars, or a remote-debugging port. These apps are
  SINGLE-INSTANCE and hardened: relaunching with a flag just wakes the existing (unflagged) process, and
  packaged Electron apps (Zalo verified) strip the flag / block the debug port. flag→env→CDP in sequence
  is the classic wasted-turn spiral — go straight to `ocr`.
- `ocr` reads TEXT only (not icons/avatars) and, for accented scripts, needs the matching Windows OCR
  language pack (Settings > Language) — without the Vietnamese pack, en-US still reads Vietnamese as
  unaccented Latin, which is usually enough to locate a name/label and click it. If a target is a
  non-text icon, `screenshot` + a vision model is the fallback (only when `vision: true`).
- A regular web page in Chrome/Edge is different: launching the browser itself with
  `--force-renderer-accessibility` DOES expose the DOM to `uia.ps1 read` (verified). That trick is for
  the browser, not for a packaged Electron app you cannot relaunch with the flag.

**Windows shell trap — do NOT `powershell -Command "<complex script>"` through the `bash` tool.** On
Windows the `bash` tool is git-bash: it re-parses the string and mangles PowerShell quoting, so
`Add-Type`, `param(...)`, here-strings, and nested quotes fail (`Missing ')'`, `... is not recognized`).
Reach for the first-class `computer` actions above instead — they cover perceive/act/activate without
any raw PowerShell. If you GENUINELY need PowerShell (rare), `write_file` a `.ps1` and run
`powershell -NoProfile -ExecutionPolicy Bypass -File script.ps1` — never inline `-Command`. Retrying the
same mangled `-Command` is the top wasted-turn pattern; switch strategy on the FIRST failure.
It dispatches to the scripts below (Unicode names handled via a temp UTF-8 `@file` automatically), gated like
bash, and honours the presence/input config. Bash + the raw scripts is the fallback / for anything the tool
doesn't expose. The underlying `uia.ps1` lets a text model perceive + act + verify with no vision and (for
pattern actions) no cursor movement:

```
# perceive: list actionable elements (name + role + verb + exact coords)
NEKO_UIA_WINDOW="<window title>" pwsh uia.ps1 list
#   [Edit] 'Input' (setvalue) -> 960,432
#   [Button] 'Greet' (invoke) -> 794,494
# act by NAME (programmatic UIA pattern -> no cursor, no focus steal, works occluded):
pwsh uia.ps1 setvalue "Input" "Neko"      # ValuePattern (type without keyboard) -- AUTO-VERIFIES: reads the
                                          #   value back -> "set+VERIFIED" or "WARN MISMATCH" (exit 1); a
                                          #   read-only field -> "FAIL READ-ONLY" before any silent no-op
pwsh uia.ps1 invoke   "Greet"             # InvokePattern (click without moving the mouse); falls back to a
                                          #   real coord-click only if no pattern is exposed
pwsh uia.ps1 toggle   "Show advanced"     # TogglePattern -- AUTO-VERIFIES the state actually flipped (else WARN)
# verify (no vision): read a value/state back
pwsh uia.ps1 get "Input"                  # -> value 'Input' = 'Neko'
# read a whole page/doc as TEXT (Text/Document/Hyperlink names) -- summarize a web page, no vision:
pwsh uia.ps1 read                          # dumps readable content (list = actionable; read = content)
# Unicode targets (Vietnamese/CJK/emoji): the cp1252 console mangles non-ASCII args -> pass @<utf8-file>:
pwsh uia.ps1 invoke "@C:\tmp\name.txt"     # reads the exact element name from a UTF-8 file (round-trips clean)
```

Controls without a usable UIA pattern use the human-input verbs. They target the named window and **refuse
to type if Neko cannot prove that window owns the foreground**, preventing text from leaking into another
app. `type` uses Win32 `SendInput` + `KEYEVENTF_UNICODE`, not the clipboard or keyboard-layout-dependent
SendKeys; `scroll` uses the separate touch channel, so the real mouse stays put:

```text
computer({ action: "open", target: "notepad.exe" })
computer({ action: "wait", duration_ms: 500 })
computer({ action: "type", window: "Notepad", name: "Text editor", text: "Hello from Neko" })
computer({ action: "key", window: "Notepad", keys: "CTRL+S" })
computer({ action: "scroll", window: "Notepad", direction: "down", amount: 2 })
computer({ action: "read", window: "Notepad" })  # verify from fresh state
computer({ action: "watch", window: "Messenger", duration_ms: 10000, settle_ms: 500 })
```

### Windows coordinate contract (DPI is part of correctness)
All Neko coordinates are **physical pixels in the Windows virtual desktop**. Before a spatial task, call
`computer({action:"display"})`; it reports every monitor's physical bounds, work area, DPI, scale, and negative
origins. UIA bounds, screenshots, touch injection, mouse fallback, overlay, and scrolling share that space.

If a task genuinely needs a custom C#/PowerShell coordinate script, set
`SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)` **before any window, Forms, Screen,
GetWindowRect, or monitor API is touched**. Do not use the older `SetProcessDPIAware()` as the final solution: it
is only system-DPI-aware and remains wrong when monitors use different scales. Never infer the screen edge from
an action's success message; read the final physical positions back or inspect a fresh screenshot.

### Completion is an observed state, not a successful action
For every desktop/browser task, separate **process evidence** ("the click/script ran") from **outcome evidence**
("the requested end state is now visible/readable"). After the final mutation, wait for the UI to settle and
perform an independent observation. Check each user-visible postcondition against the original task. If a
shortcut was meant to be at the right edge, verify its final bounding rectangle against `display`'s work area;
do not conclude from the coordinate you asked the script to use. Production Neko enforces this at finish time:
a completion claim after state-changing tools is rejected until a fresh successful inspection is present.

`open` launches a single executable/file/URL; use gated `bash` for commands with arguments, downloads,
package managers, and installers. Never put a secret in `type`/`setvalue`; hand control to the user.
WEB note: a browser exposes the page to UIA only when accessibility is on -- launch Chrome with
`--force-renderer-accessibility` (reuses the logged-in profile, no CDP) so `uia.ps1 read` sees the feed/DOM
as text. **VERIFIED:** gpt-oss autonomously read + summarized a live Facebook feed via `read`, scrolled with
`inject.ps1`, and opened + composed a post by invoking the composer BY NAME (`@file`) -- coordinate taps on a
feed are fragile (the layout reflows between `list` and `tap`); invoke-by-name is layout-independent. For a
heavy page, lower `reasoning_effort` so the model emits the answer instead of over-reasoning into the token cap.
**VERIFIED end-to-end** on a real .NET window: `list` -> `setvalue Input=Neko` -> `invoke Greet` ->
screenshot showed `Hello, Neko!`, and `get` read the value back — all with the default gpt-oss, zero vision,
zero cursor movement. The loop is **perceive (`list`) → act (`invoke`/`setvalue`/`toggle`) → verify
(`get`/`list`)**, all text. **Act→verify is now built in for state-changing patterns:** `setvalue` reads the
value back and asserts it landed (read-only / rejected / reformatted / masked input is caught, not assumed),
`toggle` asserts the state flipped — both exit 1 on mismatch so the model sees the failure. `invoke`/`click`
have no single property to check (side effects), so still **re-perceive after them** (`list`/`get`/`read`)
before assuming success — never blind-trust an action you can't read back. (Principle: the model decides the
action, code verifies it against the structure — the desktop analogue of "LLM extracts, code computes".)

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
- **Screenshot** — first-class `computer screenshot` reuses the resident host; `screenshot.ps1 <out.gif>
  [width]` is its one-shot fallback. Both capture + downscale the physical virtual desktop to a small **GIF**
  and print `origin` + `scale` (driver maps `real = origin + view / scale`). Resident output also includes a
  frame id, sampled change percentage, and physical `changed=x,y,w,h` bounds. Pixel change proves only that
  something changed, not that the requested outcome is correct. Why GIF, not JPEG/PNG: NVIDIA's gateway counts the image's
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
- **Multi-monitor**: the image spans the physical virtual desktop, including negative origins. Map a view
  point with `realX = originX + viewX/scale`, `realY = originY + viewY/scale`.

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
(For keyboard fallback, use the built-in `computer type`/`key`; it focus-checks the target before SendInput.)

## Grounding without a GUI-trained model (the key technique)
"Everything is data" -- the screen ALREADY is structured data; don't make the model estimate pixels. Ground
in order of reliability (only the last needs a GUI-trained model):
1. **Code / CLI / API** (CoAct-1) -- no grounding at all, most reliable (Neko's code-first principle).
2. **Accessibility tree** -- `uia.ps1` reads AND acts on a window via Windows UI Automation: NAME + ROLE +
   EXACT bounding rect FROM THE OS, plus the assistive-tech action patterns. A plain text model (gpt-oss)
   `list`s elements, then acts BY NAME: `invoke` (InvokePattern -- click with NO cursor movement / no focus
   steal / works occluded), `setvalue` (ValuePattern -- type with no keyboard), `toggle`, and `get` to verify
   -- pixel/element-perfect, private, NO vision, NO GUI-training. Neko now keeps one PowerShell/.NET UIA/input/capture host
   warm per process: measured WPF p50/p95 is 31/57 ms for `list`, 23/36 ms for `get`, and 93/121 ms for
   verified `setvalue` after a ~1.08 s cold start. Keyboard/touch actions reuse that process too: type
   252-321 ms, key 311 ms, and custom-canvas touch 467 ms including focus + post-action structural check.
   `computer_use_resident: false` restores the one-shot path.
   Falls back to a real coord-click
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

## Latency contract -- make a known app feel human-speed
Benchmark success and human wall-clock speed are different metrics. UIA is now warm and human-interactive;
display remains one-shot, and one remote model turn commonly costs several more
seconds. For apps such as Zalo, the shortest sound path is:

1. **Resident local executor (landed):** one local JSONL host per Neko process loads UIA, SendInput, touch,
   and virtual-desktop capture
   injection once, serializes
   desktop requests, restarts after failure, does not pin short-lived Neko processes, and keeps the existing
   scripts as a transport/startup fallback. UIA reads are below the p50 <150 ms / p95 <300 ms target;
   focus-verified keyboard input is 252-321 ms, a verified custom-canvas tap is 467 ms, and warm capture is
   71-119 ms with sampled physical change bounds. Native DXGI capture is deferred until GDI measurably fails
   on GPU/HDR/protected content; model perception remains a separate cost.
2. **Profiled fast path, not core hard-coding:** an app capability profile discovers the current Zalo window,
   version, accessible names, and shortcuts. A profile hit may perform deterministic search/draft actions;
   a miss immediately returns the fresh state to the general agent. Never assume labels from an old version.
3. **Validated micro-batches:** one model turn may propose several low-risk actions, but the executor checks the
   expected window/control/fingerprint before each action and stops on the first mismatch. Sending, posting,
   paying, deleting, or selecting a different recipient is a separate approved commit, never hidden in a batch.
4. **Lifecycle:** discover/attach -> baseline observation -> plan -> validated low-risk batch -> sensitive
   approval -> independent outcome verification -> audit -> idle/release. On user takeover: pause, re-perceive,
   and re-plan; never resume from stale coordinates or stale UIA ids.
5. **Completion for messaging:** verify the exact recipient, exact draft, one send only, and a fresh delivery
   state exposed by the app. Never type a password, PIN, OTP, or hidden-chat secret; hand control to the user.

The GUI harness must report **model turns and GUI actions separately**, plus wall time, misses, violations,
wrong-recipient/duplicate-action counters, and verifier coverage. A fast path ships only when repeated trials
keep task success flat-or-up and safety failures at zero; fewer turns alone are not evidence of completion.

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

**(A2) Independent ACTING pointer — touch injection (no mouse hijack).** The resident computer host, or the
one-shot fallback `inject.ps1 tap|dbltap|stroke
<coords>` acts via Windows TOUCH INJECTION (`InitializeTouchInjection`/`InjectTouchInput`) — a SEPARATE
pointer channel, so the agent clicks/drags/draws on the VISIBLE desktop while the user's MOUSE stays put.
**VERIFIED:** drew lines in Paint with the real cursor parked in a corner (unmoved before == after); no
driver, no admin, unpackaged P/Invoke, Win11-Home OK. Pair with (A) overlay = Clicky's "instructor pointer"
but it actually ACTS: the overlay shows WHERE, injection DOES it, your mouse is free. **Config-first:** set
`computer_use_input: "inject"` -> bash gets `NEKO_INPUT=inject` -> `mouse.ps1`'s `click`/`dblclick`/`stroke`
transparently route to touch injection (agent code unchanged); `"sendinput"` forces the legacy cursor-moving
path in both resident and one-shot modes; a NEW backend is a config value + a script, not a rewrite. Honest scope: touch lands on the TOPMOST
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

## Robustness — audit trail, intervention+resume, goal-loop (the professional layer)
Three things separate a real computer-use agent from a demo:

**1. Audit trail ("what did Neko do?").** Every desktop ACTION (`uia` invoke/setvalue/toggle, `inject`/`mouse`
tap/click/stroke, `input` type/key/scroll/open) is appended, timestamped, to `%TEMP%\neko_actions.log`
(override via `NEKO_ACTION_LOG`; typed text and launch targets are redacted from this log).
To answer "what steps did you take?" or to review/replay, `read` that log -- a human-readable trace of the
real OS-level actions (complements the agent transcript). Cheap, always-on.
Resident `computer watch` writes separate metadata-only events to `%TEMP%\neko_observations.log` (override
via `NEKO_OBSERVATION_LOG`): status, `elapsed_ms`, `detected_ms`, state id, and an opaque window id. It stores
neither the window title nor the private text body.

**2. Intervention + auto-resume (state-managed interruption / shared autonomy -- SOTA).** While Neko drives,
the overlay's low-level hook detects a REAL (non-injected) user click/move and writes the stop-file; the next
helper call returns `PAUSED: the user took control`. The loop -- DON'T blindly continue:
- helper says PAUSED  ->  STOP acting immediately;
- run `idle.ps1 [idleSec=3] [maxWaitSec=90]` -- it blocks until the user has been idle a few seconds, then
  clears the pause (returns "resume: ...");
- **RE-PERCEIVE**: screenshot + `uia.ps1 read`/`list` -- the user may have changed the state;
- **RE-PLAN** toward the goal from the NEW state, then resume.
"Re-perceive, don't blind-resume" is the mixed-initiative principle (the human is always in charge). The
overlay shows red "Đã dừng — bạn đang điều khiển" while paused; injected (agent) input is exempt from the
takeover hook, so Neko's own actions never trip it.

**3. Goal-completion loop (persistence -- finish the task, don't give up).** A single `run` stops the moment
the model emits no tool call -- which is exactly why an earlier Paint task quit after 2 strokes. For a real
GOAL use the closed loop: **`neko run --loop "<goal>"`** (`agent.runUntilDone`). Each pass RE-INSPECTS the
ACTUAL state (re-screenshot / re-read), compares to the goal + a high bar, and either replies DONE or does the
next concrete step -- up to maxIters. This is the **Reflexion / CRITIC / Chain-of-Verification** pattern
(Actor -> Evaluator -> Self-Reflection); research notes most gains land in the first ~2-3 passes, so the bound
is sane. Tip: for read/verify-heavy turns, lower `reasoning_effort` so the model emits the verdict instead of
over-reasoning into the token cap. Compose all three: the goal-loop drives to completion, the resume loop
hands control back-and-forth cleanly, and the audit log records every step.

**Long-horizon rule (OSWorld 2.0 / QGP).** Keep the full constraint list and current subgoal in `todo_write`;
after every material action, re-read the environment and update the plan from observed state. A todo is
`completed` only when there is fresh evidence (UIA value/tree, screenshot, file readback, or command result).
Do not guess through an ambiguous dialog: ask. Do not emit a final answer while a todo is still pending unless
the final answer names the external blocker. These state/backlog controllers matter more on hour-scale tasks
than adding another action verb.

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

## Honest scope (tested, 2026-07-10)
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
- **Screenshot capture** currently uses the honest `capture=gdi` compatibility backend. It is fast once warm
  but is not guaranteed for protected video, every GPU overlay, or HDR-faithful color; those measured failures
  justify the future DXGI backend. Antivirus may also flag screen-capture scripts (false positive); use a
  trusted capture path. Downscale to stay under NVIDIA's ~180 KB inline-image cap.
- **Web** computer-use (DOM via `@playwright/mcp`, no vision) is still the most reliable autonomous path.
