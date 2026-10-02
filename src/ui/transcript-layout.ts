/** Plain transcript layout: index offsets once, materialize only visible rows. */
import stringWidth from "string-width";
import { styleFor, type Row } from "./scroll.tsx";
import type { Line } from "./transcript.tsx";

interface Entry {
  line: Line;
  text: string;
  starts: number[];
  ends: number[];
  row: number;
}

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class TranscriptLayout {
  readonly entries: Entry[] = [];
  private rowCount = 0;
  get totalRows(): number { return this.rowCount; }
  private set totalRows(value: number) { this.rowCount = value; }

  constructor(lines: Line[], width: number) {
    let total = 0;
    for (const line of lines) {
      if (line.kind === "welcome") continue;
      const iterator = indexEntry(line, width, total);
      let step = iterator.next();
      while (!step.done) step = iterator.next();
      this.entries.push(step.value);
      total += step.value.starts.length + 1;
    }
    this.totalRows = total;
  }

  /** Large transcript preparation yields between chunks; closing the viewer cancels stale work. */
  static async create(lines: Line[], width: number, signal: AbortSignal): Promise<TranscriptLayout> {
    const layout = new TranscriptLayout([], width);
    let total = 0;
    let sinceYield = performance.now();
    for (const line of lines) {
      if (line.kind === "welcome") continue;
      const iterator = indexEntry(line, width, total);
      let step = iterator.next();
      while (!step.done) {
        signal.throwIfAborted();
        if (performance.now() - sinceYield >= 8) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          signal.throwIfAborted();
          sinceYield = performance.now();
        }
        step = iterator.next();
      }
      layout.entries.push(step.value);
      total += step.value.starts.length + 1;
      if (performance.now() - sinceYield >= 8) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal.throwIfAborted();
        sinceYield = performance.now();
      }
    }
    signal.throwIfAborted();
    layout.totalRows = total;
    return layout;
  }

  /** Rows and strings outside this window are never constructed for an Ink frame. */
  window(offset: number, height: number): Row[] {
    const from = Math.max(0, Math.floor(offset));
    const to = Math.min(this.totalRows, from + Math.max(0, Math.floor(height)));
    const rows: Row[] = [];
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const entry = this.entries[mid];
      if (entry.row + entry.starts.length < from) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.row >= to) break;
      const { glyph, color, background, dim } = styleFor(entry.line.kind);
      for (let j = Math.max(0, from - entry.row); j <= entry.starts.length && entry.row + j < to; j++) {
        if (j === entry.starts.length) rows.push({ text: "", dim: false });
        else rows.push({ text: (j === 0 ? glyph : " ".repeat(stringWidth(glyph))) + entry.text.slice(entry.starts[j], entry.ends[j]), color, background, dim });
      }
    }
    return rows;
  }

  anchor(row: number): { id: number; offset: number } | null {
    for (const entry of this.entries) {
      if (row < entry.row + entry.starts.length + 1) {
        const local = Math.max(0, Math.min(entry.starts.length - 1, row - entry.row));
        return { id: entry.line.id, offset: entry.starts[local] };
      }
    }
    return null;
  }

  resolve(anchor: { id: number; offset: number } | null): number {
    if (!anchor) return 0;
    const entry = this.entries.find((item) => item.line.id === anchor.id);
    if (!entry) return 0;
    let row = 0;
    while (row + 1 < entry.starts.length && entry.starts[row + 1] <= anchor.offset) row++;
    return entry.row + row;
  }

  /** Case-insensitive literal search, returning the actual wrapped row of each occurrence. */
  find(query: string): number[] {
    if (!query) return [];
    const needle = query.toLowerCase();
    const matches: number[] = [];
    for (const entry of this.entries) {
      const folded = entry.text.toLowerCase();
      // Most text folds without changing length. Expanding folds such as İ need an offset map.
      let offsets: number[] | null = null;
      if (folded.length !== entry.text.length) {
        offsets = [];
        let original = 0;
        for (const char of entry.text) {
          for (let i = 0; i < char.toLowerCase().length; i++) offsets.push(original);
          original += char.length;
        }
      }
      let next = 0;
      for (;;) {
        const found = folded.indexOf(needle, next);
        if (found < 0) break;
        const originalIndex = offsets?.[found] ?? found;
        next = found + needle.length;
        let low = 0;
        let high = entry.starts.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (entry.starts[mid] <= originalIndex) low = mid + 1;
          else high = mid;
        }
        const row = entry.row + Math.max(0, low - 1);
        if (matches.at(-1) !== row) matches.push(row);
      }
    }
    return matches;
  }
}


function* indexEntry(line: Line, width: number, row: number): Generator<void, Entry> {
  const { glyph } = styleFor(line.kind);
  const wrap = Math.max(8, width - stringWidth(glyph));
  // Escape controls in linear native string passes before any raw content reaches Ink.
  const text = line.text.replace(/\r\n?/g, "\n").replaceAll("\t", "    ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const starts: number[] = [];
  const ends: number[] = [];
  let start = 0;
  let cells = 0;
  let count = 0;
  for (const { segment, index } of segments.segment(text)) {
    if (++count % 2048 === 0) yield;
    if (segment === "\n") {
      starts.push(start); ends.push(index);
      start = index + 1; cells = 0;
      continue;
    }
    const size = stringWidth(segment);
    if (cells > 0 && cells + size > wrap) {
      starts.push(start); ends.push(index);
      start = index; cells = 0;
    }
    cells += size;
  }
  starts.push(start); ends.push(text.length);
  return { line, text, starts, ends, row };
}
