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
export const CARET_GLYPHS: Record<CaretStyle, string> = {
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
export interface WrapLine { cells: WrapCell[]; cols: number; }
export interface WrapResult { lines: WrapLine[]; caretLine: number; }
export function wrapInput(cps: string[], cur: number, width: number): WrapResult {
  const cols = Math.max(1, Math.floor(width));
  const lines: WrapLine[] = [];
  let line: WrapCell[] = [];
  let lineCols = 0;
  let caretLine = 0;
  const flush = () => { lines.push({ cells: line, cols: lineCols }); line = []; lineCols = 0; };
  for (let idx = 0; idx < cps.length; idx++) {
    const cp = cps[idx];
    if (cp === "\n") {
      if (idx === cur) caretLine = lines.length;
      flush();
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
  flush();
  if (lines.length === 0) lines.push({ cells: [], cols: 0 });
  caretLine = Math.min(Math.max(0, caretLine), lines.length - 1);
  return { lines, caretLine };
}

/** Max visual lines the input box shows before scrolling within it (keeps the caret visible). */
export const MAX_INPUT_LINES = 5;

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
    onPasteImage?: () => string | null;
    /** Legacy caret glyph override. Kept for config/API compatibility; overlay caret ignores it. */
    caretGlyph?: CaretStyle;
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
  useInput((input, key) => {
    // Ink delivers a paste as one call with the whole string; if it carries a line break, treat it
    // as a paste (insert, don't submit) rather than an Enter.
    const isPaste = input.length > 1 && /[\r\n]/.test(input);
        if (key.return && !isPaste) {
          const expanded = expandPlaceholders(ref.current, pastedContents);
          onCommitPastes?.(); // a submit consumes all staged pastes (ChatApp clears map + counter)
          return onSubmit(expanded);
        }
    const chars = [...ref.current];
    if (key.meta && input === "v" && onPasteImage) { // Alt+V: clipboard image -> [Image #N] at the caret
      const ph = onPasteImage();
      if (ph) {
        const ins = [...(cur.current > 0 && chars[cur.current - 1] !== " " ? " " : "") + ph + " "];
        chars.splice(cur.current, 0, ...ins);
        cur.current += ins.length;
        ref.current = chars.join("");
        onChange(ref.current);
      }
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
      if (input && !input.startsWith("\x1b") && !isEscapeResidue(input) && !key.ctrl && !key.meta && !key.tab && !key.escape &&
          !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        // Never insert a stray escape sequence (mouse report, unknown CSI, etc.) as literal text - Ink may
        // strip the ESC and hand us just the CSI body ("[<64;10;5M"), incl. multi-report bursts.
        let text = isPaste ? input.replace(/\r\n?/g, "\n") : input;
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
      const i = Math.min(cur.current, cps.length);
      const bullet = "\u2022";
      // shownChar maps a printable char to a bullet when mask is set, but PRESERVES a "\n" so a masked
      // multiline value still renders its line breaks (otherwise everything collapsed to one bullet row).
      const shownChar = (ch: string) => mask && ch !== "\n" ? bullet : ch;
      const renderRange = (start: number, end: number) => cps.slice(start, end).map(shownChar).join("");
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
      // Multiline value (a small paste kept its newlines): skip horizontal windowing — Ink renders
      // the \n as real line breaks and wraps naturally, so the box shows the 2-3 lines as typed.
      // Big pastes collapse to a single-line placeholder (no \n), so they stay under windowing.
      // The caret is INSERTED before char i, so `after` starts AT i (char i renders normally).
      if (value.includes("\n")) {
        return (
          <Text>
            {renderRange(0, i)}
            {CARET}
            {renderRange(i, cps.length)}
          </Text>
        );
      }
      // Wrap path: a long single-line value (no \n) that would overflow the width is wrapped into
      // multiple visual lines (display-width aware) rather than horizontal window-scroll. Each visual
      // line is ONE <Text> of plain string; the line holding the caret splits into before/caret/after
      // (the caret is INSERTED between cells, char i renders normally). Keeping each line a flat string
      // (not a per-codepoint <Text> fan-out) preserves Ink's yoga height measurement after a resize-down.
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
                if (!onThisLine) {
                  return <Text key={`l${li}`}>{ln.cells.map((c) => shownChar(c.ch)).join("")}{nl}</Text>;
                }
                // Insert the caret before the first cell at/after the cursor index (or at line end).
                let before = "", after = "";
                for (const cell of ln.cells) {
                  const ch = shownChar(cell.ch);
                  if (cell.index < i) before += ch; else after += ch;
                }
                return (
                  <Text key={`l${li}`}>
                    {before}
                    {CARET}
                    {after}
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
  const before = renderRange(winStart, caretAt);
  const after = renderRange(caretAt, winEnd);
    return (
    <Text>
      {before}
      {CARET}
      {after}
    </Text>
  );
}
