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

// 1000 = button events, 1003 = ANY-motion events (needed for hover affordances like the jump pill),
// 1006 = SGR coordinates. Motion reports are cheap for us (parsed + dropped by the shared guards) and
// only enabled in fullscreen.
export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1003l\x1b[?1006l";

/** Mouse on unless NEKO_DISABLE_MOUSE is set. Only consulted in fullscreen. */
export function isMouseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.NEKO_DISABLE_MOUSE;
  return !(v === "1" || v === "true");
}

export function enableMouse(out: Writable = process.stdout): void { out.write(ENABLE_MOUSE); }
export function disableMouse(out: Writable = process.stdout): void { out.write(DISABLE_MOUSE); }

/**
 * Parse ALL wheel events in an input chunk (a fast spin can batch several SGR reports into one chunk -
 * counting only the first made scrolling feel like it lagged behind the wheel). Returns the NET
 * direction + count, or null when the chunk carries no wheel events. ESC is optional (Ink often strips
 * it and hands us just the CSI body "[<64;10;5M"). Modifier bits (shift/ctrl/meta = 4/8/16) are masked.
 */
export function parseWheelAll(input: string): { dir: "up" | "down"; count: number } | null {
  const re = /\x1b?\[<(\d+);\d+;\d+[Mm]/g;
  let up = 0, down = 0, m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const cb = parseInt(m[1], 10);
    if ((cb & 64) === 0) continue; // bit 6 marks a wheel event; 64 = up, 65 = down (low bit)
    if ((cb & 1) === 0) up++; else down++;
  }
  const net = up - down;
  if (net === 0) return null; // no wheel events, or an exactly-cancelling burst
  return net > 0 ? { dir: "up", count: net } : { dir: "down", count: -net };
}

/** Parse a LEFT-button PRESS (capital-M SGR report) into 1-based terminal coordinates, else null.
 * Used for tap targets like the jump-to-bottom pill. Modifier bits are masked; wheel and motion
 * (bit 32 - hover movement, not a click) are excluded. */
export function parseClick(input: string): { x: number; y: number } | null {
  const m = /\x1b?\[<(\d+);(\d+);(\d+)M/.exec(input);
  if (!m) return null;
  const cb = parseInt(m[1], 10);
  if (cb & 64) return null;          // wheel, not a click
  if (cb & 32) return null;          // motion report, not a press
  if ((cb & 3) !== 0) return null;   // not the left button
  return { x: parseInt(m[2], 10), y: parseInt(m[3], 10) };
}

export interface PointerEvent { x: number; y: number; kind: "wheel" | "press" | "release" | "move" }

/** The LAST pointer event in a chunk (bursts arrive concatenated; for hover only the newest position
 * matters). Any SGR report carries coordinates - wheel and clicks update the hover position too. */
export function parseLastPointer(input: string): PointerEvent | null {
  const re = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;
  let m: RegExpExecArray | null;
  let last: PointerEvent | null = null;
  while ((m = re.exec(input))) {
    const cb = parseInt(m[1], 10);
    const kind: PointerEvent["kind"] = cb & 64 ? "wheel" : cb & 32 ? "move" : m[4] === "M" ? "press" : "release";
    last = { x: parseInt(m[2], 10), y: parseInt(m[3], 10), kind };
  }
  return last;
}
