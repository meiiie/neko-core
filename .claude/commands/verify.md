---
description: Run the Neko Core verification loop (tests, compile, doctor, policy)
---

Read `AGENTS.md` and `docs/process/TESTING.md`. If the owner requested a scoped check,
use that scope; an unqualified `/verify` runs the full local gate:

1. `bun run typecheck`
2. `bun run lint`
3. `bun test`
4. `node bin/neko-source.cjs doctor`
5. `node bin/neko-source.cjs policy`
6. `bun run build`

Use the CI-pinned Bun version and `rtk` when available. Run heavy checks sequentially.
Report PASS/FAIL/SKIP with the reason; redact sensitive output. Diagnose a failure before
retrying. Do not launch a benchmark or the legacy self-improve runner.
