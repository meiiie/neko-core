# Neko Core — Work Log

Running journal of what was done and the decisions behind it. Newest entry first.
Rules that govern this work live in `RULES.md`.

## 2026-07-01 — GeneBench-Pro harness-lift, Windows bash fix, TUI polish

Continued on `self-improve`. Three linked arcs, all green (typecheck + 239 tests + policy + build).

**Dogfooded Neko on a real research benchmark (GeneBench-Pro).** OpenAI's new benchmark for agents doing
messy multi-stage computational-biology analysis (129 problems; SOTA is low — GPT-5.6 Sol Pro 31.5%, Claude
Opus 4.8 16%). Pulled the public 10-problem package from Hugging Face (`ajh-oai/genebench-pro-public-package`),
built a thin runner (`E:\Sach\Sua\genebench-pro\`, outside the repo) that stages each problem's data files,
runs `neko run --yolo "<task>"`, extracts the final JSON answer, and grades it with the benchmark's own public
`reference_grader.py` (fully deterministic — no LLM judge). Proved Neko is exactly the right agent shape for
this (bash + code execution + files + iterate). gpt-oss scored 0/10 (expected for a weak model on a 16-31%
benchmark), but the run SURFACED two harness bugs that cost answers independent of model quality.

**Windows bash fix (real harness-lift, benefits every Windows run).** The `bash` tool spawned via
`{ shell: true }`, which on Windows is **cmd.exe** — so a model's natural Unix idioms (`python - <<'PY'`
heredocs, single-quotes, `$VAR`, pipes) failed with "<< was unexpected at this time", burning steps. Fixed in
`core/sandbox.ts`: on Windows the unsandboxed path now routes through real **Git-Bash** (`findWindowsBash()`
prefers `NEKO_BASH`, then a Git install, then a git-derived path; deliberately ignores WSL's
`System32\bash.exe`, which can't see the Windows-drive cwd), falling back to cmd.exe only if no bash is found.
Verified a heredoc now runs (`HEREDOC_OK 4`). Re-running GeneBench with the fix + higher `max_steps` moved a
problem from no-answer (cut off) to a graded answer; no-JSON count 2→1. Lesson confirmed: **harness quality
lifts completion/answer-rate; crossing the pass threshold needs a stronger model.**

**TUI polish (Claude-Code-level, clean-room from screenshots + our own code — nothing copied).**
- **Tables** (`ui/markdown.tsx`): the old renderer space-padded columns with no borders as one `<Text>` per
  row, so a wide table overflowed the terminal and Ink wrap-shattered the columns. Rewrote it width-aware:
  box borders (`┌┬┐│├┼┤└┴┘`), columns budgeted to the terminal `cols` (`fitColumns` shrinks the widest first),
  cells truncated to a single line (`truncCell`, ellipsis) so borders stay aligned, inline styling kept.
- **Rhythm:** breathing room above headings + around tables (vertical rhythm, not cramped text).
- **Ctrl+O is now a toggle** (`ui/chat.tsx`): it used to APPEND a full copy each press (never collapsing,
  because `<Static>` lines are immutable). Now it toggles an `expandedId` and shows the peeked result in the
  live region (below `<Static>`), so a second Ctrl+O collapses cleanly — no duplication.
- **Blinking run indicator** (`ui/thinking-line.tsx` `RunningLine`): a tool call in flight now shows LIVE with
  a blinking gray dot; it commits to the transcript (solid dot) only when it finishes — a clear running-vs-done
  signal, matching Claude Code. Tool-call lines are deferred + keyed by call id so the agent's concurrent path
  (all tool_calls, then all tool_results) pairs correctly. `cols` is threaded transcript → Markdown so both
  the committed and streaming renders are width-aware.

## 2026-07-01 — Self-improve loop, Z.ai/glm-5.2 provider UX, web-reading overhaul

A long session on the `self-improve` branch (39 commits ahead of main, all green: typecheck + 233 tests
+ policy + build). Three arcs; everything stays on the branch for review (main untouched at 3b7091a).

**Self-improvement loop (Neko improves Neko).** `scripts/self-improve.ts`: glm-5.2 (Z.ai plan) edits Neko
→ a hard VERIFY GATE (typecheck + 0-fail tests + policy) → an INDEPENDENT model peer-reviews the diff via
`scripts/review-diff.ts` → commit to the branch, else revert; when stuck it web-searches SOTA and refills
`docs/self-improve/BACKLOG.md`. Bench got per-task metrics (time / in-out tokens / tok-s / steps) + a JSONL
dev-log (`~/.neko-core/bench-log.jsonl`) + a harder tier. Ran unattended in ~50-min batches and produced
FOUR genuine, verified, reviewed harness wins: `estimateTokens` counts tool_calls (overflow-guard
accuracy); `compact()` char-based lean-tail clip (dense-output token win); a broad doom-loop guard (later
softened to warn-not-block, cap 6, on audit); and a real SECURITY fix — the bash seatbelt was bypassable
by quoting the target (`rm -rf "$HOME"`). Honest yield: ~1 real win per 2-3 segments, then a plateau — a
disciplined assistant, not a perpetual-motion machine (matches the feasibility analysis). Loop bugs found
+ fixed along the way: reviewer routed through `neko run` got DENIED tools → a real `--no-tools` flag +
provider-direct reviewer; `ensureBranch` used `-B` (reset) → continue-branch; the worker self-committed
past the gate → forbidden + un-committed; a flaky session test wrote the user's real `~/.neko-core/sessions`
(2234 files) → isolated to a temp HOME.

**Provider / model UX (Z.ai + glm-5.2).** New `anthropic` provider → the Z.ai coding-plan endpoint (glm-5.2;
effort → extended-thinking budget). Per-provider keys via `key_env` + config, so a new provider is a profile,
not a code change. Fixed the 401 trap (a top-level api_key shadowed the profile's; `setApiKey`/`/login` now
save to the ACTIVE profile). `/login` = guided wizard (pick provider → paste its key); `/provider` switches
account then CHAINS into that provider's model picker (`Agent.setProvider` + `NekoConfig.adopt` — live, no
restart); `/model` swaps model within the current provider. No flags, no config editing.

**Web reading — full overhaul.** Studied clean-room (in `../neko-refs/`, source-audited before running):
Obscura (a Rust headless browser — built + tested, but it JS-errors on heavy SPAs like FB Comet, so NOT
adopted), Hermes Agent (its "60x faster / 49x cheaper" = clean markdown + skip-the-LLM-on-small-pages +
paginate), Agent-Reach (a per-platform free-backend router; installs a browser-session bridge for social
logins). Shipped:
- `web_fetch` returns deterministic **Markdown** (`htmlToMarkdown`: keeps links/headings/lists; no model
  call). Hermes size policy: small page → no model call; large page → **paginate** (`page:N`) + 5-min cache
  instead of truncating and losing content.
- Opt-in `scrape_backend: "jina"` → Jina Reader renders public SPAs → markdown (free/keyless).
- **Deterministic platform routes** in `web_fetch` (CODE, not a skill the model can ignore): YouTube →
  `yt-dlp` transcript, GitHub → `gh`, RSS/Atom → item list; each falls back to a normal fetch if the tool is
  missing. Real test: a YouTube task on gpt-oss went from 7 calls / 48-56k tokens (fumbling fake transcript
  sites) to **2 calls / 16k tokens**.
- Skills `web-reading` (efficient reads: a11y/markdown first, grab-once, no scroll-churn) + `web-reach`
  (platform routing + honest ToS/account-ban warning for logged-in social feeds). Skills gained a
  frontmatter `match:` regex so `matchSkill` loads a domain skill DETERMINISTICALLY (token-overlap was too
  coarse — web-reach was silently never loading). The doom-loop guard was generalized to nudge on N
  consecutive EMPTY/failed results from ANY tool (the FB scrape-thrash the edit/exact guards missed).
- Login platforms (FB/X/IG/LinkedIn) are deliberately NOT auto-routed — they need the user's session and
  carry ToS/ban risk, so they stay with the browser MCP + the skill's warning. Key finding: loading a skill
  ≠ the model following it (gpt-oss ignored web-reach's routing) — the reliable fix is the tool layer, not a
  skill.

Version bumped 0.4.0 → 0.5.0-dev; the branch builds + is installed locally as `neko`.

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
