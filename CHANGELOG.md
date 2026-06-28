# Changelog

All notable changes to Neko Code are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[semantic versioning](https://semver.org/) (pre-1.0: minor versions may include breaking changes).

## [Unreleased]

### Added
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
- **Deep research** — a `deep-research` skill (plan -> multi-source search -> read primaries -> cross-verify
  >=2 authoritative sources -> cited synthesis) and a strengthened always-on Accuracy section in the prompt.
- **tui-self-test** skill — verify the TUI render (ink-testing-library + a live screenshot loop) with the
  SendKeys focus-leak guardrail learned from dogfooding.

### Fixed
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
