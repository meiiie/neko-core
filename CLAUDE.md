# Neko Code — working notes for Claude Code

**Neko Code** is a local-first terminal coding agent (Claude-Code / Codex-CLI class), built
in **TypeScript + Bun + Ink**. Its engine/library is **Neko Core** (package `neko-core`).
The command is `neko`. Roadmap + history: `docs/process/ROADMAP.md`, `docs/process/WORKLOG.md`.
Working rules: `docs/process/RULES.md`.

## Codebase map (`src/`, run by Bun)

Ports & Adapters — dependencies point inward (`docs/process/ARCHITECTURE.md`,
enforced by `test/architecture.test.ts`).

| Layer / Module | Role |
|---|---|
| **`core/`** (pure domain) | |
| `core/ports.ts` | The interfaces core depends on: `Provider` (LLM), `McpTools`, plus `ToolCall`/`ProviderResponse`/`DeltaHook`. |
| `core/agent.ts` | The agent loop (`complete → tool_calls → observe`, `max_steps`) + cost; `compact()`; `appendSystem()`. |
| `core/tools.ts` · `core/tool-runtime.ts` | Tool contracts (safe: read_file/search/glob/ls/todo_write · gated: write_file/edit/bash) + `describeToolCall` + executable `ToolRegistry`; path-escape refused. |
| `core/permissions.ts` · `core/cost.ts` | Permission modes (default/accept-edits/plan/auto) · token usage. |
| **`adapters/`** (edge) | |
| `adapters/providers.ts` | `openai_compat` over `fetch`: SSE streaming, retry, abort (implements `Provider`). |
| `adapters/config.ts` | Config-first loader: overlay (built-in → `~/.neko-core` → `./.neko-core` → profile → `NEKO_*`) + profiles. Key read on demand, never stored/printed. |
| `adapters/mcp.ts` · `adapters/session.ts` · `adapters/context.ts` · `adapters/skills.ts` | MCP client · session persistence/resume · project context (NEKO.md/CLAUDE.md) · `.md` skills. |
| `adapters/registry.ts` · `adapters/doctor.ts` · `adapters/project.ts` | capabilities + `policy` audit · `doctor` diagnostics · `init` scaffolds. |
| **`shared/`** | `version.ts` (leaf). |
| **`ui/`** | `ui/chat.tsx` — Ink REPL (streaming markdown, tool lines, approval, thinking line, slash commands, modes). |
| `bin/neko.ts` | The `neko` CLI entry point. |
| `reference/python/` | The Python **spec/reference** (original port). Not shipped; read it, don't depend on it. |

## Critical gotchas

- **`bang_c` is FROZEN** (sibling `E:\Sach\Sua\bang_c`). Read to learn; never edit.
- **Clean-room only.** The local `claude-code` tree is studied for patterns/UX, **never copied**
  into this public repo. Learn ideas ✅, copy proprietary code ❌.
- **Secrets never committed/printed.** Key via env (`NEKO_API_KEY` / `OPENAI_API_KEY` /
  `NVIDIA_API_KEY`) or gitignored `~/.neko-core/config.json`. Run `/secret-scan` before any push.
- **Config-first.** A new model/endpoint is a profile, not a code change.
- **Windows console is cp1252.** Keep *printed* strings ASCII (an em-dash mojibakes).
- **Safe-by-default.** `write_file`/`edit`/`bash` are approval-gated; modes are a *named* state.

## Verify loop

```bash
rtk bun run typecheck          # tsc --noEmit
rtk bun test                   # the test suite
bun bin/neko.ts doctor         # resolved provider/model/key (no model call)
bun bin/neko.ts policy         # safe/gated boundary audit
bun run build                  # bun build --compile -> dist/neko (single binary)
```

(Prefix shell commands with `rtk` per the global RTK rule.)
