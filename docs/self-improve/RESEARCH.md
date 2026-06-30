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
- **LLMLingua** (token-level pruning of low-information tokens), **Gisting / AutoCompressor** (compress prompts
  into soft/summary tokens). → cheaper prompt pre-processing for large tool results.
- Five practical patterns (summarization chains, semantic dedup, structured extraction, ...) cut 30-70% of
  tokens. → audit Neko's system prompt + tool schemas + observations for dedup/structuring wins.

## How to turn a finding into work
1. Read the paper's core mechanism (1-2 sentences).
2. Find the closest existing Neko component (`compact()`, the tool schemas, the agent loop, a skill).
3. Write a SMALL, verifiable BACKLOG item: "change X so that Y, measured by Z (bench tokens / pass-rate)".
4. The loop implements it, the verify gate + bench dev-log confirm it actually helped (else revert).
