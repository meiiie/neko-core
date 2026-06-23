import { Box, Text } from "ink";

import type { NekoConfig } from "../adapters/config.ts";
import { VERSION } from "../shared/version.ts";
import { Logo } from "./logo.tsx";
import { Markdown } from "./markdown.tsx";

export type LineKind = "welcome" | "user" | "assistant" | "tool_call" | "tool_result" | "tool_result_full" | "info" | "error";
export interface Line {
  id: number;
  kind: LineKind;
  text: string;
  summary?: string; // 1-line collapse for read-type tool results (full is under Ctrl+O)
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
              {cfg.effort ? ` · ${cfg.effort} effort` : ""}
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
      // Read-type tools collapse to a 1-line summary; full output is under Ctrl+O.
      if (line.summary) {
        const more = line.text.split("\n").length > 1;
        return <Text dimColor>{`  ⎿ ${line.summary}${more ? " (ctrl+o to expand)" : ""}`}</Text>;
      }
      const all = line.text.split("\n");
      const isError = /^(Error|Blocked|Denied|Refused)/.test(all[0] ?? "");
      const COLLAPSE = 8;
      const hidden = all.length - COLLAPSE;
      const shown = hidden > 0 ? all.slice(0, COLLAPSE) : all;
      return (
        <Box flexDirection="column">
          {shown.map((l, i) => {
            const add = l.startsWith("+");
            const del = l.startsWith("-");
            const disp = l.length > 200 ? l.slice(0, 200) + "…" : l;
            return (
              <Text key={i} color={isError ? "red" : add ? "green" : del ? "red" : undefined} dimColor={!isError && !add && !del}>
                {(i === 0 ? "  ⎿ " : "     ") + disp}
              </Text>
            );
          })}
          {hidden > 0 ? <Text dimColor>{`     … +${hidden} lines (ctrl+o to expand)`}</Text> : null}
        </Box>
      );
    }
    case "tool_result_full":
      return (
        <Box flexDirection="column">
          {line.text.split("\n").map((l, i) => {
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
    case "error":
      return <Text color="red">{"✗ "}{line.text}</Text>;
    default:
      return <Text color="gray">{line.text}</Text>;
  }
}
