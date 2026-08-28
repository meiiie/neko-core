# Neko Core roadmap

## Current status (2026-08-28) - v1.4.0

Neko Core is a production terminal agent with a stable public CLI, embeddable core, and ACP v1 server.
The 1.0 baseline includes:

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

**Branch:** `main`. **Current release: v1.4.0 (2026-08-28).** The 1.0 compatibility contract remains the
long-term stable baseline; v1.4.0 adds the globally bundled `no-comments` hygiene skill and removes an obsolete
Bun 1.3 build override that produced an internal Bun 1.4.0 Windows diagnostic. Ordinary CLI composition,
providers, ACP hosts, and durable sessions remain compatible. The complete pre-1.0 history remains in
[CHANGELOG.md](../../CHANGELOG.md) and
[WORKLOG.md](WORKLOG.md).

## Compatibility policy

The 1.x CLI, configuration, durable-data, SDK, ACP, authority, and delivery commitments are defined in the
canonical [stability and support policy](STABILITY.md). Roadmap work may extend those contracts, but it may not
silently narrow them.

## Active priorities

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

- Improve tool selection, context relevance, and completion verification on unsaturated public eval tiers.
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

Every item must name the user-visible outcome and its evidence. A change is not complete until targeted tests,
the full verify loop, policy audit, compiled binary smokes, and applicable real-terminal probes pass. Release
rules are in [RELEASE.md](RELEASE.md); architecture constraints are in [ARCHITECTURE.md](ARCHITECTURE.md).
