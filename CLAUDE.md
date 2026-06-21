# Neko Core — working notes for Claude Code

Neko Core is a **config-first, local-first agentic CLI** (in the spirit of Claude Code /
Codex CLI). The `neko` command drives an agent that reads, searches, edits, and runs
inside a project. Start with `docs/PORTING.md` (roadmap), `docs/DEVELOPER-GUIDE.md`,
and `docs/HARNESS-ARCHITECTURE.md`.

## Codebase map (`src/neko_core/`)

| Module | Role |
|---|---|
| `config.py` | Config-first loader: layered overlay (built-in → `~/.neko-core` → `./.neko-core` → profile → `NEKO_*` env) + named profiles. API key read on demand, never stored/printed. |
| `providers.py` | One `complete(messages, tools)` contract; `openai_compat` (any OpenAI-compatible endpoint) + optional `local_llamacpp`. |
| `tools.py` | Tool contracts (`safe`: read_file/search · `gated`: write_file/bash) + JSON→OpenAI tool schema. |
| `tool_runtime.py` | Executable tools + approval gate; path-taking tools refuse to escape the project root. |
| `registry.py` | Introspection surfaces: agents / commands / capabilities + the `policy` audit of the safe/gated boundary. |
| `agent.py` | The agent loop: `complete → tool_calls → observe`, capped at `max_steps`. |
| `doctor.py` · `project.py` | Read-only diagnostics; `init-user` / `init` config scaffolds. |
| `cli.py` | `neko` entry point (chat, run, config, doctor, profiles, init[-user], tools, agents, commands, capabilities, policy). |

## Critical gotchas

- **`bang_c` is FROZEN.** The mature heritage harness lives in the sibling repo
  `E:\Sach\Sua\bang_c` (`src/hackaithon_c`). **Read it to port; never edit it.** Port
  *out of* it (copy + adapt), and **drop the MCQ/contest cruft** (`rag_*`, `tiered_*`,
  `rubric`, `profiling`, `pred.csv`/exporter). See `docs/PORTING.md` "Hard exclusions".
- **Secrets never get committed or printed.** The API key comes from env
  (`NEKO_API_KEY` / `OPENAI_API_KEY` / `NVIDIA_API_KEY`) or the gitignored
  `~/.neko-core/config.json`. It is never stored in the printable config dict. Run
  `/secret-scan` before any public push.
- **Config-first.** Behaviour lives in config (`DEFAULTS` + profiles + overlays), not
  code. A new model/endpoint is a **profile**, not a code change.
- **Windows console is cp1252.** Keep *printed* strings ASCII — a `—` em-dash mojibakes
  to `�` in the terminal. Docstrings and API payloads may stay UTF-8.
- **Safe-by-default.** `write_file`/`bash` are approval-gated; `--yolo` (`approval=auto`)
  is a *named* bounded-autonomous state, audited by `neko policy`.

## Verify loop (run the smallest relevant check first, then broaden)

```bash
rtk python -m pytest -q                 # 36 unit tests
rtk python -m compileall -q src         # syntax
PYTHONPATH=src python -m neko_core doctor   # resolved provider/model/key (no model call)
PYTHONPATH=src python -m neko_core policy   # safe/gated boundary audit (exit 1 on FAIL)
```

(Prefix shell commands with `rtk` per the global RTK rule.)
