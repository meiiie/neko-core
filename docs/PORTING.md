# Neko Core — Porting & Roadmap

> Read this first if you're picking up Neko Core development. It maps **what already
> exists** (the mature harness, in `meiiie/bang_c`) onto **what this repo should become**
> (the standalone product), and the path toward the **coding-agent** vision.

## The honest current state

Neko Core's **mature implementation already exists** — but it lives in the competition
repo `meiiie/bang_c` as the package `src/hackaithon_c/`. It is a real, Claude-Code-patterned
**config-first agentic CLI harness**, fully documented here:

- **[DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md)** — the comprehensive dev guide (quickstart, config-first,
  providers, workflows/strategies, the agentic registries, extension, dev process). *Read this.*
- **[HARNESS-ARCHITECTURE.md](HARNESS-ARCHITECTURE.md)** — module-by-module architecture + the
  Claude-Code-style surfaces (`--doctor/--agents/--tools/--commands/--capabilities/--policy/--yolo`,
  run-sessions, trace review, resume).

**This repo (`meiiie/neko-core`)** currently holds only a **minimal fresh scaffold**
(`src/neko_core/`: a runnable `neko` CLI shell + config-first loader + skeleton agent/providers/tools).
It is the clean vessel; the rich content above is what to port + evolve into it.

> ⚠️ Do **not** modify `bang_c` — it is the frozen HackAIthon submission. Port *out of* it (copy),
> never refactor it in place.

## What Neko Core IS vs is BECOMING

- **Today (in bang_c):** a config-first **LLM-task** agentic CLI — `input → classify → prompt →
  solve(strategy) → normalize → validate → export`, provider-agnostic (local GGUF / llama-server /
  any OpenAI-compatible API), with explicit agents/tools/commands/capabilities registries and a
  runtime/development policy gate. Discipline borrowed from Claude Code / Codex / Goose.
- **Vision (this repo's north star):** evolve that foundation into a **local-first coding & automation
  agent** in the spirit of **Claude Code / Codex CLI** — `neko chat` driving an agent that can read,
  edit, run, and search inside a project, safely (approval gates) and cheaply (small local models first).

The bridge is real: the harness *already* has the provider abstraction, config-first system, tool/agent
registries, policy gate, and a bounded-autonomous `--yolo` mode. The coding-agent is the harness's tools
+ loop pointed at *a codebase* instead of *a question set*.

## Port map (bang_c `src/hackaithon_c/` → this repo `src/neko_core/`)

| Heritage module(s) | Port? | Notes |
|---|---|---|
| `config.py` + `project.py` + layered `~/.neko-core` / `./.neko-core` | ✅ **core** | the config-first DNA — keep, this repo's `config.py` is a thin start |
| `model_client.py` + `local_client.py` + `nvidia_client.py` | ✅ **core** | provider abstraction → this repo's `providers.py`; **strip any keys, keep key-via-env/JSON** |
| `tool_registry.py` + `tool_runtime.py` | ✅ **core** | tool contracts/guardrails → this repo's `tools.py` |
| `command_registry.py` + `capabilities.py` + `agents.py` + `policy.py` + `doctor.py` | ✅ **core** | the Claude-Code-style introspection surfaces (`--commands/--capabilities/--agents/--policy/--doctor`) |
| `run.py` (CLI entry) | ✅ adapt | becomes this repo's `cli.py` (`neko`), trimmed of contest argparse |
| `branding.py` + `assets/neko-core-banner.png` | ✅ | identity (banner already copied here) |
| `loader.py` `schema.py` `classifier.py` `prompting.py` `solver.py` `normalize.py` `calibration.py` | ⚪ optional | the **MCQ-solving** path — keep as one optional `mcq` workflow, or drop; not core to the coding-agent |
| `exporter.py` `checkpoint.py` `manifest.py` `evaluation.py` `review.py` `risk.py` `compare.py` | ⚪ optional | contest artifact/trace tooling — port the genuinely-reusable bits (checkpoint, manifest), drop contest scoring |
| `install.sh` / `install.ps1` / `neko.ps1` | ✅ adapt | the one-line install + `neko` launcher (point URLs at this repo, not bang_c) |

### Hard exclusions (never copy into this public repo)
- Secrets: `.env*`, any API key, `~/.neko-core/config.json` with keys.
- Codex off-limits: `scripts/finetune/*`, `data/finetune/*`, `notes/training-2026-06-17/*`, `tests/test_finetune_*`.
- Scratch: `run-*/`, `output-*/`, `traces-*/`, `task-runs*/`, `eval-runs/`, `models/`, `*.gguf`.
- Competition-only docs (method-writeup, evaluation-rubric, submission-readiness, runpod-*, the `.pptx`).

## Suggested build order (next session)

1. **Port the config-first core + provider abstraction** (`config.py`, `providers.py`) — get
   `neko config` / `neko --doctor` working against a real provider (start with `openai_compat`, no model download).
2. **Port the registries + policy** (`tools`, `commands`, `capabilities`, `agents`, `--policy`) — the
   Claude-Code-style introspection surfaces. This is the project's identity.
3. **Build the coding-agent tools** — `read_file`, `search` (safe) then `write_file`, `bash` (approval-gated).
4. **Wire the agent loop** (`agent.run()`): complete → tool-calls → observe → repeat, with `max_steps`.
5. **`neko chat` REPL** with streaming; carry over `--yolo` as the bounded-autonomous mode.
6. Tests + the `mcq` workflow as an optional showcase of the heritage path.

Throughout: **config-first, provider-agnostic, safe-by-default, offline-first** (DEVELOPER-GUIDE §10).
Run + commit incrementally. Ask the owner before large architecture decisions.
