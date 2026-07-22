import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { HIT_SENTINEL } from "./frame-diff.ts";
import { trunc } from "./format.ts";
import { highlightLine } from "./highlight.tsx";
import { Markdown } from "./markdown.tsx";

/** The clickable option row: each option is a hit zone (HIT_SENTINEL anchor) with a REAL hover
 * state, same contract as the jump pill - what lights up is exactly what a click settles. The
 * caller maps zone index -> approval kind (plan box: y/n; tool box: y/a/n). */
function OptionRow({ options, hover }: { options: string[]; hover?: number | null }): ReactNode {
  return (
    <Text color="gray">
      {options.map((label, i) => (
        <Text
          key={i}
          color={hover === i ? "black" : "gray"}
          backgroundColor={hover === i ? "#4d9fff" : undefined}
          bold={hover === i}
        >
          {HIT_SENTINEL}{label}{i < options.length - 1 ? "   " : ""}
        </Text>
      ))}
    </Text>
  );
}

/** Zone labels for a pending approval, in hit-zone order (chat's pointer handler uses the same
 * order to settle: index 0 approves, last denies, middle - when present - is "always"). */
export function approvalOptions(toolName: string): string[] {
  if (toolName === "exit_plan_mode") return ["[y] proceed (accept-edits)", "[n] keep planning / Esc"];
  return ["[y]es", `[a]lways allow ${toolName}`, "[n]o / Esc"];
}

export interface Approval {
  toolName: string;
  args: Record<string, any>;
  resolve: (ok: boolean) => void;
}

export type ApprovalFlash = { kind: "ok" | "no" | "always"; tool: string };

const flashText = (flash: ApprovalFlash) => {
  if (flash.kind === "no") return "✗ denied";
  if (flash.kind === "always") return `✓ always-${flash.tool}`;
  return "✓ approved";
};

/** Inline consent box for a gated tool, with a preview (command / write / diff / plan).
 * `hover` = index of the pointer-hovered option zone (null/undefined = none). */
export function ApprovalBox({ approval, flash, width, hover }: { approval: Approval; flash?: ApprovalFlash | null; width?: number; hover?: number | null }): ReactNode {
  const { toolName, args } = approval;
  const color = flash?.kind === "no" ? "red" : flash ? "green" : undefined;
  const status = flash ? flashText(flash) : null;

  // Plan review (exit_plan_mode) gets its own, richer box. Markdown defaults to 80 cols, which
  // overflows a narrow terminal and garbles the layout — so we cap its width to the available
  // inner width (outer `width` minus border 2 + paddingX 2). Falls back to 80 when unset (tests).
  if (toolName === "exit_plan_mode") {
    const mdWidth = width ? Math.max(10, width - 4) : undefined;
    return (
      <Box borderStyle="round" borderColor={color ?? "blue"} paddingX={1} flexDirection="column" flexShrink={0}>
        <Text bold color={color ?? "blue"}>{status ?? "Ready to code?"}</Text>
        <Markdown text={String(args.plan ?? "")} width={mdWidth} minWidth={10} />
        {status ? null : <OptionRow options={approvalOptions(toolName)} hover={hover} />}
      </Box>
    );
  }

  const preview: any[] = [];
  if (toolName === "bash") {
    preview.push(<Text key="c" color="white">{"$ "}{trunc(args.command, 200)}</Text>);
  } else if (toolName === "write_file") {
    const content = String(args.content ?? "");
    const lines = content.split("\n");
    preview.push(<Text key="p" color="gray">write {args.path} ({lines.length} lines, {content.length} chars)</Text>);
    // Line number (dim) + green marker + syntax-highlighted code - same look as the committed diff.
    lines.slice(0, 8).forEach((l, i) => preview.push(
      <Text key={`l${i}`}><Text dimColor>{String(i + 1).padStart(4)} </Text><Text color="green">{"+ "}</Text>{highlightLine(l)}</Text>,
    ));
    if (lines.length > 8) preview.push(<Text key="more" dimColor>{`  … +${lines.length - 8} more lines`}</Text>);
  } else if (toolName === "edit") {
    preview.push(<Text key="p" color="gray">edit {args.path}</Text>);
    preview.push(<Text key="o"><Text color="red">{"- "}{trunc(args.old_string, 160)}</Text></Text>);
    preview.push(<Text key="n"><Text color="green">{"+ "}</Text>{highlightLine(trunc(args.new_string, 160))}</Text>);
  } else {
    preview.push(<Text key="a" color="gray">{trunc(JSON.stringify(args), 200)}</Text>);
  }
  return (
    <Box borderStyle="round" borderColor={color ?? "yellow"} paddingX={1} flexDirection="column" flexShrink={0}>
      <Text bold color={color ?? "yellow"}>{status ?? `Approve ${toolName}?`}</Text>
      {preview}
      {status ? null : <OptionRow options={approvalOptions(toolName)} hover={hover} />}
    </Box>
  );
}
