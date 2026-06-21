![Neko Core](assets/neko-core-banner.png)

# Neko Core

> A **config-first, local-first agentic CLI**, Claude-Code-patterned — growing into a coding & automation agent in the spirit of **Claude Code** / **Codex CLI**, but **offline-capable**.

**By [The Wiii Lab](https://github.com/meiiie).**

---

## What it is

Neko Core is a **config-first agentic CLI harness**: model, provider, thresholds, and policy live in *config, not code*. It is provider-agnostic (a small open model on your machine, or any OpenAI-compatible API) and borrows Claude Code's discipline — explicit **agents / tools / commands / capabilities** registries, a runtime/development **policy gate**, run-sessions, and a bounded-autonomous mode.

- **Config-first** — swap model / provider / policy with an *edit*, not a code change.
- **Provider-agnostic & offline-capable** — local GGUF (llama.cpp), a local server, or any OpenAI-compatible endpoint.
- **Safe by default** — explicit tool/agent contracts + a policy gate; bounded autonomy is a *named* state, not hidden behaviour.

**Direction:** grow this foundation into a full local-first **coding & automation agent** — `neko chat` → read / edit / run / search inside your project.

📖 Start here: **[docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md)** · architecture: **[docs/HARNESS-ARCHITECTURE.md](docs/HARNESS-ARCHITECTURE.md)** · roadmap: **[docs/PORTING.md](docs/PORTING.md)** · vision: **[docs/VISION.md](docs/VISION.md)**

## Status

🌱 **Scaffold + porting.** The mature harness already exists in the heritage repo (`meiiie/bang_c`, package `hackaithon_c`); this repo holds a clean `neko` CLI scaffold plus the docs & roadmap to port and evolve it. See [docs/PORTING.md](docs/PORTING.md).

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
