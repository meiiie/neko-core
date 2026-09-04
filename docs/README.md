# Neko Core documentation

This index separates current product contracts from historical evidence. A current behavior should have one
canonical document; dated research and logs may explain why it exists but do not override the code, tests, or
the documents listed here.

## Start here

- [README](../README.md) - install, providers, daily use, and project overview.
- [Harness architecture](HARNESS-ARCHITECTURE.md) - how model, loop, context, tools, persistence, and UI fit.
- [Ports and adapters](process/ARCHITECTURE.md) - dependency and trust boundaries.
- [Extending Neko](EXTENDING.md) - providers, tools, skills, recipes, and MCP.
- [Working rules](process/RULES.md) - repository invariants and verify loop.
- [Testing](process/TESTING.md) - deterministic, terminal, sandbox, and live evaluation layers.
- [Stability and support](process/STABILITY.md) - the public 1.x compatibility and support promise.
- [Release](process/RELEASE.md) - the stable delivery contract.

## Capability guides

- [ACP](process/ACP.md)
- [Browser Bridge](process/BROWSER-BRIDGE.md)
- [Meetings](process/MEETINGS.md)
- [Office artifacts](process/OFFICE.md)
- [Oracle](process/ORACLE.md)
- [Sandbox](process/SANDBOX.md)
- [Web and search](process/WEB.md)
- [Scheduling and automation](process/AUTOMATION.md)

## Evaluation and project state

- [Public evaluation](process/EVALUATION.md) defines evidence and claim gates.
- [Active harness objective](process/HARNESS-GOAL.md) defines the current hypotheses, invariants, and stopping rules.
- [Roadmap](process/ROADMAP.md) contains only current and future product direction.
- [Changelog](../CHANGELOG.md) is the user-facing release history.
- [Work log](process/WORKLOG.md) is the compact current engineering record; older detail remains in Git.
- [Self-improvement](self-improve/README.md) is an optional, human-gated experiment surface.

## Non-normative archives

`research/` contains dated design evidence. `marketing/` contains campaign source material. Neither directory
is loaded by the product or treated as a current implementation contract. Speculative queues and superseded
operational narratives are removed from the active tree once their decisions reach a canonical process document;
their complete history remains recoverable through Git.
