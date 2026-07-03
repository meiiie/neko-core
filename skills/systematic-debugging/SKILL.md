---
name: systematic-debugging
description: Use when facing ANY bug, test failure, crash, or unexpected behavior, BEFORE proposing or trying a fix. Find the ROOT CAUSE first — read the actual error, reproduce, trace the data flow to where it truly goes wrong — instead of guessing patches at the symptom. Stops the flail loop (edit-rerun-edit-rerun with slightly different guesses) that burns steps and masks the real bug under a pile of band-aids. ("go bug/loi/crash, tim nguyen nhan goc, debug co he thong").
---

# Skill: Systematic debugging (root cause before any fix)

The expensive failure mode isn't a hard bug — it's **guessing**: trying a fix at the symptom, re-running,
trying a slightly different guess, and stacking band-aids that each move the problem without solving it.
Core principle: **no fix without a root-cause first**. A symptom fix that makes the error go away without
you understanding WHY is not a fix — it's a hidden second bug. (Neko's own loop guards trip on exactly
this: repeated edits to one file, a failing command re-run 3x — those are the "you're guessing" alarm.)

## The iron rule
```
NO FIX UNTIL YOU CAN NAME THE ROOT CAUSE
```
If you can't say "the bug is X at Y because Z", you're still in investigation — don't edit yet.

## Phase 1 — investigate (do this BEFORE touching code)
1. **Read the actual error, completely.** The full message, the stack trace, the line/file/exit code. It
   very often names the exact cause; skimming past it is how hours get lost. A non-zero exit or an
   assertion diff (`expected X, got Y`) is a precise clue, not noise.
2. **Reproduce it reliably.** What exact input/state triggers it? Every time, or intermittently? If you
   can't reproduce it, you can't know you fixed it — gather more data, don't guess. (For a bug, capturing
   the repro as a failing test is the strongest form — see [[test-driven-development]].)
3. **Check what changed.** `git diff` / recent commits / a new dependency / a config or environment
   difference. A bug that appeared suddenly usually has a recent cause.
4. **Trace the data flow to the TRUE origin** (crucial for multi-file/multi-layer bugs). The place the
   error SHOWS is often downstream of where it's CAUSED: a wrong value printed in `format()` may be a
   wrong shape returned by `parse()` two layers up. Follow the bad value backwards to the first point it's
   wrong — fix THERE, not where it surfaces. (A fix at the symptom layer often passes one test and breaks
   another; the root-cause fix passes all of them.)

## Phase 2 — hypothesis, then fix
State the root cause as one sentence you believe. Predict what fixing it will do (which test goes green).
Make the SMALLEST change at the root cause. Then VERIFY: re-run the exact failing check and confirm it
passes AND the rest still passes — judge the ACTUAL state, not your memory of what you intended.

## Phase 3 — confirm it's really fixed
- Re-run the full relevant test/command, not just the one case.
- Ask: could this same root cause bite elsewhere? (If a helper mis-rounded money, every caller was
  affected — fix the helper, not one call site.)
- If a fix "works" but you don't understand why -> you're not done; you got lucky and the bug will return.

## Red flags you're guessing (stop and go back to Phase 1)
- Editing the same file a 3rd time with a different tweak, or re-running a failing command with a small
  change each time — the loop guards will (rightly) nag; heed them.
- "Let me just try..." without a named hypothesis.
- Changing code you don't understand to see if the error moves.
- Adding a try/catch or a special-case to make the symptom disappear without knowing the cause.

## In Neko's own repo
Reproduce against `bun test` (or the exact failing command); read the real output (bash marks failures
`(exit N -- FAILED)`); trace across the ports/adapters seams (a UI symptom can originate in a core
function). The verify loop confirms the fix holds; a bug fix should leave behind a test that fails without
the fix (regression guard).
