/**
 * Rich, scrollable transcript for fullscreen mode: renders the real TranscriptLine components (markdown,
 * diffs, syntax highlight - same as inline) inside an app-owned viewport, so scrolled-back history reads
 * exactly like the live conversation. Not the flattened rows of ScrollRegion.
 *
 * How it scrolls without forking Ink's layout engine:
 *   - The viewport is a fixed-height Box with overflow:hidden.
 *   - Sticky-to-bottom (the common case) uses justifyContent:flex-end so the newest content pins to the
 *     bottom with NO height measurement and NO one-frame lag - the top simply clips.
 *   - When scrolled up, the content column gets marginTop:-offset (rows); Ink clips the overflow above.
 *   - `contentRef` is measured by the parent (measureElement) to learn the total height, for the
 *     scrollbar + the max scroll offset.
 *
 * Each line is memoized so scrolling (a margin change) doesn't re-parse markdown, and only a newly
 * appended line pays render cost. Layout of all mounted lines still runs each frame, which is fine for
 * the compaction-bounded threads this targets; virtualization (mount only the visible slice) is the
 * documented next step if huge threads ever need it.
 */
import { Box, Text } from "ink";
import { memo, type RefObject } from "react";

import type { NekoConfig } from "../adapters/config.ts";
import { ScrollBar } from "./scroll.tsx";
import { TranscriptLine, type Line } from "./transcript.tsx";

// Cap the rich (mounted) lines: unlike the append-only <Static>, every mounted TranscriptLine is
// re-laid-out each frame, so an unbounded thread would make streaming janky. We mount the most recent
// MAX_RICH_LINES richly (plenty of scrollback) and point at /transcript for older history. A resumed
// thread already arrives bounded, so this only bites a very long live session.
const MAX_RICH_LINES = 300;

const MemoLine = memo(function MemoLine({ line, cfg, cols }: { line: Line; cfg: NekoConfig; cols: number }) {
  return <Box width={cols}><TranscriptLine line={line} cfg={cfg} cols={cols} /></Box>;
});

export function RichTranscript({ lines, offset, viewH, width, cfg, total, sticky, contentRef }: {
  lines: Line[];
  offset: number;
  viewH: number;
  width: number;
  cfg: NekoConfig;
  total: number; // measured content height (rows); for the scrollbar + effective bottom offset
  sticky: boolean;
  contentRef: RefObject<any>;
}): React.ReactNode {
  const bodyW = Math.max(10, width - 2); // reserve the scrollbar gutter so wrapping (and height) is stable
  const maxOffset = Math.max(0, total - viewH);
  const hidden = Math.max(0, lines.length - MAX_RICH_LINES);
  const shown = hidden ? lines.slice(-MAX_RICH_LINES) : lines;
  return (
    <Box flexDirection="row" width={width} height={viewH}>
      <Box height={viewH} width={bodyW} overflow="hidden" flexDirection="column" justifyContent={sticky ? "flex-end" : "flex-start"}>
        <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={sticky ? 0 : -offset}>
          {hidden ? <Text dimColor>{`... ${hidden} earlier line${hidden > 1 ? "s" : ""} - /transcript for the full history ...`}</Text> : null}
          {shown.map((l) => <MemoLine key={l.id} line={l} cfg={cfg} cols={bodyW} />)}
        </Box>
      </Box>
      <ScrollBar offset={sticky ? maxOffset : offset} viewH={viewH} total={total} />
    </Box>
  );
}
