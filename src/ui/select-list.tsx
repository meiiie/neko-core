/**
 * SelectList — one reusable interactive picker (arrow keys + Enter + type-to-filter + Esc).
 * Used by /resume, /model, and any future chooser, so every picker behaves the same.
 */
import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface SelectItem {
  id: string;
  label: string;
  detail?: string;
}

/** A pending picker overlay (drives <SelectList>). */
export interface Overlay {
  title: string;
  items: SelectItem[];
  onSelect: (item: SelectItem) => void;
}

export function SelectList(props: {
  title: string;
  items: SelectItem[];
  onSelect: (item: SelectItem) => void;
  onCancel: () => void;
  cols: number;
  search?: boolean; // type-to-filter (default on)
}) {
  const { title, items, onSelect, onCancel, cols, search = true } = props;
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState("");

  const filtered = query
    ? items.filter((it) => (it.label + " " + (it.detail ?? "")).toLowerCase().includes(query.toLowerCase()))
    : items;
  const idx = Math.min(index, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) {
      if (filtered[idx]) onSelect(filtered[idx]);
      return;
    }
    if (key.upArrow) return setIndex(Math.max(0, idx - 1));
    if (key.downArrow) return setIndex(Math.min(filtered.length - 1, idx + 1));
    if (search) {
      if (key.backspace || key.delete) {
        setQuery((q) => [...q].slice(0, -1).join(""));
        setIndex(0);
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.tab) {
        setQuery((q) => q + input);
        setIndex(0);
      }
    }
  });

  const N = 8;
  const start = Math.max(0, Math.min(idx - 3, Math.max(0, filtered.length - N)));
  const rule = "─".repeat(Math.max(10, cols - 1));

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan">{title} ({filtered.length ? idx + 1 : 0} of {filtered.length})</Text>
      {search ? (
        <Text dimColor>  {query ? `search: ${query}` : "search… (type to filter)"}</Text>
      ) : null}
      <Text dimColor>{rule}</Text>
      {filtered.slice(start, start + N).map((it, k) => {
        const i = start + k;
        return (
          <Box key={it.id} flexDirection="column">
            <Text color={i === idx ? "cyan" : undefined} bold={i === idx}>
              {i === idx ? "> " : "  "}
              {it.label}
            </Text>
            {it.detail ? <Text dimColor>    {it.detail}</Text> : null}
          </Box>
        );
      })}
      <Text dimColor>{rule}</Text>
      <Text dimColor>↑/↓ select · Enter confirm · Esc cancel{search ? " · type to filter" : ""}</Text>
    </Box>
  );
}
