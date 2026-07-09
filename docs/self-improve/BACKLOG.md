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

- [ ] **End-user search onboarding ladder (Docker optional) — docs + UX.** (Owner, 2026-07-03: "để sau".)
  Today's finding: Docker Desktop idles ~5.7GB RAM for SearXNG; the INDEX->VERIFY skill architecture makes
  DDG-only correct for catalog price surveys, so Docker is a per-session power-up, not a dependency. TODO
  when picked up: document the 3-tier ladder (default DDG / TAVILY_API_KEY / `neko setup web` + Docker) in
  README + a first-run hint; consider a gentle in-chat hint when searxng_url is configured but unreachable
  ("start Docker Desktop or remove searxng_url"). Verify: docs render + the hint fires only in that state.

- [x] **MCP lazy-CONNECT (spawn on first call) — the top LOCAL-perf item.** *(done same day — spec cache
  keyed by name+config-hash registers the tool surface without spawning; ensureClient connects on first
  use; `neko mcp` stays live via connectPending. Measured: 513MB/3 processes -> 233MB/1 process (-55%),
  zero children for non-browsing runs. Unit-tested incl. cache-hit no-spawn + config-change miss.)*
  Original finding: a live
  `neko run` tree = 513MB RAM, of which **~277MB is the browser-MCP server spawned even when the run never
  calls a browser tool** (bunx runner 161MB + node 116MB), plus its spawn latency on EVERY run. `mcp_lazy`
  removed the TOKEN tax; the PROCESS tax remains. Fix: defer `connectAll` per server until its first
  tool/schema request (mcp_load or a call); doctor/`neko mcp` still connect eagerly to enumerate. Verify:
  a run that uses no MCP tool spawns no MCP child (assert via process list in a test or a spawn-count
  hook); a run that calls one connects lazily and works; RAM of a trivial run drops ~250MB+.
- [x] **MCP child-process cleanup (orphan hygiene).** *(done same day, honest scope: close() now
  TREE-kills stdio children by transport pid — the SDK killed only its direct child and the bunx->node
  chain orphaned grandchildren; plus lazy-connect removes the spawn entirely for non-browsing runs, so
  the observed leak paths are closed. NOT covered: a hard-killed run that was actively browsing can
  still orphan — no in-process fix exists for SIGKILL; acceptable residual.)* Found 2026-07-03: 28
  orphaned `node mcp/server`
  processes saturating the machine (flaked the queue UI test) — every `neko run` spawns stdio MCP
  children (the browser MCP from config), and a killed/timed-out neko (eval spawnSync timeout, Ctrl+C,
  crash) orphans them. Fix: tie child lifetime to the parent (Windows Job Objects / POSIX process
  groups + kill-on-exit in McpHub.close and a signal handler), so no run can leak servers. Verify: spawn
  a run with a connected MCP, SIGKILL it, assert no `mcp/server` child survives; plus McpHub.close kills
  children on normal exit.
- [ ] **Mobile arc: Neko on Android (owner discussion 2026-07-03).** Phase 1 MVP: run the existing
  `neko-linux-arm64` release binary under Termux+proot, storage via termux-setup-storage, chat via the
  relay web client pointed at localhost -> "find/summarize documents on the phone" works with ZERO new
  code. Phase 2: termux-api + adb-wireless-loopback as a `phone` skill/MCP (config-first). Phase 3 (big):
  an AccessibilityService companion app exposing ui-snapshot/tap/type as MCP tools — the mobile leg of
  the structure-grounded computer-use strategy (a11y tree = the phone's DOM). iOS: relay client only;
  full third-party phone control is blocked by platform policy (Shortcuts bridge at most — be honest).

- [ ] **Long-horizon benchmark tier (the real capability discriminator).** Found 2026-07-03: BOTH the easy
  (16/16) and the new hard (12/12) bench tiers saturate at 100% for glm-5.2 — bounded coding pass-rate no
  longer discriminates harness quality. Per METR HCAST (task horizon = the SOTA metric: longest task at 50%
  success, doubling ~every 4mo), the discriminating signal is MUCH longer horizon: a multi-file feature
  with interacting parts + a full test suite (15-25 steps), a migration across N call sites, a bug that
  only surfaces after a refactor. Build 3-5 such tasks (deterministic verifiers) where even a strong model
  fails ~30-60% — THEN harness improvements (TDD/debugging skills, verify gate) show measurable lift.
  Complementary: wire skill-context into the bench so `test-driven-development`/`systematic-debugging` lift
  is measurable (bench currently runs skill-less). Verify: a task set where glm-5.2 is <100% and a harness
  change moves it.

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
  pass-rate flat. *(2026-07-10: the multimodal subset is now real - when context relief fires, it keeps
  the two newest tool images and replaces older base64 images with a marker, while never touching user
  attachments. General text-result clearing remains open and still needs the benchmark.)*
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
- [x] **Broad doom-loop detection (per-file edit cap + repeated-failure nudge).** *(already landed via the
  loop - `editsPerPath` + `consecutiveUnproductive` in core/agent.ts with BROAD-loop-guard tests in
  test/agent.test.ts; checkbox reconciled 2026-07-02.)* The current
  `lastSig`/`repeats` guard only catches the *exact same* tool call 3× in a row — it misses the
  far more common loop where the agent edits the same file `N` times with *different* args chasing
  a stubborn build error, or re-runs a failing `bash`/test 3× with tiny tweaks. Track (a) edits per
  path (write_file/edit/multi_edit) and (b) consecutive failing bash/test results; on threshold
  (e.g. 3 edits to one path, or 3 failed bashes in a row) inject the same "reconsider your
  approach" nudge the loop guard already uses. (LangChain `LoopDetectionMiddleware` took Top-30→Top-5
  on Terminal Bench this way; it's the single highest-leverage harness fix.) Verify: a unit test
  where a stub provider emits 3 distinct edits to ONE path — assert the nudge observation fires
  (the old guard does NOT trip on distinct calls) and that no real edit runs past the nudge.
- [x] **Pre-completion verification gate (force a verify pass before exit).** *(landed as the opt-in
  `verifyBeforeExit` agent option with unit coverage; config wiring is shared by CLI/TUI/subagents.)* `run()` returns the
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
- [x] **Tool-error-triggered recovery middleware (Self-Harness "artifact middleware").** *(done 29e7c95,
  2026-07-02, owner-directed: [recovery] diagnose->repair->validate directive on the FIRST failure of a
  mutating tool (bash/write/edit; read misses stay benign), edge-triggered - a success re-arms, persistent
  failure stays the unproductive-streak guard's job; appended as a tool message so the prompt prefix stays
  cacheable. +2 unit tests.)* Neko's doom-loop
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

- [x] **Parallel-tool-width nudge for independent reads (W&D).** *(done d8822d4, 2026-07-03, owner-directed
  speed sprint: BATCH-independent-reads rule in the system prompt; fan-out machinery + tests already
  existed. Live effect tracked via the errand A/B — the item's stub-provider turns-test isn't meaningful
  with a scripted stub, recorded honestly.)* Neko already fan-outs a tool
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

- [x] **Volatile-field stabilization of the system-prompt prefix (Don't Break the Cache).** *(done 7fa916d,
  2026-07-02, owner-directed: env block = session-start snapshot (dirty-count dropped, memoized), todos out
  of the system message (recited in-stream by todo_write), + beyond the item's scope: explicit Anthropic
  cache breakpoints w/ self-heal and cached_tokens metrics in cost/bench. Honest live verdict: Z.ai accepts
  cache_control but attributes 0 cache reads today - the win is measured on providers that report it.)*
  `adapters/context.ts` `environmentBlock()` (line ~103) injects a `Date: <today>` line AND a
  `git status --porcelain` dirty-count into the `<env>` block that is concatenated into the
  SYSTEM PROMPT — so that prefix CHANGES EVERY TURN (the date ticks; a single edit flips the
  dirty-count from `0` to `1`), which invalidates the provider's prompt-prefix (KV) cache and
  forces the next request to re-process the entire prefix from scratch. *Don't Break the Cache*
  (Lumer et al., arXiv 2601.06007, Jan 2026) names this as the #1 prefix-cache killer —
  "embedding timestamps, datetime strings, session identifiers, or user-specific information at
  the beginning of the prompt instantly invalidates the prefix match" — and shows prompt caching
  cuts long-horizon agentic cost **41-80%** (GPT-5.2 -79%, Claude Sonnet 4.5 -78%) when the prefix
  is stable. **Distinct from the existing "Prompt-prefix cache stability during compaction
  (TokenPilot)" item**: that one fixes `compact()` *rewriting the head* mid-run; this fixes
  *volatile fields in the stable static prefix that change every turn even with zero compaction*.
  The two compose: a stable static prefix (this item) + a non-destructive append compaction
  (TokenPilot) = a fully cache-friendly trajectory. For Neko: (a) move the `Date:` line OUT of the
  prefix entirely — either drop it (the model rarely needs the calendar date to code) or push it
  into a late/volatile region; (b) drop the dirty-file-COUNT from the env block (keep `branch`,
  drop the `(N uncommitted changes)` suffix, or move it to a tail user-message), so the static
  prefix is byte-stable across turns; (c) audit `bin/neko.ts`/`ui/chat.tsx` for any OTHER per-turn-
  varying text (random IDs, wall-clock) concatenated into the system message and freeze/relocate it.
  **Verify**: (1) a unit test that builds the system prompt twice with a clock advanced by 1 day +
  a faked edit, and asserts the STATIC PREFIX is byte-identical between the two (fails today — the
  `Date:` line + dirty-count differ); (2) a test that the env block still reports branch + cwd +
  model (no loss of useful info, just no per-turn churn); (3) if the provider reports
  `cached_tokens` in `usage`, an adapter-level test over two consecutive `complete()` calls with
  unchanged prefix asserts cache hit rises (fallback proxy: assert the message array's prefix is
  stable across steps); (4) bench: `cached_tokens` up, total `cost` down, pass-rate flat. NB: some
  providers require a *minimum prefix length* (e.g. OpenAI ≥1024 tokens) before caching engages —
  no code change needed, just note it; and prefix-cache semantics are provider-specific, so gate on
  whether the active provider reports cache metrics, else assert prefix-stability as the proxy.

- [ ] **Per-step model cascade — cheap-model-first, escalate only on failure (SLM-probe/RouteLM).**
  Neko runs ONE model for the entire `run()`: `cfg.model`/`getProvider(cfg)` is fixed for the whole
  agent loop, so a frontier model burns full cost on every step — including the many mechanical
  read-only steps (`read_file`/`search`/`glob`/`ls`/a known `bash` command) where a cheap model
  would emit an equivalent tool call. *Model cascading* (surveyed in Moslem & Kelleher, arXiv
  2603.04445, 2026; RouteLLM Ong et al. 2025; MixLLM Wang et al. 2025) is the established win:
  attempt each step on a SMALL/cheap model, and escalate to the configured frontier model ONLY when
  the cheap step fails or produces low-confidence output — reported **24-84% cost reduction at
  parity quality** (R2-Reasoner -84.46% API cost at competitive accuracy; MixLLM 97.25% of GPT-4
  quality at 24.18% of cost; SLMs match LLM performance on the top-20% high-confidence queries).
  **Distinct from the existing "Per-step adaptive reasoning effort (Ares)" item**: Ares dials the
  THINKING budget on ONE model (a compute knob); this swaps the MODEL ITSELF between a cheap and a
  frontier tier per step (a cost-tier knob). The two compose. For Neko, the transferable,
  training-free proxy (the SLM-probe router is trained; AutoMix-style self-verification is not):
  (1) let a profile declare an optional `cascadeModel` (a cheap/fast model) alongside the main
  `model`; (2) in the agent loop, route READ-ONLY steps (those whose tool calls are all in the
  `CONCURRENCY_SAFE`/read-only set — `read_file/search/glob/ls/web_search/web_fetch`) to the
  cheap model first; (3) escalate to the frontier model for write/edit/build steps, tool-less
  planning/final-synthesis turns, OR when the cheap model's step errored/produced no usable tool
  call (AutoMix-style self-verification: if the cheap step's output is malformed or the tool call is
  rejected, re-run the step on the frontier model and continue from there). This reuses the existing
  per-`complete()` provider indirection — no loop-structure change, just a per-step provider choice.
  **Verify**: (1) a unit test with a stub "cheap" provider + stub "frontier" provider recording
  which handled each step; assert a pure-read step goes to the cheap model and a write step goes to
  the frontier model; (2) a test that a read step whose cheap-model output is malformed/erroring
  escalates to the frontier model on the next `complete()` (and the trajectory continues correctly);
  (3) a test that with NO `cascadeModel` configured, every step uses the single configured model
  (no regression to today's behavior); (4) bench: `cost` drops (cheap tier handles read-heavy
  tasks) at flat-or-up pass-rate — the escalation guard must keep pass-rate from regressing. NB:
  ship behind an **opt-in** `cascadeModel` profile flag so a wrong step classification (cheap model
  botches a read the frontier would've nailed, but it doesn't error) is a per-task quality toggle,
  not a default breakage; and different models may use incompatible chat templates / the cheap
  model may not support `reasoning_effort` — the adapter already self-heals on rejected fields,
  verify that path under the cascade.

- [ ] **Budget-aware early-stop of doomed trajectories (BAGEN).** Neko's only resource guard is a
  hard `maxSteps` cap (`core/agent.ts`): the loop runs flat-out until the model stops calling tools
  OR `maxSteps` fires — at which point it forces ONE more `complete()` asking for a summary. There
  is zero notion of a TOKEN/cost budget, and NO mechanism to ABORT a trajectory the agent is clearly
  not going to complete — so a run that's doomed (stuck in a hard bug, a missing dependency, an
  impossible spec) burns the FULL step+token budget before the hard stop, and the only signal to the
  operator is the final `[stopped: reached max_steps]` string. BAGEN (Lin et al., arXiv 2606.00198,
  May 2026) shows the budget-aware signal is **already present and training-free in frontier
  models**: a simple early-stop policy that aborts when the model signals a trajectory is
  infeasible saves **28-64% tokens on failed trajectories** (GPT-5.2 -64.1%, Gemini 3.1 -55.7%,
  Claude Sonnet 4.6 -49.6%, Qwen3 -38.8%) at only **1.6-4.2pp** overall success cost — the
  transferable, training-free lever (SFT+RL only sharpens it). **Distinct from the existing
  "Broad doom-loop detection"** (counts repeats-per-path, tactical), **"Tool-error recovery"**
  (single-error redirect), **"PIVOT"** (plan-vs-execution divergence), and **"Pre-completion verify
  gate"** (one-shot exit check): none of them ABORT a whole trajectory on a *feasibility/dead-end*
  signal, and none are token-budget-aware. For Neko: (1) support an optional `tokenBudget` (and/or a
  `costBudget`) on `run()`/profile, tracked against the existing `agent.cost.totalTokens` each step;
  (2) add an opt-in early-stop probe: every `k` steps, append a brief user-role feasibility check
  ("Given remaining budget R and current state, can this task still be completed? Reply with
  `FEASIBLE` or `INFEASIBLE: <reason>`.") reusing the existing `appendSystem`/turn plumbing — on an
  `INFEASIBLE` verdict (or on `cost` crossing `budget` with the step still incomplete), stop the loop
  EARLY and return a structured `stopped: budget-exhausted/infeasible` result with the model's stated
  reason, instead of grinding to `maxSteps`. (3) Near the budget ceiling, steer rather than abort:
  mirror BAGEN's "request more resources / wrap up" — when remaining budget < threshold, nudge the
  model to SUMMARIZE progress + open questions and stop, not start fresh sub-tasks. **Verify**: (1)
  a unit test where a stub provider emits an `INFEASIBLE` verdict at step `k`; assert the loop stops
  at step `k` (NOT `maxSteps`) and the result carries the reason (assert it does NOT early-stop on a
  `FEASIBLE` verdict, nor when the probe is off); (2) a test that crossing a configured `tokenBudget`
  triggers the wrap-up/stop with `agent.cost.totalTokens <= budget + oneStepTolerance` (no budget
  blowout); (3) a test that with NO budget/probe configured, behavior is identical to today (hard
  `maxSteps` only — no regression); (4) a trajectory test where the stub would loop to `maxSteps` on
  an unsolvable task — assert WITH the probe it stops early at lower token cost. Bench: on a
  deliberately-unsolvable task, `outTok`/`calls` drop sharply at ~flat pass-rate on the solvable
  ones (early-stop only fires on doomed runs). NB: ship behind an **opt-in** `tokenBudget`/probe
  flag; the probe adds a periodic extra turn, so gate its cadence (`k`) to avoid overhead on short
  tasks; BAGEN finds frontier models alert TOO LATE (>70% feasibility even at 60% budget consumed),
  so a pure self-poll may under-trigger — the *hard token-budget* ceiling is the reliable backstop,
  the feasibility poll is the bonus.

- [x] **Pre-flight tool-argument validation + self-repair (Gecko).** *(landed 2026-07-03:
  required schema fields are validated before execution and a repair hint is returned; unit-tested.)* When the provider returns a
  tool call, its `arguments` are trusted verbatim: `adapters/providers.ts` line ~230 (and
  `adapters/anthropic.ts` line ~102) do `JSON.parse(fn.arguments)` and on a parse failure silently
  coerce to `{}` (Anthropic) or `{ _raw }` (providers) — so a malformed/partial JSON call, or a
  call MISSING a required key, is dispatched straight into `tools.execute()`, which then throws
  inside `safeExecute()` and the model gets `Error running X: missing required argument: path` as a
  *post-hoc* observation. That's a wasted full round-trip per malformed call (the whole growing
  context is re-fed just to learn the arg was wrong). Gecko (Zhang et al., arXiv 2602.19218) shows
  the fix: validate tool **name + arguments against the schema BEFORE execution**, and on a
  validation failure let the model **self-repair** from a stateful feedback observation instead of
  executing. For Neko: after parsing `tool_calls` but BEFORE the `for (const call of ...)`
  dispatch in `run()`, run each call's args through the tool's JSON schema (a small
  `validateArgs(tool, args)` that checks required keys are present + non-empty + correct primitive
  type — reuse the existing `requireArg` logic generalized); on failure, emit a structured
  observation like `Argument validation failed for <tool>: missing/invalid <key> (<schema hint>) —
  re-emit the call with corrected arguments` and CONTINUE the loop (no execute), giving the model a
  cheap self-repair turn. Distinct from the existing doom-loop/recovery items (those fire AFTER a
  tool runs and errors): this catches the call BEFORE it ever executes. **Verify**: (1) a unit
  test where a stub provider emits a `read_file` call missing `path` — assert `execute()` is NEVER
  called (a spy/counter) and the validation-observation is fed back; (2) a test that a well-formed
  call dispatches normally (no regression); (3) a test that a parse-failed `arguments` string (no
  longer silently `{}`) yields a clear validation error, not a downstream `Error running`;
  (4) bench `calls` drop on tasks prone to malformed calls (fewer wasted execute+error round-trips)
  at flat-or-up pass-rate. NB: ship behind an **opt-in** profile flag (`validate_tool_args`) so a
  too-strict validator (rejecting a legit-but-unusual arg) is a toggle, not a default breakage;
  keep validation to required-key + primitive-type checks (cheap, deterministic), not full JSON
  Schema evaluation.

- [ ] **No-op-edit detection + "fail-plausible" output guard (Silent Failures).** Neko's edit tools
  have NO notion of a *silent failure*: an action that produces no error AND no real progress, or
  one where the model transforms a failure into a fluent success narrative. Two concrete gaps:
  (1) `multi_edit`/`edit` (`tool-runtime.ts` lines ~778-787) reject a missing/non-unique
  `old_string` but NOT `old_string === new_string` — a no-op edit writes an identical file and
  returns `Edited <path> (1 edits, +N -N)`, i.e. a *success* signal for zero change, which the
  model reads as "the edit landed." (2) More broadly, *When Errors Become Narratives* (Wu, arXiv
  2606.14589 — a longitudinal study of 22 silent-failure incidents in a production agent runtime)
  finds ~70% of silent failures are caught only by human observation, not tests, and the most
  dangerous class is **chained hallucination**: an LLM turns an error/empty result into a
  plausible-sounding success ("fail-plausible"). For Neko: (a) in `edit`/`multi_edit`, if
  `oldStr === newStr` (after trim normalization) return `Error: edit ${k+1} is a no-op (old_string
  === new_string) — no change written` instead of a success; (b) (the cheap "fail-plausible" guard)
  when `write_file` would overwrite a path with byte-identical content, return a `no change` marker
  instead of a success; and (c) when a `bash`/`search`/`read_file` result is empty (0 bytes) or
  matches a known no-signal shape, tag the observation `[empty result]` so the model can't silently
  narrate over a void. Distinct from the doom-loop/recovery items (which fire on REPEATS or ERRORS)
  and the pre-completion verify gate (one-shot at exit): this flags the *absence of a signal* at the
  tool-result boundary. **Verify**: (1) a unit test calling `edit` with `old_string === new_string`
  asserts it returns the no-op error and does NOT write the file (fails today — it writes + reports
  success); (2) a test that `write_file` of identical content returns the no-change marker and
  skips the write; (3) a test that a 0-byte bash output observation carries the `[empty result]` tag;
  (4) a test that a genuinely-changing edit still writes + reports success (no regression). No
  bench-token target — this is a *correctness* guard; bench pass-rate should be flat-or-up (fewer
  tasks where the model believes a no-op edit fixed the bug). NB: the no-op check is cheap and
  deterministic — ship it ON by default (it only ever rejects a true no-op); the `[empty result]`
  tag is additive, never lossy.

- [ ] **Recurrence-based memory consolidation (RecMem).** Neko's `memory` tool (`core/tools.ts`
  line ~198: `list | read | write | delete | search`) and its storage
  (`~/.neko-core/memory/*.md`) are a pure **append-only KV store**: every `write` creates or
  overwrites a whole file. There is no notion that a new `write` might be a DUPLICATE or
  near-duplicate of an existing memory, and no merging — so the store accumulates overlapping
  entries (three "user prefers X" notes across sessions), and `search` re-surfaces all of them,
  inflating the cross-session context the agent recalls before working. RecMem (Dai et al., arXiv
  2605.16045) cuts this: store incoming interactions, and only **consolidate (merge + summarize)**
  a memory when a semantically-similar interaction RECURS — skipping heavy processing when no
  similar cluster exists; reported to cut memory-construction token cost **up to 87% at higher
  accuracy**. Distinct from every existing backlog item (none touch the `memory`/`workflow` store)
  and from in-session "decision notes" (a single-session file): this is *cross-session dedup +
  merge* of the durable memory store. For Neko, the training-free proxy: on `memory write`, before
  persisting, (a) run a cheap text-similarity pass (token-overlap / keyword Jaccard, NO embedding
  model — keeps it local-first and dependency-free) against the existing memory bodies; (b) if a
  high-similarity match exists, MERGE the new note into that file (append a line, or rewrite the
  merged body) instead of creating a new file; (c) if no match, write a new file as today.
  Optionally: tag memories with a last-touched date so an LRU sweep can prune truly stale entries
  (the "decay" lever). **Verify**: (1) a unit test where two `write` calls with near-identical
  content (same keywords) result in ONE merged file (not two) — assert the store has 1 entry and
  both facts are present; (2) a test that two clearly-distinct `write`s still create two files (no
  false-merge — the dangerous failure mode); (3) a test that `search` returns the single merged
  entry once (no duplicate recall); (4) bench: on a multi-session workload that records overlapping
  memories, the recalled-context token count drops at flat-or-up task pass-rate. NB: keep the
  similarity threshold conservative (merge only on HIGH overlap — a false-merge that drops a fact
  is worse than a duplicate); ship behind an **opt-in** profile flag (`consolidate_memory`) so a
   too-aggressive merge is a toggle; no external embedding API (keeps the local-first guarantee).

- [ ] **Scoped sub-trajectory folding with recovery (Context-Folding).** Neko has exactly two ways to
  shed context mid-run, and neither collapses an *ad-hoc span within the parent's own trajectory*:
  (a) `compact()`/`shrinkOldObservations` summarize the *whole head* by age/size (global), and
  (b) the `task` sub-agent isolates an *entire* sub-run in a fresh context and returns just its
  result string (whole-context delegation). So when the parent itself does a long exploratory burst
  (read A → search B → read C → grep D → read E to understand one module), the only way to drop that
  burst's bulk is to wait for global `compact()` — which also rewrites everything older, busts the
  prefix cache, and risks summarizing away a needed detail. Context-Folding (Sun et al., arXiv
  2510.11967, Oct 2025 — **10x smaller active context at matched-or-better accuracy than ReAct,
  outperforming summarization-based methods**) lets the agent *procedurally branch into a
  sub-trajectory and then fold it on completion, collapsing the intermediate steps while retaining a
  concise summary of the outcome.* Distinct from EVERY existing item: `compact()` and its anchor/
  cache/lossless/constraint variants touch the *global head prune*; `task`-scope-attenuation narrows
  a *separate delegated agent*; LCM-lossless makes the compact() prune *recoverable* but doesn't add
  an in-trajectory fold. This is a **first-class, agent-initiated fold marker** inside the parent's
  own `messages`. For Neko: (a) add a lightweight `fold_context` tool (SAFE) that takes an optional
  `summary` arg — when invoked, it snapshots the messages *since the last fold/turn boundary* to
  `~/.neko-core/session-<id>/fold-<n>.jsonl`, replaces that span in `this.messages` with ONE summary
  message (the agent-supplied summary, or a one-line marker), and returns the fold id; (b) reuse the
  LCM-style recovery tool (the existing "Lossless compaction" item's `recover_context`) to restore a
  named fold's raw steps verbatim on demand. Crucially the fold is **opt-in and agent-driven** (the
  model decides a sub-investigation is done), not an automatic size trigger — so it composes with,
  not replaces, `compact()`. **Verify**: (1) a unit test that seeds `messages` with a 6-message
  exploratory span, calls `fold_context` with a summary, and asserts the span collapses to exactly
  ONE summary message in `messages` while the raw 6 are persisted byte-identical to the fold file;
  (2) a test that `recover_context(fold-n)` returns those raw 6 messages (fails today — no fold
  exists); (3) a test that a fold marker survives a subsequent `compact()` (it's already a summary,
  not re-summarized away); (4) a behavioral test where a stub provider does a long read-burst then
  folds — assert WITH fold the post-fold `estimateTokens(this.messages)` is materially lower than
  WITHOUT, at flat-or-up pass-rate. NB: ship behind an **opt-in** profile flag (`scoped_folding`);
  the fold's summary quality is the risk (a bad summary drops a detail) — mitigated by the recovery
  tool, so the verify gate must assert recovery round-trips, not just that the fold shrinks context.

- [ ] **Failure-taxonomy evidence corpus for the self-improve proposer (How-Coding-Agents-Fail).**
  Neko's self-improve loop (`scripts/self-improve.ts`) generates candidate improvements from a
  *rotating GOALS list* + the BACKLOG, and judges each via a pass/fail verify gate + a qualitative
  peer-review of the *diff*. What it has NO access to is a **grounded taxonomy of how coding agents
  actually fail in the wild** — so the proposer can't target the highest-prevalence, growing failure
  classes; it proposes whatever the static GOALS list cycles to. *How Coding Agents Fail Their Users*
  (Tang et al., Notre Dame/Vanderbilt/Google, arXiv 2605.29442, May 2026 — **20,574 real sessions**)
  quantifies the two dominant, *growing-over-time* failure classes that current reward signals
  under-measure: **S3 Developer Constraint Violation (38.33% of failures, the #1 class, 73.68%
  caused by instruction-following failure)** and **S7 Inaccurate Self-Reporting (22.58% — the agent
  claims success without verifying; only 2.99% self-correct, 91.49% need explicit developer
  pushback)**. Both are *directly measurable in Neko's own loop* and map to concrete harness levers
  Neko does NOT yet have: (i) a **constraint-adherence check** (does the agent obey stated
  scope/policy mid-run? — distinct from the existing *Governance-Decay* item, which is about
  constraints SURVIVING compaction; this is about constraints being HONORED at decision time), and
  (ii) an **honest-status / no-false-completion check** (distinct from the existing *Pre-completion
  verification gate*, which forces a re-inspect before exit; this flags a CLAIMED-done that the
  trajectory doesn't support). Distinct from the existing self-improve items: the *falsifiable-
  prediction gate* judges one commit's *bench delta*; the *candidate-archive* keeps variants —
  neither ingests a *failure-evidence corpus* to steer WHAT gets proposed. For Neko (a scripts/
  self-improve-harness change, no agent-loop edit): (1) distill the S3/S7 signal definitions into a
  small `docs/self-improve/FAILURE-TAXONOMY.md` evidence file the proposer's task preamble loads
  (so it proposes "add a constraint-adherence check" / "add a false-completion detector" instead of
  a random GOALS rotation); (2) add a cheap **S7 self-report verifier** to the loop's own post-run
  check — after a `run()` that ended with a tool-less final answer, scan whether the final claim
  ("done"/"fixed"/"passes") is supported by the trajectory (was the test actually re-run? did the
  cited file get the cited edit?); log a SUPPORTED/UNSUPPORTED verdict to STATE.md. **Verify**
  (scripts-level, pure harness logic): (1) a test that the proposer preamble embeds the S3/S7
  definitions (the taxonomy file is read, not ignored); (2) a test where a stubbed run's final answer
  claims "tests pass" but the trajectory shows no test re-run since the last edit — assert the S7
  verifier logs UNSUPPORTED (and SUPPORTED when a test DID run post-edit); (3) a test that a run
  honoring a stated scope constraint ("only touch src/core/") logs no S3 violation while one that
  edits outside scope logs one. NB: this is *evidence-grounding* the proposer + a trajectory-level
  status check — keep the verifier heuristic/cheap (no extra model call per run by default; an
  opt-in model-based S7 judge is a later escalation).

- [ ] **Cost-aware cross-turn speculative tool pre-staging (Cost-Aware Speculative Execution).**
  Neko's loop is strictly sequential per turn: `complete()` → run the tool batch → `complete()` again
  (the only intra-turn concurrency is the W&D fan-out of *already-decided* concurrency-safe calls via
  `Promise.all`). So while the model is *generating* the next step (or while a slow tool like a big
  `bash` build / `web_fetch` runs), nothing is pre-staged for the *likely next* step — the agent pays
  the full latency of `read_file` of the path it's 90% about to read, only after it decides to. Cost-
  Aware Speculative Execution (Fareed, arXiv 2606.07846, Jun 2026) generalizes the speculative-
  execution idea to agent workflows with an **expected-value rule**: fire a downstream operation
  before its upstream completes, but only on **admissible** edges (side-effect-free / idempotent /
  stageable behind a commit barrier — wrong speculations roll back), pricing each speculation and
  gating on a failure-weighted expected value with a Bayesian success-probability estimate. Distinct
  from EVERY existing item: W&D grows *same-turn parallel width* (calls the model already decided on);
  ToolCaching memoizes *re-execution of an identical repeat*; Ares dials *effort*; PASTES (cited
  under W&D) is a *serving-system* latency-hider. This is **cross-turn eager pre-staging of a
  PREDICTED-but-not-yet-requested read-only call**, rolled back (result discarded) on a miss. For
  Neko (the cheap, training-free proxy — the paper's router is Bayesian; we use a rule): when the
  agent emits a tool batch, optionally **speculatively pre-run** the highest-probability *next*
  read-only call (seeded heuristics: after `search`/`glob` for `X`, pre-`read_file` the top-1 result;
  after editing `path`, pre-`read_file` the path to confirm — though that one's already likely);
  cache the result keyed by (tool, args); if the model's NEXT turn requests exactly that call, serve
  it from the cache (zero added latency) and drop the speculation cost; if not, discard (the only cost
  is the wasted tool execution — bounded, since only read-only/idempotent calls are eligible). This
  COMPOSES with ToolCaching (speculation seeds the cache; a cache hit IS a successful speculation).
  **Verify**: (1) a unit test that after a `search` result with a top-1 hit, the speculator pre-runs
  `read_file` on it and a FOLLOW-UP `read_file` of the same path is served from cache without
  re-execution (a spy/counter); (2) a test that a speculation whose predicted call is NOT made is
  discarded (no leak into `messages`, no cost charged beyond the wasted tool exec); (3) a test that NO
  mutating tool (`write_file`/`edit`/`bash`) is ever speculatively pre-run (admissibility — only the
  `CONCURRENCY_SAFE` read-only set is eligible); (4) bench **wall-clock** drops on read-heavy tasks
  (the latency win is the point — token cost is flat-or-down via cache reuse, NOT up, since a miss is
  discarded not appended) at flat-or-up pass-rate. NB: ship behind an **opt-in** profile flag
  (`speculative_prestage`); keep the heuristic conservative (pre-stage only top-1, only after
  `search`/`glob`, only read-only) so wasted exec is rare; a wrong speculation costs one tool run,
  never tokens-in-context (the result is discarded on miss, unlike a real call which is appended).

- [ ] **Pre-edit test-surfacing via a source↔test dependency map (TDAD).** Neko's loop has no notion
  of which *existing* tests a given edit will affect: `run()` (`core/agent.ts` line ~325) streams
  tool calls, and after a `write_file`/`edit`/`multi_edit` the agent is told nothing about the
  regression blast-radius — so it either (a) skips re-running tests and ships a regression, or
  (b) blindly re-runs the WHOLE suite (costly), never the targeted subset. The system prompt
  (line ~43) only says "VERIFY after bash/tests" generically. TDAD (Alonso, Yovine, Braberman,
  arXiv 2603.17973, Mar 2026) is the fresh SOTA fix and a direct result: build a **dependency map
  between source files and the tests that exercise them**, deliver it as a *lightweight agent
  skill (a static text file the agent queries at runtime)*, and **before/after committing a patch,
  the agent queries the map to know exactly which tests to verify and can self-correct**. Result on
  SWE-bench Verified (Qwen3-Coder-30B): **regressions 6.08% → 1.82% (-70%)**, AND issue-resolution
  **24% → 32% (+8pp)**. Critically, the paper found naive *procedural* TDD ("write a failing test
  first") is HARMFUL (regressions rose to 9.94%) — surfacing CONTEXT (the map) beats prescribing
  WORKFLOW. **Distinct from EVERY existing backlog item**: none touch test-to-source mapping; the
  "Pre-completion verification gate" forces *some* re-check at exit (undirected); this surfaces
  *which* tests are relevant to the just-touched code so the verify is targeted, not whole-suite.
  Training-free (a static skill + an agent query). For Neko: (1) generate the map ONCE per repo
  (a small script: parse imports/references from src/ + a test-runner's `--testNamePattern`/file
  association, or a cheap `grep -l "from '<src>'"` over the test tree) and write it to a
  `.neko-core/test-map.md` skill (or a `test_map` built-in that returns the relevant test files
  for a given changed path); (2) after any EDIT_TOOLS call, the loop (or a nudge) tells the agent
  "changed <path> — relevant tests per the map: <list> — run them," mirroring how the doom-loop
  nudge already fires on edits-per-path. Default: whole-suite fallback when no map exists. **Verify**:
  (1) a unit test that, given a seeded map, a `test_map`/query for an edited `src/core/tools.ts`
  returns the test(s) importing it (e.g. `test/tools.test.ts`) and NOT unrelated tests; (2) a test
  that the post-edit nudge observation contains the targeted test list (fires on EDIT_TOOLS only,
  not on reads); (3) a trajectory test where an edit breaks a previously-passing test the agent
  DIDN'T just touch — assert WITH the map+nudge the agent runs that test and catches the regression,
  and WITHOUT it ships the regression (the SWE-bench failure mode); (4) bench: regression rate
  (pre-existing tests broken by a change) drops at flat-or-up issue-resolution; token cost ~flat
  (targeted subset vs whole-suite should be CHEAPER, not costlier). NB: ship the map generator as a
  plain script (no runtime parser dep — keeps local-first); the map is advisory (the agent may still
  run more tests); keep it opt-in behind a profile flag so a stale/wrong map is a toggle, and
  regenerate the map on demand (it's a function of the source tree, not live state).

- [ ] **Execution-free patch/claim verification via semi-formal reasoning (Agentic Code Reasoning).**
  Neko's verification is ENTIRELY execution-based: the system prompt demands "VERIFY — re-run the
  test / re-read the file / re-run the build" (`core/agent.ts` line ~43), and `runUntilDone`
  (line ~231) re-inspects by *running* something. There is NO mechanism to judge whether a change
  is correct WITHOUT executing it — yet many changes (a refactor, a config tweak, a "does this fix
  the bug?") could be cheaply sanity-checked in-the-head before the costly build/test cycle, and
  some (an unbuildable WIP, a change to a file with no test) can't be execution-verified at all.
  Agentic Code Reasoning (Ugare & Chandra, arXiv 2603.01896, Mar 2026) introduces **semi-formal
  reasoning**: a *structured prompting* method that forces the agent to (1) state explicit
  **premises**, (2) **trace execution paths** symbolically, and (3) derive **formal conclusions**
  — a "certificate" the model *cannot skip cases or make unsupported claims* through. Training-free
  (pure prompting). Results: **patch-equivalence verification 78% → 88% (93% on real
  agent-generated patches)**, approaching execution-free reliability; +5pp Top-5 fault localization
  on Defects4J; 87% on code QA. **Distinct from EVERY existing backlog item**: all verify-gate /
  doom-loop / recovery / TACO items *execute* (run a tool) to verify; this verifies *by reasoning
  about the code symbolically*, with zero tool execution — a genuinely different axis. It's the
  pre-flight check BEFORE the build: cheap, catches "this can't possibly work" / "this changes
  behavior X didn't ask for" before burning a build+test round-trip. For Neko: (1) add a SAFE
  `verify_change` tool (or a pre-edit-gate option) that, given a changed path + the intent, runs a
  ONE-SHOT semi-formal reasoning pass — the prompt forces: "State premises (what the code assumes).
  Trace the execution path for the change. List cases that now behave differently. Conclude:
  CORRECT / REGRESSION-AT-<case> / UNCERTAIN." with a structured output; (2) on UNCERTAIN or
  REGRESSION-AT, steer the agent to fix before the build; on CORRECT, proceed to the (still-run)
  execution verify as the backstop. Crucially this COMPOSES with, doesn't replace, execution
  verification — it's a cheap first filter. **Verify**: (1) a unit/behavioral test where a stub
  change has a latent regression (e.g. an off-by-one the build won't catch) — assert the
  semi-formal pass flags REGRESSION-AT and the agent fixes it BEFORE the build step (count: build
  runs only after the reasoning pass says CORRECT); (2) a test that a genuinely-correct change
  passes the reasoning pass (low false-positive rate — don't block good edits); (3) a test the
  structured output (premises/trace/conclusion) is present (the certificate isn't skippable);
  (4) bench: `calls` (round-trips) drop on subtle-bug tasks (caught earlier, fewer build-fix-build
  cycles) at flat-or-up pass-rate. NB: ship behind an **opt-in** profile flag (`semiformal_verify`)
  — a reasoning pass that's wrong is just advice, but one that false-positives blocks progress, so
  keep it ADVISORY (steer, don't hard-gate) unless the conclusion is high-confidence REGRESSION;
  the prompt must be tight (the paper's value is the structure preventing skipped cases, not
  verbosity — keep it a focused certificate, not a free-form essay, or it becomes token-cost with
  no reliability gain).

- [ ] **Execution-verified best-of-N sampling for hard edit steps (test-time scaling).** Neko's
  `run()` takes the FIRST response on every step (`core/agent.ts` line ~351: one `complete()` call
  per step, first answer wins) — there is NO sampling of alternatives and NO selection. The
  existing `MoaProvider` (`adapters/providers.ts` line ~391) samples DIFFERENT MODELS in parallel
  and *aggregates* their advice (text synthesis), but it does not (a) sample the SAME model N times
  nor (b) SELECT among candidates via execution. So on a hard edit step (a tricky multi-hunk fix,
  a regex that won't quite match), the agent commits to its single first attempt and then
  iteratively debugs it across many steps (the exact doom-loop `EDIT_PER_PATH_CAP` catches) — when
  sampling N diverse attempts and keeping the one the BUILD/TESTS accept would reach a correct
  fix in one selection. This is the test-time-scaling win on SWE-bench (TTC scaling, Ma et al.,
  arXiv 2503.23803: a 32B model to 46% on SWE-bench Verified via sampling + execution-guided
  selection, surpassing 671B/o1; SWE-Master / DeepSWE likewise use candidate-patch selection via a
  verifier). TTC's selector is *trained* (reward model); the **training-free, harness-portable**
  proxy is: on a HARD edit step (gated — only when the prior attempt FAILED a build/test, or when a
  profile flag opts in), (1) sample N candidate edits from the same model at raised temperature;
  (2) **use the existing build/test run as the verifier** — execute each candidate (in isolated
  worktree copies / via `git stash`-and-apply), keep the first whose build+tests pass; (3) if none
  pass, fall back to the single-answer path (today's behavior) — no regression. **Distinct from
  EVERY existing backlog item**: MoA samples models (diversity of *source*) and aggregates text;
  this samples the SAME model (diversity of *sample*) and SELECTS via execution (diversity of
  *outcome*). Doom-loop/recovery items react to a single failing attempt; this proactively
  generates alternatives. Ares/cascade dial per-step *cost* on one answer; this spends more to get
  a better FIRST answer on hard steps. For Neko: (1) an opt-in `bestOfN` on `run()`/profile
  (default off — it multiplies cost on the gated steps); (2) the sampling reuses the provider's
  `temperature` (already configurable) — sample at temperature >0; (3) the selection reuses
  `git` (the repo is already a git workspace): stash, apply candidate-k, run the verify command,
  restore — pick the passing one. Gate tightly: only fire after a build/test FAILURE (the model is
  already stuck), or on an explicit hard-step marker, never on every step. **Verify**: (1) a unit
  test with a stub provider that returns N distinct candidate edits and a stub "build" whose pass
  condition matches only candidate-k — assert the loop selects candidate-k (not the first) and that
  only N executions ran; (2) a test that when NO candidate passes, `run()` falls back to the
  single-answer path (today's behavior — no regression, no infinite sampling); (3) a test that with
  `bestOfN` OFF, exactly ONE `complete()` runs per step (no sampling — today's behavior); (4) bench:
  on a hard-multi-hunk task, pass-rate UP (a correct sample is found) and `calls` DOWN (one
  selection beats N debug iterations) — but track `cost` (sampling costs more tokens; the win is
  pass-rate-per-dollar, not raw tokens). NB: this is the one item where **cost goes UP per gated
  step** — the value is correctness/throughput on hard tasks, not token efficiency, so the verify
  gate MUST measure pass-rate + dollar-cost together, not tokens alone; keep it strictly opt-in and
  failure-gated so it only spends extra where the cheap single-path already failed.

- [ ] **Executable skill guardrails that fire on failure-prone states (HASP/Skill Programs).** Neko's
    `playbook` (`core/playbook.ts`), `workflow` (`core/workflows.ts`), `memory` (`core/memory.ts`), and
    skills (`adapters/skills.ts`) are ALL **advisory text** -- injected into context (the playbook block
    every turn; skills/workflows on-demand via `appendSystem`) and left for the model to *choose* to
    heed. There is NO mechanism for a learned lesson to EXECUTE: to detect a specific failure-prone
    state in the live trajectory and automatically inject corrective context. HASP (Liu, Ming, Joty,
    Zhao, arXiv 2605.17734, May 2026) upgrades skills into executable **Program Functions (PFs)** that
    "activate on failure-prone states and modify the next action or inject corrective context" -- the
    inference-time variant is **training-free** (PFs wrap the existing loop) yet still gives **+25%
    over ReAct** on web-search reasoning. **Distinct from EVERY existing backlog item**: the
    doom-loop/tool-error/PIVOT/pre-completion items fire on a *hardcoded tactical signal* (repeats,
    an error, plan divergence); RecMem/decision-notes touch *storage*; this is a **user-learned rule
    that registers a TRIGGER (a matched state) + an ACTION (a corrective nudge to inject)** -- the agent
    can teach itself a new automatic guardrail the way it already teaches itself an advisory playbook
    bullet. For Neko, the transferable training-free proxy: (1) extend the `playbook` tool with an
    `add_guardrail` action storing a structured rule `{trigger: <regex/keyword on the latest
    observation or tool call>, action: <nudge text>}` in `~/.neko-core/guardrails.json`; (2) in the
    agent loop, after each tool observation, scan registered guardrails -- on a `trigger` match,
    `appendSystem()` the matched `action` text automatically (reusing the existing nudge plumbing), so
    a lesson like "when `bash tsc` reports TS2322, re-read the symbol's type definition before
    re-editing" fires WITHOUT the model having to recall it. The guardrail only INJECTS context
    (steers) -- it never auto-runs a tool -- so it stays safe-by-default. **Verify**: (1) a unit test
    that registers a guardrail `{trigger:"TS2322", action:"re-check the type"}`, runs a step whose
    observation contains "TS2322", and asserts the action text is `appendSystem`-injected on that turn
    (and a non-matching observation does NOT inject it); (2) a test that guardrails only fire on the
    matching turn, not every turn (no steady-state nag); (3) a test that `add_guardrail`/`list`/
    `remove` persist round-trip; (4) a behavioral test where the stub would doom-loop on a known error
    pattern WITH a registered guardrail for it -- assert the nudge fires and the loop does NOT repeat
    the failing call 3x (the old guard trips later); without the guardrail it loops. Bench: flat-or-up
    pass-rate on error-prone tasks, fewer wasted steps. NB: ship behind an **opt-in** profile flag
    (`executable_guardrails`); keep triggers user-editable and the registry bounded (cap K guardrails).

- [ ] **Stale-fact supersession in the memory store (Supersede).** Neko's `memory` tool
    (`core/memory.ts`) is append-only: `write` creates/overwrites a WHOLE file by name, with NO notion
    of FACT CURRENCY -- if a memory records "user prefers Tailwind v3" and the underlying fact changes
    (migrated to v4), the only fix is for the agent to recall the OLD note's filename and `write`/
    `delete` it by hand; nothing flags the v3 note as SUPERSEDED, and a later `memory search` happily
    re-surfaces the stale value. *Supersede* (Patel, arXiv 2606.27472, Jun 2026) measures exactly this
    gap: bounded self-maintained memory scores **77% vs 92% full-context** (the "supersession gap",
    p<0.005), worsening as the conversation grows (68% -> 28% over a 24x-longer run) -- agents reliably
    use a stale value when the current one isn't surfaced. The transferable, training-free lever is the
    *currency* mechanic, not the RL (which only sharpens it). **Distinct from EVERY existing backlog
    item**: RecMem (Q3 #6) merges *near-duplicate* notes by similarity; this targets a note whose
    VALUE is invalidated by a newer fact even when the wording differs -- a currency/timestamp layer,
    not dedup/merge. Decision-notes (Q2) is single-session. For Neko: (a) add an optional
    `superseded_by` field + `updated_at` timestamp to each memory (front-matter or a
    `~/.neko-core/memory/.index.json`); (b) on `memory write`, run a cheap keyword/entity-overlap pass
    against existing notes in the same TOPIC cluster (no embedding model -- local-first) and, on a
    high-overlap hit, mark the OLD note `superseded_by: <new name>` (keep history, do NOT delete) and
    have `memory search`/`list` surface only the CURRENT (non-superseded) value, demoting stale ones
    unless explicitly requested; (c) add a `memory supersede` action to explicitly invalidate a note by
    name. **Verify**: (1) a unit test: write "prefers Tailwind v3", then "prefers Tailwind v4" -- assert
    `list`/`search` returns ONLY the v4 note as current and v3 is marked superseded (still readable via
    `read`); (2) a test that two clearly-DISTINCT-topic notes do NOT supersede each other (no false
    invalidation -- the dangerous failure mode); (3) a test that explicit `memory supersede <name>`
    marks it stale without a new write; (4) a behavioral test where an outdated memory value would lead
    the agent to use the old convention -- assert WITH supersession the current value is the only one
    surfaced and the task uses it. Bench: recalled-context correctness up (no stale values acted on)
    at flat-or-up pass-rate; recalled token count ~flat. NB: keep the topic-similarity threshold
    CONSERVATIVE (supersede only on HIGH keyword overlap + matching entity); ship behind an **opt-in**
    profile flag (`memory_supersession`); never auto-delete, only demote.

- [ ] **Reasoning-skill cards distilled from the agent's own trajectories, recalled before a hard
    step (TRS).** Neko already has advisory lessons (`playbook`/`workflow`), but they are WRITTEN BY
    THE AGENT BY HAND after a task -- short, generic, and never automatically tied to a SPECIFIC hard
    step's signature. Ares (Q3 #3) dials *thinking effort* per step; it does not retrieve a *reusable
    solution sketch* for the step at hand. Thinking with Reasoning Skills / TRS (Zhao et al., arXiv
    2604.21764, Apr 2026) is the fresh SOTA and is **explicitly training-free and black-box
    compatible**: run the reasoning model on source problems, have a summarizer LLM distill each
    trajectory into a compact **skill card** (`Trigger / Do / Avoid / Check / Risk` + retrieval
    keywords), store them as plain key-value entries, and at inference **recall the relevant card(s)
    BEFORE reasoning** so the model avoids redundant detours. Reported (exact): math tokens **-18.5%
    to -59.1%** at flat-or-up accuracy; coding tokens **-10.3% to -33.9%** at flat-or-up pass@1, with
    the hardest subset accuracy lifting ~45% -> ~80% and tokens ~halved. Self-distilled from the
    agent's OWN traces -- no weight updates. **Distinct from EVERY existing backlog item**:
    `playbook`/`workflow` are manually-authored prose recalled at the agent's discretion; Ares is a
    per-step *compute* dial; this is **automatic distillation of a completed task's own trajectory into
    a structured card, then deterministic retrieval of the card whose `Trigger` matches the current
    step** (deterministic recall, not model discretion). For Neko (a `scripts/` offline distiller + a
    runtime recall hook, training-free): (1) an opt-in script that, after a `run()` on a hard task,
    prompts the model to distill the trajectory into a card (`Trigger / Do / Avoid / Check / Risk` +
    keywords) appended to `~/.neko-core/reasoning-skills.jsonl`; (2) at runtime, before a step that
    looks hard (a tool-less step, or an EDIT_TOOLS step after a prior failure), do a cheap keyword
    match of the current step's signature against card `Trigger`/keywords and, on a hit,
    `appendSystem()` the card -- steering the model toward the proven path without it rediscovering it.
    **Verify**: (1) a scripts-level unit test that a stub trajectory distills to a card with the 5
    fields + keywords, persisted to the jsonl; (2) a runtime test that a step whose signature matches a
    seeded card's `Trigger` gets the card `appendSystem`-injected, and a non-matching step does NOT
    (deterministic recall); (3) a test that recall is bounded (<=K cards) so context never bloats;
    (4) bench: `outTok` (reasoning tokens) drops on a repeated-similar-task workload at flat-or-up
    pass-rate, and on a SECOND run of a hard task the step count drops (the card short-circuits the
    first run's detours). NB: ship behind an **opt-in** profile flag (`reasoning_skill_recall`); keep
    the distiller offline/one-shot (gate to tasks the bench flags as hard or repeated); retrieval is
    keyword/BM25-style only (no embedding dep -- local-first).

- [ ] **Verifier-backed long-horizon computer-use eval pack (OSWorld 2.0 / QGP / OSGuard).** Before adding
    another planner or GUI framework, build a small local benchmark that exposes Neko's actual remaining
    failure modes: at least 12 disposable tasks spanning UIA controls, keyboard-only/custom controls,
    browser DOM/MCP, file+GUI hybrid work, a dynamic/late-arriving state change, user takeover, and a latent
    destructive shortcut. Each task gets (a) binary completion, (b) partial work-unit progress, (c) explicit
    safety invariants, and (d) action/step/time counts. Run baseline vs plan-exit gate vs `--loop`; require
    zero wrong-window typing, duplicate work units, secret entry, and unsafe completion. Only if the results
    show progress drift should the next change add a persisted verifier/evidence field or a dedicated backlog
    controller. **Verify:** repeat each task >=3x, publish aggregate completion/partial/safety/recovery rates,
    and keep the disposable WPF input probe as the deterministic smoke test for `type`/`key` focus safety.

## Done
<!-- the loop appends:  [x] <item>  (commit <hash>, bench delta <±tok / ±pass>) -->

---
*If this list is empty or stale, the loop triggers a RESEARCH pass (web_search SOTA + new papers) and appends
fresh items here.*
