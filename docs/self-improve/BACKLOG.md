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
- [ ] **Anchor-preserving compaction (ACC-style).** `compact()`/`shrinkOldObservations` clip purely by
  age/size (KEEP_TAIL, 40-line/8K-char caps) — size-blind to *importance*, so the summarizer can silently
  drop the one error message / target value / stated decision the rest of the task hinges on (brevity
  bias). Add an *anchor-extraction* pass to the existing summarizer call: when building the head text to
  summarize, also ask the model to extract a compact **"Reasoning anchors"** block (verbatim error
  strings, target values, key decisions) and **concatenate it onto the summary** so it survives the
  prune. Distinct from ACON (*which* observation to clip, learned from failure) and "decision notes" (a
  separate session file): this is *in-line importance tagging* inside the single summarizer prompt that
  already runs. (Active Context Curation, arXiv 2604.11462, kept sparse anchors through every prune for
  +4.8pp WebArena at -8.8% tokens.) Verify: a unit test where the head contains a distinctive error
  string + target value; force `compact()`; assert BOTH appear verbatim in the resulting summary (fails
  today — the summarizer drops them). Then assert bench `in` tokens not worse and pass-rate flat-or-up
  (anchors are sparse, so the summary barely grows).
- [ ] **Falsifiable-prediction gate in the self-improve loop (AHE decision-observability).** Today the
  loop commits a self-change iff the verify gate passes (`typecheck + tests + policy`) plus a qualitative
  peer-review ("is this a real improvement, any regression risk?"). That accepts *neutral* changes as
  readily as real wins and judges the diff, not whether the *stated outcome* materialized — so the loop
  can drift on placebo edits. Borrow AHE's *decision observability* (arXiv 2604.25850, beat Codex-CLI on
  Terminal-Bench 2 this way): before editing, the loop **states a falsifiable prediction** ("this trims
  ~X% bench `in` tokens at flat pass-rate" / "this fixes failing case Y"); after the verify gate, it
  **compares the prediction to the actual bench delta** (from `~/.neko-core/bench-log.jsonl`) and records
  the verdict (MET / NOT-MET / NEUTRAL) in STATE.md, committing only on MET-or-confirmed-NEUTRAL.
  Distinct from the existing peer-review: peer-review judges the *diff* qualitatively; this checks the
  *stated outcome* quantitatively against the bench. Verify: a scripts-level test where a stubbed change's
  stated prediction ("−10% in-tokens") is checked against a stubbed bench delta (−2%) — assert the gate
  logs NOT-MET and does NOT commit; assert it DOES commit when delta meets the prediction. Pure
  self-improve-harness logic — no agent-loop change.
- [ ] **Tool-schema notation optimization (TRON-style "Notation Matters").** Distinct from the existing
  "Token audit of system prompt + tool schemas" Now-item (which targets *content* redundancy/dedup):
  this targets the **notation/format** overhead. JSON schemas carry structural tokens (`"type"`,
  `"properties"`, quotes, braces) that purpose-built notations cut. "Notation Matters" (arXiv 2605.29676,
  May 2026) found **TRON trims up to 27% of schema tokens at ≤14pp accuracy cost**; critically it also
  shows some compact formats (TOON) *cascade-parse-fail in multi-turn + parallel tool-call* settings —
  so any change must be validated end-to-end, not just on token count. For Neko: measure the fixed
  per-turn cost of `tools.schemas()`; try a conservative, OpenAI-compatible compaction (drop redundant
  `"type":"string"` defaults, shorten repetitive keys, elide optional fields the model never misuses)
  rather than a foreign notation that would break the chat template. Verify: (1) a token-count test
  asserting the serialized schema shrank; (2) the *existing* tool-call unit tests still pass (the model
  still emits well-formed calls); (3) bench pass-rate flat (catches the TOON-style cascade failure).
    Bench `in` tokens should drop on every tool-bearing step.
- [ ] **Lazy built-in tool-schema gating (the "Tools Tax").** Neko already loads *MCP* tool schemas on
  demand via the `mcp_load` meta-tool (`adapters/mcp.ts`), but the **built-in** tools are still injected
  in full every turn via `tools.schemas()` (`tool-runtime.ts`) — `read_file/search/glob/ls/todo_write/
  write_file/edit/bash/web_search/web_fetch/skill/computer/...` plus the large `browser_*` family. Each
  schema's structural overhead (`type`/`properties`/`required`/long descriptions) is re-fed and re-cached
  on *every* step even when unused — a fixed per-turn tax that grows with every tool added. Borrow Tool
  Attention's two-phase loader (arXiv 2604.21816, cut per-turn tool tokens 47.3k->2.4k, -95%): expose a
  compact **name + one-line-description "summary pool"** for all built-ins upfront, and a safe
  `tools_load` meta-tool that promotes the full JSON schema of only the ones a turn needs, mirroring the
  existing `mcp_load` pattern. **Caveat from the paper**: end-to-end gains are *projected*, not measured
  on live agents — so the verify gate is mandatory, not optional. Distinct from the "Tool-schema notation
  optimization" item (which compacts the *format* of schemas that ARE sent): this drops schemas from the
  wire entirely. Verify: (1) a unit test asserting `schemas()` returns only the summary pool + any
  explicitly-loaded schemas, and that `tools_load` returns the full schema for a named tool; (2) the
  existing tool-call unit tests still pass (the model still reaches the right tool via load-then-call);
  (3) bench `in` tokens drop on tool-bearing steps at flat-or-up pass-rate. NB: ship behind an **opt-in**
  profile flag so a regression in tool discovery is a toggle, not a default breakage.
- [ ] **Prompt-prefix cache stability during compaction (TokenPilot).** `compact()` mutates the *head* of
  `this.messages` (summarizes old messages in place, rewrites the system message text) — which invalidates
  the provider's prompt-prefix (KV) cache on every compaction, so the next request re-processes the whole
  prefix from scratch. TokenPilot (arXiv 2606.17016, -61% / -87% cost in isolated / continuous mode)
  shows the fix: make compaction **ingestion-aware** — *never mutate the stable prefix* (system prompt +
  earliest turns). Instead prune forward from the prefix boundary, and do ingestion-time noise removal at
  the tool-result gate (before a noisy observation ever enters `messages`) so the stored trajectory is
  already lean and the prefix never needs rewriting. For Neko: (a) change `compact()` so it *appends* a
  compact summary message rather than rewriting the head, leaving the system message + earliest user
  turns byte-identical; (b) add budget-aware truncation in observation formatting so huge tool results
  are clipped *before* joining `messages`. **Verify**: a unit test that seeds a message history, runs
  `compact()`, and asserts the system message + first N messages are byte-identical before/after (fails
  today — `compact()` rewrites the head); plus a provider-adapter test that the message array handed to
  `complete()` preserves a stable prefix across two simulated compactions. Bench: `cached_tokens` (if the
  provider reports it in `usage`) should rise and `cost` drop at flat pass-rate. NB: prefix-cache
  semantics are provider-specific; gate on whether the active provider reports cache metrics, else fall
  back to asserting prefix-stability as the proxy.
- [ ] **Event-driven task re-grounding against instruction fade-out (OpenDev).** Long runs drift: the
  model literally loses sight of the *original* user instruction as tool observations pile up between it
  and the working end of context. Neko re-injects an "Ongoing goal" only via the `/goal` slash command
  (`ui/commands.ts`) — a *manual*, one-shot, user-invoked nudge. OpenDev (arXiv 2603.05344) shows the
  fix: **event-driven system reminders** that re-inject the original task + key constraints "at the point
  of decision" (each Nth step, and on threshold events like compaction / doom-loop nudge), not relying
  solely on the initial prompt. Distinct from the existing "Pre-completion verification gate" (which
  fires *once*, at exit): this is *periodic* re-grounding *during* the run, countering attention decay.
  For Neko: capture the original `instruction` passed to `run()`; every `k` steps (and immediately after
  any `compact()`), `appendSystem()` a short "REMINDER - your task is: <instruction verbatim>. Stay
  focused on the original goal." (reuse the existing `appendSystem` plumbing). **Verify**: a unit test
  where a stub provider emits `k+1` steps asserts the reminder observation is injected exactly at step
  `k` (and once post-compaction) and contains the verbatim instruction; assert it does NOT fire when the
  run is shorter than `k`. Functional check: a long-horizon bench task whose final step must reference
  the *original* spec (not the most-recent observation) completes correctly WITH the reminder and
  fails/drifts WITHOUT it. Bench tokens should be ~flat (reminder is small) at flat-or-up pass-rate.

## Done
<!-- the loop appends:  [x] <item>  (commit <hash>, bench delta <±tok / ±pass>) -->

---
*If this list is empty or stale, the loop triggers a RESEARCH pass (web_search SOTA + new papers) and appends
fresh items here.*
