/**
 * Mouse wheel scrolling for fullscreen mode (SGR mouse reporting, DEC 1000 + 1006).
 *
 * Enabling mouse tracking lets us receive wheel events, but it also takes over the terminal's native
 * click-drag select-to-copy. So it's on by default ONLY in fullscreen (already opt-in) and can be turned
 * off with NEKO_DISABLE_MOUSE=1; most terminals also let you hold Shift to bypass capture for a native
 * selection. We enable button + SGR-coordinate reporting (1000/1006) but NOT motion (1002/1003), so only
 * clicks/wheel are reported - less interference with the terminal than full motion tracking.
 *
 * SGR mouse report: `CSI < Cb ; Cx ; Cy (M|m)`. Wheel up = Cb 64, wheel down = Cb 65.
 */
import type { Writable } from "node:stream";

export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";

/** Mouse on unless NEKO_DISABLE_MOUSE is set. Only consulted in fullscreen. */
export function isMouseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.NEKO_DISABLE_MOUSE;
  return !(v === "1" || v === "true");
}

export function enableMouse(out: Writable = process.stdout): void { out.write(ENABLE_MOUSE); }
export function disableMouse(out: Writable = process.stdout): void { out.write(DISABLE_MOUSE); }

/**
 * Parse a wheel direction out of an input chunk that may contain an SGR mouse report. Returns "up" or
 * "down" for a wheel event, else null (a click, a non-mouse sequence, or a partial). Tolerant of the
 * report being embedded in a larger chunk. Only the FIRST wheel event in the chunk is returned - wheel
 * ticks arrive one report per chunk in practice.
 */
export function parseWheel(input: string): "up" | "down" | null {
  // ESC is optional: Ink often strips the leading ESC and hands us just the CSI body ("[<64;10;5M").
  const m = /\x1b?\[<(\d+);\d+;\d+[Mm]/.exec(input);
  if (!m) return null;
  const cb = parseInt(m[1], 10);
  // Low 2 bits are the button; bit 6 (64) marks wheel. 64 = up, 65 = down. Modifier bits (shift/ctrl/
  // meta = 4/8/16) may be OR'd in, so mask to the wheel button rather than compare exactly.
  if ((cb & 64) === 0) return null;
  return (cb & 1) === 0 ? "up" : "down";
}
