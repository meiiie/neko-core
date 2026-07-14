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
  interface; Chat Completions, Responses, Anthropic Messages, ChatGPT, and Gemini adapters implement
  it. A new wire protocol = a new adapter, not an agent change.
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

## Identity and persona boundary

Neko's stable base prompt defines the operational identity shared by every provider: one continuous
collaborator that notices conversation history instead of treating turns as isolated templates. The global
`~/.neko-core/NEKO.md` is the user-owned, local-first persona seam across projects and models; project
`NEKO.md`/`AGENTS.md` files add narrower working context. These prompt layers may shape voice, preferences,
and relationship context, but cannot bypass executable permission, path, browser-capability, or tool-policy
boundaries.

Neko may have a recognizable personality without making an unsupported claim of consciousness or lived
experience. Character Card V3 import/export is intentionally not another subsystem yet: the existing Markdown
seam covers Neko's current single-identity use case. Adopt a portable card format only when cross-application
identity exchange becomes a measured requirement, with schema validation, sanitized extensions, explicit
activation, and no executable assets by default.

## Context budget and cache boundary

The agent keeps one deterministic system message with a stable base prefix followed by
`SESSION_CONTEXT_MARK` and volatile session state. Adapters may place cache breakpoints at that seam, but core
never depends on a provider cache API. Official OpenAI requests use one random, provider-instance
`prompt_cache_key`; GPT-5.6+ Chat Completions also marks the stable side of that seam with an explicit cache
breakpoint. Anthropic Messages caches the stable system prefix, the live context tail, and a rolling message
boundary. Compatible endpoints and older OpenAI models receive no unsupported breakpoint field and retain
their existing self-healing behavior.

Progressive disclosure is the default context policy. MCP already lazy-loads large tool surfaces. Durable ACE
playbook bullets remain lossless on disk, while each request receives bounded recent excerpts and can retrieve
exact lessons through `playbook search` or `playbook read`. This avoids destructive summarization while keeping
the repeated prefix bounded. Cache-write tokens are reported separately from actual prompt/context tokens so a
provider's accounting cannot make the apparent context larger than the request.

Text acquisition paginates before the per-observation guard. `web_fetch` returns resumable 40k-character
pages; `read_file` returns a line `offset`, or an exact `column` continuation for a single minified line. The
agent therefore never head/tail-clamps away an unreachable middle merely because an adapter returned 100k.

Per-step reasoning control crosses the `Provider` port as an optional request hint. `adaptive_effort` is off by
default: when enabled, a successful batch containing only mechanical read tools lowers the *next* completion to
`low`; a mutation, failed/empty observation, planning/final turn, or explicit `off` restores the saved user
preference. The rule may lower a comparable tier but never raise it. This is a reversible training-free proxy,
not a claim that Neko reproduces Ares's learned full-history router. A read often precedes the hardest synthesis,
so the lagged proxy remains experimental and must not be enabled globally without repeated workload-specific evals.

## Gemini provider boundaries

The first-class `gemini-api` profile reuses `OpenAICompatProvider` against Google's documented
`generativelanguage.googleapis.com/v1beta/openai` endpoint. API keys stay in the normal config/env secret
boundary; no sidecar or OAuth state exists for this route. Opaque Chat Completions metadata such as Gemini
tool-call thought signatures is stored as provider continuation data and restored only when the destination
base URL matches its origin. Switching providers strips it instead of leaking encrypted provider state.

The separate `gemini` profile below is Code Assist Standard/Enterprise only.

Antigravity is deliberately not a `Provider` adapter. Its public `agy -p` surface is a headless invocation of
Google's complete agent harness, not a raw completion protocol: Antigravity remains authoritative for tools,
permissions, workspace access, sessions, and output formatting. Nesting that harness behind `Provider.complete`
would make Neko's `ToolRegistry`, approval gate, structured tool calls, continuation replay, and usage accounting
non-authoritative. Directly copying Antigravity OAuth identity or calling `cloudcode-pa.googleapis.com/v1internal`
would additionally depend on an undocumented private contract and violate Google's published third-party-access
boundary. A future consumer-subscription adapter requires an explicit Google embedding protocol that lets Neko
remain the tool executor; account-risk tolerance is not an architectural substitute for that contract.

`adapters/gemini-cli.ts` owns discovery, OAuth handoff, process lifecycle, and the ACP NDJSON transport;
`adapters/gemini-provider.ts` implements the core `Provider` port, and `adapters/gemini-support-pack.ts`
atomically installs Google's official bundle plus a private Node LTS runtime when no compatible CLI exists.
The optional component is never linked into core or the base executable. A system-precedence settings file disables Gemini's built-in tools,
extensions, and hooks. The provider exposes only a capability-token-protected MCP server on `127.0.0.1`, and
that server delegates calls to `CompleteOptions.executeTool`, so the same Neko approval/path/sandbox boundary
remains authoritative. ACP model lists and usage metadata are validated at the adapter boundary; credentials
remain in an isolated `~/.neko-core/gemini-home` store and are never copied into Neko config or shared with
the user's standalone Gemini CLI session.

## Native Claude and xAI provider boundaries

`adapters/effort.ts` treats effort as a persistent user preference plus a per-model negotiated capability,
not a global closed enum. Live model catalogs accept arbitrary future tier names; catalog-less profiles use
their configured ceiling, and provider validation errors can advertise a compatible tier before adapters
fall back to model-default reasoning. This keeps model switches reversible and the core provider-agnostic.

`adapters/anthropic.ts` speaks the official Anthropic Messages API for Claude and retains the existing
Messages-compatible path for Z.ai. Current Claude models use adaptive thinking plus `output_config.effort`;
compatible legacy models keep manual thinking budgets. Signed `thinking`, `redacted_thinking`, text, and
tool-use blocks are persisted as opaque continuation data and replayed byte-for-byte only when protocol,
secret-free endpoint, and model all match. Official Anthropic structured output uses
`output_config.format`; compatible endpoints retain the forced-tool fallback.

`adapters/responses-provider.ts` is the small API-key adapter for the standard Responses API. The xAI
profiles use it with `store: false`, locally retained encrypted reasoning, a stable per-session
`prompt_cache_key`, native tools/vision/structured output, idle-aware streaming, and bounded retry. It does
not import CLIProxyAPI, reuse subscription OAuth, impersonate an official CLI, or call a private inference
endpoint. `provider-scope.ts` gives all opaque provider continuations the same endpoint-and-model isolation
rule, including OpenAI-compatible thought-signature metadata.

## Kimi and DeepSeek provider boundaries

`adapters/kimi-auth.ts` implements Moonshot AI's public RFC 8628 Kimi Code device flow directly. Neko
requests and owns its own token, refreshes it lazily, and stores it atomically in the restricted
`~/.neko-core/kimi-auth.json` file. It never imports CLIProxyAPI state, copies Kimi CLI credentials, reads
browser cookies, or silently switches to API billing. The `kimi` transport is a thin credential-aware use
of the existing Chat Completions adapter; the separate `moonshot` route uses `KIMI_API_KEY`. Both routes
share live `/models` capability discovery and Kimi's `max_completion_tokens`/thinking wire contract.

DeepSeek publishes no account OAuth contract, so its first-class profile remains API-key-only. It targets
the documented V4 endpoint and model ids. `reasoning_content` is opaque continuation data only on assistant
turns that call tools, and is replayed only to the same protocol, endpoint, and model. This satisfies
DeepSeek's multi-step tool contract without exposing chain-of-thought to core or leaking it after a provider
switch.

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
