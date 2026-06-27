# Changelog

All notable changes to Neko Code are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[semantic versioning](https://semver.org/) (pre-1.0: minor versions may include breaking changes).

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
