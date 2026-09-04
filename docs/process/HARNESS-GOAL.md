# Harness objective: independent completion with reproducible evidence

Status: active, started 2026-08-30.

## Objective

Make explicit long-horizon Neko runs complete large software tasks more reliably by
holding implementation to an independent executable standard of completion. Preserve
normal CLI/TUI, ACP/Wiii, tool authority, provider routing, and sandbox semantics. Make
no superiority claim until an official, reproducible comparison supports it.

## Falsifiable hypotheses

1. A contract controller that receives a pre-work instrument and independent clustered
   gaps improves artifact completion rate or official ProgramBench score versus a
   single controller at the same aggregate provider-call cap.
2. Bounded implementation rounds expose missing artifacts and broken build paths early
   enough for the validator to redirect work before the finalization reserve.
3. Time-to-first runnable artifact predicts successful completion better than raw edit
   count or reasoning duration.
4. Exact network capability semantics improve normal Neko autonomy while preserving
   ProgramBench's mandatory offline boundary.

Any failed hypothesis is useful. Revert ineffective controller complexity rather than
keeping it because it sounds sophisticated.

## Invariants

- The validator cannot mutate the candidate, expand authority, inspect secrets, use
  Computer, or reveal private cases/raw output to the implementer.
- The implementer cannot read hidden tests or validator cases.
- ProgramBench stays networkless and clean-room compliant.
- Normal Neko may use network only through the existing per-call capability or explicit
  standing policy; `--yolo` automates approval, not containment removal.
- Unknown mutation outcomes are never replayed automatically.
- Wiii Computer remains session-scoped, semantic, lease-bound, and absent without a
  negotiated capability.
- Existing 1.x public contracts cannot be silently narrowed for an evaluation gain.

## Work sequence and evidence

### 1. Documentation and state hygiene

- Keep one canonical evaluation policy and one compact current work log.
- Delete superseded speculative queues from the active documentation set.
- Record every benchmark result as official, local-equivalent, model/controller
  failure, infrastructure exclusion, or interrupted.

Evidence: link check, stale-term search, and diff review.

### 2. Wiii and sandbox audit

- Run ACP Computer capability/context/lifecycle tests.
- Run sandbox/network/turn-capability tests.
- Fix only reproduced failures.
- Confirm that the model-facing context distinguishes normal per-call egress from an
  offline benchmark.

Evidence: focused tests, policy output, and no authority widening.

### 3. Full-suite stability

- Reproduce any Windows-only timeout under full-suite load before assigning it to UIA,
  SRT, or the tool runtime.
- Stabilize the process-tree lifecycle boundary without widening the production Bash
  deadline or deleting a distinct test contract.

Evidence: isolated stress plus one clean full-suite run.

### 4. Controller experiment

- Add a bounded implementation-round option used only by the experimental contract
  controller until evidence supports promotion.
- Force an early clean build-path check and treat unavailable offline dependencies as
  a planning constraint, not a reason to retry network access.
- Preserve the same aggregate provider-call budget in both arms.

Current treatment: `implementationRoundSteps=12`, frozen in the campaign manifest.
Round exhaustion checkpoints the trajectory and yields to independent review without
claiming `max_steps` or asking the implementer for a premature final answer.

Evidence: deterministic no-artifact, unavailable-toolchain, no-progress, and
artifact-before-deadline regressions.

### 5. Frozen ProgramBench campaign

- At least three unsaturated tasks.
- `single` and `contract` arms in one manifest.
- At least three independent provider replicates per cell.
- Z.AI GLM-5.3 at the same effort, call budget, task order, CPU/memory, and evaluator.
- Counterbalanced controller order within replicate blocks to reduce time/provider
  drift as a treatment confound.
- Official scoring for every valid artifact; infrastructure failures remain missing
  data and are rerun only as new replicate identities.
- Freeze the non-ignored source snapshot, component SHAs, evaluator image ID, and task
  image IDs. Refuse resume after any provenance drift.
- Give every evaluator and nested branch container one random ownership label and
  remove that exact set on success, error, cancel, or interrupt. A Docker-daemon guard
  must survive Windows Terminal killing the host process group and remove only the
  exact run label after its credential-free heartbeat stops.

Evidence: immutable manifests, artifacts, trajectories, evaluator results, aggregate
report, confidence intervals, and cost.

R2 closed as infrastructure-invalid after five valid pairs (`p=0.0625`). Its manifest
is retained unchanged. R3 stopped at dependency preflight before inference. R4
stopped at cell four when an abort-ignoring provider request exposed a recursive
teardown deadline fault. R4 is retained unchanged. R5 restarts the complete matrix with
strict offline host dependency resolution, invalid-deliverable zero classification,
infrastructure fail-fast semantics, abort-raced provider settlement, and a teardown
budget independent from model work.

R5 closed infrastructure-invalid after a host power-cycle interrupted one replicate.
Its one valid `fx` pair is retained but ineligible. That interruption found and fixed
the remaining cleanroom ownership gap: the primary task container is now covered by a
Docker-daemon heartbeat guard, and a live forced process-tree kill left no owned
container or heartbeat. R6 restarts all 18 cells from the repaired, newly gated source.

The R6 source candidate passed the post-repair gate on 2026-08-31: 1,579 Bun tests
passed with 14 platform skips and zero failures; 47 Python tests passed with three
platform skips; typecheck, lint, diff hygiene, doctor, policy, production build, PTY,
ACP, and startup lifecycle probes passed. Docker ownership was empty and the E: volume
was healthy with no new Disk/NTFS fault event since boot. The campaign must retain this
source snapshot unchanged until it closes.

## Decision rules

- Promote only if treatment improves artifact completion or official score across the
  frozen task set, the exact paired one-sided permutation p-value is at most 0.05,
  artifact rate does not decrease, and no safety, lifecycle, or ordinary-CLI
  regression appears.
- If the result is inconclusive, add replicates before changing the controller.
- If treatment loses, inspect failure clusters, make one falsifiable change, and run a
  new versioned campaign. Do not tune against hidden test details.
- Stop a run on human takeover, provider/account revocation, unrecoverable
  infrastructure failure, or evidence of secret exposure.

## Completion definition

This objective is complete only when:

1. documentation and full release gates are clean;
2. Wiii and sandbox behavior are verified with no unresolved regression;
3. the frozen campaign completes with auditable official evidence;
4. the controller decision is made from aggregate results, including variance and
   cost; and
5. any public performance wording stays within the claim gate.

Passing these conditions may justify a strong benchmark claim. It does not guarantee
that Neko is universally SOTA outside the measured benchmark.
