# Neko Core — Work Log

Running journal of what was done and the decisions behind it. Newest entry first.
Rules that govern this work live in `RULES.md`.

## 2026-06-29 — Computer-use: independent pointer, web-via-a11y, tab presence

Built `skills/computer-use` into a real, config-first, composable capability — Neko USES the
computer, on the user's real visible machine, with its own pointer that doesn't hijack the mouse.

**Grounding + action (no GUI-trained model, mostly no vision):**
- `uia.ps1` — the Windows accessibility tree as the desktop DOM: `list` (actionable elements +
  verb + exact coords), `invoke`/`setvalue`/`toggle` (UIA patterns — act with NO cursor), `get`
  (verify), `read` (dump a page/doc as TEXT to summarize). CacheRequest beats the FindAll timeout
  on rich WinUI/WPF trees. Unicode targets via `@<utf8-file>` (the cp1252 console mangles Vietnamese
  args; invoke-by-name is layout-independent — coord taps on a reflowing feed are fragile).
- `inject.ps1` — **independent agent pointer** via Windows TOUCH INJECTION
  (`InitializeTouchInjection`/`InjectTouchInput`): tap/dbltap/stroke on the visible desktop WITHOUT
  moving the user's mouse (verified: drew in Paint with the real cursor parked, unmoved). No driver,
  no admin, Win11-Home OK.
- `mouse.ps1` — legacy SendInput (moves the one system cursor); when `NEKO_INPUT=inject` it
  transparently delegates the acting verbs to `inject.ps1`.
- `overlay.ps1` — the VISIBLE agent cursor (blue triangle, flies to where Neko acts) + a presence
  banner; now also a **tab/window indicator**: reads `neko_active_window.txt` and frames + labels
  the exact window/tab Neko is using ("NEKO dang dung tab nay: <title>").

**Config-first (a backend/flag, not a code change):** `computer_use_overlay` -> `NEKO_PRESENCE`
(overlay + takeover); `computer_use_input: "inject"|"sendinput"` -> `NEKO_INPUT` (which pointer
backend). Helpers also publish `NEKO_DRAW_WINDOW` to the active-window file for the indicator.

**Web via accessibility (reuse the logged-in browser, no CDP, no credentials):** launch Chrome with
`--force-renderer-accessibility` so `uia.ps1 read` sees the page DOM as text. gpt-oss AUTONOMOUSLY
browsed + summarized a live Facebook feed (read -> scroll via inject -> summarize), and opened +
composed a post by invoking the composer BY NAME. Posting capability proven end-to-end; the final
irreversible publish is left to the user's explicit go.

**Honest findings (dead ends documented so we don't repeat them):** Chrome 149 blocks CDP on the
default profile; Chrome 127+ App-Bound Encryption blocks cookie-copy (so a copied profile loses the
login) -> `--force-renderer-accessibility` on the default profile is the clean reuse path. UWP apps
suspend their UIA tree when fully hidden (keep visible). For read-heavy turns, lower `reasoning_effort`
so the model emits the answer instead of over-reasoning into the output-token cap.

**Independent cursor — the answer:** Windows has ONE *mouse* cursor (a 2nd OS arrow needs a kernel
driver). But it has SEPARATE pen/touch input channels, so Neko's pointer = touch injection (acts,
mouse untouched) + the overlay triangle (visible) + the tab frame (which window). Functionally its
own cursor on the same screen; true hidden/background or game control still needs a VM (isolation).

## 2026-06-22 — Session 1: port → harness → go-live

**Ported the coding-agent core out of the frozen `bang_c` (PORTING steps 1–6):**
- config-first (layered overlay + named profiles); providers (`openai_compat` +
  optional `local_llamacpp`) behind one `complete(messages, tools)` contract.
- tool contracts + executable tools: `read_file`/`search` (safe), `write_file`/`bash`
  (gated, approval gate, path-escape refused).
- registries + a real `policy` audit of the safe/gated boundary.
- the agent loop (`complete → tool_calls → observe`, `max_steps` cap); `neko chat`/`run`
  + `--yolo`. 38 pytest tests green.

**Configured the Claude Code harness (full-lean):** `CLAUDE.md`, `.claude/settings.json`
(allow verify-loop, deny edits to `bang_c` + reads of secrets), `.claudeignore`, slash
commands `/verify` `/secret-scan` `/port-module`. (A `neko-explorer` subagent file exists
but per the no-subagent rule we don't use it — kept only as an optional, dormant artifact.)

**Went live:** wired an NVIDIA NIM endpoint via `~/.neko-core/config.json` (key via JSON,
never committed); model `qwen/qwen3-next-80b-a3b-instruct`. Verified end-to-end: the model
called `read_file` and answered correctly.

**Shipped:** merged + pushed to `origin/main`. Installed `neko` via `pipx` (editable);
resolved the name collision with the heritage CLI (heritage stays reachable as `bang-c`).

**Fixed REPL resilience:** survives any turn failure (prints the error, stays at the
prompt), clear API-error messages, EOF / non-TTY diagnostics instead of silent exit.

### Decision — language/runtime: **TypeScript + Bun + Ink** (owner, 2026-06-22)
Evaluated on merits (no sunk-cost; project still small). TS is the proven stack for this
product category (Claude Code, Gemini CLI, opencode all TS+Ink), MCP reference SDK is TS,
Bun compiles to a native binary (drops the Node-runtime dependency), and the team already
ships TS (wiii-desktop). "Offline-first" needs only a local OpenAI-compatible server
(llama-server/Ollama) — no in-process inference, so no Python advantage. Go/Rust are
reserved for LATER if zero-dependency single-binary distribution becomes the main pain
(the Codex/Goose path). The Python build is kept as the spec under `reference/python/`.

## 2026-06-22 — Session 2: TypeScript rewrite (branch `feat/ts-rewrite`)
- Restructured: Python moved to `reference/python/`; TS project at root (Bun, `src/`, `bin/`).
- **TS Step 1 done** — config-first overlay + profiles + env + key-via-env/JSON
  (`src/config.ts`), `openai_compat` provider over `fetch` with retry/backoff + clear error
  parsing (`src/providers.ts`), `doctor`/`init-user`/`init` + the `neko` CLI dispatch
  (`bin/neko.ts`). Typecheck clean; reads the SAME `~/.neko-core/config.json` as Python, so
  the live NVIDIA profile works unchanged; key shows `set`, never the value.

- **Runtime confirmed: Bun + TS + Ink** (owner). Rust reserved for later (Codex path) —
  Ink TUI + MCP Tier-1 are TS-native, Bun already gives single-binary + fast startup.
- Studying the local `claude-code` (claude-js) tree as a **clean-room reference** for
  UX/UI + logic only (never copy). Goal defined in `ROADMAP.md`.
- **A1 done** — tools + registry + policy in TS (`src/tools.ts`, `src/tool-runtime.ts`,
  `src/registry.ts`); `neko tools/agents/commands/capabilities/policy` wired. Tool runtime
  verified (read/search/write/bash, path-escape refused, denial-as-string, safe-under-deny).

### Next (TS) — see ROADMAP.md
- A2 agent loop + `neko run`; A3 real tool set (edit/glob/ls); A4 streaming + cost.
- B1 Ink chat REPL; B2 slash commands; B3 permission modes. C1-C3 project context / resume / MCP.
- D1 tests; D2 single binary + re-point `neko`; D3 rename to Neko Code + merge.

- **A3 done** — coding tool set: `edit` (unique string replace, gated), `glob` (Bun.Glob), `ls` (safe). 7 tools total; coder/explorer agents + policy updated.
- **A4 done** — SSE streaming in the provider (`complete(.., onDelta)`) + token tracking (`src/cost.ts`). `neko run` streams the answer live and prints a token usage line.
- **B1 done** — Ink chat REPL (`src/ui/chat.tsx`): streaming render, interleaved tool lines, inline approval (y/a/n), spinner, one Agent across turns. Deps: ink@7/react@19/ink-text-input/ink-spinner. `neko chat` launches it (lazy import).
- **B2 done** — slash commands (/help /cost /model /profiles /init /clear /reset /exit), input history (up/down), multiline (trailing backslash) in the Ink REPL.
- **B3 done** — permission modes (`src/permissions.ts`): default/accept-edits/plan/auto; ToolRegistry decides allow/prompt/deny by mode; Shift+Tab cycles in the Ink REPL; doctor/capabilities/policy show mode; NEKO_MODE env override.
- **C1 done** — project context (`src/context.ts`): NEKO.md/CLAUDE.md from cwd→repo root + ~/.neko-core/NEKO.md, prepended to the system prompt; `neko context` diagnostic.
- **C2 done** — conversation persistence (`src/session.ts`): chat saves each turn to ~/.neko-core/sessions/ (keyed by cwd); `neko chat --resume` reloads latest; `neko sessions` lists.
- **C3 done** — MCP client (`src/mcp.ts`): stdio servers from config -> tools as mcp__server__tool (gated by mode); `neko mcp` lists; agent merges MCP + built-in schemas. Verified live against a local echo MCP server (test/fixtures/echo-mcp.ts).
- **D1 done** — bun test suite: 44 tests (config/providers/permissions/tools/runtime/registry/agent/context/session), all pass; typecheck clean.

### Loop paused — D2/D3 need owner sign-off
- D2 (re-point the `neko` command pipx->TS binary) changes the environment; D3 (rename to Neko Code + merge to main + push public) is outward-facing. Both await the owner.

## 2026-06-22 — Session 2 finalize (D2 + D3)
- **D2 done** — bun build --compile single binary (dist/neko, react-devtools-core bundled for Ink); removed Python pipx neko; copied the TS binary to ~/.local/bin/neko.exe. `neko` now = the TS build (live-verified).
- **D3 done** — renamed product to Neko Code (README + CLAUDE.md refreshed; engine = Neko Core); secret-scan; merge feat/ts-rewrite -> main + push.
- **ROADMAP COMPLETE: 14/14 milestones.** Neko Code is a Claude-Code-class TS+Bun+Ink coding agent.

## 2026-06-22 — Session 3: UX/UI parity
- **E1 done** — compared against the local claude-code component surface (App/BaseTextInput/Markdown/Message/FileEditToolDiff/InterruptedByUser...) and reimplemented clean-room: welcome box, bordered input, markdown output, tool bullets, spinner+elapsed, Esc-to-interrupt (AbortSignal), approval box with diff preview. ASCII-safe. Approval gate now passes tool args (for diff). Binary rebuilt + reinstalled.
- **E2** slash-command autocomplete menu (filtered list under the input when typing /). Verified via headless render + snapshot.
- **E3** activation: bare `neko` (and `neko code` / `neko core`) now starts the session (no need for `neko chat`); `neko chat` still works. --help/--version/other commands intact.

## 2026-06-22 — Session 4: full polish (studied claude-code clean-room)
- **E4** syntax highlighting · **E5** markdown tables · **E6** input queue while busy (status shows N queued) + non-streamed-final render. 53 tests pass; verified via rendered snapshots (table aligned, code highlighted, queue drains).

## 2026-06-22 — Session 5: i18n fix + pro UI (+ ponytail skill)
- **Fixed Vietnamese/IME input**: replaced ink-text-input with a tiny Ink-native input (src/ui/text-input.tsx) that appends decoded keypresses + NFC-normalizes, codepoint-safe. No more 'chuúng'/'hệ hệ' duplication.
- **Redesigned TUI** toward Claude Code: dropped heavy +--+ boxes; cat logo header + dim subtitle, thin full-width rule, clean '> ' prompt, two-column bottom status bar (mode·shift+tab left, model·tokens right). Removed ink-text-input dep.
- Installed the **ponytail** skill (~/.claude/skills) and used it (minimal-code mode) for this pass. Studied claude-code components clean-room.
- **Logo**: baked assets/neko-core-banner.png into src/ui/logo.tsx as magenta half-block art (scripts/gen-logo.ts, pngjs devDep; no runtime decode). Welcome shows it + dim version/model/path.
- **Logo redesign**: dropped the big pixel-art 'NEKO CORE' wordmark + the PNG-bake machinery (gen-logo.ts, pngjs). Now a small cool cat mascot (shades, orange) + 'Neko Code' as clean text — Claude-style. src/ui/logo.tsx is a tiny component.
- **Vietnamese fix v2**: root cause was stale-closure in the controlled input (IME sends backspace+char back-to-back; both read the stale value -> 'moọi'). Now value lives in a ref, mutated synchronously. Test reproduces 'mọ' not 'moọ'.
- **Logo**: cat now matches the banner glyph (/\··~▽, ハ‥マ style) inline with the title.
- **Micro-UX**: tool calls show a green ● bullet + dim ⎿ result; assistant messages get vertical breathing room.

## 2026-06-22 — Session 6: features (markdown/loop/tools/skills)
- **Markdown**: blockquotes (│) + links ([text](url) -> text). 
- **Loop**: agent emits step N; chat status shows 'step N'.
- **Tool mgmt**: ToolRegistry.disabled; chat /tools lists, /tools <name> toggles (hidden from schemas + blocked).
- **Skill system**: src/skills.ts loads *.md from ~/.neko-core/skills + ./.neko-core/skills; neko skills, chat /skills + /skill <name> (injects into system prompt via Agent.appendSystem). Example skill: ~/.neko-core/skills/concise.md.
