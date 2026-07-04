/**
 * Clipboard via OSC 52 - set the terminal clipboard with an escape sequence, no native integration and
 * no child process. Works over SSH and inside tmux (with `set-clipboard on`), and is the copy path when
 * fullscreen mouse capture has taken over native select-to-copy. Supported by iTerm2, kitty, WezTerm,
 * Windows Terminal (recent), Alacritty, foot, and others.
 *
 * Format: OSC 52 ; c ; <base64(text)> BEL   (c = the "clipboard" selection)
 */
import type { Writable } from "node:stream";

// Guard against pathological sizes: many terminals cap the OSC 52 payload (~74-100KB of base64). Keep
// well under that; a copy is a convenience, not an archive. Exported so callers can report a clip honestly.
export const MAX_COPY_CHARS = 60_000;

export function osc52(text: string): string {
  const clipped = text.length > MAX_COPY_CHARS ? text.slice(0, MAX_COPY_CHARS) : text;
  const b64 = Buffer.from(clipped, "utf-8").toString("base64");
  return `\x1b]52;c;${b64}\x07`;
}

/** Write the OSC 52 copy sequence for `text` to the terminal. Returns false for empty text. */
export function copyToClipboard(text: string, out: Writable = process.stdout): boolean {
  if (!text) return false;
  out.write(osc52(text));
  return true;
}
