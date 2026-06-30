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

## How to turn a finding into work
1. Read the paper's core mechanism (1-2 sentences).
2. Find the closest existing Neko component (`compact()`, the tool schemas, the agent loop, a skill).
3. Write a SMALL, verifiable BACKLOG item: "change X so that Y, measured by Z (bench tokens / pass-rate)".
4. The loop implements it, the verify gate + bench dev-log confirm it actually helped (else revert).
