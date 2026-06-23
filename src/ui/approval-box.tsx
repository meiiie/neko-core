import { Box, Text } from "ink";

import { trunc } from "./format.ts";
import { Markdown } from "./markdown.tsx";

export interface Approval {
  toolName: string;
  args: Record<string, any>;
  resolve: (ok: boolean) => void;
}

/** Inline consent box for a gated tool, with a preview (command / write / diff / plan). */
export function ApprovalBox({ approval }: { approval: Approval }) {
  const { toolName, args } = approval;

  // Plan review (exit_plan_mode) gets its own, richer box.
  if (toolName === "exit_plan_mode") {
    return (
      <Box borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column">
        <Text bold color="blue">Ready to code?</Text>
        <Markdown text={String(args.plan ?? "")} />
        <Text color="gray">[y] proceed (accept-edits)   [n] keep planning / Esc</Text>
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
    lines.slice(0, 8).forEach((l, i) => preview.push(<Text key={`l${i}`} color="green">{"+ "}{l}</Text>));
    if (lines.length > 8) preview.push(<Text key="more" dimColor>{`  … +${lines.length - 8} more lines`}</Text>);
  } else if (toolName === "edit") {
    preview.push(<Text key="p" color="gray">edit {args.path}</Text>);
    preview.push(<Text key="o" color="red">{"- "}{trunc(args.old_string, 160)}</Text>);
    preview.push(<Text key="n" color="green">{"+ "}{trunc(args.new_string, 160)}</Text>);
  } else {
    preview.push(<Text key="a" color="gray">{trunc(JSON.stringify(args), 200)}</Text>);
  }
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text bold color="yellow">Approve {toolName}?</Text>
      {preview}
      <Text color="gray">[y]es   [a]lways allow {toolName}   [n]o / Esc</Text>
    </Box>
  );
}
