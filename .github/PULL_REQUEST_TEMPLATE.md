<!-- Thanks for contributing! Keep PRs small and focused. -->

## What & why

<!-- What does this change, and why? Link any related issue (e.g. "Closes #12"). -->

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun test` passes
- [ ] `bun bin/neko.ts policy` is **PASS** (the safe/gated tool boundary is intact)
- [ ] Added or updated a test for this change
- [ ] No secrets committed; printed (non-TUI) strings are ASCII
- [ ] A new model/endpoint is a config **profile**, not a code change (if applicable)
