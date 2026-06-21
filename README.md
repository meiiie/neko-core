![Neko Core](assets/neko-core-banner.png)

# Neko Core

> A **local-first agentic CLI** — a coding & automation assistant in the spirit of **Claude Code** / **Codex CLI**, but **offline-capable** and **config-first**.

**By [The Wiii Lab](https://github.com/meiiie).**

---

## What it is

One `neko` command: chat with an agent that can **read, edit, run, and search** inside your project — driven by a small open model on your own machine (no API key required), or a hosted model when you want one.

- **Local-first / offline-capable** — run e.g. Qwen3-4B locally; hosted models are opt-in.
- **Config-first** — swap model / provider / policy with an *edit*, not a code change.
- **Safe by default** — destructive tools behind an approval gate; the agent loop has a hard step cap.

See [docs/VISION.md](docs/VISION.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

🌱 **Early scaffold.** The CLI skeleton, the config-first loader, and the module interfaces are in place; the agent loop, providers, and tools are being built next.

## Quick start

```bash
git clone https://github.com/meiiie/neko-core
cd neko-core
pip install -e .

neko --version
neko config        # show the resolved config-first settings
neko chat          # (scaffold) interactive agentic session
```

## Heritage

Neko Core began as a config-first inference harness for **HackAIthon 2026 — Bảng C** (team Neko Core, Vietnam Maritime University). The competition entry stays frozen at [`meiiie/bang_c`](https://github.com/meiiie/bang_c); **this repository is the standalone product** that grows beyond the contest.

## Team

Team **Neko Core** — Vietnam Maritime University (VMU): Nguyễn Mạnh Hùng (lead) · Bùi Việt Hoàng · Phạm Thị Minh Hồng · Phạm Thị Thu Thảo · Nghiêm Thị Mỹ Linh

## License

MIT © 2026 The Wiii Lab — see [LICENSE](LICENSE).
