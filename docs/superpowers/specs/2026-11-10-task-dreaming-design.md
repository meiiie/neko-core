# Task-scoped dreaming

## Outcome and source

Apply the useful memory components from [Anthropic's 2026-11-06 article](https://www.anthropic.com/research/components-of-agent-memory) to Neko's existing task memory: check notes against original evidence, preserve corrections and uncertainty, produce a compact linked representation, and recall only a bounded index. This is not compaction, model training, or a claim of benchmark lift.

Baseline: `3d6949040a4e95f9eea97ba65546f0fc6425b995`, Neko Core only. Existing TypeScript/Bun stack and CLI/ACP memory semantics remain canonical. Wiii and host authority are unchanged.

## Implementation decisions

- An explicit `neko dream` command works on one existing opt-in task session. No scheduler, background model calls, global memory sweep, or implicit import from legacy sessions.
- `preview` is local and does not call a provider. `prepare` makes one bounded tool-free model request and stores a reviewable candidate. `show` reads it. `apply` separately activates that exact candidate without model calls.
- One pass replaces one bounded task note, `dream.md`. A single-note commit is intentionally atomic; speculative multi-file rewrites were rejected because they require a broader migration/transaction protocol. Original notes and transcripts remain intact. Corrections are explicit, source-linked entries, not destructive edits to user-authored notes.
- Use original structured source groups when present, otherwise the immutable display history, otherwise uncompacted non-internal user/tool/assistant messages. Label the origin. Never treat an assistant statement or old note as proof of an observed fact.
- Read a bounded recent evidence window, retain original cited sources from the last activated receipt, visibly report backlog/omitted records, and never claim the whole history was processed. No watermark is advanced by a failed or partial pass.
- Model output is structured claims, exact source quotes, uncertainty, corrections, and links. Validate source membership and exact quotes. A quote check establishes provenance, not semantic entailment or present-day truth. Inferences never enter the injected top layer.
- Candidates bind the source digest, full memory snapshot digests, task/root and provider/model identifiers. Apply rechecks these inputs and refuses stale work. Shared scoped-memory writer exclusion prevents concurrent cooperative writes.
- Persist the candidate/audit record before the atomic single-file replacement. Interrupted activation is resolved by comparing the exact before/after bytes, not by blindly replaying. Retain old bytes for an explicit rollback. Never auto-break a stale writer lock.
- Enforce memory-off, active scope, single-link regular files, safe paths, input/output size limits, configured-secret checks, and cancellation. Source text remains untrusted data and cannot grant tool or host authority.
- Reuse the existing memory read/search and shared turn-context path. Inject a small observed-only index; details and source references stay in the note.

## Acceptance

Deterministic regression tests must cover correction/source attribution, assistant-only claims, malformed output, secrets, no tools, scope isolation/revocation, disabled memory, stale input, repeated apply, concurrent mutation, symlink/hardlink paths, interruption recovery, rollback, and bounded recall. Run typecheck, lint, the full local test gate, doctor/policy and build where supported. Tests use fake providers and temporary homes only. No paid runs, push, package release or deployment.

## Limits

This first iteration is explicitly requested rather than idle scheduled. It consolidates one selected task and does not promote information globally. A source-backed statement can still be wrong; originals remain searchable. Oversize individual evidence is excluded and reported, never silently clipped into a seemingly complete quote. Source quality and real model effectiveness need a separately authorized evaluation.

Final contract and usage: [DREAMING.md](../../process/DREAMING.md). Recovery claims cover process interruption only, not uniform power-loss durability. The injected layer contains complete bounded titles, not truncated claims.
