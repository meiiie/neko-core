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

import { appendFileSync } from "node:fs";

export interface ScrollBand { top: number; height: number } // 1-based absolute top row of the scrollable band

const ESC = "\x1b[";
const EL = `${ESC}K`; // erase to end of line

// Diagnostic tap (NEKO_TRACE_FRAMES=<file>): NDJSON of every differ decision - what the model believed
// and what rows were emitted. This is `doctor keys` for the RENDER side: model-vs-screen divergence
// bugs (ghost rows) are invisible in unit sims and only reproducible under a real ConPTY; the tap turns
// a field screenshot into a byte-level timeline. Zero cost when the env is unset.
const TRACE = process.env.NEKO_TRACE_FRAMES;
function trace(ev: Record<string, unknown>): void {
  if (!TRACE) return;
  try { appendFileSync(TRACE, JSON.stringify({ t: Date.now(), ...ev }) + "\n"); } catch { /* diagnostics never break rendering */ }
}
/** Rows targeted by the emitted bytes (from its CUP sequences) - the screen-truth of a write. */
function rowsOf(out: string): number[] {
  const rows: number[] = [];
  for (const m of out.matchAll(/\x1b\[(\d+);\d*H?/g)) rows.push(Number(m[1]));
  return rows;
}

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

  private lastRaw: string[] | null = null; // the last RAW Ink frame (pre-compose), for geometry refresh

  // The band geometry under which `prev` (the screen model) was LAST painted. A hardware scroll
  // (DECSTBM+SU/SD) moves REAL screen rows; it is only safe while model and screen agree on which
  // rows are band. Right after setBand changes the geometry, screen rows just beyond the OLD band
  // still hold CHROME - a scroll region sized to the NEW band would physically drag those chrome
  // rows along while the model updates only band rows, and the divergence is permanent (the
  // duplicated-footer ghost, images #77/#78: SD1 over rows 1..24 while screen rows 23-24 were the
  // rule + input line). So: scroll ONLY when paintedBand === band; otherwise plain absolute rows.
  private paintedBand: ScrollBand | null = null;
  private markPainted(): void { this.paintedBand = this.band ? { ...this.band } : null; }
  // Hardware scroll (DECSTBM+SU/SD) switch. OFF BY DEFAULT ON WINDOWS: at real write cadence,
  // ConPTY displaces content OUTSIDE the DECSTBM region (the e2e divergence probe caught the chrome
  // one row off right after a region scroll; paced probes pass - it takes live timing). Plain
  // absolute row repaints cannot be displaced. Unix PTYs keep the optimization; NEKO_HWSCROLL=1/0
  // forces either way.
  private hwScrollEnabled(): boolean {
    const v = process.env.NEKO_HWSCROLL;
    if (v === "1") return true;
    if (v === "0") return false;
    return process.platform !== "win32";
  }

  // SELF-HEALING RESYNC - the answer to conhost's residual displacement (the one-row ghost that
  // survived every targeted fix; its mechanism lives inside ConPTY's buffer/viewport handling, not
  // in our bytes). We cannot stop the displacement from ever happening, but we CAN bound its
  // lifetime: a full ABSOLUTE repaint of the model (CUP per row + EL - cannot be displaced, erases
  // anything stale) runs (a) ~400ms after each burst of writes goes quiet (trailing debounce - the
  // screen the user actually looks at is always freshly healed) and (b) at least every ~2s during
  // sustained activity (streaming). Cost: one plain frame per pause. A curses-style ^L, automated.
  private lastResyncAt = 0;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  /** Absolute repaint of the whole model (skips a trailing empty line - see fullRepaintOr). */
  private paintAll(): string {
    const lines = this.prev!;
    const n = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    let out = "";
    for (let i = 0; i < n; i++) out += `${ESC}${i + 1};1H` + lines[i] + EL;
    this.lastResyncAt = Date.now();
    return out + `${ESC}${lines.length};1H`;
  }
  /** The disease (conhost displacement) exists only on Windows - elsewhere the heal would be pure
   * overhead (notably SSH links paying ~10KB per pause for nothing). */
  private healEnabled(): boolean { return process.platform === "win32"; }
  private armTrailingResync(): void {
    if (!this.healEnabled() || !this.band) return; // inline frames float in scrollback - absolute repaints don't apply
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (!this.writer || !this.prev || !this.band) return;
      trace({ ev: "resync-heal" });
      this.writer(this.paintAll());
    }, 400);
    (this.resyncTimer as any).unref?.();
  }
  /** Stop the heal timer (teardown). */
  dispose(): void { if (this.resyncTimer) { clearTimeout(this.resyncTimer); this.resyncTimer = null; } }
  private sameGeometry(): boolean {
    return !!this.band && !!this.paintedBand &&
      this.paintedBand.top === this.band.top && this.paintedBand.height === this.band.height;
  }

  /** The scrollable band (fullscreen viewport), in absolute rows. MUST only be set when the Ink frame
   * starts at screen row 1 (our fullscreen: alt-screen + clear + home), because scroll emission uses
   * absolute addressing. null = band detection off (inline). A GEOMETRY CHANGE re-composes the last raw
   * frame in place: Ink skips byte-identical frames entirely, so when viewH shrinks (a picker opened) the
   * re-render often writes NOTHING - without this, the screen stays frozen with the old composition
   * (stale transcript rows sitting over the /resume picker, image #60). */
  setBand(band: ScrollBand | null): void {
    const changed = this.band?.top !== band?.top || this.band?.height !== band?.height;
    if (changed) trace({ ev: "setBand", top: band?.top, h: band?.height, prevLen: this.prev?.length });
    this.band = band;
    if (changed && band) this.refreshCompose();
  }
  reset(): void { this.prev = null; }

  /** Re-compose the last raw frame under the CURRENT band geometry and paint the delta (absolute rows). */
  private refreshCompose(): void {
    if (!this.writer || !this.prev || !this.lastRaw) return;
    const lines = this.compose(this.lastRaw.slice());
    if (lines.length !== this.prev.length) { trace({ ev: "refreshCompose-skip", raw: lines.length, prev: this.prev.length }); return; } // dimensions changed too - the next real frame reseeds
    let out = "";
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== this.prev[i]) { out += `${ESC}${i + 1};1H` + lines[i] + EL; this.prev[i] = lines[i]; }
    }
    trace({ ev: "refreshCompose", rows: rowsOf(out) });
    if (out) { this.writer(out + `${ESC}${this.prev.length};1H`); this.armTrailingResync(); }
    this.markPainted(); // model is now consistent with the CURRENT geometry
  }

  // Text selection (mouse drag-to-copy): a highlighted region over the band, anchored to CONTENT rows
  // (indices into bandRows), NOT screen rows - so a drag can extend past the top/bottom edge and the
  // view can scroll under it while the highlight stays on the same text (the "drag up to select above
  // the fold" case). windowRows maps content rows -> screen rows from the CURRENT scroll distance, so
  // every repaint (scroll hop included) re-lands the highlight correctly with no per-scroll bookkeeping.
  // Columns include the 2-space gutter (bandRows are full screen rows), so screen col X = string index X-1.
  private selection: { r0: number; c0: number; r1: number; c1: number } | null = null; // r0/r1 = CONTENT row indices
  private selWidth = 0; // pad spanned rows out to this screen column so the block is a solid rectangle
  /** Highlight a selection over the band (r0/r1 are CONTENT row indices into bandRows); null clears it.
   * `width` = the content right-edge column, so a multi-row selection paints as a full-width rectangle. */
  setSelection(sel: { r0: number; c0: number; r1: number; c1: number } | null, width = 0): void {
    this.selection = sel;
    this.selWidth = width;
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
    // Selection highlight: r0/r1 are CONTENT row indices. The slice index i shows content row `start+i`,
    // so a row is selected when start+i is within [r0, r1]. Column bounds apply on the first/last CONTENT
    // rows; middle rows fill to the right edge. Because start comes from the CURRENT scroll distance, the
    // highlight follows the text as the view scrolls - no screen-coordinate bookkeeping on scroll.
    if (this.selection) {
      const s = this.selection;
      for (let i = 0; i < slice.length; i++) {
        const c = start + i; // content row shown at slice index i
        if (c < s.r0 || c > s.r1) continue;
        const from = c === s.r0 ? s.c0 - 1 : 0;                          // 1-based screen col -> 0-based
        const to = c === s.r1 ? s.c1 : (this.selWidth || Number.MAX_SAFE_INTEGER); // last row stops at c1; the
        slice[i] = overlaySelection(slice[i], Math.max(0, from), to);    // rest fill to the content right edge
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

  /** On seed/resync frames: INLINE (no band), raw passthrough is correct and cheapest (null).
   * In FULLSCREEN, paint the frame with ABSOLUTE addressing, one row at a time - ALWAYS, even before
   * any band content exists. Two reasons, both learned from one-row ghosts:
   *  - relative erase drifts when the cursor is not where Ink assumes (images #35, #63);
   *  - a raw newline-flow frame SCROLLS the real terminal when its trailing "\n" lands on the bottom
   *    row. That is exactly Ink's FIRST frame (no erase prefix, trailing newline) passed through
   *    before the band content arrived: the screen scrolled one row at birth, the model stayed
   *    pinned at row 1, and every later absolute write painted one row below the original chrome -
   *    the duplicated footer/prompt of images #77/#78. Absolute rows cannot scroll, ever. */
  private fullRepaintOr(parsed: { eraseCount: number }, lines: string[]): string | null {
    if (!this.band) return null;
    // `lines` IS this.prev at every call site - paintAll paints exactly it (and stamps the resync
    // clock: a seed/resync is already a full heal).
    this.armTrailingResync();
    return this.paintAll();
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
    // Geometry changed since the model was last painted -> a detected "shift" is a re-anchoring
    // artifact of the new slice, not a real scroll. Plain absolute rows only (they self-heal).
    const shift = this.hwScrollEnabled() && this.sameGeometry() ? detectShift(prevBand, win, H) : null;
    trace({ ev: "repaintBand", top, H, prevLen: this.prev.length, shift: shift ? `${shift.dir}${shift.k}` : null, geomOk: this.sameGeometry() });
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
    for (let i = 0; i < H; i++) this.prev[i] = win[i];
    // Sustained activity (a long scroll, streaming) never goes quiet enough for the trailing heal -
    // fold a full repaint in at least every ~2s so displacement can't accumulate mid-gesture.
    if (this.healEnabled() && Date.now() - this.lastResyncAt > 2000) out = this.paintAll();
    else out += `${ESC}${this.prev.length};1H`; // restore the cursor row Ink assumes (its frame's last line)
    this.writer(out);
    this.markPainted();
    this.armTrailingResync();
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
    if (!parsed) { trace({ ev: "passthru-reset", head: payload.slice(0, 40) }); this.prev = null; return null; } // not a standard rerender -> passthrough + reset
    // Compose: Ink rendered the band blank (when band content is on); splice the real window in, so
    // both the baseline and the diff operate on what the SCREEN should actually show.
    this.lastRaw = parsed.frame.split("\n"); // kept for setBand's geometry refresh (Ink skips identical frames)
    const lines = this.compose(this.lastRaw.slice());
    const prev = this.prev;
    const geomOk = this.sameGeometry(); // BEFORE the mark: was `prev` painted under this geometry?
    this.prev = lines;
    this.markPainted(); // every path below leaves the model consistent with the CURRENT geometry
    if (!prev) { trace({ ev: "seed", n: lines.length }); return this.fullRepaintOr(parsed, lines); } // seed: raw passthrough would show a blank band
    if (parsed.eraseCount !== prev.length) { trace({ ev: "resync-erase", erase: parsed.eraseCount, prev: prev.length, n: lines.length }); return this.fullRepaintOr(parsed, lines); } // Ink's idea of prev differs -> resync
    if (lines.length !== prev.length) { trace({ ev: "resync-height", prev: prev.length, n: lines.length }); return this.fullRepaintOr(parsed, lines); }      // height changed -> full rewrite

    const changed: number[] = [];
    for (let i = 0; i < lines.length; i++) if (lines[i] !== prev[i]) changed.push(i);
    if (changed.length === 0) return "";             // identical frame -> skip the write entirely

    // --- fullscreen scroll detection over the band ---
    // ONLY when the chrome BELOW the band is untouched: a real scroll moves band rows and nothing else.
    // When the chrome changes shape in the same frame (an overlay/picker opens, the input grows), a
    // near-uniform shift can still be detected across the frame - but emitScroll would hardware-shift
    // REAL screen rows beyond its model, desyncing the baseline from the screen and leaving residue the
    // next diffs never repair (the mangled /resume picker, image #60). Chrome changed -> plain line-diff.
    const band = this.band;
    if (band && geomOk && this.hwScrollEnabled() && band.height >= 8 && changed.length > band.height / 2) {
      let chromeUnchanged = true;
      for (let i = band.height; i < lines.length; i++) if (lines[i] !== prev[i]) { chromeUnchanged = false; break; }
      if (chromeUnchanged) {
        const scroll = detectShift(prev, lines, band.height);
        if (scroll) { trace({ ev: "hw-scroll", dir: scroll.dir, k: scroll.k, bandH: band.height, n: lines.length }); return emitScroll(prev, lines, band, scroll); }
      }
    }

    // --- plain line-diff ---
    let out = "";
    trace({ ev: "diff", changed: changed.map((i) => i + 1), n: lines.length, bandH: band?.height });
    // Heal scheduling is SELECTIVE: only structurally-risky writes arm it (many rows changing =
    // layout churn, the displacement's habitat). Small diffs - the caret blink, the spinner, the
    // ctx% tick - must NOT arm, or an idle session heals every second forever (blink 530ms beats a
    // 400ms trailing timer). Idle stays byte-silent; risky moments still get the belt.
    const risky = band && this.healEnabled() && changed.length >= 8;
    if (risky && Date.now() - this.lastResyncAt > 2000) { this.armTrailingResync(); return this.paintAll(); }
    if (risky) this.armTrailingResync();
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
  const cap = to === Number.MAX_SAFE_INTEGER ? Infinity : to;
  const isSgr = (): RegExpExecArray | null => (row[i] === "\x1b" && row[i + 1] === "[" ? /^\x1b\[[0-9;]*[A-Za-z]/.exec(row.slice(i)) : null);
  let out = "", col = 0, i = 0, sgr = "";
  // 1. content BEFORE the block: emit verbatim, tracking colour state.
  for (let m; col < from && i < row.length; ) {
    if ((m = isSgr())) { if (m[0].endsWith("m")) sgr += m[0]; out += m[0]; i += m[0].length; continue; }
    out += row[i]; col++; i++;
  }
  while (col < from) { out += " "; col++; } // pad if the row ended before the block starts (trailing space)
  // 2. INSIDE the block: one flat colour - drop the row's own SGR (keep tracking state), fill to the edge.
  out += SEL_ON;
  for (let m; col < cap && i < row.length; ) {
    if ((m = isSgr())) { if (m[0].endsWith("m")) sgr += m[0]; i += m[0].length; continue; }
    out += row[i]; col++; i++;
  }
  if (cap !== Infinity) while (col < cap) { out += " "; col++; } // pad the block out to a solid rectangle
  out += `${ESC}0m${sgr}`; // 3. close: reset the block, replay the row's colour state...
  while (i < row.length) { out += row[i]; i++; } // ...then emit any content AFTER the block (last-row suffix)
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
