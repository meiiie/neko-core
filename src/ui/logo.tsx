import { Box, Text } from "ink";

// Classic ASCII cat mascot (3 lines align with the version/model/path block). Recolor via COLOR.
const COLOR = "#e6932e";
const CAT = [" /\\_/\\ ", "( o.o )", " > ^ < "];

export function Logo() {
  return (
    <Box flexDirection="column">
      {CAT.map((row, i) => (
        <Text key={i} color={COLOR}>{row}</Text>
      ))}
    </Box>
  );
}
