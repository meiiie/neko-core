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

import { setHitTargets } from "./hit-targets.ts";

export interface ScrollBand { top: number; height: number } // 1-based absolute top row of the scrollable band
const bandBase = (band: ScrollBand): number => Math.max(0, band.top - 1); // frame-array index

const ESC = "\x1b[";
const EL = `${ESC}K`; // erase to end of line

/** Zero-width marker TextInput plants at the caret position; the differ finds it, strips it, and puts
 * the REAL terminal cursor (a bar) there - the caret sits BETWEEN cells with zero width (Claude Code's
 * "khả|o"), not a drawn glyph in its own cell (which reads as a gap). U+2060 (WORD JOINER) is zero-width
 * and effectively never appears in a typed prompt. Defined HERE (a React-free leaf) so both TextInput
 * and the differ share it without a UI dependency cycle. */
export const CARET_SENTINEL = "⁠";
/** Zero-width marker for the START of a clickable zone (U+2063 INVISIBLE SEPARATOR - never typed,
 * width 0 for both string-width and cellW below). Components prefix clickable text with it; the
 * differ strips it and records its screen cell into ui/hit-targets.ts for pointer hit-testing. */
export const HIT_SENTINEL = "⁣";
const SGR_RE = /\x1b\[[0-9;]*m/g;
/** DECSCUSR style for the hardware caret: NEKO_CARET picks it, default a BLINKING BAR (like Claude Code). */
function caretStyle(): string {
  switch ((process.env.NEKO_CARET || "").toLowerCase()) {
    case "block": return `${ESC}1 q`;      // blinking block
    case "underline": return `${ESC}3 q`;  // blinking underline
    default: return `${ESC}5 q`;           // blinking bar
  }
}
/** Display column (1-based) of the FIRST caret sentinel in a row, or 0 if absent. Counts visible cell
 * width BEFORE the sentinel, skipping SGR colour codes (so a coloured prompt doesn't offset the column). */
function cellW(cp: number): number {
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2060 && cp <= 0x2064) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0; // combining / zero-width (incl. both sentinels)
  if (cp >= 0x1f000 || (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)) return 2; // CJK / emoji
  return 1;
}
/** Display column (1-based) of the character AT string index `idx`: visible cell width before it,
 * skipping SGR/OSC escape bytes (a coloured row must not offset the column). */
function colAt(row: string, idx: number): number {
  let col = 0, i = 0;
  while (i < idx) {
    if (row.charCodeAt(i) === 27 && row[i + 1] === "[") { const m = /^\[[0-9;]*[A-Za-z]/.exec(row.slice(i)); if (m) { i += m[0].length; continue; } }
    if (row.charCodeAt(i) === 27 && row[i + 1] === "]") { const m = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(row.slice(i)); if (m) { i += m[0].length; continue; } } // OSC (hyperlink) = zero-width, skip like SGR
    const cp = row.codePointAt(i)!;
    col += cellW(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return col + 1; // the cell just after everything before `idx`
}
function sentinelCol(row: string): number {
  const idx = row.indexOf(CARET_SENTINEL);
  return idx < 0 ? 0 : colAt(row, idx); // the cursor sits just before the char that follows the sentinel
}

// Optional NDJSON trace for diagnosing model-to-screen divergence under a real PTY.
const TRACE = process.env.NEKO_TRACE_FRAMES;
function trace(ev: any): void {
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
  // Only text, SGR and OSC 8 links are safe to diff; other terminal controls pass through intact.
  if (/\x1b\[[0-9;]*[ABCDEFGHJKSTr]/.test(frame) || /\x1b\](?!8;;)/.test(frame)) return null;
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

  // Hardware scroll is safe only when the painted and current band geometry agree.
  private paintedBand: ScrollBand | null = null;
  private markPainted(): void { this.paintedBand = this.band ? { ...this.band } : null; }
  // Windows defaults to absolute repaint because ConPTY can displace rows outside DECSTBM.
  private hwScrollEnabled(): boolean {
    const v = process.env.NEKO_HWSCROLL;
    if (v === "1") return true;
    if (v === "0") return false;
    return process.platform !== "win32";
  }

  // Periodic absolute repaint bounds residual ConPTY displacement during bursts and streaming.
  private lastResyncAt = 0;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  /** Absolute repaint of the whole model. Empty rows still get EL: after a resize/reflow the reserved
   * last row may contain stale chrome, and merely moving the cursor there leaves that ghost visible. */
  private paintAll(): string {
    const lines = this.prev!;
    let out = "";
    for (let i = 0; i < lines.length; i++) out += `${ESC}${i + 1};1H` + lines[i] + EL;
    // Clear the unowned spare row after resize so reflowed text cannot survive below the footer.
    out += `${ESC}${lines.length + 1};1H${EL}`;
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
      this.writer(this.paintAll() + this.cursorSuffix());
    }, 400);
    // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
    (this.resyncTimer as any).unref?.();
  }
  /** Stop the heal timer (teardown). */
  dispose(): void { if (this.resyncTimer) { clearTimeout(this.resyncTimer); this.resyncTimer = null; } }

  /** Force a full absolute repaint of the CURRENT model - used after a resize so the band never depends
   * on a follow-up frame to appear. The dimension-change re-render already updated `prev` to the new size;
   * painting it in full (absolute rows) is immune to Ink skipping a byte-identical chrome. Before, the
   * caret's periodic blink accidentally supplied that follow-up frame; the hardware caret is static, so
   * this must be explicit (fullscreen-sim caught a black screen after a shrink otherwise). */
  forceFullRepaint(): void {
    // An unrecognized control write can reset `prev` while `lastRaw` still points at the old geometry.
    // Never replay that stale raw frame; only repaint when a current parsed model still exists.
    if (!this.writer || !this.lastRaw || !this.band || !this.prev) { this.prev = null; return; }
    const lines = this.compose(this.lastRaw.slice()); // recompose the LATEST Ink frame at the CURRENT band geometry
    const hits = this.extractCursor(lines);
    this.prev = lines;
    this.markPainted();
    this.writer(this.paintAll() + this.cursorSuffix());
    setHitTargets(hits);
  }
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

  // The stripped caret sentinel drives the terminal's native cursor; overlays omit it to hide the caret.
  private cursorPos: { row: number; col: number } | null = null;
  private caretActive = false;
  /** Find the caret sentinel in the composed lines, record its (row, col), and STRIP every sentinel so
   * it neither displays nor shifts a column. Called on each real frame (process). */
  private extractCursor(lines: string[]): { row: number; col: number }[] {
    let found = false;
    const hits: { row: number; col: number }[] = [];
    for (let r = 0; r < lines.length; r++) {
      // Click-zone anchors first (both sentinels are zero-width to cellW, so order is cosmetic).
      if (lines[r].indexOf(HIT_SENTINEL) >= 0) {
        for (let idx = lines[r].indexOf(HIT_SENTINEL); idx >= 0; idx = lines[r].indexOf(HIT_SENTINEL, idx + 1)) {
          hits.push({ row: r + 1, col: colAt(lines[r], idx) });
        }
        lines[r] = lines[r].split(HIT_SENTINEL).join("");
      }
      if (lines[r].indexOf(CARET_SENTINEL) < 0) continue;
      if (!found) { this.cursorPos = { row: r + 1, col: sentinelCol(lines[r]) }; found = true; }
      lines[r] = lines[r].split(CARET_SENTINEL).join(""); // strip (may be >1 if pasted; harmless)
    }
    this.caretActive = found;
    if (!found) this.cursorPos = null;
    return hits;
  }
  /** Screen cell (1-based row/col) of the hardware caret, if one is on screen. Click-to-caret uses
   * this as the anchor: the pointer handler passes TextInput the click's DELTA from this cell and
   * the layout math stays inside TextInput (the only code that knows the wrap geometry). */
  caretScreenPos(): { row: number; col: number } | null {
    return this.caretActive ? this.cursorPos : null;
  }
  /** Trailing bytes that place (and show) the real cursor at the caret, or hide it when inactive. Appended
   * after every frame the differ writes so the cursor lands on the input no matter what else repainted. */
  private cursorSuffix(): string {
    // Fullscreen (band) only - inline uses relative frames where an absolute CUP would be wrong.
    if (!this.band) return "";
    // No active caret (an overlay / picker / approval box owns the screen): HIDE the hardware
    // cursor. The differ OWNS cursor visibility once it has shown the caret at an input frame, so
    // Ink does not re-hide it on the next frame - we must, or the blinking bar lingers in the
    // corner over the menu (the stray `|` under the browser-setup picker). Idempotent.
    if (!this.caretActive || !this.cursorPos) return `${ESC}?25l`;
    return `${ESC}?25h` + caretStyle() + `${ESC}${this.cursorPos.row};${this.cursorPos.col}H`;
  }

  /** Re-compose the last raw frame under the CURRENT band geometry and paint the delta (absolute rows). */
  private refreshCompose(): void {
    if (!this.writer || !this.prev || !this.lastRaw) return;
    const lines = this.compose(this.lastRaw.slice());
    if (lines.length !== this.prev.length) { trace({ ev: "refreshCompose-skip", raw: lines.length, prev: this.prev.length }); return; } // dimensions changed too - the next real frame reseeds
    const hits = this.extractCursor(lines); // only update hit/caret state for an accepted frame
    let out = "";
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== this.prev[i]) { out += `${ESC}${i + 1};1H` + lines[i] + EL; this.prev[i] = lines[i]; }
    }
    trace({ ev: "refreshCompose", rows: rowsOf(out) });
    if (out) { this.writer(out + `${ESC}${this.prev.length};1H` + this.cursorSuffix()); this.armTrailingResync(); }
    setHitTargets(hits); // publish only after the dimension check and optional paint succeeded
    this.markPainted(); // model is now consistent with the CURRENT geometry
  }

  // Selection anchors to content rows so it remains stable while the viewport scrolls beneath it.
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
   * selection overlay is SGR and hyperlinks are OSC 8 - stripping both leaves the real transcript text
   * (for a bare URL the visible text IS the url, so a copied link stays a link). */
  screenText(top: number, bottom: number): string[] {
    const out: string[] = [];
    for (let y = top; y <= bottom; y++) {
      out.push((this.prev?.[y - 1] ?? "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, ""));
    }
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
    // Slice across committed rows and the live tail without materializing their concatenation.
    const total = this.bandRows.length + this.bandTail.length;
    const end = Math.max(0, total - this.bandDist);
    const start = Math.max(0, end - H);
    const slice: string[] = [];
    for (let i = start; i < end; i++) {
      slice.push(i < this.bandRows.length ? this.bandRows[i] : this.bandTail[i - this.bandRows.length]);
    }
    while (slice.length < H) slice.push("");
    // First and last selected content rows use column bounds; middle rows fill the viewport.
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
    const base = bandBase(this.band);
    for (let i = 0; i < this.band.height && base + i < out.length; i++) out[base + i] = win[i];
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
    const base = bandBase(this.band);
    const H = Math.min(this.band.height, Math.max(0, this.prev.length - base));
    const prevBand = this.prev.slice(base, base + H);
    let anyChange = false;
    for (let i = 0; i < H; i++) if (win[i] !== prevBand[i]) { anyChange = true; break; }
    if (!anyChange) return;
    const top = this.band.top;
    let out = "";
    // A shift after geometry changes is re-anchoring, not a hardware-scroll candidate.
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
    for (let i = 0; i < H; i++) this.prev[base + i] = win[i];
    // Sustained activity receives periodic full repaint even without an idle window.
    if (this.healEnabled() && Date.now() - this.lastResyncAt > 2000) out = this.paintAll();
    else out += `${ESC}${this.prev.length};1H`; // restore the cursor row Ink assumes (its frame's last line)
    this.writer(out + this.cursorSuffix()); // re-place the hardware caret after a scroll/repaint
    this.markPainted();
    this.armTrailingResync();
  }

  /** Optimized bytes to write INSTEAD of `payload`; "" = nothing changed (skip the write);
   * null = pass the payload through untouched. Wraps the diff so the hardware caret (cursorSuffix) is
   * re-placed after every real write - the terminal cursor lands on the input no matter what repainted. */
  private lastCursorKey = "";
  process(payload: string): string | null {
    const out = this.processInner(payload);
    if (out === null) return null; // passthrough (extractCursor did not run) - leave the cursor alone
    // The caret sentinel is stripped BEFORE the diff, so moving the caret (same visible text) produces
    // an IDENTICAL frame ("" ) - but the cursor still has to move. Emit the cursor suffix on a caret-only
    // move, and refresh it after any real write. Key = active position (or "" when hidden).
    const key = this.caretActive && this.cursorPos ? `${this.cursorPos.row},${this.cursorPos.col}` : "";
    if (out === "") {
      if (key === this.lastCursorKey) return "";      // nothing changed, caret didn't move -> skip
      this.lastCursorKey = key;
      return this.cursorSuffix();                       // caret-only move: reposition the hardware cursor
    }
    this.lastCursorKey = key;
    return out + this.cursorSuffix();
  }
  private processInner(payload: string): string | null {
    // Ink emits BSU/ESU and cursor controls separately; they must not reset the frame baseline.
    if (/^(?:\x1b\[\?[0-9;]+[hl])+$/.test(payload)) return null;
    // Ink sometimes handles a resize as an explicit wipe immediately followed by its new full frame.
    // Passing that through would paint the frame's intentionally BLANK transcript band and reset our
    // model; replaying lastRaw afterward would instead resurrect the OLD-sized frame. Consume this one
    // exact shape, compose the new raw frame now, and repaint it absolutely after the wipe.
    const wiped = /^((?:(?:\x1b\[2J|\x1b\[3J|\x1b\[H))+)([\s\S]+)$/.exec(payload);
    if (wiped && this.band) {
      const afterWipe = parseInkPayload(wiped[2]);
      if (afterWipe && afterWipe.eraseCount === 0) {
        this.lastRaw = afterWipe.frame.split("\n");
        const lines = this.compose(this.lastRaw.slice());
        const hits = this.extractCursor(lines);
        this.prev = lines;
        this.markPainted();
        setHitTargets(hits);
        trace({ ev: "wipe-seed", n: lines.length });
        return wiped[1] + this.paintAll();
      }
    }
    const parsed = parseInkPayload(payload);
    if (!parsed) { trace({ ev: "passthru-reset", head: payload.slice(0, 40) }); this.prev = null; return null; } // not a standard rerender -> passthrough + reset
    // Compose: Ink rendered the band blank (when band content is on); splice the real window in, so
    // both the baseline and the diff operate on what the SCREEN should actually show.
    this.lastRaw = parsed.frame.split("\n"); // kept for setBand's geometry refresh (Ink skips identical frames)
    const lines = this.compose(this.lastRaw.slice());
    const hits = this.extractCursor(lines); // pull sentinels out BEFORE diffing; publish after acceptance
    const prev = this.prev;
    const geomOk = this.sameGeometry(); // BEFORE the mark: was `prev` painted under this geometry?
    this.prev = lines;
    this.markPainted(); // every path below leaves the model consistent with the CURRENT geometry
    setHitTargets(hits); // every accepted frame clears/replaces stale zones from dismissed surfaces
    if (!prev) { trace({ ev: "seed", n: lines.length }); return this.fullRepaintOr(parsed, lines); } // seed: raw passthrough would show a blank band
    if (parsed.eraseCount !== prev.length) { trace({ ev: "resync-erase", erase: parsed.eraseCount, prev: prev.length, n: lines.length }); return this.fullRepaintOr(parsed, lines); } // Ink's idea of prev differs -> resync
    if (lines.length !== prev.length) { trace({ ev: "resync-height", prev: prev.length, n: lines.length }); return this.fullRepaintOr(parsed, lines); }      // height changed -> full rewrite

    const changed: number[] = [];
    for (let i = 0; i < lines.length; i++) if (lines[i] !== prev[i]) changed.push(i);
    if (changed.length === 0) return "";             // identical frame -> skip the write entirely

    // Chrome changes invalidate band-only hardware-scroll detection.
    const band = this.band;
    if (band && geomOk && this.hwScrollEnabled() && band.height >= 8 && changed.length > band.height / 2) {
      const base = bandBase(band);
      const end = Math.min(lines.length, base + band.height);
      let chromeUnchanged = true;
      for (let i = 0; i < lines.length; i++) {
        if ((i < base || i >= end) && lines[i] !== prev[i]) { chromeUnchanged = false; break; }
      }
      if (chromeUnchanged) {
        const scroll = detectShift(prev.slice(base, end), lines.slice(base, end), end - base);
        if (scroll) { trace({ ev: "hw-scroll", dir: scroll.dir, k: scroll.k, bandH: band.height, n: lines.length }); return emitScroll(prev, lines, band, scroll); }
      }
    }

    let out = "";
    trace({ ev: "diff", changed: changed.map((i) => i + 1), n: lines.length, bandH: band?.height });
    // Only structural writes arm healing; caret and status ticks must leave an idle screen silent.
    const risky = band && this.healEnabled() && changed.length >= 8;
    if (risky && Date.now() - this.lastResyncAt > 2000) { this.armTrailingResync(); return this.paintAll(); }
    if (risky) this.armTrailingResync();
    if (band) {
      // Fullscreen frames are pinned to row one, so changed rows use absolute addressing.
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
  // Close OSC 8 links before the selection block so a clipped link cannot bleed into it.
  const isOsc = (): RegExpExecArray | null => (row[i] === "\x1b" && row[i + 1] === "]" ? /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(row.slice(i)) : null);
  let out = "", col = 0, i = 0, sgr = "";
  for (let m; col < from && i < row.length; ) {
    if ((m = isSgr())) { if (m[0].endsWith("m")) sgr += m[0]; out += m[0]; i += m[0].length; continue; }
    if ((m = isOsc())) { out += m[0]; i += m[0].length; continue; }
    out += row[i]; col++; i++;
  }
  while (col < from) { out += " "; col++; } // pad if the row ended before the block starts (trailing space)
  out += "\x1b]8;;\x07" + SEL_ON; // close any open hyperlink (a stray close is a no-op), then highlight
  for (let m; col < cap && i < row.length; ) {
    if ((m = isSgr())) { if (m[0].endsWith("m")) sgr += m[0]; i += m[0].length; continue; }
    if ((m = isOsc())) { i += m[0].length; continue; }
    out += row[i]; col++; i++;
  }
  if (cap !== Infinity) while (col < cap) { out += " "; col++; } // pad the block out to a solid rectangle
  out += `${ESC}0m${sgr}`;
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
  const base = bandBase(band);              // 0-based frame index
  const bottom = band.top + band.height - 1;
  let out = `${ESC}${top};${bottom}r`;     // DECSTBM: confine scrolling to the band
  out += s.dir === "up" ? `${ESC}${s.k}S` : `${ESC}${s.k}T`; // SU / SD: the terminal shifts the region
  out += `${ESC}r`;                        // reset margins (also homes the cursor - we CUP everywhere below)
  // What the shift made of the band, per line; then paint every line that still differs from `next`
  // (the k revealed rows + any noise rows the detector tolerated).
  const shifted: (string | null)[] = [];
  for (let i = 0; i < band.height; i++) {
    shifted[i] = s.dir === "up"
      ? (i < band.height - s.k ? prev[base + i + s.k] : null)   // null = blank revealed row
      : (i >= s.k ? prev[base + i - s.k] : null);
  }
  for (let i = 0; i < band.height; i++) {
    if (shifted[i] !== next[base + i]) out += `${ESC}${top + i};1H` + next[base + i] + EL;
  }
  for (let i = 0; i < next.length; i++) {
    if ((i < base || i >= base + band.height) && next[i] !== prev[i]) out += `${ESC}${i + 1};1H` + next[i] + EL;
  }
  out += `${ESC}${next.length};1H`;        // end on the last frame line, as Ink expects
  return out;
}
