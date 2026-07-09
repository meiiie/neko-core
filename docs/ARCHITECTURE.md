# Neko Core — Architecture (historical scaffold)

> This file describes the original Python-era target and is retained for history only.
> The shipped TypeScript architecture is documented in [`process/ARCHITECTURE.md`](process/ARCHITECTURE.md).

Early scaffold. This document is the design the codebase is growing toward.

```
neko (CLI)  ──▶  Agent loop  ──▶  Provider.complete(messages, tools)
                    │                  ├─ local_llamacpp  (offline, GGUF)  ← default
                    │                  └─ openai_compat   (hosted, opt-in)
                    └──▶  ToolRegistry  ── bash · read_file · write_file · search
                                          (destructive tools behind an approval gate)

config-first overlay:
  defaults  <  ~/.neko-core/config.json  <  ./.neko-core/config.json  <  NEKO_* env
```

## Modules

| File | Role | Status |
|---|---|---|
| `cli.py` | `neko` entry — `chat` / `run` / `config` | scaffold (runnable) |
| `config.py` | config-first overlay loader | working |
| `agent.py` | the agentic loop (step → tools → observe) | skeleton |
| `providers.py` | `complete()` contract; local + hosted | interface only |
| `tools.py` | tool registry + specs | skeleton |

## Principles (carried from the Neko Core harness)

1. **Config-first** — behaviour is data, swappable without code changes.
2. **Provider-agnostic** — the core never imports a vendor SDK; providers are pluggable.
3. **Safe by default** — destructive tools gated; the loop has a hard `max_steps` cap.
4. **Offline-first** — works with a local model and no network; hosted is opt-in.

## Build order (suggested for the next session)

1. `providers.local_llamacpp` — a working `complete()` against a local GGUF.
2. `tools` — `read_file`, `search` (safe), then `write_file`, `bash` (gated).
3. `agent.run()` — wire the loop: complete → tool-calls → observe → repeat.
4. `cli chat` — a REPL around `agent.run()` with streaming output.
5. Approval policy + context management + tests.
