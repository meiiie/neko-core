# NEKO Anti-Slop Batch 2 — 2026-09-21 (Asia/Saigon)

## Goal
Batch 2 after PR #68 (`main` @ `2e660ed`). Drive remaining anti-slop errors to 0 without behavior change; freer-auto untouched.

## Baseline (post-Batch 1)
| Metric | Count |
|--------|------:|
| Total anti-slop errors | **20** |
| `no-known-value-widening` | 7 |
| `no-runtime-typeof` | 6 |
| `no-conditional-empty-object-spread` | 4 |
| `no-unknown-parameters` | 3 |

## Batch 2 scope
Representation narrowing / unparsed I/O (`typeof` + `Raw`/`unknown`) and shape erasure (anon returns, open dicts, conditional empty spreads).

**In scope (CONT-17 files)**
- `src/core/agent.ts`, `cost.ts`, `tool-runtime.ts`, `permissions.ts`
- `src/ui/chat.tsx`, `format.ts`, `chat-lines.ts`, `chrome-glyphs.ts`
- `bin/neko.ts`
- `test/agent.test.ts`

**Out of scope**
- freer-auto / auto-default-smoke behavior
- Mass test deletion
- New features

## Fixes (surgical, no behavior change)
1. **typeof → domain guards**: `isText` for observations/content; `isMode(any)` via literal equality (drop redundant `typeof === "string"`).
2. **unknown params → named wire/domain types**: `CostTracker.restore` validates `number` fields; `applyUniqueEdit` takes `WireValue`.
3. **Named owner contracts**: `ContextSpan`, `ElidedDiff`, `ScrollAwayBaseline`; chrome maps use `satisfies Record<ChromeKind, string>`.
4. **Conditional empty spreads**: omit via `undefined` (same as existing bench path) or assign optional fields in separate statements.

## Results
| Metric | Before | After |
|--------|--------|-------|
| Total anti-slop errors | 20 | **0** |
| Typecheck | pass | pass |
| `bun test test/cost.test.ts test/agent.test.ts` | — | 124 pass |

## Branch / PR
See PR from `fix/anti-slop-b2-narrowing-shape`.
