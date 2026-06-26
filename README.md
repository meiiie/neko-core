![Neko Core](assets/neko-core-banner.png)

# Neko Code

> A **local-first terminal coding agent** in the spirit of **Claude Code** / **Codex CLI** —
> built on **TypeScript + Bun + Ink**, **provider-agnostic**, and **offline-capable**.
> Engine: **Neko Core**.

**By [The Wiii Lab](https://github.com/meiiie).** MIT-licensed — contributions welcome.

---

## What it is

Neko Code drives an agent that **reads, searches, edits, and runs** inside your project, from the
terminal. It is **config-first** (model / provider / policy live in config, not code) and talks to
**any OpenAI-compatible endpoint** — a hosted API (NVIDIA NIM, OpenAI, …) or a **local server**
(llama.cpp `llama-server`, Ollama), so it works offline.

**Core**
- **Streaming agent loop** — `complete → tool-calls → observe`, capped by `max_steps`, with live token
  streaming, read-only tool fan-out (parallel), a stuck-loop guard, and auto-compaction.
- **Tools** — `read_file` · `search` · `glob` · `ls` (safe) and `write_file` · `edit` · `multi_edit` ·
  `bash` (approval-gated). `search` uses ripgrep when present; `bash` takes a per-call timeout + can run
  in the background; `read_file` pages large files and reads **images/PDFs**. Path-escape is refused.
- **Permission modes** — `default` / `accept-edits` / `plan` / `auto`, cycled with **Shift+Tab** (a
  *named* bounded-autonomy state, audited by `neko policy`); a seatbelt blocks catastrophic shell.
- **Ink TUI** — streaming chat with slash commands, history, multiline, `/rewind`.
- **Sessions** — conversations persist; resume with `neko --resume`.
- **MCP** — connect Model Context Protocol servers (stdio / http / sse + OAuth) and use their tools;
  lazy schema loading keeps a big MCP surface out of context until needed.

**What makes it interesting**
- 📱 **Remote control from any device** — type `/relay`, scan the QR with your phone, and drive Neko from
  anywhere. The agent **dials out** (no open port, works behind any NAT) and the link is **end-to-end
  encrypted** through a relay you host yourself — so even the relay can't read your messages.
- 🧠 **Self-improving memory** — durable facts (`memory`), authored `skills`, learned `workflows`
  (procedures it distills by doing), and an always-on `playbook` (ACE) it refines over time.
- 🧩 **Skills** — pluggable domain expertise with progressive disclosure (e.g. a purchasing/procurement
  skill, a browser visual-QA skill) — stay general, go deep on demand.
- 🖼️ **Browser + vision** — drive a page over MCP, screenshot it, and read those images back to verify a
  UI frame by frame (with a vision model).
- ⬆️ **Self-update** — `neko update` pulls the latest release and swaps itself in place.

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
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the roadmap + working notes are under
[`docs/process/`](docs/process/).

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
