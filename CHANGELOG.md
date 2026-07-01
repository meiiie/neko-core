# Changelog

All notable changes to Neko Code are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[semantic versioning](https://semver.org/) (pre-1.0: minor versions may include breaking changes).

## [Unreleased]

- **Horizontal gutter — the UI is inset from the terminal edges** — the whole REPL (transcript + live region)
  now sits inside a left/right padding instead of running flush against column 0, matching Claude Code's
  `paddingLeft={2}`. `<Static>` inherits the wrapper Box's padding, so one change indents both the committed
  history and the live area; width-sensitive rendering (markdown tables, dividers, the stream clamp) uses the
  padded inner width.

- **Long generations no longer time out mid-stream ("The operation timed out")** — the request timeout was a
  TOTAL cap (`AbortSignal.timeout(timeout_seconds)`) applied to the whole streamed response, so a legitimately
  long generation (e.g. a landing page across 3 files) was aborted once it crossed `timeout_seconds` (120s) even
  while tokens were still streaming in. It's now an **idle timeout**: the timer resets on every streamed chunk,
  so a healthy stream never times out and only a genuine STALL (no bytes for `timeout_seconds`) aborts. Fixed in
  both providers (`anthropic` — the Z.ai/GLM path — and `openai_compat`). Unit-tested with a slow-but-active
  stream (total time > budget, gaps < budget → completes). Also: the live **todo tracker** only shows while a
  turn runs (the committed "Update Todos" result is the record) — it no longer prints the plan twice.

- **Streaming no longer scroll-jumps to the top; list/footer/run-indicator polish** — the live streaming
  preview used to render the whole growing reply (up to ~60 lines), which overflows the terminal so Ink can't
  update it in place and **redraws from the top every frame** — the classic "it keeps scrolling to the top
  while generating" bug. The preview is now **clamped to the viewport height** (wrap-aware, tracks terminal
  rows) and rendered in a `compact` markdown mode (predictable height); the full reply still commits to the
  scrollback verbatim when it finishes. Also: a **`**Label**` line followed by bullets** is no longer glued to
  them (a list is treated as one block with a blank line around it); the **footer mode indicator** gets a `⏵⏵`
  chevron + indent; and the **in-flight tool dot** is blue and blinking. Unit-tested (`clampToRows`, list-block
  separation, compact-vs-normal height).

- **The `bash` tool runs real bash on Windows (not cmd.exe)** — an unsandboxed bash command used to spawn
  through `cmd.exe` on Windows, so the Unix idioms a model naturally emits (heredocs like `python - <<'PY'`,
  single-quoting, `$VAR`, pipelines) failed with `"<< was unexpected at this time"` and wasted agent steps.
  Neko now routes the tool through **Git-Bash** if present (`NEKO_BASH` override, then a Git install, then a
  git-derived path; WSL's `System32\bash.exe` is deliberately skipped because it can't see the Windows-drive
  workspace), falling back to the platform shell only when no bash is found. Dogfooded on OpenAI's GeneBench-Pro
  benchmark, where the old behavior cost answers; unit-tested (`plainTarget` / git-bash detection).

- **Terminal UI polish — bordered tables, vertical rhythm, a real Ctrl+O toggle, a live run indicator** —
  markdown **tables** now draw aligned box borders and are budgeted to the terminal width (the widest column
  shrinks, cells truncate to a single line) instead of overflowing and wrap-shattering their columns.
  **Paragraph spacing** is fixed: Ink collapses an empty `<Text>` to zero height, so blank markdown lines were
  disappearing and paragraphs ran together — blank lines now render as real rows (runs collapse to one), with a
  blank line above headings and around tables, for even vertical rhythm. **Turn separation:** each user prompt
  and each tool call now gets a blank line above it (matching Claude Code's per-message `marginTop`), so a prompt
  no longer glues to the previous turn's output or the tool call below it. **Ctrl+O** is now a proper expand/collapse **toggle** (it used to append a
  duplicate full copy every press and never collapse); the peeked output shows in the live region so a second
  press closes it. A tool call **in flight** shows live with a **blinking dot** and commits to the transcript
  with a solid dot when it finishes — a clear running-vs-done signal (deferred + keyed by call id so parallel
  tool calls pair correctly). Table layout is unit-tested (`fitColumns` / `truncCell` / bordered render).

- **`web_fetch` reads the web as Markdown, with deterministic per-platform routing** — a fetch now returns
  clean **Markdown** (`htmlToMarkdown`: keeps headings/links/lists, drops nav/scripts — the old flat strip
  threw links away). A **small page comes back whole with NO model call** (the markdown is the answer); a
  **large page paginates** (`page:N`) instead of truncating; results cache ~5 min. Known platforms route in
  **code, not a skill the model can ignore**: a **YouTube** URL → its **transcript** via `yt-dlp`, **GitHub**
  → `gh`, an **RSS/Atom** feed → a compact item list; each falls back to a normal fetch if the tool is missing.
  Opt-in `scrape_backend: "jina"` renders public JS/SPAs via Jina Reader (keyless). Measured: a YouTube ask on
  gpt-oss dropped from 7 calls / ~48k tokens (chasing fake-transcript sites) to **2 calls / ~16k**, and the
  same on glm-5.2 answered in 2 calls / ~9k. Size policy + compact reads learned from Hermes Agent; our own
  implementation. Unit-tested (`htmlToMarkdown` / `paginateWeb` / `vttToText` / `rssToMarkdown`).

- **Skills load deterministically by a `match:` trigger, not just fuzzy keyword overlap** — a skill's
  frontmatter may declare a `match:` regex (e.g. a platform URL for the new `web-reach` skill), checked FIRST
  so a clearly-matching domain skill loads even for short or non-English asks that token-overlap missed (a
  Vietnamese "lay transcript youtube ..." shared only ~3 English tokens and silently loaded nothing). Adds two
  skills: `web-reading` (efficient reads — a11y/markdown first, grab-once, no scroll-churn) and `web-reach`
  (route each platform to its best free backend). The doom-loop guard was generalized to nudge after N
  unproductive tool results (empty/duplicate), not just repeated identical calls.

- **Interactive provider/model switching in the REPL** — `/provider` picks a provider then chains into a
  model picker; `/login` runs a guided provider-picker wizard before capturing the key; both swap the live
  provider in place (`NekoConfig.adopt` + `agent.setProvider`) so a switch takes effect mid-session without
  restart. Keys still resolve on demand and are never stored or printed.

- **Provider extensibility — any provider is a profile + an env var (no config editing)** — built-in presets
  now declare a `key_env` (the env var holding that provider's key, e.g. `ZAI_API_KEY`, `DEEPSEEK_API_KEY`),
  resolved with the right precedence (a profile's own key beats a stray `OPENAI_/NVIDIA_API_KEY`; `NEKO_API_KEY`
  still overrides). So a multi-provider setup just means setting per-provider env vars and `--profile <name>` —
  no JSON surgery. New presets ride the Anthropic provider: `zai` (GLM Coding Plan, quota endpoint),
  `zai-openai` (Z.ai pay-as-you-go), `claude` (real Anthropic), plus `moonshot` (Kimi); `key_env` added to
  openai/groq/deepseek/mistral/together/fireworks/xai/openrouter/nvidia. Adding a new provider stays a one-line
  data edit. Unit-tested (key_env resolution + no cross-provider hijack).

- **Anthropic Messages API provider — run on Claude or a Z.ai GLM coding plan** — `provider: "anthropic"`
  speaks `POST {base_url}/v1/messages` (the Claude format, and the format Z.ai's GLM Coding Plan / OpenCode
  endpoint `https://api.z.ai/api/anthropic` expects). It's a config choice, not a core change — same Provider
  port as openai_compat. So Neko can run on a Z.ai coding-plan subscription (whose quota is on the Anthropic
  endpoint, not the pay-as-you-go OpenAI one), e.g. for continuous self-improvement runs. Converts Neko's
  OpenAI-shaped messages/tools to Anthropic blocks (system fold-up, tool_use / tool_result, image blocks,
  input_schema) and parses both non-streamed and SSE responses (text/thinking/tool deltas, usage). Set up a
  profile `{"provider":"anthropic","base_url":"https://api.z.ai/api/anthropic","model":"glm-4.6","api_key":"..."}`
  and run `neko run --profile zai ...` / `neko chat --profile zai`. Live-verified end to end (glm-4.6 drove a
  tool-calling agent run); conversions unit-tested.

- **`neko run --image <path>` — image→price in ONE automatic command** — attach image(s) to a one-shot run.
  Neko runs a **vision pre-pass** (a vision model reads the image into text) and then hands that text to the
  normal tool-using agent, which searches/prices it — so a text model that can't see and a vision endpoint
  that can't tool-call combine into one command. The vision model is `vision_model` config, defaulting to the
  verified `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` on an NVIDIA endpoint (a new `NekoConfig.withModel` clones
  the config at that model). Verified end to end: `neko run --image pack.jpg "tìm giá rẻ nhất VN"` -> the
  vision pass read "SanDisk Cruzer Blade 16GB", the agent then web-searched the CZ50 and priced it. If no
  vision model is available, the image run is a pure perception pass (no tools, since vision-only endpoints
  reject tool-calling).
- **Computer-use act→verify (deterministic) — the desktop analogue of "LLM extracts, code computes"** — a
  state-changing UIA action no longer trusts that it worked: `setvalue` reads the value back and asserts it
  landed (a read-only field is caught up front; rejected / reformatted / masked / truncated input becomes a
  "WARN MISMATCH", exit 1), and `toggle` asserts the state actually flipped. The model decides the action;
  code verifies it against the structure. `invoke` also self-verifies via a **UIA tree diff** — it snapshots
  the window's control tree + the top-level windows before/after and reports what appeared / went away / which
  new window opened (deterministic proof it did something, or a warning that it didn't); `click` still can't
  self-verify, so re-perceive after it. Live-tested on WPF windows (set+VERIFIED on a field, FAIL READ-ONLY on
  a locked one, `invoke` reporting the exact element that appeared).
- **Deterministic price-table layer (`price-table.ts`) — LLM extracts, code computes** — the professional,
  non-patchwork fix for a class of dogfood failures (gpt-oss read "31.990.000đ" as 31, reported a pricier
  source as "cheapest" while holding a cheaper one, summed wrong). Per the 2026 consensus on reliable
  extraction, the model now only transcribes prices VERBATIM and a deterministic script (`parseVnd` + sort +
  min/max/sum/median + outlier flags) does all the numbers — making the misparse / wrong-min / wrong-sum bug
  class *impossible*. Unit-tested (the script is deterministic, so it can be; the model can't). The
  procurement skill is reframed around it; the principle is documented in `docs/process/WEB.md` as the shape
  for any future numeric extraction.
- **Computer use** — a `computer-use` skill (code-first per CoAct-1, the GUI perception-action loop, hard
  guardrails). WEB control validated end-to-end through `@playwright/mcp` (DOM-driven, no vision needed) and
  a real VN procurement run. A Windows desktop **control primitive** `mouse.ps1` (pos/move/click) plus the
  Clicky-inspired `[POINT:x,y]` grounding path, so the screenshot -> vision-ground -> click loop is ready the
  moment a vision/GUI model is configured.
- **Desktop control with NO vision (UIA)** — `uia.ps1` drives Windows apps through the OS accessibility tree
  (the desktop DOM): a plain text model `list`s a window's controls (name + role + verb + exact OS coords),
  then acts BY NAME — `invoke` (InvokePattern: click without moving the cursor), `setvalue` (type without the
  keyboard), `toggle`, and `get` to verify — no vision, no GUI-trained model, no cursor hijack. SOTA-grade
  perf via a UIA CacheRequest (one bulk cross-process call; a naive tree walk times out on rich WinUI/WPF).
  Verified end-to-end on a real .NET window (`list` -> `setvalue` -> `invoke` -> screenshot confirmed). Raw-
  pixel vision is now only the LAST resort, for custom-drawn UIs with no accessibility tree.
- **Independent agent pointer (no mouse hijack)** — `inject.ps1` (tap/dbltap/stroke) acts via Windows TOUCH
  INJECTION, a SEPARATE pointer channel, so Neko clicks/drags/draws on the visible desktop WITHOUT moving the
  user's mouse (verified: drew in Paint with the real cursor parked, unmoved). Pairs with the overlay (the
  visible "instructor" triangle) for a true clicky-style cursor that actually acts. **Config-first:**
  `computer_use_input: "inject"` -> `NEKO_INPUT=inject` -> `mouse.ps1`'s click/stroke transparently route to
  the non-hijacking path (`"sendinput"` forces the legacy path); a new backend is a config value + a script.
  No driver, no admin, Win11-Home compatible. (Hidden/background or game control still needs VM isolation —
  documented honestly in the skill.)
- **Web reading via accessibility + tab presence** — `uia.ps1 read` dumps a page/doc as TEXT (so a text
  model summarizes a web page with no vision); Unicode `@<utf8-file>` targets (invoke-by-name survives the
  cp1252 console and is layout-independent). Launching Chrome with `--force-renderer-accessibility` exposes
  the logged-in page DOM to UIA — gpt-oss autonomously browsed + summarized a live feed and composed a post,
  reusing the login with no CDP and no credentials. The overlay now shows a **tab/window indicator** —
  frames + labels the exact window/tab Neko is driving ("NEKO dang dung tab nay: <title>"), driven by
  `neko_active_window.txt`.
- **Computer-use robustness — audit trail, intervention-resume, goal-loop** — every desktop action is appended
  timestamped to `%TEMP%\neko_actions.log` (override via `NEKO_ACTION_LOG`), so "what steps did you do?" is a
  `read` away. On a real (non-injected) user click the overlay yields and the helpers return `PAUSED`; the new
  `idle.ps1` blocks until the user has been idle a few seconds then clears the pause, so Neko can RE-PERCEIVE
  (re-screenshot / `uia.ps1 read`) and RE-PLAN from the new state — SOTA state-managed interruption / shared
  autonomy, "re-perceive don't blind-resume". And `runUntilDone` (`neko run --loop`) now re-inspects the ACTUAL
  state each pass before judging DONE (Reflexion/CRITIC/Chain-of-Verification) — the fix for tasks that quit
  early (the Paint test). SKILL.md documents all three.
- **First-class `computer` tool** — computer-use is now a native, gated agent tool, not just bash-ed scripts:
  `computer({action, window, name, value, x, y, points})` with `action` = list/read/get/invoke/setvalue/
  toggle/click/stroke/screenshot. It dispatches to the accessibility-tree scripts (Unicode names via an
  automatic temp UTF-8 `@file`), honours the presence/input config, and is gated like bash. The agent calls
  it structurally instead of constructing fragile shell strings. Verified live against a real Paint window.
- **`auto_loop` config (persist by default)** — set `"auto_loop": true` and `neko run` uses the closed loop
  (runUntilDone) by default, so you don't retype `--loop`; `--once` (alias `--no-loop`) forces a single shot.
- **`neko setup web` — one-command SOTA web stack** — stands up SearXNG in Docker (JSON API enabled, the bit
  that's off by default), verifies it, and wires `searxng_url` + the `@playwright/mcp` browser MCP (headed
  real-Chrome) into config — idempotent, key-safe (never touches `api_key`), with clear `[skip]` messages if
  Docker/bunx is missing. Sub-targets `setup searxng` / `setup browser`. Turns the manual setup that lifted
  Neko above a hand search (DuckDuckGo 18.3M → SearXNG 7.99M) into one command.
- **`neko bench lift` — harness-lift benchmark** — runs the same tasks twice, RAW (the model alone, no
  tools/loop, must emit file contents) vs +NEKO (tools + agentic loop), and reports the delta. Makes the
  thesis ("the harness turns a model into a capable agent") measurable instead of vibes. Honest finding: on
  tiny self-contained coding tasks a capable model (gpt-oss-120b) one-shots them, so the lift is ~0 there —
  the lift shows on tasks the raw model CANNOT do (a `run-to-know` task whose value needs executing code; and
  agentic/computer-use, where raw can't act at all — cf. the Paint house: raw scribbled+quit, +Neko drew a
  full house).
- **Deep research** — a `deep-research` skill (plan -> multi-source search -> read primaries -> cross-verify
  >=2 authoritative sources -> cited synthesis) and a strengthened always-on Accuracy section in the prompt.
- **tui-self-test** skill — verify the TUI render (ink-testing-library + a live screenshot loop) with the
  SendKeys focus-leak guardrail learned from dogfooding.

### Fixed
- **Path-escape guard now catches SYMLINKS, not just `../`** — `resolveInRoot` did lexical containment only, so a symlink INSIDE the root pointing OUTSIDE passed the check but actually escaped (read/write through it could touch files outside the project). It now also compares realpaths (resolving a new file's nearest existing parent), so a symlinked path that resolves outside the root is refused. Verified: reading through a junction escaping the root is refused, no leak. Low-risk on a local-first tool (you own the repo, write/bash are gated) but now closed.
- **Computer-use coordinate actions land on a scaled display (DPI fix)** — UIA reports element coordinates in
  PHYSICAL pixels, but the acting scripts were DPI-UNAWARE, so on a scaled display (e.g. 125%) Windows
  virtualized their click/tap coordinates and they landed ~1.25x off-target — every coordinate action quietly
  missed. CONFIRMED with a functional test (an unaware mouse-click at a checkbox's reported coords missed; a
  fully DPI-aware read+click toggled it). All five coordinate scripts (`uia`/`inject`/`mouse`/`overlay`/
  `screenshot`) now set `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`, so reads, actions, the cursor
  overlay, and the screenshot `scale` all share one physical-pixel space. (Touch still routes control clicks
  through `invoke`-by-name, not coordinates — injected touch doesn't promote to a control click.)
- **Atomic writes — a crash can no longer lose the session / API key / memory** — `saveSession` (per turn),
  the user config writer (holds the API key), and the NEKO.md memory note all did a plain `writeFileSync`,
  which truncates-then-writes; a kill/crash/concurrent-write in that window left an unparseable file that the
  loaders then silently dropped — i.e. the whole conversation or the saved key, gone. They now go through
  `shared/atomic.ts` (write a temp sibling, then atomic rename), so the target is always the old or the new
  bytes, never a truncation. Unit-tested incl. "a failed write leaves the original intact".
- **MCP: a hung server no longer blocks startup** — `connectAll` awaited each server's connect + `listTools`
  with no timeout, so one unresponsive stdio command / URL hung Neko's startup indefinitely (and stalled every
  server after it). Each connect is now bounded (15s) and skipped-with-error on timeout; interactive OAuth is
  exempt (user-paced).
- **`computer` tool: failures are visible, inputs are validated** — `runComputer` swallowed PowerShell
  spawn errors / timeouts into `"(no output)"`, so the agent couldn't tell a *failed* action from a silent
  one; and `click` coerced a missing/invalid coordinate to the string `"NaN"` and passed it to the injector.
  Now spawn errors, timeouts (the 90s hang), and non-zero exits are surfaced as real error observations, and
  `click`/`stroke` reject non-numeric coordinates up front (deterministic input validation, unit-tested) —
  the same "surface errors, validate in code" standard as the extraction layer.
- **A throwing tool no longer crashes the whole turn** — a model glitch (e.g. emitting `web_fetch` with no
  `url`) made an executor `throw`, which escaped the agent loop and killed the run (`neko: error: ...`). Tool
  execution now goes through `safeExecute`, so any throw becomes a recoverable error OBSERVATION fed back to
  the model (honouring the loop's "errors are fed back so the model adapts rather than crash" contract).
  Caught a real failure mid price-research; regression-tested.
- **Context-overflow crash** — one huge tool result (a heavy page's browser snapshot) could push the prompt
  past the context window, so the server returned a negative `max_tokens` and 400'd the turn. Each
  observation is now capped, and a long turn compresses its OLDEST observations in place (observation
  masking) before it would overflow. Regression-verified on the exact page that crashed (772k tokens, 0 crash).
- **Procurement price typing** — prices are captured per condition (new / used-trade-in / installment), each
  a labeled row, so a used/trade-in price is never reported as the new price.

### Changed
- **UI polish** (verified live) — diffs render Claude-style (line number first, red removals / green
  additions); the tool-result connector uses a glyph (`└`) that renders on every terminal font; the
  diff/write header colors its `+N` green and `-M` red.

## [0.4.0] — 2026-06-27

### Added
- **Mixture-of-Agents provider** (`provider: "moa"`, or `neko --profile moa`): diverse reference models
  analyze in parallel without tools (on an advisory-safe view of the conversation — no system prompt or
  tool payloads re-sent), then a strong aggregator synthesizes their advice and drives the tool loop.
  Clean-room from the MoA paper (arXiv 2406.04692) + Hermes Agent. Mixture token cost is accounted; a
  failing reference degrades gracefully. Opt-in quality mode (N+1 calls/turn). Independent benchmarks: it
  TIES strong single models on saturated tasks (no headroom) but EXCEEDS them where the single model is
  weak — false-premise robustness, 5/6 vs 4/6.

## [0.3.0] — 2026-06-27

### Added
- **Remote control, professional + cross-device.**
  - `/rc` HTTP control API gained SSE streaming, `GET /status`, `POST /interrupt`, `Authorization: Bearer`
    auth, a 1 MB body cap, request serialization, and a discovery file; optional `remote_bind` for a
    trusted private mesh (Tailscale).
  - `/relay` drives Neko from **any phone/browser with no open port** — the agent dials out and
    long-polls a relay you host (a Cloudflare Worker; `cloudflare/relay/`), with **end-to-end encryption**
    (zero-knowledge relay) and **QR pairing** printed in the terminal.
- **Self-improving memory** — learned `workflows` (AWM-style procedures) and an always-on `playbook`
  (ACE) alongside `memory` (facts) and authored `skills`.
- **Skills** — `procurement` (VN sourcing / purchasing officer) and `browser-visual-qa` (drive a page,
  capture, analyze frames with vision).
- **Tool-use parity with Claude Code** — `search` via ripgrep (with a built-in fallback) + glob/case/
  context; `bash` per-call `timeout` + `run_in_background`; `read_file` offset/limit + image/PDF reading;
  MCP **lazy** schema loading.
- **Self-update** — `neko update` downloads the latest release and replaces the binary in place, plus a
  daily-cached startup check.
- **Config-driven `effort_ceiling`** — maps a configured `reasoning_effort` (e.g. `max`) down to the
  endpoint's accepted ceiling proactively.

### Fixed
- Robustness: bounded live render and tool output (no UI freeze / OOM on big streams), interruptible
  `bash`, per-cwd git-branch caching.
- Windows installer survives the schannel certificate-revocation condition (`--ssl-no-revoke` + fallback).
- `reasoning_effort` gracefully clamps to the highest accepted tier instead of erroring.

## [0.2.0]

- Initial public binaries: streaming agent loop, safe/gated tools, permission modes, Ink TUI, sessions,
  MCP, config-first profiles, one-line install.

[0.3.0]: https://github.com/meiiie/neko-core/releases/tag/v0.3.0
[0.2.0]: https://github.com/meiiie/neko-core/releases/tag/v0.2.0
