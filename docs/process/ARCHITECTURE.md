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
     browser-bridge (loopback adapter)   │ │
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

## Browser Bridge boundary

The optional Neko Browser Bridge is an adapter, never a core dependency. It composes its local browser
commands through the existing `McpTools` port, so the agent loop and permission modes stay unchanged. A
Manifest V3 extension claims one tab with a user gesture; a loopback server authenticates an exact,
config-allowlisted extension origin with a per-session capability. Store and unpacked ids remain explicit,
so public distribution never weakens Origin checks. See `BROWSER-BRIDGE.md` for the protocol and threat model.

## Gemini CLI ACP boundary

`adapters/gemini-cli.ts` owns discovery, OAuth handoff, process lifecycle, and the ACP NDJSON transport;
`adapters/gemini-provider.ts` implements the core `Provider` port, and `adapters/gemini-support-pack.ts`
atomically installs Google's official bundle plus a private Node LTS runtime when no compatible CLI exists.
The optional component is never linked into core or the base executable. A system-precedence settings file disables Gemini's built-in tools,
extensions, and hooks. The provider exposes only a capability-token-protected MCP server on `127.0.0.1`, and
that server delegates calls to `CompleteOptions.executeTool`, so the same Neko approval/path/sandbox boundary
remains authoritative. ACP model lists and usage metadata are validated at the adapter boundary; credentials
remain in an isolated `~/.neko-core/gemini-home` store and are never copied into Neko config or shared with
the user's standalone Gemini CLI session.

## ChatGPT realtime voice boundary

`adapters/browser-voice.ts` is the default provider-agnostic conversational preview. A fragment capability
authenticates one browser tab to a loopback WebSocket; it is removed from browser history and is never embedded
in the served page. Browser Speech Recognition owns microphone capture and may use the browser vendor's online
service, which the consent page states before Start. Only bounded transcript text crosses into Neko.
`adapters/voice-interaction.ts` supplies a deterministic, non-content backchannel policy with per-turn and
cross-turn cooldown plus sensitive-input suppression. Final utterances call the same TUI turn runner and Agent
as typed input. Barge-in aborts the active Agent controller and cancels browser synthesis. Stop, tab close,
heartbeat loss, logout, support management, and TUI unmount close the loopback server and speech UI.

This route deliberately does not pretend to be local STT/TTS or native full-duplex speech-to-speech. Its
boundary is narrow enough for a future verified local Voice Support Pack to replace recognition and synthesis
without moving tool execution or permission policy out of Neko.

The separate Open ChatGPT route opens the official ChatGPT Voice web surface as an external companion. It does
not integrate that consumer tab into Neko: no cookie/session extraction, DOM automation, private endpoints, or
claims that GPT-Live is available as a developer API. The App Server route below is explicitly a Lab option.

`adapters/chatgpt-voice.ts` owns the experimental subscription voice session, the official Codex App Server
WebRTC signaling, and a one-session-capability loopback page. The browser owns microphone consent and the
`RTCPeerConnection`; it never receives ChatGPT credentials. App Server owns SIWC authentication and the
realtime sideband. Audio therefore does not pass through or get transcoded by the Neko process. The page is
served only on `127.0.0.1`, uses a URL-fragment capability that is removed from browser history, authenticates
both signaling HTTP and the exact-origin WebSocket, and stops on tab close/heartbeat loss. Subscription-only
spawns remove API-key environment variables, so the adapter cannot silently create API charges.

Voice background tool calls enter core only through `Agent.executeExternalTool`, which wraps the same
`ToolRegistry`, approval gate, events, path containment, and sandbox used by a normal text turn. The TUI owns
visible LIVE/mute/transcript state and all lifecycle exits (`/voice stop`, `/logout`, support management,
unmount). Voice transcript notifications remain an ephemeral presentation stream rather than being inserted
as incomplete text-only turns into the persisted Agent history.

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
