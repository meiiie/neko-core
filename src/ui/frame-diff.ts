/**
 * FrameDiffer — Neko's compositor-lite at the stdout layer. Ink (standard renderer) writes
 * `eraseLines(prevCount) + <full frame>` on every render; this differ intercepts that payload,
 * compares the new frame to the previous one line-by-line, and emits the MINIMAL byte sequence:
 *
 *  - unchanged lines are skipped entirely (a keystroke rewrites ~the input line, not the screen);
 *  - in fullscreen, a SCROLL of the viewport band is detected (new lines == previous lines shifted
 *    by k) and emitted as the terminal's own hardware scroll - DECSTBM sets the scroll region,
 *    SU/SD shifts it, and only the k revealed rows are painted. A 3-row scroll writes ~3 rows
 *    instead of the whole viewport. This is the classic curses optimization and the reason
 *    claude-code-class fullscreen scrolling feels native: the terminal moves the pixels, not us.
 *
 * Safety model: the parser accepts ONLY the exact payload shape Ink's standard renderer produces
 * (no cursor-feature sequences - Neko never uses Ink's setCursorPosition). Anything else - resize
 * wipes, alt-screen switches, Ink's clear(), OSC writes - passes through untouched and resets the
 * baseline, so the differ can never corrupt output it doesn't fully understand; it just stops
 * optimizing until it re-seeds on the next standard frame. Correctness is locked by tests that
 * replay the emitted bytes through a virtual terminal and require the final grid to be identical
 * to a full rewrite.
 */

export interface ScrollBand { top: number; height: number } // 1-based absolute top row of the scrollable band

const ESC = "\x1b[";
const EL = `${ESC}K`; // erase to end of line

/** Parse Ink's standard rerender payload: eraseLines(prev) + frame. Returns null for anything else. */
export function parseInkPayload(p: string): { eraseCount: number; frame: string } | null {
  const m = /^((?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G)/.exec(p);
  if (!m) return null;
  const eraseCount = (m[1].match(/\x1b\[2K/g) ?? []).length;
  const frame = p.slice(m[1].length);
  // A frame is text + SGR color codes + newlines. Any cursor-movement/erase/scroll CSI inside means
  // this is NOT a plain frame (or Ink changed shape) - refuse to optimize rather than risk corruption.
  if (/\x1b\[[0-9;]*[ABCDEFGHJKSTr]/.test(frame)) return null;
  return { eraseCount, frame };
}

export class FrameDiffer {
  private prev: string[] | null = null;
  private band: ScrollBand | null = null;

  /** The scrollable band (fullscreen viewport), in absolute rows. MUST only be set when the Ink frame
   * starts at screen row 1 (our fullscreen: alt-screen + clear + home), because scroll emission uses
   * absolute addressing. null = band detection off (inline). */
  setBand(band: ScrollBand | null): void { this.band = band; }
  reset(): void { this.prev = null; }

  /** Optimized bytes to write INSTEAD of `payload`; "" = nothing changed (skip the write);
   * null = pass the payload through untouched (and the baseline resets/reseeds as appropriate). */
  process(payload: string): string | null {
    const parsed = parseInkPayload(payload);
    if (!parsed) { this.prev = null; return null; } // not a standard rerender -> passthrough + reset
    const lines = parsed.frame.split("\n");
    const prev = this.prev;
    this.prev = lines;
    if (!prev) return null;                          // no baseline yet -> passthrough seeds it
    if (parsed.eraseCount !== prev.length) return null; // Ink's idea of prev differs from ours -> resync
    if (lines.length !== prev.length) return null;   // height changed -> a full rewrite is the safe move

    const changed: number[] = [];
    for (let i = 0; i < lines.length; i++) if (lines[i] !== prev[i]) changed.push(i);
    if (changed.length === 0) return "";             // identical frame -> skip the write entirely

    // --- fullscreen scroll detection over the band ---
    const band = this.band;
    if (band && band.height >= 8 && changed.length > band.height / 2) {
      const scroll = detectShift(prev, lines, band.height);
      if (scroll) return emitScroll(prev, lines, band, scroll);
    }

    // --- plain line-diff (relative addressing; works wherever the frame sits on screen) ---
    // The cursor starts on the LAST line of the previous frame (that's where Ink leaves it).
    let cur = prev.length - 1;
    let out = "";
    for (const i of changed) {
      out += moveRel(cur, i) + `${ESC}G` + lines[i] + EL;
      cur = i;
    }
    out += moveRel(cur, lines.length - 1); // end on the last line - the row Ink assumes next render
    return out;
  }
}

function moveRel(from: number, to: number): string {
  if (to < from) return `${ESC}${from - to}A`;
  if (to > from) return `${ESC}${to - from}B`;
  return "";
}

/** Detect a uniform vertical shift of the band: returns {dir:"up",k} when the content moved UP by k
 * (new[i] == prev[i+k] - the user scrolled toward the tail), {dir:"down",k} for the opposite. Requires
 * a near-perfect match (<=2 noise rows) so false positives are practically impossible. */
export function detectShift(prev: string[], next: string[], bandH: number): { dir: "up" | "down"; k: number } | null {
  const maxK = Math.min(bandH - 1, 24);
  for (let k = 1; k <= maxK; k++) {
    let up = 0, downMatches = 0;
    const span = bandH - k;
    for (let i = 0; i < span; i++) {
      if (next[i] === prev[i + k]) up++;
      if (next[i + k] === prev[i]) downMatches++;
    }
    if (span >= 4 && up >= span - 2 && up > 0) return { dir: "up", k };
    if (span >= 4 && downMatches >= span - 2 && downMatches > 0) return { dir: "down", k };
  }
  return null;
}

/** Emit a hardware scroll of the band + paint of the revealed rows + any leftover mismatches.
 * Absolute addressing (frame line i = screen row i+1; guaranteed by the band contract). */
function emitScroll(prev: string[], next: string[], band: ScrollBand, s: { dir: "up" | "down"; k: number }): string {
  const top = band.top;                    // 1-based
  const bottom = band.top + band.height - 1;
  let out = `${ESC}${top};${bottom}r`;     // DECSTBM: confine scrolling to the band
  out += s.dir === "up" ? `${ESC}${s.k}S` : `${ESC}${s.k}T`; // SU / SD: the terminal shifts the region
  out += `${ESC}r`;                        // reset margins (also homes the cursor - we CUP everywhere below)
  // What the shift made of the band, per line; then paint every line that still differs from `next`
  // (the k revealed rows + any noise rows the detector tolerated).
  const shifted: (string | null)[] = [];
  for (let i = 0; i < band.height; i++) {
    shifted[i] = s.dir === "up"
      ? (i < band.height - s.k ? prev[i + s.k] : null)   // null = blank revealed row
      : (i >= s.k ? prev[i - s.k] : null);
  }
  for (let i = 0; i < band.height; i++) {
    if (shifted[i] !== next[i]) out += `${ESC}${top + i};1H` + next[i] + EL;
  }
  // Chrome below the band: plain per-line diff, absolute rows.
  for (let i = band.height; i < next.length; i++) {
    if (next[i] !== prev[i]) out += `${ESC}${i + 1};1H` + next[i] + EL;
  }
  out += `${ESC}${next.length};1H`;        // end on the last frame line, as Ink expects
  return out;
}
