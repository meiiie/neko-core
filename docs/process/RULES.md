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

## Safety
- **Secrets never committed or printed.** Key via env (`NEKO_API_KEY` / `OPENAI_API_KEY` /
  `NVIDIA_API_KEY`) or the gitignored `~/.neko-core/config.json`. Run `/secret-scan` before
  any public push; push public only with owner sign-off.
- **Windows console is cp1252.** Keep *printed* strings ASCII (an em-dash mojibakes to `?`).

## Tooling
- Prefix shell commands with `rtk` (the token-saving wrapper).
- Verify loop: `pytest -q` · `compileall src` · `neko doctor` · `neko policy`.
