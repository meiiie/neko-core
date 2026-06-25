![Neko Core](assets/neko-core-banner.png)

# Neko Code

> A **local-first terminal coding agent** in the spirit of **Claude Code** / **Codex CLI** —
> built on **TypeScript + Bun + Ink**, **provider-agnostic**, and **offline-capable**.
> Engine: **Neko Core**.

**By [The Wiii Lab](https://github.com/meiiie).**

---

## What it is

Neko Code drives an agent that **reads, searches, edits, and runs** inside your project, from
the terminal. It is **config-first** (model / provider / policy live in config, not code) and
talks to **any OpenAI-compatible endpoint** — a hosted API (NVIDIA NIM, OpenAI, …) or a **local
server** (llama.cpp `llama-server`, Ollama), so it works offline.

- **Streaming agent loop** — `complete → tool-calls → observe`, capped by `max_steps`, with live
  token streaming and usage tracking.
- **Tools** — `read_file` · `search` · `glob` · `ls` (safe) and `write_file` · `edit` · `bash`
  (approval-gated). Path-taking tools refuse to escape the project root.
- **Permission modes** — `default` / `accept-edits` / `plan` / `auto`, cycled with **Shift+Tab**
  (a *named* bounded-autonomy state, audited by `neko policy`).
- **Ink TUI** — streaming chat with slash commands (`/help`, `/cost`, `/model`, …), input
  history, and multiline.
- **Project context** — auto-loads `NEKO.md` / `CLAUDE.md` into the system prompt.
- **Sessions** — conversations persist; resume with `neko chat --resume`.
- **MCP** — connect Model Context Protocol servers and use their tools (`neko mcp`).

## Install

**One line — no Bun required.** Downloads a standalone binary from the latest
[release](https://github.com/meiiie/neko-core/releases):

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/meiiie/neko-core/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/meiiie/neko-core/main/install.ps1 | iex
```

Then set up your key and go:

```bash
neko init-user                 # scaffold ~/.neko-core/config.json (API key + profile)
# edit ~/.neko-core/config.json: set api_key + model (or use env NEKO_API_KEY)
neko doctor                    # check provider/model/key
neko                           # start the interactive session  (also: neko code / neko core)
```

### From source (development) — requires [Bun](https://bun.sh)

```bash
git clone https://github.com/meiiie/neko-core
cd neko-core
bun install
bun run build                  # -> dist/neko  (single standalone executable; no Bun to run it)
bun bin/neko.ts doctor         # or run directly via Bun, no build needed
```

### Commands

`neko` (session, default) · `run <task>` · `config` · `doctor` · `profiles` · `init[-user]` ·
`tools` · `agents` · `commands` · `capabilities` · `policy` · `context` · `sessions` · `mcp`.

Bare `neko` (or `neko code` / `neko core`) starts the interactive session.
`--profile <name>` selects a runtime profile · `--yolo` auto-approves gated tools ·
`neko --resume` continues the latest session.

## Heritage

Neko Code began as a config-first inference harness for **HackAIthon 2026 — Bảng C** (team Neko
Core, Vietnam Maritime University). The competition entry stays frozen at
[`meiiie/bang_c`](https://github.com/meiiie/bang_c). The original standalone port was written in
Python and is preserved as the **spec/reference** under [`reference/python/`](reference/python/);
the shipping product is this TypeScript build.

## Team

Team **Neko Core** — Vietnam Maritime University (VMU): Nguyễn Mạnh Hùng (lead) · Bùi Việt Hoàng ·
Phạm Thị Minh Hồng · Phạm Thị Thu Thảo · Nghiêm Thị Mỹ Linh

## License

MIT © 2026 The Wiii Lab — see [LICENSE](LICENSE).
