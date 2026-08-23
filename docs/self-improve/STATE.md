# Self-improvement state

Updated: 2026-08-24

## Baseline

Neko Core v1.0.0 is the stable product baseline. The public coding and GUI smoke tiers that once guided early
development are saturated or versioned historical evidence; they are regression signals, not sufficient proof
of improvement. New harness claims require an unsaturated tier or a direct, reproducible incident regression.

## Current focus

Owner-directed work has priority. The autonomous script is idle unless the owner explicitly starts a bounded
run. Near-term measurement targets are:

- cold start, complete first frame, first token, and input latency;
- provider stream continuity and truthful unknown-outcome recovery;
- targeted verification after mutation without redundant whole-suite work;
- long-transcript and mouse interaction performance;
- sandbox and sidecar teardown under interruption.

## Accepted latest move

The 1.0 lifecycle pass primes only the fixed welcome row before Ink's first fullscreen frame and defers
alternate-screen restoration until Ink's final erase writes have settled. A real ConPTY regression asserts that
the header is present when the composer first appears and that no restore control sequence lands after the
resume hint. Full history remains lazy, so the fix does not trade startup correctness for unbounded warming.

## Measurement rules

- Compare the same provider, model, effort, task set, runtime, and harness version.
- Keep infrastructure failures separate from model failures.
- Report pass rate with steps, tokens, latency, and constraint violations; no single aggregate hides a safety
  regression.
- Record a change only after the full gate passes; otherwise revert it and keep only the lesson.

Detailed release history belongs in [../process/WORKLOG.md](../process/WORKLOG.md), not this short state file.
