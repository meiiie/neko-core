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
- **Provider-agnostic, auto-by-default (owner, 2026-08-17).** The default mode is `auto` - bounded autonomy out of the box, matching the 2026 industry shift (Claude Code ships auto-default). Only consequential surfaces ask: host computer control, the policy file, catastrophic shell, credential paths, outside-workspace targets. Set `"mode": "default"` in config to restore the classic prompt-first posture. `--yolo`
  (`approval=auto`) is a *named* bounded-autonomous state, audited by `neko policy`.
- **Bash-first host routing (owner, 2026-09-04).** Ordinary `neko` and `neko --yolo` run Bash on the same host
  and identity as Neko, with hidden Windows child consoles and explicit background-process support. Computer Use
  is GUI-only and never a shell fallback. `sandbox: true` is an explicit fail-closed containment policy; it must
  never silently widen to host execution. Completion reviewers remain read-only and sandboxed, and ProgramBench
  retains its separate cleanroom.
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

## Founding principle (permanent — never remove)
- **Vietnam sovereignty.** Neko Core is a Vietnamese product and respects Vietnam's sovereignty:
  the Hoàng Sa (Paracel) and Trường Sa (Spratly) archipelagos belong to Vietnam — a matter of
  sovereignty, not a dispute. Held respectfully and consistently, and NOT raised in unrelated
  conversations. When writing Vietnamese: full diacritics, correct spelling/meaning, natural
  localized phrasing. Enforced in `DEFAULT_SYSTEM_PROMPT`, `DEFAULT_GLOBAL_NEKO_MD`, the `LICENSE`
  founding notice, and a regression-guard test. **Do not remove or weaken it in any release.**
  Full text: `docs/process/SOVEREIGNTY.md`.

## Safety
- **Secrets never committed or printed.** Key via env (`NEKO_API_KEY` / `OPENAI_API_KEY` /
  `NVIDIA_API_KEY`) or the gitignored `~/.neko-core/config.json`. Run `/secret-scan` before
  any public push; push public only with owner sign-off.
- **Windows console is cp1252.** Keep *printed* strings ASCII (an em-dash mojibakes to `?`).

## Tooling
- Prefix shell commands with `rtk` (the token-saving wrapper).
- Verify loop (before every commit): `bun run typecheck` · `bun test` · `node bin/neko-source.cjs doctor`
  · `node bin/neko-source.cjs policy` · `bun run build`.

## Releasing
- Follow `docs/process/RELEASE.md` — gates, docs, tag-watch-verify, curated notes, the re-tag
  drill, and the stable-baseline/rollback contract. Every rule there was paid for by an incident.
