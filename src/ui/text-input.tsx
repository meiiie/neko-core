/**
 * Minimal Ink-native text input. Replaces ink-text-input, which mangled Vietnamese / IME
 * input (combining marks + backspace-insert sequences). We append the decoded keypress and
 * NFC-normalize, using codepoint-safe ops so multi-byte chars never split.
 */
import { Text, useInput } from "ink";

export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
}) {
  const { value, onChange, onSubmit, placeholder } = props;
  useInput((input, key) => {
    if (key.return) return onSubmit(value);
    if (key.backspace || key.delete) return onChange([...value].slice(0, -1).join("")); // drop last codepoint
    // Skip keys handled elsewhere (history / mode-cycle / interrupt); insert anything else.
    if (input && !key.ctrl && !key.meta && !key.tab && !key.escape &&
        !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      onChange((value + input).normalize("NFC"));
    }
  });
  return (
    <Text>
      {value ? value : <Text dimColor>{placeholder ?? ""}</Text>}
      <Text inverse> </Text>
    </Text>
  );
}
