/**
 * Minimal Ink-native text input. Replaces ink-text-input (mangled Vietnamese/IME).
 *
 * Vietnamese IME (Telex/Unikey) composes a toned vowel by sending backspace + the new char
 * back-to-back. With a captured `value` prop those two events both read the STALE value
 * (no re-render between them) -> "mọi" became "moọi". Fix: keep the live value in a ref and
 * mutate it synchronously, so each keypress sees the latest. NFC + codepoint-safe.
 *
 * Cursor: a codepoint index (also a ref, for the same IME reason). Left/Right move it, Ctrl+A/
 * Ctrl+E jump to start/end, and typing/backspace act at the cursor. Cursor-only moves bump a
 * tick to force a re-render (the value didn't change, so onChange wouldn't).
 */
import { Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  expandPlaceholders,
  formatPlaceholder,
  gcPastes as gcPastesImpl,
  shouldCollapsePaste,
} from "../shared/paste-collapse.ts";

/** Caret glyph styles. Some terminal fonts render the block-element caret (▏ U+258F, the default)
 * with internal left-padding or a wider advance, so it reads as a gap rather than flush against the
 * preceding char. Letting the user switch glyphs (the pipe/bar that sits centred, a full block, an
 * underline) is the lowest-risk cross-font fix; terminal/font detection is brittle. Set via
 * `caret_glyph` config or NEKO_CARET env. See adapters/config.ts caretGlyph. */
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
  const w = cp.match(/[\u0300-\u036F\u200B-\u200F\uFE00-\uFE0F]/) ? 0 : cp.charCodeAt(0) > 0x1100 && /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(cp) ? 2 : 1;
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
    if (idx === cur) caretLine = lines.length;
    const cp = cps[idx];
    if (cp === "\n") { flush(); continue; }
    const w = cellWidth(cp);
    if (w === 0) { line.push({ ch: cp, index: idx, w: 0 }); continue; }
    if (lineCols + w > cols) flush();
    line.push({ ch: cp, index: idx, w });
    lineCols += w;
  }
  if (cur >= cps.length) caretLine = lines.length;
  flush();
  if (lines.length === 0) lines.push({ cells: [], cols: 0 });
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
    /** Caret glyph override. "thin-block" (▏, default), "bar" (│), "block" (█), "underline" (▁).
     * Different terminal fonts render block-elements inconsistently; this lets the user pick the
     * glyph that sits flush in THEIR font. Configured via `caret_glyph` / NEKO_CARET. */
    caretGlyph?: CaretStyle;
  }) {
    const { value, onChange, onSubmit, placeholder, mask, width = 9999, pastedContents, nextPasteId, onCommitPastes, caretGlyph = "thin-block" } = props;
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

  // Caret blink, like a real terminal / Word / Claude Code: SOLID while you type (so it never disappears
  // mid-keystroke), then it blinks once idle - the "waiting for input" signal. A keystroke stamps
  // `lastActivity`; the interval keeps the caret on for one blink period after the last key, then toggles.
  // Toggling is a single-cell change, so the off phase renders a SPACE (not nothing) - the text never jitters.
  const BLINK_MS = 530; // classic caret cadence
  const [caretOn, setCaretOn] = useState(true);
  const lastActivity = useRef(0);
  useEffect(() => {
    const id = setInterval(() => setCaretOn((on) => (Date.now() - lastActivity.current < BLINK_MS ? true : !on)), BLINK_MS);
    return () => clearInterval(id);
  }, []);

  useInput((input, key) => {
    // Only KEYBOARD activity keeps the caret solid - NOT mouse reports (wheel scroll + any-motion) that
    // Ink also funnels through useInput. Stamping on those froze the blink: the caret stayed lit the whole
    // time the mouse moved/scrolled. isEscapeResidue flags mouse/CSI residue; real keys - including arrows,
    // which arrive as input="" - don't match it, so they still keep it solid while you type/edit.
    if (!isEscapeResidue(input)) { lastActivity.current = Date.now(); setCaretOn(true); }
    // Ink delivers a paste as one call with the whole string; if it carries a line break, treat it
    // as a paste (insert, don't submit) rather than an Enter.
    const isPaste = input.length > 1 && /[\r\n]/.test(input);
        if (key.return && !isPaste) {
          const expanded = expandPlaceholders(ref.current, pastedContents);
          onCommitPastes?.(); // a submit consumes all staged pastes (ChatApp clears map + counter)
          return onSubmit(expanded);
        }
    const chars = [...ref.current];
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

  // Render the caret as a thin green bar SITTING BEFORE the character at the cursor - a text-editor
  // caret (like Claude Code), not a block that covers the character. When empty it sits before the
  // placeholder. The glyph is "▏" (LEFT ONE EIGHTH BLOCK), NOT "|": a pipe is centred in its cell, so it
  // reads as a gap after the text; ▏ hugs the LEFT edge of its cell, sitting flush against the preceding
  // character exactly like a real bar cursor. Green so it reads as the live insertion point.
      const cps = [...value];
      const visibleCols = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 9999;
      // OVERLAY caret: the char UNDER the cursor in inverse video (no inserted glyph cell). Sits flush
      // against preceding text (unlike ▏ which fonts kern with a gap). At EOL or empty → inverse space.
      const i = Math.min(cur.current, cps.length);
      const cg = "\u258F";
      const caret = caretOn
        ? <Text backgroundColor="green" color="black">{i < cps.length ? cps[i] : cg}</Text>
        : <Text color="green">{" "}</Text>;
      if (cps.length === 0) {
        return (
          <Text>
            {caret}
            <Text dimColor>{placeholder ?? ""}</Text>
          </Text>
        );
      }
      // Multiline value (a small paste kept its newlines): skip horizontal windowing — Ink renders
      // the \n as real line breaks and wraps naturally, so the box shows the 2-3 lines as typed.
      // Big pastes collapse to a single-line placeholder (no \n), so they stay under windowing.
      if (value.includes("\n")) {
        const before = mask ? "" : cps.slice(0, i).join("");
        const after = mask ? "" : cps.slice(i).join("");
        return (
          <Text>
            {before}
            {caret}
            {after}
          </Text>
        );
      }
      // Wrap path: a long single-line value (no \n) that would overflow the width is wrapped into
      // multiple visual lines (display-width aware) rather than horizontal window-scroll. Each visual
      // line is ONE <Text> of plain string; the caret, when on that line, splits it into before/overlay/
      // after. Keeping each line a flat string (not a per-codepoint <Text> fan-out) preserves Ink's
      // yoga height measurement after a resize-down (a nested-<Text> structure regressed SHRINK).
      const wrapped = wrapInput(cps, cur.current, visibleCols);
      if (wrapped.lines.length > 1) {
        const startLine = Math.max(0, wrapped.caretLine - MAX_INPUT_LINES + 1);
        const shown = wrapped.lines.slice(startLine, startLine + MAX_INPUT_LINES);
        return (
          <Text>
            {shown.map((ln, li) => {
              // caret on THIS visual line? find its column position among the cells.
              const onThisLine = startLine + li === wrapped.caretLine;
              let before = "";
              let overlayCh: string | null = null;
              let after = "";
              for (const cell of ln.cells) {
                if (onThisLine && cell.index === i) { overlayCh = cell.ch; continue; }
                if (overlayCh === null && onThisLine) before += cell.ch; else after += cell.ch;
                if (!onThisLine) before += cell.ch, after = "";
              }
              const caretNode = caretOn && onThisLine
                ? <Text backgroundColor="green" color="black">{overlayCh ?? cg}</Text>
                : null;
              return (
                <Text key={`l${li}`}>
                  {before}
                  {caretNode}
                  {after}
                  {li < shown.length - 1 ? "\n" : ""}
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
  const before = mask ? "\u2022".repeat(i - winStart) : cps.slice(winStart, i).join("");
  const after = mask ? "\u2022".repeat(winEnd - i) : cps.slice(i, winEnd).join("");
  return (
    <Text>
      {before}
      {caret}
      {after}
    </Text>
  );
}
