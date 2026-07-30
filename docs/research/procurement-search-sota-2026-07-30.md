# Procurement search reliability — research checkpoint 2026-07-30

Status: active checkpoint  
Scope: live price research where the user gives attributes but no exact product code, with special
attention to highest/lowest-price claims.

## Incident reproduced

- [verified] The 2026-07-30 laptop run reproduced the missed-source failure on current `main`.
  The input was only `U9 + RTX 5070 + 16 inch`, so the agent correctly began with broad discovery.
  Websosanh then exposed exact identifiers including `83KY001VVN`. The next query was
  `"83KY001VVN" giá Xgear`: it coupled the newly discovered identifier to the merchant already known
  from the index instead of widening to the exact identifier across independent sources.
  confidence: high · observed 2026-07-30 · source: local Neko trajectory

- [verified] The active SearXNG endpoint was unreachable. Neko fell back to DuckDuckGo, where two
  long `site:a OR site:b ...` queries returned no results. The agent continued, but it had no explicit
  coverage ledger or deterministic sufficiency gate to prevent an over-broad market claim.
  confidence: high · observed 2026-07-30 · source: local Neko trajectory and `neko doctor`

- [verified] The current procurement skill already says “SKU first” and “supplement the aggregator”.
  The defect is therefore not missing intent. It is missing executable state transition and completion
  criteria: nothing forces a newly found identifier to become the next lexical query, records which
  discovery channels were attempted, or narrows the final claim when coverage is incomplete.
  confidence: high · observed 2026-07-30 · source: `skills/procurement/SKILL.md` and git history

## What the current research says

- [supported] Coverage-first decomposition plus predefined evidence sufficiency conditions reduces
  premature termination. Choubey et al. define objectives before execution and require each step to
  gather evidence until its completion criteria are met; their July 2026 ACL paper reports the strongest
  overall result among compared DeepResearch Bench systems, with ablations identifying step-level
  sufficiency and dependency-gated context as key contributors.
  confidence: high · 2026-07 · source:
  https://aclanthology.org/2026.acl-industry.116/

- [supported] Search reformulation should reuse identifiers discovered anywhere in accumulated evidence,
  not only terms from the latest result. A study of 14.44 million real agentic search requests found that
  54% of newly introduced query terms were traceable to accumulated evidence and recommends explicit
  cross-step context tracking and intent-adaptive budgets.
  confidence: medium · 2026-01-24 · source: https://arxiv.org/abs/2601.17617

- [supported] Exact lexical retrieval remains a strong tool once a product code is known. SAGE evaluated
  six deep-research agents over 1,200 questions and found BM25 roughly 30% better than the tested
  LLM-based retrievers in its setting because agents generated keyword-oriented subqueries. This is not
  an e-commerce result, but it directly argues against replacing exact SKU queries with semantic-only
  retrieval.
  confidence: medium · 2026-02-05 · source: https://arxiv.org/abs/2602.05975

- [supported] Separating task structure from an explicit evidence state improves targeted exploration.
  Microsoft Research's DualGraph keeps an outline graph and a knowledge graph, then uses missing
  relations to generate the next query; it reports a 53.08 RACE score with GPT-5 on DeepResearch Bench.
  For procurement, a small candidate/coverage ledger is the proportionate analogue of that knowledge
  graph.
  confidence: medium · ICML 2026, page dated 2026-02 · source:
  https://www.microsoft.com/en-us/research/publication/a-tale-of-two-graphs-separating-knowledge-exploration-from-outline-structure-for-open-ended-deep-research/

- [supported] Claim-level decomposition and reproducible retrieval configuration make verification
  failures auditable. FactSearch decomposes claims, generates targeted queries, retrieves with a
  self-hosted metasearch system, and verifies modularly; the work explicitly treats retrieval
  infrastructure as a first-class component.
  confidence: high · 2026-07 · source: https://aclanthology.org/2026.acl-demo.36/

- [supported] Executable, guarded constraints are better debugging evidence than a post-hoc narrative.
  Microsoft's AgentRx normalizes trajectories, synthesizes constraints from tool schemas and policies,
  evaluates each constraint only when its guard applies, and identifies the first critical failure step.
  The local failure maps to query reformulation after identifier discovery.
  confidence: medium · 2026-03-12 · source:
  https://www.microsoft.com/en-us/research/blog/systematic-debugging-for-ai-agents-introducing-the-agentrx-framework/

- [supported] More prompt text is not the right default fix. Anthropic recommends the smallest
  high-signal context that fully specifies behavior, warns against laundry lists of edge cases, and
  advocates just-in-time retrieval using lightweight identifiers. The current procurement skill is
  27,402 bytes, so the high-value transition belongs in a compact contract plus a deterministic helper,
  not another long prose appendix.
  confidence: medium · 2025-09-29 · source:
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

- [verified] Product identity and product variation must remain separate. GS1 defines product identifiers
  as keys for unique trade items, while 2026 e-commerce work on VARM distinguishes “same entity” from
  “variant relationship” and extracts the attributes that differ. In this workflow, a manufacturer SKU
  is an exact-match key; configuration similarity is only a candidate relation until verified.
  confidence: high for the identity distinction, medium for applying it to retailer SKUs · sources:
  https://www.gs1.org/standards/id-keys/gtin (accessed 2026-07-30, page date n.d.);
  https://doi.org/10.1177/2167647X261423127 (2026-02-28)

- [supported] Workflow-specific regression evals are necessary because generic model benchmarks do not
  expose local orchestration failures. OpenAI describes contextual evals for specific workflows and its
  internal data agent uses continuously running evals as regression canaries.
  confidence: high · sources:
  https://openai.com/index/evals-drive-next-chapter-of-ai/ (2025-11-19);
  https://openai.com/index/inside-our-in-house-data-agent/ (2026-01-29)

## Design decision

- [inference] Implement an **identifier cascade**:
  broad attribute discovery → candidate identifier ledger → exact-identifier query plan → source-page
  verification → deterministic price computation → coverage-qualified claim.
  confidence: high · basis: the reproduced failure plus the sources above

- [inference] Generate the exact-identifier query matrix in code. It must include:
  one open-web exact query, one SKU-index URL, and one independent `site:` query per relevant retailer.
  Never combine domains with `OR`, and never bind the identifier only to the merchant already known.
  confidence: high · basis: local DuckDuckGo failure and lexical-retrieval evidence

- [inference] Treat coverage as evidence, not as a feeling. The agent should report attempted channels,
  hits, misses, blocks, and exact-product verification. Unless the relevant coverage contract is met,
  the output must say “highest verified among the surveyed sources”, not an absolute “highest in
  Vietnam”.
  confidence: high · basis: ACL 2026 evidence-aware termination and FactSearch

- [inference] Separate at least two extrema when availability differs:
  highest current public listing and highest verified buyable/in-stock offer. An unavailable or
  order-only listing remains evidence but must not silently replace the buyable maximum.
  confidence: high · basis: the incident and procurement semantics

## Alternatives rejected

- [refuted] “Add a stronger sentence telling the model to search by SKU.” The existing skill already has
  that sentence, yet the trace still narrowed to `SKU + known merchant`.
  why it failed: prose expressed intent but did not make the transition executable or auditable.

- [open] Full ML product matching or a product knowledge graph could improve fuzzy identity resolution,
  but it is disproportionate for a local skill without a stable catalog or labeled data. Revisit only
  after the deterministic cascade has a measured recall ceiling.

- [open] Exhaustively proving the maximum across every Vietnamese seller is not possible with public web
  search alone. The practical target is explicit source coverage, primary-page verification, and honest
  claim qualification.

## Observable acceptance criteria

1. Given candidate SKU `83KY001VVN` and category `laptop`, deterministic code emits:
   - `"83KY001VVN" giá`;
   - a Websosanh SKU URL;
   - separate FPT Shop and An Khang `site:` queries;
   - no query containing multi-domain `OR`;
   - no coupling to a previously observed merchant unless that merchant is one independent domain row.
2. Case-variant identifiers and duplicate/case-variant domain inputs are normalized without losing the identifier;
   numeric GTINs require a valid check digit, component labels are rejected even with separators, and explicit
   kinds admit source-labelled numeric/letter-only SKUs plus letter-only/`#` MPNs without weakening auto mode.
3. The planner exposes qualified highest and lowest claims, and its Windows CLI output stays ASCII-safe
   while parsed JSON preserves the internal Vietnamese query.
4. The procurement skill puts the identifier cascade and completion contract before detailed tactics,
   invokes the planner through the standalone `neko procurement source-plan` surface, and allows all
   available exact matches when fewer than three candidates exist.
5. Unit tests fail before each planner/contract behavior exists, then pass after implementation.
6. The repository's typecheck, full test suite, doctor, policy, and build gates pass.
7. A post-change live run must either find the previously missed exact-SKU sources or explicitly expose
   their coverage status and avoid an absolute Vietnam-wide maximum claim.

## Post-change regression evidence

- [verified] Re-running the original broad request after the change caused the agent to execute
  `source-plan.ts` for `83KY001VVN` and other leading candidates, open both the An Khang and FPT Shop
  product URLs, and verify eight source-page offers before running `price-table.ts`.
  confidence: high · observed 2026-07-30 · source: local post-change trajectory and generated
  `baogia_norm.json`

- [verified] The exact-identifier pivot rejected a 117,990,000 VND HP candidate after confirming that
  `C1WR2PA` carries RTX 5080, not the requested RTX 5070. The deterministic table then identified the
  highest verified public listing as 87,990,000 VND at An Khang, explicitly labeled not in-stock/order-only
  rather than available stock.
  confidence: high · observed 2026-07-30 · source: local post-change trajectory, source-page fetches,
  and `price-table.ts` output

- [open] The live regression reached and validated its deterministic artifacts, but the outer process was
  manually stopped after the table and final checks completed, before its final user-facing prose was
  observed. Retrieval and computation acceptance passed; end-to-end completion latency and duplicate
  fetch suppression remain separate optimization targets.

## Checkpoint 2026-07-30

Current best understanding: the primary defect is a missing identifier-triggered state transition plus
an unmeasured stopping rule. Search backend degradation amplified the defect but did not create it.
The smallest high-leverage fix is a deterministic query planner, a short execution contract near the top
of the skill, and an incident-derived regression eval. This is a synthesis beyond the current Neko
baseline; it is not a claim that Neko has established a new global research SOTA.
