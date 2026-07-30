# Transcript input isolation and terminal viewport behavior

Research checkpoint: 2026-07-30

Scope: Neko Core `/transcript` under Windows Terminal/ConPTY. The failure under investigation is a
mouse movement or wheel report becoming visible search text. This ledger distinguishes terminal input
classification from transcript storage, rendering, and search.

## Checkpoint 2026-07-30

Current best model:

1. Terminal control reports are typed input events, not text.
2. Classify and consume pointer reports before any text state mutation.
3. Keep one input owner for the active overlay and route only the event classes it supports.
4. Preserve the canonical transcript; window only the rendered projection.
5. Optimize search or rendering only after measuring them independently from input corruption.

## Findings

- [verified] The screenshot payload `[<65;86;26M` is an SGR mouse-wheel report with the leading ESC
  removed: button code 65 is wheel down, followed by terminal coordinates x=86 and y=26.
  confidence: high · checked 2026-07-30
  sources:
  - XTerm Control Sequences, SGR mouse mode 1006
    (https://invisible-island.net/xterm/ctlseqs/ctlseqs.html, patch level 410 dated 2026-04-19)
  - Neko's existing `parseWheelAll` and `parseLastPointer` tests cover the same grammar with and without
    ESC (`test/mouse.test.ts`)
  consequence: deleting ANSI from stored transcript data would operate on the wrong layer.

- [verified] Ink 7.1.x exposes unknown CSI/SGR reports to `useInput` as strings and removes a leading
  ESC before invoking the handler.
  confidence: high · checked 2026-07-30
  sources:
  - Ink `src/input-parser.ts` and `src/hooks/use-input.ts` on current main
    (https://github.com/vadimdemedes/ink/tree/main/src)
  - Ink v7.1.1 release, 2026-07-16
    (https://github.com/vadimdemedes/ink/releases/tag/v7.1.1)
  local evidence: Neko uses Ink 7.1.0; the component reproduction received
  `[<65;86;26M` and appended it to `TranscriptViewer.query`.
  consequence: a component using `useInput` must classify pointer reports before its printable-text
  fallback. Upgrading from 7.1.0 to 7.1.1 does not supply that boundary.

- [verified] OpenAI Codex currently converts terminal input to typed crossterm events at one shared
  input boundary and drops unmapped mouse events before they reach transcript/pager overlay state.
  confidence: high · checked 2026-07-30 at commit
  `b545c94041017d000e2c8b2f6272705d21b85dfb`
  sources:
  - `codex-rs/tui/src/tui/event_stream.rs`
    (https://github.com/openai/codex/blob/main/codex-rs/tui/src/tui/event_stream.rs)
  - `codex-rs/tui/src/pager_overlay.rs`
    (https://github.com/openai/codex/blob/main/codex-rs/tui/src/pager_overlay.rs)
  consequence: Neko should emulate the invariant, not the Rust architecture: pointer input must not
  fall through to search text, and the active overlay should remain the only consumer.

- [verified] Ratatui's current application model also treats mouse, key, resize, and paste as distinct
  event variants rather than one printable stream.
  confidence: high · checked 2026-07-30
  sources:
  - Ratatui application/event handling documentation (https://ratatui.rs/concepts/application-patterns/)
  - Ratatui v0.30.2 release, 2026-06-19
    (https://github.com/ratatui/ratatui/releases/tag/ratatui-v0.30.2)
  consequence: the portable design principle is event classification before state mutation.

- [verified] Replacing the whole terminal model is not a prerequisite for fixing this defect.
  confidence: medium-high · checked 2026-07-30
  sources:
  - OpenAI Codex maintainers documented the scrollback/select/copy/multiplexer tradeoffs of a fully
    owned viewport and removed the experimental `tui2` default
    (https://github.com/openai/codex/issues/8344, updated 2026-01-22)
  - Ink still has no first-class scrolling primitive in the open scrolling API discussion
    (https://github.com/vadimdemedes/ink/issues/773, checked 2026-07-30)
  consequence: keep Neko's existing bounded transcript viewport and repair its event boundary.

- [verified] The failure reproduces in both the component harness and the shipped execution path.
  confidence: high · 2026-07-30
  local evidence:
  - `TranscriptViewer` rendered `found 0` and the exact mouse reports after injected SGR input
  - `dist/neko.exe --yolo --resume <session>` under Bun.Terminal/ConPTY reproduced the screenshot-like
    flood with `neko-core 0.22.1`
  consequence: this is not screenshot corruption, terminal font behavior, or a simulated-only issue.

- [verified] Transcript rendering already windows the flattened rows with
  `all.slice(offset, offset + viewHeight)` and keeps the canonical `Line[]` unchanged.
  confidence: high · local source inspected 2026-07-30
  consequence: pointer scrolling can update only `offset`; no transcript rewrite or eager full-row
  repaint is required.

## Refuted hypotheses

- [refuted] “The session or transcript contains broken ANSI that must be scrubbed.”
  reason: the payload appears only after a live pointer event mutates the search query. The same stored
  session opens normally until the input is injected.

- [refuted] “Mouse motion is being replayed as provider thinking.”
  reason: the bytes match XTerm SGR mouse grammar exactly and arrive through `useInput`; no provider or
  persisted-message field participates.

- [refuted] “An Ink upgrade to 7.1.1 fixes the bug.”
  reason: the 7.1.1 source retains the same CSI parsing and ESC-stripping behavior, and its release
  changes do not add typed mouse delivery.

- [refuted] “A complete virtualized-viewer rewrite is needed before `/transcript` can be stable.”
  reason: the content is already viewport-windowed. The observed corruption occurs before rendering,
  at the missing pointer/text classification branch.

## Implemented decision

- `TranscriptViewer` parses the full wheel burst first and updates `offset` by three rows per net tick.
- Every other recognized pointer report (press, release, motion, and cancelling wheel bursts) is consumed.
- Navigation keys and printable search text are processed only after that pointer boundary.
- Canonical transcript lines remain unchanged; normal type-to-search remains covered by a component test.
- A reusable `scripts/e2e-transcript-pointer.ts` gate exercises the compiled binary under Bun.Terminal/
  ConPTY with the exact field payload.

Verified on 2026-07-30 across two rounds with the newly built Windows binary:

- 561 entries: open 179–280 ms, first pointer response 51–81 ms, search 61–74 ms;
- 5,000 entries: open 235–333 ms, first pointer response 50–80 ms, search 62–91 ms;
- no run rendered a raw SGR report or `found 0`; every run found the ordinary `NEEDLE` query.

These ranges are local gate evidence, not an independent product comparison.

## Open questions

- [open] Ink may eventually expose typed mouse events directly.
  confidence: low · revisit on a future Ink release; a local classification boundary is still required
  for current supported versions.

- [open] Large-query search could pre-index lowercase text if a measured session benchmark shows input
  latency outside the project budget.
  confidence: low · do not mix this speculative optimization into the pointer correctness fix.

## Claim boundary

This checkpoint supports a source-backed, production-grade event-isolation design. It does not establish
“beyond SOTA”: that label would require independent cross-terminal benchmarks against comparable TUIs,
not only passing Neko's own tests.
