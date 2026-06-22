# Neko Core — Architecture

The pattern is **Ports & Adapters (Hexagonal), lite** with a strict **dependency-inward**
rule. The point is not ceremony — it is that the agent loop never knows whether it is talking
to NVIDIA or a local server, to a terminal or a pipe. That keeps the core testable and the
edges swappable as the project grows. Enforced by `test/architecture.test.ts`.

```
        bin/neko.ts            ← entry: parse argv, build adapters, dispatch
              │
        ┌─────┴─────┐
       ui/         (one-shot run printer)     ← drivers (presentation)
        │
   ┌────┴───────────────────────────┐
   │            CORE                 │        ← pure domain, no I/O frameworks
   │  agent · tools · tool-runtime   │
   │  permissions · cost · registry  │
   └────┬───────────────────────────┘
        │ depends only on PORTS (interfaces)
   ┌────┴───────────────────────────┐
   │          ADAPTERS               │        ← implement ports / touch the outside world
   │  providers (LLM HTTP) · mcp     │
   │  session · config · context     │
   │  skills · project · doctor      │
   └────────────────────────────────┘
```

## Layers & the dependency rule

**Dependencies point inward. The core never imports the UI or any UI framework (Ink/React).**

| Layer | Files (`src/`) | May import |
|---|---|---|
| **Entry** | `bin/neko.ts` | everything |
| **UI (drivers)** | `ui/*` | core, adapters, ports |
| **Core (domain)** | `agent.ts`, `tools.ts`, `tool-runtime.ts`, `permissions.ts`, `cost.ts`, `registry.ts` | ports + other core only |
| **Adapters** | `providers.ts`, `mcp.ts`, `session.ts`, `config.ts`, `context.ts`, `skills.ts`, `project.ts`, `doctor.ts` | stdlib/SDKs; may implement a port |

**Ports** (interfaces owned by the core, implemented by adapters):
- `Provider` (in `providers.ts`) — `complete(messages, tools?, onDelta?, signal?)`. The agent
  depends on this interface; `OpenAICompatProvider` is the adapter. A new backend = a new
  adapter, not an agent change.
- `ToolRegistry` (in `tool-runtime.ts`) — the agent calls `schemas()` / `execute()`; it does
  not know what a tool does.
- `ApprovalGate` (in `tool-runtime.ts`) — the gated-tool consent callback the UI supplies.

## How to extend (the common cases)

- **Add a tool** → declare it in `tools.ts` (`ToolSpec` + `TOOL_LABELS`), implement it in
  `tool-runtime.ts` (`DISPATCH`), classify it `SAFE`/`GATED`. The agent + UI pick it up for free.
- **Add a provider/model/endpoint** → it is usually *config* (a profile in `DEFAULTS`), not
  code. A genuinely new protocol = a new `Provider` adapter in `providers.ts`.
- **Add a slash command** → a `case` in `chat.tsx`'s `handle()` + an entry in `SLASH`.
- **Add a skill** → drop a `*.md` in `~/.neko-core/skills/`; no code.

## Verify loop (the harness)

```
bun run typecheck      # tsc --noEmit
bun test               # unit + UI (ink-testing-library) + architecture rule
bun bin/neko.ts doctor # resolved provider/model/key (no model call)
bun bin/neko.ts policy # safe/gated boundary audit
bun run build          # single binary -> dist/neko
```

Every change runs typecheck + test before commit. Non-trivial logic leaves one runnable
check (see `RULES.md`).
