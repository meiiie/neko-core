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
- [ ] **A4** Streaming responses (SSE) + token/cost tracking (per turn + session total).

### Phase B — UX (the Ink TUI = "Neko Code")
- [ ] **B1** Ink chat REPL: streaming render, tool-call/diff display, approval prompts (yes / yes-always / no), spinner, markdown.
- [ ] **B2** Slash commands (`/help`, `/clear`, `/model`, `/init`, `/cost`, `/exit`), input history, multiline.
- [ ] **B3** Permission modes (default / accept-edits / plan / yolo) cycled like Claude Code; surfaced in `neko policy`.

### Phase C — Project intelligence
- [ ] **C1** Project context: load `NEKO.md` / `CLAUDE.md` (+ subdir, additive) into the system prompt.
- [ ] **C2** Conversation persistence + `neko --resume` / sessions (history on disk).
- [ ] **C3** MCP client: connect to MCP servers (`@modelcontextprotocol/sdk`) and expose their tools to the loop.

### Phase D — Polish & distribution
- [ ] **D1** Full `bun test` suite parity with the Python reference + new features.
- [ ] **D2** `bun build --compile` single binary; install script; re-point the `neko` command from the pipx(Python) install to the TS binary.
- [ ] **D3** Rename pass to **Neko Code** (banner/help/README/CLAUDE.md); merge to `main` (after `/secret-scan` + owner sign-off).

## Loop rules
- One milestone per iteration: implement → verify (typecheck + `bun test` + run) → commit → tick here + note in `WORKLOG.md`.
- Solo, no subagents. Config-first, safe-by-default, printed strings ASCII.
- Stop the loop and ask the owner when: a milestone needs a product/architecture decision,
  a live action would spend real money beyond a tiny smoke call, or anything outward-facing
  (push to public / publish) is required.
