# Changelog

All notable changes to Neko Code are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[semantic versioning](https://semver.org/) (pre-1.0: minor versions may include breaking changes).

## [Unreleased]

### Added
- **Version rollback that STICKS.** `neko update 0.7.7` downloads an exact version (up or down — a
  real downgrade) and pauses auto-update so the daily updater can't drag you forward again; `neko
  update` (no version) returns to latest and resumes auto-updates. The installer honors the same via
  `NEKO_VERSION`. The hold is written as `auto_update: false` (not a new config field) precisely so
  the version you roll back TO honors it — a rollback to 0.7.7 actually holds instead of being
  auto-upgraded on the next launch. `neko doctor` also now shows the file-search backend (ripgrep vs
  the built-in JS walk) so you can confirm the fast path.

### Fixed
- (See the research/multiline-caret branch: word-wrap, tight inserted-bar caret, plan-box width,
  incremental session persistence so an interrupted turn survives a resume.)

## [0.7.7] — 2026-07-07

### Fixed
- **Overall Windows lag (typing, streaming, scrolling): the frame differ is BACK ON, paired with a
  self-healing resync.** 0.7.6 cured the duplicated-chrome ghost by disabling the differ on Windows,
  but that traded away the whole render economy - every keystroke, stream delta and scroll step fell
  back to full Ink frames (bench: scroll first-response 15ms -> 63-76ms, with a 391ms render backlog
  after a flick). The ghost's real damage was PERSISTENCE, so instead of disabling the differ the
  displacement's lifetime is now bounded: a full ABSOLUTE repaint of the model (CUP+EL per row -
  immune to conhost's displacement, erases anything stale) lands ~400ms after every write burst and
  at least every 2s during sustained activity - a curses-style ^L, automated. Measured through a
  real ConPTY: scroll first-response 11ms (0.7.0-class), typed-echo OK, and the e2e ghost harness is
  clean 3/3 where the unhealed differ ghosted 3/3. `NEKO_INCR=0` still disables the differ entirely;
  that fallback path keeps instant coalesced scrolling and stays sim-locked in CI.
  The heal is surgical about WHEN it runs: Windows-only (elsewhere the displacement does not exist -
  an SSH link should not pay ~10KB per pause for nothing), and only structurally-risky writes arm it
  (many rows changing at once); the caret blink and spinner ticks do not, so an idle session is
  byte-silent (measured: 667 bytes over 5 idle seconds - pure blink, zero heals).

### Added
- **`scripts/bench-scroll-conpty.ts`**: scroll-latency bench through a real ConPTY (first-response /
  settle / bytes), with baselines recorded in the header - scroll feel is now measurable, not
  debatable.
- **Reference-terminal fidelity**: the harness VT gained lazy autowrap (DECAWM) and ECH, and the
  differ-on ConPTY stream was sequence-inventoried against it - verdicts no longer rest on a parser
  with blind spots.

## [0.7.6] — 2026-07-07

### Fixed
- **Duplicated footer/prompt rows on Windows (ghost chrome): the frame differ is now OFF by default
  on Windows.** Mid-turn, a one-row-shifted copy of the input line and status footer stayed on
  screen next to the live ones (latent since at least v0.7.4 - reproduced deterministically on a
  new REAL-ConPTY e2e harness). The investigation peeled four real hazards, each fixed and each
  insufficient alone: Ink's raw newline-flow first frame could scroll the real screen (seeds/resyncs
  now paint ABSOLUTE rows, always); hardware scrolls could fire across a band-geometry change
  (`paintedBand` gate) and displace content outside the DECSTBM region on ConPTY (now off by default
  on Windows, `NEKO_HWSCROLL` overrides); DEC 2026 brackets reached terminals we had denied because
  Ink emits its own BSU/ESU (now stripped whenever 2026 is denied). The residual displacement still
  reproduced with a pure absolute-CUP stream - it lives in conhost's buffer/viewport handling, not
  in our bytes (they replay clean through the reference VT) - so Windows now takes Ink's plain
  full-frame writes: with the differ off the same e2e runs are clean 100% (typing verified live in
  every run). Unix keeps the full differ + hardware scroll. `NEKO_INCR=1` force-enables on Windows
  for experiments.
- **Typing dead on Windows Terminal (dev-only regression, never released).** Dropping WT from the
  2026 allowlist sent every WT session into the DECRQM probe, whose pre-Ink stdin pause left input
  permanently silent under Bun on Windows - AND the probe re-enabled 2026 (WT answers "supported").
  The support decision is now three-state (`yes`/`no`/`unknown`): known answers never probe, Windows
  never probes, `NEKO_SYNC=0` is a hard no, and the probe no longer pauses stdin. The e2e harness
  now emulates real WT (WT_SESSION + DECRQM reply) and asserts typed keys ECHO in every run - both
  failure modes are locked.

### Added
- **Render forensics.** `NEKO_TRACE_FRAMES=<file>` taps every differ decision AND every byte that
  reaches stdout (base64 NDJSON), and `scripts/e2e-conpty-ghost.ts` runs a real binary under a real
  ConPTY and counts duplicated chrome rows over a live turn - together they separate "our bytes are
  wrong" from "the terminal executed correct bytes wrongly" in minutes.
- **`bun-stable-watch` workflow.** The canary pin is deliberate, temporary debt - and now the repo
  calls it in itself: a daily cron checks Bun's releases and files a revert issue (with the full
  payoff checklist) the day the first stable after 1.3.14 ships. No human memory involved.
- **Runtime forensics.** Every release compile logs `bun --revision` first, so the exact
  version+commit of the embedded (rolling-canary) runtime is on record for every shipped binary.

## [0.7.5] — 2026-07-06

### Added
- **Input smoke gate: the whole "renders but can't type" class is now caught before shipping.**
  `scripts/input-probe.ts` spawns the compiled binary's `doctor keys` under a REAL pseudo-terminal
  (Bun.Terminal: ConPTY on Windows, forkpty elsewhere), types into the master side, and asserts the
  byte makes the full round trip (write -> PTY -> raw stdin -> hex echo -> verdict). Wired into
  `bun run build` (so CI runs it on all three OSes) and into the release smoke step right next to
  `__uiprobe` - a runtime that drops stdin renders perfectly and fails ONLY here. Verified on
  Windows (ConPTY) and Linux (WSL) against real binaries.

### Fixed
- **Typing dead on some Windows machines: the Bun 1.3.14 runtime, not Neko.** Field report (with an
  agent-driven on-machine diagnosis): the session renders perfectly but no keypress ever arrives -
  Ctrl+C included. A minimal `stdin.setRawMode(true)` probe under stable Bun 1.3.14 receives ZERO
  bytes on the affected machine while Node in the same terminal receives them all, and the same
  probe under Bun canary 1.4.0 works; a Neko rebuilt on the canary runtime takes input again
  (`doctor keys` shows the bytes). Releases are now compiled on the canary runtime until the first
  stable after 1.3.14 ships (pinned + documented in the workflows). Machine-dependent: many Windows
  boxes are fine on 1.3.14 - if yours types, nothing changes.
- **Installer: PATH is now compared per ENTRY, never by substring.** The old wildcard check saw the
  pre-v0.3 `...\Programs\neko-core` entry, decided `...\Programs\neko` was "already on PATH", and never
  added the real install dir - so after shadow healing removed the old exe, `neko` was not recognized
  at all. The installer now matches exact PATH entries (case/trailing-slash tolerant), prepends the
  install dir into the CURRENT shell as well (works immediately under `irm ... | iex`), and cleans the
  dangling `Programs\neko-core` PATH entry + empty dir left behind by the pre-v0.3 installer.

### Added
- **`neko --doctor`** as an alias of `neko doctor` (previously the flag was silently ignored and
  dropped you into chat). Both installers now end by suggesting `neko doctor` and `neko --yolo`.
- **Terminal/input diagnostics.** `neko doctor` now reports the hosting terminal, stdin/stdout TTY +
  raw-mode capability, and the effective UI fps (+ detected display Hz). New `neko doctor keys`: a raw
  key probe OUTSIDE the UI stack - it prints every byte the terminal delivers (hex + printable) for 10s
  and issues a verdict. This is the triage for "the session renders but typing does nothing": zero
  bytes = the keyboard never reaches neko (terminal/ConPTY/antivirus level); `CSI ..._` bytes =
  win32-input-mode was stuck on; plain bytes = the input layer is fine.

### Fixed
- **Stuck win32-input-mode heals at startup.** DEC private mode 9001 (Windows Terminal's
  win32-input-mode) left ON by a previous app makes every keypress arrive as `CSI Vk;Sc;Uc;Kd;Cs;Rc _`
  - the UI renders fine but typing looks completely dead. The terminal-hygiene reset every neko run
  performs at entry (and teardown) now turns it off alongside the mouse modes.
- **"display detected at 59Hz" confusion.** Windows WMI reports the floor of fractional refresh
  timings (59.94Hz panels read "59"). Detection now snaps floor-reported rates to the marketing rate
  (59->60, 119->120, 143->144), so a plain 60Hz monitor no longer prints a mysterious 59Hz/59fps line
  (it prints nothing at all - 60 is already the default).

### Changed
- **Installer polish (grok-class) + shadow diagnosis.** Both installers now fetch and SHOW the version
  being installed, draw a clean single-line progress bar, run the installed binary and report its real
  version, always state the PATH situation (Windows now PREPENDS to the User PATH), and - the important
  one - detect OTHER `neko` executables on PATH that would shadow the fresh install and print the exact
  removal commands. That shadow was exactly the "installed the new version but `neko --version` still
  says 0.2" trap. Served live from `main`; no release required.

## [0.7.4] — 2026-07-06

### Added
- **Auto-update, on by default (Claude-Code style).** The daily startup check now INSTALLS a newer
  release in the background instead of only notifying: the download stages next to the running binary
  and swaps in atomically (Windows uses the rename-out-of-the-way trick), taking effect on the next
  launch - the session in progress is never touched. Opt out with `auto_update: false` or
  `NEKO_AUTO_UPDATE=0` (notify-only), or silence checks entirely with `auto_update_check: false`.
  `neko update` remains for manual runs. Source (bun) runs are never auto-updated, and the updater only
  moves forward - a dev build can't be clobbered by an older release.

## [0.7.3] — 2026-07-06

### Changed
- The executable icon is now the mascot EXACTLY as it appears in the banner: the ハ・・マ pixels are
  extracted 1:1 from `neko-core-banner.png` (`assets/mascot-art.txt`) and rendered in brand orange -
  no redrawn approximation. Downscaling uses coverage sampling so thin strokes survive at 16px.
- New `assets/social-preview.png` (1280x640, dark) for the GitHub social card: the banner recolored -
  orange mascot + white NEKO CORE (upload via Settings -> Social preview).

## [0.7.2] — 2026-07-06

### Changed
- The executable icon is now the mascot itself — the kaomoji ハ・・マ in brand orange, thin strokes and
  negative space, exactly as it appears in the banner and the in-app logo (owner call: the kaomoji IS the
  brand; the interim filled cat face is gone).

## [0.7.1] — 2026-07-06

### Added
- **Branded Windows executable** — the compiled `neko.exe` now carries proper PE metadata: Task Manager
  shows **Neko Core** (was "Bun"), Explorer shows the pixel-cat icon, and file properties list The Wiii
  Lab, the version, and the MIT copyright. The icon is *generated from code*
  (`scripts/make-icon.ts` → `assets/neko.ico`, 16-256px) — reviewable pixel art in the brand orange, no
  opaque binary blobs.

### Fixed
- Ink is told `interactive: true` explicitly: a shell that exports `CI=true` (or any CI-ish env var) no
  longer freezes the UI — Ink's is-in-ci detection used to stop frame writes even on a real TTY. The same
  detection made every UI test silently blank on GitHub runners; the suite now forces interactive in its
  render harnesses and passes identically with and without CI env vars.
- UI tests pass the mode explicitly (a tests-only `fullscreen` prop) — bun ≥1.3.14 test scheduling made
  cross-file env mutation and even the bunfig preload unreliable.

## [0.7.0] — 2026-07-06

The fullscreen release: Neko's terminal UI became an app-owned, flicker-free viewport — built through
nine measured optimization rounds and a week of daily dogfooding on a real 144Hz Windows terminal, then
verified natively on Linux. (0.6.0 was an internal milestone on the way and was never published.)

### Added
- **Fullscreen UI as THE interface** (alt-screen, like vim/htop). The transcript is an app-owned
  scrollable viewport: mouse wheel + PgUp/PgDn + Ctrl+arrows scroll with an ease-out glide, Ctrl+F finds
  in-transcript, a clickable "jump to bottom" pill (with a real hover state) appears when scrolled away,
  and markdown formats **live as it streams** (bold/headers/tables render mid-stream, not on commit).
  Terminals that can't host it (non-TTY / tiny) fall back to inline automatically.
- **FrameDiffer — a compositor-lite at the stdout layer.** Ink's full-frame rerenders are intercepted and
  shrunk to the changed lines, or to a real hardware scroll (DECSTBM + SU/SD: the terminal shifts the
  region; only revealed rows are painted). Keystrokes cost ~178 bytes instead of whole-screen rewrites;
  every emitted byte sequence is verified against a virtual terminal in tests. All fullscreen writes use
  absolute addressing — immune to real-terminal cursor drift (the class of "ghost input row" bugs).
- **ANSI row cache** — each transcript line renders to styled rows ONCE (hidden Ink instance), giving the
  viewport `<Static>`-like economics; a windowed background warmer (newest-first, time-budgeted chunks)
  keeps long sessions responsive.
- **Refresh-rate-aware rendering** — the display's Hz is auto-detected (Windows/macOS/Linux, cached) and
  drives the UI frame cap; `/fps [auto|30..240]` overrides.
- **Drag-to-select + copy** (fullscreen captures the mouse, so native selection can't reach the alt
  screen): a left-drag paints a solid selection rectangle, copies on release, persists for the habitual
  Ctrl+C, and confirms with a reserved-row "copied N chars" note that never shifts the layout. `/copy`
  (last reply) and `/copy all` write BOTH OSC 52 and the native clipboard (clip.exe UTF-16LE / pbcopy /
  wl-copy / xclip) — works on terminals that ignore OSC 52.
- **Session-aware tab title** — `🐱 <session>` (named once from the first message, stable across turns;
  `/title` pins), a pulsing `●`/`○` dot while a turn runs, restored on exit. Windows quirks defeated:
  the title stack is skipped (WT restores it mid-session) and a 1s keeper heals SetConsoleTitle clobbers
  from console children.
- **Editor-style input caret** — a thin green `▏` flush against the text, blinking when idle, solid while
  typing (mouse traffic doesn't hold it solid).

### Changed
- **Fullscreen is the sole interactive mode** — the `/fullscreen` toggle is gone (an entire class of
  alt-screen↔inline transition bugs went with it); `NEKO_FULLSCREEN=0` remains as an internal escape
  hatch, not a user-facing option.
- **Claude-clean exit** — leaving Neko restores the shell exactly as it was and prints only the
  `Resume this session with: neko --resume <id>` hint; the raw transcript echo is gone, and the
  "press ctrl+c again to exit" hint is an ephemeral status, not a transcript line.
- **Input chrome is layout-stable** — a reserved status row (paste hint / copy note), and the prompt box,
  find bar, pickers and approval boxes can never be flex-squashed on short windows.
- **TypeScript 7.0.1-rc (native Go compiler)** is the typecheck gate (~4x faster); CI cross-checks
  against 5.9 on all three OSes until 7.0 GA.
- **NODE_ENV=production baked into the compiled binary** (React dev-mode overhead was shipping — ~5x per
  frame) with a `__uiprobe` smoke test in CI so it can't regress.

### Fixed
- Session-index freshness key is now mtime+size (same-millisecond rewrites were served stale on ext4),
  with in-place migration for legacy indexes (no full re-parse stall on first `/resume` after upgrade).
- The `/resume` picker renders intact when scrolled (flex-squash mangled names) and the band re-composes
  on geometry changes (stale transcript rows could freeze over the picker).
- Mouse tracking can no longer leak into the shell: all 7 DEC mouse modes reset on exit, at process
  entry (self-heal after a hard kill), and via an unbypassable `process.on("exit")` restore.
- Verified natively on Linux (full suite + compiled binary); three Windows-centric tests made portable.

## [0.5.1] — 2026-07-03

Reliability + efficiency patch, driven by real dogfooding (every fix traces to a live failure).

### Fixed
- **Approval box no longer swallows a fast `y`** — the y/a/n handler lived in a `useInput` hook that only
  activated *with* the approval box; Ink paints the frame at React commit but attaches a toggled hook's
  listener in a later passive effect, so a key pressed the instant the box appeared fell into that gap and
  the box hung forever (this was also why two "flaky" CI tests failed deterministically on slow runners —
  root-caused via `git bisect` + instrumenting Ink). Approval keys now live in the always-mounted global
  hotkey hook: no activation window, no dropped keys.
- **Release builds can't lose an asset anymore** — every matrix job used to create the GitHub release
  concurrently; two jobs racing on a fresh tag each created one, the duplicate was discarded and its upload
  404'd (v0.5.0 shipped without `neko-linux-arm64` until a manual re-run). The release is now created ONCE
  by a first job (`gh release create`, idempotent) and the build matrix only uploads (`--clobber`).
- **HTTP 529 (`overloaded_error`) is retried, not fatal** — Z.ai returned Anthropic's documented overload
  status and the run died instantly; 529 joined the retryable set in both providers (with backoff), locked
  by a fetch-mock test.

### Added / Changed
- **Prompt-prefix cache stability + measurement** (research-grounded: Anthropic prompt-caching docs, Manus
  context engineering, *Don't Break the Cache* arXiv 2601.06007) — the `<env>` block is now a session-start
  SNAPSHOT (the per-turn `git status` dirty-count that invalidated the provider's prefix cache on every
  edit is gone; the model runs `git status` itself for live state), todos moved out of the system message
  (the `todo_write` result already recites the plan in-stream), and the anthropic provider sends explicit
  `cache_control` breakpoints (system-end + rolling last-message; ON by default, `prompt_cache: false`
  opts out, strip-and-retry self-heal for endpoints that reject them). Cache reads/writes are now measured:
  `/cost`, the bench summary and `bench-log.jsonl` report `cached` tokens across provider shapes
  (Anthropic `cache_read_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`, DeepSeek
  `prompt_cache_hit_tokens`).
- **Tool-error recovery directive** (Self-Harness, arXiv 2606.09498) — the FIRST failure of a mutating tool
  (bash/write_file/edit) injects a `[recovery]` observation at the point of error: DIAGNOSE the actual
  state → REPAIR the root cause → VALIDATE by re-running the failed check. Edge-triggered (a success
  re-arms it; persistent failure stays the unproductive-streak guard's job), append-only so the prompt
  prefix stays cacheable.
- **Procurement skill: two-stage INDEX → VERIFY sourcing** — price surveys now START from a comparison
  aggregator (websosanh.vn; one server-rendered fetch ≈ hundreds of offers), then verify the offers that
  answer the question (top-N for "most expensive", bottom-N for "cheapest", median band for "market
  price") on the merchant page (product-match + live price + stock), then gap-fill via the source MAP +
  search — with a new PC-components MAP section (HACOM, Phong Vũ, GearVN, An Phát, laptopworld…). A/B on a
  real errand: the old strategy answered a "highest price" query wrong (9.99M₫) at 75k tokens; the new one
  found the true answer (12.99M₫, verified live) at 50k tokens — cheaper and correct, even with the search
  backend degraded.

## [0.5.0] — 2026-07-02

- **Streaming stops jumping to the top; declutter + emoji alignment** — (1) **scroll jump** — a live region
  taller than the viewport made the terminal redraw from the top every frame while a long reply streamed. The
  reply now **progressively commits** its completed paragraphs to scrollback (via `<Static>`) once it outgrows
  the viewport, keeping the live region to the current paragraph, and the (stale) thinking trace is hidden once
  the answer starts streaming — so the live area stays within the terminal and no longer jumps. (2) a markdown
  horizontal rule (`---`) now renders as **plain spacing** instead of a full-width line (it read as clutter).
  (3) **emoji alignment** — table column widths use terminal display width (`string-width`, emoji = 2 cells)
  so a cell with an emoji no longer knocks the borders out of line, and keycap emojis (`1️⃣`) normalize to `1.`
  (they render as a misaligned box otherwise). Unit-tested (keycap normalize, wide-char table alignment, rule).

- **Wrapping no longer breaks words mid-character; LaTeX math renders as Unicode** — two fixes to how replies
  render: (1) **word-wrap** — markdown paragraphs were a `<Text>` with no width, so inside `<Static>` (+ the left
  gutter) they wrapped at the FULL terminal width and then spilled past the edge, and the terminal hard-wrapped
  them mid-character (Vietnamese "tương ứ" / "ng", the continuation dumped at column 0). Every transcript item is
  now width-capped to the inset content width, so text wraps at word boundaries within the gutter and never
  overflows. (2) **math** — a terminal can't render LaTeX, so `$...$` / `$$...$$` showed raw. A `mathToUnicode`
  converter now maps the common constructs to readable Unicode: `\frac{a}{b}` → `(a)/(b)`, `x^2` → `x²`,
  `\sqrt{...}` → `√(...)`, `\sum_{i=1}^{n}` → `∑ᵢ₌₁ⁿ`, Greek + operators (`\theta`→θ, `\times`→×, `\leq`→≤) —
  handling nested `\frac`/`\sqrt` (the quadratic formula renders as `(-b ± √(b²-4ac))/(2a)`). Inline `$...$`
  converts only when it actually looks like LaTeX, so a price like `$5 to $10` is left alone; the system prompt
  also nudges the model toward plain Unicode math. Unit-tested (`mathToUnicode`, width-capped wrap, display/inline).

- **Terminal-clean output: no emoji, real rules, readable elapsed** — three presentation fixes so replies
  look right in a monospace terminal: (1) the system prompt now tells the model to format for a monospace
  terminal and **avoid emojis** (decorative/keycap emojis like a digit-in-a-box misalign the columns — the same
  rule Claude Code uses); (2) a markdown horizontal rule (`---`) renders as a clean full-width box-drawing line
  instead of a partial run of ASCII dashes; (3) the live spinner's elapsed time reads `1m 00s` … `3m 14s` past a
  minute instead of an ever-growing bare `194s`. Unit-tested (`fmtElapsed`, box-rule render).

- **Horizontal gutter — the UI is inset from the terminal edges** — the whole REPL (transcript + live region)
  now sits inside a left/right padding instead of running flush against column 0, matching Claude Code's
  `paddingLeft={2}`. `<Static>` inherits the wrapper Box's padding, so one change indents both the committed
  history and the live area; width-sensitive rendering (markdown tables, dividers, the stream clamp) uses the
  padded inner width.

- **Long generations no longer time out mid-stream ("The operation timed out")** — the request timeout was a
  TOTAL cap (`AbortSignal.timeout(timeout_seconds)`) applied to the whole streamed response, so a legitimately
  long generation (e.g. a landing page across 3 files) was aborted once it crossed `timeout_seconds` (120s) even
  while tokens were still streaming in. It's now an **idle timeout**: the timer resets on every streamed chunk,
  so a healthy stream never times out and only a genuine STALL (no bytes for `timeout_seconds`) aborts. Fixed in
  both providers (`anthropic` — the Z.ai/GLM path — and `openai_compat`). Unit-tested with a slow-but-active
  stream (total time > budget, gaps < budget → completes). Also: the live **todo tracker** only shows while a
  turn runs (the committed "Update Todos" result is the record) — it no longer prints the plan twice.

- **Streaming no longer scroll-jumps to the top; list/footer/run-indicator polish** — the live streaming
  preview used to render the whole growing reply (up to ~60 lines), which overflows the terminal so Ink can't
  update it in place and **redraws from the top every frame** — the classic "it keeps scrolling to the top
  while generating" bug. The preview is now **clamped to the viewport height** (wrap-aware, tracks terminal
  rows) and rendered in a `compact` markdown mode (predictable height); the full reply still commits to the
  scrollback verbatim when it finishes. Also: a **`**Label**` line followed by bullets** is no longer glued to
  them (a list is treated as one block with a blank line around it); the **footer mode indicator** gets a `⏵⏵`
  chevron + indent; and the **in-flight tool dot** is blue and blinking. Unit-tested (`clampToRows`, list-block
  separation, compact-vs-normal height).

- **The `bash` tool runs real bash on Windows (not cmd.exe)** — an unsandboxed bash command used to spawn
  through `cmd.exe` on Windows, so the Unix idioms a model naturally emits (heredocs like `python - <<'PY'`,
  single-quoting, `$VAR`, pipelines) failed with `"<< was unexpected at this time"` and wasted agent steps.
  Neko now routes the tool through **Git-Bash** if present (`NEKO_BASH` override, then a Git install, then a
  git-derived path; WSL's `System32\bash.exe` is deliberately skipped because it can't see the Windows-drive
  workspace), falling back to the platform shell only when no bash is found. Dogfooded on OpenAI's GeneBench-Pro
  benchmark, where the old behavior cost answers; unit-tested (`plainTarget` / git-bash detection).

- **Terminal UI polish — bordered tables, vertical rhythm, a real Ctrl+O toggle, a live run indicator** —
  markdown **tables** now draw aligned box borders and are budgeted to the terminal width (the widest column
  shrinks, cells truncate to a single line) instead of overflowing and wrap-shattering their columns.
  **Paragraph spacing** is fixed: Ink collapses an empty `<Text>` to zero height, so blank markdown lines were
  disappearing and paragraphs ran together — blank lines now render as real rows (runs collapse to one), with a
  blank line above headings and around tables, for even vertical rhythm. **Turn separation:** each user prompt
  and each tool call now gets a blank line above it (matching Claude Code's per-message `marginTop`), so a prompt
  no longer glues to the previous turn's output or the tool call below it. **Ctrl+O** is now a proper expand/collapse **toggle** (it used to append a
  duplicate full copy every press and never collapse); the peeked output shows in the live region so a second
  press closes it. A tool call **in flight** shows live with a **blinking dot** and commits to the transcript
  with a solid dot when it finishes — a clear running-vs-done signal (deferred + keyed by call id so parallel
  tool calls pair correctly). Table layout is unit-tested (`fitColumns` / `truncCell` / bordered render).

- **`web_fetch` reads the web as Markdown, with deterministic per-platform routing** — a fetch now returns
  clean **Markdown** (`htmlToMarkdown`: keeps headings/links/lists, drops nav/scripts — the old flat strip
  threw links away). A **small page comes back whole with NO model call** (the markdown is the answer); a
  **large page paginates** (`page:N`) instead of truncating; results cache ~5 min. Known platforms route in
  **code, not a skill the model can ignore**: a **YouTube** URL → its **transcript** via `yt-dlp`, **GitHub**
  → `gh`, an **RSS/Atom** feed → a compact item list; each falls back to a normal fetch if the tool is missing.
  Opt-in `scrape_backend: "jina"` renders public JS/SPAs via Jina Reader (keyless). Measured: a YouTube ask on
  gpt-oss dropped from 7 calls / ~48k tokens (chasing fake-transcript sites) to **2 calls / ~16k**, and the
  same on glm-5.2 answered in 2 calls / ~9k. Size policy + compact reads learned from Hermes Agent; our own
  implementation. Unit-tested (`htmlToMarkdown` / `paginateWeb` / `vttToText` / `rssToMarkdown`).

- **Skills load deterministically by a `match:` trigger, not just fuzzy keyword overlap** — a skill's
  frontmatter may declare a `match:` regex (e.g. a platform URL for the new `web-reach` skill), checked FIRST
  so a clearly-matching domain skill loads even for short or non-English asks that token-overlap missed (a
  Vietnamese "lay transcript youtube ..." shared only ~3 English tokens and silently loaded nothing). Adds two
  skills: `web-reading` (efficient reads — a11y/markdown first, grab-once, no scroll-churn) and `web-reach`
  (route each platform to its best free backend). The doom-loop guard was generalized to nudge after N
  unproductive tool results (empty/duplicate), not just repeated identical calls.

- **Interactive provider/model switching in the REPL** — `/provider` picks a provider then chains into a
  model picker; `/login` runs a guided provider-picker wizard before capturing the key; both swap the live
  provider in place (`NekoConfig.adopt` + `agent.setProvider`) so a switch takes effect mid-session without
  restart. Keys still resolve on demand and are never stored or printed.

- **Provider extensibility — any provider is a profile + an env var (no config editing)** — built-in presets
  now declare a `key_env` (the env var holding that provider's key, e.g. `ZAI_API_KEY`, `DEEPSEEK_API_KEY`),
  resolved with the right precedence (a profile's own key beats a stray `OPENAI_/NVIDIA_API_KEY`; `NEKO_API_KEY`
  still overrides). So a multi-provider setup just means setting per-provider env vars and `--profile <name>` —
  no JSON surgery. New presets ride the Anthropic provider: `zai` (GLM Coding Plan, quota endpoint),
  `zai-openai` (Z.ai pay-as-you-go), `claude` (real Anthropic), plus `moonshot` (Kimi); `key_env` added to
  openai/groq/deepseek/mistral/together/fireworks/xai/openrouter/nvidia. Adding a new provider stays a one-line
  data edit. Unit-tested (key_env resolution + no cross-provider hijack).

- **Anthropic Messages API provider — run on Claude or a Z.ai GLM coding plan** — `provider: "anthropic"`
  speaks `POST {base_url}/v1/messages` (the Claude format, and the format Z.ai's GLM Coding Plan / OpenCode
  endpoint `https://api.z.ai/api/anthropic` expects). It's a config choice, not a core change — same Provider
  port as openai_compat. So Neko can run on a Z.ai coding-plan subscription (whose quota is on the Anthropic
  endpoint, not the pay-as-you-go OpenAI one), e.g. for continuous self-improvement runs. Converts Neko's
  OpenAI-shaped messages/tools to Anthropic blocks (system fold-up, tool_use / tool_result, image blocks,
  input_schema) and parses both non-streamed and SSE responses (text/thinking/tool deltas, usage). Set up a
  profile `{"provider":"anthropic","base_url":"https://api.z.ai/api/anthropic","model":"glm-4.6","api_key":"..."}`
  and run `neko run --profile zai ...` / `neko chat --profile zai`. Live-verified end to end (glm-4.6 drove a
  tool-calling agent run); conversions unit-tested.

- **`neko run --image <path>` — image→price in ONE automatic command** — attach image(s) to a one-shot run.
  Neko runs a **vision pre-pass** (a vision model reads the image into text) and then hands that text to the
  normal tool-using agent, which searches/prices it — so a text model that can't see and a vision endpoint
  that can't tool-call combine into one command. The vision model is `vision_model` config, defaulting to the
  verified `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` on an NVIDIA endpoint (a new `NekoConfig.withModel` clones
  the config at that model). Verified end to end: `neko run --image pack.jpg "tìm giá rẻ nhất VN"` -> the
  vision pass read "SanDisk Cruzer Blade 16GB", the agent then web-searched the CZ50 and priced it. If no
  vision model is available, the image run is a pure perception pass (no tools, since vision-only endpoints
  reject tool-calling).
- **Computer-use act→verify (deterministic) — the desktop analogue of "LLM extracts, code computes"** — a
  state-changing UIA action no longer trusts that it worked: `setvalue` reads the value back and asserts it
  landed (a read-only field is caught up front; rejected / reformatted / masked / truncated input becomes a
  "WARN MISMATCH", exit 1), and `toggle` asserts the state actually flipped. The model decides the action;
  code verifies it against the structure. `invoke` also self-verifies via a **UIA tree diff** — it snapshots
  the window's control tree + the top-level windows before/after and reports what appeared / went away / which
  new window opened (deterministic proof it did something, or a warning that it didn't); `click` still can't
  self-verify, so re-perceive after it. Live-tested on WPF windows (set+VERIFIED on a field, FAIL READ-ONLY on
  a locked one, `invoke` reporting the exact element that appeared).
- **Deterministic price-table layer (`price-table.ts`) — LLM extracts, code computes** — the professional,
  non-patchwork fix for a class of dogfood failures (gpt-oss read "31.990.000đ" as 31, reported a pricier
  source as "cheapest" while holding a cheaper one, summed wrong). Per the 2026 consensus on reliable
  extraction, the model now only transcribes prices VERBATIM and a deterministic script (`parseVnd` + sort +
  min/max/sum/median + outlier flags) does all the numbers — making the misparse / wrong-min / wrong-sum bug
  class *impossible*. Unit-tested (the script is deterministic, so it can be; the model can't). The
  procurement skill is reframed around it; the principle is documented in `docs/process/WEB.md` as the shape
  for any future numeric extraction.
- **Computer use** — a `computer-use` skill (code-first per CoAct-1, the GUI perception-action loop, hard
  guardrails). WEB control validated end-to-end through `@playwright/mcp` (DOM-driven, no vision needed) and
  a real VN procurement run. A Windows desktop **control primitive** `mouse.ps1` (pos/move/click) plus the
  Clicky-inspired `[POINT:x,y]` grounding path, so the screenshot -> vision-ground -> click loop is ready the
  moment a vision/GUI model is configured.
- **Desktop control with NO vision (UIA)** — `uia.ps1` drives Windows apps through the OS accessibility tree
  (the desktop DOM): a plain text model `list`s a window's controls (name + role + verb + exact OS coords),
  then acts BY NAME — `invoke` (InvokePattern: click without moving the cursor), `setvalue` (type without the
  keyboard), `toggle`, and `get` to verify — no vision, no GUI-trained model, no cursor hijack. SOTA-grade
  perf via a UIA CacheRequest (one bulk cross-process call; a naive tree walk times out on rich WinUI/WPF).
  Verified end-to-end on a real .NET window (`list` -> `setvalue` -> `invoke` -> screenshot confirmed). Raw-
  pixel vision is now only the LAST resort, for custom-drawn UIs with no accessibility tree.
- **Independent agent pointer (no mouse hijack)** — `inject.ps1` (tap/dbltap/stroke) acts via Windows TOUCH
  INJECTION, a SEPARATE pointer channel, so Neko clicks/drags/draws on the visible desktop WITHOUT moving the
  user's mouse (verified: drew in Paint with the real cursor parked, unmoved). Pairs with the overlay (the
  visible "instructor" triangle) for a true clicky-style cursor that actually acts. **Config-first:**
  `computer_use_input: "inject"` -> `NEKO_INPUT=inject` -> `mouse.ps1`'s click/stroke transparently route to
  the non-hijacking path (`"sendinput"` forces the legacy path); a new backend is a config value + a script.
  No driver, no admin, Win11-Home compatible. (Hidden/background or game control still needs VM isolation —
  documented honestly in the skill.)
- **Web reading via accessibility + tab presence** — `uia.ps1 read` dumps a page/doc as TEXT (so a text
  model summarizes a web page with no vision); Unicode `@<utf8-file>` targets (invoke-by-name survives the
  cp1252 console and is layout-independent). Launching Chrome with `--force-renderer-accessibility` exposes
  the logged-in page DOM to UIA — gpt-oss autonomously browsed + summarized a live feed and composed a post,
  reusing the login with no CDP and no credentials. The overlay now shows a **tab/window indicator** —
  frames + labels the exact window/tab Neko is driving ("NEKO dang dung tab nay: <title>"), driven by
  `neko_active_window.txt`.
- **Computer-use robustness — audit trail, intervention-resume, goal-loop** — every desktop action is appended
  timestamped to `%TEMP%\neko_actions.log` (override via `NEKO_ACTION_LOG`), so "what steps did you do?" is a
  `read` away. On a real (non-injected) user click the overlay yields and the helpers return `PAUSED`; the new
  `idle.ps1` blocks until the user has been idle a few seconds then clears the pause, so Neko can RE-PERCEIVE
  (re-screenshot / `uia.ps1 read`) and RE-PLAN from the new state — SOTA state-managed interruption / shared
  autonomy, "re-perceive don't blind-resume". And `runUntilDone` (`neko run --loop`) now re-inspects the ACTUAL
  state each pass before judging DONE (Reflexion/CRITIC/Chain-of-Verification) — the fix for tasks that quit
  early (the Paint test). SKILL.md documents all three.
- **First-class `computer` tool** — computer-use is now a native, gated agent tool, not just bash-ed scripts:
  `computer({action, window, name, value, x, y, points})` with `action` = list/read/get/invoke/setvalue/
  toggle/click/stroke/screenshot. It dispatches to the accessibility-tree scripts (Unicode names via an
  automatic temp UTF-8 `@file`), honours the presence/input config, and is gated like bash. The agent calls
  it structurally instead of constructing fragile shell strings. Verified live against a real Paint window.
- **`auto_loop` config (persist by default)** — set `"auto_loop": true` and `neko run` uses the closed loop
  (runUntilDone) by default, so you don't retype `--loop`; `--once` (alias `--no-loop`) forces a single shot.
- **`neko setup web` — one-command SOTA web stack** — stands up SearXNG in Docker (JSON API enabled, the bit
  that's off by default), verifies it, and wires `searxng_url` + the `@playwright/mcp` browser MCP (headed
  real-Chrome) into config — idempotent, key-safe (never touches `api_key`), with clear `[skip]` messages if
  Docker/bunx is missing. Sub-targets `setup searxng` / `setup browser`. Turns the manual setup that lifted
  Neko above a hand search (DuckDuckGo 18.3M → SearXNG 7.99M) into one command.
- **`neko bench lift` — harness-lift benchmark** — runs the same tasks twice, RAW (the model alone, no
  tools/loop, must emit file contents) vs +NEKO (tools + agentic loop), and reports the delta. Makes the
  thesis ("the harness turns a model into a capable agent") measurable instead of vibes. Honest finding: on
  tiny self-contained coding tasks a capable model (gpt-oss-120b) one-shots them, so the lift is ~0 there —
  the lift shows on tasks the raw model CANNOT do (a `run-to-know` task whose value needs executing code; and
  agentic/computer-use, where raw can't act at all — cf. the Paint house: raw scribbled+quit, +Neko drew a
  full house).
- **Deep research** — a `deep-research` skill (plan -> multi-source search -> read primaries -> cross-verify
  >=2 authoritative sources -> cited synthesis) and a strengthened always-on Accuracy section in the prompt.
- **tui-self-test** skill — verify the TUI render (ink-testing-library + a live screenshot loop) with the
  SendKeys focus-leak guardrail learned from dogfooding.

### Fixed
- **Path-escape guard now catches SYMLINKS, not just `../`** — `resolveInRoot` did lexical containment only, so a symlink INSIDE the root pointing OUTSIDE passed the check but actually escaped (read/write through it could touch files outside the project). It now also compares realpaths (resolving a new file's nearest existing parent), so a symlinked path that resolves outside the root is refused. Verified: reading through a junction escaping the root is refused, no leak. Low-risk on a local-first tool (you own the repo, write/bash are gated) but now closed.
- **Computer-use coordinate actions land on a scaled display (DPI fix)** — UIA reports element coordinates in
  PHYSICAL pixels, but the acting scripts were DPI-UNAWARE, so on a scaled display (e.g. 125%) Windows
  virtualized their click/tap coordinates and they landed ~1.25x off-target — every coordinate action quietly
  missed. CONFIRMED with a functional test (an unaware mouse-click at a checkbox's reported coords missed; a
  fully DPI-aware read+click toggled it). All five coordinate scripts (`uia`/`inject`/`mouse`/`overlay`/
  `screenshot`) now set `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`, so reads, actions, the cursor
  overlay, and the screenshot `scale` all share one physical-pixel space. (Touch still routes control clicks
  through `invoke`-by-name, not coordinates — injected touch doesn't promote to a control click.)
- **Atomic writes — a crash can no longer lose the session / API key / memory** — `saveSession` (per turn),
  the user config writer (holds the API key), and the NEKO.md memory note all did a plain `writeFileSync`,
  which truncates-then-writes; a kill/crash/concurrent-write in that window left an unparseable file that the
  loaders then silently dropped — i.e. the whole conversation or the saved key, gone. They now go through
  `shared/atomic.ts` (write a temp sibling, then atomic rename), so the target is always the old or the new
  bytes, never a truncation. Unit-tested incl. "a failed write leaves the original intact".
- **MCP: a hung server no longer blocks startup** — `connectAll` awaited each server's connect + `listTools`
  with no timeout, so one unresponsive stdio command / URL hung Neko's startup indefinitely (and stalled every
  server after it). Each connect is now bounded (15s) and skipped-with-error on timeout; interactive OAuth is
  exempt (user-paced).
- **`computer` tool: failures are visible, inputs are validated** — `runComputer` swallowed PowerShell
  spawn errors / timeouts into `"(no output)"`, so the agent couldn't tell a *failed* action from a silent
  one; and `click` coerced a missing/invalid coordinate to the string `"NaN"` and passed it to the injector.
  Now spawn errors, timeouts (the 90s hang), and non-zero exits are surfaced as real error observations, and
  `click`/`stroke` reject non-numeric coordinates up front (deterministic input validation, unit-tested) —
  the same "surface errors, validate in code" standard as the extraction layer.
- **A throwing tool no longer crashes the whole turn** — a model glitch (e.g. emitting `web_fetch` with no
  `url`) made an executor `throw`, which escaped the agent loop and killed the run (`neko: error: ...`). Tool
  execution now goes through `safeExecute`, so any throw becomes a recoverable error OBSERVATION fed back to
  the model (honouring the loop's "errors are fed back so the model adapts rather than crash" contract).
  Caught a real failure mid price-research; regression-tested.
- **Context-overflow crash** — one huge tool result (a heavy page's browser snapshot) could push the prompt
  past the context window, so the server returned a negative `max_tokens` and 400'd the turn. Each
  observation is now capped, and a long turn compresses its OLDEST observations in place (observation
  masking) before it would overflow. Regression-verified on the exact page that crashed (772k tokens, 0 crash).
- **Procurement price typing** — prices are captured per condition (new / used-trade-in / installment), each
  a labeled row, so a used/trade-in price is never reported as the new price.

### Changed
- **UI polish** (verified live) — diffs render Claude-style (line number first, red removals / green
  additions); the tool-result connector uses a glyph (`└`) that renders on every terminal font; the
  diff/write header colors its `+N` green and `-M` red.

## [0.4.0] — 2026-06-27

### Added
- **Mixture-of-Agents provider** (`provider: "moa"`, or `neko --profile moa`): diverse reference models
  analyze in parallel without tools (on an advisory-safe view of the conversation — no system prompt or
  tool payloads re-sent), then a strong aggregator synthesizes their advice and drives the tool loop.
  Clean-room from the MoA paper (arXiv 2406.04692) + Hermes Agent. Mixture token cost is accounted; a
  failing reference degrades gracefully. Opt-in quality mode (N+1 calls/turn). Independent benchmarks: it
  TIES strong single models on saturated tasks (no headroom) but EXCEEDS them where the single model is
  weak — false-premise robustness, 5/6 vs 4/6.

## [0.3.0] — 2026-06-27

### Added
- **Remote control, professional + cross-device.**
  - `/rc` HTTP control API gained SSE streaming, `GET /status`, `POST /interrupt`, `Authorization: Bearer`
    auth, a 1 MB body cap, request serialization, and a discovery file; optional `remote_bind` for a
    trusted private mesh (Tailscale).
  - `/relay` drives Neko from **any phone/browser with no open port** — the agent dials out and
    long-polls a relay you host (a Cloudflare Worker; `cloudflare/relay/`), with **end-to-end encryption**
    (zero-knowledge relay) and **QR pairing** printed in the terminal.
- **Self-improving memory** — learned `workflows` (AWM-style procedures) and an always-on `playbook`
  (ACE) alongside `memory` (facts) and authored `skills`.
- **Skills** — `procurement` (VN sourcing / purchasing officer) and `browser-visual-qa` (drive a page,
  capture, analyze frames with vision).
- **Tool-use parity with Claude Code** — `search` via ripgrep (with a built-in fallback) + glob/case/
  context; `bash` per-call `timeout` + `run_in_background`; `read_file` offset/limit + image/PDF reading;
  MCP **lazy** schema loading.
- **Self-update** — `neko update` downloads the latest release and replaces the binary in place, plus a
  daily-cached startup check.
- **Config-driven `effort_ceiling`** — maps a configured `reasoning_effort` (e.g. `max`) down to the
  endpoint's accepted ceiling proactively.

### Fixed
- Robustness: bounded live render and tool output (no UI freeze / OOM on big streams), interruptible
  `bash`, per-cwd git-branch caching.
- Windows installer survives the schannel certificate-revocation condition (`--ssl-no-revoke` + fallback).
- `reasoning_effort` gracefully clamps to the highest accepted tier instead of erroring.

## [0.2.0]

- Initial public binaries: streaming agent loop, safe/gated tools, permission modes, Ink TUI, sessions,
  MCP, config-first profiles, one-line install.

[0.3.0]: https://github.com/meiiie/neko-core/releases/tag/v0.3.0
[0.2.0]: https://github.com/meiiie/neko-core/releases/tag/v0.2.0
