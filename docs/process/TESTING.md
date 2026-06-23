# Neko Code — test plan & log

A thorough, repeatable test of every layer: pure logic, the agentic loop, the tools, MCP, and the
whole TUI/UX — plus live end-to-end runs against a real provider, tiered easy → hard → edge.

## How to run

```bash
rtk bun run typecheck        # types
rtk bun test                 # all headless tests (unit + integration + UI snapshots) — no network
bash scripts/selftest.sh     # LIVE end-to-end (drives `neko run`; uses real API tokens)
bun bin/neko.ts policy       # safe/gated tool-boundary audit
```

## Layer 1 — headless unit/integration (`bun test`, no network)

| Area | File | Covers |
|---|---|---|
| Architecture | architecture.test | core never imports adapters/ui/ink (deps point inward) |
| Agent loop | agent.test | loop, max_steps cap, **loop guard** (3x-repeat), graceful finish, compact (keep-tail), runUntilDone, parallel fan-out, vision images, /rewind, dynamicContext |
| Tools | tools.test | tool list/order, schema, describeToolCall, SAFE/GATED |
| Tool runtime | tool-runtime.test (26) | read/write/edit (+whitespace fallback +diff), **multi_edit** (atomic), bash (exit + **Ctrl+B background**), **checkpoint/restore**, seatbelt, disabled, hooks, todo, **adversarial check** (native + MCP), **task subagent_type** |
| Permissions | permissions.test | default/accept-edits/plan/auto decisions |
| Config | config.test (13) | overlay precedence, profiles, per-model context window, isLocalEndpoint, **mcp_allow/deny**, defaults |
| Providers | providers.test | OpenAI-compat parse, stream, retry/abort |
| Sessions | session.test | per-cwd isolation, save/load |
| Context | context.test | NEKO.md, @import, environmentBlock, rememberNote |
| MCP | mcp-oauth, remote-control | OAuth provider storage; /rc token-gated round-trip |
| Recipes/registry | recipes, registry | $ARGUMENTS fill; capability/policy audit |

## Layer 2 — UX/UI (headless Ink snapshots)

| File | Covers |
|---|---|
| chat-ui.test | header/status bar, **resume replays conversation**, tool line, approval box + `y`, plan box, queue, slash menu |
| ux.test | status bar (mode + ctx%), **ThinkingLine effort + per-turn tokens**, **edit diff preview** (-/+), **live reasoning** (shows then clears), **post-turn run-time line**, **placeholder drops after 1st turn**, **Ctrl+C clears input** |
| markdown.test | table renders bold cells + decodes entities/`<br>`; tool-result collapse + ctrl+o hint; 1-line read summary |
| text-input.test | cursor insert (Left + type), IME/NFC end-typing, multi-line paste (no early submit) |
| ui.test | logo/markdown/highlight primitives |

## Layer 3 — live end-to-end (`scripts/selftest.sh`, real provider)

Tiered, with deterministic checks where possible (file contents, grep on output):

| Tier | Scenario | Check |
|---|---|---|
| Easy | provider round-trip | replies "NEKO-OK" |
| Medium | write_file + read_file | file contains "pong" |
| Medium | bash + reasoning | prints "BASHOK" |
| Medium | glob/ls discovery | finds src/core/cost.ts |
| Hard | read + reason chain | names class "CostTracker" |
| Hard | multi_edit (2 edits, atomic) | both edits land on disk |
| Edge | read missing file | reports the error gracefully (no crash/loop) |

## Run log

**2026-06-23** (profile: nvidia / qwen3-next-80b-a3b-instruct)
- `bun run typecheck` — clean.
- `bun test` — **107 passed, 0 failed** (19 files); re-run ×3, stable (de-flaked the async-bash approval test).
- `bun bin/neko.ts policy` — PASS.
- `bash scripts/selftest.sh` — **7/7 passed** (easy → hard → edge).

### Observations
- Each turn sends ~3k input tokens minimum (system prompt + `<env>` + project context). If token
  cost matters, trimming the system prompt is the clearest win.
- Live `reasoning` only renders for endpoints that return `reasoning_content`; the qwen *instruct*
  model doesn't emit it (not a Neko issue) — verified the mechanism with a mock that does.
- The interactive TUI can't be keyboard-driven headlessly (no TTY); it's covered by Ink snapshot
  tests (Layer 2). The live layer drives the same core via `neko run`.
