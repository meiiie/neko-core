# Changelog

All notable changes to Neko Code are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[semantic versioning](https://semver.org/) (pre-1.0: minor versions may include breaking changes).

## [Unreleased]

### Added
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
