# Self-improvement harness protocol

Read [../HARNESS-ARCHITECTURE.md](../HARNESS-ARCHITECTURE.md) before changing the harness. This file defines
the experiment protocol, not a second architecture.

## Choose one lever

- **Quality:** task success, constraint adherence, recovery, or fresh verification.
- **Efficiency:** provider calls, tokens, redundant tools, cold start, or rendering latency.
- **Robustness:** malformed inputs, cancellation, crash recovery, and process cleanup.
- **Security:** authority narrowing, secret isolation, sandbox enforcement, and effect integrity.
- **Extensibility:** a smaller, clearer provider/tool/skill/ACP seam.

State one falsifiable prediction before editing, for example: priming the fixed welcome row makes the header
present when the composer first appears without warming session history. Name the direct regression test and
the no-regression gate.

## Constraints

1. One lever and one coherent diff per pass.
2. No benchmark, oracle, timeout, or safety weakening to manufacture a pass.
3. No credentials, private provider contracts, or proprietary copied code.
4. No automatic commit, push, merge, tag, release, or external deployment without explicit owner authority.
5. A failed or ambiguous experiment is reverted; its lesson may be recorded without keeping the code.

## Required evidence

- the smallest test that fails before and passes after;
- relevant subsystem tests;
- bun run typecheck, bun run lint, and the full bun test;
- neko policy for any authority/tool/config change;
- compiled binary and real-terminal probes for lifecycle, input, rendering, or process changes;
- benchmark deltas only when the benchmark is unsaturated and the comparison contract is unchanged.

Accepted work is summarized in STATE.md and the engineering detail goes to the process work log.
