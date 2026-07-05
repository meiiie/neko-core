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

export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  mask?: boolean; // render bullets (for secrets like /login)
}) {
  const { value, onChange, onSubmit, placeholder, mask } = props;
  const ref = useRef(value);
  const cur = useRef([...value].length);
  // External change (history nav, clear): adopt it and put the cursor at the end.
  if (value !== ref.current) {
    ref.current = value;
    cur.current = [...value].length;
  }
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);

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
    lastActivity.current = Date.now(); // keep the caret solid while actively typing
    setCaretOn(true);
    // Ink delivers a paste as one call with the whole string; if it carries a line break, treat it
    // as a paste (insert, don't submit) rather than an Enter.
    const isPaste = input.length > 1 && /[\r\n]/.test(input);
    if (key.return && !isPaste) return onSubmit(ref.current);
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
        onChange(ref.current);
      }
      return;
    }
    if (input && !input.startsWith("\x1b") && !isEscapeResidue(input) && !key.ctrl && !key.meta && !key.tab && !key.escape &&
        !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      // Never insert a stray escape sequence (mouse report, unknown CSI, etc.) as literal text - Ink may
      // strip the ESC and hand us just the CSI body ("[<64;10;5M"), incl. multi-report bursts.
      const ins = [...(isPaste ? input.replace(/\r\n?/g, "\n") : input)];
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
  const shown = mask ? cps.map(() => "•") : cps;
  const caret = <Text color="green">{caretOn ? "▏" : " "}</Text>;
  if (cps.length === 0) {
    return (
      <Text>
        {caret}
        <Text dimColor>{placeholder ?? ""}</Text>
      </Text>
    );
  }
  const i = Math.min(cur.current, cps.length);
  return (
    <Text>
      {shown.slice(0, i).join("")}
      {caret}
      {shown.slice(i).join("")}
    </Text>
  );
}
