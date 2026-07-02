/**
 * Fullscreen scroll mode — a viewport over the transcript on stock Ink.
 *
 * Built on the display-row model (richwrap.tsx): the whole transcript is flattened to fixed 1-row lines
 * (cached per line id — committed lines never change), so a viewport is just `rows[top .. top+height]`.
 * No `<Static>` and no wrapping in the view => exact scroll math, and nothing leaks to scrollback. Enter
 * the terminal's alternate screen so the app owns the screen and restores it cleanly on exit.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { NekoConfig } from "../adapters/config.ts";
import { VERSION } from "../shared/version.ts";
import { RichRow, type Row, toRichLines, tokenizeInline, wrapSegs } from "./richwrap.tsx";
import type { Line } from "./transcript.tsx";

const BLANK: Row = [{ text: "" }];
const wrap = (segs: Row, cols: number): Row[] => wrapSegs(segs, cols);

/** One transcript line -> its display rows (with the same margins/summaries the inline renderer uses). */
export function lineToRows(line: Line, cols: number, cfg: NekoConfig): Row[] {
  switch (line.kind) {
    case "welcome":
      return [
        [{ text: "Neko Code", bold: true }, { text: ` v${VERSION}`, color: "#9a9a9a" }],
        [{ text: `${(cfg.model || "no model").split("/").pop()} · ${cfg.provider} · ${cfg.profile ?? "no profile"}${cfg.effort ? ` · ${cfg.effort} effort` : ""}`, color: "#9a9a9a" }],
        [{ text: process.cwd(), color: "#9a9a9a" }],
        BLANK,
      ];
    case "user":
      return [BLANK, ...wrap([{ text: "> ", color: "cyan" }, ...tokenizeInline(line.text).map((s) => ({ ...s, color: s.color ?? "cyan" }))], cols)];
    case "assistant":
      return [BLANK, ...toRichLines(line.text, cols), BLANK];
    case "tool_call":
      return [BLANK, ...wrap([{ text: "● ", color: "green" }, { text: line.text }], cols)];
    case "info":
      return wrap([{ text: line.text, dim: true }], cols);
    case "error":
      return wrap([{ text: "✗ ", color: "red" }, { text: line.text, color: "red" }], cols);
    case "tool_result_full":
      return toolResultRows(line.text.split("\n"), cols, false);
    case "tool_result": {
      if (line.summary) {
        const more = line.text.split("\n").length > 1;
        return wrap([{ text: `  └ ${line.summary}${more ? " (ctrl+o to expand)" : ""}`, dim: true }], cols);
      }
      return toolResultRows(line.text.split("\n"), cols, true);
    }
    default:
      return wrap([{ text: line.text, color: "gray" }], cols);
  }
}

/** Render tool output lines with the └/indent prefixes + diff +/- coloring; collapse at 8 lines when asked. */
function toolResultRows(all: string[], cols: number, collapse: boolean): Row[] {
  const isError = /^(Error|Blocked|Denied|Refused)/.test(all[0] ?? "");
  const CAP = 8;
  const hidden = collapse ? all.length - CAP : 0;
  const shown = hidden > 0 ? all.slice(0, CAP) : all;
  const out: Row[] = [];
  shown.forEach((l, i) => {
    const add = l.startsWith("+") || /^\s*\d+ \+ /.test(l);
    const del = l.startsWith("-") || /^\s*\d+ - /.test(l);
    const color = isError ? "red" : add ? "green" : del ? "red" : undefined;
    const dim = !isError && !add && !del;
    out.push(...wrap([{ text: (i === 0 ? "  └ " : "     ") + l, color, dim }], cols));
  });
  if (hidden > 0) out.push(...wrap([{ text: `     … +${hidden} lines (ctrl+o to expand)`, dim: true }], cols));
  return out;
}

/** Flatten the transcript to display rows, caching committed lines by id (they never change). */
export function linesToRows(lines: Line[], cols: number, cfg: NekoConfig, cache: Map<number, Row[]>): Row[] {
  const out: Row[] = [];
  for (const line of lines) {
    let rows = cache.get(line.id);
    if (!rows) { rows = lineToRows(line, cols, cfg); cache.set(line.id, rows); }
    out.push(...rows);
  }
  return out;
}

/** A fixed-height window over `rows` starting at `top` (each row is exactly one terminal line). */
export function ScrollView({ rows, top, height }: { rows: Row[]; top: number; height: number }): ReactNode {
  const slice = rows.slice(top, top + height);
  // pad so the input stays pinned to the bottom even when the transcript is shorter than the viewport
  const pad = Math.max(0, height - slice.length);
  return (
    <Box flexDirection="column" height={height} flexShrink={0}>
      {Array.from({ length: pad }, (_, i) => <Text key={`p${i}`}> </Text>)}
      {slice.map((r, i) => <RichRow key={top + i} row={r} />)}
    </Box>
  );
}

/** Enter/leave the alternate screen buffer (fullscreen; restores scrollback on exit). */
export const enterAltScreen = (write: (s: string) => void) => write("\x1b[?1049h\x1b[H");
export const leaveAltScreen = (write: (s: string) => void) => write("\x1b[?1049l");
