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

/** Color the "+N" green and "-N" red inside an edit/write header like "Edited f  (+3 -1)". */
function HeaderCounts({ text }: { text: string }) {
  return (
    <>
      {text.split(/([+-]\d+)/).map((p, k) =>
        /^\+\d+$/.test(p) ? <Text key={k} color="green">{p}</Text>
        : /^-\d+$/.test(p) ? <Text key={k} color="red">{p}</Text>
        : p,
      )}
    </>
  );
}

/** Render one transcript line. The `key` is set by the caller's <Static> map. */
export function TranscriptLine({ line, cfg, cols }: { line: Line; cfg: NekoConfig; cols?: number }) {
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
      // A blank line above each user turn so the prompt stands clear of the previous turn's output
      // (Claude-Code's UserPromptMessage does marginTop={1}); otherwise turns run together.
      return (
        <Box marginTop={1}>
          <Text color="cyan">{"> "}{line.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Markdown text={line.text} width={cols} />
        </Box>
      );
    case "tool_call":
      // A blank line above each tool call groups it with its result and separates it from the prompt.
      return (
        <Box marginTop={1}>
          <Text><Text color="green">● </Text>{line.text}</Text>
        </Box>
      );
    case "tool_result": {
      // Read-type tools collapse to a 1-line summary; full output is under Ctrl+O.
      if (line.summary) {
        const more = line.text.split("\n").length > 1;
        return <Text dimColor>{`  └ ${line.summary}${more ? " (ctrl+o to expand)" : ""}`}</Text>;
      }
      const all = line.text.split("\n");
      const isError = /^(Error|Blocked|Denied|Refused)/.test(all[0] ?? "");
      const COLLAPSE = 8;
      const hidden = all.length - COLLAPSE;
      const shown = hidden > 0 ? all.slice(0, COLLAPSE) : all;
      return (
        <Box flexDirection="column">
          {shown.map((l, i) => {
            const m = l.match(/^\s*\d+ ([+-]) /); // Claude-style "  20 - ..." (line number, then marker)
            const add = l.startsWith("+") || m?.[1] === "+";
            const del = l.startsWith("-") || m?.[1] === "-";
            const disp = l.length > 200 ? l.slice(0, 200) + "…" : l;
            if (i === 0 && !isError && /\([^)]*[+-]\d+[^)]*\)/.test(disp)) {
              // Edit/write header: dim, but color the +N green and -M red (Claude-style).
              return <Text key={i} dimColor>{"  └ "}<HeaderCounts text={disp} /></Text>;
            }
            return (
              <Text key={i} color={isError ? "red" : add ? "green" : del ? "red" : undefined} dimColor={!isError && !add && !del}>
                {(i === 0 ? "  └ " : "     ") + disp}
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
            const m = l.match(/^\s*\d+ ([+-]) /); // Claude-style "  20 - ..." (line number, then marker)
            const add = l.startsWith("+") || m?.[1] === "+";
            const del = l.startsWith("-") || m?.[1] === "-";
            return (
              <Text key={i} color={add ? "green" : del ? "red" : undefined} dimColor={!add && !del}>
                {(i === 0 ? "  └ " : "     ") + l}
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
