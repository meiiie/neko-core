# Neko Core — working notes for Codex

**Neko Core** is a local-first terminal coding agent (Codex / Codex-CLI class), built
in **TypeScript + Bun + Ink**. Its engine/library is the package `neko-core`.
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
| `adapters/config.ts` | Config-first loader: overlay (built-in → profile preset → `~/.neko-core` → `./.neko-core` → `NEKO_*`) + profiles. Key read on demand, never stored/printed. |
| `adapters/mcp.ts` · `adapters/session.ts` · `adapters/context.ts` · `adapters/skills.ts` | MCP client · session persistence/resume · global identity + project context (NEKO.md/AGENTS.md) · `.md` skills. |
| `adapters/registry.ts` · `adapters/doctor.ts` · `adapters/project.ts` | capabilities + `policy` audit · `doctor` diagnostics · `init` scaffolds. |
| `adapters/tool-registry.ts` | Shared CLI/TUI/subagent composition for native web, skills, vision, sandbox and inherited safety boundaries. |
| `adapters/office-tools.ts` · `adapters/office-support-pack.ts` | Typed, workspace-bounded Office tools + optional checksummed OfficeCLI support pack. |
| `adapters/mcp-compose.ts` | Composes independent edge-tool sources behind the single `McpTools` port. |
| **`shared/`** | `version.ts` (leaf). |
| **`ui/`** | Ink REPL, split by concern: `chat.tsx` (lifecycle + turn loop + render), `commands.ts` (slash commands + `runSlashCommand`), `transcript.tsx` (line renderer), `select-list.tsx` (reusable picker), `thinking-line.tsx`, `approval-box.tsx`, `markdown.tsx`, `highlight.tsx`, `logo.tsx`, `text-input.tsx`, `format.ts`. |
| `bin/neko-source.cjs` · `bin/neko.ts` | Safe Node source bootstrap · internal Bun CLI entry. |
| `reference/python/` | The Python **spec/reference** (original port). Not shipped; read it, don't depend on it. |

## Critical gotchas

- **`bang_c` is FROZEN** (sibling `E:\Sach\Sua\bang_c`). Read to learn; never edit.
- **Clean-room only.** The local `Codex` tree is studied for patterns/UX, **never copied**
  into this public repo. Learn ideas ✅, copy proprietary code ❌.
- **Reference clones** live in `../neko-refs/` (sibling, untracked — e.g. Goose). Study them
  clean-room for ideas; never copy code in.
- **Secrets never committed/printed.** Key via env (`NEKO_API_KEY` / `OPENAI_API_KEY` /
  `NVIDIA_API_KEY`) or gitignored `~/.neko-core/config.json`. Run `/secret-scan` before any push.
- **Config-first.** A new model/endpoint is a profile, not a code change.
- **Windows console is cp1252.** Keep *printed* strings ASCII (an em-dash mojibakes).
- **Auto-by-default, consequence-gated.** The default permission mode is `auto` (bounded autonomy, matching 2026 industry practice); only consequential surfaces ask - host `computer` control, the policy file itself, catastrophic shell (seatbelt), credential paths, and anything outside the workspace. Modes remain a *named* state (Shift+Tab).

## Verify loop

```bash
rtk bun run typecheck          # tsc --noEmit
rtk bun test                   # the test suite
rtk node bin/neko-source.cjs doctor # resolved provider/model/key (no model call)
rtk node bin/neko-source.cjs policy # safe/gated boundary audit
rtk bun run build                  # bun build --compile -> dist/neko (single binary)
```

(Prefix shell commands with `rtk` per the global RTK rule.)
