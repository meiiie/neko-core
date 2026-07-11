![Neko Core](assets/neko-core-banner.png)

# Neko Code

> **Một chú mèo trong terminal — chỉ muốn meo meo, và làm việc.** A **local-first, extensible terminal
> agent** that codes, browses, remembers — and through **skills, MCP, and an evolving memory** grows into
> new roles, from sourcing goods to driving a browser. Built on **TypeScript + Bun + Ink**,
> **provider-agnostic**, **offline-capable**. Engine: **Neko Core**.

**By [The Wiii Lab](https://github.com/meiiie).** MIT-licensed — contributions welcome.

[![CI](https://github.com/meiiie/neko-core/actions/workflows/ci.yml/badge.svg)](https://github.com/meiiie/neko-core/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/meiiie/neko-core?sort=semver)](https://github.com/meiiie/neko-core/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Made with Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun)](https://bun.sh)

---

## What it is

Neko is a general-purpose agent that **acts on your machine** from the terminal — it reads, searches,
edits, and runs code, drives a browser, and reaches the web. It is **config-first** (model / provider /
policy live in config, not code) and **not locked to any single role**: coding is what it does out of the
box, but its **pluggable skills**, **MCP tools**, and **memory** extend it into whole new domains. It
talks to **any OpenAI-compatible endpoint** — a hosted API (NVIDIA NIM, OpenAI, …) or a **local server**
(llama.cpp `llama-server`, Ollama), so it works offline.

### The foundation

- **Streaming agent loop** — `complete → tool-calls → observe`, capped by `max_steps`, with live token
  streaming, read-only tool fan-out (parallel), a stuck-loop guard, and auto-compaction.
- **Tools** — `read_file` · `search` · `glob` · `ls` (safe) and `write_file` · `edit` · `multi_edit` ·
  `bash` · `computer` (approval-gated). `search` uses ripgrep when present; `bash` takes a per-call timeout
  and can run in the background; `read_file` pages large files and reads images/PDFs. On Windows,
  `computer` combines UI Automation, mouse-independent touch, Unicode typing, shortcuts, scrolling, and
  app/file/URL launch. With vision enabled, a desktop screenshot returns directly to the model as the
  next observation; text-only drivers can pass the saved capture to a separate vision model. Path-escape
  is refused.
- **Web, a ladder not a cliff** — `web_search` + `web_fetch` work with zero config (DuckDuckGo).
  `neko setup web` upgrades to a private multi-engine SearXNG that Neko wakes on demand and stops when
  idle (Docker, Ollama-style); `neko setup tavily <key>` wires hosted agent-search with no Docker at
  all. Each rung falls back to the next automatically. See
  [`docs/process/WEB.md`](docs/process/WEB.md).
- **Permission modes** — `default` / `accept-edits` / `plan` / `auto`, cycled with **Shift+Tab** (a
  *named* bounded-autonomy state, audited by `neko policy`); a seatbelt blocks catastrophic shell.
- **Fullscreen terminal UI** — an app-owned, flicker-free viewport (alt-screen, like vim/htop):
  markdown renders live *as it streams*, scrolling is hardware-smooth at your display's refresh rate
  (auto-detected; `/fps`), the mouse wheel scrolls, drag selects + copies (or `Ctrl+C` / `/copy`),
  `Alt+C` copies the current draft without clearing it, `Ctrl+F` finds in the transcript, and the tab
  title tracks your session (a pulsing dot while it works). Exit leaves your shell exactly as it was —
  plus a one-line resume hint.
- **Sessions** — conversations persist; resume with `neko --resume`.
- **MCP** — connect Model Context Protocol servers (stdio / http / sse + OAuth) and use their tools;
  lazy schema loading keeps a big MCP surface out of context until needed.

### Extensible by design — not just a coding tool

Neko is built to take on new roles, one skill and one tool at a time:

- **Skills** — pluggable domain expertise with progressive disclosure. One is a *purchasing officer*
  (research, source, and plan a purchase across Vietnamese retailers — humans approve and buy); another
  drives a browser and reads screenshots back with vision to verify a UI frame by frame. A skill is a
  markdown file, not a fork; built-in skills and their helper scripts ship inside the single binary.
- **Self-improving memory** — durable facts (`memory`), learned `workflows` (procedures it distills by
  doing), and an always-on `playbook` it refines over time, so it gets better with use.
- **Remote control from any device** — type `/relay`, scan the QR, and drive Neko from your phone
  anywhere; the agent **dials out** (no open port) over an **end-to-end-encrypted** relay you host.
- **Auto-update** — Neko keeps itself current like Claude Code: a daily startup check installs new
  releases in the background (they apply on the next launch). `auto_update: false` switches to
  notify-only; `neko update` still works manually.

The direction is open-ended: an agent that can do more of your computer's work over time. The extension
model is documented in [`docs/EXTENDING.md`](docs/EXTENDING.md).

## Install

**One line — no Bun required.** Downloads a standalone binary from the latest
[release](https://github.com/meiiie/neko-core/releases):

```bash
# macOS / Linux
curl -fsSL https://neko.holilihu.online/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://neko.holilihu.online/install.ps1 | iex
```

> Fallback if the domain is unreachable: swap the URL for
> `https://raw.githubusercontent.com/meiiie/neko-core/main/install.sh` (and `…/install.ps1`).

**Current release: [v0.10.0](https://github.com/meiiie/neko-core/releases/tag/v0.10.0).**
Every release passes the full gate battery before it is tagged — tests, render + input smokes, a
real-ConPTY e2e, scroll bench, secret scan (`docs/process/RELEASE.md`). **Pin or roll back any time**
(the pin holds — auto-update won't undo it): `neko update 0.9.0`, or at install time
`... | sh -s -- --version 0.9.0` (unix) / `& ([scriptblock]::Create((irm .../install.ps1))) -Version 0.9.0` (Windows).

Then start Neko and use the guided sign-in:

```bash
neko
# /login -> OpenAI -> ChatGPT Plus/Pro  (subscription, no API billing)
#                  -> API key          (pay-as-you-go API)
```

The equivalent non-TUI commands are:

```bash
neko login openai chatgpt
neko login openai api <key>

# Headless/SSH alternative: prints a URL and one-time device code
neko login openai chatgpt --device

neko doctor
```

The ChatGPT profile uses the Codex Responses backend and never falls back to an OpenAI API key. Usage
is governed by the limits and model access of your ChatGPT plan; it does not create API pay-as-you-go
charges. Credentials are refreshed automatically and stored separately in
`~/.neko-core/chatgpt-auth.json` (restricted file permissions where the OS supports them). This
third-party integration may need an update if OpenAI changes its OAuth flow or Codex backend.
`/model` reads the live account-aware Codex catalog. GPT-5.5 and other compatible models keep using Neko's
lightweight direct transport. GPT-5.6 Sol/Terra/Luna use the official local
[Codex App Server](https://developers.openai.com/codex/app-server) protocol
because their Responses-Lite/code-mode route rejects honest third-party HTTP clients. Neko first reuses a
compatible Codex CLI already installed on the machine; the optional GPT-5.6 Support Pack is the standalone
fallback and is not required for GPT-5.5, API-key providers, Ollama, or other local models. App Server runs
hidden, on demand, with an isolated Codex home; Neko's existing OAuth token and approval-gated ToolRegistry
remain authoritative, so there is no second sign-in and no client-identity spoofing. It stops after 15 idle
minutes by default (`codex_keepalive`; `0` keeps it alive until logout/exit). Model metadata also drives
native image input, context size, and `/effort`, so each usable model shows only its supported reasoning
tiers. `/usage` reads the subscription's short/weekly quota windows, reset times, extra model buckets, and
credits without making a model request. `/logout` signs out only the active route, so ChatGPT OAuth and
OpenAI API keys do not erase each other.

When `/model` needs the component, Neko asks before downloading anything. You can also manage it directly:

```bash
neko support status           # reuses an installed Codex CLI when compatible
neko setup codex              # install the optional standalone App Server
neko support update           # verify and replace with the latest stable official release
neko support remove           # remove only Neko's managed pack, never the user's Codex CLI
```

On Windows x64, the tested OpenAI `0.144.1` standalone archive is 92.7 MiB and occupies 270.4 MiB after
installation. It is downloaded from the official `openai/codex` GitHub release, checked against the asset's
published SHA-256, and required to have a valid OpenAI Authenticode signature before Neko activates it.
The base Neko install is unchanged because the pack remains opt-in.

For API-key or local-model providers:

```bash
neko init-user                 # scaffold ~/.neko-core/config.json (API key + profile)
# edit ~/.neko-core/config.json: set api_key + model (or use env NEKO_API_KEY)
neko doctor                    # check provider/model/key
neko                           # start the interactive session  (also: neko code / neko core)
```

Keep it current with `neko update`.

### From source (development) — requires [Bun](https://bun.sh)

```bash
git clone https://github.com/meiiie/neko-core
cd neko-core
bun install
bun run build                  # -> dist/neko  (single standalone executable; no Bun to run it)
bun bin/neko.ts doctor         # or run directly via Bun, no build needed
```

### Commands

`neko` (session, default) · `run <task>` · `config` · `doctor` · `profiles` · `init[-user]` · `tools` ·
`agents` · `commands` · `capabilities` · `policy` · `context` · `sessions` · `mcp` · `login` · `logout` · `update`.

Bare `neko` (or `neko code` / `neko core`) starts the interactive session.
`--profile <name>` selects a runtime profile · `--yolo` auto-approves gated tools ·
`neko --resume` continues the latest session.

## Contributing

Issues and PRs are very welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)**. In short: `bun install`,
make your change, then `bun run typecheck && bun test` must stay green (plus `neko policy` for the
safe/gated boundary). The architecture (Ports & Adapters) is in
[`docs/process/ARCHITECTURE.md`](docs/process/ARCHITECTURE.md); the roadmap and working notes are under
[`docs/process/`](docs/process/). A new model or endpoint is a config **profile**, not code.

## Heritage

Neko Code began as a config-first inference harness for **HackAIthon 2026 — Bảng C** (team Neko Core,
Vietnam Maritime University). The competition entry stays frozen at
[`meiiie/bang_c`](https://github.com/meiiie/bang_c). The original standalone port was written in Python
and is preserved as the **spec/reference** under [`reference/python/`](reference/python/); the shipping
product is this TypeScript build.

## Team

Team **Neko Core** — Vietnam Maritime University (VMU): Nguyễn Mạnh Hùng (lead) · Bùi Việt Hoàng · Phạm
Thị Minh Hồng · Phạm Thị Thu Thảo · Nghiêm Thị Mỹ Linh

## License

MIT © 2026 The Wiii Lab — see [LICENSE](LICENSE).
