# State — where Neko is right now

*Updated by the loop after each cycle (and by hand when direction changes). Keep it short: the current focus,
what's measured, and the last few moves — not a full history (that's `docs/process/WORKLOG.md`).*

## Current focus
**Owner-directed work, not the autonomous loop** (as of 2026-07-10). **v0.9.0 is RELEASED** (tag
`153e470`, 5/5 binaries, main fast-forwarded): OSC 8 clickable links through the whole custom
compositor, the managed SearXNG lifecycle (Ollama keep_alive pattern), the vision computer-use loop,
and `neko bench gui [hard]`. The evening close-out then landed on `self-improve` as Unreleased:
`neko setup tavily <key>` (the no-Docker search rung, live-verified), the ladder's middle-rung
fallback (SearXNG -> Tavily -> DuckDuckGo), and a doctor WARN naming the model-shadow footgun
(top-level `model` vs profile preset). The self-improve loop is built + ran (it produced ~4 real wins
then plateaued — a disciplined assistant, not perpetual motion), and its idea `BACKLOG.md` +
`RESEARCH.md` stay as the queue for when it runs again. **The verifier-backed long-horizon
computer-use eval exists AND discriminates**: `neko bench gui` (base tier = smoke; saturated live
12/12) + `neko bench gui hard` (cross-screen memory, paged decoys, interrupts, guarded submits, a
composite workflow; METR-style calibrated budgets). Live baseline gpt-oss-120b: **11/12 (92%),
paged-decoys FLAKY, 16 grounding misses**.
**Next = the glm-5.2 baseline (blocked: both Z.ai keys rejected since 2026-07-10, owner must refresh), then
a harness lever (verify gate / recovery middleware / re-grounding) must show measurable lift on pass-rate
or miss-count; no new controller until then.** The recorded 11/12 gpt-oss result is the historical v1
baseline; GUI harness v2 tightened instruction/constraint verification and needs a fresh baseline before
scores are compared.

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
- [2026-07-11] (owner-directed Fable 5 audit) GUI harness v2 closed three false-pass classes found by
  replaying forbidden-then-repaired trajectories: wrong item then right item, unrelated setting toggled
  then restored, and forbidden interrupt choices followed by successful recovery. The log now records a
  harness version; the old 11/12 score remains historical until v2 is re-baselined.
- [2026-07-10 night] (owner-directed: "relay ... suy nghĩ sâu") **relay v2 shipped + deployed**: WS
  hibernation transport (SOTA-checked vs Claude Code Remote Control + Cloudflare DO guidance),
  streaming partials to the phone, mid-turn Stop, durable pairing (relay.json), DO-storage state
  (eviction/offline-queue fixed), truthful /alive, busy=wait. 490/490 tests; Worker deployed to the
  owner's Cloudflare and live-probed 10/10. Back-compat both ways. Also: owner's config model-shadow
  FIXED live (top-level model removed, doctor now OK on gpt-oss-120b).
- [2026-07-10 evening] (owner-directed close-out) **v0.9.0 released** (all RELEASE.md gates green; 5/5
  assets; notes curated; local binary reinstalled). Then handoff polish on `self-improve` (pushed):
  doctor model-shadow WARN (verified live on the real shadowed config), `neko setup tavily <key>` with
  live key verification, ladder middle-rung fallback. 485/485 tests, dual typecheck, policy PASS,
  secret-scan CLEAN.
- [2026-07-10] (owner-authorized live calibration) base tier saturated (12/12) -> built the HARD tier
  (bank-transfer / paged-decoys / guarded-form / expense-report composite; `El.goTo` interrupts +
  `El.guard` validation) and calibrated budgets METR-style to the measured strain point. Result on
  gpt-oss-120b: 11/12 (92%), FLAKY paged-decoys, 16 grounding misses - the ruler discriminates. glm-5.2
  blocked: both Z.ai keys rejected (account/key expired; owner to refresh). Also found: top-level
  `model:` in the user config shadows every profile's model (footgun, worked around via a local overlay).
  450/450 tests, policy PASS.
- [2026-07-10] (owner-directed, continuing the colleague's computer-use arc) built the long-horizon
  computer-use eval `neko bench gui`: a deterministic simulated GUI world injected via a new opt-in
  `ToolRegistry.computerHandler` seam (default unset = real Windows path untouched); 4 axis-isolated tasks
  (task-success+constraint / error-recovery / precise-action / coordinate-grounding), metrics -> bench-log
  suite "gui". 15-test deterministic self-test (scripted provider, no live model). 436/436, policy PASS,
  typecheck clean. Live glm-5.2 baseline is the owner's to run next. Committed to `self-improve`, NOT pushed. atomic todo validation and
  open-plan exit recovery; `Alt+C` copies raw and collapsed-paste drafts without mutation; Windows
  `computer` gains Unicode type, exact-control focus, key, touch-scroll, wait, and open; action payloads
  are redacted; built-in skills/assets are embedded into the standalone binary. 416/416 tests, policy
  PASS, VT capture, WPF/UIA probe 3/3, external-directory binary skill probe, ConPTY 14 ms/142 ms PASS.
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
