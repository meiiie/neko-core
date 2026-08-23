# Human-gated self-improvement

This directory is an optional experiment surface for improving Neko's harness. It is not a daemon, release
authority, or source of product truth. The owner starts a bounded run deliberately, reviews its diff, and
ships it only through the same tests and release gates as any human-authored change.

| File | Purpose |
|---|---|
| [STATE.md](STATE.md) | Current baseline, measurement focus, and most recent accepted move |
| [BACKLOG.md](BACKLOG.md) | Candidate improvements; an idea is not a commitment |
| [RESEARCH.md](RESEARCH.md) | Dated evidence and possible mappings to Neko |
| [HARNESS.md](HARNESS.md) | Small-change protocol for an experimental pass |

The canonical product architecture is [../HARNESS-ARCHITECTURE.md](../HARNESS-ARCHITECTURE.md). The canonical
history is [../process/WORKLOG.md](../process/WORKLOG.md). If these files disagree, code, tests, current process
docs, and owner direction win.

## Admission loop

    read current state -> choose one measurable lever -> make one bounded change
           -> run targeted evidence -> run full gate -> human review
           -> accept and record, or revert completely

Research-only passes may update RESEARCH.md and BACKLOG.md but must not present an unimplemented idea as a
current capability. The loop never deletes safety checks, weakens permissions, publishes releases, or runs
forever without explicit owner authority.
