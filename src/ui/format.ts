/** Small formatting helpers shared across the UI. */

export function trunc(s: string, n = 120): string {
  const one = String(s).replace(/\s+/g, " ");
  return one.length > n ? one.slice(0, n) + "..." : one;
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
