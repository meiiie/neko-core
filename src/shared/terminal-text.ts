/** Render untrusted text without letting terminal control bytes reach a TTY. */

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export interface TerminalTextOptions {
  /** Exact upper bound for the returned string, including the truncation marker. */
  maxChars?: number;
  /** Escape non-ASCII code points too (for legacy console-only surfaces). */
  ascii?: boolean;
  /** Keep LF as a line separator; every other control character is escaped. */
  preserveLineBreaks?: boolean;
}

export function hasTerminalControl(value: string): boolean {
  return CONTROL.test(value);
}

export function terminalSafeText(value: any, options: TerminalTextOptions = {}): string {
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : Number.POSITIVE_INFINITY;
  const suffix = "... [truncated]";
  let out = "";

  for (const char of String(value ?? "")) {
    const code = char.codePointAt(0)!;
    const keepLineBreak = options.preserveLineBreaks && code === 0x0a;
    const encoded = keepLineBreak || (!CONTROL.test(char) && (!options.ascii || code <= 0x7e))
      ? char
      : code <= 0xffff
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : `\\u{${code.toString(16)}}`;
    if (out.length + encoded.length > limit) {
      if (!Number.isFinite(limit)) return out;
      const marker = suffix.slice(0, limit);
      const bodyLimit = Math.max(0, limit - marker.length);
      return `${out.slice(0, bodyLimit)}${marker}`;
    }
    out += encoded;
  }
  return out;
}

/**
 * Write an untrusted chunk without retaining parser state between chunks.
 *
 * Escaping each control code immediately is intentional: an OSC/CSI sequence split over multiple
 * provider deltas can never be reassembled by the terminal.
 */
export function writeTerminalSafe(
  stream: Pick<NodeJS.WriteStream, "write">,
  value: any,
  options: TerminalTextOptions = { preserveLineBreaks: true },
): void {
  stream.write(terminalSafeText(value, options));
}

/**
 * Truncate a one-line label while keeping head + tail visible (paths/commands).
 * Mid-arg-only cuts lied about what was gated (lived raise-bar-13: collapse showed `ve...`).
 */
export function honestTruncate(value: any, cap: number, mark = "…"): string {
  const one = String(value ?? "").replace(/\s+/g, " ").trim();
  if (cap <= 0) return "";
  if (one.length <= cap) return one;
  if (cap <= mark.length) return mark.slice(0, cap);
  const keep = cap - mark.length;
  if (keep <= 1) return one.slice(0, cap);
  // Prefer a slightly longer head (command verbs) and a visible distinctive tail (path end).
  let headLen = Math.max(1, Math.ceil(keep * 0.55));
  let tailLen = Math.max(1, keep - headLen);
  if (headLen + tailLen > keep) tailLen = keep - headLen;
  let head = one.slice(0, headLen);
  let tail = one.slice(one.length - tailLen);
  // Snap head end to a path/space break when one is nearby (avoid mid-token head cut).
  const snap = Math.max(head.lastIndexOf("/"), head.lastIndexOf(" "), head.lastIndexOf("-"));
  if (snap >= Math.floor(headLen * 0.45)) {
    head = head.slice(0, snap + (head[snap] === "/" ? 1 : 0));
  }
  let out = `${head}${mark}${tail}`;
  if (out.length > cap) {
    const over = out.length - cap;
    if (head.length > over) head = head.slice(0, head.length - over);
    else tail = tail.slice(over - head.length + 1);
    out = `${head}${mark}${tail}`.slice(0, cap);
  }
  return out;
}
