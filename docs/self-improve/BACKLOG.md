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

- [ ] **Constraint pinning across compaction (Governance Decay).** `compact()` summarizes the whole
  head with a summarizer prompt ("task, key decisions, files changed, current state") that has
  **zero notion of governance text** — so a policy constraint the agent obeys while visible
  (e.g. "NEVER run `rm -rf`; this branch is read-only") can be silently dropped from the summary,
  and the agent then does the now-unseen prohibited action on a later step. This is the exact
  failure mode in *Governance Decay* (Chen 2026, arXiv 2606.22528): 0% violations while the policy
  is visible → 30% after compaction (59% worst-case); their training-free **Constraint Pinning**
  fix restores 0%. Distinct from ACC/anchor-compaction (which preserve *task* facts — errors,
  target values) and "decision notes" (a separate session file): this preserves **policy/safety
  constraints** that must survive every prune. For Neko: support a small **pinned-constraint
  block** in the system prompt (marker-delimited, e.g. a `### Pinned constraints` section, or
  `<!-- pinned -->...<!-- /pinned -->`); in `compact()`, *extract* any pinned text *before*
  summarizing and *re-inject it verbatim* into the post-compaction system message, so compaction
  can never erase it. **Verify**: a unit test that (a) seeds a message history whose system prompt
  contains a pinned constraint string, (b) forces `compact()`, and (c) asserts the pinned string is
  present verbatim in the post-compaction system message (fails today — the summarizer is free to
  drop it). Then a trajectory-level test: a stub provider that would emit a now-prohibited tool
  call *after* compaction — assert the pinned constraint blocks it. Bench tokens ~flat (pinned text
  is tiny) at flat-or-up pass-rate; this is primarily a *safety-correctness* win, not a token win.
- [ ] **Project-context index/retrieve split (AGENTS.md evaluation).** `adapters/context.ts` injects
  the full project context (NEKO.md/CLAUDE.md, including the entire codebase **map**) into the
  system prompt **upfront on every run**. *Evaluating AGENTS.md* (Gloaguen et al., arXiv 2602.11988,
  Feb 2026) directly pressures this design: repo-level context files **do not generally improve task
  success, raise inference cost >20% on average, and the "repository overview" — the most popular,
  provider-recommended component — provides no measurable benefit**; only instructions on
  *non-standard coding practices* help. Distinct from the lazy-tool-schema item (drops *tool
  schemas* from the wire) and SkillReducer (compresses *skill* bodies): this targets the
  *project-context prose* re-billed on every run. For Neko: this is a **measure-first** item.
  (1) Instrument the fixed per-run token cost of the full upfront project context (the NEKO.md map
  + CLAUDE.md body) and confirm it's material. (2) Prototype a split: keep a **tight index** of
  *where* info lives (one line per subsystem + pointer to read it) in the upfront prompt, and a
  small `project_context` retrieve tool that loads the full map section on demand (mirroring the
  existing `skill`/`memory` on-demand pattern). **Verify**: (a) a test asserting the upfront
  project-context token count drops by ≥X% in the index split while the index still names every
  subsystem from the original map; (b) a long-horizon bench task that needs info from the map
  completes (the agent reaches it via the retrieve tool) at flat-or-up pass-rate; (c) the bench
  dev-log shows **total** `in` tokens down or flat (the retrieval calls must not exceed the upfront
  savings). NB: the paper is correlational across *other* agents; validate on Neko's own bench
  before shipping, and keep the full map as a fallback (the map genuinely helps our small codebase —
  scope the split, don't delete the map blindly).
- [ ] **Sub-agent scope attenuation via per-delegation tool allowlist.** The `task` tool
  (chat.tsx `registryRef.subagent`) spawns a fresh `ToolRegistry` that inherits the parent's **full**
  built-in tool set (`read_file/write_file/edit/bash/web_search/...`) + all MCP tools + hooks — the
  spawn narrows the *role* (system prompt) but **not which tools the child may use**. *When Child
  Inherits* (Cai, Zhang, Hei, arXiv 2605.08460, May 2026) models delegation as *inheritance* and
  finds current frameworks violate trust boundaries by passing the full tool set + context wholesale;
  its lens: **scope should attenuate per hop** — each spawn *narrows* permitted actions, never
  widens. Distinct from the existing context-isolation story (the sub-agent already gets a *fresh*
  context): this is about *tool* scope, which is un-attenuated today. For Neko: let the `task` tool
  accept an optional **`tools` allowlist** (array of tool names); when set, the sub-agent's
  `ToolRegistry` is constructed so only those tools (plus safe essentials) are exposed/serialized —
  a delegated "researcher" with `tools: ["read_file","search","glob","ls"]` literally cannot
  `edit`/`bash`/`rm` even via inherited hooks. Default (no allowlist) keeps today's full-inherit
  behavior. **Verify**: (1) a unit test that a sub-agent spawned with `tools: ["read_file"]` has its
  `schemas()` return only `read_file` (+ essentials) and that a call to `edit`/`bash` is refused with
  a clear "not available in this sub-agent" message; (2) a test that omitting the allowlist preserves
  the full tool set (no regression to existing delegation); (3) bench: a task that delegates research
  completes correctly with a scoped allowlist, and the sub-agent's per-turn `in` tokens are lower
  (fewer tool schemas serialized) at flat-or-up pass-rate. NB: ship the allowlist as **opt-in** so a
  too-narrow list (model forgets a tool it needs) is a per-call miss, not a default breakage.

- [ ] **Workflow-adaptive, critical-gated observation compression (TACO).** `shrinkOldObservations`
  clips old tool results by *size* (40-line / 8K-char caps) — size-blind to *signal*, so it either
  trashes a short error trace or keeps a 10K-char `apt install` "Unpacking ..." spam verbatim. TACO
  (arXiv 2604.19572) is the fresh SOTA: a **training-free, line-level** compressor with two gates —
  (1) **critical/non-critical**: any observation containing an explicit error/exception/test-failure
  signal is passed through **unchanged**; only non-critical output is compressed, and (2)
  **pattern rules** (regex trigger + keep/strip patterns, e.g. strip every `Unpacking|Setting up`
  line from an `apt-get` log, keep the final status line) — reported to cut a 10,071-char install
  log to 73 chars (99.3%) at +2-6pp TerminalBench, ~10% per-step tokens on large models. Distinct
  from the existing "Tool-result clearing" (drops *whole old results* for a sliding window),
  ACON/anchor-compaction (protect *task facts* in the summary), and AgentDiet (dedup *within* a
  kept result): TACO compresses the *noise lines inside* an otherwise-kept observation, gated by
  criticality. For Neko: (a) add an `isCritical(result)` test in observation formatting (regex for
  `error|exception|fail|traceback|✗`, non-zero exit, etc.) — pass critical results through
  untouched; (b) apply a small seeded rule set (`pip/npm/apt install`, `git clone`, `tsc`/`cargo
  build` rebuild spam) that strips progress-bar / verbose-log lines while keeping the final status.
  Keep rules in a file under `.neko-core/` so they're editable (AHE component-observability).
  **Verify**: (1) a unit test where a `bash` result = a 200-line `npm install` log (no error) is
  compressed to a one-line status (assert the error-critical sibling is passed through byte-identical);
  (2) a unit test that an observation containing `Error:` / a non-zero exit code is NOT compressed;
  (3) the existing `shrinkOldObservations` test still passes; (4) bench `in` tokens drop on a
  build/install-heavy task at flat-or-up pass-rate.
- [ ] **Lossless compaction with on-demand recovery (LCM `expand`).** `compact()` is **destructive**:
  it summarizes the head *in place*, throwing away the raw observations forever — if the summary
  dropped a detail a later step needs (the exact path, the precise error string), the agent cannot
  get it back and must re-run the tool (wasting tokens / re-introducing the very cost compaction
  saved). LCM (arXiv 2605.04050) makes compaction **lossless**: raw messages are *persisted* and the
  summary carries a pointer; a tool (`lcm_expand`/`lcm_grep`) restores the verbatim original on
  demand. Volt beat Claude Code v2.1.4 +4.5pp avg on OOLONG, widening to +12.6pp at 512K. Distinct
  from the existing "Anchor-preserving compaction" (keeps a *static* anchor block in the summary) and
  "Decision notes" (a separate *session* file): this is **reversibility of the prune itself** — the
  raw observation is recoverable, not summarized-away. For Neko: compact() already runs in-memory;
  (a) before rewriting the head, snapshot the about-to-be-summarized messages to
  `~/.neko-core/session-<id>/compact-<n>.jsonl`; (b) emit the summary with a marker like
  `[compacted N turns — use recover_context to see raw]`; (c) add a safe built-in `recover_context`
  tool that loads + injects the stored raw block for a named compact. **Verify**: (1) a unit test
  that forces `compact()`, then calls `recover_context` for that compact and asserts the *raw*
  messages come back byte-identical (fails today — they're gone); (2) a trajectory test where the
  summary drops a distinctive value, the agent `recover_context`s it, and the task succeeds (the
  benchmark for "don't re-run the tool"); (3) `compact()` still reduces token count (the summary
  still replaces the head in-context; recovery is opt-in). Bench: `in` tokens flat-or-down (recovery
  fires rarely) at flat-or-up pass-rate; the win is correctness on tasks that today force a re-run.
- [ ] **Tool-error-triggered recovery middleware (Self-Harness "artifact middleware").** Neko's doom-loop
  guard trips only on the *exact same* tool call 3× — but the common, costly loop is subtler: a tool
  *errors*, the agent flails (retries, edits around it, deletes the partial output it needs), and
  burns the budget without ever being told how to *recover*. Self-Harness (arXiv 2606.09498) found
  this exact failure across models and fixed it with a **tool-error-triggered system prompt** — when
  a tool errors, inject a redirect: "the last tool errored; do NOT delete/rerun blindly — diagnose
  the cause, recreate or repair the needed artifact, validate it, then proceed." Took
  Qwen3.5-35B 20.3%→36.7% on Terminal-Bench-2 (a 16pp swing, the single biggest Self-Harness win).
  Distinct from the existing "Broad doom-loop detection" (counts repeats per path) and the
  "Pre-completion verification gate" (fires once at exit): this fires **on the first tool error** with
  a *recovery-oriented* prompt, not just a "reconsider" nudge. For Neko: in the agent loop, detect a
  non-zero `bash` exit / a refused write / a tool exception; on the next turn `appendSystem()` a
  short recovery prompt (reuse the existing nudge plumbing). Make it threshold-gated (e.g. after the
  1st error on a *write/edit/bash* tool, not on benign read misses) to avoid nagging. **Verify**: (1)
  a unit test where a stub provider's `edit` errors once — assert the recovery observation fires
  exactly once on the next turn and contains the diagnosis directive (assert it does NOT fire on a
  successful tool call or when gated off); (2) a trajectory test where the stub would otherwise
  delete-then-rerun into a budget limit — assert WITH the middleware it diagnoses-and-proceeds within
  budget (the Terminal-Bench failure mode). Bench: flat-or-up pass-rate, fewer wasted steps on
  error-prone tasks; primarily a *correctness/budget* win.

- [ ] **Per-step adaptive reasoning effort (Ares).** Neko sends ONE fixed `reasoning_effort`
  for the whole run: `cfg.effort` is baked into the provider payload on every `complete()`
  (`adapters/providers.ts` + `adapters/anthropic.ts` thinking budget), and the user only
  changes it manually via `/effort`. So a run either burns maximum thinking tokens on a
  trivial `ls`/`read_file` step (waste) or under-thinks a hard planning step (errors). Ares
  (arXiv 2603.07915) shows a *per-step* effort router cuts reasoning tokens **up to 52.7%
  with minimal accuracy loss** — reserving high effort for inherently hard steps (planning,
  debugging) and dropping to low for mechanical ones (open URL, read a file, run a known
  command). Ares's router is a *trained* classifier; for Neko the transferable, training-free
  proxy is a **rule-based per-step effort** driven by the step's *tool*: steps whose only tool
  calls are safe read-only inspection (`read_file/search/glob/ls/web_search/web_fetch`) or a
  trivial bash command map to a LOW effort; steps that touch `write_file/edit/bash` (build/
  test/install) or emit NO tools (the final synthesis / planning turn) get the configured HIGH
  effort. Distinct from every existing backlog item (none touch reasoning effort) and from the
  "Pre-completion verification gate" (that's a *prompt* gate; this is a *compute* knob).
  **Verify**: (1) a unit test with a stub provider whose `complete()` records the
  `reasoning_effort` sent each call; assert a turn calling only `read_file` sends LOW while a
  turn calling `edit` sends the configured HIGH (and a tool-less turn sends HIGH); (2) the
  existing tool-call + reasoning tests still pass (effort changes cost, not call shape); (3)
  bench `outTok` (reasoning lives in output tokens) drops at flat-or-up pass-rate — the
  primary metric is **reasoning/output tokens**, not `inTok`. NB: ship behind an **opt-in**
  profile flag (`adaptive_effort`) so a wrong step classification is a toggle, not a default;
  keep the configured effort as the HIGH ceiling and never exceed it. Providers that reject
  `reasoning_effort` already self-heal (the adapter omits the field) — verify that path still
  works under per-step changes.

- [ ] **Parallel-tool-width nudge for independent reads (W&D).** Neko already fan-outs a tool
  batch IF *every* call in it is concurrency-safe (the `CONCURRENCY_SAFE` set in `core/agent.ts`:
  `read_file/search/glob/ls/web_search/web_fetch/task`) — but whether the model *emits* a
  parallel batch at all is left entirely to the model's own judgment, and nothing in the system
  prompt encourages it. So the model typically serializes obviously-independent reads (reading
  3 files to understand a module, or `search` + `glob` together), costing one full round-trip
  (a re-feed of the whole growing context) PER read. W&D (arXiv 2602.07359, "Scaling Parallel
  Tool Calling") shows scaling *width* — multiple tool calls in one reasoning step — both
  *raises* accuracy (GPT-5-Medium 62.2% > GPT-5-High 54.9% on BrowseComp) *and* cuts the
  number of turns/context-re-feeds required. Distinct from every existing backlog item (none
  touch turn-count or tool batching) and from "Sub-agent scope attenuation" (that narrows
  *which* tools; this grows *how many in parallel*). For Neko, the cheap, training-free lever
  is a **one-line system-prompt nudge** (no loop change needed — the fan-out machinery already
  exists): tell the model, in the `## Tools` section, to batch independent read-only
  inspections into one turn ("When you need several independent reads/searches, emit them
  together in one step — they run in parallel") — mirroring how the existing prompt already
  nudges "Prefer edit over rewriting". **Verify**: (1) a behavioral test where a stub provider
  is asked to gather info from 3 files; assert that WITH the nudge the model emits all reads
  in ONE assistant turn (one `complete()` call covering all three) and WITHOUT it emits them
  across 3 turns (use the stub to count turns-to-completion); (2) the existing fan-out test
  (parallel-safe batch runs via `Promise.all`) still passes; (3) bench `calls` (LLM
  round-trips) and `inTok` (re-fed context) drop at flat-or-up pass-rate on read-heavy tasks.
  NB: W&D also warns of a width/depth trade-off (too-wide batches can mis-coordinate) — the
  nudge targets *independent* reads, so gate the verify on tasks where reads are genuinely
  independent (the model still serializes when a read depends on a prior read's result).

- [ ] **Mutation-aware stale-read elision (Context Rot "dilution").** Neko re-feeds tool
  results verbatim every turn until `shrinkOldObservations`/`compact()` age them out —
  including a `read_file`/`ls` result for a path the agent has NOT touched since, whose
  contents are byte-identical to what's already earlier in context from a prior read of the
  same path. Chroma's *Context Rot* (trychroma.com/research/context-rot, evaluated across 18
  SOTA models incl. GPT-4.1/Claude 4/Gemini 2.5/Qwen3) shows mere irrelevant BULK measurably
  degrades performance ("dilution": performance falls with input length even with NO
  distractors), and that focused ~300-token prompts beat ~113K-token full prompts *even with
  thinking enabled* — so re-feeding unchanged content is pure cost AND pure harm. Distinct
  from the existing "Tool-result clearing" (drops whole OLD results by age) and TACO
  (compresses NOISE LINES inside a result): this elides a *whole unchanged* re-read whose
  content already exists verbatim earlier in the trajectory, collapsing a redundant duplicate.
  For Neko: in observation formatting (where `clampObservation` runs), track the hash of each
  `read_file`/`ls`/`search` result keyed by (tool, normalized-args); when a new result hashes
  EQUAL to the most recent prior result for the same key, replace it with a one-line marker
  (`[unchanged: read_file src/core/agent.ts — see earlier result]`) instead of re-appending
  the full body. (Only exact-equality, byte-for-byte — never a fuzzy/semantic match, which
  Context Rot shows is where the dangerous *distractor* degradation lives.) **Verify**: (1) a
  unit test that calls the formatter with the same `read_file` path twice in a row; assert the
  second observation is the marker, not the full body, and that a DIFFERENT path still emits
  full body; (2) a test that a result whose content CHANGED between calls (the file was edited)
  emits the full new body (no false elision); (3) the existing `clampObservation`/
  `shrinkOldObservations` tests still pass; (4) bench `inTok` drops on tasks with repeated
  reads of the same unchanged file at flat-or-up pass-rate. NB: key the cache per-session only
  (never across runs), invalidate the key on any `write_file`/`edit` to that path, and keep it
  opt-in behind a profile flag so a hash collision (vanishingly rare for a real hash) is a
  toggle, not a silent correctness bug.

- [ ] **Idempotent-tool-call result caching (ToolCaching).** Neko's agent loop runs EVERY tool call
  through `safeExecute()` (`core/agent.ts`) afresh each turn — so when the model re-issues a
  DETERMINISTIC call it has already made with identical args in the same run (a re-`search` for the
  same regex, a re-`glob` of the same pattern, a re-`bash` of a read-only command like `git status`/
  `ls`/`cat`, a re-`web_search`), the tool re-runs and the fresh result is re-appended to context —
  burning both wall-clock (re-execution) AND tokens (a second full result body). ToolCaching (Zhai
  et al., arXiv 2601.15335, Jan 2026) cuts this: cache `(tool, normalized-args) -> result` for
  cacheable calls and serve the prior result on a repeat without re-executing. Distinct from the
  existing "Mutation-aware stale-read elision (Context Rot)" item — that elides the re-*FEED* of an
  unchanged `read_file`/`ls` result by hashing its OUTPUT (a context-token win only; the tool still
  RUNS): this skips the re-*EXECUTION* of any idempotent tool (incl. slow deterministic `bash`/
  `search`/`glob`/`web_search`), a wall-clock + token win, keyed on the INPUT args not the output
  hash. For Neko: add a per-session `(tool, normalizedArgs) -> result` memo inside `safeExecute()`;
  cache only the DETERMINISTICALLY-safe subset (extend the `CONCURRENCY_SAFE` set — `read_file/
  search/glob/ls/web_search/web_fetch`; explicitly EXCLUDE `bash` unless the command is on a tiny
  read-only allowlist like `ls`/`cat`/`pwd`/`git status`, since most bash mutates or is
  time-dependent; always exclude `write_file`/`edit`/`task`). Invalidate the key on any mutation to
  the same path (a `write_file`/`edit` to a path busts that path's `read_file` cache). **Verify**:
  (1) a unit test calling `safeExecute(read_file, path)` twice with identical args asserts the tool
  body is NOT re-invoked the 2nd time (a spy/counter) and the same cached string is returned; (2) a
  test that editing the path between two reads RE-runs the tool and returns fresh content (no stale
  cache); (3) a test that `bash`/`write_file` are NEVER served from cache (correctness — they
  mutate); (4) bench wall-clock AND `inTok` drop on a task with repeated identical deterministic
  reads/searches at flat-or-up pass-rate. NB: key the cache per-session only (never across runs),
  keep it opt-in behind a profile flag, and cap its size (LRU) so a pathological run doesn't grow
  memory unboundedly.
- [ ] **Self-improve-loop candidate archive + best-keep (DGM/Population).** Neko's self-improve loop
  (`scripts/self-improve.ts`) is strictly LINEAR: it commits ONE improvement, then builds the NEXT on
  top — a single evolving branch. If commit #3's change interacts badly with #2, or #2 was actually a
  neutral placebo that passed the verify gate, every later commit inherits the drift; there is no way
  to keep a divergent harness variant and benchmark it against the current head. DGM (Zhang et al.,
  ICLR 2026, arXiv 2505.22954) and the fresher **Meta-Harness** (Lee et al., Stanford IRIS, arXiv
  2603.28052, Mar 2026 — #1 on Terminal-Bench-2 by SEARCHING over harness code) show the win: keep an
  **ARCHIVE of candidate harness variants** (source + score + execution trace), benchmark each, and
  keep the best — population-based exploration instead of one greedy line. Meta-Harness's proposer
  specifically reads "the source code, scores, and execution traces of ALL prior candidates through a
  filesystem" to propose the next. Distinct from the existing "Falsifiable-prediction gate (AHE)"
  item (that gates a SINGLE linear commit on its predicted-vs-actual delta): this is about MAINTAINING
  ALTERNATIVES so a bad branch can be abandoned, not just detected. For Neko: the loop already writes
  `~/.neko-core/bench-log.jsonl` (per-commit bench deltas) and STATE.md — extend it to keep a small
  **candidate archive** (`~/.neko-core/harness-archive/`): before each proposer run, snapshot the
  current head's `git rev-parse HEAD` + its bench delta + a one-line trace; let the proposer (the
  `neko run` task) READ the archive (its prior candidates' diffs + deltas) so it proposes informed
  variants rather than amnesiac linear edits; on a commit that benchmarks WORSE than the prior head,
  `git revert`/reset instead of stacking on top. **Verify** (scripts-level, no agent-loop change):
  (1) a test that after N proposer runs the archive holds N entries (hash + delta + trace), none lost;
  (2) a test where a stubbed "bad" improvement (passes typecheck but regresses bench) is committed
  then DETECTED on the next benchmark and reverted (the loop returns to the prior head, not the
  drifted one) — the linear loop today would keep the regression; (3) a test that the proposer's
  system prompt embeds ≥1 prior candidate's delta (it is not amnesiac). Pure self-improve-harness
  logic — no `src/` change. NB: keep the archive bounded (top-K by score) so it doesn't grow
  forever; this is the machinery AHE's "experience-observability" + DGM's "archive" both assume.
- [ ] **Plan-execution misalignment detector + textual-gradient replan (PIVOT).** Neko's loop is
  PLAN-LESS at runtime: the model streams tool calls, and the only "plan" is whatever `todo_write`
  items it optionally wrote (never enforced) plus the `lastSig`/`repeats` doom-loop guard. Nothing
  detects that execution has DIVERGED from the model's own stated plan — e.g. the todos say "1. fix
  agent.ts, 2. update tests, 3. bench" but the model has spent 8 steps editing `tools.ts` (a different
  file) chasing a build error — so it silently drifts, burning the budget on off-plan work, with no
  mechanism to notice and re-plan. PIVOT (Zhang et al., arXiv 2605.11225, May 2026) names this
  plan-execution misalignment and fixes it with a **structured "textual gradient"**: after executing,
  INSPECT the trajectory against the plan, compute the discrepancy as a loss, and if non-zero,
  EVOLVE (re-plan) rather than continue the stale plan — up to **94% relative improvement in
  constraint satisfaction** and **3-5× fewer tokens** than competing refinement. Training-free
  (runtime trajectory refinement via environment feedback). Distinct from EVERY existing backlog
  item: "Broad doom-loop detection" / "Tool-error recovery" fire on REPEATS/ERRORS (tactical);
  "Pre-completion verify gate" fires once at EXIT; "Event-driven re-grounding" re-states the
  original TASK verbatim (no notion of a PLAN). This compares the LIVE trajectory against the model's
  OWN `todo_write` plan and replans on divergence. For Neko: every `k` steps, if a `todo_write` plan
  exists, run a lightweight INSPECT pass — compare the tools/paths actually touched in the last `k`
  steps against the current `todo_write` items (are we touching files relevant to the active todo?
  have we spent >m steps without completing any todo?); on divergence, `appendSystem()` a
  "textual-gradient" nudge: "Your recent steps (<summary>) don't match your plan (<current todos>).
  Re-plan: either update the todos to match what you're actually doing, or return to the planned
  work." (reuse existing `appendSystem` plumbing). **Verify**: (1) a unit test where a stub provider
  writes a `todo_write` plan then emits `k` steps touching OFF-PLAN paths — assert the divergence
  nudge fires exactly at step `k` and contains both the actual-summary and the plan-reference (assert
  it does NOT fire when steps match the plan, or when no todos exist, or when `k` not reached); (2) a
  test that completing a todo (writing the matching `[x]`) resets the divergence counter (no nag after
  on-plan progress); (3) a trajectory test where the stub would drift off-plan into a budget limit —
  assert WITH the detector it returns to plan and finishes within budget. Bench: flat-or-up pass-rate,
  fewer wasted off-plan steps; primarily a budget/correctness win on long, multi-step tasks. NB:
  gate behind an opt-in profile flag; the detector needs ≥1 `todo_write` to exist (no plan = no
  divergence to detect), so it composes naturally with the existing `todo_write` tool.

## Done
<!-- the loop appends:  [x] <item>  (commit <hash>, bench delta <±tok / ±pass>) -->

---
*If this list is empty or stale, the loop triggers a RESEARCH pass (web_search SOTA + new papers) and appends
fresh items here.*
