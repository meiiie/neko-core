# Implementation plan

Spec: ../specs/2026-11-10-task-dreaming-design.md

1. Pin behavior with deterministic tests in `test/dream.test.ts`: source quotes, uncertainty, bounds, malformed data and tool-free generation. Implement pure contracts/rendering in `src/core/dream.ts`.
2. Add scoped snapshot/atomic writer helpers to `src/core/memory.ts`, preserving legacy behavior. Add `src/adapters/dream-store.ts`: candidate records, snapshot comparison, atomic apply/idempotency, rollback. Pin concurrency, disabled/revoked scope, links, stale and interrupted cases.
3. Add `src/adapters/dream-input.ts` to extract a bounded evidence window from the existing task source/display stores without policy roles; report backlog. Add `src/adapters/dream.ts` to issue a single bounded provider request and validate before storing.
4. Add the explicit CLI entrypoint and command catalog, with local preview/show/apply/rollback and opt-in prepare. Reuse the task-session writer lease and preserve every archive reference. Test actual CLI processes against local fixtures.
5. Wire a small observed-only index into the shared memory context. Verify ordinary memory tools can read/search the generated note, scope isolation, and bounded injection.
6. Run final typecheck/lint/full test gate/doctor/policy/build sequentially, review the diff, document exact verification and remaining limits, and commit locally only.

Review focus: stale inputs after model wait, quoted malicious tool content, source role/uncertainty laundering, crash between audit and publication, disabled or retired task during provider work. No model spending in implementation or verification.
