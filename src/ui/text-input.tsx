/**
 * Minimal Ink-native text input. Replaces ink-text-input (mangled Vietnamese/IME).
 *
 * Vietnamese IME (Telex/Unikey) composes a toned vowel by sending backspace + the new char
 * back-to-back. With a captured `value` prop those two events both read the STALE value
 * (no re-render between them) -> "mọi" became "moọi". Fix: keep the live value in a ref and
 * mutate it synchronously, so each keypress sees the latest. NFC + codepoint-safe.
 *
 * Cursor: a codepoint index (also a ref, for the same IME reason). The caret is the terminal's REAL
 * hardware cursor (a bar BETWEEN cells, like Claude Code's "khả|o") - no glyph is drawn in the text.
 * TextInput only marks the position with the zero-width CARET_SENTINEL; the FrameDiffer strips it and
 * positions the cursor there, and the terminal blinks it natively. Long input wraps to multiple visual
 * lines (display-width aware); the line holding the caret carries the sentinel.
 */
import { Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  expandPlaceholders,
  formatPlaceholder,
  gcPastes as gcPastesImpl,
  shouldCollapsePaste,
} from "../shared/paste-collapse.ts";
import { CARET_SENTINEL } from "./frame-diff.ts";

/** Caret glyph styles for the EOL/empty caret (config `caret_glyph` / NEKO_CARET). Mid-text the
 * caret is an inverse-video overlay instead - a glyph there would shift the line sideways. */
export type CaretStyle = "thin-block" | "bar" | "block" | "underline";
export const CARET_GLYPHS = {
  "thin-block": "\u258f", // ▏ LEFT ONE EIGHTH BLOCK - hugs the left edge of its cell (default)
  bar: "\u2502", // │ BOX DRAWINGS LIGHT VERTICAL - centred in its cell
  block: "\u2588", // █ FULL BLOCK - covers the cell
  underline: "\u2581", // ▁ LOWER ONE EIGHTH BLOCK - sits at the cell bottom
};
/** Resolve an arbitrary user/config string to a CaretStyle, defaulting to "thin-block". */
export function resolveCaretStyle(s: string | null | undefined): CaretStyle {
  if (s === "bar" || s === "block" || s === "underline") return s;
  return "thin-block";
}


/** Escape-sequence residue that must NEVER be inserted as text: mouse reports ("[<64;10;5M"), cursor
 * keys, private-mode echoes - alone or as a BURST of several sequences concatenated in one chunk (a
 * fast wheel flick delivers exactly that, and it used to leak past the single-sequence guard). Ink
 * splits the leading ESC off as its own keypress and can deliver the rest as literal text, so the ESC
 * is optional per sequence. A real keystroke is a single printable char and never matches; the only
 * false-positive is pasting a string shaped exactly like raw CSI sequences - vanishingly rare.
 * Shared by every type-to-filter/type-to-edit surface (TextInput, SelectList, the fullscreen find bar). */
export function isEscapeResidue(s: string): boolean {
  return /^(?:\x1b?\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e])+$/.test(s);
}

/** Display width of a single codepoint (0 for combining marks/zero-width, 1 narrow, 2 wide CJK/emoji). */
export function cellWidth(cp: string): number {
  const codePoint = cp.codePointAt(0) ?? 0;
  const w = cp.match(/[\u0300-\u036F\u200B-\u200F\uFE00-\uFE0F]/)
    ? 0
    : (codePoint >= 0x1F000 || /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u.test(cp))
      ? 2
      : 1;
  return w;
}

/** Visual lines from codepoints, each <= `width` display cols. Honors hard "\n" breaks and display
 * width (not codepoint count) so wide chars don't overflow by one cell. Returns lines + the line index
 * the caret (codepoint cursor) sits on. Pure; never touches useInput/refs (Vietnamese-IME-safe). */
export interface WrapCell { ch: string; index: number; w: number; }
export interface WrapLine {
  cells: WrapCell[];
  cols: number;
  /** A caret stop after this line's content: the hard-newline index, or input length on the final line.
   * Soft wraps omit it because that same logical index belongs at the start of the next visual line. */
  endIndex?: number;
}
export interface WrapResult { lines: WrapLine[]; caretLine: number; }
export function wrapInput(cps: string[], cur: number, width: number): WrapResult {
  const cols = Math.max(1, Math.floor(width));
  const lines: WrapLine[] = [];
  let line: WrapCell[] = [];
  let lineCols = 0;
  let caretLine = 0;
  const flush = (endIndex?: number) => { lines.push({ cells: line, cols: lineCols, endIndex }); line = []; lineCols = 0; };
  for (let idx = 0; idx < cps.length; idx++) {
    const cp = cps[idx];
    if (cp === "\n") {
      if (idx === cur) caretLine = lines.length;
      flush(idx);
      continue;
    }
    const w = cellWidth(cp);
    if (w === 0) {
      if (idx === cur) caretLine = lines.length;
      line.push({ ch: cp, index: idx, w: 0 });
      continue;
    }
      // Soft-wrap when the next cell would exceed the line width. But if the line is EMPTY and the
      // cell is wider than the whole width (e.g. a 2-cell CJK char on a 1-col box), don't flush —
      // that would emit a spurious empty line. Let the wide char occupy the (too-narrow) line.
      if (lineCols > 0 && lineCols + w > cols) {
        // WORD wrap (image #79): break at the line's last space so words stay whole - "đã đấ|m"
        // read broken mid-word while Claude Code carries the word down. The partial word after the
        // space moves to the new line (and the caret moves with it when it rides a carried cell).
        // A single word wider than the whole box still hard-breaks; an overflowing space flushes.
        let br = -1;
        if (cp !== " ") for (let k = line.length - 1; k >= 0; k--) if (line[k].ch === " ") { br = k; break; }
        if (br >= 0) {
          const carry = line.slice(br + 1);
          line = line.slice(0, br + 1);
          lineCols = line.reduce((s, c) => s + c.w, 0);
          flush();
          line = carry;
          lineCols = carry.reduce((s, c) => s + c.w, 0);
          if (carry.some((c) => c.index === cur)) caretLine = lines.length;
        } else {
          flush();
        }
      }
    if (idx === cur) caretLine = lines.length;
    line.push({ ch: cp, index: idx, w });
    lineCols += w;
  }
  if (cur >= cps.length) caretLine = lines.length;
  flush(cps.length);
  if (lines.length === 0) lines.push({ cells: [], cols: 0, endIndex: 0 });
  caretLine = Math.min(Math.max(0, caretLine), lines.length - 1);
  return { lines, caretLine };
}

/** Max visual lines the input box shows before scrolling within it (keeps the caret visible). */
export const MAX_INPUT_LINES = 5;

/** Modified-Enter encodings that mean "newline, not submit": CSI-u (kitty keyboard protocol,
 * Windows Terminal/VS Code sendInput bindings) and xterm modifyOtherKeys, any modifier 2-8
 * (Shift/Alt/Ctrl combos). Ink does not parse these, so they arrive as a raw sequence; Ink may
 * also strip the leading ESC, hence the optional prefix. */
const MODIFIED_ENTER = /^\x1b?\[(?:13;[2-8]u|27;[2-8];13~)$/;

/** Map a mouse click or vertical arrow to a caret index. dRow/dCol are offsets from the CURRENT
 * caret's screen cell. One wrap projection supplies every candidate stop, so this stays O(n) even for
 * long drafts returned by the external editor; hard newlines, word wraps, wide cells and combining marks
 * use exactly the same geometry as the renderer. */
/**
 * Split the half-open range [start, end) at the selection bounds, marking which runs are selected.
 *
 * This is the whole of the highlight's correctness — clipping a selection to one visual line of a
 * wrapped value, and collapsing an empty or inverted range to nothing — so it lives out here as a pure
 * function rather than inside the render, where Ink strips styling in tests and it could not be checked.
 * Returns a single unselected run when nothing is highlighted, so the caller can skip the split.
 */
export function selectionRuns(
  start: number,
  end: number,
  sel: { from: number; to: number } | null | undefined,
): Array<{ from: number; to: number; on: boolean }> {
  const whole = start < end ? [{ from: start, to: end, on: false }] : [];
  if (!sel || sel.to <= sel.from) return whole;
  const a = Math.max(start, sel.from);
  const b = Math.min(end, sel.to);
  if (a >= b) return whole;
  const runs: Array<{ from: number; to: number; on: boolean }> = [];
  if (start < a) runs.push({ from: start, to: a, on: false });
  runs.push({ from: a, to: b, on: true });
  if (b < end) runs.push({ from: b, to: end, on: false });
  return runs;
}

function caretColumn(line: WrapLine, index: number): number {
  return line.cells.reduce((sum, cell) => (cell.index < index ? sum + cell.w : sum), 0);
}

function closestCaretIndex(line: WrapLine, targetCol: number, fallback: number): number {
  let best = line.cells[0]?.index ?? line.endIndex ?? fallback;
  let bestDistance = Infinity;
  let col = 0;
  for (const cell of line.cells) {
    const distance = Math.abs(col - targetCol);
    // Equal-column zero-width stops belong to one grapheme; prefer the later logical stop so a
    // variation selector/combining mark cannot pull the caret backwards.
    if (distance <= bestDistance) { bestDistance = distance; best = cell.index; }
    col += cell.w;
  }
  if (line.endIndex !== undefined) {
    const distance = Math.abs(line.cols - targetCol);
    if (distance <= bestDistance) best = line.endIndex;
  }
  return best;
}

export function caretIndexForClick(value: string, caretIndex: number, width: number, dRow: number, dCol: number): number {
  const cps = [...value];
  const i = Math.min(Math.max(0, caretIndex), cps.length);
  const w = Math.max(1, Math.floor(width) - 1);
  const projection = wrapInput(cps, i, w);
  const currentCol = caretColumn(projection.lines[projection.caretLine], i);
  const targetLine = Math.min(projection.lines.length - 1, Math.max(0, projection.caretLine + dRow));
  return closestCaretIndex(projection.lines[targetLine], Math.max(0, currentCol + dCol), i);
}

/** Move to one adjacent visual row. A null result means that row does not exist, so the caller may
 * hand the key to prompt history. Unlike clamping a pointer click, an arrow at the top/bottom must not
 * remap within the current row, especially around zero-width Unicode caret stops. */
export function caretIndexForVerticalMove(
  value: string,
  caretIndex: number,
  width: number,
  dRow: -1 | 1,
): number | null {
  const cps = [...value];
  const i = Math.min(Math.max(0, caretIndex), cps.length);
  const w = Math.max(1, Math.floor(width) - 1);
  const projection = wrapInput(cps, i, w);
  const targetLine = projection.caretLine + dRow;
  if (targetLine < 0 || targetLine >= projection.lines.length) return null;
  const currentCol = caretColumn(projection.lines[projection.caretLine], i);
  return closestCaretIndex(projection.lines[targetLine], currentCol, i);
}

export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  mask?: boolean; // render bullets (for secrets like /login)
  width?: number;
  /** Shared paste-collapse map (owned by ChatApp so submit + external editor can expand it). */
  pastedContents: Map<number, string>;
  /** Shared id counter ref (owned by ChatApp). TextInput increments it when it stages a paste. */
  nextPasteId: { current: number };
    /** Called after a submit consumes staged pastes (ChatApp clears its map + counter). */
    onCommitPastes?: () => void;
    /** Alt+V hook: ChatApp reads the clipboard image and returns its `[Image #N]` placeholder (or
     * null). TextInput only does the caret mechanics - the token is inserted AT the caret, inline,
     * so an image reads as part of the sentence being typed (the Claude Code affordance). */
    onPasteImage?: () => string | null | Promise<string | null>;
    /** Legacy caret glyph override. Kept for config/API compatibility; overlay caret ignores it. */
    caretGlyph?: CaretStyle;
    /** Click-to-caret hook: ChatApp registers the handler it calls with the click's (dRow, dCol)
     * delta from the hardware caret's screen cell. TextInput owns the geometry -> index math.
     * Returns the resulting codepoint index, which is also where a drag-selection anchors. */
    registerCaretClick?: (fn: ((dRow: number, dCol: number) => number) | null) => void;
    /** The same geometry lookup WITHOUT moving the caret. `fromIndex` overrides the origin the delta
     * is measured from: a drag measures from where it STARTED, not from the caret, so it does not
     * depend on a repaint having landed between the press and the first motion. */
    registerIndexAt?: (fn: ((dRow: number, dCol: number, fromIndex?: number) => number) | null) => void;
    /** Highlighted codepoint range, rendered in reverse video. ChatApp owns it because the drag that
     * produces it is a pointer gesture and pointer events arrive there. */
    selection?: { from: number; to: number } | null;
    /** Prompt history is a boundary fallback, not the first owner of Up/Down. The editor invokes these
     * only when no visual row exists in that direction. */
    onHistoryUp?: () => void;
    onHistoryDown?: () => void;
    /** A slash menu can temporarily own Up/Down without moving the caret underneath it. */
    verticalNavigation?: boolean;
  }) {
    const { value, onChange, onSubmit, placeholder, mask, width = 9999, pastedContents, nextPasteId, onCommitPastes, onPasteImage, caretGlyph = "thin-block" } = props;
  const ref = useRef(value);
  const cur = useRef([...value].length);
  // External change (history nav, clear): adopt it and put the cursor at the end.
  if (value !== ref.current) {
    ref.current = value;
    cur.current = [...value].length;
  }
    const [, setTick] = useState(0);
    const rerender = () => setTick((t) => t + 1);
    // Paste-collapse state is OWNED by ChatApp (pastedContents + nextPasteId are props) so submit
    // AND the external editor (Ctrl+G) can expand placeholders. This layer only INSERTS them.
    const gcPastes = (text: string) => gcPastesImpl(text, pastedContents);

  // Caret: the REAL terminal hardware cursor (a thin bar between cells, like Claude Code's "khả|o") -
  // no glyph is drawn in the text at all. TextInput marks the caret position with a zero-width SENTINEL
  // (CARET_SENTINEL); the FrameDiffer finds it, strips it, and positions the terminal cursor there
  // (DECSCUSR bar + show). This is the only way to sit BETWEEN two cells with zero width - any drawn
  // glyph occupies a full cell and reads as a gap ("chà▏o"). The terminal blinks the cursor natively,
  // so there is no glyph-toggle (which used to add/remove a visible space on each blink).
  // Insert text at the caret (shared by typing, newline keys, and Alt+V).
  const insertAtCaret = (text: string) => {
    const chars = [...ref.current];
    const ins = [...text];
    chars.splice(cur.current, 0, ...ins);
    cur.current += ins.length;
    ref.current = chars.join("");
    onChange(ref.current);
  };

  useInput((input, key) => {
    // Coalesced keystroke burst: a terminal under load (or a bridge/driver) can deliver the last
    // typed char and the Enter key in ONE stdin chunk ("e\r"). That is typing plus a submit, not a
    // paste: split the trailing lone \r off, insert the text part, and treat it as the return key.
    // A chunk containing \n (or an interior \r) is still a true multi-line paste.
    let data = input;
    let coalescedReturn = false;
    if (input.length > 1 && /\r$/.test(input) && !/[\r\n]/.test(input.slice(0, -1))) {
      data = input.slice(0, -1);
      coalescedReturn = true;
    }
    const isReturn = key.return || coalescedReturn;
    // Ink delivers a paste as one call with the whole string; if it carries a line break, treat it
    // as a paste (insert, don't submit) rather than as an Enter.
    const isPaste = data.length > 1 && /[\r\n]/.test(data);
    // Newline WITHOUT submit (Claude Code parity), three routes because terminals differ:
    // Ink parses kitty-CSI-u Shift+Enter to return+shift and \x1b\r bindings to return+meta;
    // xterm modifyOtherKeys arrives as a raw sequence (MODIFIED_ENTER); and "\" then plain
    // Enter works in EVERY terminal with zero setup (the trailing backslash becomes the break).
    if (MODIFIED_ENTER.test(input)) return insertAtCaret("\n");
    if (isReturn && (key.meta || key.shift) && !isPaste) return insertAtCaret("\n");
        if (isReturn && !isPaste) {
          if (coalescedReturn && data) { // the coalesced text part is typed input; insert before submit
            const chars = [...ref.current];
            chars.splice(cur.current, 0, ...data);
            cur.current += data.length;
            ref.current = chars.join("");
            onChange(ref.current);
          }
          if (cur.current > 0 && [...ref.current][cur.current - 1] === "\\") {
            const chars = [...ref.current];
            chars.splice(cur.current - 1, 1, "\n"); // 1-for-1 swap: the caret index is unchanged
            ref.current = chars.join("");
            return onChange(ref.current);
          }
          const expanded = expandPlaceholders(ref.current, pastedContents);
          onCommitPastes?.(); // a submit consumes all staged pastes (ChatApp clears map + counter)
          return onSubmit(expanded);
        }
    const chars = [...ref.current];
    if (key.meta && input === "v" && onPasteImage) { // Alt+V: clipboard image -> [Image #N] at the caret
      // Clipboard decoding is asynchronous on Windows. Capture the semantic insertion point, then let
      // typing continue while the warm worker reads/resizes the image. When it finishes, preserve any
      // caret movement that happened after Alt+V instead of jumping the user back in time.
      const at = cur.current;
      const apply = (ph: string | null) => {
        if (!ph) return;
        const live = [...ref.current];
        const pos = Math.min(at, live.length);
        const prefix = pos > 0 && live[pos - 1] !== " " ? " " : "";
        const suffix = " "; // preserve the established token boundary, including an intentional next space
        const ins = [...prefix + ph + suffix];
        live.splice(pos, 0, ...ins);
        if (cur.current >= pos) cur.current += ins.length;
        ref.current = live.join("");
        onChange(ref.current);
      };
      try {
        const result = onPasteImage();
        if (result instanceof Promise) void result.then(apply, () => {});
        else apply(result);
      } catch { /* the adapter reports a user-facing paste error */ }
      return;
    }
    if ((key.upArrow || key.downArrow) && !key.ctrl && !key.meta && props.verticalNavigation !== false) {
      const next = caretIndexForVerticalMove(ref.current, cur.current, visibleCols, key.upArrow ? -1 : 1);
      if (next !== null) {
        if (next !== cur.current) {
          cur.current = next;
          rerender();
        }
        return;
      }
      if (key.upArrow) props.onHistoryUp?.();
      else props.onHistoryDown?.();
      return;
    }
    if (key.leftArrow) { cur.current = Math.max(0, cur.current - 1); return rerender(); }
    if (key.rightArrow) { cur.current = Math.min(chars.length, cur.current + 1); return rerender(); }
    if (key.ctrl && input === "a") { cur.current = 0; return rerender(); } // home
    if (key.ctrl && input === "e") { cur.current = chars.length; return rerender(); } // end
    if (key.ctrl && input === "w") { // delete the word before the cursor
      let j = cur.current;
      while (j > 0 && chars[j - 1] === " ") j--;
      while (j > 0 && chars[j - 1] !== " ") j--;
      chars.splice(j, cur.current - j);
      cur.current = j;
      ref.current = chars.join("");
      onChange(ref.current);
      return;
    }
      if (key.backspace || key.delete) {
        if (cur.current > 0) {
          chars.splice(cur.current - 1, 1);
          cur.current -= 1;
          ref.current = chars.join("");
          gcPastes(ref.current);
          onChange(ref.current);
        }
        return;
      }
      if (data && !data.startsWith("\x1b") && !isEscapeResidue(data) && !key.ctrl && !key.meta && !key.tab && !key.escape &&
          !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !isReturn) {
        // Never insert a stray escape sequence (mouse report, unknown CSI, etc.) as literal text - Ink may
        // strip the ESC and hand us just the CSI body ("[<64;10;5M"), incl. multi-report bursts.
        let text = isPaste ? data.replace(/\r\n?/g, "\n") : data;
        // Paste collapse: a long or multi-line paste becomes a compact placeholder so the input box
        // never turns into a one-line windowed blob; the full text is expanded back on submit.
          if (isPaste && shouldCollapsePaste(text)) {
            const id = nextPasteId.current++;
            pastedContents.set(id, text);
            text = formatPlaceholder(id, text);
          }
        const ins = [...text];
        chars.splice(cur.current, 0, ...ins);
        cur.current += ins.length;
        ref.current = chars.join("").normalize("NFC");
        onChange(ref.current);
      }
  });

      const cps = [...value];
      const visibleCols = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 9999;
      // Click-to-caret: ChatApp forwards a pointer press in the input area as a (dRow, dCol) delta
      // from the hardware caret's screen cell; the wrap geometry turns it into a codepoint index.
      // No dep array: re-registering each render keeps the handler on the current width/value refs.
      useEffect(() => {
        props.registerCaretClick?.((dRow, dCol) => {
          cur.current = caretIndexForClick(ref.current, cur.current, visibleCols, dRow, dCol);
          rerender();
          return cur.current;
        });
        props.registerIndexAt?.((dRow, dCol, fromIndex) =>
          caretIndexForClick(ref.current, fromIndex ?? cur.current, visibleCols, dRow, dCol));
        return () => { props.registerCaretClick?.(null); props.registerIndexAt?.(null); };
      });
      const i = Math.min(cur.current, cps.length);
      const bullet = "\u2022";
      // shownChar maps a printable char to a bullet when mask is set, but PRESERVES a "\n" so a masked
      // multiline value still renders its line breaks (otherwise everything collapsed to one bullet row).
      const shownChar = (ch: string) => mask && ch !== "\n" ? bullet : ch;
      const plain = (start: number, end: number) => cps.slice(start, end).map(shownChar).join("");
      /**
       * A range of the value, split at the selection bounds so the selected part renders in reverse
       * video. At most THREE segments per visual line — the component's own note warns that a
       * per-codepoint <Text> fan-out breaks Ink's yoga height measurement after a resize-down, and
       * three flat strings is nowhere near that.
       */
      const sel = props.selection ?? null;
      const seg = (start: number, end: number, key: string) => {
        const runs = selectionRuns(start, end, sel);
        if (runs.length <= 1) return plain(start, end);
        return (
          <Text key={key}>
            {runs.map((r, ri) => (r.on
              ? <Text key={`${key}s${ri}`} inverse>{plain(r.from, r.to)}</Text>
              : plain(r.from, r.to)))}
          </Text>
        );
      };
      // The caret is the terminal's HARDWARE cursor (a bar between cells, like Claude Code's "khả|o").
      // TextInput only MARKS its position with the zero-width CARET_SENTINEL; the FrameDiffer strips it
      // and positions the real cursor there. No glyph is drawn, so text stays tight and the bar sits
      // BETWEEN cells (a drawn glyph occupies a full cell and reads as a gap). Zero width -> no shift.
      const CARET = CARET_SENTINEL;
      if (cps.length === 0) {
        return (
          <Text>
            {CARET}
            <Text dimColor>{placeholder ?? ""}</Text>
          </Text>
        );
      }
      // One shared viewport for hard newlines and soft wraps. The old hard-newline branch handed the
      // entire value to Ink and bypassed MAX_INPUT_LINES. Each display-width-aware visual line is one
      // flat <Text>; only the caret line splits before/caret/after. Avoiding a per-codepoint fan-out
      // preserves Ink's yoga height measurement after a resize-down.
      // Reserve ONE column (visibleCols - 1) so the inserted caret never pushes a full line to overflow.
        const wrapped = wrapInput(cps, cur.current, Math.max(1, visibleCols - 1));
        if (wrapped.lines.length > 1) {
          const startLine = Math.max(0, wrapped.caretLine - MAX_INPUT_LINES + 1);
          const shown = wrapped.lines.slice(startLine, startLine + MAX_INPUT_LINES);
          return (
            <Text>
              {shown.map((ln, li) => {
                const onThisLine = startLine + li === wrapped.caretLine;
                const nl = li < shown.length - 1 ? "\n" : "";
                const lineFrom = ln.cells.length ? ln.cells[0].index : 0;
                const lineTo = ln.cells.length ? ln.cells[ln.cells.length - 1].index + 1 : 0;
                if (!onThisLine) {
                  return <Text key={`l${li}`}>{seg(lineFrom, lineTo, `p${li}`)}{nl}</Text>;
                }
                // Insert the caret before the first cell at/after the cursor index (or at line end).
                const caretCell = Math.min(Math.max(i, lineFrom), lineTo);
                return (
                  <Text key={`l${li}`}>
                    {seg(lineFrom, caretCell, `b${li}`)}
                    {CARET}
                    {seg(caretCell, lineTo, `a${li}`)}
                    {nl}
                  </Text>
                );
              })}
            </Text>
          );
      }
      const charCols = Math.max(0, visibleCols - 1);
  const [winStart, winEnd] = cps.length < visibleCols ? [0, cps.length] : (() => {
    if (charCols === 0) return [i, i];
    const margin = Math.min(4, Math.floor(charCols / 2));
    let start = Math.max(0, i - margin);
    let end = Math.min(cps.length, start + charCols);
    if (end - i < margin && end < cps.length) {
      end = Math.min(cps.length, i + margin);
      start = Math.max(0, end - charCols);
    }
    if (end - start < charCols) start = Math.max(0, end - charCols);
    return [start, end];
  })();
  // Caret INSERTED at the cursor (clamped to the window): char i renders normally in `after`.
  const caretAt = Math.min(Math.max(i, winStart), winEnd);
    return (
    <Text>
      {seg(winStart, caretAt, "w0")}
      {CARET}
      {seg(caretAt, winEnd, "w1")}
    </Text>
  );
}
