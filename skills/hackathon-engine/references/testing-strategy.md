# Testing strategy — enough tests to trust the demo, not a coverage trophy

At a hackathon, tests exist to **make the verify loop real** (Stage 5) and stop the demo path from
silently breaking as you move fast — not to hit a coverage number. Test what would lose you the demo.

## What to test (in priority order)
1. **The demo path, end to end.** One test that drives the exact flow the judges will see (the "happy
   path" that must work on stage). If nothing else exists, this does.
2. **The acceptance criteria from `SPEC.md`.** Each observable "user can X, sees Y" gets a check. These
   are the truth the verify loop asserts against — not a self-authored happy path you invented.
3. **The money/state/security paths.** Anything that mutates data, handles auth, or does the core
   computation. A wrong number or a broken auth in the demo is fatal.
4. **The nasty inputs that crash live demos.** Empty, huge, malformed, unicode, the double-click. One
   negative test per input boundary prevents the on-stage exception.

## What to skip (ponytail)
Exhaustive unit coverage, tests for glue you'll delete, UI-pixel snapshots, mocking everything into a
maze. A test you won't run or that tests the framework is waste. Coverage % is not the goal; a trustworthy
demo path is.

## How, fast
- **One command runs them all** and is wired into the verify loop + CI (`devops.md`): red never ships.
- Prefer a few **integration/e2e tests** (hit the real API / render the real page) over many isolated
  unit tests — they catch what actually breaks and cost less to write under time pressure.
- Deterministic: seed randomness, freeze time, stub only the truly external (a paid API, a clock).
- Fast: the suite must run in seconds so you actually run it every slice. Slow tests get skipped, then rot.
- If it's genuinely a bugfix, **write the failing test first** (TDD) — it proves the bug and the fix in one
  move (see the `test-driven-development` skill).

## The honest bar (ties to the engine's skepticism)
A test that only asserts your happy assumption is theater. Assert the **observable behavior** a user or
judge would check, from a **fresh run** — and read the actual result, don't trust "it should pass". A
green suite you didn't watch run is not evidence.
