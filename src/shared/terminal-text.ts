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

export function terminalSafeText(value: unknown, options: TerminalTextOptions = {}): string {
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
  value: unknown,
  options: TerminalTextOptions = { preserveLineBreaks: true },
): void {
  stream.write(terminalSafeText(value, options));
}
