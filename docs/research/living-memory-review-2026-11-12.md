# Living memory: evidence review and bounded hardening

Research cutoff: **2026-11-12**. Implementation baseline: PR #101,
`ebf4e34e97ea91ea76eb817cf6cba2043b8aa263` on `feat/living-memory`.
This is a selected primary-source review, not an exhaustive survey or a SOTA claim.
Public papers, engineering posts, release notes and selected source code were inspected;
no access to Anthropic's private logs or proprietary implementation is claimed.

## Decision

**Keep the direction as a derived episode index, not a complete semantic memory system.**
Preserve canonical sessions, existing Dream consolidation and the provider-independent runtime.
Keep automatic extraction free of model calls; use an explicitly bounded injected pointer and
on-demand reads. Do not add an embedding service, graph database or another reflection loop
without an evaluation demonstrating that it solves a real failure at an acceptable cost.

The important distinction is not files versus vectors: it is **source evidence versus a lossy
representation**, and **remembered information versus current authorization**. A past assistant
sentence is not proof of success, and a remembered deployment request is not permission to deploy now.

## Evidence and consequences

| Source | Relevant finding or design | Decision for Neko |
| --- | --- | --- |
| Manning, Raghavan, Schuetze, *Introduction to Information Retrieval* (2008), evaluation chapters [1] | Retrieval needs a collection, queries and relevance judgments; recall and ranking quality must be measured. | Keep a lexical baseline and stable IDs; measure retrieval separately from task success. |
| Kleppmann, *Designing Data-Intensive Applications* (2017), Part III [2] | A system of record differs from derived indexes and caches. | Session evidence stays authoritative; journal failure must not corrupt the canonical session. |
| Generative Agents (2023) [3] | Experience storage, retrieval and reflection are different components. | An episode index is useful without pretending to perform reflection. Simulation results are not coding-agent evidence. |
| MemGPT (2023) [4] | Hierarchical memory and model-controlled retrieval extend a limited active context. | Keep a small active pointer rather than replaying a whole history. This does not prove every model will retrieve correctly. |
| LongMemEval (2024/2025) [5] | Extraction, multi-session and temporal reasoning, updates and abstention are distinct abilities. | Evaluate contradictions, stale facts and missing evidence, not just substring search. |
| Sleep-time Compute (2025) [6] | Offline processing can trade extra compute for cheaper later inference. | Existing Dream is the appropriate consolidation seam; no extra paid call in journal persistence. |
| A-Mem and Mem0 (2025) [7,8] | Structured notes, linking, extraction and consolidation offer richer retrieval but involve additional processing. | Candidate alternatives, not justification for installing a database before measuring the simple approach. |
| Hindsight (2025/2026) [9] | Separates categories such as facts, experiences and beliefs and combines multiple retrieval routes. | Label excerpts as unverified. Do not promote the last assistant message to a verified outcome. |
| SimpleMem (2026) [10] | Compression, consolidation and query-aware retrieval address different stages. | Keep future quality experiments separate from this correctness/security patch. |
| LongMemEval-V2 (2026-05-12) [11] | Environment memory includes workflows, dynamic state, gotchas and premise awareness. Its file-based AgentRunbook-C obtains strong results, but query latency remains material. | File-based memory is a credible baseline; evaluate real resumed work, with latency and a fixed reader/model. |
| Graphiti source at `6ba19a1` (2026-10-09) [12] | Entity-edge persistence carries episode provenance, creation/validity/invalidation/expiration fields and a reference timestamp. | Retain a source-session ID and snapshot time now; do not imply these two fields implement bitemporal truth. |

These systems do not share one task distribution, backbone, context budget or pricing model.
Their reported scores must not be spliced into a universal leaderboard. No quality uplift,
latency reduction or SOTA status for Neko is established by this patch.

## Anthropic: what the public materials actually support

**Effective context engineering for AI agents** (2025-09-29) [13] supports lightweight
identifiers, progressive/JIT retrieval and hybrid context. It also describes the extra latency
and tool-design burden of runtime search. Returning a snippet without a readable ID does not
complete that design.

**Effective harnesses for long-running agents** (2025-11-26) [14] connects continuity with
progress records, incremental work and checking the real environment. It does not make a
natural-language completion claim sufficient verification.

**The components of agent memory**, Lance Martin (2026-11-06) [15], distinguishes raw
transcripts, notes, derived organization and the small injected layer. Its dreaming examples
include checking notes against transcripts and removing redundant or stale content. The lesson
for this PR is to preserve a route to evidence, not to copy every memory mechanism into the CLI.

**Claude Code public release notes**, v2.1.318 (2026-11-04) [16], include repairs for lost
continuation history, an idle-compaction output that was not a summary, and a deleted transcript
being recreated on exit. They also keep a mod's prompt attachment in the user turn instead of
promoting it to a system message. These are useful failure classes for durable memory work.
v2.1.322 (2026-11-10) [17] was also checked; its listed change concerns Vertex fast mode, not a
new memory algorithm. Do not infer a memory advance merely from a newer version number.

The current Claude Code memory documentation [18] is useful background on auto memory and
scope, and explicitly distinguishes context from enforced configuration. It is a mutable page,
not a date-pinned proof that every currently documented option existed by the research cutoff.

## Changes in this patch

- Master `/memory off`, the journal switch and the environment kill switch govern capture and
  every journal read helper. The runtime passes `TaskScope` through the memory dispatcher;
  scoped journal access fails closed instead of falling back to global personal history.
- Host-profile sessions are not newly indexed into the global journal. Existing journal files
  are not silently deleted or migrated.
- Results carry exact episode/session IDs. A one-word `journal` query searches; only
  `journal_read` opens an ID. Read output identifies the source session and snapshot time.
- New excerpts are JSON-quoted; legacy v1 quoted records remain readable. Last text is marked
  unverified. The injected model pointer contains no historical request text and has no
  other-project fallback. The human recap retains its existing cross-project overview.
- Known-pattern redaction covers auth schemes before key/value masking, quoted assignments
  and private-key blocks. Legacy reads are re-rendered through redaction. This is best effort,
  not a promise to detect arbitrary secrets or personal data.
- IDs, record schema and sizes are checked. Linked journal roots/files are rejected; writes use
  the existing atomic helper with mode 0600. This is not a sandbox against a hostile same-user
  process or an fsync-backed power-loss guarantee.
- Duplicate suppression uses content rather than message count, preserves changed final text,
  and bounds its in-process cache. The 15-second interval suppresses identical writes, not all
  writes. Vietnamese lexical normalization also handles `đ` and punctuation.

## Verification and limits

Original source snapshots were checked against Git blob hashes before editing. New tests first
reproduced 25 failures in 27 journal cases and three scoped-dispatch failures. A subsequent
maximum-ID pointer test and an ID/filename ambiguity test also failed before their fixes. The final **38 focused cases pass on Linux
Node 22.16.0**, using TypeScript stripping and a local `bun:test` registration adapter. The real
memory dispatcher and task-scope module execute; its unrelated Dream import is replaced with
an isolated test stub that throws if called. That does **not** test Dream behavior.

Strict standalone TypeScript checking of the journal, task-scope and imported shared modules
passes with the available local compiler. The repository's Bun 1.4.0, TypeScript 7 toolchain,
oxlint, gitleaks, full suite, build and cross-platform matrix were unavailable locally. The new
tests are ordinary Bun tests for repository CI. This is **not** a full repository/release gate.
No provider calls, paid benchmarks, merge, tag or release were performed.

## Remaining work before claiming better memory

First/last excerpts still omit middle-of-session decisions. A source ID is provenance, not a
new scoped transcript-reading tool. CWD is not a durable repository identity across moves.
Global manual journal search remains global outside task scope. Human recaps may show other
projects. Automatic session-save journal capture still needs a full integration/soak review,
including async save-path latency, deletion propagation and concurrent writers. The existing
`NODE_ENV=test` capture guard in the session adapter is preserved, not newly introduced here. These limits are not resolved by the focused tests above.

Next compare: memory off; the hardened index; scoped raw-session retrieval; and index plus
existing Dream. Hold model, token/tool budget and source histories fixed. Use bilingual,
multi-project cases with middle decisions, corrections, failed tests, interrupted work and
changed authorization. Report source recall, correct use of retrieved evidence, unsupported
claims, cross-scope leakage, resumed-task success, provider cost and p50/p95 retrieval latency.
A BM25/FTS, embedding or temporal-graph extension should earn its complexity against that
baseline. LME-V2 can inform task categories but is not a substitute for a coding-agent evaluation.

## Primary references

[1] https://nlp.stanford.edu/IR-book/ and https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-in-information-retrieval-1.html

[2] https://www.oreilly.com/library/view/designing-data-intensive-applications/9781491903063/part03.html

[3] https://arxiv.org/abs/2304.03442

[4] https://arxiv.org/abs/2310.08560

[5] https://arxiv.org/abs/2410.10813

[6] https://arxiv.org/abs/2504.13171

[7] https://arxiv.org/abs/2502.12110

[8] https://arxiv.org/abs/2504.19413

[9] https://arxiv.org/abs/2512.12818 and https://aclanthology.org/2026.acl-demo.27/

[10] https://arxiv.org/abs/2601.02553

[11] https://arxiv.org/abs/2605.12493

[12] https://github.com/getzep/graphiti/blob/6ba19a1b4d860c1b72aec8f099f458d424bac90f/graphiti_core/edges.py

[13] https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

[14] https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

[15] https://www.anthropic.com/research/components-of-agent-memory

[16] https://github.com/anthropics/claude-code/releases/tag/v2.1.318

[17] https://github.com/anthropics/claude-code/releases/tag/v2.1.322

[18] https://code.claude.com/docs/en/memory
