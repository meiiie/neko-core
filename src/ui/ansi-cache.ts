/**
 * ANSI line cache — render each transcript Line to styled terminal rows ONCE, then reuse the strings.
 *
 * Why: a rich TranscriptLine (markdown/diff/syntax) costs tens to hundreds of ms to lay out, and a
 * scrollable viewport re-lays-out everything mounted EVERY frame - measured ~1.2s/frame on a real
 * 123-message session. Inline mode never feels this because <Static> renders each line exactly once.
 * This cache gives the fullscreen viewport the same economics: pay the rich render once per line (in a
 * hidden off-screen Ink instance), keep the resulting ANSI rows, and let the viewport paste string rows
 * - O(viewport) plain-text work per frame, with the full rich appearance preserved in the ANSI codes.
 * (Same pattern as claude-code's staticRender/exportRenderer: components -> strings, clean-room.)
 *
 * The hidden instance renders to a fake stdout at the target width; rows come back pre-wrapped, so the
 * viewport never re-measures them. The cache is keyed per (line id, width) - a resize clears it and the
 * background warmer re-fills. Warming happens newest-first in idle chunks; anything not yet warmed
 * renders as a cheap plain fallback row and upgrades in place when its rich rows land.
 */
import { render } from "ink";
import { createElement } from "react";

import type { NekoConfig } from "../adapters/config.ts";
import { Box } from "ink";
import { TranscriptLine, type Line } from "./transcript.tsx";
import { styleFor } from "./scroll.tsx";

interface Hidden { rerender: (node: any) => void; unmount: () => void; out: { buf: string[]; columns: number } }

let hidden: Hidden | null = null;
let hiddenWidth = 0;

function ensureHidden(width: number): Hidden {
  if (hidden && hiddenWidth === width) return hidden;
  hidden?.unmount();
  const out: any = {
    columns: width,
    rows: 500,
    buf: [] as string[],
    write: (s: string) => { out.buf.push(s); },
    on: () => {}, off: () => {}, removeListener: () => {},
  };
  // debug:true = Ink writes the FULL frame synchronously on every render (no log-update diffing, no
  // 30fps throttle) - exactly what a capture-to-string instance needs (same flag ink-testing uses).
  // NOTE: stdin must be OMITTED entirely - passing `stdin: undefined` explicitly makes Ink emit empty
  // frames (found empirically; its option merge treats the explicit undefined as a value).
  const inst = render(createElement(Box, {}), { stdout: out, patchConsole: false, exitOnCtrlC: false, debug: true });
  hidden = { rerender: inst.rerender, unmount: inst.unmount, out };
  hiddenWidth = width;
  return hidden;
}

/** Render any React node to styled ANSI rows at `width` via the hidden Ink instance. Synchronous. */
export function renderNodeRows(node: any, width: number): string[] {
  const h = ensureHidden(width);
  h.out.buf.length = 0;
  h.rerender(createElement(Box, { width, flexDirection: "column" }, node));
  const frame = h.out.buf.length ? h.out.buf[h.out.buf.length - 1] : "";
  const rows = frame.split("\n");
  while (rows.length && rows[rows.length - 1] === "") rows.pop();
  return rows.length ? rows : [" "];
}

/** Render one Line to its styled rows at `width`. Synchronous (the hidden Ink commits in-line). */
export function renderLineRows(line: Line, width: number, cfg: NekoConfig): string[] {
  return renderNodeRows(createElement(TranscriptLine as any, { line, cfg, cols: width }), width);
}

/** Cheap synchronous fallback for a line whose rich rows haven't been warmed yet: one plain row in the
 * transcript's glyph style. Upgraded in place when the rich rows land. */
export function fallbackRows(line: Line): string[] {
  const { glyph } = styleFor(line.kind);
  const first = String(line.text).split("\n", 1)[0];
  return [glyph + first];
}

const cache = new Map<number, { width: number; rows: string[] }>();
let warmTimer: ReturnType<typeof setTimeout> | null = null;

export function getCachedRows(line: Line, width: number): string[] | null {
  const hit = cache.get(line.id);
  return hit && hit.width === width ? hit.rows : null;
}

/** Prime a newly committed rich line before it enters the fullscreen transcript. Streaming replies
 * are already shown as formatted Markdown; caching the final assistant line synchronously prevents a
 * one-frame fallback to raw `**markdown**` while the background warmer catches up. */
export function primeAnsiCache(line: Line, width: number, cfg: NekoConfig): void {
  try { cache.set(line.id, { width, rows: renderLineRows(line, width, cfg) }); }
  catch { cache.set(line.id, { width, rows: fallbackRows(line) }); }
}

export function clearAnsiCache(): void {
  cache.clear();
  if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
}

/** How many lines from the tail warm eagerly. Warming an ENTIRE marathon session used to render every
 * markdown line through the hidden instance - tens of seconds of saturated event loop that lagged
 * EVERYTHING (scroll, typing, streaming) in fullscreen on a long session. The tail window covers the
 * pinned view + normal scrollback; deeper history shows instant plain fallback rows and warms only
 * when scrolled near (the `center` option). */
export const WARM_WINDOW = 300;

/** Rows this line contributes right now (cached rich rows, else the 1-row fallback). */
export function rowsCountFor(line: Line, width: number): number {
  return getCachedRows(line, width)?.length ?? 1;
}

/**
 * Warm the cache at `width` in time-budgeted async chunks (never blocks the UI longer than one chunk;
 * 16ms gaps give input/stream events air between chunks). Scope: the LAST `WARM_WINDOW` lines, plus -
 * when `center` is given (the line index the user scrolled to) - a span around it. Newest-first.
 * Re-entrant: a new call supersedes the pending schedule. `onProgress` fires per chunk so the viewport
 * re-renders with upgraded rows.
 */
export function warmAnsiCache(lines: Line[], width: number, cfg: NekoConfig, onProgress: () => void, center?: number): void {
  if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
  const wanted = new Set<number>();
  for (let i = Math.max(0, lines.length - WARM_WINDOW); i < lines.length; i++) wanted.add(i);
  if (center !== undefined) {
    for (let i = Math.max(0, center - 80); i < Math.min(lines.length, center + 80); i++) wanted.add(i);
  }
  const missing = [...wanted].sort((a, b) => b - a).map((i) => lines[i]).filter((l) => l && !getCachedRows(l, width));
  if (!missing.length) return;
  let i = 0;
  const BUDGET_MS = 12; // render at least 1 line, then yield as soon as the budget is spent
  const step = () => {
    warmTimer = null;
    const t0 = performance.now();
    do {
      const l = missing[i++];
      try { cache.set(l.id, { width, rows: renderLineRows(l, width, cfg) }); } catch { cache.set(l.id, { width, rows: fallbackRows(l) }); }
    } while (i < missing.length && performance.now() - t0 < BUDGET_MS);
    onProgress();
    if (i < missing.length) warmTimer = setTimeout(step, 16);
  };
  warmTimer = setTimeout(step, 16);
}
