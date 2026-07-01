/**
 * A small clean-room markdown renderer for the terminal (Ink). Handles code fences,
 * headings, bullet/numbered lists, tables, blockquotes, and inline **bold** / *italic* / `code`
 * / [links]. Decodes HTML entities and <br> (LLM table cells often carry them). Kept ASCII-safe
 * (no fancy glyphs) so it renders on any Windows console codepage.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { highlightLine } from "./highlight.tsx";

/** Decode HTML entities + <br> so they don't show up literally (common in scraped/LLM tables). */
function decodeEntities(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => safeCp(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCp(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function safeCp(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Visible text of a cell (markers stripped, entities decoded) — for column-width math. */
function plain(s: string): string {
  return decodeEntities(s)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}
const plainLen = (s: string) => [...plain(s)].length;

function splitRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

/** Truncate visible text to `w` columns, marking the cut with an ellipsis (single-line cells keep
 * the box borders aligned; wrapping would shatter them). */
export function truncCell(s: string, w: number): string {
  const chars = [...s];
  if (chars.length <= w) return s;
  if (w <= 1) return chars.slice(0, Math.max(0, w)).join("");
  return chars.slice(0, w - 1).join("") + "…";
}

/** Fit natural column widths into `maxWidth` terminal columns (accounting for the │ borders + a
 * space of padding each side) by shrinking the widest columns first — so a wide table is truncated
 * to fit instead of overflowing and wrap-shattering across lines. */
export function fitColumns(natural: number[], maxWidth: number): number[] {
  const n = natural.length;
  if (!n) return [];
  const overhead = n + 1 + n * 2; // │ separators + one space of padding on each side of every cell
  const budget = Math.max(n * 3, maxWidth - overhead);
  const w = natural.map((x) => Math.max(1, x));
  let total = w.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let wi = 0;
    for (let c = 1; c < n; c++) if (w[c] > w[wi]) wi = c;
    if (w[wi] <= 3) break; // don't crush a column below a legible width
    w[wi]--;
    total--;
  }
  return w;
}

function renderTable(header: string[], rows: string[][], key: number, maxWidth: number): ReactNode {
  const natural = header.map((h, c) => Math.max(plainLen(h), ...rows.map((r) => plainLen(r[c] ?? "")), 1));
  const w = fitColumns(natural, maxWidth);
  const rule = (l: string, mid: string, r: string) => (
    <Text color="gray">{l}{w.map((x) => "─".repeat(x + 2)).join(mid)}{r}</Text>
  );
  const renderRow = (cells: string[], rk: string, bold: boolean) => (
    <Text key={rk} bold={bold}>
      <Text color="gray">│</Text>
      {w.map((width, c) => {
        const raw = cells[c] ?? "";
        const fits = plainLen(raw) <= width;
        const shown = fits ? raw : truncCell(plain(raw), width);
        const len = fits ? plainLen(raw) : [...shown].length;
        return (
          <Text key={c}> {fits ? inline(raw) : shown}{" ".repeat(Math.max(0, width - len))} <Text color="gray">│</Text></Text>
        );
      })}
    </Text>
  );
  return (
    <Box key={key} flexDirection="column" marginTop={1} marginBottom={1}>
      {rule("┌", "┬", "┐")}
      {renderRow(header, "h", true)}
      {rule("├", "┼", "┤")}
      {rows.map((r, ri) => renderRow(r, `r${ri}`, false))}
      {rule("└", "┴", "┘")}
    </Box>
  );
}

function inline(raw: string): ReactNode[] {
  const s = decodeEntities(raw);
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[2] !== undefined) out.push(<Text key={key++} bold>{m[2]}</Text>);
    else if (m[3] !== undefined) out.push(<Text key={key++} color="yellow">{m[3]}</Text>);
    else if (m[4] !== undefined) out.push(<Text key={key++} italic>{m[4]}</Text>);
    else if (m[5] !== undefined) out.push(<Text key={key++} color="cyan" underline>{m[5]}</Text>); // [text](url) -> text
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.length ? out : [s];
}

export function Markdown({ text, width }: { text: string; width?: number }): ReactNode {
  const maxWidth = Math.max(24, width ?? 80);
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <Box key={key++} flexDirection="column" paddingLeft={2}>
          {code.map((c, j) => (
            <Text key={j}>{c.length ? highlightLine(c) : " "}</Text>
          ))}
        </Box>,
      );
      continue;
    }

    // Table: a "| ... |" header row followed by a "|---|---|" separator.
    const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
    const isSep = (l: string) => l.includes("-") && /^\s*\|?[\s:|-]+\|?\s*$/.test(l);
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(renderTable(header, rows, key++, maxWidth));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      // Breathing room above a heading (except the very first block) for vertical rhythm.
      blocks.push(
        <Box key={key++} marginTop={blocks.length ? 1 : 0}>
          <Text bold color="cyan">{inline(heading[2])}</Text>
        </Box>,
      );
      i++;
      continue;
    }

    // Horizontal rule (---, ***, ___): a dim separator instead of literal dashes.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<Text key={key++} dimColor>{"-".repeat(48)}</Text>);
      i++;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push(<Text key={key++} color="gray" italic>{"│ "}{inline(quote[1])}</Text>);
      i++;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      blocks.push(<Text key={key++}>{bullet[1]}- {inline(bullet[2])}</Text>);
      i++;
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numbered) {
      blocks.push(<Text key={key++}>{numbered[1]}{numbered[2]}. {inline(numbered[3])}</Text>);
      i++;
      continue;
    }

    blocks.push(<Text key={key++}>{inline(line)}</Text>);
    i++;
  }

  return <Box flexDirection="column">{blocks}</Box>;
}
