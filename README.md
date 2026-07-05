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
  `bash` (approval-gated). `search` uses ripgrep when present; `bash` takes a per-call timeout and can run
  in the background; `read_file` pages large files and reads images/PDFs. Path-escape is refused.
- **Permission modes** — `default` / `accept-edits` / `plan` / `auto`, cycled with **Shift+Tab** (a
  *named* bounded-autonomy state, audited by `neko policy`); a seatbelt blocks catastrophic shell.
- **Fullscreen terminal UI** — an app-owned, flicker-free viewport (alt-screen, like vim/htop):
  markdown renders live *as it streams*, scrolling is hardware-smooth at your display's refresh rate
  (auto-detected; `/fps`), the mouse wheel scrolls, drag selects + copies (or `Ctrl+C` / `/copy`),
  `Ctrl+F` finds in the transcript, and the tab title tracks your session (a pulsing dot while it
  works). Exit leaves your shell exactly as it was — plus a one-line resume hint.
- **Sessions** — conversations persist; resume with `neko --resume`.
- **MCP** — connect Model Context Protocol servers (stdio / http / sse + OAuth) and use their tools;
  lazy schema loading keeps a big MCP surface out of context until needed.

### Extensible by design — not just a coding tool

Neko is built to take on new roles, one skill and one tool at a time:

- **Skills** — pluggable domain expertise with progressive disclosure. One is a *purchasing officer*
  (research, source, and plan a purchase across Vietnamese retailers — humans approve and buy); another
  drives a browser and reads screenshots back with vision to verify a UI frame by frame. A skill is a
  markdown file, not a fork.
- **Self-improving memory** — durable facts (`memory`), learned `workflows` (procedures it distills by
  doing), and an always-on `playbook` it refines over time, so it gets better with use.
- **Remote control from any device** — type `/relay`, scan the QR, and drive Neko from your phone
  anywhere; the agent **dials out** (no open port) over an **end-to-end-encrypted** relay you host.
- **Self-update** — `neko update` pulls the latest release and swaps itself in place.

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

Then set up your key and go:

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
`agents` · `commands` · `capabilities` · `policy` · `context` · `sessions` · `mcp` · `update`.

Bare `neko` (or `neko code` / `neko core`) starts the interactive session.
`--profile <name>` selects a runtime profile · `--yolo` auto-approves gated tools ·
`neko --resume` continues the latest session.

## Contributing

Issues and PRs are very welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)**. In short: `bun install`,
make your change, then `bun run typecheck && bun test` must stay green (plus `neko policy` for the
safe/gated boundary). The architecture (Ports & Adapters) is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the roadmap and working notes are under
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
