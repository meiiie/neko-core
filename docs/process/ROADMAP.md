# Neko Code — Roadmap to "Claude-Code level"

> **Goal:** evolve the Neko Core engine into **Neko Code**, a terminal coding agent in the
> class of Claude Code / Codex CLI. This file is the target the work loops over; tick
> milestones as they land (each must be verified + committed).

## Current status (2026-07-06) — session handoff
Neko Code is a **working terminal coding agent** — Phases A→G below are done (agentic core, project
intelligence, MCP, single-binary, SOTA refinement, robustness + skill extensibility + Claude-Code tool
parity) — and, as of v0.7.0, a **fullscreen-first terminal UI** in the Claude-Code class.
Default model: **glm-5.2** via the Z.ai GLM coding plan (`anthropic` provider, `--profile zai`).

- **Branch:** `self-improve`. **v0.7.0 released 2026-07-06** (owner-approved push; 0.6.0 was an internal
  milestone, never published). All green: typecheck (TS 7.0.1-rc native) + 360/0 tests + policy + build
  on Windows, and the FULL verify loop natively on Linux (359/0; the one win32-gated test skipped).
- **The v0.7.0 arc (Jul 3-6) — fullscreen became THE interface:** app-owned alt-screen viewport with a
  stdout-layer FrameDiffer (line-diff + DECSTBM hardware scroll, absolute-addressed, VT-verified), ANSI
  row cache + windowed warmer, live-markdown streaming tail, ease-out glide scroll at the display's
  detected refresh rate (`/fps`), drag-to-select + copy (solid rectangle, Ctrl+C, OSC 52 + native
  clipboard), session tab titles (🐱 name, pulsing busy dot, ConPTY clobber-healing), editor-style
  blinking caret, layout-stable chrome (flexShrink pins + a reserved status row), claude-clean exit
  (no transcript dump; just the resume hint), and the `/fullscreen` toggle REMOVED — fullscreen is the
  sole mode, inline is only the automatic unfit-terminal fallback. Session-index freshness key hardened
  to mtime+size with in-place legacy migration (no `/resume` stall after upgrade).
- **Earlier this arc (Jul 2-3, released as v0.5.1):** approval dropped-'y' race fixed, release-asset
  race fixed (create-once), prompt-cache stability + measurement, 529 retry, tool-error recovery.
- **Next:** a new, owner-directed task (TBD). **Rule: never merge to `main` or push without the owner's
  explicit OK.** Orientation for a fresh session: `WORKLOG.md` (journal) · `RULES.md` (how we work) ·
  `CLAUDE.md` (codebase map) · `docs/self-improve/` (the Neko-improves-Neko loop + its idea `BACKLOG.md`).

## Naming
- **Neko Code** = the product / CLI experience (the Claude-Code analog).
- **Neko Core** = the engine/library at the heart of it (package `neko-core`, `src/`).
- The command stays `neko`. Full doc/brand rename is the last milestone (avoid churn now).

## IP / legal boundary (non-negotiable)
The local `claude-code` tree is studied **only as a reference for patterns/architecture/UX**.
We **reimplement clean (clean-room) in our own code** and **never copy Anthropic's
proprietary source** into this public repo. Learn ideas ✅, copy code ❌.

## Architecture map we're matching (clean-room, from the reference's shape + known patterns)
entrypoint (Ink TUI) · query engine (agent loop, streaming) · Tool abstraction + tool set ·
tasks/todos · context & history (persist/resume) · slash commands · permission modes ·
cost/token tracking · MCP client · single-binary distribution.

## Milestones

### Phase A — Agentic core
- [x] **A0** TS Step 1: config-first + `openai_compat` provider + doctor + CLI skeleton. *(done)*
- [x] **A1** Tools + registry + policy (read_file/search safe, write_file/bash gated; OpenAI schema). *(done — typecheck clean; `neko tools/agents/commands/capabilities/policy` work; tool runtime smoke: read/search/write/bash, path-escape refused, denial returns a string, safe-under-deny)*
- [x] **A2** Agent loop + `neko run` (complete → tool_calls → observe, `max_steps`; interactive approval + `--yolo`). *(done — typecheck clean; live `neko run --yolo` on NVIDIA called read_file and answered correctly)*
- [x] **A3** Real coding tool set: `edit` (exact unique string replace, gated), `glob` (Bun.Glob), `ls` (safe); `search` is the scoped grep. *(done — typecheck clean, policy PASS; smoke: edit unique/not-found/ambiguous, glob, ls)*
- [x] **A4** Streaming responses (SSE) + token tracking (`src/cost.ts`; per-call usage accumulated). *(done — live `neko run` streams tokens via SSE and prints `tokens: in/out/total`. $-cost left to a future per-model price config.)*

### Phase B — UX (the Ink TUI = "Neko Code")
- [x] **B1** Ink chat REPL (`src/ui/chat.tsx`): streaming render, interleaved tool-call lines, inline approval prompt (y/a/n), thinking spinner, one Agent across turns, `/reset`/`/exit`. *(typecheck clean; module imports under Bun; non-TTY guard degrades to a hint. Full interactive render pending the owner's terminal.)*
- [x] **B2** Slash commands (`/help` `/cost` `/model` `/profiles` `/init` `/clear` `/reset` `/exit`), input history (↑/↓), multiline (trailing `\` continuation). *(typecheck clean; module imports under Bun)*
- [x] **B3** Permission modes (`src/permissions.ts`): default / accept-edits / plan / auto; Shift+Tab cycles in chat; surfaced in doctor/capabilities/policy; `NEKO_MODE` override. *(verified: plan denies writes, accept-edits auto-approves edits but prompts bash, auto allows all; typecheck clean)*

### Phase C — Project intelligence
- [x] **C1** Project context (`src/context.ts`): loads `NEKO.md` / `CLAUDE.md` from cwd up to the repo root + `~/.neko-core/NEKO.md`, additive, capped; prepended to the system prompt. `neko context` lists them. *(verified: finds repo CLAUDE.md, walks up from nested dirs; typecheck clean)*
- [x] **C2** Conversation persistence (`src/session.ts`): chat saves after each turn to `~/.neko-core/sessions/` (keyed by cwd); `neko chat --resume` reloads the latest for this dir; `neko sessions` lists them. *(verified: save/load/latest/list round-trip; typecheck clean)*
- [x] **C3** MCP client (`src/mcp.ts`): connects to stdio MCP servers from config (`mcp_servers`), exposes their tools as `mcp__<server>__<tool>` (gated by permission mode), `neko mcp` lists them. Safe by default (no servers = no-op). *(verified LIVE against a local echo MCP server: connect/list/call round-trip; typecheck clean)*

### Phase D — Polish & distribution
- [x] **D1** `bun test` suite — 44 tests across config, providers, permissions, tools, runtime, registry, agent, context, session. *(all pass; typecheck clean)*
- [x] **D2** `bun build --compile` single binary (`dist/neko`, react-devtools-core bundled for Ink); re-pointed the `neko` command from the pipx(Python) install to the TS binary in `~/.local/bin`. *(verified: `which neko` → the binary; live `neko run` called a tool)*
- [x] **D3** Renamed to **Neko Code** (README + CLAUDE.md refreshed for the TS product; engine stays "Neko Core"); secret-scan + merge to `main` + push (owner-approved).

## Loop rules
- One milestone per iteration: implement → verify (typecheck + `bun test` + run) → commit → tick here + note in `WORKLOG.md`.
- Solo, no subagents. Config-first, safe-by-default, printed strings ASCII.
- Stop the loop and ask the owner when: a milestone needs a product/architecture decision,
  a live action would spend real money beyond a tiny smoke call, or anything outward-facing
  (push to public / publish) is required.

## Post-1.0 — UX/UI parity pass (clean-room vs claude-code)
- [x] **E1** Ink UX overhaul: welcome box, bordered input box, **markdown rendering** of
  assistant output (`src/ui/markdown.tsx`), `*`/indented tool-call lines, spinner + elapsed
  status, **Esc-to-interrupt** (AbortSignal through provider+agent), and a bordered approval
  box with an **edit/write diff preview**. ASCII-safe (classic borders, line spinner) for any
  Windows console. *(typecheck + 45 tests incl. headless Markdown render; binary rebuilt)*
- [x] **E4** Syntax-highlighted code blocks (`src/ui/highlight.tsx`; tokenized Ink Text segments, not raw ANSI).
- [x] **E5** Markdown tables (aligned columns) in the renderer.
- [x] **E6** Input queue while busy (type-ahead, drained after each turn) + render of non-streaming finals.

## Phase F — SOTA refinement (research-grade quality -> product) [June 2026]
> Direction (owner): lean **research-grade SOTA** (memory - planning - multi-agent, latest techniques)
> as the engine that *drives* product polish — a "tinh hoa" architecture prepared to ship for real.
> Keep the harness thin (the model does planning/decomposition); invest in prompt/skills/memory + the
> daily-use experience. Dogfood: Neko improves its own repo.

- [x] **F0** Distribution at Codex/Claude-Code grade: CI builds 5-OS standalone binaries -> GitHub
  Releases; `install.sh`/`install.ps1` one-line install; branded domain `neko.holilihu.online`
  (Cloudflare Worker -> neko-core); CI green. Default model `openai/gpt-oss-120b` after a multi-trial
  Neko-bench (pass@1 97% / pass^3 92%, vs nemotron 72%/38%). *(verified: released binary runs end-to-end)*
- [x] **F1** Bugs found via cross-model benchmarking + fixed: two `system` messages broke Llama/Mistral
  tool-calling (-> one system message); `reasoning_effort` self-heal; non-interactive approval
  fail-closed; shared `homeDir()` for Linux CI. *(committed; tests green)*
- [x] **F2** Command result-awareness (Claude-Code-style): bash marks failures `(exit N -- FAILED)` and
  the prompt mandates read-result -> on failure diagnose + fix + re-run. *(verified 3/3 self-correction)*
- [x] **F3** Navigable slash-command menu: Up/Down select, Tab completes (was: arrows rewound the
  half-typed command via history). *(regression test added)*
- [x] **F4** Remote-control stability: `startRemoteControl` now binds async + port-hops on EADDRINUSE
  (no crash), keeps a permanent error handler, returns HTTP 500 on a failing turn (no client hang),
  and the `/rc` caller awaits + reports failures. *(+2 robustness tests)*
- [x] **F5** Reviewed transcript + markdown renderers (already SOTA-aligned: tool markers, diff color,
  tables, code highlight); added the missing markdown horizontal-rule. *(deeper pixel-tuning of
  streamed output is best done live with the owner; UI tests green)*
- [x] **F6** Naturalness: dropped the literal narration example the model parroted ('Writing the
  file...'), ask for a natural note in its own words; tone steered to a senior-engineer voice (no
  preamble/postamble). *(verified: narration reads naturally while acting+verifying)*
- [x] **F7** SOTA memory/planning/multi-agent — **assessed against June-2026 research; Neko is already
  aligned**, so the SOTA-correct move was NOT to bolt on a heavy subsystem: *(a)* memory =
  agentic file-based retrieval (the research's "single biggest unlock" over vector search) — kept,
  + added Mem0-style consolidation (search-then-UPDATE, don't duplicate) to the prompt; *(b)*
  multi-agent — research found a single agent beats multi-agent on ~64% of tasks at half the cost, so
  Neko's thin single-agent-first harness (subagents via `task` only for isolation) is correct, not a
  gap; *(c)* resilience — retry/backoff + loop-guard + self-verify (F2) + closed-loop (`--loop`) already
  cover the "evaluation agent" pattern.
- [x] **F8** `neko bench` — built-in agentic-coding benchmark (`src/adapters/bench.ts`): pass@1 +
  `--trials N` (PASS/FLAKY/FAIL), deterministic verifiers. *(verified: gpt-oss-120b 8/8 at --trials 2)*

## Phase G — robustness hardening + SOTA extensibility

- [x] **G0** Serious-bug audit (found via real dogfooding — "freezes after long use"): fixed 7 robustness
  bugs, each a real freeze/OOM/crash at the edges. (1) live-stream render was O(n)/frame -> on long
  reasoning/output the event loop stalled and Esc/Ctrl+C went dead (kill-terminal); bounded to O(1)
  via `renderTail`. (2) bash ignored the abort signal -> Esc/Ctrl+C couldn't stop a running command
  (60s wait + orphan child); threaded the AbortSignal -> kill at once. (3) bash output buffered
  unbounded -> a runaway command (`yes`) OOMed; capped at 200 KB. (4) read_file slurped a whole file
  before truncating -> multi-GB OOM; now reads a bounded prefix via fd. (5) `void handle()` could
  surface an unhandled rejection -> crash; wrapped. (6) transcript `lines` bounded (trim + Static
  remount). (7) session save spawned git every turn (spawnSync, up to 2s) -> cached per cwd, which
  also **killed the recurring session-test flake**. *(full suite 146/0, no flake; each fix tested)*
- [x] **G1** SOTA skill extensibility — **progressive disclosure** (Anthropic Agent-Skills pattern):
  skill name+description injected into context (`skillsContextBlock`, ~100 tokens each) so the model
  auto-discovers capabilities, + a SAFE `skill` tool that loads the full body JIT (via an injected
  registry hook, so core never imports the skills adapter). A domain is now a pluggable skill; the
  core stays thin + general. *(verified end-to-end + unit test; policy + architecture green)*
- [x] **G2** First domain capability: bundled **`procurement`** skill (Purchasing Officer — sources VN
  platforms, compares price/trust/warranty/VAT/shipping-to-Bac-Giang, outputs a human-approved purchase
  plan; never buys autonomously). Repo `skills/` is now a bundled skill dir (lowest priority). Extension
  model documented in `docs/EXTENDING.md`. *(verified end-to-end: auto-loads the skill, sources live
  iPhone prices from CellphoneS/TGDD/FPT/Hoang Ha)* — next: browser MCP for JS-heavy sites; voice-call MCP.
- [x] **G3** Procurement, broadened to SOTA + benchmarked. *(a)* Diverse queries — the skill works
  structured-data-first (a normalized offer table where price is a number), so it handles lowest/highest
  price, sort asc/desc, filter (budget/official-only/in-stock/VAT), top-N, totals, multi-item compare.
  *(b)* **Excel export with clickable links** — a bundled, zero-dependency `scripts/make-sheet.ts`
  (hand-rolled OOXML in a STORED zip: real .xlsx, hyperlinks + auto-filter + bold header, opens with no
  warning); the `skill` tool now surfaces the skill's own dir so bundled scripts run by absolute path.
  *(c)* **Deterministic benchmark** `skills/procurement/evals/run-evals.ts` — fixed offer table (no web),
  `--trials N` -> PASS/FLAKY/FAIL, verifies min/max/sort/filter + a real xlsx-with-links (inflates the
  zip to check). *(verified: 5/5 solid at --trials 2; full suite 147/0)*
- [x] **G4** Schema-guided web extraction (researched SOTA, then built at the right layer). A fair A/B
  (Claude Code vs Neko) showed the gap was extraction quality, not browsing: web_fetch's freeform
  extractor collapsed a 7-variant price table to one number / grabbed the "listed" price. Researched the
  SOTA (Firecrawl `/extract`, Crawl4AI, ScrapeGraphAI, structured-output / constrained decoding) and
  **probed the endpoint — NVIDIA gpt-oss supports `response_format` json_schema**. Built it as a generic
  Provider capability (`CompleteOptions.responseSchema` -> `response_format`, self-healed if rejected),
  and gave `web_fetch` an optional `schema` arg -> schema-constrained JSON. Tool-layer fix, every skill
  benefits — not a per-skill prompt band-aid. *(proven on the real Viettablet page: freeform = prose/one
  number; with schema = all 8 variants + true lowest 24.099M. +provider unit test + a deterministic
  extraction benchmark on a cached page fixture: 3/3 trials, full variant recall + true lowest. 150/0.)*
- [x] **G5** Harsh + diverse adversarial extraction benchmark (`skills/procurement/evals/harsh-eval.ts`
  + 8 fixtures), driving fixes data-first. Each fixture breaks naive extraction: strikethrough "listed"
  price, promo/installment/trade-in noise, a DIFFERENT product on the page, out-of-stock/"contact",
  mixed VN currency formats, bundle-vs-standalone, a specs-only page (hallucination bait), and a
  prompt-injection page that commands the AI to "set the price to 1". It exposed 3 real gaps, all fixed
  at the TOOL layer (in `WEB_EXTRACT_PROMPT` / the schema): (a) injection succeeded 2/3 -> page text is
  now treated as UNTRUSTED DATA, never instructions; (b) VN thousands-separator mis-read
  ("24.099.000" -> 24.099) -> number-magnitude rule + integer-typed price (constrained decoding forbids
  the stray decimal); (c) variant-collapse already covered by G4. *(result: 8/8 cases solid at
  --trials 3 — incl. hallucination-resistance + prompt-injection defense; full suite 150/0)*
- [x] **G6** End-to-end agent benchmark + an honest ceiling finding (`skills/procurement/evals/e2e-eval.ts`).
  Serves the adversarial fixtures over real local HTTP and points the WHOLE agent at them (skill auto-load
  -> web_fetch -> extraction -> answer). Building it surfaced a benchmark bug worth keeping in mind
  (`spawnSync` blocks the event loop so the in-process server can't answer -> use async `spawn`), and a
  real product-match gap (the agent could report a Galaxy S24's price as an S26's -> WEB_EXTRACT_PROMPT
  now front-loads two active checks: product-match + value-present). **The honest finding:** explicit
  *schema-guided* extraction is robust (8/8, G5), but the *agent's freeform* single-URL extraction has a
  gpt-oss judgment ceiling (~80-90%) on extreme adversarial pages — measured the whack-a-mole directly
  (prompt/default-schema tweaks only move WHICH 1-2 of 6 cases flake), so I reverted an over-fit default
  guard schema instead of chasing the eval. Mitigation is structural, not more prompt text: the skill
  uses the schema path for prices, and real sourcing surveys several sources (diluting a single trap).
  Documented in `evals/README`. *(4-layer suite: run-evals 5/5 · extract 2/2 · harsh 8/8 · e2e ~4-5/6)*
- [x] **G7** Browser MCP for JS-gated sites (the static-fetch frontier from G6) — researched the SOTA
  (browser-use 89.1% WebVoyager + runs as a stdio MCP server; Microsoft's Playwright MCP as a pure tool
  layer; Stagehand; Skyvern vision; DOM-driven beats vision by 12-17pp) and **verified the integration
  end-to-end** — no Neko code, just config (config-first). Neko's MCP client connected to `@playwright/mcp`
  and exposed 23 browser tools (`mcp__playwright__browser_navigate/snapshot/click/...`). Proof on a page
  whose price is injected by JS: `web_fetch` (static, scripts stripped) saw only "loading...", while the
  agent via `browser_navigate` -> `browser_snapshot` read the rendered DOM and reported the real price -
  exactly the Shopee/Tiki gap. Chose **Playwright MCP** (pure hands, Neko stays the brain) over the more
  autonomous browser-use. Wired into the procurement skill (browser for dynamic sites, web_fetch+schema
  for static). *(honest caveat: browser solves JS rendering, not anti-bot/captcha on big marketplaces)*
- [x] **G8** Workflow memory — procedural memory (AWM-style), the frontier technique chosen over rebuilding
  browser-use. Researched the June-2026 frontier (Agent Workflow Memory, Agentic Plan Caching, Agentic
  Context Engineering, self-improving-agent surveys) and picked the one that generalizes across every
  domain + fits Neko's architecture. Where `memory` stores FACTS and `skills` are AUTHORED expertise, the
  new `workflow` tool stores reusable PROCEDURES the agent LEARNED by doing (`~/.neko-core/workflows/*.md`,
  file-based, core layer — mirrors `memory.ts`). A workflow index is injected each turn (progressive
  disclosure) and `matchWorkflow` deterministically recalls a strongly-matching procedure before a similar
  task (mirrors the skill auto-loader); the prompt tells the agent to write one after a non-trivial success.
  **Verified the full self-improving loop end-to-end:** the agent calls `workflow write` to save a learned
  procedure, and a matching later task auto-recalls + follows it. The third memory leg: facts + authored
  skills + learned workflows -> the agent gets faster and more reliable over time. *(+unit tests; policy +
  architecture green; full suite 153/0)*
- [x] **G9** ACE — Agentic Context Engineering (arXiv 2510.04618), clean-room. The fourth self-improving
  primitive: a `playbook` of operating strategies/lessons that is ALWAYS in context (vs JIT memory/
  workflows) and refined by incremental DELTA updates (`playbook add`/`revise` one bullet) + grow-and-
  refine de-dup — never rewritten into a vague summary (the "context collapse" ACE is built to avoid).
  `core/playbook.ts` (mirrors `memory.ts`), a `playbook` tool, an always-on context block, and a Reflector
  prompt (after a non-obvious/failed step, add or sharpen a lesson). **Value benchmark proves the
  learn->persist->reuse loop with an UNGUESSABLE rule** (`test/ace-value-eval.ts`): BASELINE (empty
  playbook) 0/3 -> the agent learns the rule in task 1 -> REUSE (learned playbook, always-on) 3/3 on a
  NEW price. *(benchmark-integrity fix along the way: both value benchmarks now run the agent in a sandbox
  cwd after it was caught reading the benchmark's own source to cheat. full suite 156/0)*
- [x] **G10** Stealth browser for anti-bot sites (the G7 frontier). Researched the SOTA stealth stacks
  (patchright, puppeteer-extra-stealth, nodriver, dedicated stealth MCP servers) and found the cleanest
  fit is **config-only, no third-party package**: `@playwright/mcp --device "Desktop Chrome"`. Measured on
  a local detector: vanilla headless leaked `headlessUA=true` (a bot signal); with `--device` both
  `navigator.webdriver` AND the headless User-Agent read **false** — basic fingerprints masked via config
  alone, true to Neko's config-first principle. Most-undetectable option documented too: `--cdp-endpoint`
  to the user's real logged-in Chrome. *(honest caveat: this masks common UA/webdriver checks; Cloudflare
  + captcha on big marketplaces is an arms race that can still need a human — and the cheapest prices are
  usually at static official retailers that don't need a browser at all. Wired into the procurement skill.)*
- [x] **G11** Remote control, made professional + cross-device (studied Claude Code Remote Control + Codex
  cloud clean-room). **(a) `/rc` v2** — the local HTTP control API grew a professional surface: SSE
  streaming (`Accept: text/event-stream` streams token deltas + a `done` event with `{reply,tokens,ms}`),
  `GET /status`, `POST /interrupt`, `Authorization: Bearer` only (the old `?token=` leaked into logs ->
  rejected 401) with constant-time compare, a 1 MB body cap (413), turns serialized (409, no overlapping
  runs on one session), and a discovery file (`~/.neko-core/remote.json`). Optional `remote_bind` to reach
  it from another device over a trusted private mesh (Tailscale), with a loud off-loopback warning.
  **(b) `/relay`** — the professional cross-device pattern (how Claude Code Remote Control works): the
  local agent **dials OUT** to a relay you host and long-polls for instructions, so it never opens a
  listening port and works behind any NAT/firewall with zero per-device setup (a phone browser is enough,
  no Tailscale). Ships a self-hosted Cloudflare Worker (Durable-Object rendezvous) + a mobile web client +
  deploy guide under `cloudflare/relay/`. Because the relay is YOURS, it's already more private than a
  vendor cloud. **(c) E2E — the beyond-vendor piece:** `/relay` derives an AES-256-GCM key from a pairing
  secret (carried in the URL `#fragment`, never sent to the relay); host (`relay-crypto.ts`) and phone
  client (WebCrypto) seal/open at the edges, so the Worker forwards **only ciphertext** — a true
  zero-knowledge blind forwarder, MORE private than Claude Code's relay (where the platform reads
  plaintext). *(proven: node<->browser interop + tamper/wrong-secret rejection; the relay-sees-only-
  ciphertext property as a unit test AND end-to-end with a real agent — relay saw only `{iv,ct}`, phone
  decrypted "30". full suite 168/0.)*
- [x] **G12** Tool-use parity with Claude Code (atomic-level audit of agent.ts/tool-runtime.ts/mcp.ts).
  Verdict: the orchestration (loop, read-only parallel fan-out, loop-guard, abort, compact, hooks,
  permissions, adversarial check) and MCP (stdio/http/sse + OAuth + resources + prompts + reconnect)
  were already at par; the gaps were five leaf-tool capabilities, now all closed. **(a) search** uses
  ripgrep when installed (fast on big trees, honors .gitignore), falling back to the built-in walk; both
  gained `glob` / `case_insensitive` / `context`. **(b) bash** gained a per-call `timeout` (default 60s,
  clamped [1s,10min]) and `run_in_background` so the MODEL can launch servers/watchers (not only the
  human via Ctrl+B). **(c) read_file** gained `offset`/`limit` paging. **(d) read_file media**: images ->
  vision content (caption + data URL) under a config `vision` flag (off by default so text models never
  receive image tool content), with dimensions parsed from PNG/GIF/JPEG headers; PDFs -> text via
  pdftotext when present (useful even for text models), clear degradation otherwise. **(e) MCP lazy
  loading**: auto when >30 connected tools (or `mcp_lazy` in config), the context lists tool names only +
  an `mcp_load` meta-tool pulls schemas on demand -- no flooding context with dozens of unused schemas.
  *(+13 tests incl. a real stdio MCP fixture server for lazy loading; tool-runtime 39/0, policy +
  architecture PASS, full suite green.)*

## Phase H — real-terminal UX/UI polish (July 2026)
- [x] **H1** Dogfood-driven polish to Claude-Code quality on a real terminal (full list in the "Current
  status" block above + WORKLOG): **rendering** — Vietnamese word-wrap (no mid-word breaks), LaTeX→Unicode
  math, bordered width-aware tables + emoji-aware column widths, keycap-emoji normalize, markdown rhythm +
  a left/right gutter, `---` declutter, readable `Xm YYs` elapsed; **behaviour** — streaming no longer jumps
  to the top (progressive commit), idle (not total) request timeout so long generations finish, Ctrl+O
  expand/collapse toggle, blue in-flight tool dot, a no-emoji output rule in the system prompt; **platform**
  — the Windows `bash` tool runs real Git-Bash instead of cmd.exe.
- [~] **H2** Fullscreen / alt-screen scroll mode — **tried, then REVERTED.** Stock Ink has no real scroll
  region (`overflow:hidden` samples rows, doesn't clip); Claude Code only gets it smooth via a *patched* Ink
  renderer + custom ScrollBox. Forking Ink is disproportionate (weeks, risky, threatens the single binary),
  and the earlier progressive-commit fix already removed the reported jump — so the polished **inline** mode
  stays the single experience. (Lesson recorded in WORKLOG: don't chase a Claude-Code feature that depends on
  their forked Ink.)
