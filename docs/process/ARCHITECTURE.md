# Neko Core — Architecture

The pattern is **Ports & Adapters (Hexagonal), lite** with a strict **dependency-inward**
rule. The point is not ceremony — it is that the agent loop never knows whether it is talking
to NVIDIA or a local server, to a terminal or a pipe. That keeps the core testable and the
edges swappable as the project grows. Enforced by `test/architecture.test.ts`.

```
   bin/neko.ts                              ← entry: parse argv, build adapters, dispatch
        │
   src/ui/  (+ one-shot run printer)        ← drivers (presentation, Ink)
        │
   src/core/  ───────────────────────────┐  ← pure domain, no I/O frameworks
     agent · tools · tool-runtime         │
     permissions · memory · workflows     │
     playbook · sandbox · cost · ports     │
        │  depends only on PORTS (ports.ts)
   src/adapters/  ──────────────────────┐ │  ← implement ports / touch the outside world
     providers (LLM) · mcp · config      │ │
     session · context · skills          │ │
     project · doctor · registry         │ │
     tool-registry (composition)         │ │
   src/shared/  version                    ←── leaf utilities
```

## Layers & the dependency rule

**Dependencies point inward.** Core imports only `core/` + `shared/`; never `adapters/`, `ui/`,
or a UI framework (Ink/React). Adapters import `core/` (ports) + `shared/`, never `ui/`.

| Layer | Folder | May import |
|---|---|---|
| **Entry** | `bin/neko.ts` | everything |
| **UI (drivers)** | `src/ui/` | core, adapters, shared |
| **Core (domain)** | `src/core/` — `agent` `tools` `tool-runtime` `permissions` `cost` `ports` | core + shared only |
| **Adapters** | `src/adapters/` — `providers` `mcp` `config` `session` `context` `skills` `project` `doctor` `registry` | core (ports) + shared + SDKs |
| **Shared** | `src/shared/` — `version` | nothing |

**Ports** (`src/core/ports.ts` — interfaces owned by the core, implemented by adapters):
- `Provider` — `complete(messages, tools?, onDelta?, signal?)`. The agent depends on this
  interface; `adapters/providers.ts` `OpenAICompatProvider` implements it. A new backend = a
  new adapter, not an agent change.
- `McpTools` — external tool source (`toolSchemas`/`has`/`call`); `adapters/mcp.ts` `McpHub`
  satisfies it. The `ToolRegistry` holds one optionally.

Also: `ToolRegistry` (`core/tool-runtime.ts`) — the agent calls `schemas()`/`execute()`, never
knowing what a tool does; `ApprovalGate` (`core/tool-runtime.ts`) — the gated-tool consent
callback the UI supplies.
`adapters/tool-registry.ts` is the single composition seam for config-backed capabilities and
child-boundary inheritance; CLI, TUI, and depth-one subagents must use it to avoid wiring drift.

## How to extend (the common cases)

- **Add a tool** → declare it in `core/tools.ts` (`ToolSpec` + `TOOL_LABELS`), implement it in
  `core/tool-runtime.ts` (`DISPATCH`), classify it `SAFE`/`GATED`. Agent + UI pick it up for free.
- **Add a provider/model/endpoint** → usually *config* (a profile in `DEFAULTS`), not code. A
  genuinely new protocol = a new `Provider` adapter in `adapters/providers.ts`.
- **Add a slash command** → a `case` in `ui/chat.tsx`'s `handle()` + an entry in `SLASH`.
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
