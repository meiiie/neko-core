/**
 * RichView — the fullscreen transcript viewport: a window of lines rendered with the real TranscriptLine
 * components (markdown, diffs, syntax highlight - same as inline), bottom-anchored with flex-end so the
 * newest visible content sits at the bottom and the top simply clips.
 *
 * `bottom` (exclusive line index) picks the window; null = pinned to the live tail. Scrolling is just a
 * different slice of the SAME rich rendering - scrolled-back history looks identical to the live view,
 * no flat-mode flash. The per-frame cost is O(viewport), NOT O(conversation): only the slice's
 * viewH + TAIL_BUFFER lines are mounted, so a 121-message (or 10,000-message) session scrolls and
 * streams like an empty one. That bound is the whole design - mounting the entire thread rich froze
 * real sessions.
 *
 * Each line is memoized so an append/scroll only pays markdown for lines entering the window.
 */
import { Box } from "ink";
import { memo } from "react";

import type { NekoConfig } from "../adapters/config.ts";
import { TranscriptLine, type Line } from "./transcript.tsx";

// How many lines past the viewport height to mount: every Line renders >= 1 row (most render 2+ with
// margins), so viewH + 8 lines always over-fills the viewport when that much history exists.
const TAIL_BUFFER = 8;

const MemoLine = memo(function MemoLine({ line, cfg, cols }: { line: Line; cfg: NekoConfig; cols: number }) {
  return <Box width={cols}><TranscriptLine line={line} cfg={cfg} cols={cols} /></Box>;
});

export function RichView({ lines, bottom, viewH, width, cfg }: { lines: Line[]; bottom: number | null; viewH: number; width: number; cfg: NekoConfig }): React.ReactNode {
  const end = bottom ?? lines.length;
  const shown = lines.slice(Math.max(0, end - (viewH + TAIL_BUFFER)), end);
  return (
    <Box height={viewH} width={width} overflow="hidden" flexDirection="column" justifyContent="flex-end">
      <Box flexDirection="column" flexShrink={0}>
        {shown.map((l) => <MemoLine key={l.id} line={l} cfg={cfg} cols={width} />)}
      </Box>
    </Box>
  );
}
