/**
 * SelectList — one reusable interactive picker (arrow keys + Enter + type-to-filter + Esc).
 * Used by /resume, /model, and any future chooser, so every picker behaves the same.
 */
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

import { HIT_SENTINEL } from "./frame-diff.ts";
import { hitIndexAt } from "./hit-targets.ts";
import { parseLastPointer, parseWheelAll } from "./mouse.ts";
import { isEscapeResidue } from "./text-input.tsx";

export interface SelectItem {
  id: string;
  label: string;
  detail?: string;
  preview?: string; // shown in a panel when Space is pressed
}

/** A pending picker overlay (drives <SelectList>). */
export interface Overlay {
  title: string;
  description?: string;
  items: SelectItem[];
  onSelect: (item: SelectItem) => void;
  onCancel?: () => void;
  search?: boolean;
  showCount?: boolean;
  onCtrlA?: () => void; // optional secondary action (e.g. /resume "all projects")
  ctrlAHint?: string;
  onRename?: (item: SelectItem, newName: string) => void; // Ctrl+R rename
  getPreview?: (item: SelectItem) => string; // computed LAZILY (only when Space is pressed) - avoids
  // building a preview for every item upfront (e.g. loading every session transcript to show a menu).
}

export function SelectList(props: {
  title: string;
  description?: string;
  items: SelectItem[];
  onSelect: (item: SelectItem) => void;
  onCancel: () => void;
  cols: number;
  search?: boolean; // type-to-filter (default on)
  showCount?: boolean;
  onCtrlA?: () => void;
  ctrlAHint?: string;
  onRename?: (item: SelectItem, newName: string) => void;
  getPreview?: (item: SelectItem) => string;
}) {
  const { title, description, items, onSelect, onCancel, cols, search = true, showCount = true, onCtrlA, ctrlAHint, onRename, getPreview } = props;
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [lazyPreview, setLazyPreview] = useState<Record<string, string>>({}); // id -> preview, filled on demand
  const [renaming, setRenaming] = useState<string | null>(null); // rename buffer; null = not renaming

  // A nested flow can replace one picker with another without unmounting this component. Its search
  // query belongs to the old list (e.g. "openai" must not filter the following auth-method list).
  useEffect(() => {
    setIndex(0);
    setQuery("");
    setShowPreview(false);
    setRenaming(null);
  }, [title]);

  const filtered = query
    ? items.filter((it) => (it.label + " " + (it.detail ?? "")).toLowerCase().includes(query.toLowerCase()))
    : items;
  const idx = Math.min(index, Math.max(0, filtered.length - 1));
  // Visible window (computed BEFORE useInput so the pointer handler maps hit zones to items).
  const N = 8;
  const start = Math.max(0, Math.min(idx - 3, Math.max(0, filtered.length - N)));

  useInput((input, key) => {
    // Mouse: each visible item row is a hit zone (HIT_SENTINEL anchor recorded by the differ from
    // the LAST PAINTED frame). Hover follows the pointer, a left click selects + confirms, and the
    // wheel moves the cursor. Zones are indexed in visible order, so item = filtered[start + zone].
    // No differ (inline mode / tests) -> no zones -> pointer input is consumed harmlessly.
    const ptr = parseLastPointer(input);
    if (ptr) {
      if (renaming !== null) return;
      const zone = hitIndexAt(ptr.x, ptr.y);
      if (ptr.kind === "move") {
        if (zone >= 0 && start + zone < filtered.length) setIndex(start + zone);
        return;
      }
      if (ptr.kind === "press" && ptr.left && zone >= 0) {
        const it = filtered[start + zone];
        if (it) { setIndex(start + zone); onSelect(it); }
      }
      return; // release / other buttons: consumed, never type-to-filter residue
    }
    const wheel = parseWheelAll(input);
    if (wheel) {
      if (renaming === null) setIndex(Math.max(0, Math.min(filtered.length - 1, idx + (wheel.dir === "up" ? -1 : 1) * wheel.count)));
      return;
    }
    // Rename mode owns the keyboard until Enter/Esc.
    if (renaming !== null) {
      if (key.return) {
        if (filtered[idx] && onRename) onRename(filtered[idx], renaming);
        return setRenaming(null);
      }
      if (key.escape) return setRenaming(null);
      if (key.backspace || key.delete) return setRenaming((r) => [...(r ?? "")].slice(0, -1).join(""));
      if (input && !key.ctrl && !key.meta && !key.tab && !input.startsWith("\x1b") && !isEscapeResidue(input)) return setRenaming((r) => (r ?? "") + input);
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
      // Type-to-filter, but NEVER a stray escape sequence: with mouse tracking on (or left on by a
      // crashed session), wheel/move reports arrive as "[<64;97;33M" bursts and used to pile up in the
      // filter (image-verified). Same guard as TextInput.
      if (input && !key.ctrl && !key.meta && !key.tab && !input.startsWith("\x1b") && !isEscapeResidue(input)) {
        setQuery((q) => q + input);
        setIndex(0);
      }
    }
  });

  const rule = "─".repeat(Math.max(10, cols - 1));

  return (
    // flexShrink 0: the picker must NEVER be flex-squashed. In fullscreen the root Box is fixed-height;
    // when the transcript band + pill + this list overflow it by a row, Yoga shrinks the list, squashing
    // its 2-row items into 1 (label and detail OVERLAP on one screen row - the mangled /resume of image
    // #60) and the header into 0 - and the viewH feedback then settles in that squashed state. Pinning
    // the list makes the flexible transcript box give up the rows instead.
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Text color="cyan">{title}{showCount ? ` (${filtered.length ? idx + 1 : 0} of ${filtered.length})` : ""}</Text>
      {description ? <Text dimColor>{description}</Text> : null}
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
              {HIT_SENTINEL}{i === idx ? "> " : "  "}
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
          : `↑/↓ select · Enter confirm${getPreview ? " · Space preview" : ""}${onCtrlA ? ` · Ctrl+A ${ctrlAHint ?? "more"}` : ""}${onRename ? " · Ctrl+R rename" : ""} · Esc cancel${search ? " · type to filter" : ""}`}
      </Text>
    </Box>
  );
}
