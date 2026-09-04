# Neko Core testing contract

The suite is organized by failure class, not by a target test count. A test earns its place when it protects a
distinct behavior, boundary, incident, or platform integration. Old run logs belong in WORKLOG.md; this file
contains only the current contract.

## Required local gate

Run from the repository root with the stable Bun version pinned in CI:

    bun run typecheck
    bun run lint
    bun test
    node bin/neko-source.cjs doctor
    node bin/neko-source.cjs policy
    bun run build

Doctor and policy may return explicit warnings for the developer's current profile, project trust, TTY, or
bounded-auto posture; they must not crash, leak credentials, or misreport an unavailable boundary as healthy.

GitHub CI repeats the full suite on Linux, macOS, and Windows. Windows shards the suite into fresh sequential
processes to avoid cross-file SRT/UIA fixture pressure without dropping any test.

## Test classes

### Core and adapters

- Agent tests cover loop progression, tool-call validation, eager/concurrent safe execution, context relief,
  compaction, recovery, usage accounting, aborts, validation debt, and completion gates.
- Provider tests cover canonical conversion, streaming parsers, semantic commit barriers, retry, continuation
  ownership, effort negotiation, usage, and bounded malformed input.
- Tool tests cover schemas, permissions, exact capability leases, path and hardlink boundaries, checkpoints,
  side effects, background processes, abort/timeout cleanup, and host/sandbox routing.
- Session tests cover atomic publication, readable backup fallback, writer leases, bounded metadata, durable
  checkpoints, unknown outcomes, load/replay, and resume.
- Config, auth, MCP, browser, Office, meeting, relay, and support-pack tests each own their external trust
  boundary and never require a live credential in the ordinary suite.

The architecture test rejects inward dependency violations and broken relative imports. Secret-bearing stores
are always isolated into temporary homes under NODE_ENV=test.

### UI and virtual terminal

Ink component tests cover the input editor, approval and plan boxes, model/login pickers, Markdown, command
dispatch, transcript folding, session resume, and busy/cancel state.

The fullscreen simulator renders the real ChatApp through test/vt.ts. It verifies Unicode cells, startup,
typing, resize, scroll, streaming, selection in both directions, edge auto-scroll, hover/wheel transitions,
pickers, approvals, and both the incremental and differ-less renderers.

Virtual-terminal tests are deterministic and fast, but they do not replace a real PTY. A renderer can produce
the right React tree while the compiled runtime drops input or restores terminal modes in the wrong byte order.

### Real PTY/ConPTY

- scripts/input-probe.ts launches the compiled binary, types a byte through a real PTY/ConPTY, and requires
  raw-input echo and a success verdict.
- scripts/e2e-startup-lifecycle.ts asserts that the welcome header is already visible when the composer first
  appears, then exits and proves terminal restoration precedes the resume hint with no late restore sequence.
- scripts/e2e-conpty-ghost.ts exercises typing, output displacement, resize, and ghost-frame recovery.
- scripts/bench-scroll-conpty.ts measures scroll response and settle time. Render changes compare its recorded
  baseline instead of relying on visual confidence.

The lifecycle script accepts --source for source-mode diagnosis and --exe <path> for a release artifact. Release
gates exercise the actual binary.

### Live platform primitives

Tests that require Bubblewrap, Seatbelt, Windows SRT/ACL, Office engines, WPF/UIA, or a real browser must be
explicit about availability. A body-level early return is not a pass. CI uses requirement environment flags for
the primitives it provisions; absence then fails closed.

Windows SRT policy and failure semantics stay in the deterministic default suite. Its live process/ACL probes
are an explicit lane because they depend on host provisioning and can take tens of seconds:

```powershell
$env:NEKO_TEST_LIVE_SRT = "1"
rtk bun test test/sandbox.test.ts
Remove-Item Env:\NEKO_TEST_LIVE_SRT
```

If that lane is required, an unavailable or unhealthy SRT is evidence to fix; it is not replaced by a passing
default test or an unconfined fallback.

No platform test may execute a workspace-local binary discovered through PATH, a symlink/junction alias, or an
unverified support pack.

## Evaluation contract

Coding and GUI benches are opt-in because they spend provider quota. Every trial receives a fresh workspace,
fresh provider instance, isolated home, fixed tool ceiling, immutable seed, and a deterministic verifier. The
candidate cannot read harness implementation or hidden verifier files through structured tools or sandboxed
commands.

Reports bind source/artifact digest, task and verifier identities, runtime, platform, profile, redacted config,
sandbox state, step budget, and SLA. Different fingerprints are not comparable. Infrastructure failures stay in
the denominator and mark the report NOT COMPARABLE.

The public easy, hard, and frontier packs are regression/calibration rulers, not SOTA proof. A single trial or a
saturated tier cannot support a frontier claim. See [EVALUATION.md](EVALUATION.md) and the dated frontier-v2
design under docs/research.

## Skips, timeouts, and flakes

- Use test.skipIf only when the missing primitive is outside the test's responsibility and the required CI lane
  covers it elsewhere.
- A custom timeout must reflect a real external ceiling or deterministic fake-time contract.
- Never raise a timeout to hide blocked teardown, delete a distinct assertion to reduce count, or retry until
  green without identifying the race.
- A flaky test is treated as possible product evidence until the product path is disproven.
- Shared live primitives run sequentially; pure tests may run in parallel.

Windows Bash lifecycle regressions must prove that a grandchild cannot act after an abort or timeout. Tests may
wait for fixture readiness and for Windows to release handles, but must not enlarge the production command
deadline to make teardown appear green.

## Release-only checks

Before a version tag:

1. Run the required local gate on the exact commit.
2. Run the startup lifecycle E2E on both renderers.
3. Run the ghost/typing E2E three times.
4. Run the scroll bench for render changes.
5. Run the secret scan.
6. Build with the exact stable Bun runtime pinned by release.yml.
7. After tagging, wait for every release matrix job and verify all binaries, checksums, latest-release routing,
   and the public download page.

The authoritative order and artifact contract are in [RELEASE.md](RELEASE.md).
