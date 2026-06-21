# Neko Core — Vision

Neko Core is a **config-first, local-first agentic CLI**, patterned after **Claude Code** /
**Codex CLI** — growing from a config-first LLM-task harness into a full **coding & automation agent**.

## Today

A config-first agentic CLI harness (mature implementation in `meiiie/bang_c`):

- **Config-first** — behaviour is data; swap model / provider / policy with an edit, not a patch.
- **Provider-agnostic & offline-capable** — local GGUF (llama.cpp), a local server, or any
  OpenAI-compatible API.
- **Claude-Code discipline** — explicit `agents / tools / commands / capabilities` registries, a
  runtime/development `--policy` gate, run-sessions + trace review, and a bounded-autonomous `--yolo` mode.

## Where it's going

A local-first **coding & automation agent**: `neko chat` → an agent that reads, edits, runs, and
searches inside your project — **safely** (approval gates on destructive actions) and **cheaply**
(small local models first, hosted models only when needed).

The bridge is real: the harness already has the provider abstraction, config-first system, tool/agent
registries, policy gate, and bounded autonomy. The coding-agent is those tools + the agent loop pointed
at *a codebase* instead of *a question set*.

## Why

- **Local-first / offline-capable** — run a small open model with no API key; hosted is opt-in.
- **Config-first** — behaviour is data, not code.
- **Single, sharp tool** — one `neko` command, explicit contracts, no hidden behaviour.

## Heritage

Neko Core began as a config-first inference harness for HackAIthon 2026 — Bảng C (frozen at
`meiiie/bang_c`). This repository is the standalone product that grows beyond the contest.
See [PORTING.md](PORTING.md) for the heritage → product map.
