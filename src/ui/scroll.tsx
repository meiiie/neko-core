/**
 * Shared scroll primitives for an app-owned viewport: flatten Lines into fixed-height display rows,
 * a windowing hook with sticky-to-bottom auto-follow, and a ScrollRegion that renders the visible slice
 * plus a fractional scrollbar. Used by the /transcript overlay AND (Phase 2) fullscreen mode.
 *
 * Fixed-height rows (wrap long lines, clip noisy entries) make windowing O(1) - render only rows[off..
 * off+height] - so scrolling a huge thread never lays out hundreds of items. Rich variable-height
 * rendering of scrollback is a later phase; this is the fast, safe base.
 */
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";

import type { Line, LineKind } from "./transcript.tsx";

/** Per-kind glyph + color, mirroring the live transcript so a review reads the same as the session. */
export function styleFor(kind: LineKind): { glyph: string; color?: string; dim: boolean } {
  switch (kind) {
    case "user": return { glyph: "> ", color: "cyan", dim: false };
    case "assistant": return { glyph: "  ", color: "white", dim: false };
    case "tool_call": return { glyph: "● ", color: "green", dim: false };
    case "tool_result": return { glyph: "  └ ", dim: true };
    case "error": return { glyph: "✗ ", color: "red", dim: false };
    default: return { glyph: "  ", color: "gray", dim: true }; // info
  }
}

export interface Row { text: string; color?: string; dim: boolean }

/** Flatten Lines into fixed-width display rows: wrap long lines, clip a noisy entry to a few rows with a
 * "+N more" marker, blank separator between entries. Uniform rows -> trivial windowed scroll. */
export function flattenLines(lines: Line[], width: number): Row[] {
  const rows: Row[] = [];
  for (const l of lines) {
    if (l.kind === "welcome") continue;
    const { glyph, color, dim } = styleFor(l.kind);
    const body = l.kind === "tool_result" && l.summary ? l.summary : l.text;
    const wrap = Math.max(8, width - glyph.length);
    const segs: string[] = [];
    for (const raw of String(body).split("\n")) {
      if (!raw.length) { segs.push(""); continue; }
      for (let i = 0; i < raw.length; i += wrap) segs.push(raw.slice(i, i + wrap));
    }
    const clip = l.kind === "user" || l.kind === "assistant" ? 12 : 4;
    const shown = segs.slice(0, clip);
    shown.forEach((s, i) => rows.push({ text: (i === 0 ? glyph : " ".repeat(glyph.length)) + s, color, dim }));
    if (segs.length > clip) rows.push({ text: " ".repeat(glyph.length) + `… +${segs.length - clip} more lines`, color: "gray", dim: true });
    rows.push({ text: "", dim: false }); // separator between entries
  }
  return rows;
}

export interface ScrollApi {
  offset: number;      // top row index of the window
  maxOffset: number;
  atBottom: boolean;
  up: (n?: number) => void;
  down: (n?: number) => void;
  top: () => void;
  bottom: () => void;
  to: (row: number, center?: boolean) => void; // scroll so `row` is visible (optionally centered)
}

/** Windowing state: a top offset + sticky-to-bottom. While sticky (at the bottom), new content keeps the
 * view pinned to the bottom (chat auto-follow). Scrolling up breaks sticky and holds your position as
 * content grows below; scrolling back to the bottom re-arms sticky.
 *
 * While sticky the offset is DERIVED (pinned to maxOffset), not chased with an effect: the old
 * effect-based chase cost a second render per appended line during streaming (setState after paint),
 * and pinning is a pure function of total/viewH anyway. Handlers compute from the derived `off`, so
 * breaking sticky with a scroll-up starts exactly at the bottom, not at a stale stored offset. */
export function useScroll(total: number, viewH: number): ScrollApi {
  const maxOffset = Math.max(0, total - viewH);
  const [offset, setOffset] = useState(0);
  const [sticky, setSticky] = useState(true);
  const off = sticky ? maxOffset : Math.min(Math.max(0, offset), maxOffset);
  return {
    offset: off,
    maxOffset,
    atBottom: off >= maxOffset,
    up: (n = 1) => { setSticky(false); setOffset(Math.max(0, off - n)); },
    down: (n = 1) => { const v = Math.min(maxOffset, off + n); if (v >= maxOffset) setSticky(true); setOffset(v); },
    top: () => { setSticky(false); setOffset(0); },
    bottom: () => { setSticky(true); setOffset(maxOffset); },
    to: (row, center = true) => {
      // No upper clamp here: the derive above clamps at RENDER time, so a jump issued in the same frame
      // that `total` changes (e.g. entering history mode, which materializes the rows) lands right.
      setSticky(false);
      const target = center ? row - Math.floor(viewH / 2) : row;
      setOffset(Math.max(0, target));
    },
  };
}

export interface RowScrollApi {
  /** Rows between the viewport bottom and the live tail. 0 = pinned to the tail. */
  dist: number;
  scrolled: boolean;
  /** Accumulate a scroll of `n` rows (negative = up/older). Coalesced: any burst inside one frame
   * interval flushes as ONE state update, so a fast wheel spin moves far in a single render instead of
   * queueing a render per tick (the render-backlog "chasing the wheel" jank). */
  by: (n: number) => void;
  top: () => void;
  toBottom: () => void;
}

/** Row scrolling ANCHORED FROM THE END: position is the distance (in rows) from the live tail, so when
 * rows are inserted/upgraded ABOVE the viewport (the background ANSI warmer replacing fallback rows, or
 * simply history growing) the reading position holds rock-steady - an index-from-start anchor would
 * jump on every upstream change.
 *
 * Motion is a GLIDE, not a jump: wheel/key gestures move the TARGET; the shown position eases toward it
 * at ~60fps, covering half the remaining distance per frame (exponential ease-out, min 1 row). Each hop
 * repaints as a small hardware shift, so a fast flick reads as gliding momentum - the "smooth like a
 * GUI app" feel - instead of full-page teleports. The first hop fires immediately (no start latency). */
export function useRowScroll(totalRows: number, viewH: number, onHop?: (dist: number) => void, hopMs = 16): RowScrollApi {
  const [, force] = useState(0);
  const st = useRef<{ shown: number; target: number; timer: ReturnType<typeof setTimeout> | null }>({ shown: 0, target: 0, timer: null });
  const maxRef = useRef(0);
  maxRef.current = Math.max(0, totalRows - viewH); // clamp against the CURRENT size on every access
  const hopRef = useRef(onHop);
  hopRef.current = onHop; // latest-callback pattern: hops see current state without re-creating the loop
  const lastHopAt = useRef(0);
  useEffect(() => () => { if (st.current.timer) clearTimeout(st.current.timer); }, []);

  const step = () => {
    st.current.timer = null;
    // Drift-compensated cadence: timers fire LATE under load; subtract the measured overshoot from the
    // next delay so hops average the hopMs target instead of hopMs + event-loop latency (bench: 28ms
    // avg uncompensated at a 16ms target).
    const now = performance.now();
    const late = lastHopAt.current ? Math.max(0, now - lastHopAt.current - hopMs) : 0;
    lastHopAt.current = now;
    const s = st.current;
    s.target = Math.max(0, Math.min(maxRef.current, s.target));
    const d = s.target - s.shown;
    if (d === 0) return;
    const wasPinned = s.shown === 0;
    s.shown += d > 0 ? Math.max(1, Math.floor(d / 2)) : Math.min(-1, Math.ceil(d / 2));
    // The hot path: repaint DIRECTLY through the callback (differ band repaint, sub-ms) - React is cut
    // out of the per-hop loop entirely. Bench showed render+effect per hop cost 28-51ms between
    // repaints; direct hops run at the timer's 16ms. React still renders at the gesture EDGES (pill
    // mounts/unmounts, settle) - the only moments its output actually changes.
    if (hopRef.current) {
      hopRef.current(Math.min(s.shown, maxRef.current));
      const settled = s.shown === s.target;
      const pinnedChanged = wasPinned !== (s.shown === 0);
      if (settled || pinnedChanged) force((t) => t + 1);
    } else {
      force((t) => t + 1);
    }
    if (s.shown !== s.target) st.current.timer = setTimeout(step, Math.max(2, hopMs - late));
  };
  const kick = () => { lastHopAt.current = 0; if (!st.current.timer) step(); };
  return {
    dist: Math.min(st.current.shown, maxRef.current),
    scrolled: st.current.shown > 0 || st.current.target > 0,
    by: (n) => { // n>0 = toward the tail (dist shrinks); n<0 = up into history (dist grows)
      st.current.target = Math.max(0, Math.min(maxRef.current, st.current.target - n));
      kick();
    },
    top: () => { st.current.target = maxRef.current; kick(); },
    toBottom: () => { st.current.target = 0; kick(); },
  };
}

/** Split a row's text around case-insensitive matches of `q`, marking each match inverse (the current
 * match, at `currentRow`, gets a brighter inverse). Returns styled Text spans. */
function highlightRow(r: Row, q: string, isCurrent: boolean): React.ReactNode {
  if (!q) return <Text color={r.color} dimColor={r.dim} wrap="truncate-end">{r.text || " "}</Text>;
  const text = r.text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0, k = 0;
  while (i <= text.length) {
    const hit = lower.indexOf(ql, i);
    if (hit < 0) { parts.push(<Text key={k++} color={r.color} dimColor={r.dim}>{text.slice(i)}</Text>); break; }
    if (hit > i) parts.push(<Text key={k++} color={r.color} dimColor={r.dim}>{text.slice(i, hit)}</Text>);
    parts.push(<Text key={k++} inverse color={isCurrent ? "#e6932e" : undefined}>{text.slice(hit, hit + q.length)}</Text>);
    i = hit + q.length;
  }
  return <Text wrap="truncate-end">{parts}</Text>;
}

/** Render the visible window of rows in a fixed-height, single-column box. One Row = exactly one
 * terminal row (wrap="truncate-end"), so the layout CANNOT break or wrap sideways - this is what makes
 * scrolled-back history O(viewport) and misalignment-proof. No scrollbar (the jump-to-bottom pill is the
 * position affordance). Optionally highlights `highlight` matches and marks the row at `currentRow`. */
export function ScrollRegion({ rows, offset, height, width, highlight = "", currentRow }: { rows: Row[]; offset: number; height: number; width: number; highlight?: string; currentRow?: number }): React.ReactNode {
  const view = rows.slice(offset, offset + height);
  return (
    <Box flexDirection="column" width={width} height={height}>
      {Array.from({ length: height }, (_, i) => {
        const r = view[i];
        if (!r) return <Text key={i}> </Text>;
        return <Box key={i}>{highlightRow(r, highlight, offset + i === currentRow)}</Box>;
      })}
    </Box>
  );
}

