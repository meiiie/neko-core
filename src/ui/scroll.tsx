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
import { useMemo, useState } from "react";

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
      setSticky(false);
      const target = center ? row - Math.floor(viewH / 2) : row;
      setOffset(Math.max(0, Math.min(target, maxOffset)));
    },
  };
}

/** A 1-column fractional scrollbar: thumb size + position reflect how much is off-screen. Shared by the
 * flat ScrollRegion and the rich transcript so both look the same. Renders nothing when it all fits. */
export function ScrollBar({ offset, viewH, total }: { offset: number; viewH: number; total: number }): React.ReactNode {
  if (total <= viewH) return <Box width={2} height={viewH} />; // keep the gutter so body width is stable
  const thumbSize = Math.max(1, Math.round((viewH * viewH) / total));
  const maxOffset = Math.max(1, total - viewH);
  const thumbStart = Math.round((Math.min(offset, maxOffset) / maxOffset) * (viewH - thumbSize));
  return (
    <Box flexDirection="column" width={2} height={viewH}>
      {Array.from({ length: viewH }, (_, i) => {
        const on = i >= thumbStart && i < thumbStart + thumbSize;
        return <Text key={i} color={on ? "#4d9fff" : "#3a3a3a"}>{on ? " █" : " │"}</Text>;
      })}
    </Box>
  );
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

/** Render the visible window of rows in a fixed-height box, with a 1-column fractional scrollbar on the
 * right (thumb size + position reflect how much is off-screen). Optionally highlights `highlight` matches
 * and marks the row at `currentRow`. Pure view - the parent owns `offset`. */
export function ScrollRegion({ rows, offset, height, width, highlight = "", currentRow }: { rows: Row[]; offset: number; height: number; width: number; highlight?: string; currentRow?: number }): React.ReactNode {
  const view = rows.slice(offset, offset + height);
  const total = rows.length;
  const bodyW = Math.max(4, width - 2); // reserve the scrollbar gutter (stable width -> stable wrapping)
  return (
    <Box flexDirection="row" width={width} height={height}>
      <Box flexDirection="column" width={bodyW} height={height}>
        {Array.from({ length: height }, (_, i) => {
          const r = view[i];
          if (!r) return <Text key={i}> </Text>;
          return <Box key={i}>{highlightRow(r, highlight, offset + i === currentRow)}</Box>;
        })}
      </Box>
      <ScrollBar offset={offset} viewH={height} total={total} />
    </Box>
  );
}

/** Convenience for a memoized flatten keyed on lines+width. */
export function useFlattened(lines: Line[], width: number): Row[] {
  return useMemo(() => flattenLines(lines, width), [lines, width]);
}
