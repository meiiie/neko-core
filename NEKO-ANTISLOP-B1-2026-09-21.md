# NEKO Anti-Slop Batch 1 — 2026-09-21 (Asia/Saigon)

## Goal
Dedicated anti-slop campaign on `meiiie/neko-core` `main` @ `340db94+`.
CI was red on all OS: **43 errors, 0 warnings** from `bun run lint` (anti-slop).
Typecheck passed; tests never ran because lint failed first.

## Batch 1 scope (this PR only)
Fix unjustified `as` assertions missing `SAFETY:` comments (~23).

**In scope**
- Tests: `agent`, `gui-eval`, `approval-box`, `ux`, `markdown`, `chat-ui`, `cost`, `auto-default-smoke`
- Src: `src/ui/chat-lines.ts` (one cast)

**Out of scope** (later batches)
- Representation-narrowing (`no-runtime-typeof`)
- Shape-erasure / known-value-widening
- Conditional empty-object spreads
- Unknown parameters
- Unless one-line adjacent to a Batch 1 cast (none were)

## Constraints honored
- Do **not** mass-delete tests
- Keep **freer auto** (auto-default-smoke / yolo footer probes only gained SAFETY comments)
- Surgical: add proper `SAFETY:` justifications (or remove casts only if unnecessary — none removed)

## Results
| Metric | Before | After |
|--------|--------|-------|
| Unjustified `as` (SAFETY) | 23 | **0** |
| Total anti-slop errors | 43 | **20** |

Remaining 20 are non-Batch-1 rules (typeof / widening / spreads / unknown params).

## Branch / PR
See PR from `fix/anti-slop-b1-safety-as`.
