# Neko Core — Work Log

Running journal of what was done and the decisions behind it. Newest entry first.
Rules that govern this work live in `RULES.md`.

## 2026-07-03 — Cross-model verification + local-perf profile (owner question: "other models? CPU/GPU/RAM?")

**Cross-model:** harsh-eval re-run on gpt-oss/NVIDIA (the OpenAI wire format, `response_format`
constrained decoding) = **8/8 solid** — schema extraction is now green on BOTH provider families
(anthropic-format via forced tool call on glm-5.2, openai-format via response_format on gpt-oss), each
with its own self-heal. Cache metrics likewise normalized across 3 usage shapes; the stable prefix
benefits every implicit-caching endpoint by construction.

**Local perf profile (measured, not asserted):** binary 112.7MB; startup 0.5-1.0s; live-run tree 513MB
RAM with CPU <15% of one core (I/O-bound as designed; GPU unused by design — the model is remote, local
inference is a config choice where our stable-prefix work speeds server-side APC). The one real local
finding: **~277MB of that RAM is the browser-MCP server spawned even when a run never touches a browser
tool** — mcp_lazy removed the token tax, the process tax remains. Queued as the top local-perf BACKLOG
item (MCP lazy-CONNECT), alongside the orphan-hygiene fix. The G0-era hot-path fixes (O(1) render,
bounded buffers, fd-prefix reads, cached git status) remain the load-bearing local optimizations.

## 2026-07-03 — Speed sprint + full no-regression battery (two big finds)

**Speed sprint (owner-directed), all shipped:** (1) deterministic **websosanh offers parser** in web_fetch
(904eafc) — the procurement INDEX tier is now CODE-parsed: 32/32 offers from the live page, zero LLM
tokens, can't misread a price, graceful fallback on redesign; (2) **parallel-width nudge** (d8822d4, W&D
arXiv 2602.07359) — batch independent reads in one turn (the fan-out machinery existed; the prompt now
tells the model to use it); (3) skill: **one survey answers min+max+median** + reuse baogia_norm.json for
follow-ups + SKU-querying the index (c372258). Combined-question errand now runs at 8-9 calls vs 30 for
the ask-twice pattern. (4) Effort A/B (max vs medium, same errand): medium was NOT faster (471s vs 342s,
n=1, provider-latency dominated) — default effort kept; wall-clock levers are call count + cache, not the
thinking budget. Honest record.

**Benchmark battery (owner mandate: prove no "improved but worse").** Suite green at every step; two REAL
finds, both invisible without the battery:
- **`neko bench` 16/16, calls 64->59, and the first true cache picture: 94% of input tokens were cache
  READS on Z.ai** (256.5k in, 240.4k cached) — the prefix-cache + rolling-breakpoints work measurably
  engages in real agent loops (the earlier isolated 2-call probe showing 0 was not representative), and
  the old "in tokens" numbers were UNDERCOUNTS (Anthropic input_tokens excludes cache reads; the old
  adapter never added them back).
- **harsh-eval collapsed 0/8 on glm-5.2 -> exposed that `responseSchema` was never implemented on the
  anthropic provider** (G4 built it for openai_compat only; the model switch silently degraded ALL schema
  extraction to free text). Fixed with the format's standard structured-output pattern: forced tool call
  (schema = input_schema, thinking skipped - incompatible + unneeded), self-heal to prompt-JSON +
  extractJsonLoose. 0/8 -> **8/8 solid**.
- run-evals 4/6 -> **6/6 solid** after fixing the MEASUREMENT layer (grade the final answer, not tool
  echoes; negative checks on kept rows only; accept legitimate source aliases; clarify the trade-in
  credit-vs-program rule per G5 intent; print the failing output tail). The A/B against the pre-sprint
  skill proved these were pre-existing false alarms + model drift, NOT today's regressions.
- Final suite 267/0 after killing 28 ORPHANED MCP server processes (eval spawnSync timeouts kill neko but
  orphan its stdio children -> machine saturation -> the queue-test flake). Hygiene item queued in BACKLOG.

## 2026-07-03 — Procurement recall gap fixed: INDEX (websosanh) -> VERIFY architecture (A/B live-proven)

Owner caught a REAL wrong answer: asked "SSD 990 EVO 2TB MZ-V9E2T0BW, GIA DAT NHAT o VN" — Neko said 9.99tr
(HACOM) while ChatGPT+search found laptopworld.vn at ~14tr. Root causes, in impact order: (1) the skill had
no INDEX tier — websosanh.vn was one passive search suggestion, so coverage = whatever search returned
(7 shops); (2) SearXNG was down (Docker Desktop off) -> DuckDuckGo fallback with measurably weaker recall;
(3) the source MAP had no PC-components category (laptopworld/An Phat/Mai Hoang/Nguyen Cong PC missing).

Fix at the SKILL layer (zero core change — domain = pluggable skill): a mandatory **two-stage
INDEX -> VERIFY** section in `skills/procurement/SKILL.md`. INDEX: every price survey STARTS with
`websosanh.vn/s/<query>.htm` (probed: server-rendered, one web_fetch = ~600 offers spanning 360k->14tr+;
`?sort=` params do nothing, so harvest ALL offers verbatim and let `price-table.ts` sort — LLM extracts,
code computes). VERIFY: by query type — "dat nhat" verifies the top 3-5 on the merchant page (product-match
+ live price + stock), "re nhat" the bottom 3-5 (junk lives there: 359k/880k index rows were accessories/
wrong SKU), "gia thi truong" = median after dropping wrong-SKU rows. GAP-FILL: MAP + search (+ a new
PC-components MAP section). Also restarted Docker -> `neko-searxng` auto-revived (restart=unless-stopped),
doctor shows `web_search: searxng` again.

**A/B proof (same errand, same day):** OLD strategy -> 7 sources, max 9.99tr (WRONG), 75k tok / 13 calls.
NEW strategy, run in DEGRADED mode (DDG — searxng came up mid-run): found laptopworld VIA the index,
verified live on the merchant page -> **12,990,000d in stock = correct answer**, dropped 5 ghost index rows
(404s) + stale prices (websosanh's 14.289tr for laptopworld was an OLD price — likely the very number
ChatGPT reported unverified), and flagged that market band is really 3.95-5.2tr. Cost: **50k tok / 12 calls
— cheaper AND correct** (the index replaces blind per-shop fetches). Also gitignored the
`skills/procurement/baogia*.json` artifacts dogfood runs drop in the repo.

## 2026-07-03 — Researched Browser Use CLI 3.0 / browser-harness (clean-room, live-verified)

Owner asked whether Browser Use CLI 3.0 changes our browser story (G7 chose Playwright MCP; G10 stealth via
config). Cloned both repos to `../neko-refs/` and read the core. **Findings:** CLI 3.0 is their autonomous
agent product; the reusable piece is **browser-harness** — a ~1.4k-line Python CLI (helpers 508 + daemon 427
+ ipc 201) speaking **raw CDP to a running Chrome**, invoked via bash heredocs (`browser-harness <<'PY' ...`).
Architecture is the "bitter lesson" applied to browser tools: NO tool schemas, NO accessibility-tree dumps —
a small pre-imported helper API (page_info/click_at_xy/js/cdp/screenshot/tabs/waits), screenshot-first +
coordinate clicks that pass through iframes/shadow-DOM at the compositor level, `js()` for text-only
extraction, and **self-healing**: the agent writes missing helpers into `agent_helpers.py` and uses them
immediately. Ships AS a skill (SKILL.md) — exactly Neko's G1 extension model. Windows is first-class (TCP
loopback + token IPC). **Live-verified end-to-end on this machine:** `uv tool install browser-harness` ->
launched a throwaway Chrome with `--remote-debugging-port` + temp profile -> `BU_CDP_URL=... browser-harness`
drove it (new_tab, wait_for_load, page_info, js('h1.textContent')) — worked first try; cleaned up after.
**Verdict (revised after owner pushback — the right call):** **HOLD, don't adopt now (YAGNI).** Neko's
existing stack already covers the real workloads — proven by dogfooding (attached to the owner's Chrome,
read their X feed, summarized the first 100 posts; procurement sources live VN retail sites): layer 1
`web_fetch` + schema extraction + deterministic routes, layer 2 Playwright MCP against real Chrome
(config-only), layer 3 skills routing (web-reach). A second browser stack = a new Python daemon dependency
+ split maintenance for capabilities we already have. **Adoption triggers recorded** (revisit browser-harness
only when one actually fires): (a) a real site where a11y-snapshot refs break (cross-origin iframes /
shadow-DOM) and coordinates would win; (b) measured snapshot/token costs that mcp_lazy + the queued BACKLOG
compaction items (TACO, stale-read elision) can't cover; (c) needing agent-authored browser helpers beyond
what workflows/skills give. The refs clone + this analysis stay for that day.
**The measured, already-shipped fix instead:** the owner's config runs the 23-tool browser MCP below the
lazy threshold (30), so its schemas cost **~3,991 tokens EVERY LLM call**; `mcp_lazy: true` (built in G12)
drops that to ~634 (meta-tool + name index) — **~3,357 tokens/call saved**, ~100-170k on a long browse
session — one config line, no code. **Applied 2026-07-03** (owner-approved): `"mcp_lazy": true` in
`~/.neko-core/config.json` (backup: `config.json.bak-mcp-lazy`); verified via the chat wiring path —
`hub.lazy=true`, wire schemas 15,962 -> 486 chars + a 2,048-char name index, `mcp_load` exposed.

## 2026-07-02 — Tool-error recovery directive at the point of failure (29e7c95)

Sprint item 2 (Self-Harness, arXiv 2606.09498 — its single biggest win was a recovery-oriented prompt
injected WHEN a tool errors; +16pp Terminal-Bench-2 on a mid-size model). Neko's static F2 rule ("read the
result, diagnose, fix") fades under attention decay on long runs; the fix lands the directive NEXT TO the
error. On the FIRST failure of a mutating tool (bash/write_file/edit/multi_edit — read misses are benign
exploration), the loop appends a `[recovery]` observation: DIAGNOSE the actual state -> REPAIR the root
cause / recreate the artifact -> VALIDATE by re-running the failed check. Edge-triggered (a mutating
success re-arms; a second consecutive failure stays silent — persistence is the unproductive-streak
guard's job), and appended as a tool message so the prompt prefix stays cacheable. +2 unit tests (fires
once + re-arms; silent on read misses). Suite 261/0.

**Sprint status / next-up:** the remaining reliability items (pre-flight arg validation - Gecko;
pre-completion verify gate) are both opt-in and lower-leverage; deliberately deferred to a fresh session
rather than shipped tired. The queue lives in `docs/self-improve/BACKLOG.md`.

## 2026-07-02 — Prompt-prefix cache: stable prefix + explicit breakpoints + measured (7fa916d)

The sprint's highest-leverage BACKLOG item, done research-first (Anthropic prompt-caching docs; Manus
"Context Engineering for AI Agents" — KV-cache hit rate as THE production metric, stable prefix, no
timestamps, append-only; *Don't Break the Cache*, arXiv 2601.06007 — 41-80% agent-cost cut, dynamic
content at the END; Z.ai context-caching docs — implicit caching, `cache_read_input_tokens` in usage).
Neko's cache-hostility, fixed at each layer it owns:

- **The head of every request churned per turn.** `environmentBlock()` recomputed a `git status`
  dirty-count (flips on every edit) + the date INSIDE the system message, and `dynamicContext` re-injected
  the todo list (changes on every `todo_write`) — so the provider's prompt-prefix cache died for the whole
  conversation, every turn. Now: the env block is a **session-start snapshot** (memoized per
  cwd+model+provider, labeled so the model runs `git status` itself for live state — also kills 1-2 git
  spawns per turn), and todos are OUT of the system message (the `todo_write` result already recites the
  plan into the message stream — the Manus recitation pattern, append-only and cache-friendly).
- **The anthropic provider sent no cache breakpoints** (Anthropic-format caching is explicit — without
  `cache_control` nothing caches at all on a real Anthropic endpoint). Now: a breakpoint at the end of the
  system prompt (one entry covers tools + system per the tools→system→messages hierarchy) + a **rolling**
  breakpoint on the last message block (the API's 20-block lookback re-reads the previous step's prefix, so
  a 40-step turn pays each step's tail, not the whole history). ON by default; `prompt_cache: false` opts
  out; endpoints that reject `cache_control` are self-healed (strip + one retry — the reasoning_effort
  pattern). Unit-tested: add/strip round-trip + a fetch-mock heal test.
- **Measurement first**: `Usage`/`CostTracker`/bench now carry `cached_tokens` (Anthropic
  `cache_read/creation_input_tokens` folded back into prompt_tokens — Anthropic's `input_tokens` EXCLUDES
  them; OpenAI `prompt_tokens_details.cached_tokens` normalized). `/cost`, the bench summary, and
  `bench-log.jsonl` report the hit rate, so the self-improve loop can DIFF it.

**Honest live verdict (probed, not assumed):** Z.ai's coding-plan anthropic endpoint ACCEPTS
`cache_control` (HTTP 200, with or without the old beta header) and returns `cache_read_input_tokens` —
but attributes **0 reads** even on byte-identical back-to-back calls (call-2 latency halved, 3212→1300ms,
so infra-level reuse likely exists without usage attribution). So the falsifiable prediction "cached>0 on
Z.ai turn 2" is NOT MET on Z.ai today; the breakpoints stand on the documented Anthropic/Bedrock 90% read
discount + the verified self-heal, and the stable prefix benefits every implicit-caching provider (OpenAI,
DeepSeek, vLLM). 260/0 tests; typecheck + policy + build green.

## 2026-07-02 — Post-release hardening: the dropped-'y' approval race + the release-asset race

The v0.5.0 post-release check found BOTH pipelines red, each hiding a real bug:

- **CI red — the two approval UI tests were NOT "flaky under load"; they were a real race, deterministic on
  slow machines.** Root-caused end to end: the approval y/a/n handler lived in its own
  `useInput({ isActive: approval !== null })` hook. Ink paints the frame at React *commit*, but a toggled
  hook's listener only attaches in a later *passive effect* — so a 'y' typed the instant the box appears
  falls in that gap and is silently dropped; the box hangs forever. Proof chain: `git bisect` (first bad =
  492e010, the `<Static>` width-cap, which widened the commit-to-effect window past the tests' 20ms poll);
  a probe that passed with +300ms before 'y'; instrumenting ink's `use-input.js` showed the subscribe
  landing after the keypress (and the console.error itself un-raced it — a Heisenbug). Fix at the right
  layer: approval keys move into the ALWAYS-mounted global hotkey hook (subscribed from app mount; ink 7's
  `useEffectEvent` invokes the latest render's closure, so it sees `approval` the moment the box shows) and
  the toggling hook is deleted. TextInput is unmounted during an approval, so no double-handling. The two
  tests went from ~13s (full poll budget burned) to instant; 5x reruns green; full suite 253/0. Lesson
  recorded: an `isActive`-toggled `useInput` can never catch a keypress that races its own activation —
  handle state-gated keys in an always-on hook instead.
- **Release incomplete — v0.5.0 shipped missing `neko-linux-arm64`.** Every matrix job ran
  softprops/action-gh-release; two jobs racing on the fresh tag each created a release, the duplicate was
  discarded, and its upload 404'd. Healed the live release by re-running the failed job (5/5 assets now
  up), then fixed the workflow: a tiny first job creates the release ONCE via `gh release create`
  (idempotent for re-runs), and the build matrix `needs:` it and only does `gh release upload --clobber`.
  No third-party release action left.

Also noted for the next backlog pass: the "broad doom-loop detection" BACKLOG item is already implemented
and tested (the BROAD loop guard tests in `test/agent.test.ts`) — the checkbox is stale.

## 2026-07-02 — Fullscreen scroll mode: attempted, then REVERTED (a lesson)

Tried the fullscreen/alt-screen scroll mode (scroll up while a reply streams + jump-to-bottom, like Claude
Code) on a display-row model (`richwrap.tsx` + `fullscreen.tsx`, a `/fullscreen` toggle). It **worked and
unit-tested green**, but dogfooding on a real terminal showed the micro-interactions were **not good enough**
(alt-screen full-frame flicker, page-jump not smooth, no mouse-wheel, broken selection, transcript vanishes on
exit). Root cause is structural, not a fixable bug: **stock Ink has no real scroll region** (verified —
`overflow:hidden` samples rows instead of clipping), so the whole thing fought the framework. Claude Code only
gets it smooth by **patching Ink's renderer + a custom ScrollBox** (DECSTBM scroll region, negative-y clamp) —
and even THEY keep fullscreen opt-in / internal-default for the public (`isFullscreenEnvEnabled` = env var or
`USER_TYPE==='ant'`, auto-off under tmux -CC). Reaching that quality means forking Ink: weeks, risky, and it
threatens the single-binary build — disproportionate to a nice-to-have already ~90% covered by the earlier
progressive-commit fix (which removed the reported top-jump). Per our own rule ("no patchwork; do it right or
don't ship it"), **reverted the whole feature** (`richwrap.tsx`, `fullscreen.tsx`, the `chat.tsx` mode, the
`/fullscreen` command) and kept the polished **inline** mode as the single experience. Lesson: don't chase a
Claude-Code feature that depends on their forked Ink — verify the framework can do it *well* before building.

## 2026-07-02 — Streaming scroll-jump, declutter, emoji alignment

More screenshot feedback:
- **Streaming "keeps jumping to the top".** The terminal auto-follows output, so a live (non-`<Static>`) region
  taller than the viewport forces a redraw-from-top every frame. Fix: **progressive commit** — once the buffered
  reply outgrows the viewport, `maybePump` moves its completed paragraphs (up to the last blank line) into
  `<Static>` (natural scrollback, no jump) and keeps only the current paragraph live; also hide the stale
  thinking trace once the answer streams (frees ~6 rows). (The full Claude-Code behavior — scroll UP while it
  streams + a "jump to bottom / N new messages" pill — needs the alternate-screen / managed-scroll-region
  architecture; that's a larger change to raise separately, but this removes the reported top-jump.)
- **`---` clutter.** A markdown rule rendered as a full-width `─` line, which read as noise; now it's just
  spacing (the model is already told not to draw rules).
- **Emoji misalignment.** Table widths counted code points, so an emoji cell (width 2) knocked the borders out
  of line; switched `plainLen` to `string-width` (display width). Keycap emojis (`1️⃣`) that render as a box+digit
  are normalized to `1.`, and the emoji variation selector is stripped.

## 2026-07-02 — Word-wrap regression fix + LaTeX->Unicode math

Two issues from a screenshot (Vietnamese text breaking mid-word + raw LaTeX):
- **Wrap breaking words / losing the gutter indent.** Root cause (found by A/B + width probes, not guessed):
  markdown paragraphs are a bare `<Text>` with no width, and Ink's `<Static>` renders items at the FULL
  terminal width — so with the left gutter a long line wrapped at full width, got shifted right by the padding,
  overflowed the real terminal edge, and the TERMINAL hard-wrapped it mid-character (dumping the tail at column
  0). Vietnamese exposed it because the lines were long. Fix: give the markdown column an explicit
  `width={maxWidth}` and width-cap every `<Static>` item to `contentCols`, so text wraps at OUR inset width at
  word boundaries and never reaches the terminal edge. (The gutter itself was fine; this was a `<Static>`
  width-propagation gap.)
- **LaTeX math.** A terminal can't render `$...$`/`$$...$$`, so formulas showed raw. Built `mathToUnicode` —
  extensible mapping tables (Greek, operators, super/subscripts) + `\frac`/`\sqrt`/`\text` handling with the
  right ordering so nested `\frac{...\sqrt{...}...}{...}` works (quadratic formula → `(-b ± √(b²-4ac))/(2a)`).
  Wired to display math (own-line `$$`/`\[`) and inline `$...$` (guarded so `$5 to $10` prices are left alone),
  plus a system-prompt nudge toward plain Unicode math. This is a real, extend-by-adding-a-symbol feature, not a
  patch — matches the "SOTA + infinitely extensible" bar.

## 2026-07-02 — Terminal-clean output (no emoji / real rules / readable elapsed)

Screenshot review surfaced three presentation issues; studied Claude Code's own prompts to fix them right:
- **Emojis misaligning** (the model emitted `1️⃣`/`🎯`/`🔑`; keycap emojis render as a box+digit on the Windows
  terminal and throw off column widths). Root fix is a formatting instruction, not a render hack: Claude Code's
  system prompt says *"MUST avoid using emojis"* + *"Only use emojis if the user explicitly requests it"* and
  frames output as GitHub-flavored markdown in a monospace font. Added the equivalent **`## Output`** section to
  Neko's `DEFAULT_SYSTEM_PROMPT` (markdown-for-monospace, no emojis unless asked, no hand-drawn ASCII rules).
  So it's a baseline rule, not a per-domain skill — the user's instinct ("do we need a presentation skill?") was
  close, but this belongs in the always-on system prompt.
- **`-----` ASCII rules** looked like noise → a markdown `---` now renders as a clean full-width box-drawing
  line (`─`), not a partial run of hyphens.
- **`194s` elapsed** → `fmtElapsed` shows raw seconds under a minute, then `1m 00s … 3m 14s` (zero-padded) so a
  long turn's timer reads cleanly. Unit-tested.

## 2026-07-02 — Horizontal gutter; live-verified the idle-timeout fix

Confirmed the idle-timeout fix end to end: a `neko run` on glm-5.2 asked for a professional 3-file landing
page — the exact task that previously died with "The operation timed out" — and it **completed** (index.html
432 lines, styles.css 386, script.js 156; 34.5k tokens / 16 calls; exit 0; the agent even opened the page in
a browser to screenshot it). The idle timeout held across a multi-minute generation.

**Horizontal gutter** (Claude Code uses `paddingLeft={2}` on its REPL container): Neko's UI ran flush against
column 0. Added `paddingLeft/paddingRight` to the root Box — verified empirically that Ink's `<Static>`
inherits a parent Box's padding, so one wrapper indents both the committed transcript and the live region.
Width-sensitive rendering switched to `contentCols` (= `cols - gutter*2`) so tables/dividers/the stream clamp
fit the inset width. Also hardened the async-tool UI tests (bash/plan approval) to poll-until-condition instead
of a fixed tick — git-bash's heavier spawn makes a fixed wait flaky. (Note: those two tests can still flake when
the machine is badly saturated — e.g. right after a live browser-driving run leaves orphaned node processes —
but pass in isolation and on a healthy machine; the gutter was ruled out as the cause via an A/B run.)

## 2026-07-01 — Idle timeout (mid-stream abort fix), todo de-dup

A real functional bug surfaced by dogfooding (a "make me a landing page" run failed with **"The operation
timed out"**): the provider request timeout was a **TOTAL** cap — `AbortSignal.timeout(timeout_seconds*1000)`
attached to the whole `fetch`, which keeps aborting the *body stream* too. So a long-but-healthy generation
(3 files, glm-5.2 with thinking) crossed the 120s cap and was killed mid-stream. Switched both providers
(`anthropic.ts` — the Z.ai/GLM path the user runs — and `providers.ts`) to an **idle timeout**: a manual
`AbortController` + a timer that `bumpIdle()` resets on every `reader.read()` chunk (threaded through
`parseStream`/`sseEvents`). A healthy stream never times out; only a genuine stall (no bytes for
`timeout_seconds`) aborts. This is the standard SDK pattern (Claude Code / OpenAI SDK use idle, not total,
timeouts for streaming). Unit-tested with a slow-but-active stream (gaps < budget, total > budget → finishes).
Also de-duped the todo view: the sticky live tracker renders only while a turn runs; when idle the committed
"Update Todos" tool result is the single record (it was showing the plan twice).

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
- **Rhythm:** breathing room above headings + around tables (vertical rhythm, not cramped text). The real
  cramping culprit: Ink collapses an empty `<Text>` to height 0, so blank markdown lines between paragraphs
  were vanishing — now blank lines render as real rows (runs collapse to one) for even paragraph spacing.
- **Turn separation** (studied Claude Code's own source at `../test/claude_lo/claude-code`, clean-room — its
  `UserPromptMessage` uses `marginTop={1}` and `MessageRow` sets `addMargin` per row): Neko's transcript lines
  (user / tool_call / info) had no margin, so a prompt glued to the previous turn's completion line and to the
  tool call below it. Gave the user line + each tool_call line a blank line above — prompts now stand clear and
  each tool call groups with its result.
- **List blocks + streaming scroll-jump + footer + run dot** (round 2, from more screenshots + the Claude Code
  source):
  - **List separation:** a `**Label**` line followed by bullets was glued to them. A run of list items is now
    one block (blank around the run, tight between items), so section labels stand clear.
  - **Streaming "scroll jumps to the top":** the live preview rendered `renderTail(stream, 4000 chars)` — up to
    ~60 lines, taller than the viewport, so Ink couldn't update in place and redrew from the top every frame.
    Fixed by clamping the preview to the terminal height (`clampToRows`, wrap-aware, tracks `rows`) and rendering
    it in a new `compact` Markdown mode (no added blank-line rhythm → predictable height). The full reply still
    commits to `<Static>` verbatim when the stream ends. (Same root cause + fix shape as Claude Code's
    `disableRenderCap` / `visibleStreamingText`.)
  - **Footer:** the mode indicator gets a `⏵⏵` chevron + a left indent (matches Claude Code's `figures.pointer`
    mode line).
  - **Run indicator:** the in-flight tool dot is now blue (`RunningLine`), blinking, per request. (Very fast
    tools finish before a blink cycle; it's clearly visible on real work like a build.)
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
