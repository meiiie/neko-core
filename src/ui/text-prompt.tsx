import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { TextInput } from "./text-input.tsx";

export interface TextPromptOptions {
  placeholder?: string;
  maxChars: number;
  onSubmit: (text: string) => void;
}

export function TextPrompt({ title, description, options, cols, onCancel }: {
  title: string; description?: string; options: TextPromptOptions; cols: number; onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const pastes = useRef(new Map<number, string>());
  const nextPasteId = useRef(1);
  useInput((input, key) => { if (key.escape || (key.ctrl && input === "c")) onCancel(); });
  return <Box flexDirection="column">
    <Text color="cyan">{title}</Text>
    {description ? <Text dimColor>{description}</Text> : null}
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <TextInput value={value} onChange={(text) => setValue(text.slice(0, options.maxChars))}
        onSubmit={(text) => options.onSubmit(text.slice(0, options.maxChars))}
        width={Math.max(10, cols - 6)} placeholder={options.placeholder}
        pastedContents={pastes.current} nextPasteId={nextPasteId} />
    </Box>
    <Text dimColor>Enter continue · Esc cancel · {value.length}/{options.maxChars} characters</Text>
  </Box>;
}
