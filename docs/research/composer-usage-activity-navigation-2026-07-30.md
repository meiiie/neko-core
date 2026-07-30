# Composer viewport, live token usage, activity folding, and prompt navigation

Research checkpoint: 2026-07-30

Scope: Neko Core fullscreen TUI. The local `claude-code` checkout was inspected read-only as a
clean-room behavioral reference; no source or implementation text was copied.

## Checkpoint 2026-07-30

Current best model:

1. A multiline composer is an editor viewport whose camera follows the caret. It is not an unbounded
   block and does not need a visible scrollbar.
2. Up/Down first navigate visual input rows; conversation history receives the key only at the
   corresponding editor boundary.
3. Live token counters must consume provider usage notifications as they arrive. Estimated values must
   remain visibly approximate and must never be booked into the durable cost tracker twice.
4. Tool activity has a lifecycle: present-tense while running, a compact past-tense outcome after
   success, and an expanded diagnostic when it fails.
5. Prompt navigation is a projection over exact rendered row spans. A fixed one-row anchor avoids
   changing viewport geometry while the user scrolls.

## Findings

- [verified] Neko's multiline composer bypasses its five-row viewport for any value containing a hard
  newline, and Up/Down never reaches caret navigation.
  confidence: high · local source and real ConPTY reproduction · 2026-07-30
  evidence:
  - `src/ui/text-input.tsx` renders the whole value on the hard-newline branch while the wrapped branch
    slices around `caretLine`.
  - `scripts/e2e-composer-viewport.ts` rendered seven input rows and observed no hardware-caret movement
    after Up in the compiled `neko --yolo` path.
  consequence: repair one shared wrap/viewport path; adding a visual scrollbar would not fix input
  ownership or caret movement.

- [verified] Established TUI text editors keep Up/Down as cursor operations and automatically keep the
  cursor inside the viewport.
  confidence: high · checked 2026-07-30
  sources:
  - `tui-textarea` documents `CursorMove::Up`, `CursorMove::Down`, `CursorMove::InViewport`, automatic
    scrolling, and independently callable page scrolling
    (https://docs.rs/tui-textarea/latest/tui_textarea/, checked 2026-07-30).
  - `tui-textarea` cursor implementation clamps cursor row/column against the current viewport
    (https://docs.rs/tui-textarea/latest/src/tui_textarea/cursor.rs.html, checked 2026-07-30; upstream
    commit `4d18622eeac13b309e0ff6a55a46ac6706da68cf`, 2024-12-01).
  clean-room corroboration: the inspected Claude Code editor attempts wrapped-row movement before
  invoking its history callbacks.
  consequence: Neko should expose history fallback to the editor rather than globally stealing arrows.

- [verified] Codex App Server emits token usage independently from turn completion, including restored
  usage immediately after resume.
  confidence: high · checked at OpenAI Codex commit
  `578c1b2230288104041e880a86d0f7f3a5ca6e47`, 2026-07-30
  sources:
  - App Server README: `thread/tokenUsage/updated` streams while a turn runs
    (https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md, checked 2026-07-30).
  - The same protocol says resume emits restored token usage before the next turn
    (same README, `thread/resume`, checked 2026-07-30).
  local evidence: Neko already parses the notification into `ActiveTurn`, but exposes it only from
  `finishUsage()` after `turn/completed`. A real 8-second `neko --yolo` turn displayed `↑0` until the
  final frame, then jumped to `↑34.3k`.
  consequence: add a display-only incremental usage callback; keep final cost accounting unchanged.

- [verified] Anthropic exposes input usage at stream start and cumulative output usage in message
  deltas, so live usage is not specific to one backend.
  confidence: high · checked 2026-07-30
  sources:
  - Claude Platform streaming event order and `message_start.usage`
    (https://platform.claude.com/docs/en/build-with-claude/streaming, n.d.; accessed 2026-07-30).
  - The same document states `message_delta.usage` is cumulative and shows `output_tokens`
    (same URL, accessed 2026-07-30).
  consequence: the provider port should own an optional live-usage callback instead of embedding an
  App Server type in the UI.

- [supported] OpenAI Responses usage is authoritative on `response.completed`; earlier output text
  deltas do not carry the complete usage object.
  confidence: medium-high · checked 2026-07-30
  source: OpenAI Responses streaming reference documents `usage` on `response.completed`
  (https://platform.openai.com/docs/api-reference/responses-streaming, accessed 2026-07-30).
  consequence: where no earlier provider usage exists, Neko may retain its output character estimate,
  but the UI must mark it approximate instead of presenting it as exact.

- [verified] Neko commits a successful tool invocation and result as two transcript entries, while only
  a small read/search subset receives a one-line result summary.
  confidence: high · local source inspected 2026-07-30
  evidence: `src/ui/chat.tsx` commits the pending call and then the result; `src/ui/chat-lines.ts`
  summarizes only four read-oriented tools.
  clean-room corroboration: the inspected Claude Code projection uses present tense for active work,
  past tense for a compact successful outcome, and preserves an explicit full-details route.
  consequence: fold a matched successful call/result into one line with the full detail behind the
  existing expansion gesture; never collapse failures, denials, or blocked actions.

- [verified] Neko's fullscreen history already has exact rendered rows and tail-distance scrolling, so
  prompt anchors do not require a new transcript store or virtual DOM.
  confidence: high · local source inspected 2026-07-30
  evidence: `src/ui/chat.tsx` builds `ansiRows`; `useRowScroll` stores distance from the live tail;
  `scrollBoxRef` defines the fixed repaint band.
  clean-room corroboration: the inspected Claude Code view derives the nearest preceding real user
  prompt and reserves one stable header row.
  consequence: derive user row spans in the same render pass, reserve a fixed header row, and convert
  a clicked prompt row into tail distance.

## Refuted hypotheses

- [refuted] “The long-input defect needs a scrollbar.”
  reason: the failure is a bypassed viewport plus missing caret navigation. A scrollbar would expose
  position but would not make arrows edit the text, and it would consume scarce terminal width.

- [refuted] “Live input usage is unknowable until the model finishes.”
  reason: both Codex App Server and Anthropic expose usage before the final turn/message event.

- [refuted] “Compact completed activity means deleting tool output.”
  reason: canonical tool output can remain intact while the default projection shows a one-line summary;
  errors and the expansion route remain available.

- [refuted] “Prompt jump requires rewriting session history or adding IDs to persisted messages.”
  reason: the rendered `Line` objects already have stable in-memory IDs and exact row counts for the
  current projection.

## Implementation decision

- Use one width-aware visual-line model for hard breaks and soft wrapping; render at most five rows
  around the caret. No scrollbar.
- Give `TextInput` `onHistoryUp`/`onHistoryDown` fallbacks. Consume Up/Down inside the editor whenever a
  visual caret move exists.
- Add optional `onUsage` to provider completion options. App Server publishes turn-delta snapshots
  while retaining `finishUsage()` as the single durable accounting value.
- Collapse only matched successful tool call/results; retain full text for Ctrl+O and keep failures
  expanded.
- Add a fixed one-row sticky prompt anchor while scrolled, backed by exact row spans and an exact jump.
- Verify pure behavior, React rendering, compiled ConPTY behavior, and the real modified `neko --yolo`.

## Verification checkpoint 2026-07-30

- [verified] The compiled composer now keeps exactly five visible rows, moves the logical caret upward,
  edits line 6, and scrolls line 7 out of view without a scrollbar.
  confidence: high · `scripts/e2e-composer-viewport.ts` against `dist/neko.exe` · 2026-07-30
- [verified] A real GPT-5.6 App Server turn now starts at `↑~10.6k`, later adopts exact non-zero usage,
  and never displays `↑0 ↓0`; unit coverage also proves final accounting occurs once.
  confidence: high · live authenticated `neko --yolo` + provider/agent tests · 2026-07-30
- [verified] FrameDiffer's advertised non-row-1 band contract was incomplete: compose, imperative repaint,
  shift detection, and hardware-scroll emission all indexed from row 0. A RED virtual-terminal test proved
  the overwrite; the corrected contract preserves row 1 with a band at `top=2` through compose and scroll.
  confidence: high · byte-level VT test + compiled ConPTY frame trace · 2026-07-30
- [verified] Measuring the conditional inner band creates a one-row React feedback loop; measuring the stable
  `header + band` wrapper removes the loop, while keeping the jump pill outside that measurement prevents
  Yoga from squashing the pill. Compiled ConPTY verification observed a stable sticky prompt and an exact
  click transition from band `top=2` to `top=1`.
  confidence: high · FrameDiffer simulation + real `neko --yolo --resume` · 2026-07-30
- [verified] Successful activity folds without information loss: Ctrl+O and `/transcript` retain full detail;
  failures/denials/blocked calls and current todo/plan state stay expanded.
  confidence: high · projection + fullscreen tests · 2026-07-30
- [verified] A usage snapshot and its visible stream buffer are not the same lifetime: provider-managed tools can
  flush the buffer without returning from `complete()`. A monotonic generated-character counter plus a snapshot
  baseline preserves the exact reported total and estimates only post-snapshot output (`100 → ~120` in RED/GREEN).
  confidence: high · managed-tool integration test + Codex PR review · 2026-07-30
- [verified] Sticky navigation must use the compositor's full row domain, including uncommitted stream rows. Using
  committed rows alone made the label and exact jump disagree mid-turn; a hanging-stream fullscreen test now keeps
  them aligned.
  confidence: high · fullscreen integration test + Codex PR review · 2026-07-30
- [verified] Re-wrapping once for every possible caret index is O(n²) and froze a 10,000-character draft for
  9.89 seconds. Recording hard-break/final caret stops in one wrap projection reduced the same move to 4.52 ms.
  confidence: high · RED/GREEN deterministic performance regression · 2026-07-30
- [verified] Collapsing a completed call by removing it and appending its result reorders mixed parallel tool
  outcomes. Replacing the call in place preserves the model's original call order while leaving failures expanded.
  confidence: high · mixed-call resume RED/GREEN test + CodeRabbit review · 2026-07-30
- [verified] Thread-cumulative usage needs a baseline update on rejected and aborted turns, not only successful
  returns; otherwise the next turn inherits the failed turn's entire delta. Cleanup and dispose now resynchronize
  before clearing the active turn.
  confidence: high · two-turn interrupted-usage RED/GREEN test + CodeRabbit review · 2026-07-30
- [verified] A provider without live usage still needs a fresh estimate for every tool-loop step. Reusing the
  first request's context and taking `max(booked, initial)` froze a second step at 5,000 tokens; publishing
  `booked + estimate(current messages)` from Agent raised the pending-step meter above 6,000 in the TUI test.
  confidence: high · Agent contract + hanging-provider TUI RED/GREEN tests + Codex PR review · 2026-07-30
- [verified] External tool failure state must cross string adapters. MCP `isError: true` with ordinary text
  was folded as success until the adapter preserved it as an `Error:` observation. Neko-native `(interrupted)`
  and `(no skill ...)` sentinels likewise need explicit failure classification. Fold labels also need tool-semantic
  arguments: search/glob name `pattern`, not the shared `path` fallback.
  confidence: high · MCP fixture + activity-summary RED/GREEN tests + Codex PR review · 2026-07-30
- [verified] Boundary ownership must be decided from adjacent visual-row existence, not whether a clamped
  caret lookup returns a different codepoint. Variation selectors and combining marks create equal-column
  logical stops that otherwise consume Up/Down inside a one-row grapheme.
  confidence: high · Ink input RED/GREEN test with U+FE0F and U+0301 + Codex PR review · 2026-07-30

## Open questions

- [open] Whether non-App-Server providers should expose additional early usage events.
  confidence: medium · pursue provider by provider; do not fake exactness.

- [open] Whether consecutive read/search summaries should be grouped across calls.
  confidence: low-medium · first measure the simpler one-success-one-line projection; grouping adds
  keyboard and expansion complexity.

## Claim boundary

This checkpoint supports a source-backed design and local production gates. It does not establish
“beyond SOTA”; that would require independent cross-product and cross-terminal usability benchmarks.
