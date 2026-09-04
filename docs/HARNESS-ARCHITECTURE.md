# Neko Core harness architecture

The harness is everything that turns a model completion into dependable work: context construction, the agent
loop, tool contracts, permissions, persistence, recovery, provider transport, and the user-facing terminal or
ACP adapter. Model quality matters, but the harness decides what the model can observe, do, remember, verify,
and recover.

This document is the canonical map. Trust-boundary details live in
[process/ARCHITECTURE.md](process/ARCHITECTURE.md); runnable evidence lives in
[process/TESTING.md](process/TESTING.md).

## End-to-end turn

```text
user / ACP client
      |
      v
session + project trust + skills + memory + runtime policy
      |
      v
Agent.run / runUntilDone
      |
      +--> Provider.complete(messages, tool schemas, effort, abort signal)
      |           |
      |           +--> streamed text / reasoning metadata / tool calls / usage
      |
      +--> ToolRegistry preflight
                  |
                  +--> turn capability lease
                  +--> permission + seatbelt + adversarial hook
                  +--> durable pre-effect checkpoint
                  +--> local, sandboxed, MCP, browser, Office, or computer executor
                  +--> durable result/error checkpoint
      |
      v
completion verification + session checkpoint + terminal/ACP update
```

Every effect returns through the same `ToolRegistry` boundary. Provider-managed tools, ACP clients, MCP
servers, subagents, browser control, and optional support packs do not receive a second path around it.

## Layers

| Layer | Responsibility | Key modules |
|---|---|---|
| Core domain | provider/tool ports, agent loop, cost, permissions, tool contracts | `src/core/` |
| Adapters | provider transports, config, sessions, MCP, skills, sandbox, browser, Office | `src/adapters/` |
| UI and protocols | Ink TUI, CLI commands, transcript renderer, ACP server | `src/ui/`, `src/adapters/acp.ts` |
| Distribution | safe source bootstrap, compiler, installers, update and release workflows | `bin/`, `scripts/`, `.github/` |

Dependencies point inward. Core imports neither adapters nor Ink; `test/architecture.test.ts` enforces the
rule. The public package root exposes the embeddable core without starting the CLI.

## Context contract

Neko builds one bounded, cache-stable model request from:

1. the base system prompt and current runtime policy;
2. the exact trusted project snapshot (`AGENTS.md`, `NEKO.md`, and supported imports);
3. global identity plus bounded memory/workflow/playbook indexes;
4. the durable canonical message trajectory;
5. turn-local capability and environment context;
6. only the tool schemas available to this turn.

Large observations are paged or clipped, old tool images are masked, and compaction preserves the original
task, recent turns, open todos, and a structured summary. Controller messages persist locally but are removed
from provider-visible conversation history. Credentials, raw chain-of-thought, UI state, and unrelated host
files are never context just because they exist.

## Agent loop and completion

`src/core/agent.ts` owns the loop:

```text
complete -> validate tool calls -> execute -> observe -> complete
```

The loop includes:

- preflight validation for tool names and required arguments;
- eager execution only for safe calls whose order is already valid;
- concurrent fan-out for independent read-only calls;
- repetition, failure-streak, and unproductive-result guards;
- explicit abort propagation through provider, hooks, tools, and sidecars;
- token/context accounting across every provider call in the turn;
- validation debt after mutations and a fresh-evidence completion gate;
- bounded checkpoint continuation for committed partial streams;
- closed-loop self-review through `runUntilDone`, with a hard step ceiling.

A provider error is not success, an interrupted mutation is not automatically replayable, and a confident
final sentence cannot clear missing verification evidence.

## Tool and authority contract

Tools declare schemas and permission classes in the core. The runtime then intersects four sources of
authority:

1. base tool availability;
2. the active mode (`default`, `accept-edits`, `plan`, or `auto`);
3. a turn-scoped capability lease, such as reviewer-only or exact-file work;
4. explicit launch authority such as `--yolo`.

The intersection can narrow authority but cannot expand beyond the host policy. Project trust, credential
denials, system paths, catastrophic shell refusal, exact outside-root consent, and sandbox health remain
independent checks. Hooks run after deterministic preflight and before the effect; they cannot make a denied
tool available.

Read-only Bash is still treated as a command execution surface. When sandboxed, it receives only the exact
filesystem roots and one-call network domains granted by policy. An unhealthy configured sandbox fails closed.

## Provider and protocol integrity

Providers implement the `Provider` port. They translate canonical messages and tools to a vendor protocol,
stream deltas back, preserve opaque continuation data only for the exact endpoint/model that created it, and
report usage. Retry decisions use a semantic commit barrier:

- before visible output or a ready tool call, a bounded transport retry is safe;
- after a committed semantic event, recovery continues from the durable checkpoint rather than replaying the
  request blindly;
- malformed protocol data, user aborts, and unknown mutation outcomes are never converted into success.

Subscription OAuth and API-key billing are separate profiles. Sidecar agents are isolated behind a Neko-owned
tool proxy, so their native tool surfaces cannot bypass the registry.

## Durable sessions and crash recovery

`src/adapters/session.ts` stores versioned sessions with atomic primary/backup publication and one active
writer lease. Checkpoints occur when a user prompt is accepted, around tool effects, on provider checkpoints,
and at turn termination.

The canonical trajectory includes user and assistant messages, stable tool-call IDs, tool results/errors,
compaction capsules, provider continuation state, model/profile/mode, and turn state. A call that was durable
before a crash but has no durable result is sealed as `unknown_outcome`; Neko inspects real state before any
possible retry.

ACP uses the same store. `session/load` replays history to a client; `session/resume` rebuilds model context
without replay when the client already has the transcript.

## Terminal lifecycle

The fullscreen TUI owns an alternate-screen buffer. Startup enters it before Ink's first render and primes the
small welcome row so header and composer appear in one frame. The frame differ owns the scrollable transcript
band; Ink owns the stable chrome and input.

On exit, React/Ink completes its final erase writes while the alternate buffer is still active. Neko then
disables mouse/focus/keyboard modes, restores the primary buffer and title, removes its emergency exit hook,
and prints one CRLF-anchored resume hint. The ConPTY lifecycle regression asserts this byte ordering on both
the incremental and fallback renderers.

## Extension seams

- **Model or compatible endpoint:** add or override a config profile first.
- **New provider protocol:** implement `Provider`; keep vendor types in an adapter.
- **Native tool:** add the schema and permission class, then its bounded runtime implementation and tests.
- **MCP surface:** compose it through `mcp-compose.ts`; duplicate names fail closed.
- **Skill:** ship Markdown plus bounded assets/scripts; the binary embeds built-ins and user-global overrides
  live in `~/.neko-core/skills`.
- **Client UI:** use ACP instead of importing terminal components.

No extension may create a second credentials store in the transcript, a second approval model, or a direct
effect path from a provider to the host.

## Evidence and release bar

The current long-horizon experiment is governed by
[process/HARNESS-GOAL.md](process/HARNESS-GOAL.md) and
[process/EVALUATION.md](process/EVALUATION.md). The architecture follows a validator wall: an independent
completion instrument is defined before implementation, raw cases stay private to the validator, and only
clustered outcome gaps cross back to the implementer. This is an experimental controller layer, not authority
to weaken tools, sandboxing, or normal CLI behavior.

ProgramBench comparison state is content-addressed. The campaign manifest freezes the non-ignored source
snapshot, runner/shim hashes, evaluator image ID, and task image IDs. Each evaluator owns its outer and nested
containers through one random label, and each cell writes a terminal run record before the campaign assigns a
status. Aggregate scoring treats a valid missing artifact as zero while refusing to convert runner, evaluator,
or Docker infrastructure failures into controller scores.

Harness changes require targeted regression tests plus the full gate:

```bash
bun run typecheck
bun run lint
bun test
node bin/neko-source.cjs doctor
node bin/neko-source.cjs policy
bun run build
```

Terminal/render changes additionally run the real ConPTY lifecycle and ghost/typing probes. Security and
benchmark claims must use the frozen public evaluation contract rather than self-reported success. The exact
release procedure is [process/RELEASE.md](process/RELEASE.md).
