# Neko Code — Roadmap to "Claude-Code level"

> **Goal:** evolve the Neko Core engine into **Neko Code**, a terminal coding agent in the
> class of Claude Code / Codex CLI. This file is the target the work loops over; tick
> milestones as they land (each must be verified + committed).

## Naming
- **Neko Code** = the product / CLI experience (the Claude-Code analog).
- **Neko Core** = the engine/library at the heart of it (package `neko-core`, `src/`).
- The command stays `neko`. Full doc/brand rename is the last milestone (avoid churn now).

## IP / legal boundary (non-negotiable)
The local `claude-code` tree is studied **only as a reference for patterns/architecture/UX**.
We **reimplement clean (clean-room) in our own code** and **never copy Anthropic's
proprietary source** into this public repo. Learn ideas ✅, copy code ❌.

## Architecture map we're matching (clean-room, from the reference's shape + known patterns)
entrypoint (Ink TUI) · query engine (agent loop, streaming) · Tool abstraction + tool set ·
tasks/todos · context & history (persist/resume) · slash commands · permission modes ·
cost/token tracking · MCP client · single-binary distribution.

## Milestones

### Phase A — Agentic core
- [x] **A0** TS Step 1: config-first + `openai_compat` provider + doctor + CLI skeleton. *(done)*
- [x] **A1** Tools + registry + policy (read_file/search safe, write_file/bash gated; OpenAI schema). *(done — typecheck clean; `neko tools/agents/commands/capabilities/policy` work; tool runtime smoke: read/search/write/bash, path-escape refused, denial returns a string, safe-under-deny)*
- [x] **A2** Agent loop + `neko run` (complete → tool_calls → observe, `max_steps`; interactive approval + `--yolo`). *(done — typecheck clean; live `neko run --yolo` on NVIDIA called read_file and answered correctly)*
- [x] **A3** Real coding tool set: `edit` (exact unique string replace, gated), `glob` (Bun.Glob), `ls` (safe); `search` is the scoped grep. *(done — typecheck clean, policy PASS; smoke: edit unique/not-found/ambiguous, glob, ls)*
- [x] **A4** Streaming responses (SSE) + token tracking (`src/cost.ts`; per-call usage accumulated). *(done — live `neko run` streams tokens via SSE and prints `tokens: in/out/total`. $-cost left to a future per-model price config.)*

### Phase B — UX (the Ink TUI = "Neko Code")
- [x] **B1** Ink chat REPL (`src/ui/chat.tsx`): streaming render, interleaved tool-call lines, inline approval prompt (y/a/n), thinking spinner, one Agent across turns, `/reset`/`/exit`. *(typecheck clean; module imports under Bun; non-TTY guard degrades to a hint. Full interactive render pending the owner's terminal.)*
- [x] **B2** Slash commands (`/help` `/cost` `/model` `/profiles` `/init` `/clear` `/reset` `/exit`), input history (↑/↓), multiline (trailing `\` continuation). *(typecheck clean; module imports under Bun)*
- [x] **B3** Permission modes (`src/permissions.ts`): default / accept-edits / plan / auto; Shift+Tab cycles in chat; surfaced in doctor/capabilities/policy; `NEKO_MODE` override. *(verified: plan denies writes, accept-edits auto-approves edits but prompts bash, auto allows all; typecheck clean)*

### Phase C — Project intelligence
- [x] **C1** Project context (`src/context.ts`): loads `NEKO.md` / `CLAUDE.md` from cwd up to the repo root + `~/.neko-core/NEKO.md`, additive, capped; prepended to the system prompt. `neko context` lists them. *(verified: finds repo CLAUDE.md, walks up from nested dirs; typecheck clean)*
- [x] **C2** Conversation persistence (`src/session.ts`): chat saves after each turn to `~/.neko-core/sessions/` (keyed by cwd); `neko chat --resume` reloads the latest for this dir; `neko sessions` lists them. *(verified: save/load/latest/list round-trip; typecheck clean)*
- [x] **C3** MCP client (`src/mcp.ts`): connects to stdio MCP servers from config (`mcp_servers`), exposes their tools as `mcp__<server>__<tool>` (gated by permission mode), `neko mcp` lists them. Safe by default (no servers = no-op). *(verified LIVE against a local echo MCP server: connect/list/call round-trip; typecheck clean)*

### Phase D — Polish & distribution
- [x] **D1** `bun test` suite — 44 tests across config, providers, permissions, tools, runtime, registry, agent, context, session. *(all pass; typecheck clean)*
- [x] **D2** `bun build --compile` single binary (`dist/neko`, react-devtools-core bundled for Ink); re-pointed the `neko` command from the pipx(Python) install to the TS binary in `~/.local/bin`. *(verified: `which neko` → the binary; live `neko run` called a tool)*
- [x] **D3** Renamed to **Neko Code** (README + CLAUDE.md refreshed for the TS product; engine stays "Neko Core"); secret-scan + merge to `main` + push (owner-approved).

## Loop rules
- One milestone per iteration: implement → verify (typecheck + `bun test` + run) → commit → tick here + note in `WORKLOG.md`.
- Solo, no subagents. Config-first, safe-by-default, printed strings ASCII.
- Stop the loop and ask the owner when: a milestone needs a product/architecture decision,
  a live action would spend real money beyond a tiny smoke call, or anything outward-facing
  (push to public / publish) is required.

## Post-1.0 — UX/UI parity pass (clean-room vs claude-code)
- [x] **E1** Ink UX overhaul: welcome box, bordered input box, **markdown rendering** of
  assistant output (`src/ui/markdown.tsx`), `*`/indented tool-call lines, spinner + elapsed
  status, **Esc-to-interrupt** (AbortSignal through provider+agent), and a bordered approval
  box with an **edit/write diff preview**. ASCII-safe (classic borders, line spinner) for any
  Windows console. *(typecheck + 45 tests incl. headless Markdown render; binary rebuilt)*
- [x] **E4** Syntax-highlighted code blocks (`src/ui/highlight.tsx`; tokenized Ink Text segments, not raw ANSI).
- [x] **E5** Markdown tables (aligned columns) in the renderer.
- [x] **E6** Input queue while busy (type-ahead, drained after each turn) + render of non-streaming finals.

## Phase F — SOTA refinement (research-grade quality -> product) [June 2026]
> Direction (owner): lean **research-grade SOTA** (memory - planning - multi-agent, latest techniques)
> as the engine that *drives* product polish — a "tinh hoa" architecture prepared to ship for real.
> Keep the harness thin (the model does planning/decomposition); invest in prompt/skills/memory + the
> daily-use experience. Dogfood: Neko improves its own repo.

- [x] **F0** Distribution at Codex/Claude-Code grade: CI builds 5-OS standalone binaries -> GitHub
  Releases; `install.sh`/`install.ps1` one-line install; branded domain `neko.holilihu.online`
  (Cloudflare Worker -> neko-core); CI green. Default model `openai/gpt-oss-120b` after a multi-trial
  Neko-bench (pass@1 97% / pass^3 92%, vs nemotron 72%/38%). *(verified: released binary runs end-to-end)*
- [x] **F1** Bugs found via cross-model benchmarking + fixed: two `system` messages broke Llama/Mistral
  tool-calling (-> one system message); `reasoning_effort` self-heal; non-interactive approval
  fail-closed; shared `homeDir()` for Linux CI. *(committed; tests green)*
- [x] **F2** Command result-awareness (Claude-Code-style): bash marks failures `(exit N -- FAILED)` and
  the prompt mandates read-result -> on failure diagnose + fix + re-run. *(verified 3/3 self-correction)*
- [x] **F3** Navigable slash-command menu: Up/Down select, Tab completes (was: arrows rewound the
  half-typed command via history). *(regression test added)*
- [ ] **F4** Remote-control stability pass (`/remote` / `/rc` logic + lifecycle).
- [ ] **F5** Pixel-level UX polish: streamed-output presentation, markdown spacing/color, diff &
  tool-call rendering, thinking display, streaming cadence — side-by-side vs Claude Code.
- [ ] **F6** Naturalness: system-prompt tone/conciseness shaping; smoother tool-call narration.
- [ ] **F7** SOTA memory - planning - multi-agent, latest techniques (kept thin/disposable).
- [ ] **F8** `neko bench` — productize the Neko-bench harness (run + compare models).
