/** Random-access rows keep large history blocks out of the per-frame allocation path. */
import type { Line } from "./transcript.tsx";
import type { LineRowSpan } from "./scroll.tsx";
import type { TranscriptLayout } from "./transcript-layout.ts";

export interface RowSource {
  readonly length: number;
  at(index: number): string | undefined;
  slice(start?: number, end?: number): string[];
}

function bounds(length: number, start = 0, end = length): [number, number] {
  const fix = (n: number) => Math.max(0, Math.min(length, n < 0 ? length + n : n));
  return [fix(start), fix(end)];
}

export class LayoutRows implements RowSource {
  readonly length: number;
  constructor(private readonly layout: TranscriptLayout) { this.length = layout.totalRows; }
  at(index: number): string | undefined {
    const at = index < 0 ? this.length + index : index;
    return at < 0 || at >= this.length ? undefined : this.layout.window(at, 1)[0]?.text;
  }
  slice(start = 0, end = this.length): string[] {
    const [from, to] = bounds(this.length, start, end);
    return this.layout.window(from, Math.max(0, to - from)).map((row) => row.text);
  }
}

export function mapRows(source: RowSource, map: (row: string) => string): RowSource {
  return {
    length: source.length,
    at(index) { const row = source.at(index); return row === undefined ? undefined : map(row); },
    slice(start, end) { return source.slice(start, end).map(map); },
  };
}

export class CombinedRows implements RowSource {
  readonly length: number;
  private readonly ends: number[] = [];
  constructor(private readonly sources: RowSource[]) {
    let count = 0;
    for (const source of sources) { count += source.length; this.ends.push(count); }
    this.length = count;
  }
  at(index: number): string | undefined {
    const at = index < 0 ? this.length + index : index;
    if (at < 0 || at >= this.length) return undefined;
    let lo = 0, hi = this.ends.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.ends[mid] <= at) lo = mid + 1; else hi = mid; }
    return this.sources[lo].at(at - (lo ? this.ends[lo - 1] : 0));
  }
  slice(start = 0, end = this.length): string[] {
    const [from, to] = bounds(this.length, start, end);
    const rows: string[] = [];
    for (let i = from; i < to; i++) rows.push(this.at(i) ?? "");
    return rows;
  }
}

export function projectRowSources(lines: Line[], rowsFor: (line: Line) => RowSource) {
  let count = 0;
  const spans: LineRowSpan[] = [];
  const sources = lines.map((line) => {
    const source = rowsFor(line);
    spans.push({line, start: count, end: count + source.length});
    count += source.length;
    return source;
  });
  return { rows: new CombinedRows(sources), spans };
}
