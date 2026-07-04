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
import { useRef, useState } from "react";

// A CSI escape-sequence residue (mouse report like "[<64;10;5M", a cursor key, etc.). Ink splits the
// leading ESC off as its own keypress and can deliver the REST as literal text, which would corrupt the
// line. This matches the full CSI grammar (ESC optional) so we can drop it. A real keystroke is a single
// printable char and never matches; the only false-positive is pasting a string shaped exactly like a
// CSI sequence, which is vanishingly rare and not worth a heuristic for.
const CSI_RESIDUE = /^\x1b?\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]$/;

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

  useInput((input, key) => {
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
    if (input && !input.startsWith("\x1b") && !CSI_RESIDUE.test(input) && !key.ctrl && !key.meta && !key.tab && !key.escape &&
        !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      // Never insert a stray escape sequence (mouse report, unknown CSI, etc.) as literal text - Ink may
      // strip the ESC and hand us just the CSI body ("[<64;10;5M"), which CSI_RESIDUE catches.
      const ins = [...(isPaste ? input.replace(/\r\n?/g, "\n") : input)];
      chars.splice(cur.current, 0, ...ins);
      cur.current += ins.length;
      ref.current = chars.join("").normalize("NFC");
      onChange(ref.current);
    }
  });

  // Render the caret (inverse block) at the cursor; when empty it sits before the placeholder.
  const cps = [...value];
  const shown = mask ? cps.map(() => "•") : cps;
  if (cps.length === 0) {
    return (
      <Text>
        <Text inverse> </Text>
        <Text dimColor>{placeholder ?? ""}</Text>
      </Text>
    );
  }
  const i = Math.min(cur.current, cps.length);
  return (
    <Text>
      {shown.slice(0, i).join("")}
      <Text inverse>{shown[i] ?? " "}</Text>
      {shown.slice(i + 1).join("")}
    </Text>
  );
}
