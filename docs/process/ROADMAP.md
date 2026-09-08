# Neko Core roadmap

## Current status (2026-09-08) - v1.6.0 released

Neko Core is a production terminal agent with a stable public CLI, embeddable core, and ACP v1 server.
The current 1.x platform includes:

- a provider-agnostic streaming agent loop with bounded recovery and evidence-based completion;
- durable sessions, atomic checkpoints, crash recovery, rewind, handoff, and ACP load/resume;
- one governed tool boundary for local tools, MCP, browser, Office, computer use, and sidecars;
- config-first API and subscription routes with isolated credentials and live model catalogs;
- a fullscreen Ink UI with hardware scrolling, mouse interaction, image paste, alerts, and clean lifecycle;
- embedded global skills, governable memory/workflows/playbook, and optional support packs;
- five standalone release targets with SHA-256 sidecars and verified exact-version rollback;
- stable Bun 1.4.0 as the compiled runtime, including the Windows stdin engine required by the input probe.
- launch-authorized ACP host profiles for embedding products, beginning with NekoCut's exclusive six-tool
  MCP-over-ACP surface.
- optional session-scoped ACP Computer capability negotiation for Wiii, with semantic stale-state and lease
  guards, bounded persistent-workstation awareness, and fast stable launcher discovery rather than
  coordinate-blind host control;
- separate Cline Account OAuth and API-key routes, plus config-first B.AI and TokenRouter gateways.
- direct host Bash as the zero-flag default, with hidden Windows child consoles, exact runtime/toolchain context,
  background process support, and Computer Use reserved for visible GUI interaction;
- an explicit provider-agnostic completion contract and independent read-only validator for closed-loop work.
- resumable, disk-streamed release downloads plus compressed transfer artifacts, with final binary digest and
  embedded-version verification before atomic activation.

**Branch:** `main`. **Current release:** [v1.6.0](https://github.com/meiiie/neko-core/releases/tag/v1.6.0)
is public, published 2026-09-07 18:05 UTC (2026-09-08 in Vietnam), commit
`adbb74cd518ce60d85bb8d80b186066c9b529420`. Cross-platform CI and the release workflow
passed; all 17 assets, latest-release routing, the downloaded Windows binary's SHA-256
and version, and the public website were verified. See the [release record](WORKLOG.md).
The 1.0 compatibility contract remains the long-term stable baseline. v1.5.0 makes host Bash the normal
no-flag shell route while preserving explicit fail-closed sandboxing. v1.5.1 changes only release transport:
resumable checkpoints and compressed assets;
it does not change providers, tools, authority, ACP, sessions, or the completion controller.
Provider protocols, ACP hosts, and durable sessions remain compatible. The complete pre-1.0 history remains in
[CHANGELOG.md](../../CHANGELOG.md) and
[WORKLOG.md](WORKLOG.md).

## Compatibility policy

v1.6.0 includes profile endpoint ownership repair, home-directory
ChatGPT transport startup, metadata-driven account catalogs and routing (including
GPT-6 Astra), and reviewed private feedback email delivery with optional session logs.
See [incident analysis](../research/provider-incidents-2026-09-07.md) and
[feedback privacy](FEEDBACK.md). These are not included in v1.5.1;
the dedicated Cloudflare feedback backend is deployed and accepted two synthetic
emails, including a 500,512-byte report and duplicate-receipt checks. Gmail Inbox
placement is not independently confirmed. Follow [RELEASE.md](RELEASE.md) for the
full local gate, cross-platform CI and complete release-asset verification; a
successful targeted check or a bumped version alone is not publication evidence.

The 1.x CLI, configuration, durable-data, SDK, ACP, authority, and delivery commitments are defined in the
canonical [stability and support policy](STABILITY.md). Roadmap work may extend those contracts, but it may not
silently narrow them.

## Active priorities

### Current work and resume point

- v1.6.1 release candidate (2026-09-09): install the complete official Codex App Server
  package, including Code Mode host/resources; reject incomplete legacy packs and
  verify a local dynamic-tool round trip before activation. Simplify `/feedback`
  to two screens with conversation off by default and safe support diagnostics.
  Repair existing managed packs automatically before requests, with cancellable
  preparation and retained drafts. First-time setup remains opt-in. Publication
  and feedback-service deployment are authorized; verify the release record below
  before treating the candidate as published. The owner requested focused tests
  instead of repeating the full suite for this patch.
  See [current work log](WORKLOG.md) and [feedback contract](FEEDBACK.md).
- Repository instruction/documentation refresh for GPT-6 Astra, reviewed 2026-09-07.
  Shared instructions are in [AGENTS.md](../../AGENTS.md); model-specific rationale and
  official sources are in [the dated review](../research/codex-astra-instructions-2026-09-07.md).
- The instruction refresh itself does not change runtime behavior. The separately
  tested provider fixes and private-feedback feature ship together in v1.6.0.
- ProgramBench remains paused until explicit owner resumption. Frozen R6 is incomplete:
  10 terminal results, two interrupted cells, six pending cells. Full details and claim
  limits are in [EVALUATION.md](EVALUATION.md). Preserve its source and records; any new
  comparison must pass provenance checks before work starts.

### Reliability

- Continue field-soak monitoring for startup, provider streaming, sandbox teardown, updater locks, and
  long-running turns. A new incident class blocks baseline promotion.
- Keep unknown tool outcomes non-replayable and make recovery explanations more actionable.
- Reduce flaky test infrastructure without deleting distinct safety or lifecycle contracts.

### Performance

- Measure cold start, first frame, first token, input latency, and long-transcript rendering separately.
- Optimize only behind repeatable before/after evidence; never trade away context, verification, or safety for
  a startup benchmark.
- Keep expensive support components lazy and outside the base binary when they are not part of every session.

### Harness quality

- ProgramBench is paused by owner direction. Publishing a version does not automatically resume it;
  preserve immutable runs and wait for explicit resumption. It is not an ordinary verification step.
- When resumed, execute the falsifiable completion-system objective in [HARNESS-GOAL.md](HARNESS-GOAL.md). Keep
  one canonical evidence ledger in [EVALUATION.md](EVALUATION.md); do not grow a second speculative backlog or
  tune from hidden-test failures.
- Improve tool selection, context relevance, and completion verification on unsaturated public eval tiers.
- Evaluate the provider-agnostic pre-work completion contract and independent read-only validator with the
  fixed call-budget-matched multi-trial benchmark before making it the default outside explicit closed loops.
- Use the multi-profile completion campaign beyond the saturated `layered-bug` fixture: multiple hard/frontier
  tasks, at least three provider replicates, actual sampling seeds only where the provider exposes them, and an
  official unsaturated external tier before any general lift claim.
- After the pause, complete a newly frozen `fx`/`srgn`/`figlet` ProgramBench matrix with three provider replicates
  for both `single` and `contract`. The content-addressed campaign must have no infrastructure-invalid cells before
  its exact paired decision rule can support controller lift; the current `fx` pilot results remain diagnostics only.
- Prefer deterministic preprocessing and targeted test-surfacing over larger prompts.
- Admit self-improvement changes only when a frozen benchmark or direct regression demonstrates lift.

### Clients and ecosystem

- Maintain durable ACP interoperability with Zed, JetBrains, Wiii, and other clients.
- Publish the Browser Bridge through its supported store path while retaining the auditable unpacked bundle.
- Keep the Apache-licensed SDK boundary small, stable, and independent of the AGPL application shell.

## Non-goals

- No private OAuth impersonation, token import from another CLI, or agent-inside-agent tool bypass.
- No unbounded autonomous loop, silent destructive host access, or auto-retry of unknown mutations.
- No framework rewrite for size or novelty alone; TypeScript + Bun + Ink remains the 1.x platform.
- No copied proprietary implementation. External products may inform behavior only through clean-room study.

## How roadmap work ships

Every item must name the user-visible outcome and its evidence. Use the scoped checks in
[TESTING.md](TESTING.md); release candidates require the full gate. Release rules are in
[RELEASE.md](RELEASE.md); architecture constraints are in [ARCHITECTURE.md](ARCHITECTURE.md).
