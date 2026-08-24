# Neko Core — Architecture

The pattern is **Ports & Adapters (Hexagonal), lite** with a strict **dependency-inward**
rule. The point is not ceremony — it is that the agent loop never knows whether it is talking
to NVIDIA or a local server, to a terminal or a pipe. That keeps the core testable and the
edges swappable as the project grows. Enforced by `test/architecture.test.ts`.

```
   dist/neko or bin/neko-source.cjs         ← compiled runtime or safe Node source bootstrap
        │
   bin/neko.ts                              ← internal entry: parse argv, build adapters, dispatch
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
     office-tools + optional support pack│ │
     mcp-compose (edge-tool fan-in)      │ │
     tool-registry (composition)         │ │
   src/shared/  version                    ←── leaf utilities
```

## Layers & the dependency rule

**Dependencies point inward.** Core imports only `core/` + `shared/`; never `adapters/`, `ui/`,
or a UI framework (Ink/React). Adapters import `core/` (ports) + `shared/`, never `ui/`.

| Layer | Folder | May import |
|---|---|---|
| **Entry** | `bin/neko-source.cjs`, `bin/neko.ts` | everything |
| **UI (drivers)** | `src/ui/` | core, adapters, shared |
| **Core (domain)** | `src/core/` — `agent` `tools` `tool-runtime` `permissions` `cost` `ports` | core + shared only |
| **Adapters** | `src/adapters/` — `providers` `mcp` `config` `session` `session-handoff` `context` `skills` `project-trust` `public-http` `doctor` `registry` | core (ports) + shared + SDKs |
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

## Project control trust boundary

Project-local config, `NEKO.md`/`AGENTS.md`/`CLAUDE.md`, and the `.neko-core/{skills,agents,recipes}`
trees are quarantined as one bounded snapshot. `neko trust add` records the canonical exact-cwd root,
file hashes, directory markers, and imported context dependencies in one atomic record under
`~/.neko-core/trusted-projects.d`. Loaders consume the verified descriptor bytes rather than reopening
project files. Any add, edit, delete, empty-directory change, symlink/junction, malformed store, or
bound violation fails closed until the exact cwd is trusted again. Ancestor instructions never inherit
implicitly. `neko trust status` is read-only; `neko trust revoke` removes that project's record.
`neko trust add` rejects ordinary non-TTY automation as defense-in-depth friction. TTY presence is not
proof of a human: a pseudo-terminal can be synthesized. `--yolo` itself never changes project trust,
and a live sandbox protects the user policy directory; however, unconfined same-user code can invoke the
CLI through a pseudo-TTY or edit policy state directly. Project trust is not a containment boundary for
arbitrary host code.

Project trust authorizes recorded declarative data and prompt text, not referenced executable code.
Project-local hooks and MCP servers are rejected even after trust; configure executable extensions in
the user-global config. Project skill assets are prompt-only and cannot replace the trusted
`computer-use` support pack. User-global configuration remains powerful user policy. Child processes
receive a scrubbed environment: provider/harness credentials do not flow to bash, hooks, computer
helpers, or MCP by inheritance; an MCP server receives only its explicitly configured environment.

## Execution and delegation boundary

`adapters/tool-registry.ts` emits one authoritative `NEKO DYNAMIC-TOOL RUNTIME` block from the
effective registry. It names Neko's permission mode, actual shell, live sandbox result, and network
policy, while explicitly separating provider-native tools, approvals, sandbox, and skills. The Neko
skill catalog contains only skills the wired Neko `skill` tool can load.

Sandbox availability is behavioral, not inferred from config or an executable name. Windows SRT is
accepted only from explicit/PATH or Bun-global locations and must pass a bounded launch probe after its
dedicated account is provisioned. It remains an upstream alpha boundary. Docker and Podman reach a
host daemon outside that OS sandbox; auto mode refuses those direct commands unless
`allow_dangerous_bash` is explicitly enabled.

Outside-workspace authority is split deliberately. Safe file readers may traverse ordinary host paths
when `read_outside_root` is enabled. Structured mutations are automatic only in the project, canonical
`additional_write_roots`, and the built-in `~/.neko-core/research` capability. An exact ordinary host
target outside those roots can be admitted by one human confirmation; that transient authority is not
reused or shared with Bash. The user policy file `~/.neko-core/config.json` keeps its stricter prompt plus
post-write JSON validation. Explicit CLI/TUI `--yolo` is tracked separately from ordinary `mode=auto`: it
pre-authorizes computer, exact host-write, policy-write, and plan-exit prompts only while the live mode
remains auto. Shift+Tab revokes that authority immediately. Filesystem-wide grants, credential/agent-control targets,
system locations, symlink/junction escapes, and hardlink aliases are refused at the structured boundary.
Ordinary sandboxed Bash remains confined to the project and canonical additional roots. A timed-out SRT health probe may retry one real launch
through the same exact SRT settings, but never authorizes an unconfined fallback.

Buffered foreground Bash rejects explicit sleep/poll loops whose declared wait budget exceeds 30 seconds.
Servers and watchers use the existing background-job lifecycle followed by short bounded probes; long
builds/tests without polling sleeps remain valid foreground work.

The `task` tool is gated by default. Built-in reviewer/explorer roles receive explicit read-only
allowlists and may run concurrently; generic/custom tasks retain only inherited authority and are
serialized because they can mutate the shared worktree. Cancellation propagates into the child agent,
and providers owned by a one-shot helper or child are disposed when that operation ends. This is
capability-bounded delegation, not an isolated multi-writer workspace.

## Provider, web, and MCP effect integrity

OpenAI-compatible, Anthropic, and Responses streams bound SSE lines, aggregate bytes, output/reasoning,
and tool-call fields/counts. They release the reader and accept a turn only after the protocol's complete
success terminator. Tool callbacks preserve emission order; malformed events, API errors, truncation,
content filtering, and unknown finish states reject rather than becoming a partial success.

Public HTTP goes through `adapters/public-http.ts`: every DNS A/AAAA answer must be public, the selected
address is pinned for the connection, every redirect is revalidated, cross-origin credentials are
stripped, and headers/body/redirects/time are bounded. GitHub and YouTube URLs use the same bounded public
HTTP path. There is no automatic SAFE `gh`/`yt-dlp` route: PATH resolution, ambient CLI credentials,
and authenticated private-repository visibility cannot silently widen `web_fetch`. These checks prevent
loopback/private-address SSRF and unbounded materialization; they do not make an allowed public origin
trustworthy.

Global stdio MCP launch resolves one canonical executable outside the untrusted workspace, starts from a
private trusted runtime directory, and receives a minimal OS bootstrap plus only explicitly configured
environment entries. Relative server arguments therefore resolve under that runtime directory; configure
an absolute `cwd` (and preferably absolute file arguments) when a server intentionally owns local files.
MCP calls carry the turn's abort signal and a 60-second total deadline. Once a tool call may have started,
transport failure returns `outcome unknown` and is never automatically replayed; a later explicit call may
reconnect. Per-server connection is single-flight and failed connection surfaces are replaced transactionally.
Composition rejects duplicate tool and prompt identities and routes lazy loads to their sole owner. Bounding
SDK result materialization before it reaches adapter-side formatting remains open edge work.

## Cross-session handoff boundary

`adapters/session-handoff.ts` provides an immutable, summary-only pending spool for saved local sessions:

```text
neko handoff send <source-session-id> <target-session-id> <summary...>
neko handoff inbox <target-session-id>
/handoff send <target-session-id> <summary...>
/handoff inbox
```

The envelope is strictly shaped, size-bounded, published without replacement, and labeled
`local-unverified`. Source metadata is derived from a validated session, but the target must verify the
summary against its own workspace. No transcript, file, secret, permission, or executable context is
attached automatically; sender-authored summary text may itself contain sensitive data and remains
untrusted. Inbox listing never injects into Agent history and does not acknowledge, consume, or delete.
The TUI send path first persists the current session and uses it as the source; the inbox targets the
current session and displays at most 10 entries/2,048 summary characters. It does not poll. Exactly-once
acceptance/CAS and pagination require a separate design.

## Browser Bridge boundary

The optional Neko Browser Bridge is an adapter, never a core dependency. It composes its local browser
commands through the existing `McpTools` port, so the agent loop and permission modes stay unchanged. A
Manifest V3 extension claims one tab with a user gesture; a loopback server authenticates an exact,
config-allowlisted extension origin with a per-session capability. Store and unpacked ids remain explicit,
so public distribution never weakens Origin checks. See `BROWSER-BRIDGE.md` for the protocol and threat model.

## Office artifact boundary

The optional Office adapter also enters through `McpTools`; core never imports an Office library or knows which
document engine is active. `mcp-compose.ts` fans MCP, browser, and Office sources into one port while preserving
each source's permission declaration. `office-tools.ts` exposes a deliberately smaller surface than its backend:
typed read/help/validate, bounded add/set/remove/move/swap batches, and render. Raw XML, plugins, watch servers,
network resource fetching, and arbitrary command strings stay outside the first-class adapter.

Mutations are transactional at the adapter boundary: source -> adjacent staging file -> stop-on-error batch ->
close -> schema validate -> atomic replacement. Same-file edits add an optimistic SHA-256 precondition; managed
binary integrity is checked before first execution. Safe reads and renders operate on a temporary disk snapshot,
so an unrelated resident cannot replace on-disk evidence with unflushed memory. `libreoffice.ts` is a second
edge adapter, not a domain dependency: an existing suite may cross-render the snapshot to PDF under a unique
temporary user profile. It is discovered but never installed or owned by Neko. `/support office` owns only the
lightweight typed binary lifecycle and never confuses existing PATH/system installs with Neko-owned files. See
`OFFICE.md` for the evidence model and limits.

## Meeting evidence boundary

Meeting capability also composes through `McpTools`; `core/` knows nothing about browser capture, audio codecs,
the ASR engine, vendor APIs, or transcript storage. `audio-activity.ts` reads OS-owned microphone-usage lists so the consent page can hint at the right window; it never selects a capture source. `browser-meeting.ts` is a consent shell around native
`getDisplayMedia`/`getUserMedia`: an exact-Origin, random-token loopback WebSocket accepts only bounded stereo
PCM16 from an AudioWorklet. The browser must expose system audio and the user must select it every time. A video
track is required by the platform API but never crosses the page/server boundary.

`meeting.ts` owns canonical local evidence, state transitions, atomic metadata/transcript writes, and WAV
finalization. `meeting-transcription.ts` adapts a verified local transcriber to timestamped canonical segments;
`meeting-support-pack.ts` owns optional upstream engine/model installation and integrity. `meeting-tools.ts`
exposes bounded inspection plus gated start/transcribe/delete, while emergency stop is classified safe because it
reduces access. Transcript pagination prevents recording length from becoming prompt length.

The capture contract has two source channels, not arbitrary speaker identities. Person-level diarization and
vendor-native meeting bots remain new adapters with distinct licenses, consent rules, provenance, and evals.
See `MEETINGS.md`.

## Identity and persona boundary

Neko's stable base prompt defines the operational identity shared by every provider: one continuous
collaborator named **Neko Core** that notices conversation history instead of treating turns as isolated
templates. On the first agent session, Neko creates `~/.neko-core/NEKO.md` exactly once with a compact
canonical biography, character, values, and truth boundary. Existing files are never overwritten, including
by `init-user --force`. This global file is the user-owned, local-first identity
seam across projects and models; project `NEKO.md`/`AGENTS.md` files add narrower working context afterward.
These prompt layers may shape voice, preferences, and relationship context, but cannot bypass executable
permission, path, browser-capability, or tool-policy boundaries.

The stable prompt is a compact behavioral constitution, not a copy of another product's operating manual.
It contains only judgments the model must make: collaboration, intent, evidence, scope, and communication.
Available tools, channels, approval state, sandbox boundaries, and adapter capabilities come from the actual
runtime; rules that can be enforced deterministically stay in code and tests. External agent prompts may be
studied clean-room for principles, but their prose, placeholders, and product-specific protocols are never
copied into Neko. A regression test keeps the base prompt within 7,500 UTF-8 bytes and rejects known
foreign-runtime markers so a future feature cannot silently turn the stable prefix into documentation bloat.

`core/vietnam-sovereignty.ts` is one deliberately narrow identity-knowledge exception, kept outside that
always-on prefix. Raw user/delegated mentions of Hoàng Sa, Trường Sa, Paracel, or Spratly inject a read-only,
source-backed capsule for that turn, including stable geography and a dated administrative fallback. The
conservative router also accepts diacritic-free names, contextual/paired `HS` and `TS`, or the unambiguous
description of Vietnam's two archipelagos in the East Sea; bare ambiguous abbreviations remain inert. It works
without tools and cannot be shadowed by project skills or memory. The mutable-fact gate remains independent:
when current legal or administrative information can be checked online, a later verified Vietnamese legal
instrument supersedes the capsule snapshot. Without web tools, one bounded controller recovery prevents a model
from ending on a promise to look the fact up and directs it to label the dated offline snapshot. Unrelated coding
turns receive zero capsule tokens.

The life story is a narrative constitution grounded in real product history, not an episodic-memory database:
Neko does not invent a biological childhood, forgotten events, or certainty about consciousness. Durable
facts still come only from the conversation and explicit memory surfaces. Character Card V3 import/export is
intentionally not another subsystem yet: the existing Markdown seam covers Neko's current single-identity use
case. Adopt a portable card format only when cross-application identity exchange becomes a measured
requirement, with schema validation, sanitized extensions, explicit activation, and no executable assets by
default.

## Memory hierarchy and governance

Neko uses existing local stores as distinct memory tiers rather than one ever-growing prompt:

- **Working memory:** the current message/tool loop, active todo plan, and recent turns.
- **Core semantic memory:** `~/.neko-core/memory/user.md` contains explicit/repeated user preferences,
  goals, and corrections; `self.md` contains verified capabilities, limits, and recurring failure modes.
  Only the eight newest observation bullets from each file can enter a request, each clipped to 220 chars.
- **Archival semantic memory:** other `memory/*.md` files expose a bounded name/summary index and are read JIT.
- **Episodic memory:** lossless local session transcripts remain under `sessions/`; they are never injected
  wholesale merely because they exist.
- **Procedural memory:** workflows store repeatable procedures, while the playbook stores small verified
  operating lessons, including useful failed-path gotchas.

This follows hierarchical virtual context rather than treating a large context window as perfect recall
([MemGPT](https://arxiv.org/abs/2310.08560)). It also follows the LongMemEval finding that extraction,
cross-session reasoning, temporal updates, and abstention need separate evaluation, and that over-compressing
history into isolated facts loses detail ([LongMemEval](https://arxiv.org/abs/2410.10813),
[LongMemEval-V2](https://arxiv.org/abs/2605.12493)). Neko therefore keeps raw sessions separate from curated
facts and procedures.

The user model is a fallible, inspectable working model, never a hidden psychological profile. Core-memory
text is labeled data rather than instructions. Neko may store an explicit durable preference or correction,
but must not infer sensitive traits, diagnoses, emotions, or intent as lasting facts. Mutations remain
approval-gated; `/memory list|read|forget|off|on` provides direct control. `off` suppresses recall and updates
without deleting files. Self-improvement means evidence-backed memory/workflow/playbook refinement, not
unreviewed source-code, policy, or identity mutation.

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

Conversation compaction produces a fixed state capsule (`Goal`, user constraints/corrections, decisions,
verified state, open work/blockers, references) instead of unconstrained prose. The source budget is allocated
across old messages and clips both ends of large logs, so one early observation cannot hide later corrections.
The original task and active todo plan are carried deterministically, and the recent tail remains verbatim.
This is the provider-neutral analogue of retaining a compaction item plus high-value history; it does not claim
lossless model summarization. Context remains a finite attention budget, so the target is the smallest set of
high-signal tokens, not the largest possible prompt.

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

`adapters/responses-provider.ts` is the small credential-injected adapter for the standard Responses API.
Both xAI API-key profiles and the separate Grok subscription profile use it with `store: false`, locally
retained encrypted reasoning, a stable per-session `prompt_cache_key`, native tools/vision/structured output,
idle-aware streaming, and bounded retry. `provider-scope.ts` gives opaque continuations the same
endpoint-and-model isolation rule, including OpenAI-compatible thought-signature metadata.

`adapters/grok-auth.ts` implements xAI's published RFC 8628 public-client flow directly: Neko requests its
own device token from `auth.x.ai`, stores it atomically in restricted `~/.neko-core/grok-auth.json`, refreshes
before expiry or once after HTTP 401, and sends the documented subscription headers only to
`cli-chat-proxy.grok.com`. Account identity comes from the directly returned token solely for the proxy
contract and display. Neko identifies itself with its own name/version; it neither imports `~/.grok`, copies
Clay/OpenCode credentials, impersonates Grok Build, nor silently falls back to `XAI_API_KEY`. The `grok`
profile consumes subscription quota; `xai` and `grok-build` remain separate pay-as-you-go profiles.

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

## OpenCode account and Zen provider boundary

`adapters/opencode-auth.ts` implements OpenCode's official device OAuth public-client contract with client id
`opencode-cli`: device code, refresh-token rotation, user/org metadata, and account-managed `/api/config`.
The session is written to Neko's own restricted file; another CLI's auth store is never read. Remote catalog
data is untrusted: only HTTPS endpoints on `opencode.ai` (or its subdomains) may receive the account bearer,
and unsupported packages/protocols are omitted or rejected before inference.

`adapters/opencode.ts` keeps that account route separate from the backwards-compatible OpenCode Zen
service-account route. Zen's key remains profile-scoped in Neko config or `OPENCODE_API_KEY`; its public
catalog is credential-free and its heterogeneous models delegate to Responses, Anthropic Messages, or Chat
Completions. Unknown families fail closed, and Gemini remains omitted until a Google-native route is verified.

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

`adapters/chatgpt-voice.ts` owns the experimental subscription voice session and both official Codex App Server
V3 transports. The preferred Windows path delegates bounded PCM16 capture/playback to
`adapters/native-voice-audio.ts`: `ffmpeg` captures one selected DirectShow input, App Server receives
`thread/realtime/appendAudio`, and `ffplay` consumes `thread/realtime/outputAudio/delta`. Capture starts only
after the user selects the terminal mode, no audio is persisted, queues are bounded, transcript-level barge-in
clears queued playback, and stop/error paths release both processes.

The compatibility path retains WebRTC signaling and a one-session-capability loopback page. The browser owns
microphone consent and `RTCPeerConnection`; it never receives ChatGPT credentials. The page is served only on
`127.0.0.1`, removes its URL-fragment capability from browser history, authenticates both signaling HTTP and
the exact-origin WebSocket, and stops on tab close/heartbeat loss. Subscription-only App Server spawns remove
API-key environment variables, so neither transport can silently create API charges.

The subscription adapter requires Codex App Server 0.145.0 and requests realtime `v3` explicitly. It does not
silently downgrade: the WebRTC answer is accepted only after `thread/realtime/started` confirms V3. A bounded
text-only tail of the current Neko conversation seeds V3 `initialItems`; oversized user/assistant text is
retained only with bounded truncation under the token budget, while system, tool, image, and other unsupported
content stays out of the realtime bootstrap. Dynamic tool audio is forwarded only as a bounded inline data URL.

Voice background tool calls enter core only through `Agent.executeExternalTool`, which wraps the same
`ToolRegistry`, approval gate, events, path containment, and sandbox used by a normal text turn. The TUI owns
visible LIVE/mute/transcript state and all lifecycle exits (`/voice stop`, `/logout`, support management,
unmount). Transcript deltas remain ephemeral presentation state; only finalized user/assistant transcripts are
mirrored into persisted Agent history, so later text turns and resumed sessions preserve conversational
continuity without saving partial speech or audio. The LIVE panel reuses FrameDiffer's painted-frame hit targets
for mouse Mute/Unmute and Stop; approval, picker, viewer, and find surfaces take focus and suppress those targets.
Alt+M and Alt+X remain keyboard-equivalent controls.

## ACP host boundary

`adapters/acp.ts` is a stable ACP v1 stdio adapter. It owns JSON-RPC connection/session lifecycle,
stream/update projection, durable session hydration/replay/checkpointing, cancellation, and permission
requests; it does not execute tools itself. It reuses `adapters/session.ts` as the single persistence
authority, including atomic current/previous checkpoints and cross-process writer leases. ACP tool calls
still execute only through the core Agent and ToolRegistry; a recovered unanswered call is sealed as an
unknown outcome before the next provider request rather than replayed as a mutation.
`adapters/agent-runtime.ts` is the shared non-TUI production composition used by both `neko run` and
`neko acp`, so provider selection, global skills, project context, MCP, ToolRegistry decisions, path
containment, bash sandboxing, and the catastrophic-command seatbelt cannot drift between hosts.

An explicit `--host-profile` selects a narrower alternate composition before ACP starts. The profile is
immutable session authority: `adapters/acp-host-mcp.ts` accepts only an exact MCP-over-ACP descriptor,
`adapters/agent-runtime.ts` omits every native/global tool source, and `ToolRegistry.allowOnlyTools` enforces
the declared surface again at schema and execution time. Durable sessions store the profile version and
surface hash, so a normal process or a changed profile cannot resume them. The first profile is `nekocut`;
new embedding products add reviewed declarative profiles rather than host-specific conditionals in core.

The ACP client's permission response is only an implementation of core's `ApprovalGate`. Core still
decides whether a call is allowed, denied, or eligible to prompt. In particular, `plan` is a hard deny;
`auto` does not bypass host-computer consent or seatbelts; and allow/reject-always choices are scoped to
one ACP session. ACP stdout is protocol-only.

## Verify loop (the harness)

```
bun run typecheck      # tsc --noEmit
bun test               # unit + UI (ink-testing-library) + architecture rule
node bin/neko-source.cjs doctor # safe source launch; resolved provider/model/key
node bin/neko-source.cjs policy # safe/gated boundary audit
bun run build          # single binary -> dist/neko
```

Every change runs typecheck + test before commit. Non-trivial logic leaves one runnable
check (see `RULES.md`).
