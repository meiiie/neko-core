import { Box, Text } from "ink";

// Small pixel-cat mascot (orange half-blocks; eyes/nose are gaps). Recolor via COLOR.
const COLOR = "#e6932e";
const CAT = ["█▄   ▄█", "██▀█▀██", "███▀███", "▀█████▀"];

export function Logo() {
  return (
    <Box flexDirection="column">
      {CAT.map((row, i) => (
        <Text key={i} color={COLOR}>{row}</Text>
      ))}
    </Box>
  );
}
