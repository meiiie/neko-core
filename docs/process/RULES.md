# Neko Core — Working Rules

Conventions for anyone (human or AI) developing Neko Core. Complements the lean
`CLAUDE.md`; this file is the fuller "how we work" record. See `WORKLOG.md` for the
running journal of what was done and why.

## Process
- **Solo, no subagents.** Do the work directly and proactively — do **not** delegate to
  subagents or background workflows. (Owner, 2026-06-22.)
- **Run + commit incrementally.** One logical change per commit, a clear message, and
  verify *before* committing.
- **Ask before large architecture decisions.** Surface the tradeoffs; never pick silently
  (e.g. the language/runtime choice). The owner decides.
- **Karpathy guidelines:** think before coding (state assumptions, surface tradeoffs);
  simplest code that solves it; surgical changes (touch only what's needed); goal-driven
  (define success, verify by running).

## Product & code
- **Config-first.** Behaviour lives in config (`DEFAULTS` + profiles + overlays), not code.
  A new model/endpoint is a profile, not a code change.
- **Provider-agnostic, safe-by-default.** `write_file`/`bash` are approval-gated; `--yolo`
  (`approval=auto`) is a *named* bounded-autonomous state, audited by `neko policy`.
- **`bang_c` is FROZEN.** Read it to port; never edit it. Drop MCQ/contest cruft
  (`rag_*`, `tiered_*`, `rubric`, `profiling`, `pred.csv`).

## Architecture (see `ARCHITECTURE.md`)
- **Ports & Adapters, dependencies point inward.** Core (`agent`, `tools`, `tool-runtime`,
  `permissions`, `cost`, `registry`) depends only on *interfaces* (`Provider`, `ToolRegistry`,
  `ApprovalGate`) — **never** on `ui/` or a UI framework. Enforced by `test/architecture.test.ts`.
- **Adapters at the edge.** Anything that touches the outside world (HTTP, MCP, disk, config)
  is an adapter; swap a backend by adding an adapter, not by editing the core.
- **Extend by the seams.** New tool → `tools.ts` + `tool-runtime.ts`. New backend → a profile
  (config) or a new `Provider`. New command → a `case` in `chat.tsx`. New skill → a `.md` file.

## Code laws
- **Clean code, lazy by default (ponytail).** Stop at the first rung that works; no
  speculative abstraction, no config for a constant, no interface with one impl. Deletion
  over addition. Shortest working diff wins.
- **One responsibility per module; small files.** If a file does two jobs, split it. Match the
  surrounding style; don't reformat untouched code.
- **TypeScript stays strict** (`tsc --noEmit` clean — no `any` leaks at boundaries, no `// @ts-ignore`
  without a reason).
- **Validate at trust boundaries; never swallow data-loss errors.** Tool args, config JSON, API
  responses, and path-escapes are checked; secrets are read on demand, never stored/printed.
- **One runnable check per non-trivial logic** (a branch, loop, parser, money/security/abort
  path). Trivial one-liners need none.

## Safety
- **Secrets never committed or printed.** Key via env (`NEKO_API_KEY` / `OPENAI_API_KEY` /
  `NVIDIA_API_KEY`) or the gitignored `~/.neko-core/config.json`. Run `/secret-scan` before
  any public push; push public only with owner sign-off.
- **Windows console is cp1252.** Keep *printed* strings ASCII (an em-dash mojibakes to `?`).

## Tooling
- Prefix shell commands with `rtk` (the token-saving wrapper).
- Verify loop (before every commit): `bun run typecheck` · `bun test` · `bun bin/neko.ts doctor`
  · `bun bin/neko.ts policy` · `bun run build`.
