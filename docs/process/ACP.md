# Neko over ACP

Neko implements stable Agent Client Protocol v1 over newline-delimited JSON-RPC on stdio. The ACP
process owns Neko's configured provider, tools, project context, global skills, MCP servers, and safety
policy. The editor is the client/UI; it does not replace Neko's tool runtime.

## Start the server

```bash
neko acp
```

Useful launch options remain host-owned:

```bash
neko acp --profile chatgpt
neko acp --yolo
neko acp --host-profile nekocut
```

`--yolo` selects Neko's `auto` permission mode. It does not disable catastrophic-command checks,
workspace/path containment, sandbox policy, or explicit consent for host computer control.

## Zed custom agent

Open Agent Settings, choose **Add Agent -> Add Custom Agent**, and add:

```json
{
  "agent_servers": {
    "neko": {
      "type": "custom",
      "command": "neko",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Start a new External Agent thread and select `neko`. Neko reads its normal user-level configuration and
global skills, while each ACP session uses the absolute project directory supplied by the client.

## JetBrains custom agent

In AI Chat choose **Add Custom Agent**, then add this entry to `~/.jetbrains/acp.json`:

```json
{
  "default_mcp_settings": {
    "use_idea_mcp": false,
    "use_custom_mcp": false
  },
  "agent_servers": {
    "Neko": {
      "command": "neko",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Ordinary `neko acp` refuses client-supplied MCP during session creation, so keep both forwarding switches off
and configure trusted MCP servers in Neko itself. Use the full path to the Neko executable if the IDE does
not inherit your shell's `PATH`.

## Embedded host profiles

`--host-profile` is an authority ceiling selected by the trusted process launcher, not a preference supplied
inside an ACP session. `--host-profile nekocut` changes composition for that process only:

- native filesystem, shell, web, browser, computer, skills, subagents, hooks, memory/workflows, and globally
  configured MCP are not built into the runtime;
- the client must provide exactly one MCP server named `nekocut` using ACP's in-band transport; stdio, HTTP,
  SSE, extra servers, and missing servers fail before the session runtime is created;
- the model sees exactly six namespaced NekoCut inspect/preview/submit tools, enforced by the same
  `ToolRegistry` allowlist at schema and execution time;
- only `default` and `auto` modes are available, and changing mode cannot add a tool;
- the profile ID, version, and tool-surface hash are checkpointed. List/load/resume are isolated from ordinary
  ACP sessions and require the same profile on the next process.

The in-band server is carried over the existing ACP stdio channel; Neko never executes a client-provided
command or opens a client-provided URL. `submit_edit_plan` stages a typed proposal in NekoCut. NekoCut remains
the sole authority for validation, Apply, persistence, and Undo.

## Optional Wiii Computer capability

An ordinary ACP client may advertise Wiii's session-scoped semantic Computer extension in `initialize`:

```json
{
  "clientCapabilities": {
    "_meta": {
      "dev.wiii.computer.v1": {
        "semanticProtocol": "neko-computer.semantic.v1",
        "methods": [
          "wiii/computer/v1/status",
          "wiii/computer/v1/observe",
          "wiii/computer/v1/lease/acquire",
          "wiii/computer/v1/act",
          "wiii/computer/v1/lease/release"
        ]
      }
    }
  }
}
```

Negotiation is exact and connection-scoped. A missing, partial, renamed, or cross-connection capability
exposes no `computer` tool in ACP and never falls back to Neko's local Windows UIA/PowerShell implementation.
Launch-authorized host profiles remain exclusive and ignore this optional extension.

When negotiated, the model sees one coordinate-free semantic tool and must follow
`status -> observe -> acquire -> focus/invoke/set_text -> release`. Neko uses only a ref from the latest
snapshot plus its exact state version, role, and name. A stale or mismatched target causes one fresh observation
and no blind action retry. Mutating requests carry a stable, Neko-owned operation ID; an unknown result can be
retried with that same ID only after a fresh observation shows the same logical preconditions.

Wiii remains the sole owner of provisioning, project grants, native environment IDs, display URLs/tokens,
credentials, and native lease IDs. Neko allowlists the model-visible status/snapshot/result fields, omits element
values, refuses protected inputs, stops for CAPTCHA or human takeover, and best-effort releases control after each
turn and on cancel/close/disconnect. `status`, `observe`, and `release` are read/cleanup operations; acquire and
state-changing actions retain Neko's host-computer consent boundary. Provider-native children inside the same
AgentSession share that one bounded port and never create another native owner.

ACP clients that advertise Terminal Auth support can also launch Neko's corresponding method. It runs
`neko login openai chatgpt` in a separate interactive terminal, so browser OAuth never shares the ACP
protocol stream and no credential is sent in JSON-RPC. The client reconnects after a successful login;
the terminal method is not passed to ACP's in-band `authenticate` request. API-key and other provider profiles remain
config-first and can be set up with Neko's normal `login`/`config` commands before starting the client.

## Permission mapping

ACP session modes map one-to-one to Neko's named permission states:

| ACP mode | Neko behavior |
| --- | --- |
| `default` | Prompt through `session/request_permission` before gated writes/commands. |
| `accept-edits` | Approve Neko file edits; other gated actions still prompt. |
| `plan` | Hard-deny every gated action. No permission dialog can override it. |
| `auto` | Approve bounded coding tools; Neko seatbelts and host-computer consent still apply. |

The permission dialog offers allow/reject once and allow/reject for the current ACP session. Persistent
choices are deliberately scoped to that session and disappear when it closes. A disconnected or
non-responsive client fails closed.

## Current v1 surface

- `initialize` with capability-negotiated, Registry-compatible ChatGPT Terminal Auth
- durable `session/new`, `session/list`, `session/load`, `session/resume`, and `session/close`
- `session/prompt`, `session/cancel`, `session/set_mode`, and `session/set_config_option`
- streamed agent text/thought chunks and tool lifecycle updates
- session metadata, usage, mode, provider/profile/model/effort configuration, and implemented slash commands
- text, resource links, and embedded text context
- trusted MCP servers from Neko's normal user/project configuration, or an exclusive launch-authorized host
  surface when `--host-profile` is explicitly selected

ACP session IDs are the same durable IDs used by `neko sessions` and `neko resume`. `session/load` restores
the canonical Agent messages and replays user/assistant/tool history with stable message/tool IDs before it
responds. `session/resume` restores the same model context without replay, for clients that already retain the
transcript. `session/list` supports canonical-cwd filtering and bounded cursor pagination.

The adapter checkpoints the existing atomic session store before provider waits, before a materialized tool
call executes, after tool results, at Agent crash-journal checkpoints, and on completion/cancel/error/close.
The store keeps the previous valid checkpoint as a fallback and uses a cross-process single-writer lease. If
a process dies after a mutation may have run but before its result was journaled, resume adds a failed
`outcome unknown` result and tells the Agent to inspect reality before retrying; it never silently repeats the
mutation. Provider continuation items remain opaque inside the canonical messages and are never exposed as
thought text. Resolved provider credentials are redacted from checkpoint strings.

The provider/profile/model/effort selectors rebuild only the provider between idle turns while preserving
canonical messages. A provider or endpoint switch is rejected when opaque continuation state makes it unsafe;
the client can start/fork a separate session instead. Session-local `always allow`/`always reject` answers are
not persisted and therefore return to the named permission mode after a restart. Neko currently advertises
only `/help`, `/cost`, `/sessions`, and `/tools`; each is dispatched by the ACP adapter rather than sent to the
model as an ordinary prompt.

Neko still does not advertise session delete, additional workspace roots, arbitrary client-supplied MCP, image/audio
prompts, or draft ACP v2. Those methods fail explicitly rather than degrading to a broader local authority.
Ordinary client-supplied MCP is deliberately held back because merely opening a session must not launch an
untrusted stdio command or network connection before Neko's permission boundary runs. The host-profile
exception accepts only an exact ACP-transport descriptor whose implementation stays on the existing channel.

## Debugging

ACP reserves stdout for protocol frames. Neko diagnostics go to stderr. In Zed, run
`dev: open acp logs` to inspect the exchanged messages.

Protocol: <https://agentclientprotocol.com/protocol/v1/overview>

## Registry release gate

The official Registry accepts released binary, npm, or PyPI distributions and verifies that `initialize`
advertises Agent Auth or Terminal Auth. Neko satisfies the handshake requirement, but its Registry entry
must point to a release that actually contains `neko acp`; publication is intentionally a post-release PR,
not a source-tree claim.
