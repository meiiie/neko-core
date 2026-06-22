import { Box, Text } from "ink";

import type { NekoConfig } from "../adapters/config.ts";
import { VERSION } from "../shared/version.ts";
import { Logo } from "./logo.tsx";
import { Markdown } from "./markdown.tsx";

export type LineKind = "welcome" | "user" | "assistant" | "tool_call" | "tool_result" | "info";
export interface Line {
  id: number;
  kind: LineKind;
  text: string;
}

/** Render one transcript line. The `key` is set by the caller's <Static> map. */
export function TranscriptLine({ line, cfg }: { line: Line; cfg: NekoConfig }) {
  switch (line.kind) {
    case "welcome":
      return (
        <Box marginBottom={1}>
          <Logo />
          <Box flexDirection="column" marginLeft={2}>
            <Text>
              <Text bold color="white">Neko Code</Text> <Text color="#9a9a9a">v{VERSION}</Text>
            </Text>
            <Text color="#9a9a9a">
              <Text color="white">{(cfg.model || "no model").split("/").pop()}</Text>
              {" · "}{cfg.provider}{" · "}{cfg.profile ?? "no profile"}
            </Text>
            <Text color="#9a9a9a">{process.cwd()}</Text>
          </Box>
        </Box>
      );
    case "user":
      return <Text color="cyan">{"> "}{line.text}</Text>;
    case "assistant":
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Markdown text={line.text} />
        </Box>
      );
    case "tool_call":
      return <Text><Text color="green">● </Text>{line.text}</Text>;
    case "tool_result": {
      const lines = line.text.split("\n");
      return (
        <Box flexDirection="column">
          {lines.map((l, i) => {
            const add = l.startsWith("+");
            const del = l.startsWith("-");
            return (
              <Text key={i} color={add ? "green" : del ? "red" : undefined} dimColor={!add && !del}>
                {(i === 0 ? "  ⎿ " : "     ") + l}
              </Text>
            );
          })}
        </Box>
      );
    }
    default:
      return <Text color="gray">{line.text}</Text>;
  }
}
