/**
 * TranscriptViewer — a scrollable, searchable read-only view of the WHOLE conversation, opened with
 * /transcript. It exists because an inline <Static> app writes to the terminal's NATIVE scrollback and
 * never receives scroll events: it cannot detect "user scrolled to the top" and cannot prepend earlier
 * messages there the way a GUI chat app (Messenger/Zalo) does. So instead of a fragile "load more on
 * scroll up", this gives the terminal-native answer - an in-app viewport with random access + find,
 * which is strictly more capable than incremental load-more. Esc returns to the REPL; native scrollback
 * is left untouched (we never wipe or reprint it).
 */
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";

import type { Line } from "./transcript.tsx";
import { flattenLines } from "./scroll.tsx";

export function TranscriptViewer({ lines, cols, rows: termRows, onClose }: { lines: Line[]; cols: number; rows: number; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const width = Math.max(20, cols - 2);
  const viewH = Math.max(3, termRows - 7); // leave room for border + header + hint + a little breathing space

  const q = query.trim().toLowerCase();
  const matched = q ? lines.filter((l) => l.text.toLowerCase().includes(q) || (l.summary ?? "").toLowerCase().includes(q)) : lines;
  const all = useMemo(() => flattenLines(matched, width), [matched, width]);
  const maxOffset = Math.max(0, all.length - viewH);
  const [offset, setOffset] = useState(maxOffset); // open at the BOTTOM (most recent), scroll up for older
  // Re-anchor when the content changes: a new search jumps to the first match (top); clearing it or a
  // resize snaps back to the bottom. Keeps offset valid so we never window past the ends.
  useEffect(() => { setOffset(q ? 0 : Math.max(0, all.length - viewH)); }, [q, all.length, viewH]);

  const off = Math.min(Math.max(0, offset), maxOffset);
  const window = all.slice(off, off + viewH);
  const atBottom = off >= maxOffset;
  const pos = maxOffset === 0 ? "all" : atBottom ? "end" : off === 0 ? "top" : `${Math.round((100 * off) / maxOffset)}%`;

  useInput((input, key) => {
    if (key.escape) { if (q) return setQuery(""); return onClose(); }
    if (key.upArrow) return setOffset((o) => Math.max(0, Math.min(o, maxOffset) - 1));
    if (key.downArrow) return setOffset((o) => Math.min(maxOffset, o + 1));
    if (key.pageUp) return setOffset((o) => Math.max(0, Math.min(o, maxOffset) - viewH));
    if (key.pageDown) return setOffset((o) => Math.min(maxOffset, o + viewH));
    if (key.ctrl && input === "u") return setQuery("");
    if (key.backspace || key.delete) return setQuery((s) => s.slice(0, -1));
    if (input && !key.ctrl && !key.meta && !key.tab && !key.return) return setQuery((s) => s + input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#4d9fff" paddingX={1} width={cols}>
      <Text>
        <Text bold color="#4d9fff">Conversation</Text>
        <Text dimColor>{"  "}{lines.length} entr{lines.length === 1 ? "y" : "ies"}{q ? ` · found ${matched.length}` : ""} · {pos}</Text>
      </Text>
      <Box flexDirection="column" height={viewH}>
        {window.length === 0 ? (
          <Text dimColor>{q ? `no lines match "${query.trim()}"` : "(empty)"}</Text>
        ) : (
          window.map((r, i) => (
            <Text key={off + i} color={r.color} dimColor={r.dim} wrap="truncate-end">{r.text || " "}</Text>
          ))
        )}
      </Box>
      <Text dimColor>
        {q ? `search: ${query.trim()} · ` : ""}↑↓ scroll · PgUp/PgDn page · type to search{q ? " · ctrl+u clear" : ""} · esc {q ? "clear/close" : "close"}
      </Text>
    </Box>
  );
}
