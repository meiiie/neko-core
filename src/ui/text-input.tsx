/**
 * Minimal Ink-native text input. Replaces ink-text-input (mangled Vietnamese/IME).
 *
 * Vietnamese IME (Telex/Unikey) composes a toned vowel by sending backspace + the new char
 * back-to-back. With a captured `value` prop those two events both read the STALE value
 * (no re-render between them) -> "mọi" became "moọi". Fix: keep the live value in a ref and
 * mutate it synchronously, so each keypress sees the latest. NFC + codepoint-safe.
 */
import { Text, useInput } from "ink";
import { useRef } from "react";

export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  mask?: boolean; // render bullets (for secrets like /login)
}) {
  const { value, onChange, onSubmit, placeholder, mask } = props;
  const shown = mask ? "•".repeat([...value].length) : value;
  const ref = useRef(value);
  ref.current = value; // resync to the prop each render (parent owns it between keystrokes)

  useInput((input, key) => {
    if (key.return) return onSubmit(ref.current);
    if (key.backspace || key.delete) {
      ref.current = [...ref.current].slice(0, -1).join("");
      return onChange(ref.current);
    }
    if (input && !key.ctrl && !key.meta && !key.tab && !key.escape &&
        !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      ref.current = (ref.current + input).normalize("NFC");
      onChange(ref.current);
    }
  });

  // Caret sits at the end of the typed value; when empty it sits at the START, before the
  // dim placeholder (so the cursor block isn't pushed to the end of the hint text).
  return (
    <Text>
      {value ? (
        <>
          {shown}
          <Text inverse> </Text>
        </>
      ) : (
        <>
          <Text inverse> </Text>
          <Text dimColor>{placeholder ?? ""}</Text>
        </>
      )}
    </Text>
  );
}
