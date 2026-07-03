import { Box, Text } from "ink";

import type { NekoConfig } from "../adapters/config.ts";
import { VERSION } from "../shared/version.ts";
import { highlightLine } from "./highlight.tsx";
import { Logo } from "./logo.tsx";
import { Markdown } from "./markdown.tsx";

/** Parse one diff result line into its parts. Two formats are produced by tool-runtime.ts:
 *  Write: "+ <code>" / "- <code>"; Edit: "NNNN <sign> <code>" (right-padded line number, then +/-/space).
 *  marker "" means a plain (non-diff) result line -> the caller leaves it un-highlighted. */
function parseDiffLine(l: string): { lineNo?: string; marker: "+" | "-" | " " | ""; code: string } {
  const edit = l.match(/^(\s*\d+) ([+\- ]) (.*)$/);
  if (edit) return { lineNo: edit[1], marker: edit[2] as "+" | "-" | " ", code: edit[3] };
  const write = l.match(/^([+\-]) (.*)$/);
  if (write) return { marker: write[1] as "+" | "-", code: write[2] };
  return { marker: "", code: l };
}

/** Render one diff/result line: the +/- marker (green/red) + line number (dim) carry the diff signal,
 *  and the CODE is syntax-highlighted per token (like real code) instead of one flat color. Removed
 *  lines stay red (they're going away, readability matters less); added/context lines are highlighted.
 *  A plain result line (no marker) is rendered dim, unchanged. */
function DiffLine({ raw, indent, isError }: { raw: string; indent: string; isError: boolean }) {
  const disp = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
  if (isError) return <Text color="red">{indent + disp}</Text>;
  const { lineNo, marker, code } = parseDiffLine(disp);
  if (marker === "") return <Text dimColor>{indent + code}</Text>; // plain result line -> dim, no highlight
  const markerColor = marker === "+" ? "green" : marker === "-" ? "red" : undefined;
  return (
    <Text>
      <Text dimColor>{indent}{lineNo ? `${lineNo} ` : ""}</Text>
      <Text color={markerColor} dimColor={!markerColor}>{marker} </Text>
      {marker === "-" ? <Text color="red" dimColor>{code}</Text> : highlightLine(code)}
    </Text>
  );
}

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
            const indent = i === 0 ? "  └ " : "     ";
            if (i === 0 && !isError && /\([^)]*[+-]\d+[^)]*\)/.test(l)) {
              // Edit/write header: dim, but color the +N green and -M red (Claude-style).
              return <Text key={i} dimColor>{indent}<HeaderCounts text={l.length > 200 ? l.slice(0, 200) + "…" : l} /></Text>;
            }
            return <DiffLine key={i} raw={l} indent={indent} isError={isError} />;
          })}
          {hidden > 0 ? <Text dimColor>{`     … +${hidden} lines (ctrl+o to expand)`}</Text> : null}
        </Box>
      );
    }
    case "tool_result_full":
      return (
        <Box flexDirection="column">
          {line.text.split("\n").map((l, i) => (
            <DiffLine key={i} raw={l} indent={i === 0 ? "  └ " : "     "} isError={false} />
          ))}
        </Box>
      );
    case "error":
      return <Text color="red">{"✗ "}{line.text}</Text>;
    default:
      return <Text color="gray">{line.text}</Text>;
  }
}
