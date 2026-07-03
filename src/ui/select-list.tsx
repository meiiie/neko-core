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
  preview?: string; // shown in a panel when Space is pressed
}

/** A pending picker overlay (drives <SelectList>). */
export interface Overlay {
  title: string;
  items: SelectItem[];
  onSelect: (item: SelectItem) => void;
  onCtrlA?: () => void; // optional secondary action (e.g. /resume "all projects")
  ctrlAHint?: string;
  onRename?: (item: SelectItem, newName: string) => void; // Ctrl+R rename
  getPreview?: (item: SelectItem) => string; // computed LAZILY (only when Space is pressed) - avoids
  // building a preview for every item upfront (e.g. loading every session transcript to show a menu).
}

export function SelectList(props: {
  title: string;
  items: SelectItem[];
  onSelect: (item: SelectItem) => void;
  onCancel: () => void;
  cols: number;
  search?: boolean; // type-to-filter (default on)
  onCtrlA?: () => void;
  ctrlAHint?: string;
  onRename?: (item: SelectItem, newName: string) => void;
  getPreview?: (item: SelectItem) => string;
}) {
  const { title, items, onSelect, onCancel, cols, search = true, onCtrlA, ctrlAHint, onRename, getPreview } = props;
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [lazyPreview, setLazyPreview] = useState<Record<string, string>>({}); // id -> preview, filled on demand
  const [renaming, setRenaming] = useState<string | null>(null); // rename buffer; null = not renaming

  const filtered = query
    ? items.filter((it) => (it.label + " " + (it.detail ?? "")).toLowerCase().includes(query.toLowerCase()))
    : items;
  const idx = Math.min(index, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    // Rename mode owns the keyboard until Enter/Esc.
    if (renaming !== null) {
      if (key.return) {
        if (filtered[idx] && onRename) onRename(filtered[idx], renaming);
        return setRenaming(null);
      }
      if (key.escape) return setRenaming(null);
      if (key.backspace || key.delete) return setRenaming((r) => [...(r ?? "")].slice(0, -1).join(""));
      if (input && !key.ctrl && !key.meta && !key.tab) return setRenaming((r) => (r ?? "") + input);
      return;
    }
    if (key.escape) return onCancel();
    if (key.return) {
      if (filtered[idx]) onSelect(filtered[idx]);
      return;
    }
    if (key.upArrow) return setIndex(Math.max(0, idx - 1));
    if (key.downArrow) return setIndex(Math.min(filtered.length - 1, idx + 1));
    if (input === " ") { // Space toggles the preview panel (computing this item's preview lazily on first view)
      const it = filtered[idx];
      if (it && getPreview && lazyPreview[it.id] === undefined) {
        setLazyPreview((m) => ({ ...m, [it.id]: getPreview(it) }));
      }
      return setShowPreview((p) => !p);
    }
    if (onCtrlA && key.ctrl && (input === "a" || input === "\x01")) return onCtrlA();
    if (onRename && key.ctrl && (input === "r" || input === "\x12")) return setRenaming(filtered[idx]?.label ?? "");
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
      {renaming !== null ? (
        <Text>  rename: <Text color="cyan">{renaming}</Text><Text inverse> </Text></Text>
      ) : search ? (
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
      {(() => {
        if (!showPreview || !filtered[idx]) return null;
        const pv = filtered[idx].preview ?? lazyPreview[filtered[idx].id];
        if (!pv) return null;
        return (
          <Box flexDirection="column" marginBottom={1}>
            {pv.split("\n").slice(0, 12).map((l, i) => (
              <Text key={i} dimColor>{l}</Text>
            ))}
            <Text dimColor>{rule}</Text>
          </Box>
        );
      })()}
      <Text dimColor>
        {renaming !== null
          ? "Enter save · Esc cancel rename"
          : `↑/↓ select · Enter confirm · Space preview${onCtrlA ? ` · Ctrl+A ${ctrlAHint ?? "more"}` : ""}${onRename ? " · Ctrl+R rename" : ""} · Esc cancel${search ? " · type to filter" : ""}`}
      </Text>
    </Box>
  );
}
