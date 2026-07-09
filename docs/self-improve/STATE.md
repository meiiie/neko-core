# State — where Neko is right now

*Updated by the loop after each cycle (and by hand when direction changes). Keep it short: the current focus,
what's measured, and the last few moves — not a full history (that's `docs/process/WORKLOG.md`).*

## Current focus
**Owner-directed work, not the autonomous loop** (as of 2026-07-10). A reliability/security audit just
closed composition, streaming, permission, config, persistence, paging, context, and documentation drift;
the full gate is green at 400/400 tests. The self-improve loop is built + ran (it
produced ~4 real wins then plateaued — a disciplined assistant, not perpetual motion), and its idea `BACKLOG.md`
(~46 items) + `RESEARCH.md` stay as the queue for when it runs again. The last stretch was **hands-on UX/UI
polish to real-terminal / Claude-Code quality** (see `../process/ROADMAP.md` Phase H + `../process/WORKLOG.md`),
done interactively with the owner — not by the loop. **Next = a new owner-directed task (TBD).**

The loop's original framing still holds for when it resumes: bench coding tasks are **saturated** (glm-5.2 =
11/11), so the live signal is the **codebase itself** (bug/test/robustness/perf/security/harness/docs), with the
bench as a **no-regression guard + metrics tracker**.

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
- [2026-07-10] (owner-directed) reliability/security sweep: one shared registry composition seam for
  CLI/TUI/subagents; native web restored as an MCP-compatible fallback; nested secret redaction; typed
  env booleans; interleaved OpenAI tool-call parsing; action-sensitive persistent-memory permissions;
  large-file paging; profile-key/session-title persistence; AGENTS.md context; dynamic architecture gate.
  TS 7 + TS 5.9 clean, 400/400 tests, policy PASS, binary + UI/input probes PASS.
- [2026-07-03] (owner-directed) perf+robustness deep-dive: stream-eager execution (overlap read tools with
  generation, EAYG/AsyncFC), MCP lazy-CONNECT (513->233MB RAM), pre-flight arg validation (Gecko),
  original-task carry across compact(), opt-in verify gate. Full battery ALL GREEN, no regression: unit
  276/0 · bench 16/16 (92% cached) · run-evals 6/6 · harsh 8/8. ~18 commits ahead of main on self-improve,
  NOT pushed (awaiting owner OK). Perf frontier documented; remaining ceiling = provider tok/s.
- [2026-07-03] (owner-directed) speed sprint + full battery: websosanh parser (LLM-free INDEX), W&D batch
  nudge, one-survey-all-answers; bench 16/16 w/ **94% cached on Z.ai** (prefix-cache work proven live);
  harsh-eval 0/8 exposed responseSchema missing on the anthropic provider -> forced-tool-call impl ->
  8/8; run-evals 6/6 after measurement-layer fixes (grade final answer, not echoes). Suite 267/0.
  New backlog: MCP orphan hygiene; Android mobile arc (3 phases).
- [2026-07-03] (owner-directed) **v0.5.1 RELEASED** (497345f, tag pushed): approval dropped-'y' fix, release
  race fix (proved itself - 5/5 assets first try), 529 retry, prefix-cache work + cached metrics, tool-error
  recovery, procurement INDEX->VERIFY. Next arcs (owner): performance + computer-use ("0.6.0 material").
- [2026-07-02] (owner-directed) tool-error recovery directive -> committed 29e7c95 (Self-Harness: [recovery]
  diagnose->repair->validate on the first mutating-tool failure, edge-triggered, cache-friendly append).
  Sprint next-up (deferred fresh): Gecko pre-flight arg validation; pre-completion verify gate.
- [2026-07-02] (owner-directed) prompt-prefix cache work -> committed 7fa916d: env block = session snapshot
  (no per-turn dirty-count), todos out of the system message, anthropic cache_control breakpoints (default
  ON, self-healed), cached_tokens measured in cost/bench. Honest: Z.ai attributes 0 cache reads today;
  the win is documented on Anthropic-semantics endpoints + stable-prefix for implicit-caching providers.
  BACKLOG reconciled (volatile-field item ticked; stale broad-doom-loop checkbox ticked).
- [2026-07-02] (owner-directed) post-release hardening: root-caused + fixed the dropped-'y' approval race
  (the "flaky" approval UI tests were a real Ink commit-vs-effect race; keys now in the always-mounted hook)
  and the release-asset race (release created once, matrix only uploads; v0.5.0 healed to 5/5 assets via
  re-run). Suite 253/0. NOT pushed - awaiting owner OK.
- [2026-07-02] (owner-directed, NOT the loop) real-terminal UX/UI polish — rendering (wrap/math/tables/emoji/
  spacing/gutter/rules), streaming scroll-jump fix, idle timeout, Windows bash→Git-Bash; + GeneBench-Pro
  dogfood. The first stock-Ink fullscreen attempt was reverted; the later custom FrameDiffer/compositor
  implementation shipped fullscreen-first. Full detail in `../process/ROADMAP.md` Phase H +
  `../process/WORKLOG.md`.
- [2026-07-01] bash seatbelt (dangerousCommand) was bypassable by QUOTING the target: `rm -rf "$HOME"`, `rm -rf "/"`, `rm -rf '~'` all slipped past the `rm -rf` guard because the target regex required the token immediately after whitespace -- a quote char broke the match. Made the token match quote-aware (optional `["']?`); added a test asserting the four quoted forms are Refused AND that quoting a normal relative path (`rm -rf "build"`) is still allowed. Verify gate green: typecheck + 227/0 tests + policy PASS. Left uncommitted for the harness.
- [2026-06-30] compact() lean-tail clip now also triggers by char count (LEAN_TAIL_CHARS=8000), so dense few-line tool results (minified JSON/base64/packed logs) — long in chars but short in lines — are actually clipped instead of passing through fully intact and freeing no context; committed a76ec45.
- [2026-06-30] estimateTokens now counts assistant tool_calls so the in-loop overflow guard isn't undercounted on tool-heavy turns (e.g. several large write_file calls); committed 620aed2.
