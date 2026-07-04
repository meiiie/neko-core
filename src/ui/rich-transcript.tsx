/**
 * RichTail — the fullscreen transcript while pinned to the bottom (the normal state): the LAST few lines
 * rendered with the real TranscriptLine components (markdown, diffs, syntax highlight - same as inline),
 * bottom-anchored with flex-end so the newest content is always visible and the top simply clips.
 *
 * The per-frame cost is O(viewport), NOT O(conversation): only the last TAIL_BUFFER-past-the-viewport
 * lines are mounted, so a 121-message (or 10,000-message) session streams as smoothly as an empty one.
 * That bound is the whole design - the earlier approach mounted the entire thread rich and re-laid it
 * out every frame, which froze real sessions. Scrolled-back reading is the flat O(viewport) window in
 * scroll.tsx (ScrollRegion); this component never scrolls.
 *
 * Each line is memoized so an append only pays for the new line's markdown; a slice shift re-uses the
 * other elements (stable ids + object identity).
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

export function RichTail({ lines, viewH, width, cfg }: { lines: Line[]; viewH: number; width: number; cfg: NekoConfig }): React.ReactNode {
  const shown = lines.slice(-(viewH + TAIL_BUFFER));
  return (
    <Box height={viewH} width={width} overflow="hidden" flexDirection="column" justifyContent="flex-end">
      <Box flexDirection="column" flexShrink={0}>
        {shown.map((l) => <MemoLine key={l.id} line={l} cfg={cfg} cols={width} />)}
      </Box>
    </Box>
  );
}
