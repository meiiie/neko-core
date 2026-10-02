/**
 * TranscriptViewer — a scrollable, searchable read-only view of the WHOLE conversation, opened with
 * /transcript. It exists because an inline <Static> app writes to the terminal's NATIVE scrollback and
 * never receives scroll events: it cannot detect "user scrolled to the top" and cannot prepend earlier
 * messages there the way a GUI chat app (Messenger/Zalo) does. So instead of a fragile "load more on
 * scroll up", this gives the terminal-native answer - an in-app viewport with random access + find,
 * with bounded viewport rendering. Esc returns to the REPL; native scrollback
 * is left untouched (we never wipe or reprint it).
 */
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Line } from "./transcript.tsx";
import { TranscriptLayout } from "./transcript-layout.ts";
import { parseLastPointer, parseWheelAll } from "./mouse.ts";

export function TranscriptViewer({ lines, cols, rows: termRows, onClose, title = "Conversation", unabridged = false }: { lines: Line[]; cols: number; rows: number; onClose: () => void; title?: string; unabridged?: boolean }) {
  const [query, setQuery] = useState("");
  const width = Math.max(20, cols - 2);
  const viewH = Math.max(3, termRows - 7); // leave room for border + header + hint + a little breathing space

  const q = query.trim();
  const immediate = useMemo(() => {
    let bytes = 0;
    for (const line of lines) {
      bytes += line.text.length;
      if (bytes > 16_000) return null;
    }
    return new TranscriptLayout(lines, width);
  }, [lines, width]);
  const [prepared, setPrepared] = useState<{ lines: Line[]; width: number; layout: TranscriptLayout } | null>(null);
  const [loadError, setLoadError] = useState("");
  const loaded = immediate ?? (prepared?.lines === lines && prepared.width === width ? prepared.layout : null);
  const layout = useMemo(() => loaded ?? new TranscriptLayout([], width), [loaded, width]);
  useEffect(() => {
    setLoadError("");
    if (immediate) return;
    const controller = new AbortController();
    void TranscriptLayout.create(lines, width, controller.signal).then((value) => {
      if (!controller.signal.aborted) setPrepared({ lines, width, layout: value });
    }).catch((error) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [lines, width, immediate]);
  const matches = useMemo(() => layout.find(q), [layout, q]);
  const [matchIndex, setMatchIndex] = useState(0);
  const maxOffset = Math.max(0, layout.totalRows - viewH);
  const [offset, setOffset] = useState(unabridged ? 0 : maxOffset);
  const off = Math.min(Math.max(0, offset), maxOffset);
  const window = layout.window(off, viewH);
  const atBottom = off >= maxOffset;
  const pos = maxOffset === 0 ? "all" : atBottom ? "end" : off === 0 ? "top" : `${Math.round((100 * off) / maxOffset)}%`;

  const previousView = useRef<{ layout: TranscriptLayout; offset: number; bottom: boolean; query: string; height: number } | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const previous = previousView.current;
    let next = off;
    if (!previous || previous.query !== q) {
      setMatchIndex(0);
      next = q ? (matches[0] ?? 0) : unabridged ? 0 : maxOffset;
    } else if (previous.layout !== layout || previous.height !== viewH) {
      next = previous.bottom ? maxOffset : layout.resolve(previous.layout.anchor(previous.offset));
    }
    next = Math.min(Math.max(0, next), maxOffset);
    previousView.current = { layout, offset: next, bottom: next >= maxOffset, query: q, height: viewH };
    if (next !== offset) setOffset(next);
  }, [loaded, layout, q, viewH, offset, unabridged, maxOffset, matches]);

  useInput((input, key) => {
    // Ink exposes SGR mouse reports as input strings (usually after stripping ESC). Classify them
    // before the printable-text fallback so pointer bytes can never become a search query.
    const wheel = parseWheelAll(input);
    if (wheel) {
      const delta = wheel.count * 3;
      setOffset((o) => Math.min(maxOffset, Math.max(0, o + (wheel.dir === "up" ? -delta : delta))));
      return;
    }
    if (parseLastPointer(input)) return; // consume clicks, releases, motion, and cancelling wheel bursts
    if (key.escape) { if (q) return setQuery(""); return onClose(); }
    if (key.upArrow) return setOffset((o) => Math.max(0, Math.min(o, maxOffset) - 1));
    if (key.downArrow) return setOffset((o) => Math.min(maxOffset, o + 1));
    if (key.pageUp) return setOffset((o) => Math.max(0, Math.min(o, maxOffset) - viewH));
    if (key.pageDown) return setOffset((o) => Math.min(maxOffset, o + viewH));
    if (key.tab && matches.length) {
      const next = (matchIndex + (key.shift ? -1 : 1) + matches.length) % matches.length;
      setMatchIndex(next);
      setOffset(matches[next]);
      return;
    }
    if (key.ctrl && input === "u") return setQuery("");
    if (key.backspace || key.delete) return setQuery((s) => s.slice(0, -1));
    if (input && !key.ctrl && !key.meta && !key.tab && !key.return) return setQuery((s) => s + input);
  });

  return (
    <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor="#4d9fff" paddingX={1} width={cols}>
      <Text wrap="truncate-end">
        <Text bold color="#4d9fff">{title}</Text>
        <Text dimColor>{"  "}{lines.length} entr{lines.length === 1 ? "y" : "ies"}{q ? ` · found ${matches.length}` : ""} · {pos}</Text>
      </Text>
      <Box flexDirection="column" height={viewH} flexShrink={0}>
        {!loaded ? (
          <Text dimColor>{loadError ? `Could not load transcript: ${loadError}` : "Loading transcript… Esc to cancel"}</Text>
        ) : window.length === 0 || (q && matches.length === 0) ? (
          <Text dimColor>{q ? `no lines match "${query.trim()}"` : "(empty)"}</Text>
        ) : (
          window.map((r, i) => (
            <Text key={off + i} color={r.color} dimColor={r.dim} wrap="truncate-end">{r.text || " "}</Text>
          ))
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        {q ? `search: ${query.trim()} · ` : ""}↑↓ scroll · PgUp/PgDn page · type to search{q ? " · tab/shift+tab next/previous · ctrl+u clear" : ""} · esc {q ? "clear/close" : "close"}
      </Text>
    </Box>
  );
}
