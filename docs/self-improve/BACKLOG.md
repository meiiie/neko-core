# Backlog — the loop's goal queue

Concrete, SMALL, verifiable improvement ideas. The loop picks the top unchecked item; a RESEARCH pass appends
new ones when this runs low. Each item should name **what to change + how it's verified** (a test, a bench
metric, typecheck). Mark `[x]` when committed (with the commit hash). Keep items independent so a revert of
one never blocks another.

## Now (high value, low risk)
- [ ] **Failure-aware compaction (ACON-style).** `compact()`/`shrinkOldObservations` clip statically. When a
  later turn re-reads a clipped observation or errors right after compaction, record what was clipped and
  avoid clipping that shape next time. Verify: a unit test for the "don't re-clip a just-referenced
  observation" rule; bench tokens not worse.
- [ ] **Token audit of the system prompt + tool schemas.** Measure the fixed prompt/schema token cost; remove
  redundancy/dedup without losing guidance. Verify: bench `in` tokens drop, pass-rate unchanged.
- [ ] **Peer-review before self-commit (DGM).** In `scripts/self-improve.ts`, before committing a self-change,
  a second model pass reviews the diff ("is this a real improvement, any regression risk?"); only commit if
  it agrees. Verify: the loop still commits clean changes; logs the review verdict.
- [ ] **Per-product / per-context outlier flag already done; generalize the verify gate** to also run the
  bench (no-regression) on changes touching `src/core` or `src/adapters/providers`. Verify: gate catches a
  deliberate token/pass regression.

## Research-seeded (turn into "Now" items as they're scoped)
- [ ] Archive/population self-improvement (DGM): keep N improved branches, benchmark each, keep the best —
  parallel exploration instead of one linear branch.
- [ ] Harder, long-horizon bench tasks (SWE-EVO style): multi-step, cross-module, with a regression test.
- [ ] Autonomous "relevance" pass (Focus): prune irrelevant context each step, not just at 85% full.
- [ ] **Tool-result clearing (sliding-window prune of old observations).** Distinct from ACON
  (*which* to clip) and Focus (*relevance*): a deterministic rule — keep the last `k` tool
  call/response pairs in full, replace older tool **results** with a one-line marker
  (`[cleared: read_file src/core/agent.ts]`), preserving the tool_call so the trajectory still
  reads. (Lodha et al. "Less Context, Better Agents" cut ~64% tokens *and* gained accuracy;
  Anthropic calls tool-result clearing "the safest, lightest-touch compaction.") Verify: a unit
  test that the last `k` results are intact and older ones are markers; bench `in` tokens drop,
  pass-rate flat.
- [ ] **Online skill/tool synthesis via step-reflection nudge.** (Live-SWE-agent's on-the-fly
  scaffold evolution — contrasted with DGM's offline loop.) After every Nth tool observation,
  inject a reflection nudge: "would capturing a reusable procedure as a `.neko-core` skill/script
  accelerate the rest of this task?" If yes, the agent writes it to a session tools dir and the
  `ToolRegistry` picks it up. Verify: a bench task containing a repeated sub-procedure (e.g. the
  same build+read pattern 3×) completes in fewer steps/tokens with reflection ON vs OFF, and the
  synthesized artifact exists on disk and is re-invoked.
- [ ] **Session-scoped decision notes (`NOTES.md`) that survive compaction.** Distinct from
  cross-session `memory`: a single session file the agent appends key decisions / open questions
  to, re-injected into context after `compact()` so compaction no longer erases them. (Anthropic
  "structured note-taking / agentic memory"; Claude Code preserves decisions across compaction.)
  Verify: a long-horizon test that forces compaction still correctly acts on an early
  architectural decision (regression — fails without notes, passes with); bench tokens not worse.
- [ ] **Broad doom-loop detection (per-file edit cap + repeated-failure nudge).** The current
  `lastSig`/`repeats` guard only catches the *exact same* tool call 3× in a row — it misses the
  far more common loop where the agent edits the same file `N` times with *different* args chasing
  a stubborn build error, or re-runs a failing `bash`/test 3× with tiny tweaks. Track (a) edits per
  path (write_file/edit/multi_edit) and (b) consecutive failing bash/test results; on threshold
  (e.g. 3 edits to one path, or 3 failed bashes in a row) inject the same "reconsider your
  approach" nudge the loop guard already uses. (LangChain `LoopDetectionMiddleware` took Top-30→Top-5
  on Terminal Bench this way; it's the single highest-leverage harness fix.) Verify: a unit test
  where a stub provider emits 3 distinct edits to ONE path — assert the nudge observation fires
  (the old guard does NOT trip on distinct calls) and that no real edit runs past the nudge.
- [ ] **Pre-completion verification gate (force a verify pass before exit).** `run()` returns the
  final text the instant the model stops calling tools, so an agent can declare "done" without ever
  re-checking its work (re-running the test, re-reading the file, re-running the build). Add an
  opt-in `verifyBeforeExit` option: when the model would emit a tool-less final answer, intercept
  and inject a single mandatory "re-inspect the ACTUAL state vs the goal; if not fully met, keep
  working" turn — mirroring `runUntilDone` but as a *gate on the first exit*, not a whole retry
  loop. (LangChain `PreCompletionChecklistMiddleware` + ACE "curation"/reflection-before-exit.)
  Verify: a unit test where the stub's first tool-less answer is premature; assert the gate fires
  exactly once and the model gets the verify prompt; assert it does NOT fire when the option is off.
- [ ] **Skill description + body compression (SkillReducer-style "less-is-more").** Skills already
  use progressive disclosure (name+desc in the prompt, body via the `skill` tool), but the routing
  descriptions and skill bodies themselves are never audited for tokens. Add a one-shot build-time
  pass over `skills/*.md` that (1) trims each skill's one-line `description` to a tight routing
  sentence and (2) restructures the body into "actionable core rules" up front + "supplementary
  detail" loaded only on demand — validated by a faithfulness check (core rules still cover the
  skill's stated triggers). SkillReducer found 26.4% of skills lack a routing description, 60%+ of
  body content is non-actionable, and compressing them *improved* functional quality +2.8%. Verify:
  before/after token count of the skills block in the system prompt drops (a test asserts the
  compressed descriptions stay under N chars while covering all trigger keywords); bench pass-rate
  flat-or-up (the less-is-more effect).

## Done
<!-- the loop appends:  [x] <item>  (commit <hash>, bench delta <±tok / ±pass>) -->

---
*If this list is empty or stale, the loop triggers a RESEARCH pass (web_search SOTA + new papers) and appends
fresh items here.*
