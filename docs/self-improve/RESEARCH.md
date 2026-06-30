# Research — SOTA techniques to apply (living document)

Grounding for self-improvement: the best current techniques from top labs/papers, and **how each maps to a
concrete Neko change**. When the loop is out of ideas, it runs a RESEARCH pass (web_search for the latest
SOTA + papers) and appends findings here, then turns the most promising into BACKLOG items. Keep entries
*actionable* — a finding with no Neko mapping is just trivia.

> Snapshot date of the seed entries below: **2026-06-30**. Re-research regularly; the field moves fast.

## Self-improving agents (the north star)
- **Darwin Gödel Machine (DGM)** — Zhang et al., ICLR 2026 ([arXiv 2505.22954](https://arxiv.org/abs/2505.22954)).
  An agent that **modifies its own code** and **empirically validates** each change on a coding benchmark
  (no formal proofs); grows an **archive** of agents and samples from it (population-based, open-ended).
  SWE-bench 20%→50%, Polyglot 14.2%→30.7%. It self-discovered: better edit tools, long-context management,
  peer-review of its own changes.
  → **Neko mapping:** (1) our loop already does empirical validation (verify gate + bench). (2) **ARCHIVE
  idea**: instead of one linear `self-improve` branch, keep several improved branches/commits and benchmark
  them — explore multiple harness variants in parallel, keep the best. (3) **peer-review**: a second model
  pass reviews each self-change before commit.
- **SWE-EVO** ([arXiv 2512.18470](https://arxiv.org/pdf/2512.18470)) — long-horizon software-evolution
  benchmark. → harder, realistic bench tasks beyond our self-contained ones.

## Self-improving agents — on-the-fly evolution (2025-2026 update)
- **Live-SWE-agent: Can SE Agents Self-Evolve on the Fly?** — Xia et al., Nov 2025
  ([arXiv 2511.13646](https://arxiv.org/abs/2511.13646)). Unlike DGM's *offline* archive/benchmark
  loop, it evolves the scaffold *at runtime*: a lightweight **step-reflection prompt** appended
  after each environmental feedback asks whether creating/revising a tool would help; the agent
  writes custom scripts (edit, search, repo-specific analyzers) that become first-class tools.
  **No offline eval, no revert-on-regression** — validated only by runtime environmental feedback.
  SWE-bench Verified **77.4%** (no test-time scaling).
  → **Neko mapping:** our loop is offline (verify gate + bench). The transferable idea is the
  *online* lever — a reflection nudge that turns reusable procedures into `.neko-core` skills/tools
  *during* a run. (See BACKLOG "Online skill synthesis via step-reflection nudge.")
- **GenericAgent: Token-Efficient Self-Evolving Agent via Contextual Information Density** — 2026
  ([HF 2604.17091](https://huggingface.co/papers/2604.17091)). Performance is set by
  *decision-relevant info density*, not context length. Four mechanisms: **hierarchical on-demand
  memory** (active context holds a compact *index* of what knowledge exists, not the knowledge;
  retrieved via tools on demand), self-evolution into reusable SOPs/code, minimal atomic tool set,
  active truncation/compression. ~30K working budget, ~6× smaller than peers.
  → **Neko mapping:** Neko already does progressive disclosure for *skills* (name+desc in prompt,
  body via the `skill` tool) and *memories* (listed by name, read on demand) — confirming that
  pattern pays. Remaining lever: project context (NEKO.md/CLAUDE.md) is still loaded *in full*
  upfront; an index+retrieve split is the unexplored win (caveat: the codebase map genuinely helps
  upfront, so scope carefully).

## Self-improving agents — harness-level evolution (2026-Q2 update)
- **Agentic Harness Engineering (AHE): Observability-Driven Automatic Evolution of Coding-Agent
  Harnesses** — Apr 2026 ([arXiv 2604.25850](https://arxiv.org/abs/2604.25850)). Distinct from
  DGM (which evolves the *agent* code) and ACE (which evolves the *context*): AHE evolves the
  *harness* — tools, middleware, long-term memory — and crucially pairs **every edit with a
  self-declared prediction that is later verified against task outcomes** (a "falsifiable
  contract"), so evolution is evidence-anchored rather than blind trial-and-error. Three
  observability pillars: *component* (every editable part has a file-level representation so edits
  are revertible), *experience* (raw trajectory tokens distilled into a layered drill-down
  evidence corpus), *decision* (the prediction/verify pairing). **Terminal-Bench 2 69.7%→77.0%**,
  beating Codex-CLI (71.9%); **+5.1–10.1pp cross-family transfer** without re-evolution;
  **12% fewer tokens** on SWE-bench. Key negative finding: **gains came from tools/middleware/
  memory, NOT the system prompt** — factual harness structure transfers, prose-level strategy
  does not.
  → **Neko mapping:** (1) **Decision-observability for our self-improve loop** — today the loop
  commits a change iff `typecheck + test + bench` pass (a pass/fail gate). AHE says: also have the
  loop *state a falsifiable prediction* ("this cut ~X% bench `in` tokens at flat pass-rate") and
  *check it against the actual bench delta* before keeping the commit — turning each item into a
  contract, not a vibe. (2) **Experience-observability** — distill our bench/trajectory logs into
  a small evidence corpus the loop reads before proposing (we currently re-derive from scratch).
  (See BACKLOG "Falsifiable-prediction self-improve gate" + "Trajectory-distilled evidence index.")
- **HyperAgents** (Meta) — critiques DGM's *hand-crafted, non-modifiable* meta-mechanism and
  proposes making the improvement *process itself* evolvable. → reinforces the AHE direction: the
  verify gate + bench (our meta-mechanism) should itself be a first-class editable, versioned
  component.

## Token efficiency / context engineering (direct token wins)
- **ACON** ([arXiv 2510.00615](https://arxiv.org/abs/2510.00615)) — optimize context compression by
  **iteratively refining compression guidelines from FAILURE analysis**; 26-54% peak-token cut *and* higher
  success; lets smaller models act as long-horizon agents (+46%).
  → **Neko mapping:** Neko's `compact()` + observation-masking are static. Make compaction **failure-aware**:
  when a turn fails or re-reads a clipped observation, learn what NOT to clip. Big token lever.
- **Active Context Compression / "Focus"** ([arXiv 2601.07190](https://arxiv.org/abs/2601.07190)) — autonomous
  memory management, -22.7% tokens at equal accuracy, up to -57% on some instances.
  → **Neko mapping:** an autonomous "what in context is still relevant?" pass before each step, not just at
  the 85%-full threshold.
- **Less Context, Better Agents: Efficient Context Engineering for Long-Horizon Tool-Using LLM Agents** —
  Lodha et al., Jun 2026 ([arXiv 2606.10209](https://arxiv.org/abs/2606.10209)). Two-move recipe on the
  tool-call/response part of the trajectory: (1) **sliding-window pruning** (keep only last `k` pairs),
  (2) **summarize the pruned-away history**. Result: ~64% fewer tokens *and* +20.6pp accuracy
  (summarization alone adds ~18K tokens for +12.6pp).
  → **Neko mapping:** a deterministic "tool-result clearing" rule in the agent loop — keep last `k`
  observation bodies verbatim, replace older ones with a one-line marker. Cheapest, safest token lever;
  distinct from ACON (which-to-clip) and Focus (relevance). (See BACKLOG "Tool-result clearing.")
- **LLMLingua** (token-level pruning of low-information tokens), **Gisting / AutoCompressor** (compress prompts
  into soft/summary tokens). → cheaper prompt pre-processing for large tool results.
- Five practical patterns (summarization chains, semantic dedup, structured extraction, ...) cut 30-70% of
  tokens. → audit Neko's system prompt + tool schemas + observations for dedup/structuring wins.

## Harness / scaffold engineering (2026 update — runtime loop levers)
> These come from the 2026 wave of "harness engineering" work (distinct from prompt/context): the *runtime
> middleware* around the model loop. Several map to small, high-leverage, unit-testable changes in Neko's
> `core/agent.ts`. (See the matching `## Research-seeded` BACKLOG items.)

- **Improving Deep Agents with harness engineering** — LangChain, 2026
  ([langchain.com/blog](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)). Took
  their coding agent **Top-30 → Top-5** on Terminal Bench 2.0 via five middlewares. The two most transferable:
  (1) **`LoopDetectionMiddleware`** — tracks per-file edit counts via tool-call hooks; if the agent edits the
  *same file* N times (a myopic "doom loop" repeating broken approaches), inject "reconsider your approach."
  (2) **`PreCompletionChecklistMiddleware`** — intercepts the agent before it can exit, forcing a verify pass
  against the task spec (re-run tests, compare against spec, not its own code). Also: LocalContext (env
  mapping), Doom-loop detection, and a "Reasoning Sandwich" compute budget (xhigh-high-xhigh reasoning across
  plan/implement/verify).
  → **Neko mapping:** Neko's loop guard only catches the *exact same* call 3×; a per-file-edit-cap + failing-bash
  counter is a strict superset and the single highest-leverage harness fix. And `run()` exits the instant the
  model stops calling tools — a verify-before-exit gate (mirroring the existing `runUntilDone` re-inspect prompt,
  but as a one-shot gate) closes the "declared done without checking" hole. (See BACKLOG "Broad doom-loop
  detection" + "Pre-completion verification gate.")
- **Tokenomics: Quantifying Where Tokens Are Used in Agentic Software Engineering** — Salim et al., MSR '26
  ([arXiv 2601.14470](https://arxiv.org/abs/2601.14470)). Maps token spend across SDLC stages (ChatDev +
  GPT-5). Findings: the iterative **Code Review / verification** stage burns **~59.4%** of tokens, and **input
  tokens are ~53.9%** of consumption — i.e. the cost is *re-feeding context in refinement loops*, not generation.
  → **Neko mapping:** empirically justifies prioritizing (a) the context-clearing / AgentDiet items (kill the
  re-fed junk) and (b) making the verify gate *cheap* (one re-inspect, not a full retry loop). Also a prompt to
  instrument Neko's own bench log by *stage* to find where its tokens actually go.
- **ACE: Agentic Context Engineering — Evolving Contexts for Self-Improving Language Models** — Zhang et al.,
  ICLR 2026 ([arXiv 2510.04618](https://arxiv.org/abs/2510.04618)). Treats contexts as **evolving playbooks**
  that *accumulate, refine, and organize* strategies via generation→reflection→curation — explicitly countering
  **brevity bias** (summaries dropping insights) and **context collapse** (iterative rewriting eroding detail).
  Adapts *label-free*, from natural execution feedback. +10.6% on agents.
  → **Neko mapping:** Neko's `playbook`/`memory`/`workflow` are *manually* written; ACE's structured
    curation-from-failures is the unexplored lever — and its "reflection-before-exit" is exactly the verify-gate
    idea. (See BACKLOG "Pre-completion verification gate"; informs a future "evolving playbook" item.)
- **Escaping the Context Bottleneck: Active Context Curation for LLM Agents via Reinforcement Learning**
  — 2026 ([arXiv 2604.11462](https://arxiv.org/abs/2604.11462)). Trains a tiny **ContextCurator** policy
  (a 7B model matches GPT-4o's context management) that, each step, splits working memory into **reasoning
  anchors** (sparse, decision-critical data to *keep*) vs **environmental noise** (to *prune*). WebArena
  36.4%→41.2% @ -8.8% tokens; DeepSearch 53.9%→57.1% @ **8× fewer tokens**. The key transferable idea is
  the *category distinction*, not the RL: most context is "noise" that's safe to drop, but a few anchors
  must survive every prune.
  → **Neko mapping:** Neko's `compact()`/`shrinkOldObservations` clip by *age/size* (KEEP_TAIL, line/char
  caps) — size-blind to *importance*. The unexplored lever: an **anchor-preserving compaction** that, at
  compact time, first *extracts the reasoning anchors* from the about-to-be-summarized head (error
  messages, target values, a stated decision) and *concatenates them onto the summary*, so compaction
  stops silently dropping the one number/error the rest of the task hinges on. Distinct from ACON
  (which-to-clip from failures) and "decision notes" (a separate file): this is *in-line* anchor tagging
  inside the existing summarizer prompt. (See BACKLOG "Anchor-preserving compaction.")
- **AgentDiet: Reducing Cost of LLM Agents with Trajectory Reduction** — Xiao et al., Mar 2026
  ([arXiv 2509.23586](https://arxiv.org/abs/2509.23586)). Identifies three waste classes in agent trajectories —
  **useless, redundant, expired** info — and strips them at inference time. **-39.9% to -59.7% input tokens,
  -21.1% to -35.9% total cost, same performance.**
  → **Neko mapping:** distinct from tool-result clearing (whole-result pruning) — AgentDiet targets *redundancy
  within* a kept observation (e.g. a build log restating errors, a file echoed twice). A future item: dedup
  repeated content inside large observations before they're re-fed each step.
- **SkillReducer: Optimizing LLM Agent Skills for Token Efficiency** — Gao et al., Jun 2026
  ([arXiv 2603.29919](https://arxiv.org/abs/2603.29919)). Empirical study of 55K skills: **26.4% lack a routing
  description, 60%+ of body content is non-actionable**. Two-stage fix: compress routing descriptions (+ generate
  missing ones via adversarial delta-debugging), restructure bodies into actionable core + on-demand supplementary
  (progressive disclosure). **48% description / 39% body compression AND +2.8% functional quality** (less-is-more).
  → **Neko mapping:** Neko skills already do progressive disclosure at the *skill* level; SkillReducer pushes it
    to the *description + body* level. (See BACKLOG "Skill description + body compression.")
- **Notation Matters: A Benchmark Study of Token-Optimized Formats in Agentic AI Systems** —
  Kutschka & Geiger, May 2026 ([arXiv 2605.29676](https://arxiv.org/abs/2605.29676)). JSON tool
  schemas/results carry structural token overhead (`"type"`, `"properties"`, braces) — purpose-built
  notations cut it. **TRON trims up to 27% of schema tokens at ≤14pp accuracy cost**; **TOON ~18% at
  ~9pp but cascades on multi-turn parse failures and breaks parallel tool calls** for most models. The
  methodological lesson: input-compression (does the model *understand* a compact schema?) and
  output-generation (can it *produce* one?) must be measured separately, and formats validated
  end-to-end in the loop, not just on isolated tasks.
  → **Neko mapping:** targets the *notation/format* of `tools.schemas()`, distinct from a content
  dedup audit. Use conservative OpenAI-compatible compaction (drop redundant `"type":"string"`
  defaults, shorten repetitive keys) rather than a foreign notation that breaks the chat template —
  and validate against the tool-call unit tests + bench, not just token count. (See BACKLOG
  "Tool-schema notation optimization.")

## Token efficiency / context engineering — 2026-Q2/Q3 update (RESEARCH pass)
> Three fresh angles from the latest wave, each mapped to a concrete `## Research-seeded` BACKLOG item.
> Chosen because none overlap the existing backlog (ACON/clearing/doom-loop/verify-gate/anchor-compaction/
> SkillReducer/AHE/TRON already cover the older levers).

- **Tool Attention Is All You Need: Dynamic Tool Gating and Lazy Schema Loading for Eliminating the
  MCP/Tools Tax** — Sadani & Kumar, Apr 2026 ([arXiv 2604.21816](https://arxiv.org/abs/2604.21816)).
  The MCP/eager-schema-injection overhead is a recurring per-turn tax (practitioner audits: ~10k-60k
  tokens). Their middleware keeps a compact **summary pool** (name + one-liner) in context and promotes
  full JSON schemas only for top-k gated tools (via an Intent-Schema-Overlap score + state-aware gate).
  Reported: per-turn tool tokens **47.3k -> 2.4k (-95%)**, effective context utilization 24% -> 91%.
  **Methodological caveat (flagged in the abstract):** end-to-end success/latency/quality numbers are
  *projections* from token counts + deployment telemetry, NOT measured on live agents — so any transfer
  must validate pass-rate empirically, not assume the -95% transfers to accuracy.
  -> **Neko mapping:** Neko *already* loads **MCP** tool schemas lazily via the `mcp_load` meta-tool
  (`adapters/mcp.ts`), but the **built-in** tools (`read_file/search/glob/ls/todo_write/write_file/
  edit/bash/web_search/web_fetch/skill/computer/...` + the large `browser_*` family) are injected in
  full every turn via `tools.schemas()`. Applying the same two-phase loader to the built-ins is the
  unexplored lever. (See BACKLOG "Lazy built-in tool-schema gating (the Tools Tax)." Distinct from the
  existing "Tool-schema notation optimization" item — that compacts the *format* of schemas that ARE
  sent; this drops schemas from the wire entirely.)
- **TokenPilot: Cache-Efficient Context Management for LLM Agents** — Xu et al., Jun 2026
  ([arXiv 2606.17016](https://arxiv.org/abs/2606.17016)). Identifies a trade-off prior work missed:
  text pruning / dynamic eviction *mutates the prompt layout*, causing **prefix mismatches and KV-cache
  invalidation** — so "saving" tokens can *raise* latency/cost by forcing the provider to re-process the
  prefix from scratch. Dual-granularity fix: **Ingestion-Aware Compaction** (stabilize the prefix,
  remove environmental noise at the ingestion gate before it enters the trajectory) +
  **Lifecycle-Aware Eviction** (offload segments only when task-relevance expires, on a conservative
  batch-turn schedule). **-61% / -87% cost** (isolated / continuous mode) at competitive accuracy.
  -> **Neko mapping:** `compact()` mutates the *head* of `messages` (summarizes old turns in place,
  rewrites the system text), busting the prefix cache every compaction. The lever: never rewrite the
  stable prefix — append a summary message instead, and clip noisy tool results at the ingestion gate
  (`safeExecute`) before they ever join `messages`. Distinct from ACON/anchor-compaction (which decide
  *what* to summarize): this is about *where the mutation happens* (tail, not head) to preserve cache.
  (See BACKLOG "Prompt-prefix cache stability during compaction.")
- **Building Effective AI Coding Agents for the Terminal (OpenDev): Scaffolding, Harness, Context
  Engineering, and Lessons Learned** — Bui, Mar 2026 ([arXiv 2603.05344](https://arxiv.org/abs/2603.05344)).
  A Rust terminal coding agent — same product class as Neko. Among its mechanisms, the freshest is
  **event-driven system reminders** that counteract **instruction fade-out** (the model losing sight of
  the original task as context grows) by "injecting targeted guidance at the point of decision rather
  than relying solely on the initial system prompt." (Other transferable mechanisms it lists — dual
  planner/executor split, lazy tool discovery, adaptive compaction, cross-session memory — Neko already
  has analogues.) The "instruction fade-out" framing has become a widely-cited 2026 meme
  ([Cobus Greyling, Mar 2026](https://cobusgreyling.substack.com/p/instruction-fade-out-is-the-silent)).
  -> **Neko mapping:** Neko re-injects an "Ongoing goal" only via the *manual* `/goal` slash command
  (`ui/commands.ts`); there's no automatic periodic re-grounding of the original `instruction` during a
  long `run()`. The lever: every `k` steps + right after each `compact()`, `appendSystem()` a short
  verbatim reminder of the original task. Distinct from the existing "Pre-completion verification gate"
  (fires once, at exit): this is *periodic*, *during* the run. (See BACKLOG "Event-driven task
  re-grounding against instruction fade-out.")
- **A Self-Improving Coding Agent (SICA)** — Robeyns, Szummer, Aitchison, Apr 2025
  ([arXiv 2504.15228](https://arxiv.org/abs/2504.15228)). The *same thesis* as DGM (an agent that edits
  its own code and empirically validates each change) but **eliminates the meta-agent/target-agent
  distinction** — a single agent loop edits its own codebase directly. SWE-bench Verified subset
  **17% -> 53%**. Cited here as grounding (the SWE-EVO survey frames DGM + SICA together); our loop is
  already SICA-shaped (the agent edits its own src + verifies), so no new BACKLOG item — but it
  confirms the architecture and is worth noting as prior art for the existing self-improve items.

## Token efficiency / context engineering — 2026-Q3 update (RESEARCH pass)
> Three fresh angles, none overlapping the existing backlog (governance/compaction safety,
> project-context cost, and delegation-time tool narrowing are all new). Chosen for verifiability:
> each maps to a unit-testable `## Research-seeded` BACKLOG item.

- **Governance Decay: How Context Compaction Silently Erases Safety Constraints in Long-Horizon
  LLM Agents** — Chen, Jun 2026 ([arXiv 2606.22528](https://arxiv.org/abs/2606.22528)). Names a
  failure mode prior compaction work missed: in-context **governance constraints** (policies,
  guardrails, "never do X") that an agent obeys while visible are **silently dropped by the
  summarizer**, after which the *same* agent does the now-unseen prohibited action. Across 1,323
  episodes / 7 model families (ConstraintRot benchmark): **0% violations with policy visible → 30%
  after compaction (59% worst-case models)**; when the constraint survives the summary → 0%, when
  dropped → 38%. A **Compaction-Eviction Attack** (adversarial in-context content biases the
  summarizer to drop a legit policy) defeats *every* evaluated model. Fix: **Constraint Pinning**
  (training-free) — quarantine governance text out of lossy compaction; **restores 0% violations**.
  Distinct from ACC/anchor-compaction (which preserve *task* facts): this is about *policy*
  constraints surviving the prune.
  -> **Neko mapping:** Neko's `compact()` summarizes the whole head (agent.ts summarizer prompt:
  "task, key decisions, files changed, current state") with **zero notion** of governance text;
  permission modes / safety policy live in the system prompt and are *not* quarantined from the
  prune. The lever: a **pinned-constraint list** (a small marker-delimited block in the system
  prompt, e.g. `<!-- pinned -->NEVER run rm -rf / web.<!-- /pinned -->`) that `compact()` extracts
  *before* summarizing and re-injects verbatim into every post-compaction message, so compaction
  can never erase it. (See BACKLOG "Constraint pinning across compaction (Governance Decay).")
- **Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?** —
  Gloaguen, Mündler, Müller, Raychev, Vechev, Feb 2026 ([arXiv 2602.11988](https://arxiv.org/abs/2602.11988)).
  Directly pressures Neko's own project-context design (NEKO.md/CLAUDE.md loaded in full upfront).
  Across SWE-bench + a novel developer-committed-file set: providing repo-level context files
  **does not generally improve task success**, **increases inference cost >20% on average**, and —
  critically — **"repository overviews" (the most popular, provider-recommended component) provide
  no measurable benefit**. Only instructions specifying **non-standard coding practices** help.
  (iwoszapar.com's 20-paper synthesis corroborates: AI-*generated* context files *hurt* success
  ~3%, human-written help ~4%, both add >20% cost.)
  -> **Neko mapping:** the current NEKO.md/CLAUDE.md design injects the full codebase *map*
  (exactly the "repository overview" this paper flags as no-benefit) upfront on every run. The
  unexplored, *evidence-backed* lever: **measure** the cost/benefit of the full upfront map vs a
  *one-line index + on-demand retrieve* split (pointers to where info lives, fetched only if a turn
  needs it) — the paper predicts the index split cuts the fixed per-run token tax without losing
  success (and may gain, since over-retrieval hurts). Distinct from the lazy-tool-schema item (that
  drops *tool schemas*): this drops *project-context prose*. (See BACKLOG "Project-context
  index/retrieve split (AGENTS.md evaluation).")
- **When Child Inherits: Modeling and Exploiting Subagent Spawn in Multi-Agent Networks** — Cai,
  Zhang, Hei, May 2026 ([arXiv 2605.08460](https://arxiv.org/abs/2605.08460)). Models the `task`
  sub-agent delegation as an **inheritance** problem and finds current frameworks (incl. Claude
  Code / Gemini CLI style) violate trust boundaries in four ways: **insecure memory inheritance**
  (parent→child carries instructions/states the parent didn't intend to delegate), weak resource
  control, stale post-spawn state, improper termination authority. The lens: **scope should
  *attenuate* per delegation hop** — each spawn *narrows* the permitted actions/context, never
  widens — but most frameworks pass the parent's full tool set + context wholesale. (Reinforced by
  the "context isolation as a product primitive" framing in Gemini CLI subagents, Apr 2026.)
  -> **Neko mapping:** Neko's `task` tool (chat.tsx `registryRef.subagent`) spawns a fresh
  `ToolRegistry` that inherits the parent's **full** built-in tool set (read/write/edit/bash/web/
  ...) + all MCP tools + hooks — the spawn does **not** narrow which tools the child may use, only
  swaps the system prompt for a named role. The lever, per the paper: let a delegation **specify a
  reduced tool allowlist** (and drop the parent's full message history — already isolated) so a
  read-only "researcher" sub-agent literally cannot `edit`/`bash`/`rm`, even via inherited hooks.
  Two wins: (a) a *token* win (fewer tool schemas serialized for the sub-agent's loop), and (b) a
  *correctness/safety* win (a scoped child can't drift into actions outside its role). (See BACKLOG
  "Sub-agent scope attenuation via per-delegation tool allowlist.")

## Token efficiency / context engineering — 2026-Q3 update #2 (RESEARCH pass)
> Three fresh angles, none overlapping the existing backlog. One per axis: token efficiency
> (TACO — line-level observation compression), context correctness (LCM — lossless compaction),
> harness middleware (Self-Harness — tool-error recovery). Each maps to a unit-testable
> `## Research-seeded` BACKLOG item.

- **TACO: A Self-Evolving Framework for Efficient Terminal Agents via Workflow-Adaptive
  Observation Compression** — Liu et al., Apr 2026 ([arXiv 2604.19572](https://arxiv.org/abs/2604.19572)).
  Training-free, **line-level** compressor for terminal output with a **critical/non-critical
  gate**: any observation with an explicit error/exception/failure signal is passed through
  *unchanged*; only non-critical output is compressed by *pattern rules* (regex trigger + keep/strip
  patterns, seeded for `apt/pip/npm install`, `git clone`, compiler output; rules self-evolve
  across tasks via a global confidence-ranked pool). Cuts a 10,071-char `apt-get install` log to 73
  chars (99.3%) while keeping the final status. **TerminalBench: +2-6pp accuracy, ~10% per-step
  token cut on >200B models; SWE-Bench Lite 56.3→57.1% at 308M→271M tokens; DevEval 38.1→39.7% at
  37M→27M tokens.** Key ablation: dropping the cross-task global rule pool costs 18% tokens; the
  self-evolution is what generalizes across repos.
  -> **Neko mapping:** Neko's `shrinkOldObservations` clips by *size* (40-line / 8K-char caps) —
  size-blind to signal, so it either trashes a short error trace or keeps install-log spam verbatim.
  The unexplored, **distinct** lever (vs "Tool-result clearing" which drops *whole old results*,
  ACON/anchor-compaction which protect *task facts in the summary*, AgentDiet which dedups *within*
  a kept result): compress the **noise lines inside** an otherwise-kept observation, gated by
  criticality. Seed rules + an `isCritical()` regex guard are cheap and unit-testable. (See BACKLOG
  "Workflow-adaptive, critical-gated observation compression (TACO).")
- **LCM: Lossless Context Management** — Voltropy, Feb 2026 ([arXiv 2605.04050](https://arxiv.org/abs/2605.04050)).
  Reframes compaction as **lossless**: raw messages are persisted to an immutable store; the active
  context carries *summaries with pointers*, and a `lcm_expand`/`lcm_grep` tool restores the
  verbatim original on demand. A hierarchical DAG (not a flat overwrite) gives multi-resolution
  drill-down, and a scope-reduction invariant (a sub-agent must declare delegated vs retained work,
  or the spawn is rejected) guards against infinite delegation. **Volt beat Claude Code v2.1.4
  +4.5pp avg on OOLONG (74.8 vs 70.3), widening to +12.6pp at 512K tokens.**
  -> **Neko mapping:** Neko's `compact()` is **destructive** — it summarizes the head in place,
  throwing raw observations away forever; if the summary dropped a needed detail (exact path, error
  string) the agent must re-run the tool. The **distinct** lever (vs "Anchor-preserving compaction"
  which keeps a *static* anchor block, vs "Decision notes" which is a separate *session* file):
  **reversibility of the prune** — snapshot the compacted block to `~/.neko-core/session-*/` and add
  a safe `recover_context` tool. The win is correctness on tasks that today force an expensive
  re-run, at flat-or-down tokens (recovery fires rarely). (See BACKLOG "Lossless compaction with
  on-demand recovery (LCM `expand`).")
- **Self-Harness: Harnesses That Improve Themselves** — Haidar et al., Jun 2026
  ([arXiv 2606.09498](https://arxiv.org/abs/2606.09498)). Same self-improvement thesis as DGM/AHE/SICA
  (an agent edits its own harness and empirically validates each edit) but its **Weakness Mining →
  Harness Proposal → Proposal Validation** loop surfaced a concrete, broadly-transferable middleware
  the prior wave missed: **tool-error-triggered recovery**. When a tool errors, inject a redirect
  ("do NOT delete/rerun blindly — diagnose the cause, recreate/repair the needed artifact, validate
  it, then proceed") instead of letting the agent flail (retry, edit around it, delete the partial
  output it still needs). This single edit took **Qwen3.5-35B 20.3%→36.7% on Terminal-Bench-2
  (a 16pp swing)** — the largest of Self-Harness's validated changes. Overall: M2.5 40.5%→61.9%,
  Qwen3.5-35B 23.8%→38.1%, GLM-5 42.9%→57.1%. Distinguishing principle: every edit must specify the
  targeted behavior, modified surface, motivating evidence, and evaluation result — no generic prompt
  lengthening.
  -> **Neko mapping:** Neko's doom-loop guard trips only on the *exact same* call 3×; it never fires
  on the subtler, common loop where a tool *errors once* and the agent flails into a budget blowout.
  The **distinct** lever (vs "Broad doom-loop detection" which counts repeats-per-path, vs the
  "Pre-completion verification gate" which fires once at exit): fire a *recovery-oriented* system
  prompt **on the first qualifying tool error** (non-zero bash exit, refused write, tool exception),
  reusing the existing `appendSystem` nudge plumbing. Primarily a correctness/budget win on
  error-prone tasks. (See BACKLOG "Tool-error-triggered recovery middleware (Self-Harness 'artifact
  middleware').")

## Token efficiency / context engineering — 2026-Q3 update #3 (RESEARCH pass)
> Three fresh angles, none overlapping the existing 24-item backlog. One per axis:
> compute efficiency (Ares — per-step reasoning effort), turn efficiency (W&D —
> parallel-tool width), context correctness (Context Rot — dilution from re-feeding
> unchanged content). Each maps to a unit-testable `## Research-seeded` BACKLOG item.

- **Ares: Adaptive Reasoning Effort Selection for Efficient LLM Agents** — Mar 2026
  ([arXiv 2603.07915](https://arxiv.org/abs/2603.07915)). Thinking/reasoning models
  (GPT-5, Claude, GLM with extended thinking) achieve high accuracy via long
  chain-of-thought, but the reasoning tokens are spent at a FIXED effort the operator
  configures once — so every step (trivial `ls` and hard debug alike) burns the same
  thinking budget. Ares inserts a lightweight router that predicts the LOWEST reasoning
  level (high/medium/low) needed for EACH step from the interaction history, reserving
  high effort for inherently hard steps (complex navigation/planning) and dropping to low
  for mechanical ones. **Reduces reasoning token usage up to 52.7% with minimal accuracy
  loss** (TAU-Bench tool use, BrowseComp-Plus deep research, WebArena). Ares's router is
  a *trained* classifier; the transferable idea for a training-free harness is the
  *per-step* effort allocation itself, driven by step type.
  -> **Neko mapping:** Neko sends ONE fixed `cfg.effort` for the whole run
  (`adapters/providers.ts` `reasoning_effort` payload + `adapters/anthropic.ts`
  thinking budget; user changes it manually via `/effort`). The unexplored lever:
  allocate effort *per step* by the step's tool signature — low for read-only
  inspection steps, high for edit/build/planning steps. No existing backlog item touches
  reasoning effort. (See BACKLOG "Per-step adaptive reasoning effort (Ares).")
- **W&D: Scaling Parallel Tool Calling for Efficient Deep Research Agents** — Feb 2026
  ([arXiv 2602.07359](https://arxiv.org/abs/2602.07359)). Argues that scaling *width*
  (multiple tool calls in a single reasoning step, using the model's intrinsic parallel
  tool calling) beats scaling depth or multi-agent orchestration for many workloads —
  both raising accuracy AND cutting the number of turns (hence context re-feeds).
  **GPT-5-Medium + W&D 62.2% > GPT-5-High 54.9% on BrowseComp** (weaker model + width
  beats stronger model + serialization). The paper also surfaces a width/depth trade-off
  (over-wide batches can mis-coordinate) — width helps most for *independent* calls.
  (Reinforced by the PASTES line of work, arXiv 2603.18897, which hides tool latency via
  speculative parallel execution, -43.5% task time — a serving-system take on the same
  "serialized loops expose tool latency" problem.)
  -> **Neko mapping:** Neko's loop ALREADY fan-outs a tool batch via `Promise.all` when
  every call is concurrency-safe (`CONCURRENCY_SAFE` in `core/agent.ts`), but WHETHER the
  model emits a parallel batch is left to its own judgment, with NO nudge in the system
  prompt. The cheap lever: a one-line system-prompt nudge to batch independent read-only
  inspections into one turn (the fan-out machinery already exists — no loop change). No
  existing backlog item targets turn-count or tool batching. (See BACKLOG "Parallel-tool-
  width nudge for independent reads (W&D).")
- **Context Rot: How Increasing Input Tokens Impacts LLM Performance** — Chroma Research,
  Jul 2025 ([trychroma.com/research/context-rot](https://www.trychroma.com/research/context-rot)).
  Evaluated 18 SOTA models (GPT-4.1, Claude 4, Gemini 2.5, Qwen3, ...) on how input
  length/composition degrades performance. Two distinct harms: **distractors** (topically-
  related near-miss content that misleads) and **dilution** (mere irrelevant bulk —
  performance falls with input length even with NO distractors). Focused ~300-token
  prompts beat ~113K-token full prompts across all models, *even with thinking enabled*;
  the Claude family shows the largest focused-vs-full gap. Critically: it's not just
  WHETHER info is present, but HOW MUCH non-essential bulk surrounds it. (Earlier
  needle-in-haystack work had missed this by using only retrieval tasks, where position is
  neutral; for reproduction/synthesis tasks, early placement of critical content helps.)
  -> **Neko mapping:** Neko re-feeds tool results verbatim every turn until age-based
  pruning — including a re-read of a path whose content is byte-identical to an earlier
  read in the same trajectory (pure dilution, zero new signal). The unexplored, distinct
  lever (vs "Tool-result clearing" which drops old results by AGE, vs TACO which compresses
  NOISE LINES inside a kept result): elide a whole *unchanged duplicate* re-read by hashing
  (tool, args) -> result and replacing an exact-equal repeat with a one-line marker. Exact-
  equality only (never fuzzy) — the paper shows fuzzy/semantic near-matches are where the
  dangerous distractor degradation lives. (See BACKLOG "Mutation-aware stale-read elision
  (Context Rot 'dilution').")

## Token efficiency / context engineering — 2026-Q3 update #4 (RESEARCH pass)
> Three fresh angles, none overlapping the existing 27-item backlog. One per DISTINCT axis:
> token efficiency (ToolCaching — idempotent-call memoization), self-improvement machinery
> (Meta-Harness — archive-and-search over harness variants), and trajectory correctness (PIVOT —
> plan-execution misalignment detection). Each maps to a unit-testable `## Research-seeded`
> BACKLOG item.

- **ToolCaching: Towards Efficient Caching for LLM Tool-calling** — Zhai, Shen, Luo, Yang, Jan 2026
  ([arXiv 2601.15335](https://arxiv.org/abs/2601.15335)). Identifies that parallel/async execution
  (the W&D / PASTES axis the prior pass covered) still leaves an unaddressed waste class:
  **redundant/repeated tool-calling requests** with identical or equivalent arguments, which are
  re-executed every time. A feature-driven, adaptive cache (VAAC: bandit-based admission +
  value-driven multi-factor eviction over frequency/recency/value) serves repeats from the cache.
  Reported: **up to +11% cache hit ratio, -34% end-to-end latency** vs. standard policies. The key
  transferable idea is the (tool, args) → result memo for cacheable calls, not the eviction policy.
  -> **Neko mapping:** Neko's `safeExecute()` (`core/agent.ts`) re-runs every call fresh — a re-issued
  deterministic `search`/`glob`/read-only `bash`/`web_search` re-executes AND re-appends its full
  result to context (double cost). The distinct lever (vs "Mutation-aware stale-read elision," which
  hashes the OUTPUT to elide a re-FEED and still runs the tool): key on the INPUT args and skip the
  re-EXECUTION of idempotent tools entirely — a wall-clock + token win. (See BACKLOG "Idempotent-
  tool-call result caching (ToolCaching).")
- **Meta-Harness: End-to-End Optimization of Model Harnesses** — Lee, Nair, Zhang, Lee, Khattab,
  Finn (Stanford IRIS), Mar 2026 ([arXiv 2603.28052](https://arxiv.org/abs/2603.28052)). An
  outer-loop system that SEARCHES over harness code (the code that decides what to store/retrieve/
  present to the LLM) using an agentic proposer that accesses the **source code, scores, and
  execution traces of ALL prior candidates via a filesystem** — so each proposal is informed by the
  full history of tried variants, not an amnesiac edit. Results: **+7.7pp over a SOTA context manager
  at 4× fewer tokens** on online classification; +4.7pp across 5 held-out models on IMO-level math;
  discovered harnesses **surpass the best hand-engineered baselines (incl. ACE) on Terminal-Bench-2**
  (#1 at time of submission). Distinct from AHE (which evolves a SINGLE harness linearly with
  per-edit predictions): Meta-Harness keeps an ARCHIVE of candidates and benchmarks them
  head-to-head — population search, not greedy descent. (Reinforces DGM's archive idea from the
  north-star section.)
  -> **Neko mapping:** Neko's self-improve loop (`scripts/self-improve.ts`) is strictly linear — one
  branch, each commit stacked on the last, no way to keep a divergent variant or abandon a bad one.
  The distinct lever (vs the existing "Falsifiable-prediction gate," which judges ONE linear commit):
  maintain a small **candidate archive** (hash + bench delta + trace per variant) that the proposer
  READS before proposing, and revert a commit that benchmarks worse than its parent instead of
  stacking drift. Pure self-improve-harness logic — no `src/` change. (See BACKLOG "Self-improve-loop
  candidate archive + best-keep (DGM/Population).")
- **PIVOT: Bridging Planning and Execution in LLM Agents via Trajectory Refinement** — Zhang, Popa,
  Xu, Song, Dimitriadis, May 2026 ([arXiv 2605.11225](https://arxiv.org/abs/2605.11225)). Names
  **plan-execution misalignment**: an agent commits to a plan (e.g. a todo list) then, during
  execution, drifts onto off-plan work without any mechanism to notice the divergence, burning budget.
  Four stages — PLAN (candidate trajectories) → INSPECT (execute, compute a structured **"textual
  gradient"** encoding the plan-vs-execution discrepancy) → EVOLVE (re-plan from the gradient, not the
  stale plan) → VERIFY (final constraint check); a monotonic-acceptance rule keeps only
  non-decreasing-quality solutions. Training-free (runtime trajectory refinement via environment
  feedback); **up to +94% relative constraint satisfaction, 3-5× fewer tokens** than competing
  refinement; effective fully autonomously.
  -> **Neko mapping:** Neko has no runtime plan: `todo_write` items are optional and UNENFORCED, and
  nothing compares the live trajectory against them — so the model can spend 8 steps editing an
  off-plan file with no nudge. The distinct lever (vs "Broad doom-loop"/"Tool-error recovery," which
  fire on tactical repeats/errors; vs "Pre-completion verify gate," which fires once at exit; vs
  "Event-driven re-grounding," which re-states the original TASK with no notion of a PLAN): every `k`
  steps, INSPECT the tools/paths actually touched against the current `todo_write` items and, on
  divergence, `appendSystem()` a textual-gradient nudge to re-plan. (See BACKLOG "Plan-execution
  misalignment detector + textual-gradient replan (PIVOT).")

## How to turn a finding into work
1. Read the paper's core mechanism (1-2 sentences).
2. Find the closest existing Neko component (`compact()`, the tool schemas, the agent loop, a skill).
3. Write a SMALL, verifiable BACKLOG item: "change X so that Y, measured by Z (bench tokens / pass-rate)".
4. The loop implements it, the verify gate + bench dev-log confirm it actually helped (else revert).
