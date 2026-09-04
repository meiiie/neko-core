# Self-improvement state

Updated: 2026-09-04

## Baseline

Neko Core v1.5.0 is the current release candidate. The public coding and GUI smoke tiers that once guided early
development are saturated or versioned historical evidence; they are regression signals, not sufficient proof
of improvement. New harness claims require an unsaturated tier or a direct, reproducible incident regression.

## Current focus

Owner-directed work has priority. ProgramBench execution is paused until the v1.5.0 release is closed. Its source,
manifests, and evidence remain intact; no new live campaign is part of the release gate. When resumed, the bounded
objective remains the provider-agnostic completion-system campaign in
[../process/HARNESS-GOAL.md](../process/HARNESS-GOAL.md), with these measurement targets:

- artifact completion and official ProgramBench score under a matched provider-call cap;
- time to first runnable artifact and first authoritative validation;
- independent-validator coverage without leaking its private cases;
- Wiii Computer and sandbox/network regression freedom;
- provider calls, tokens, cost, wall time, and infrastructure exclusions.

## Accepted latest move

The completion adapter and ProgramBench runner preserve provider credentials on the host, freeze the complete
campaign provenance, account for aggregate provider calls, distinguish model zeroes from infrastructure failures,
and emit privacy-safe 30-second progress telemetry. The Windows evaluator now uses a calibrated workspace snapshot
instead of the Docker Desktop `commit` path that hangs on this host; a daemon-side cleanup guard owns interruption
lifecycle. Current evidence is deliberately inconclusive. Frozen R2 completed five valid pairs with a +43.67
point mean contract lift and exact `p=0.0625`, then exposed one invalid deliverable and a transient package-index
failure. The manifest remains infrastructure-invalid. R3 then stopped at dependency preflight before a model call;
its scrubbed launcher could not see the host-global cache. R4 uses a canonical cache outside the workspace while
remaining strict-offline, scores bounded invalid-deliverable errors as controller zeroes, and fails fast on true
infrastructure loss. Earlier pilots and `yj` diagnostics remain variance/infrastructure evidence, not a general
lift claim.

R4 subsequently stopped at its fourth cell after a provider request ignored the host abort long enough to collide
with recursive remote-state teardown. The repaired boundary races provider settlement against abort, discards late
events, uses independent teardown time, and persists terminal evidence even when teardown fails. Focused tests and a
live Docker smoke pass. R4 remains infrastructure-invalid; R5 is the next eligible frozen comparison.
The post-repair R5 candidate passed the full release gate: 1,579 Bun passes with zero
failures, 47 Python passes, typecheck, lint, policy, doctor, production build, PTY, ACP,
and startup lifecycle probes. R5 now freezes that source candidate; no controller claim
is valid until the complete paired matrix closes.

R5 later closed infrastructure-invalid after a host power-cycle. Its sole valid `fx`
pair was 0 versus 15.11/100 in favor of contract, with 13 fewer provider calls and about
2.41 million fewer tokens, but one pair (`p=0.5`) is not promotion evidence. The forced
stop exposed a missing daemon owner for the primary cleanroom; run-scoped labeling plus
a heartbeat guard now covers it, and a live process-tree kill left no container or
heartbeat. R6 is the next eligible full matrix.

The repaired R6 candidate passed the complete 2026-08-31 gate: 1,579 Bun passes, 47
Python passes, zero failures, typecheck, lint, doctor, policy, production build, PTY,
ACP, and startup lifecycle probes. Docker ownership and post-reboot disk telemetry were
clean. The 18-cell R6 campaign now freezes this source snapshot.

## Measurement rules

- Compare the same provider, model, effort, task set, runtime, and harness version.
- Keep infrastructure failures separate from model failures.
- Report pass rate with steps, tokens, latency, and constraint violations; no single aggregate hides a safety
  regression.
- Record a change only after the full gate passes; otherwise revert it and keep only the lesson.

Current evidence and claim boundaries belong in [../process/EVALUATION.md](../process/EVALUATION.md), not this
short state file. Older detail remains in Git.
