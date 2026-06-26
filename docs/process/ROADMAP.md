# Neko Code — Roadmap to "Claude-Code level"

> **Goal:** evolve the Neko Core engine into **Neko Code**, a terminal coding agent in the
> class of Claude Code / Codex CLI. This file is the target the work loops over; tick
> milestones as they land (each must be verified + committed).

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
