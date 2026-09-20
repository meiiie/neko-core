/** Small formatting helpers shared across the UI. */

export function trunc(s: string, n = 120): string {
  const one = String(s).replace(/\s+/g, " ");
  return one.length > n ? one.slice(0, n) + "..." : one;
}


/** Expand hard tabs to spaces so TTY paint cannot leave tab-stop holes. `string-width` (and Ink's
 * yoga measure) treat `\t` as width 0, while a real terminal advances to the next stop without
 * overwriting the skipped cells — FrameDiffer then leaves stale glyphs in those holes (`owconst`,
 * `peconsole`). Approval/code diffs must never emit raw tabs. */
export function expandTabs(s: string, tabWidth = 4): string {
  const w = Math.max(1, Math.floor(tabWidth) || 4);
  let out = "";
  let col = 0;
  for (const ch of String(s ?? "")) {
    if (ch === "\t") {
      const n = w - (col % w);
      out += " ".repeat(n);
      col += n;
      continue;
    }
    if (ch === "\n") {
      out += ch;
      col = 0;
      continue;
    }
    if (ch === "\r") continue; // drop CR so CRLF source lines cannot rewind the cursor mid-paint
    out += ch;
    col += 1;
  }
  return out;
}


export function fmtTok(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

/** Percent of the context window used (0-100), clamped. */
export function ctxPercent(used: number, window: number): number {
  return Math.min(100, Math.max(0, Math.round((100 * used) / Math.max(1, window))));
}

/** "29s" / "6m 6s" / "1h 2m" — for the post-turn run-time line. */
export function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function fmtBytes(n: number): string {
  return n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`;
}

/** Compact age "6d 23h" / "3h 12m" / "12m" — for the resume-from-summary prompt (claude-style header). */
export function fmtAge(iso: string): string {
  const then = Date.parse(iso);
  if (!then) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** "16 hours ago" / "1 week ago" — for the /resume picker. */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!then) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  const m = s / 60, h = m / 60, d = h / 24, w = d / 7, mo = d / 30, y = d / 365;
  const ago = (n: number, u: string) => `${Math.floor(n)} ${u}${Math.floor(n) > 1 ? "s" : ""} ago`;
  if (s < 60) return "just now";
  if (m < 60) return ago(m, "min");
  if (h < 24) return ago(h, "hour");
  if (d < 7) return ago(d, "day");
  if (w < 5) return ago(w, "week");
  if (mo < 12) return ago(mo, "month");
  return ago(y, "year");
}


/** Collapse identical leading/trailing lines between old/new so approval diffs do not paint
 * unchanged anchors as red/green noise (e.g. whole prior function restated only to append).
 * Keeps up to `ctx` context lines on each side; returns the trimmed sides plus elision counts. */
export function elideCommonEnds(
  oldText: string,
  newText: string,
  ctx = 1,
): { oldText: string; newText: string; elidedHead: number; elidedTail: number } {
  const o = String(oldText ?? "").split("\n");
  const n = String(newText ?? "").split("\n");
  let head = 0;
  while (head < o.length && head < n.length && o[head] === n[head]) head++;
  let tail = 0;
  while (
    tail < o.length - head &&
    tail < n.length - head &&
    o[o.length - 1 - tail] === n[n.length - 1 - tail]
  ) {
    tail++;
  }
  // Nothing shared, or both sides identical — leave the raw strings alone.
  if ((head === 0 && tail === 0) || (head + tail >= o.length && head + tail >= n.length)) {
    return { oldText: String(oldText ?? ""), newText: String(newText ?? ""), elidedHead: 0, elidedTail: 0 };
  }
  const keep = Math.max(0, Math.floor(ctx));
  const start = Math.max(0, head - keep);
  const droppedTail = Math.max(0, tail - keep);
  return {
    oldText: o.slice(start, o.length - droppedTail).join("\n"),
    newText: n.slice(start, n.length - droppedTail).join("\n"),
    elidedHead: start,
    elidedTail: droppedTail,
  };
}
