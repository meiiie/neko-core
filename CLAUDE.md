# Neko Code — working notes for Claude Code

**Neko Code** is a local-first terminal coding agent (Claude-Code / Codex-CLI class), built
in **TypeScript + Bun + Ink**. Its engine/library is **Neko Core** (package `neko-core`).
The command is `neko`. Roadmap + history: `docs/process/ROADMAP.md`, `docs/process/WORKLOG.md`.
Working rules: `docs/process/RULES.md`.

## Codebase map (`src/`, run by Bun)

| Module | Role |
|---|---|
| `config.ts` | Config-first loader: overlay (built-in → `~/.neko-core` → `./.neko-core` → profile → `NEKO_*` env) + profiles. Key read on demand, never stored/printed. |
| `providers.ts` | One `complete(messages, tools, onDelta?)` contract; `openai_compat` over `fetch` with SSE streaming + retry. |
| `tools.ts` · `tool-runtime.ts` | Tool contracts (safe: read_file/search/glob/ls · gated: write_file/edit/bash) + executable runtime; path-escape refused. |
| `permissions.ts` | Permission modes: default / accept-edits / plan / auto. |
| `registry.ts` | agents / commands / capabilities + the `policy` audit. |
| `agent.ts` | The agent loop (`complete → tool_calls → observe`, `max_steps`) + cost tracking. |
| `context.ts` · `session.ts` · `mcp.ts` · `cost.ts` | Project context (NEKO.md/CLAUDE.md) · conversation persistence/resume · MCP client · token usage. |
| `doctor.ts` · `project.ts` | `neko doctor` diagnostics · `init`/`init-user` scaffolds. |
| `ui/chat.tsx` | The Ink (React) TUI REPL — streaming, tool lines, approval, slash commands, Shift+Tab modes. |
| `bin/neko.ts` | The `neko` CLI entry point. |
| `reference/python/` | The Python **spec/reference** (the original port). Not shipped; read it, don't depend on it. |

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
