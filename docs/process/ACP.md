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

Neko currently refuses client-supplied MCP during session creation, so keep both forwarding switches off
and configure trusted MCP servers in Neko itself. Use the full path to the Neko executable if the IDE does
not inherit your shell's `PATH`.

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
- `session/new`, `session/prompt`, `session/cancel`, `session/close`, `session/set_mode`
- streamed agent text/thought chunks and tool lifecycle updates
- text, resource links, and embedded text context
- trusted MCP servers from Neko's normal user/project configuration

Neko does not advertise session load/list/delete/resume, additional workspace roots, client-supplied MCP,
image/audio prompts, or draft ACP v2. Those methods fail explicitly rather than degrading to a broader local
authority. Client-supplied MCP is deliberately held back because merely opening a session must not launch an
untrusted stdio command or network connection before Neko's permission boundary runs.

## Debugging

ACP reserves stdout for protocol frames. Neko diagnostics go to stderr. In Zed, run
`dev: open acp logs` to inspect the exchanged messages.

Protocol: <https://agentclientprotocol.com/protocol/v1/overview>

## Registry release gate

The official Registry accepts released binary, npm, or PyPI distributions and verifies that `initialize`
advertises Agent Auth or Terminal Auth. Neko satisfies the handshake requirement, but its Registry entry
must point to a release that actually contains `neko acp`; publication is intentionally a post-release PR,
not a source-tree claim.
