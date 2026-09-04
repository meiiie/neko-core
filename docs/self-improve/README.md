# Human-gated self-improvement

This directory is an optional experiment surface for improving Neko's harness. It is not a daemon, release
authority, or source of product truth. The owner starts a bounded run deliberately, reviews its diff, and
ships it only through the same tests and release gates as any human-authored change.

| File | Purpose |
|---|---|
| [STATE.md](STATE.md) | Current baseline, measurement focus, and most recent accepted move |
| [HARNESS.md](HARNESS.md) | Small-change protocol for an experimental pass |

The canonical product architecture is [../HARNESS-ARCHITECTURE.md](../HARNESS-ARCHITECTURE.md). The canonical
evaluation contract and active objective are [../process/EVALUATION.md](../process/EVALUATION.md) and
[../process/HARNESS-GOAL.md](../process/HARNESS-GOAL.md). Candidate ideas live in issues or a bounded experiment,
not an ever-growing in-repository backlog. If these files disagree, code, tests, current process docs, and owner
direction win.

## Admission loop

    read current state -> choose one measurable lever -> make one bounded change
           -> run targeted evidence -> run full gate -> human review
           -> accept and record, or revert completely

Research-only passes may update a dated file under `docs/research/`, but must not present an unimplemented idea
as a current capability. Accepted decisions move into the relevant canonical process document. The loop never
deletes safety checks, weakens permissions, publishes releases, or runs forever without explicit owner authority.
