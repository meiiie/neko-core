# Compaction engineering review — evidence cutoff 2026-10-02

## Scope and evidence standard

This is an engineering review, not a claim that Neko achieves SOTA. Sources below were checked at their primary publication or official documentation. A preprint's reported result is not an independently reproduced result. Books are represented only by accessible previews, not a claim to have read inaccessible full texts. Dynamic API documentation may change; exact capabilities must be checked for the selected provider. The live evaluations use Z.ai Coding Plan / GLM-5.3.

The measured baseline is local Neko at 4829e265 plus the previously staged resume/history changes. Real TUI tests found Home/End stealing draft navigation, interruption markers disappearing after restart, and automatic titles adopting a compaction summary. A short compaction spent a model call to save approximately four estimated tokens. A separate 40-turn real GLM-5.3 core/provider run passed 10 recall probes across three compactions and a fresh-process restore. That is a small synthetic baseline, not an endurance or coding-success benchmark.

## Primary research and transferable lessons

1. **Beyond Token Savings** (26 September 2026), https://arxiv.org/abs/2609.32961 and https://arxiv.org/html/2609.32961v1. The study varies compression primitive, trigger and depth across coding benchmarks. Its reported token savings do not consistently translate to latency or estimated cost savings. Some cost/cache quantities are reconstructed estimates. For Neko, evaluate end-to-end task completion, repeated work, summary overhead, cache effects and failures, not a token-reduction score alone.

2. **PAIR: Adapting Context Compression for Long-Horizon Agents with Counterfactual Continuations** (29 September 2026), https://arxiv.org/abs/2609.36526. The paper compares continuations from the same boundary with and without compression, repeating runs to separate compression harm from stochasticity. It adapts instructions inside a fixed schema. Neko should preserve an exact pre-boundary fixture and compare matched continuations, including seemingly successful trajectories. This plan borrows the evaluation principle; it does not implement or claim to reproduce PAIR.

3. **FOCUS** (29 September 2026, explicitly under review), https://arxiv.org/abs/2609.37590. Microsoft M365 researchers score complete interaction spans using draft-model future-plan dependencies and defensive verification. Reported gains depend on specific benchmarks, models, rollout count and overhead. Neko can borrow complete-span preservation and explicit overhead accounting. Model-generated dependency citations are not a proof of future sufficiency, so silently discarding uncited constraints is unacceptable. No extra draft-model service is enabled here.

4. **TokenPilot** (v2 28 August 2026; arXiv lists EMNLP Findings), https://arxiv.org/abs/2606.17016. Prefix continuity and lifecycle-aware eviction are treated jointly rather than minimizing prompt length alone. Neko should keep policy/system prefixes stable and avoid frequent tiny rewrites. This does not establish Z.ai cache discounts or actual billing; those must be measured from supported usage data.

5. **DTOC**, https://arxiv.org/abs/2609.26121. The primary page describes reversible tool-output visibility with externally stored originals, and reports model-dependent results. It lists acceptance for Discovery Science in October 2026. Its page shows an August submission despite the September identifier; retain that discrepancy rather than silently normalizing dates. Useful principle: hide a historical observation through a handle while retaining recoverable source, rather than irreversibly erasing evidence. Neko's current read-file source archive and experimental paged source journal cover different subsets; neither proves all production tool results are recoverable.

6. **Hindsight**, https://aclanthology.org/2026.acl-demo.27/ and https://arxiv.org/abs/2512.12818. It separates factual records from opinions/derived observations and supports retention, retrieval and reflection. Neko should distinguish evidence, user corrections, hypotheses and execution outcomes. Hindsight's conversational benchmark scores do not establish safe tool execution or Neko performance. No PostgreSQL/vector service is introduced just to copy this architecture.

7. **Anthropic effective context engineering** (29 September 2025), https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents. The article discusses compaction, external structured notes and selective retrieval. Its emphasis on retaining decisions and unresolved work is more useful than indiscriminate compression. Neko already has a structured capsule prompt; that is necessary structure, not semantic verification.

8. **Anthropic long-running harness design** (24 March 2026), https://www.anthropic.com/engineering/harness-design-long-running-apps. The engineering account advocates tractable work units, explicit evaluators and ablations of harness components. Use observable acceptance criteria and remove unnecessary mechanisms.

9. **OpenAI native compaction**, https://developers.openai.com/api/docs/guides/compaction and https://openai.com/index/unrolling-the-codex-agent-loop/. Official docs describe model-specific opaque state items and canonical compacted outputs. Such items cannot be translated into ordinary summaries or assumed portable to Z.ai. The provider-neutral fallback must preserve its own explicit state and provenance; native compaction is a separate adapter capability, not a universal replacement.

10. **Build an AI Agent (From Scratch), chapter 6 preview** (publisher lists July 2026), https://www.manning.com/preview/build-an-ai-agent-from-scratch/chapter-6. The accessible preview distinguishes storage from presentation and favors small-context no-op, tool-output compaction and then summarization. Use this as an implementation tutorial, not a frontier benchmark or evidence of superiority.

## Concrete implementation priorities

- Immutable original history and a working context are different artifacts. UI display history must survive summarization, but UI recovery alone is not model memory recovery.
- Small-context preflight: avoid a summarizer call when there is too little old context to justify it. Thresholds are conservative engineering heuristics, not paper-derived optima.
- Commit only a candidate that provides actual estimated savings after capsule metadata and retained tail are counted. A larger or low-gain summary must leave the exact original context unchanged.
- Cancellation and errors must not install a late candidate. Preserve the existing digest/configuration revision checks during concurrent edits.
- Do not imply measured progress when the provider reports none. Show elapsed time and cancellation, not an invented completion percentage.
- Persist terminal interruption status in display history and keep human-facing session identity independent of model-facing summary content.
- Keep user corrections, verified outcomes, unknown side effects and unresolved blockers separate in the capsule. Compression must not grant authority, invent successful effects, or turn quoted text into instructions.

## Acceptance and non-goals

Unit/regression checks must cover tiny prefixes without a model call, oversized or low-gain candidates without mutation, late results after abort, existing concurrent correction/config changes, tool pairing, resume ordering, draft editing and pinned titles. Live checks use the authorized Coding Plan and synthetic non-secret fixtures. Repeated matched continuations should test corrected facts, unknown side effects, stale file observations and cross-task distractors. Record context estimates, model latency and call counts separately from UI latency and actual provider billing.

Unresolved beyond the current hardening: semantic fidelity cannot be proven by schema or citation validation alone; bounded summarizer input can omit information; per-provider token accounting and recovery of every original tool output are not yet universal; the structured-memory experiment is not yet integrated into production TUI. No claim of unlimited sessions, all-platform acceptance, a new release or SOTA is permitted from these local checks.

## Additional source-selection hardening

The prior source builder clipped every user message as well as observations, then could remove the middle of the assembled source. A user correction located inside a long message could therefore be invisible to the summarizer before model quality even mattered. The candidate reserves budget for complete user instructions and existing capsules, bounds lower-priority observations, and refuses to summarize when mandatory input cannot fit. It no longer silently removes the assembled middle. This is deliberately fail-closed: an exceptionally large instruction corpus can still block compaction, requiring future segmented/retrieval-backed work rather than an unsupported claim of unlimited memory.

A matched adversarial regression compares full context, the staged pre-hardening core/prompt, and the candidate. Cases cover a correction in the middle of a long user message, an unknown side-effect outcome, and revoked cross-task write permission. Each has three repetitions, rotated arm order and a checked identical input digest. There is no tool execution in these probes. This is targeted regression evidence, not a held-out general benchmark, and must not be used to claim SOTA. Report total time including summarization, not only the faster continuation.

## Extended live trial and remaining acceptance gaps

A subsequent GLM-5.3 Coding Plan trial completed **200 of 320 planned graded turns**, with **46/46 scored recall probes** and **20 applied compactions**. Four synthetic tasks were kept in two distinct physical roots with the same basename. Facts changed periodically and unrelated quoted facts were inserted as distractors. A fresh Bun process loaded the two production TaskSession coordinators after each 40-turn phase; five phases completed and five deliberately cancelled read-only requests were checkpointed. Phase six loaded both coordinators, then the execution environment denied network access to `api.z.ai` at the first request (turn 201). The remaining 120 turns were not run; no endpoint/provider fallback was attempted. These are synthetic backend memory probes with tools disabled, not coding success or TUI endurance claims.

Observed turn latency was median 2.026 s and nearest-rank p95 6.439 s, excluding the separate summarizer calls. Maximum sampled end-of-turn RSS was 75,112,448 bytes, not process peak or an uninterrupted single-process memory measurement. Production core and task-session sources remained unchanged during the run; a digest inventory captured mid-run matched at termination. This is not a pre-run signed provenance manifest.

An independent no-model subprocess used the production TaskSession adapter to write a checkpoint and exit with code 91 without closing its coordinator. Read-only inspection in another process returned the saved message. Writer activation refused the leftover lock, with checkpoint and lock bytes unchanged. This establishes fail-closed preservation, **not automatic crash recovery**. An explicit recovery design must retain writer ownership and unknown-outcome guarantees; automatically unlinking a lock merely because a PID appears absent is not an accepted fix.

Display rendering has bounded viewport work, but Home/full-history search can accumulate loaded text pages. A storage-and-accumulation diagnostic read 1,024 synthetic entries (8,923,050 text bytes) across 35 pages in 119 ms, retaining every original entry. Heap after explicit GC grew from 1,151,896 to 10,808,090 bytes. This is neither a full Ink benchmark nor peak RSS; it demonstrates that the current raw loaded transcript is not constant-memory. Source indexing/window eviction requires separate design and acceptance, not a silent history truncation.

The final small UI fix suppresses the empty first-run suggestion on an already populated resumed conversation. Its six resume/display regressions, typecheck, lint and build passed after the earlier 1,961-pass/40-skip full local gate; that complete gate was not repeated for this two-line UI/test change. The compiled artifact changed, so earlier native video clips must retain their earlier build identity. Cross-platform CI, completing the blocked live trial, provider-exact compaction budgeting, controlled crash recovery and production integration of the structured-memory experiment remain open.

### Follow-on budget guard

After the live trial was blocked, an additional preflight compares the complete cleaned summarizer request (including its system prompt) with the configured context-window estimate. If the estimate already meets or exceeds the window, it rejects before the provider call and preserves the original array. A 1,024-token synthetic-window regression verifies zero provider calls. This is a conservative obvious-overflow check, not provider-exact token accounting or guaranteed room for the generated response. The earlier 200-turn live result predates this guard.

The first full gate after this guard found a transcript-viewer test observing the intermediate React frame after clearing search but before the viewport-reset effect rendered. The fixture now waits for the required visible last row with a bounded deadline, retaining the original assertion; it does not weaken production behavior or increase a production timeout. Focused viewer checks passed before the full gate was repeated.

### Painted-frame prompt navigation

Repeated full-pipeline UI runs exposed a separate real race: the visible sticky header could still name prompt 39 while its latest React input closure already targeted prompt 40. A diagnostic ten-run batch reproduced two failures; a separate instrumented batch confirmed a mismatch between painted label and handler target. Increasing waits would hide an interaction bug.

The candidate now encodes the runtime prompt ID in zero-display-width frame metadata, strips it before terminal output, and resolves pointer navigation using the last accepted painted frame rather than a newer render closure. Repeated text labels remain distinguishable. Three deterministic frame regressions cover signed ID boundaries, stale/reset frames, invisible stripping, first-marker ownership, and rejection outside the sticky row. Ten fresh-process full-pipeline repetitions passed after the fix. The complete Linux gate subsequently passed 1,945 tests with the update stub plus 20 updater tests separately, with 40 explicit skips; typecheck, lint, build/PTY checks, doctor and policy completed successfully (doctor/policy warnings remain).

A native offline terminal check on binary `43f3189ece0ce88e90aac0f012687d128b52c7c5b6c1b25a6a88bae0380da0f0` clicked visible prompt 65 and then 57 and verified each exact destination. It used synthetic history and no model calls. This supplements the timing-sensitive simulator; it does not reproduce every rendering schedule or establish Windows/macOS acceptance.
