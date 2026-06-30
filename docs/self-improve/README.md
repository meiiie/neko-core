# Neko self-improvement brain

This folder is Neko's **self-knowledge**: what it is, what it's doing, where it's going, what the harness is,
and what to try next. The continuous loop (`scripts/self-improve.ts`) and any agent working on Neko should
**read this folder first** to orient, and **update it** as work happens — so progress is never lost and the
loop never works blind.

It complements (does not replace) `docs/process/` (ROADMAP/WORKLOG/RULES/ARCHITECTURE) — that's the human
project log; this is the *self-improvement* brain.

| File | Purpose | Who updates it |
|---|---|---|
| [STATE.md](STATE.md) | Current focus + what's done + how to measure (the "where am I now"). | the loop, after each cycle |
| [BACKLOG.md](BACKLOG.md) | Concrete, verifiable improvement ideas — the loop's GOAL QUEUE. | the loop (adds) + research passes |
| [RESEARCH.md](RESEARCH.md) | SOTA techniques + papers + how each applies to Neko. The grounding. | research passes (when stuck) |
| [HARNESS.md](HARNESS.md) | How Neko's harness works + the levers to improve it. | when the harness changes |

## The loop, in one picture
```
read STATE + BACKLOG  ->  pick a goal  ->  Neko works (verified)  ->  commit if green, else revert
        ^                                                                      |
        |                                  if stuck (no improvement for a few rounds):
        +----  update STATE/BACKLOG  <---  RESEARCH pass: web_search SOTA + new papers -> new ideas
```

## North star (the standard to beat)
- **Darwin Gödel Machine** (ICLR 2026): an agent that edits its own code and validates each change against a
  benchmark, growing an archive of improved versions. SWE-bench 20%→50%. That's the bar for *open-ended*
  self-improvement; our loop is the verified, single-branch, human-gated version of it.
- Improve along EVERY axis, measured: **token efficiency · speed · accuracy/pass-rate · robustness · security ·
  harness capability**. The bench dev-log (`~/.neko-core/bench-log.jsonl`) makes each one a number to move.
