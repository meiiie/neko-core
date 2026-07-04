/**
 * RichView — the fullscreen transcript viewport: a window of PRE-RENDERED ANSI rows (see ansi-cache.ts),
 * bottom-anchored. Each transcript line was rendered rich (markdown/diffs/syntax) exactly ONCE off-screen;
 * what mounts here is plain <Text> rows of cached strings - so a frame costs O(viewport) string pastes,
 * NOT O(viewport) markdown layouts. That's the <Static> economics inside a scrollable viewport, and the
 * fix for the measured ~1.2s/frame lag when rich components were mounted directly.
 *
 * `dist` = rows between the viewport bottom and the live tail (0 = pinned). Rows are pre-wrapped to the
 * viewport width, so truncate-end never actually cuts (it guards resize races only).
 */
import { Box, Text } from "ink";
import { memo } from "react";

// memo: during streaming the parent re-renders per delta, but rows/dist/viewH/width only change on
// commits, warm upgrades, or scrolling - the viewport bails out of all pure-stream re-renders.
export const RichView = memo(function RichView({ rows, dist, viewH, width }: { rows: string[]; dist: number; viewH: number; width: number }): React.ReactNode {
  const end = Math.max(0, rows.length - dist);
  const start = Math.max(0, end - viewH);
  const shown = rows.slice(start, end);
  return (
    <Box height={viewH} width={width} overflow="hidden" flexDirection="column" justifyContent="flex-end">
      {shown.map((r, i) => (
        <Text key={start + i} wrap="truncate-end">{r.length ? r : " "}</Text>
      ))}
    </Box>
  );
});
