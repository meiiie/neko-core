# Fullscreen mode — research + architecture (scrollable, virtualized transcript)

Status: **SHIPPED P1-P5** (built after the research below). Date: 2026-07-04.
Author: Claude (clean-room study of the local claude-code reference + web research).

**Implemented:** P1 synchronized output (`src/ui/sync-stdout.ts`) · P2 alt-screen + scroll viewport
(`src/ui/altscreen.ts`, `src/ui/scroll.tsx`, gated by `/fullscreen` · `cfg.fullscreen` · `NEKO_FULLSCREEN`)
· P3 mouse wheel + input hardening (`src/ui/mouse.ts`, `src/ui/text-input.tsx`) · P4 in-viewport find
(Ctrl+F, `src/ui/scroll.tsx` highlight) · P5 suitability guard + degradation (`canFullscreen`).
Default OFF (inline keeps native scrollback + copy-paste). Env: `NEKO_FULLSCREEN`, `NEKO_DISABLE_MOUSE`,
`NEKO_SYNC`. **Deferred (future):** rich variable-height virtualization of scrollback (currently flattened
fixed-height rows), a runtime DECRQM/XTVERSION sync-probe for SSH into unknown terminals (env allowlist
covers local terminals today), tmux-passthrough sync, and own-selection/OSC-52 copy under mouse capture.

## 0. Why

Today Neko renders inline: every line is written to the terminal's **native scrollback** via Ink's
`<Static>` (append-only). That is the same default Claude Code ships to external users. It has two
consequences the owner hit:

1. **No app-owned scrolling.** An inline `<Static>` app never receives scroll events — when you scroll
   up you are scrolling *the terminal emulator's buffer*, not the app. So it cannot detect "reached the
   top" and cannot lazy-load earlier messages the way a GUI chat app (Messenger/Zalo) does. That is why
   resume bounds the reprint to 80 lines, and why "scroll up to load more" is impossible **in inline
   mode**. (`/transcript` — shipped — is the interim: an app-owned scroll+search overlay.)
2. **Windows flicker + cursor-yank.** On Windows conhost, cursor-up sequences that reach above the
   visible area follow the cursor into scrollback and yank the user to the top mid-stream
   (microsoft/terminal#14774). Inline streaming also flickers without atomic frame updates.

**Fullscreen mode** fixes both: the app switches to the terminal's **alternate screen** and owns a
virtualized viewport it fully controls — real scrolling (keyboard + wheel), lazy-load, in-viewport
search, and flicker-free atomic redraws. It is also the *foundation* every later UI improvement builds
on. This doc is the research + plan for building it the right way.

The tradeoff (and why it must be a *mode*, default-off): the alternate screen **hides native
scrollback** and mouse capture **breaks terminal-native select-to-copy**. So this is opt-in, with an
escape hatch, exactly as Claude Code gates it behind `CLAUDE_CODE_NO_FLICKER` (default on only for
Anthropic staff, opt-in for everyone else).

## 1. State of the art (2026)

The whole ecosystem has converged on the same primitives. Sources below.

### 1a. Atomic frames — Synchronized Output (DEC private mode 2026)
A program brackets a frame with **BSU** (`CSI ? 2026 h`) and **ESU** (`CSI ? 2026 l`); a supporting
terminal renders everything between them atomically — no partial-repaint flicker. This is *the* fix for
streaming/redraw flicker and is what "NO_FLICKER" means. Supported by Windows Terminal, iTerm2, WezTerm,
kitty, foot, Alacritty, Ghostty, VTE ≥ 0.68, and tmux 3.4+ (tmux proxies but historically did not
implement it — detect and skip). Capability is detected by an **env allowlist** (fast, sync) backed by a
**DECRQM** query (`CSI ? 2026 $ p` → DECRPM reply) and **XTVERSION** (survives SSH, where `TERM_PROGRAM`
is not forwarded).
  - Spec: contour-terminal/vt-extensions `synchronized-output.md` (Christian Parpart).
  - tmux support: tmux/tmux PR #4744. claude-code issues #37283 (tmux flicker), #19533 (GNU screen).

### 1b. Immediate-mode rendering + double-buffer cell diff (Ratatui)
Redraw the *entire* frame into an in-memory **cell buffer** each tick, **diff** it against the previous
buffer, and emit escape sequences for **only the changed cells**. Ratatui's `BufferDiff` yields cell
updates one at a time (no per-frame temp allocation). This is the efficient way to repaint a full screen
on every scroll tick. Neko/Ink already has a reconciler that produces a diff; the claude-code Ink fork
(`render-to-screen.ts`, `screen.ts`, `optimizer.ts`, `writeDiffToTerminal`) is this pattern, then wraps
the whole diff in one BSU…ESU buffered `stdout.write`.

### 1c. Compositor + Line API + virtualized ScrollView (Textual)
Textual composites clipped, possibly-scrolling widgets; its **Line API** can update a region as small as
one cell without a full redraw, and **ScrollView** virtualizes by exposing a `virtual_size` and only
rendering the visible lines. This is the reference for *variable-height windowing*.
  - Textual "Algorithms for high performance terminal apps" (2024-12), `_compositor.py`, ScrollView docs.

### 1d. Framework reality: Ink has no ScrollView
Ink deliberately has **no native scroll container** — you must implement **windowing** yourself (render
only the slice of items that fit, using stdout dimensions). Alt-screen hides scrollback by design (like
vim). Ink also has a ~30 FPS cap and a heavy footprint; a newer Bun-native option, **OpenTUI**
(React + Bun + Zig backend), is emerging as a higher-ceiling alternative. Charm's **Bubble Tea**
`viewport` bubble is the Go equivalent of a scroll region.
  - vadimdemedes/ink; LogRocket "7 TUI libraries"; Stork.AI "OpenTUI".

### 1e. What claude-code actually built (clean-room study — patterns only, no code copied)
A full **custom Ink fork** (`src/ink/`) plus fullscreen components:
  - `terminal.ts` — `isSynchronizedOutputSupported()` (env allowlist + VTE/WT/kitty checks),
    `writeDiffToTerminal()` buffers the whole diff and wraps it in `BSU…ESU`.
  - `terminal-querier.ts` / `parse-keypress.ts` — DECRQM/DA1/OSC 11/XTVERSION query+reply over stdin.
  - `AlternateScreen.tsx` / `ink.tsx` — `?1049h/?1049l` lifecycle, careful about nested apps (a child
    `vim`'s rmcup drops us to main screen → re-enter on focus).
  - `components/ScrollBox` + `hooks/useVirtualScroll` — the windowing engine: render `messages.slice(
    start,end)` between a `topSpacer`/`bottomSpacer`, measure each item's height via Yoga and cache it
    (invalidate on width change → rewrap), keep an `offsets` prefix-sum, overscan a few rows, and only
    re-window every `SCROLL_QUANTUM≈40` rows to avoid per-wheel-tick relayout.
  - `VirtualMessageList.tsx` — sticky-to-bottom auto-follow, a fine-grained `StickyTracker` (shows the
    prompt that scrolled above the fold as a header), incremental key array, and a two-phase search
    engine (scrollToIndex → mount → scan exact positions → highlight) with a `3/47` badge and incsearch
    anchor snap-back. Heavily perf-tuned (stable callback refs to kill closure GC during fast scroll).
  - `fullscreen.ts` — the gate: env `CLAUDE_CODE_NO_FLICKER`, `CLAUDE_CODE_DISABLE_MOUSE`, tmux -CC
    auto-disable, mouse-hint for tmux. Confirms **default off for external users**.

**Takeaway:** true parity is a *substantial* build — a windowing/scroll engine, alt-screen + sync-output
plumbing, mouse + own-selection, and scroll UX. It is worth it because it is the platform for everything
after. We do it in phases, each shippable and gated.

## 2. Building blocks we need

| Block | What | Risk |
|---|---|---|
| Sync output | BSU/ESU wrap on the existing frame write; capability detect (env + DECRQM/XTVERSION) | Low |
| Alt-screen | `?1049h`/`?1049l` enter/leave; restore on exit/crash/signal; nested-app re-entry | Med |
| Cell diff | reuse Ink's reconciler diff, buffer into one write | Low (have it) |
| Windowing | render only visible slice; height measure+cache (Yoga); offsets; overscan; scroll quantum | High |
| ScrollBox handle | imperative scrollTop/scrollToBottom/scrollToElement/isSticky/subscribe | Med |
| Scroll UX | ↑↓ / PgUp/PgDn / Home/End / g/G, sticky-bottom, repin-on-submit | Med |
| Mouse | SGR 1006 wheel; own selection + OSC 52 copy (capture breaks native select) | High |
| Search | incsearch + n/N + `k/N` badge, in-viewport | Med |
| Detection/gating | env + probes, graceful degrade to inline, config/flag, Windows hardening | Med |

## 3. Architecture decision

Two realistic paths:

- **Path A — extend our Ink stack.** Add a `ScrollBox` primitive + `useVirtualScroll` windowing hook, an
  alt-screen wrapper, and BSU/ESU in the frame writer. Reuses everything we have (Ink reconciler, Yoga,
  our components, tests). Lower risk, incremental, keeps the inline path as default. This mirrors what
  claude-code did (they forked Ink rather than replacing it).
- **Path B — adopt OpenTUI (Bun + Zig).** Higher performance ceiling (no 30 FPS cap), but a large
  renderer migration and a new dependency surface; re-implements our whole UI layer.

**Recommendation: Path A, incrementally.** Keep inline mode the default (safe-by-default; native
scrollback + copy-paste intact). Fullscreen is a *gated mode* (`NEKO_FULLSCREEN=1` / config
`fullscreen: true`), off by default, with auto-disable under tmux -CC and a clean inline fallback.
Revisit Path B only if Ink's FPS/footprint becomes the measured bottleneck (`neko bench lift`).

## 4. Phased plan (each phase shippable + verify-loop + benchmark-gated)

- **Phase 0 — interim (DONE):** `/transcript` app-owned scroll+search overlay. Delivers "see + search all
  earlier messages" now, no alt-screen, zero terminal-compat risk.
- **Phase 1 — Synchronized Output in the CURRENT inline renderer.** Detect DEC 2026 support (env allowlist
  + DECRQM/XTVERSION probe), wrap each frame write in BSU…ESU. Kills streaming flicker and the Windows
  cursor-yank artifact *without* alt-screen. Standalone win, low risk, ships alone. (This is literally
  the `CLAUDE_CODE_NO_FLICKER` fix.)
- **Phase 2 — Fullscreen scaffold + ScrollBox.** Alt-screen lifecycle (enter/leave/restore on
  crash+signal), a `ScrollBox` + `useVirtualScroll` windowing hook rendering the transcript, keyboard
  scroll (↑↓/PgUp/PgDn/Home/End/g/G), sticky-to-bottom auto-follow, repin-on-submit. Gated + inline
  fallback. The transcript now scrolls for real; `/transcript` becomes redundant inside fullscreen.
- **Phase 3 — Mouse + selection.** SGR 1006 wheel scroll; our own text selection + OSC 52 clipboard copy
  (since capture disables native select); `NEKO_DISABLE_MOUSE` escape hatch for terminal-native copy.
- **Phase 4 — In-viewport search.** incsearch + n/N + `k/N` badge, superseding the overlay's search;
  optional sticky-prompt header (the prompt that scrolled above the fold).
- **Phase 5 — Detection, degradation, Windows hardening.** Full capability matrix, tmux/SSH handling,
  conhost specifics, config surface, docs. Measure harness lift; ensure no regression to inline users.

## 5. Risks & guardrails

- **Terminal compatibility is the whole game.** Build the env+probe detection first; **always** degrade
  cleanly to inline. Never assume a capability — test it or allowlist it.
- **Copy-paste.** Mouse capture breaks native select-to-copy; ship OSC 52 + a disable-mouse hatch in the
  same phase as mouse, never before.
- **Crash/signal safety.** Alt-screen + hidden cursor + mouse tracking MUST be torn down on exit, crash,
  and SIGINT/SIGTERM, or the user's terminal is left corrupt. Register handlers up front.
- **Windows-first.** The owner is on Windows Terminal (WT_SESSION → sync supported). Validate Phase 1/2
  there first; watch the conhost cursor-yank bug.
- **Our rules.** Safe-by-default (mode is off unless opted in); config-first (a flag/profile, not a code
  fork); keep printed strings ASCII where they hit the Windows console; every phase passes
  `typecheck + bun test + policy + build` and is benchmarked for interaction latency before it ships.

## 6. Open questions
- Reuse Ink's reconciler diff directly for the cell buffer, or add a thin cell-grid layer for scroll?
- Height measurement: Yoga per-item (accurate, heavier) vs. a cheap line-count estimate + correct-on-scan?
- Selection model: character grid selection vs. line selection for v1?
- Do we keep `/transcript` as a lightweight always-available viewer even after fullscreen ships (inline
  users still need it)? Likely yes.

## Sources
- Synchronized Output spec — https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md
- Synchronized Output gist (Parpart) — https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036
- tmux DECSET 2026 PR — https://github.com/tmux/tmux/pull/4744
- claude-code flicker issue (tmux) — https://github.com/anthropics/claude-code/issues/37283
- CLAUDE_CODE_NO_FLICKER writeup — https://slyapustin.com/blog/claude-code-no-flicker.html
- Ratatui rendering (immediate mode + cell diff) — https://ratatui.rs/concepts/rendering/under-the-hood/
- Ratatui deep-dive — https://starlog.is/articles/developer-tools/ratatui-ratatui/
- Textual high-performance algorithms — https://textual.textualize.io/blog/2024/12/12/algorithms-for-high-performance-terminal-apps/
- Textual ScrollView (virtual_size) — https://textual.textualize.io/api/scroll_view/
- Ink (no native ScrollView; windowing) — https://github.com/vadimdemedes/ink
- OpenTUI (Bun + Zig) — https://www.stork.ai/blog/the-tui-library-thats-killing-ink
- Efficient terminal drawing in Rust — https://hugotunius.se/2019/12/29/efficient-terminal-drawing-in-rust.html
