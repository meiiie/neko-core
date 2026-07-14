# Neko Core — Claude-Code parity backlog

Continuous goal: keep closing the gap to Claude Code, clean-room (study patterns, never copy),
karpathy + ponytail. Tick as shipped (each verified + committed).

- [x] **P1** read_file line numbers (cat -n style) + system-prompt note
- [x] **P2** @file mentions in chat (expand @path to file context)
- [x] **P3** todo system: `todo_write` tool + checklist rendering (signature Claude feature)
- [x] **P4** edit/write diff shown in the transcript (colored, multi-line)
- [x] **P5** /compact — summarize the conversation to free context
- [x] **P6** streaming markdown (render formatted as it streams)
- [x] **P7** context-left indicator in the status bar
- [x] **P8** (Ctrl-C twice; Ctrl-O skipped) Ctrl-C twice to exit; Ctrl-O to expand a truncated tool result
- [~] **P9** (skipped — the model can call edit repeatedly; YAGNI) multiedit (several edits in one call)
- [x] **P10** richer system prompt / tool descriptions (closer to Claude's)
- [x] **P11** agent-managed **memory tool** (SOTA 2026): `memory` (list/read/write/delete/search) over
      `~/.neko-core/memory/*.md`, index injected each turn for JIT recall across sessions. File-based
      like Anthropic's memory tool — no vector DB (needs embeddings; over-engineering for a local CLI).
      Verified: agent writes a memory in one session, recalls it in a fresh process.

## SOTA tier (June 2026) — where Neko stands
- **Lifecycle**: SOTA-class — sessions, resume-with-replay, checkpoints/rewind, sticky model/effort.
- **Context**: SOTA-aligned — compaction (keep-tail + clip + summary), todo-persist, JIT via glob/grep,
  auto-compact, sub-agents ("context is precious" + just-in-time retrieval).
- **Memory**: SOTA-tier via P11 (agent-managed file memory + JIT recall). Deliberately NOT building
  vector-DB retrieval / "dreaming" — those need an embedding model/API and contradict the local
  single-binary identity; the file+grep design is Anthropic's own memory-tool approach.
