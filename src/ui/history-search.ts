import { useEffect, useMemo, useState } from "react";
import { TranscriptLayout } from "./transcript-layout.ts";
import type { Line } from "./transcript.tsx";

/** Prepare searchable offsets without allocating an entire transcript's rendered rows. */
export function useHistorySearch(lines: Line[], width: number, active: boolean) {
  const empty = useMemo(() => new TranscriptLayout([], width), [width]);
  const immediate = useMemo(() => {
    if (!active) return empty;
    let size = 0;
    for (const line of lines) {
      size += line.text.length;
      if (size > 16_000) return null;
    }
    return new TranscriptLayout(lines, width);
  }, [lines, width, active, empty]);
  const [prepared, setPrepared] = useState<{lines: Line[]; width: number; layout: TranscriptLayout} | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    if (!active || immediate) { setPrepared(null); return; }
    const controller = new AbortController();
    void TranscriptLayout.create(lines, width, controller.signal).then((layout) => {
      if (!controller.signal.aborted) setPrepared({lines, width, layout});
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [active, immediate, lines, width]);
  const layout = immediate ?? (prepared?.lines === lines && prepared.width === width ? prepared.layout : null);
  return {layout: layout ?? empty, loading: active && layout === null && !error, error};
}
