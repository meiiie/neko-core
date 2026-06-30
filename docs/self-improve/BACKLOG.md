# Backlog — the loop's goal queue

Concrete, SMALL, verifiable improvement ideas. The loop picks the top unchecked item; a RESEARCH pass appends
new ones when this runs low. Each item should name **what to change + how it's verified** (a test, a bench
metric, typecheck). Mark `[x]` when committed (with the commit hash). Keep items independent so a revert of
one never blocks another.

## Now (high value, low risk)
- [ ] **Failure-aware compaction (ACON-style).** `compact()`/`shrinkOldObservations` clip statically. When a
  later turn re-reads a clipped observation or errors right after compaction, record what was clipped and
  avoid clipping that shape next time. Verify: a unit test for the "don't re-clip a just-referenced
  observation" rule; bench tokens not worse.
- [ ] **Token audit of the system prompt + tool schemas.** Measure the fixed prompt/schema token cost; remove
  redundancy/dedup without losing guidance. Verify: bench `in` tokens drop, pass-rate unchanged.
- [ ] **Peer-review before self-commit (DGM).** In `scripts/self-improve.ts`, before committing a self-change,
  a second model pass reviews the diff ("is this a real improvement, any regression risk?"); only commit if
  it agrees. Verify: the loop still commits clean changes; logs the review verdict.
- [ ] **Per-product / per-context outlier flag already done; generalize the verify gate** to also run the
  bench (no-regression) on changes touching `src/core` or `src/adapters/providers`. Verify: gate catches a
  deliberate token/pass regression.

## Research-seeded (turn into "Now" items as they're scoped)
- [ ] Archive/population self-improvement (DGM): keep N improved branches, benchmark each, keep the best —
  parallel exploration instead of one linear branch.
- [ ] Harder, long-horizon bench tasks (SWE-EVO style): multi-step, cross-module, with a regression test.
- [ ] Autonomous "relevance" pass (Focus): prune irrelevant context each step, not just at 85% full.

## Done
<!-- the loop appends:  [x] <item>  (commit <hash>, bench delta <±tok / ±pass>) -->

---
*If this list is empty or stale, the loop triggers a RESEARCH pass (web_search SOTA + new papers) and appends
fresh items here.*
