# Test-suite quality audit - 2026-08-22

## Decision

Neko does not optimize for a smaller or larger raw test count. A test stays when it owns a distinct
failure contract and gives reliable signal; it is rewritten or removed when evidence shows that it
duplicates another contract, never exercises its advertised path, or is dominated by a cheaper test.

The current static inventory is 135 files and 1,468 test declarations (about 10.9 tests per file),
including 20 explicit skips and 116 custom timeouts. Only one exact test title is duplicated, across
two analogous support-pack suites. Those numbers do not support a bulk deletion. They do identify
custom-timeout and live-platform tests as the first review queue.

This follows the engineering guidance that tests are maintained production code: reviewers should ask
whether each test is useful, simple, and actually fails when the behavior breaks. Hermeticity,
determinism, and independence are stronger quality signals than suite size. A broad end-to-end layer is
kept thin because it is slower and less diagnostic; fast contract tests carry most behavioral coverage.

Primary references:

- [Google Engineering Practices: What to look for in a code review](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
- [Google Testing Blog: Test sizes](https://testing.googleblog.com/2010/12/test-sizes.html)
- [Google Testing Blog: Just say no to more end-to-end tests](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html)
- [Bazel Test Encyclopedia](https://bazel.build/reference/test-encyclopedia)
- [Stryker mutation testing](https://stryker-mutator.io/docs/)

## Evidence from the SRT incident

The slow validator regression was not evidence that SRT failed to reap its process tree. The child test
finished, but SRT then spent tens of seconds granting and restoring ACLs because Neko placed writable
scratch and test roots directly below the Windows `%TEMP%` Known Folder. The upstream behavior is tracked
in [sandbox-runtime issue 457](https://github.com/anthropic-experimental/sandbox-runtime/issues/457).

Two changes remove the false signal:

1. Production read-only SRT scratch now lives one level below a fresh launch-private parent. SRT grants
   the same exact directory and Neko removes the whole private parent during cleanup.
2. The turn-capability test fixture uses the same ordinary nested shape. The old fixture benchmarked a
   Windows profile ACL edge case rather than the capability contract it claimed to test.

The exact validator test fell from roughly 80-120 seconds to roughly 3-6 seconds. A five-repeat live SRT
stress completed ten launches with no failure and no new residual SRT process. Live SRT tests now use
`test.skipIf` when the optional primitive is unavailable, so they cannot silently return and count as a
pass.

## Quality bar

A test should satisfy all applicable points:

1. **Distinct contract.** Its failure tells the reviewer which product invariant broke.
2. **Counterfactual value.** A plausible implementation defect or targeted mutant makes it fail.
3. **Deterministic dependencies.** Time, randomness, filesystem layout, processes, network, and platform
   capabilities are injected, isolated, or declared as live infrastructure.
4. **Correct size.** Pure logic stays process-local; subprocess, OS sandbox, PTY, Docker, and provider
   checks live in progressively smaller integration lanes.
5. **Bounded lifecycle.** Every child has cancellation, tree cleanup, and a postcondition. A larger timeout
   is not a repair for an unexplained hang.
6. **Honest result.** Missing optional infrastructure is an explicit skip. Required CI infrastructure
   fails closed. A body-level early return must not produce a green test.
7. **Incident value.** Regressions that prevented a shipped or release-blocking bug are retained unless a
   cheaper test proves the same failure boundary.

## Cleanup protocol

Test deletion is evidence-gated, not aesthetic:

- First remove false passes, sleep-based timing, shared global state, and fixtures that exercise the wrong
  layer.
- Then pilot mutation testing only on high-risk pure modules (permission decisions, turn planning, stream
  parsing, and completion state). Whole-repository mutation runs are too expensive to be a default gate.
- Delete or merge a test only when it kills no unique relevant mutant, duplicates an already-owned
  contract, and has no independent incident/platform value.
- Track runtime and flake rate per file. Quarantine must have an owner and issue; retries must not turn an
  unexplained red result into release evidence.
- Keep live Windows SRT, ConPTY/UIA, Docker, and real-provider checks in explicit lanes. Ordinary unit
  shards must not depend on those services being installed.

The next audit target is the 116 custom timeouts. They should be classified as real external-operation
ceilings, bounded deterministic fake-time tests, or historical padding. Only the third group should be
removed or rewritten.
