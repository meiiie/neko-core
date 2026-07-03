---
name: test-driven-development
description: Use BEFORE writing implementation code for any feature, bugfix, or behavior change in a codebase that HAS a test runner (bun test, vitest, pytest, cargo test...). Write the test first, watch it FAIL for the right reason, then write the minimal code to pass. Catches "it looks right" bugs the model would otherwise ship unverified, and turns a vague ask into an executable spec. Skip for throwaway one-offs, pure config, or a repo with no test setup. ("viet test truoc, do-den-refactor, TDD").
---

# Skill: Test-Driven Development (write the test first)

The single biggest source of a coding agent shipping a wrong fix is **declaring success without running
anything that could prove it wrong**. TDD removes that: the test is written first, so "done" always means
"a check that could have failed, passed". Core principle: **if you didn't watch the test fail, you don't
know it tests the right thing** (a test that passes before your change tests nothing).

## When to use
- A new feature, a bug fix, a refactor, any behavior change — in a repo that already has a test runner.
- ESPECIALLY when the change touches money/security/parsing/an off-by-one/an edge case, or when a first
  attempt "looks right" (that feeling is exactly when an unverified bug slips through).
- SKIP: a throwaway prototype, generated code, pure config, or a repo with no test harness at all (there,
  fall back to running the actual command and reading the real output — never assume).

## The loop: RED -> GREEN -> REFACTOR

1. **RED — write ONE small failing test** that states the behavior you want (the narrowest case first).
   Run it. **Watch it fail, and read the failure** — it must fail for the RIGHT reason (the feature is
   missing / the bug is present), not a typo/import error. A test that errors on setup is not a red test.
2. **GREEN — write the MINIMAL code** to make that test pass. Not the general solution — the smallest thing
   that turns this test green. Run it. Watch it pass, and confirm the whole suite is still green.
3. **REFACTOR — clean up** with the test as a safety net (dedupe, rename, simplify). Re-run: stay green.
   Then the next case -> back to RED.

**The iron rule:** no production code without a failing test first. If you wrote code before the test,
the honest move is to comment it out (or set it aside), write the test, watch it fail, THEN restore the
code and watch it pass — otherwise you never proved the test can fail.

## For a BUG FIX specifically (the highest-value case)
Reproduce the bug AS A FAILING TEST first (the exact input that misbehaves, asserting the CORRECT output).
Watch it fail — that proves you've actually reproduced it. Then fix. Watch it pass. Now you have both the
fix AND a permanent regression guard. (This is why the fix "sticks": the test fails again if anyone
reintroduces the bug.) Pairs with [[systematic-debugging]] — find the root cause, then lock it with a test.

## Common traps (all are rationalizations — stop when you catch one)
- "It's obviously correct, I'll skip the test" -> obvious code has bugs too; the test costs 30 seconds.
- Writing the test to match code you already wrote -> that just encodes the current (possibly wrong)
  behavior. Write the test from the SPEC, independently.
- A test that passes on the first run without your change -> it tests nothing; make it fail first.
- Asserting on incidental output (log strings, ordering that isn't required) instead of the actual
  contract -> test the behavior the user cares about, not the phrasing.
- Testing many things in one giant test -> one behavior per test; a focused failure tells you WHERE.

## In Neko's own repo
Tests are `bun test` (see `test/*.test.ts`), one runnable check per non-trivial branch/parser/money/
security/abort path (RULES.md). Match the surrounding test style. The verify loop (`bun run typecheck` ·
`bun test` · policy · build) is the outer gate; TDD is how each change gets there green.
