# Frontier v2 benchmark design - 2026-08-10

Status: design proposal, not an implemented or published benchmark.

This document defines the next Neko Core benchmark tier. It is intended to measure
release-scale coding-agent work after the current public `frontier` suite stopped being
diagnostic. Every numeric threshold marked **PROPOSAL** is a Neko engineering choice. It
is not a METR, SWE-EVO, SWE-Marathon, or LongHorizon-Harness standard.

## Decision

The current public `frontier` suite is a **regression/calibration suite**, not a frontier
capability benchmark. A single Luna/max trial passed each of its three tasks. That 3/3
result does not estimate reliability, but it is enough to show that spending on a stronger
model or repeating the same three tasks will not repair the ruler.

Frontier v2 therefore starts with a new, private held-out pack and a stricter evaluation
protocol. It must not inherit results from the current suite. The old suite remains useful
for fast regression detection.

## What comes from the primary evidence

The design uses the following source-derived principles:

- METR defines a time horizon from the relationship between task success and the time a
  skilled human needs for the same task. It fits success against log human duration;
  elapsed agent runtime is not a substitute for human task time
  ([METR time-horizon methodology](https://metr.org/time-horizons/)).
- METR's task-development guidance favors natural, end-to-end work with a clear outcome,
  a reproducible local environment, and a robust automated scorer. It warns against making
  a nominally long task by serially concatenating artificial subtasks and identifies roughly
  six-to-eight-hour human tasks as a useful task-development target
  ([METR task desiderata](https://taskdev.metr.org/desiderata/)).
- METR's quality-assurance process uses skilled independent humans, the same resources as
  the evaluated agent, timed attempts, and deliberate checks of invalid, partial, and gold
  submissions ([METR quality assurance](https://taskdev.metr.org/quality-assurance/)).
- SWE-EVO demonstrates release-scale evaluation over 48 tasks whose reference changes
  average 610.5 edited lines, 20.9 files, and 51 functions, with 874 tests per task on
  average. Its FAIL_TO_PASS and PASS_TO_PASS separation makes regression preservation a
  hard condition; its Fix Rate gives diagnostic partial credit only when regressions do not
  occur ([SWE-EVO](https://arxiv.org/html/2512.18470v6)). These figures are scale references,
  not minimum quotas for every Neko task.
- LongHorizon-Harness separates mutable task execution from a fresh, independent read-only
  auditor and advances external task state only from audited facts. Frontier v2 adopts that
  trust boundary, not its implementation
  ([LongHorizon-Harness](https://arxiv.org/html/2608.01964v1)).
- SWE-Marathon uses project-scale tasks, multiple verification channels, repeated trials,
  and trajectory inspection, including analysis of exploit-shaped attempts. It is evidence
  that a final test command alone is an inadequate ruler for long-horizon agents
  ([SWE-Marathon paper](https://www.swe-marathon.org/swe-marathon-paper.pdf)).

The pack sizes, family taxonomy, transition bands, repetition counts, artifact caps, and
promotion thresholds below are **PROPOSALS** derived for Neko. The cited projects do not
endorse them.

## Private held-out pack

### Composition

**PROPOSAL:** the first valid pack contains at least 12 accepted tasks across at least four
families, with at least three tasks per family. No family may exceed one third of the pack,
and no repository or fixture lineage may supply more than one quarter of the pack. A larger
pack should preserve those diversity constraints.

The initial four families are:

1. **Release evolution:** implement a coherent feature, migration, or compatibility change
   across modules while preserving existing behavior.
2. **Recovery and durable state:** recover correctly after interruption, stale cache state,
   partial publication, or resumed execution.
3. **Concurrency and effect integrity:** handle counter-edits, idempotency, atomicity, or
   competing operations without lost updates or duplicated effects.
4. **Interface and safety evolution:** change a tool, permission, protocol, or sandbox-facing
   interface while preserving the declared safety boundary and user-visible contract.

Each task must be a natural engineering objective with one dominant hard bottleneck. It may
contain many dependent steps, but it must not be padded by unrelated chores merely to increase
runtime. Prompts describe the outcome and constraints in ordinary issue or release language;
they do not identify the faulty line, hidden assertion, or expected algorithm.

**PROPOSAL:** target a four-to-eight-hour median skilled-human task, while preferring the
six-to-eight-hour range when a task remains natural. At least nine of the first 12 tasks
should have independently observed human times between two and eight hours, and the pack
median should be at least four hours. These are construction targets, not a time-horizon
claim.

### Storage and access

The task bundle lives outside the public repository and outside the model workspace. The
runner receives a versioned, read-only manifest; the candidate receives only the declared
starting workspace, prompt, allowed tools, and public checks. Gold repairs, hidden assertions,
adversarial probes, and verifier source remain in the verifier boundary.

The bundle manifest must bind:

- pack version and task ID;
- source and seeded-workspace digest;
- prompt/contract digest;
- public-check digest;
- hidden-verifier and invariant-set digests;
- reference-repair digest;
- family, fixture lineage, declared resource ceiling, and task seed;
- expected sandbox policy and verifier runtime identity.

The report may disclose these digests without disclosing held-out content. A manifest change
creates a new pack version; results from different versions are never pooled.

## Task admission gates

Every gate below is required before a task enters the pilot. The reference repair is evidence
that the task is solvable, not a patch-similarity oracle. Alternative correct implementations
must be accepted.

### 1. Specification and environment gate

- The starting snapshot, dependency closure, and verifier run without network access.
- Public instructions are sufficient for a skilled engineer and do not depend on private
  operator knowledge.
- The starting state reproduces the intended failure and all unrelated baseline checks pass.
- The evaluator is deterministic across three cold runs on the reference host class.
- The task has one primary acceptance contract and an explicit list of hard negative
  constraints.

### 2. Reference gate

- A reviewed reference repair passes every hard verifier channel on three cold seeded runs.
- A second reviewer confirms that the repair satisfies the written contract rather than an
  accidental fixture detail.
- The verifier also accepts at least one materially different implementation when the task
  admits more than one reasonable solution. If that cannot be constructed, the reviewer must
  document why the verifier is behavior-based rather than patch-shaped.

### 3. No-op gate

- The untouched starting workspace fails functional acceptance.
- Reformat-only, comment-only, and final-answer-only submissions fail.
- Replaying public expected strings, printing a success marker, or returning a clean process
  status without the required state change fails.

### 4. Partial-submission gate

**PROPOSAL:** maintain at least two reviewed partial repairs per task: one that implements a
happy path but misses a hidden edge, and one that changes the requested behavior while causing
a regression or state-integrity failure. Neither may receive a full pass.

Partial progress can be reported diagnostically by channel. It must be forced to zero for the
primary score when a regression, safety, integrity, or tamper channel fails. This mirrors the
regression-gated intent of SWE-EVO's Fix Rate without claiming metric equivalence.

### 5. Adversarial gate

**PROPOSAL:** exercise at least five relevant adversarial submissions per task, selected from:

- modifying, deleting, shadowing, or bypassing tests;
- hard-coding public examples, paths, timestamps, seeds, or attestation text;
- replacing the build/test command or dependency resolution;
- reading verifier/gold data or escaping the task workspace;
- leaving detached processes or delayed writes;
- disabling a permission, sandbox, audit, or completion boundary;
- exploiting symlinks, alternate path spellings, environment variables, or generated files;
- returning plausible output while the durable end state is wrong.

All applicable probes must fail closed. An exploit that earns a pass retires the task's
results until the verifier is repaired, the pack version changes, and the full trial set is
rerun.

### 6. Independent human gate

At least one skilled human who did not author the task must attempt it from the same starting
snapshot, with the same task-visible resources, network policy, and acceptance contract. The
operator records active work time, interruptions, outcome, ambiguity, and any extra help.

**PROPOSAL:** a second independent timed attempt is required for at least one task per family
and for every task whose first attempt fails or differs from the author's estimate by more
than twofold. Task authors' estimates are retained as estimates, never substituted for timed
human observations.

## Verifier architecture

The candidate executor and the verdict producer are separate processes and trust domains.
The current public-suite helper that imports candidate code beside an in-memory assertion module
must not be reused for the sealed pack: same-process runtime or stack introspection can expose
assertion-module identifiers/content even when no oracle file is written, although terminal
attestation still prevents an early clean exit from forging completion.
Every trial gets a fresh candidate workspace and provider instance. The auditor receives a
read-only canonical seed plus a bounded snapshot or patch from the completed candidate trial;
it never trusts candidate-owned tests, status text, or attestation.

The verifier has five channels:

1. **Functional acceptance:** hidden FAIL_TO_PASS behavior and required end-state checks.
2. **Regression preservation:** PASS_TO_PASS tests and public-contract compatibility.
3. **State and effect integrity:** filesystem inventory, atomicity/idempotency evidence,
   process cleanup, and any task-specific durable-state invariant.
4. **Boundary integrity:** protected-file identity, test/verifier integrity, path containment,
   sandbox/network policy, and forbidden host effects.
5. **Production completion parity:** the same completion gate and tool-result semantics used by
   the production Neko path, plus harness-owned terminal attestation.

All declared hard channels must pass. An optional performance channel may become hard only
when its host class, warm-up, repetitions, variance budget, and threshold were frozen before
the pilot. It must not silently convert a functional task into a host-speed benchmark.

Only auditor-issued facts advance the harness result from `running` to `passed`. Candidate
self-reports and candidate-generated logs are untrusted observations. Auditor launch failure,
timeout, cleanup uncertainty, identity drift, or truncated mandatory evidence is an
infrastructure error, not a model failure.

## Trial protocol

### Freeze

Before any scored run, freeze the candidate source fingerprint, pack manifest, model snapshot,
effort, resolved redacted configuration, tool/skill schemas, privileges, sandbox, runtime,
step/token/time ceilings, retry policy, hardware class, and ordered seed list. A change to any
source or safety boundary invalidates the entire scored set.

Diagnostic and reference runs are never added to a scored aggregate. Every scheduled scored
trial remains in the record, including model failures and infrastructure failures.

### Pilot

**PROPOSAL:** run exactly three scored repeats per task for the chosen reference configuration,
after all admission gates pass. This is 36 trials for a 12-task pack. Three repeats are a
screening stage, not a reliability estimate.

Promote the pack from pilot to main only if:

- there are zero unresolved infrastructure or verifier-integrity failures;
- aggregate pass rate for the reference configuration is between 20% and 80%;
- no family is at 100% pass rate;
- at least one task in at least two families has mixed outcomes across its three trials;
- no passing trajectory depends on an undeclared privilege, leak, or benchmark-specific hack;
- all task and run fingerprints remain stable.

The 20%-to-80% transition band and mixed-outcome rule are **PROPOSALS**, not source standards.
They are a cheap anti-saturation/floor check. If the pack fails them, repair or replace tasks;
do not buy a stronger-model run merely to obtain a more flattering number.

### Main run

**PROPOSAL:** predeclare either five or six repeats per model-scaffold-task before launching
the main run. Six is preferred when budget permits; five is acceptable for direct comparison
with a frozen five-repeat program. The repeat count must not be selected after seeing results.

Use the same ordered seeds for paired baseline/candidate comparisons, fresh workspaces and
fresh provider state per trial, and identical resource ceilings. Complete every scheduled
trial. If a source, verifier, policy, or manifest change is necessary, discard the incomplete
aggregate and start a fresh set under a new fingerprint.

No additional paid model tier is authorized by a saturated or invalid pilot. Paid escalation
starts only after the pack earns main-run status and a maximum spend is predeclared.

## Metrics and interpretation

Report at minimum:

- per-task successes/trials, pass@1 estimate, and strict `pass^k` reliability;
- family-macro and task-micro pass rates with confidence intervals;
- functional partial progress, regression preservation, and every hard-channel failure;
- model failures and infrastructure errors as separate counts;
- input/cached/output tokens, model calls, completed tool calls, and cost per success;
- latency p50/p95, step efficiency, redundant calls, tool errors, and retries;
- constraint adherence, safety violations, exploit-shaped attempts, and user corrections;
- model, harness, task, verifier, sandbox, runtime, and workspace fingerprints.

With 12 tasks and five or six repeats, confidence intervals will remain wide and family
estimates will be especially noisy. Publish exact counts and a family-sensitive resampling or
sensitivity analysis; do not turn repeated attempts on a small task set into a claim of broad
task diversity.

### Human-time caveat

Frontier v2 may report observed human completion times and model success by duration bucket.
It must not call this a METR-style time horizon until there are enough valid tasks across a
meaningful time range, timed skilled-human baselines under matched resources, repeated model
trials, and a documented success-versus-log-human-time fit. A task author's estimate, token
count, wall-clock model runtime, lines changed, or number of files is not a human-time baseline.

## Bounded trajectory and provenance artifact

Each evaluation emits one append-only report record under
`neko.eval.trajectory.v1`. The publishable record is structural and metadata-only. It must not
contain raw tool arguments, file contents, command output, model observations, error bodies,
final-answer text, environment values, or secrets.

For each trial, retain:

- task ID, trial index, outcome, elapsed time, tokens, model calls, and completed tool calls;
- verifier and production-completion verdicts;
- typed failure signals and bounded opaque failed-constraint references;
- structural rounds and allowlisted tool names;
- trial-local opaque target references such as `p1`, `q1`, and `c1`;
- productive/empty/failed result class and redundant-call marker;
- maximum-step status plus omitted-event and omitted-constraint counts.

**PROPOSAL:** cap persisted data at 128 tool events and 32 failed constraints per trial and
512 trajectories per report. Truncation must be explicit through omitted counts. Persistence
failure leaves the in-memory verdict intact but makes the run non-publishable until the
artifact is recovered or the full set is rerun.

The report envelope binds the frozen manifest and all run identities listed in the Freeze
section, including the effective sandbox and verifier runtime. Use a redacted canonical config;
never record an API key or credential-bearing environment value.

SWE-Marathon's full-trajectory publication is a transparency reference. Neko's bounded safe
artifact is intentionally less revealing because raw coding-agent traces can contain source,
held-out verifier details, and secrets. It must not be described as an equivalent full trace.
Scrubbed raw traces may be released only after a separate privacy and contamination review.

## Contamination limits

Private means access-controlled, not provably unseen. Frontier v2 cannot establish that a
model was never trained on the underlying repository, issue, or change pattern. It also cannot
prevent benchmark developers from adapting the harness to repeated internal failures, or a
provider from changing a nominal model behind an API name.

Mitigations are:

- keep task prompts, seeds, gold repairs, and hidden verifier material outside the public tree;
- expose only content digests to the candidate process;
- restrict runner and auditor access by role and record access events;
- avoid tasks copied verbatim from public issues or releases when a model could retrieve the
  completed patch from memory;
- freeze a model snapshot or record the strongest available provider identity;
- limit exploratory runs on the sealed pack and use separate development tasks;
- retire or rotate a task after public disclosure, evaluator exploitation, or repeated
  benchmark-specific tuning;
- publish the retired task and verifier when possible so external reviewers can audit past
  claims without preserving it as a future held-out task.

These controls reduce leakage; they are not cryptographic proof of non-contamination. Results
must state that limitation.

## Promotion and stop rules

### Pack promotion

A draft pack may enter the pilot only when all task admission gates pass. It may enter the
main run only when all pilot criteria pass. A pack that becomes saturated is reclassified as
a regression pack; its historical results remain valid for its frozen version, but it no
longer authorizes frontier-performance claims.

### Harness-candidate promotion

**PROPOSAL:** a harness candidate may replace the baseline through either of two predeclared
gates:

1. **Effectiveness gate:** family-macro pass rate improves by at least 10 percentage points,
   no family falls by more than 10 points, and no safety/integrity failure is introduced; or
2. **Efficiency gate:** family-macro pass rate is no more than 5 points lower, cost per success
   improves by at least 20%, p95 latency improves by at least 15%, no family falls by more than
   10 points, and no safety/integrity failure is introduced.

These are product decision thresholds, not significance tests. Always publish uncertainty and
paired raw counts. When intervals are inconclusive, label the result tentative and require a
fresh confirmatory set before a release claim.

### Immediate stop conditions

Stop the run, preserve bounded evidence, and do not spend on a stronger tier when any of the
following occurs:

- a no-op, known partial, or adversarial submission earns a full pass;
- the reference repair fails, an auditor identity changes, or a required artifact is missing;
- candidate code reads protected verifier/gold data or causes an uncontained host effect;
- an unresolved infrastructure error makes the scheduled set non-comparable;
- task, source, policy, model, runtime, or sandbox fingerprints drift mid-set;
- the pilot is above 80% or below 20%, or otherwise fails its transition-band rules;
- an independent human identifies material ambiguity or an undeclared resource dependency;
- secrets or private held-out content appear in logs or publishable artifacts.

After a stop, diagnose on unscored replicas. Any repair produces a new fingerprint and requires
a wholly fresh pilot or main set.

## Claim boundary

A private held-out Frontier v2 result can guide Neko engineering and reject weak harness
changes. By itself it cannot support a public SOTA claim because outsiders cannot fully audit
the sealed tasks and contamination cannot be excluded. SOTA language additionally requires a
matched public evaluation against named systems, disclosed resources and privileges, repeated
trials, publishable artifacts, uncertainty, and improvement on the success/cost/safety Pareto
frontier.
