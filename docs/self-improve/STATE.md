# State — where Neko is right now

*Updated by the loop after each cycle (and by hand when direction changes). Keep it short: the current focus,
what's measured, and the last few moves — not a full history (that's `docs/process/WORKLOG.md`).*

## Current focus
Stand up **continuous, measured self-improvement** (Neko improving Neko), then let it run on the Z.ai GLM
coding plan. Bench coding tasks are **saturated** (glm-5.2 = 11/11), so the live signal is the **codebase
itself** (bug/test/robustness/perf/security/harness/docs), with the bench as a **no-regression guard + metrics
tracker**.

## What's in place
- **Provider:** `anthropic` provider → Z.ai GLM coding-plan endpoint; `--profile zai` = glm-5.2; effort →
  Anthropic extended-thinking budget. `key_env` presets make any provider a profile + an env var.
- **Measurement:** `neko bench` reports per-task time / in-out tokens / tok/s / steps and appends a JSON line
  to `~/.neko-core/bench-log.jsonl`. **Diff two lines to see if a change helped.**
- **The loop:** `scripts/self-improve.ts` — forever; verify gate (typecheck + 0-fail tests + policy) + a real
  change → commit to the `self-improve` branch, else revert; rate-limit back-off; research-pass when stuck.

## Baselines (most recent)
- glm-5.2, effort high: bench **11/11 (100%)**, 6902 tok (in 4638 / out 2264), ~10 tok/s, 41 steps, 226s.
  → improvement target is NOT pass-rate (already 100%) but **tokens, speed, and robustness/coverage** + the
  harness levers in [HARNESS.md](HARNESS.md).

## How to read progress
`tail ~/.neko-core/bench-log.jsonl` — newest run last. A good self-change shows: pass stays 100%, **tokens
down / tok-s up** (efficiency), or new harder tasks now passing (capability). A bad one is reverted by the gate.

## Last moves
<!-- the loop prepends one line per cycle: [ts] iter N: <goal> -> committed <hash> | reverted (<why>) -->
- [2026-07-01] bash seatbelt (dangerousCommand) was bypassable by QUOTING the target: `rm -rf "$HOME"`, `rm -rf "/"`, `rm -rf '~'` all slipped past the `rm -rf` guard because the target regex required the token immediately after whitespace -- a quote char broke the match. Made the token match quote-aware (optional `["']?`); added a test asserting the four quoted forms are Refused AND that quoting a normal relative path (`rm -rf "build"`) is still allowed. Verify gate green: typecheck + 227/0 tests + policy PASS. Left uncommitted for the harness.
- [2026-06-30] compact() lean-tail clip now also triggers by char count (LEAN_TAIL_CHARS=8000), so dense few-line tool results (minified JSON/base64/packed logs) — long in chars but short in lines — are actually clipped instead of passing through fully intact and freeing no context; committed a76ec45.
- [2026-06-30] estimateTokens now counts assistant tool_calls so the in-loop overflow guard isn't undercounted on tool-heavy turns (e.g. several large write_file calls); committed 620aed2.
