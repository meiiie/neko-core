# Evaluation and claim policy

This document is the canonical evaluation contract for Neko Core. Dated experiments
explain decisions, but they do not override this policy. Internal fixtures are
regression tests, not evidence that Neko is state of the art.

## What the Factory study establishes

Factory's August 2026 ProgramBench study separates three responsibilities:

1. a validator defines an executable standard of completion before implementation;
2. an implementer builds without seeing the validator's private cases or raw output;
3. an orchestrator turns clustered gaps into work and decides when to ship.

The result supports the value of an independent completion standard. It does not
establish a compute-matched treatment effect: the published system runs used much
more wall time and compute, and each cell was run once without a variance estimate.
Neko therefore tests both the architecture and its compute cost.

## Controllers under test

- `single`: one normal implementation loop.
- `self-review`: the legacy implement/review loop in one model-visible context.
- `contract`: a pre-work completion instrument, an independent read-only validator,
  and outcome-level directives. Raw validator cases and observations stay behind the
  validation wall.

The contract controller is experimental. Ordinary chat and single-shot runs do not
pay its extra provider calls.

## Frozen comparison contract

A comparison is valid only when one manifest freezes all of these before inference:

- task identifiers and their order;
- ProgramBench, task image, evaluator, and implementation digests;
- provider profile, model, reasoning effort, and provider-replicate labels;
- controllers, maximum steps, contract implementation-round size, aggregate
  provider-call budget, and work deadline;
- CPU, memory, network posture, and evaluator resource limits;
- number of replicates and resume policy.

Campaign execution is blocked by task/profile/replicate and rotates controller order
deterministically across adjacent blocks. This counterbalances provider or machine
drift without pretending the provider exposes a sampling seed; the exact order is
materialized in the immutable cell list before the first model call.

Both arms receive the same aggregate provider-call cap. Tokens, cached tokens, cost,
and wall time are measured rather than forced equal because equalizing output tokens
would change the policy being evaluated. A provider without a controllable seed is
reported as independent provider replicates, never as seeded sampling.

Infrastructure failures are excluded and reported; they are never converted into
model failures. Missing or invalid deliverables after a valid model run remain
controller failures.

## ProgramBench boundary

ProgramBench inference uses the official `task_cleanroom_v6` Linux/amd64 image and
ProgramBench 1.2.4. The reference executable is a black-box oracle. The model may not
read, decompile, trace, wrap, or ship it. The task has no Internet access and may use
only dependencies already present in the cleanroom. This offline rule belongs to the
benchmark, not to normal Neko usage.

The host launcher also resolves the pinned ProgramBench 1.2.4 package with `uv
--offline`. Prime and verify that cache before freezing a campaign so a transient
package-index or DNS outage cannot invalidate later cells.

Normal Neko Bash can request network authority for the exact destinations needed by
one call, or use a user-configured standing policy. `auto` and `--yolo` may automate
that grant but do not erase the OS sandbox. See [SANDBOX.md](SANDBOX.md).

The host keeps provider credentials and provider traffic outside the task container.
The task sees only bounded native tools. Each run must emit:

- `submission.tar.gz` when a candidate exists;
- a privacy-bounded full trajectory;
- implementation and environment digests;
- final metrics and a classified terminal status;
- official evaluator output when scoring succeeds.

Hidden evaluator failures are final reporting evidence. They are not fed back into a
frozen submission or used to repair and rescore the same trial.

## Primary outcomes

Report every cell, not only successful artifacts:

- artifact completion rate;
- official ProgramBench score;
- time to first intended artifact edit;
- time to first buildable/runnable artifact;
- time to first authoritative validation;
- provider calls, tokens, cost, and wall time before and after the first artifact;
- tool success/failure counts and terminal-status class;
- instrument revisions and independent-validator verdicts.

Controller-ready state and external artifact quality are separate outcomes. A correct
artifact can expose a controller termination bug; a confident controller can still
ship a poor artifact.

## Current evidence ledger

| Run | Task/controller | Evaluator | Result | Classification |
|---|---|---|---:|---|
| `cmatrix` smoke | GLM-5.3, earlier controller | ProgramBench 1.2.4 | 97/100, 769 evaluator rows | route/evaluator smoke; one replicate |
| `bat` smoke | GLM-5.3, single | official 1.2.4 | 76/100, 1,091 hidden tests | route/evaluator smoke; one replicate |
| frozen R1, replicate 1 | `fx`, single | not scored | `artifact_missing`; 93 calls, 4.94M tokens | valid controller outcome; infrastructure pilot |
| frozen R1, replicate 1 | `fx`, contract | workspace-snapshot 1.2.4 | 24/100; 51 calls, 1.18M tokens | valid artifact; infrastructure pilot |
| frozen R1, replicate 2 | `fx`, contract | workspace-snapshot 1.2.4 | 35/100; two evaluator warnings | valid artifact; infrastructure pilot |
| R6 | `yj`, contract | local-equivalent 1.2.4 | 58/100, 767 tests | diagnostic only; Docker snapshot failed |
| R14 | `yj`, contract | local-equivalent 1.2.4 | 2/100, 767 tests | valid poor artifact; diagnostic only |
| R15 | `yj`, contract | not scored | `artifact_missing` | valid controller/finalization failure |
| R8/R10/R13 | `yj`, contract variants | not scored | `artifact_missing` | valid controller failures |
| R9/R11/R12 | `yj` | none | no comparable artifact | infrastructure exclusions |
| frozen R2, first five pairs | `fx` + `srgn`, single vs contract | workspace-snapshot 1.2.4 | mean paired lift +43.67 points; exact p=0.0625 | promising but incomplete and ineligible |
| frozen R2, `srgn` contract replicate 3 | GLM-5.3, contract | official error metadata | missing executable (`LocalEntryNotFoundError`) | controller zero; old launcher recorded evaluation failed |
| frozen R2, remaining seven cells | mixed | not run | transient PyPI/DNS lookup failure | infrastructure exclusions; campaign invalid |
| frozen R3 preflight | `fx`, single | not run | scrubbed launcher could not see the global uv cache | infrastructure exclusion; fail-fast before a model call |
| frozen R4, `fx` replicate 1 | single vs contract | workspace-snapshot 1.2.4 | 0 vs 28.77/100 | one valid pair; diagnostic only |
| frozen R4, `fx` contract replicate 2 | GLM-5.3, contract | not run | `artifact_missing`; 32 calls, 689k tokens | controller zero |
| frozen R4, `fx` single replicate 2 | GLM-5.3, single | not run | provider abort settled late, then teardown expired | infrastructure exclusion; campaign invalid |
| frozen R5, `fx` replicate 1 | single vs contract | workspace-snapshot 1.2.4 | 0 vs 15.11/100 | one valid pair; `p=0.5`; diagnostic only |

R15 used about 28.5 minutes, 55 provider admissions, 2.73 million reported
tokens, and 58 settled tools. It created substantial Go source but never produced
the required root executable after an offline dependency lookup consumed the late
build window. The sandbox enforced the benchmark correctly; the controller failed to
prove an offline build path early enough.

The ledger shows high controller variance. It establishes neither positive nor
negative general treatment lift.

R2 demonstrated why the infrastructure gate is part of the experiment. Its first
five complete pairs had 100% contract artifact delivery versus 0% for `single`; three
`fx` contract scores averaged 51.37/100 and the second `srgn` contract replicate
scored 64.25/100. The paired exact test was still inconclusive at `p=0.0625`.
The next contract artifact lacked the required executable, which is a controller
zero, not an infrastructure exclusion. A later transient DNS failure exposed that the
host launcher still checked the package index despite pinning ProgramBench 1.2.4.
The frozen R2 manifest remains unchanged and infrastructure-invalid. The launcher now
uses the primed package cache in strict offline mode, recognizes bounded invalid-
deliverable error codes as score zero, and stops a campaign at its first true
infrastructure-invalid cell instead of contaminating later cells.

R4 demonstrated a separate terminal-boundary fault. The fourth cell reached its
controller cutoff after 73 provider admissions and 77 settled tools. The in-flight
provider promise did not settle on abort, and remote-state cleanup recursively entered
the normal contained-command path with only ten seconds left. This prevented a terminal
trajectory, so fail-fast excluded the cell and preserved all later cells. The fixed host
races provider settlement against abort without changing the model work deadline,
rejects late provider events, gives teardown its own budget without creating a new token,
and persists the trajectory before rethrowing teardown errors. A one-call live Docker
smoke classified the expected missing artifact normally and left no owned container.

Docker Desktop 29.7.2 on the Windows benchmark host hangs in the official evaluator's
post-compile `docker commit`, including for a five-byte delta. The pinned
`workspace-snapshot` evaluator changes only that transport: it compiles once, archives
the resulting `/workspace` and executable, and restores the same bytes into each clean
official task image. Its `cmatrix` calibration reproduced 97/100 and all 769 test-row
statuses. Every run records the shim SHA, evaluator image ID, official score summary,
and a run ID shared by all nested containers. This is an explicitly reported host
compatibility layer, not a new scoring rule.

## Active campaign gate

Before another paid campaign:

1. all deterministic and Wiii/sandbox regressions pass;
2. the full suite has one clean run, or every quarantined flake has a documented owner
   and an isolated passing reproduction;
3. a provider-free lifecycle probe proves Docker, runner, trajectory, artifact, and
   evaluator cleanup;
4. the manifest contains at least three unsaturated tasks, both `single` and
   `contract`, and at least three provider replicates per cell;
5. no task-specific hidden feedback is present in model context or controller prompts.

The manifest also freezes a content hash of the complete non-ignored working tree,
component SHAs, evaluator image ID, and every task image ID. Resume refuses any source
or image drift. A terminal run record distinguishes a valid zero-score model outcome
from an evaluator or infrastructure failure and preserves calls, tokens, tools,
checkpoints, validation state, and wall time in either case.

Evaluator containers carry one run-scoped Docker label. A Docker-daemon cleanup guard
owns only that label and watches a credential-free heartbeat, so it can remove the
exact evaluator process set even when Windows Terminal terminates the entire host
process group before JavaScript cleanup runs. A live Ctrl+C probe left zero owned
evaluator and guard containers after six seconds.

The managed success path independently reproduced `cmatrix` at 97/100 with 506 scored
tests, a matching run ID, and zero owned containers or heartbeat files after exit. The
2026-08-31 R4 pre-campaign gate also completed 1,579 Bun tests with 14 explicit platform
skips and zero failures, plus typecheck, lint, diff hygiene, Python protocol tests,
doctor, policy, production compile, real-PTY input, ACP, and startup lifecycle probes.
R4 later failed the infrastructure condition above; its partial scores are not eligible
for promotion. R5 must freeze the repaired lifecycle implementation as a new campaign.
The post-repair R5 gate then repeated the complete Bun suite with 1,579 passes, 14
platform skips, and zero failures, plus 47 Python passes and three platform skips.
Typecheck, lint, diff hygiene, doctor, policy, production compile, real-PTY input, ACP,
and startup lifecycle probes also passed. TEMP was placed outside the repository on E:
because the Windows user TEMP volume was nearly full; no test contract was changed.

R5 was externally interrupted after one valid pair when the benchmark volume required
a power-cycle. Its completed records remain immutable. The interruption revealed a
separate ownership gap: evaluator branches had a daemon guard, but the primary
candidate cleanroom did not. The primary cleanroom now carries the same run-scoped
label under a heartbeat guard started before inference. A forced Windows process-tree
kill left zero run containers, zero guard containers, and no heartbeat. R6 is the next
claim-eligible full campaign; R5 cannot be resumed into eligibility because its
interrupted replicate identity is preserved rather than overwritten.

The repaired R6 candidate then repeated the full gate: 1,579 Bun passes, 14 explicit
platform skips, zero failures, 47 Python passes, and three Python platform skips.
Typecheck, lint, diff hygiene, doctor, policy, production compile, real-PTY input, ACP,
and startup lifecycle probes passed. No ProgramBench-owned Docker container remained;
the E: volume was healthy and emitted no new Disk/NTFS fault event after reboot.

The first decision threshold is not a SOTA claim. Promote the contract controller only
when the frozen campaign has at least three tasks and three paired provider replicates,
all cells are infrastructure-valid, mean paired official-score lift is positive, the
one-sided exact paired permutation p-value is at most 0.05, artifact rate does not
decrease, and ordinary release gates remain clean. An inconclusive result adds
replicates before changing the controller. Hidden test details never drive a repair.

## Public claim gate

A public SOTA claim requires the official benchmark's full eligible task set, official
resource limits and verifier, multiple attempts, published artifacts/trajectories,
confidence intervals, and a reproducible clean commit. Report exceptions, missing
cells, compute, and cost. A smoke, local-equivalent score, dirty worktree, or selected
best run cannot support the claim.

## Commands

Built-in calibration:

```powershell
rtk bun run neko -- bench contract frontier --trials 3 --call-budget 24
rtk bun run neko -- bench campaign frontier --profiles zai --trials 3 --call-budget 24
```

Official ProgramBench cell and frozen campaign:

```powershell
rtk bun run eval:programbench -- --task <instance> --profile zai --output <dir> --evaluate
rtk bun run eval:programbench:campaign -- --task <a> --task <b> --task <c> --profiles zai --controllers single,contract --replicates 3 --call-budget 160 --max-steps 160 --round-steps 12 --effort max --evaluate --output <dir>
```

Use `--resume` only with the exact existing manifest. Completed, failed, and
interrupted artifacts are immutable evidence and are never silently replaced.
