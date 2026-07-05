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

/** Parse Ink's standard rerender payload: eraseLines(prev) + frame. The erase prefix is OPTIONAL -
 * Ink's very FIRST frame has none (prev count 0), and the differ must seed/compose from it too, or a
 * fullscreen start would show a blank band until the second render. Returns null for anything else. */
export function parseInkPayload(p: string): { eraseCount: number; frame: string } | null {
  const m = /^((?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G)?/.exec(p)!;
  const eraseCount = m[1] ? (m[1].match(/\x1b\[2K/g) ?? []).length : 0;
  const frame = p.slice(m[1]?.length ?? 0);
  if (frame.length === 0) return null;
  // A frame is text + SGR color codes + newlines. Any cursor-movement/erase/scroll CSI - OR an OSC
  // introducer (ESC ]) - means this is NOT a plain frame (alt-screen switches, wipes, Ink's clear, or a
  // /copy OSC 52 clipboard write that goes through the wrapper): refuse to optimize and pass it through
  // untouched rather than splice the band into it and eat it.
  if (/\x1b\[[0-9;]*[ABCDEFGHJKSTr]/.test(frame) || frame.includes("\x1b]")) return null;
  return { eraseCount, frame };
}

export class FrameDiffer {
  private prev: string[] | null = null;
  private band: ScrollBand | null = null;
  private bandRows: string[] | null = null; // full pre-wrapped row set for the band (null = Ink owns the band)
  private bandTail: string[] = [];           // live tail (the streaming reply) appended after bandRows
  private bandDist = 0;                      // rows between the window bottom and the tail
  private writer: ((s: string) => void) | null = null; // direct emitter for imperative band repaints

  /** The scrollable band (fullscreen viewport), in absolute rows. MUST only be set when the Ink frame
   * starts at screen row 1 (our fullscreen: alt-screen + clear + home), because scroll emission uses
   * absolute addressing. null = band detection off (inline). */
  setBand(band: ScrollBand | null): void { this.band = band; }
  reset(): void { this.prev = null; }

  // Text selection (mouse drag-to-copy): a highlighted region over the band, in 1-based SCREEN coords.
  // Because the band rows are full screen rows (2-space gutter + content), screen column X is visible
  // column X-1 in the row string - no gutter math. The overlay is applied in windowRows(), so BOTH the
  // Ink-frame compose path and the imperative repaint show it, and it updates through the normal diff.
  private selection: { r0: number; c0: number; r1: number; c1: number } | null = null;
  /** Highlight (inverse) a selection over the band; null clears it. Repaints so it shows immediately. */
  setSelection(sel: { r0: number; c0: number; r1: number; c1: number } | null): void {
    this.selection = sel;
    this.repaintBand();
  }
  /** Plain text (ANSI stripped) of the CURRENT on-screen rows [top..bottom], 1-based inclusive. The
   * selection overlay is SGR, so stripping leaves the real transcript text - what a copy should yield. */
  screenText(top: number, bottom: number): string[] {
    const out: string[] = [];
    for (let y = top; y <= bottom; y++) out.push((this.prev?.[y - 1] ?? "").replace(/\x1b\[[0-9;]*m/g, ""));
    return out;
  }

  /** Sink for imperative repaints (wired by the stdout wrapper; wraps in BSU/ESU there). */
  setWriter(w: ((s: string) => void) | null): void { this.writer = w; }

  /**
   * Give the differ the band's CONTENT (all rows + scroll distance) and repaint imperatively. This is
   * the compose-at-the-write-layer design: the Ink tree renders the band as BLANK lines (so Ink pays
   * zero squash/wrap/measure/output cost for the viewport on every keystroke), and the differ splices
   * the real rows into each frame. A scroll changes ONLY this content - no Ink render at all: the
   * repaint diffs the new window against the previous one, uses the hardware scroll when it detects a
   * shift, and paints just what changed. null = Ink owns the band again (find mode, inline).
   */
  setBandContent(rows: string[] | null, dist: number, tail: string[] = []): void {
    this.bandRows = rows;
    this.bandTail = tail; // the STREAMING reply renders inside the band, right under the committed rows
    this.bandDist = Math.max(0, dist);
    this.repaintBand();
  }

  /** The band window, or null when composition is off. Content that FILLS the viewport is bottom-
   * anchored (chat auto-follow); content SHORTER than the viewport is TOP-anchored - a fresh session's
   * welcome belongs at the top of the screen, not floating above the input with a void over it. */
  private windowRows(): string[] | null {
    if (!this.band || !this.bandRows) return null;
    const H = this.band.height;
    // Committed rows + the live tail form one logical scrollback; the window slices across the seam
    // WITHOUT materializing the concat (the tail changes on every stream delta - O(H) here, not O(all)).
    const total = this.bandRows.length + this.bandTail.length;
    const end = Math.max(0, total - this.bandDist);
    const start = Math.max(0, end - H);
    const slice: string[] = [];
    for (let i = start; i < end; i++) {
      slice.push(i < this.bandRows.length ? this.bandRows[i] : this.bandTail[i - this.bandRows.length]);
    }
    while (slice.length < H) slice.push("");
    // Selection highlight: invert the selected columns of each row the drag covers (screen coords).
    if (this.selection) {
      const s = this.selection;
      for (let i = 0; i < slice.length; i++) {
        const y = this.band.top + i;
        if (y < s.r0 || y > s.r1) continue;
        const from = y === s.r0 ? s.c0 - 1 : 0;                  // 1-based screen col -> 0-based, inclusive
        const to = y === s.r1 ? s.c1 : Number.MAX_SAFE_INTEGER;  // half-open end; whole row for middle rows
        slice[i] = overlaySelection(slice[i], Math.max(0, from), to);
      }
    }
    return slice;
  }

  /** Splice the band window into an Ink frame's lines (Ink rendered them blank). */
  private compose(lines: string[]): string[] {
    const win = this.windowRows();
    if (!win || !this.band) return lines;
    const out = lines.slice();
    for (let i = 0; i < this.band.height && i < out.length; i++) out[i] = win[i];
    return out;
  }

  /** On seed/resync frames: when composition is OFF, raw passthrough is correct and cheapest (null).
   * When composition is ON, passing the raw payload through would paint the BLANK band Ink rendered -
   * so emit the same full-frame write Ink would have, but with the composed lines spliced in. */
  private fullRepaintOr(parsed: { eraseCount: number }, lines: string[]): string | null {
    if (!this.windowRows()) return null;
    const n = parsed.eraseCount;
    const erase = n > 0 ? "\x1b[2K" + "\x1b[1A\x1b[2K".repeat(n - 1) + "\x1b[G" : "";
    return erase + lines.join("\n");
  }

  /** Imperative band repaint (scroll, append, warm upgrade): diff the new window against the previous
   * band, prefer the hardware scroll, paint the rest - without any Ink involvement. */
  private repaintBand(): void {
    if (!this.writer || !this.prev || !this.band) return;
    const win = this.windowRows();
    if (!win) return;
    const H = Math.min(this.band.height, this.prev.length);
    const prevBand = this.prev.slice(0, H);
    let anyChange = false;
    for (let i = 0; i < H; i++) if (win[i] !== prevBand[i]) { anyChange = true; break; }
    if (!anyChange) return;
    const top = this.band.top;
    let out = "";
    const shift = detectShift(prevBand, win, H);
    if (shift) {
      out += `${ESC}${top};${top + H - 1}r` + (shift.dir === "up" ? `${ESC}${shift.k}S` : `${ESC}${shift.k}T`) + `${ESC}r`;
      const shifted: (string | null)[] = [];
      for (let i = 0; i < H; i++) {
        shifted[i] = shift.dir === "up" ? (i < H - shift.k ? prevBand[i + shift.k] : null) : (i >= shift.k ? prevBand[i - shift.k] : null);
      }
      for (let i = 0; i < H; i++) if (shifted[i] !== win[i]) out += `${ESC}${top + i};1H` + win[i] + EL;
    } else {
      for (let i = 0; i < H; i++) if (win[i] !== prevBand[i]) out += `${ESC}${top + i};1H` + win[i] + EL;
    }
    out += `${ESC}${this.prev.length};1H`; // restore the cursor row Ink assumes (its frame's last line)
    for (let i = 0; i < H; i++) this.prev[i] = win[i];
    this.writer(out);
  }

  /** Optimized bytes to write INSTEAD of `payload`; "" = nothing changed (skip the write);
   * null = pass the payload through untouched (and the baseline resets/reseeds as appropriate). */
  process(payload: string): string | null {
    // NEUTRAL control writes: Ink 7 brackets every frame with its own BSU/ESU as SEPARATE writes
    // (write-synchronized.js), and hides/shows the cursor the same way. These carry no screen content -
    // pass them through but DO NOT reset the baseline, or the differ is blinded on every single frame
    // (exactly the bug the TTY bench caught: differ ON produced identical bytes to differ OFF).
    if (/^(?:\x1b\[\?[0-9;]+[hl])+$/.test(payload)) return null;
    const parsed = parseInkPayload(payload);
    if (!parsed) { this.prev = null; return null; } // not a standard rerender -> passthrough + reset
    // Compose: Ink rendered the band blank (when band content is on); splice the real window in, so
    // both the baseline and the diff operate on what the SCREEN should actually show.
    const lines = this.compose(parsed.frame.split("\n"));
    const prev = this.prev;
    this.prev = lines;
    if (!prev) return this.fullRepaintOr(parsed, lines); // seed: raw passthrough would show a blank band
    if (parsed.eraseCount !== prev.length) return this.fullRepaintOr(parsed, lines); // Ink's idea of prev differs -> resync
    if (lines.length !== prev.length) return this.fullRepaintOr(parsed, lines);      // height changed -> full rewrite

    const changed: number[] = [];
    for (let i = 0; i < lines.length; i++) if (lines[i] !== prev[i]) changed.push(i);
    if (changed.length === 0) return "";             // identical frame -> skip the write entirely

    // --- fullscreen scroll detection over the band ---
    const band = this.band;
    if (band && band.height >= 8 && changed.length > band.height / 2) {
      const scroll = detectShift(prev, lines, band.height);
      if (scroll) return emitScroll(prev, lines, band, scroll);
    }

    // --- plain line-diff ---
    let out = "";
    if (band) {
      // ABSOLUTE addressing in fullscreen (the frame is pinned at screen row 1 by alt+clear+home). This
      // is immune to cursor drift: any real-terminal quirk that leaves the cursor somewhere unexpected
      // (async BSU/ESU flush, a preceding hardware-scroll repaint) would derail RELATIVE moves and paint
      // a changed line one row off - the ghosted second input box seen on startup. Absolute can't drift.
      for (const i of changed) out += `${ESC}${i + 1};1H` + lines[i] + EL;
      out += `${ESC}${lines.length};1H`; // end on the last line - the row Ink assumes next render
    } else {
      // RELATIVE addressing inline: the frame floats in native scrollback, so its absolute row is
      // unknown; the cursor starts on the LAST line of the previous frame (where Ink leaves it).
      let cur = prev.length - 1;
      for (const i of changed) {
        out += moveRel(cur, i) + `${ESC}G` + lines[i] + EL;
        cur = i;
      }
      out += moveRel(cur, lines.length - 1);
    }
    return out;
  }
}

function moveRel(from: number, to: number): string {
  if (to < from) return `${ESC}${from - to}A`;
  if (to > from) return `${ESC}${to - from}B`;
  return "";
}

const SEL_ON = `${ESC}48;5;25m${ESC}97m`; // selection: solid blue background + bright-white text

/** Paint the VISIBLE columns [from, to) of a styled row with the UNIFORM selection colour (solid blue bg,
 * white fg), like a desktop / Claude-Code text selection. Inside the range the row's OWN colour codes are
 * DROPPED so the block is one flat colour (an inverse-video overlay looked patchy because it swapped each
 * char's own fg/bg). Outside the range the original colours are kept, and at the end of the selection the
 * row's colour state is reset and replayed so trailing text keeps its colour. Columns are counted while
 * SGR sequences pass through, so the block lands on the right screen columns. `to` may run past the row
 * (full-row / middle-of-multi-row selections pass to = MAX) - the block simply closes at the row end. */
function overlaySelection(row: string, from: number, to: number): string {
  if (from >= to) return row;
  let out = "", col = 0, i = 0, inSel = false, sgr = "";
  const close = () => `${ESC}0m${sgr}`; // reset the block colours, then replay the row's own colour state
  while (i < row.length) {
    if (row[i] === "\x1b" && row[i + 1] === "[") {
      const m = /^\x1b\[[0-9;]*[A-Za-z]/.exec(row.slice(i));
      if (m) { if (m[0].endsWith("m")) sgr += m[0]; if (!inSel) out += m[0]; i += m[0].length; continue; }
    }
    if (col === from && !inSel) { out += SEL_ON; inSel = true; }
    if (col === to && inSel) { out += close(); inSel = false; }
    out += row[i]; col++; i++;
  }
  if (inSel) out += close(); // selection reached/overran the end of the row
  return out;
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
