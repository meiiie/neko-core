/**
 * Rich-text row model — the foundation for a scrollable viewport on stock Ink.
 *
 * Ink can't clip an overflowing region into a fixed viewport (tested: `overflow:hidden` samples rows
 * instead of clipping — which is why Claude Code patched Ink's renderer). The way to scroll on stock Ink
 * is to never let a node wrap: pre-wrap every line to the content width so each rendered element is EXACTLY
 * one terminal row. Then a viewport is just a slice `rows[offset .. offset+height]` — no clipping needed,
 * and the height is known exactly (so scroll math is correct).
 *
 * `toRichLines(text, width)` turns a markdown string into styled, ≤`width` display rows (bold/italic/code/
 * link/math styling preserved across wrap boundaries). `RichRow` renders one row.
 */
import { Text } from "ink";
import type { ReactNode } from "react";

import { mathToUnicode } from "./markdown.tsx";

export interface Seg {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  color?: string;
}
export type Row = Seg[];

const width1 = (s: string) => {
  // display width without pulling string-width into the hot path for the common ASCII case
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! > 0x1100 && /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F000}-\u{1FAFF}]/u.test(ch) ? 2 : 1;
  return w;
};

/** Split markdown inline text into styled segments (same grammar as markdown.tsx's inline). */
export function tokenizeInline(raw: string): Seg[] {
  const s = raw;
  const out: Seg[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)|\$([^$\n]+)\$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ text: m[2], bold: true });
    else if (m[3] !== undefined) out.push({ text: m[3], color: "yellow" });
    else if (m[4] !== undefined) out.push({ text: m[4], italic: true });
    else if (m[5] !== undefined) out.push({ text: m[5], color: "cyan", underline: true });
    else if (m[7] !== undefined) out.push(/[\\^_{}]/.test(m[7]) ? { text: mathToUnicode(m[7]), color: "cyan" } : { text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out.length ? out : [{ text: "" }];
}

/** Word-wrap styled segments into rows no wider than `width`, keeping each segment's style and breaking
 * at spaces (a single over-long token is hard-split so it can never overflow the viewport). */
export function wrapSegs(segs: Seg[], width: number): Row[] {
  const w = Math.max(1, width);
  const rows: Row[] = [];
  let row: Row = [];
  let used = 0;
  const pushRow = () => { rows.push(row.length ? row : [{ text: "" }]); row = []; used = 0; };
  const add = (seg: Seg, word: string) => {
    const ww = width1(word);
    if (used + ww > w && used > 0) pushRow();
    // a token longer than the whole width: hard-split it across rows
    if (ww > w) {
      let chunk = "";
      for (const ch of word) {
        if (width1(chunk + ch) > w) { row.push({ ...seg, text: chunk }); pushRow(); chunk = ch; }
        else chunk += ch;
      }
      if (chunk) { row.push({ ...seg, text: chunk }); used += width1(chunk); }
      return;
    }
    row.push({ ...seg, text: word });
    used += ww;
  };
  for (const seg of segs) {
    // split on spaces but keep them (so wrapping preserves single spaces between words)
    const parts = seg.text.split(/(\s+)/);
    for (const p of parts) {
      if (!p) continue;
      if (/^\s+$/.test(p)) { if (used > 0 && used < w) { row.push({ ...seg, text: " " }); used += 1; } continue; }
      add(seg, p);
    }
  }
  pushRow();
  return rows;
}

/** Markdown block -> styled display rows (each exactly one terminal row of width <= `width`). Handles the
 * common blocks (heading, bullet, numbered, quote, blank); a code fence / table is passed through as
 * plain wrapped rows here (the viewport composes these; rich table borders stay in markdown.tsx). */
export function toRichLines(text: string, width: number): Row[] {
  const out: Row[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (!line.trim()) { out.push([{ text: "" }]); continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    let prefix = "";
    let segs: Seg[];
    if (heading) segs = tokenizeInline(heading[2]).map((s) => ({ ...s, bold: true, color: "cyan" }));
    else if (bullet) { prefix = `${bullet[1]}- `; segs = tokenizeInline(bullet[2]); }
    else if (numbered) { prefix = `${numbered[1]}${numbered[2]}. `; segs = tokenizeInline(numbered[3]); }
    else if (quote) { prefix = "| "; segs = tokenizeInline(quote[1]).map((s) => ({ ...s, dim: true })); }
    else segs = tokenizeInline(line);
    const rows = wrapSegs(prefix ? [{ text: prefix }, ...segs] : segs, width);
    for (const r of rows) out.push(r);
  }
  return out;
}

/** Render one display row (already <= width, never wraps). */
export function RichRow({ row }: { row: Row }): ReactNode {
  return (
    <Text>
      {row.map((seg, i) => (
        <Text key={i} bold={seg.bold} italic={seg.italic} underline={seg.underline} dimColor={seg.dim} color={seg.color}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}
