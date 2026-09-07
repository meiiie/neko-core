# Self-improvement experiment protocol

Read [repository instructions](../../AGENTS.md), [harness architecture](../HARNESS-ARCHITECTURE.md),
and the relevant [evaluation contract](../process/EVALUATION.md). This protocol governs
a deliberate experiment; it does not authorize the legacy unattended runner.

## One bounded change

1. State one falsifiable prediction and its user-visible outcome.
2. Freeze the baseline, task, provider/model, effort, resource budget, and measurement.
3. Implement one coherent change without weakening tests, authority, or completion criteria.
4. Run checks appropriate to the change in [TESTING.md](../process/TESTING.md).
5. Review the diff and evidence. Accept only demonstrated improvement; if inconclusive,
   report it. Any revert must affect only the experiment's own changes.
6. Record accepted work in [WORKLOG.md](../process/WORKLOG.md); scores belong in
   [EVALUATION.md](../process/EVALUATION.md).

Raw hidden validator cases must remain unavailable to the implementer. Benchmark
failures, infrastructure exclusions, and interrupted runs remain distinct and immutable.
A passing local test or a more capable development model alone does not establish lift.

Commit, push, release, paid inference, and unattended loops require owner direction
within the current task. ProgramBench's pause remains in force.
