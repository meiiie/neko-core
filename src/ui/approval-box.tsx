import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { destructiveInWorkspace } from "../core/sandbox.ts";
import { HIT_SENTINEL } from "./frame-diff.ts";
import { alignLineDiff, elideCommonEnds, expandTabs, splitDiffLines, trunc } from "./format.ts";
import { highlightLine } from "./highlight.tsx";
import { Markdown } from "./markdown.tsx";

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

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
  // Session-scoped tool-name allowlist (matches ACP "Always allow … in this session"); not path-scoped.
  return ["[y]es", `[a]lways allow ${toolName} (this session)`, "[n]o / Esc"];
}

export interface Approval {
  toolName: string;
  args: any;
  resolve: (ok: boolean) => void;
}

export type ApprovalFlash = { kind: "ok" | "no" | "always"; tool: string };

const flashText = (flash: ApprovalFlash) => {
  if (flash.kind === "no") return "✗ denied";
  if (flash.kind === "always") return `✓ always ${flash.tool} (this session)`;
  return "✓ approved";
};

/** Tall enough to review a typical edit without truncating mid-token; still capped so a huge
 * multi_edit cannot blow past the terminal. */
export const APPROVAL_DIFF_MAX_LINES = 48;

/** Dim, sign-less context kept by elideCommonEnds — shown once, never as red/green. */
function pushContextLines(
  preview: any[],
  keyPrefix: string,
  text: string,
  budget: { left: number },
): void {
  if (!text) return;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (budget.left <= 0) return;
    preview.push(<Text key={`${keyPrefix}-ctx-${i}`} dimColor>{`  ${expandTabs(lines[i])}`}</Text>);
    budget.left--;
  }
}


/** Read a workspace-relative file for overwrite approval previews. Returns null when missing or
 * outside cwd — never follows an escaping path. Best-effort only (UI preview; gate still applies). */
function readWorkspaceFile(relPath: string): string | null {
  try {
    const root = resolve(process.cwd());
    const abs = resolve(root, String(relPath ?? ""));
    const rel = relative(root, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** Paint one LCS-aligned row into the approval preview (reorder keeps shared lines as context). */
function pushAlignedRow(
  preview: any[],
  key: string,
  row: { type: "ctx" | "del" | "add"; line: string },
  budget: { left: number },
): void {
  if (budget.left <= 0) return;
  const line = expandTabs(row.line);
  if (row.type === "ctx") {
    preview.push(<Text key={key} dimColor>{`  ${line}`}</Text>);
  } else if (row.type === "del") {
    preview.push(<Text key={key}><Text color="red">{"- "}</Text>{line}</Text>);
  } else {
    preview.push(<Text key={key}><Text color="green">{"+ "}</Text>{highlightLine(line)}</Text>);
  }
  budget.left--;
}

/** Paint elided old/new middles with dim head/tail context (shared by edit + overwrite write_file).
 * Divergent middle uses line LCS so a reorder does not paint unchanged anchors as delete+re-add. */
function pushElidedDiff(
  preview: any[],
  oldText: string,
  newText: string,
  keyPrefix: string,
  budget: { left: number },
): void {
  const { oldText: o, newText: n, elidedHead, elidedTail, headContext, tailContext } = elideCommonEnds(
    oldText,
    newText,
  );
  if (elidedHead > 0) {
    preview.push(<Text key={`${keyPrefix}-head`} dimColor>{`  … ${elidedHead} unchanged line${elidedHead === 1 ? "" : "s"} above`}</Text>);
    budget.left--;
  }
  pushContextLines(preview, `${keyPrefix}-hc`, headContext, budget);
  const aligned = alignLineDiff(o, n);
  for (let i = 0; i < aligned.length; i++) {
    if (budget.left <= 0) {
      const rest = aligned.length - i;
      preview.push(<Text key={`${keyPrefix}-more`} dimColor>{`  … +${rest} more diff lines`}</Text>);
      budget.left = 0;
      break;
    }
    pushAlignedRow(preview, `${keyPrefix}-a${i}`, aligned[i], budget);
  }
  pushContextLines(preview, `${keyPrefix}-tc`, tailContext, budget);
  if (elidedTail > 0 && budget.left > 0) {
    preview.push(<Text key={`${keyPrefix}-tail`} dimColor>{`  … ${elidedTail} unchanged line${elidedTail === 1 ? "" : "s"} below`}</Text>);
    budget.left--;
  }
}

function pushEditDiff(preview: any[], args: { path?: string; old_string?: string; new_string?: string }, keyPrefix = "e"): void {
  preview.push(<Text key={`${keyPrefix}-p`} color="gray">edit {args.path ?? "?"}</Text>);
  pushElidedDiff(preview, String(args.old_string ?? ""), String(args.new_string ?? ""), keyPrefix, { left: APPROVAL_DIFF_MAX_LINES });
}

/** Inline consent box for a gated tool, with a preview (command / write / diff / plan).
 * `hover` = index of the pointer-hovered option zone (null/undefined = none). */
export function ApprovalBox({ approval, flash, width, hover, hint }: { approval: Approval; flash?: ApprovalFlash | null; width?: number; hover?: number | null; hint?: string | null }): ReactNode {
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
        {status || !hint ? null : <Text color="yellow">{hint}</Text>}
      </Box>
    );
  }

  const preview: any[] = [];
  if (toolName === "bash") {
    preview.push(<Text key="c" color="white">{"$ "}{trunc(args.command, 200)}</Text>);
    // When the ONLY reason bash is prompting is that it destroys workspace data (otherwise a live
    // sandbox would auto-approve it), say so - the user is confirming an irreversible delete.
    const why = destructiveInWorkspace(String(args.command ?? ""));
    if (why) preview.push(<Text key="warn" color="red">{"⚠ "}{why} - confirm before it runs</Text>);
  } else if (toolName === "write_file") {
    const content = String(args.content ?? "");
    const path = String(args.path ?? "?");
    const existing = readWorkspaceFile(path === "?" ? "" : path);
    if (existing != null) {
      // Overwrite must show what disappears — all-green create paint hid the prior file (raise-bar-6).
      const beforeN = splitDiffLines(existing).length;
      const afterN = splitDiffLines(content).length;
      preview.push(<Text key="p" color="gray">overwrite {path} ({beforeN} → {afterN} line{afterN === 1 ? "" : "s"}, {content.length} chars)</Text>);
      pushElidedDiff(preview, existing, content, "w", { left: APPROVAL_DIFF_MAX_LINES });
    } else {
      const lines = splitDiffLines(content);
      preview.push(<Text key="p" color="gray">write {path} ({lines.length} line{lines.length === 1 ? "" : "s"}, {content.length} chars)</Text>);
      // Line number (dim) + green marker + syntax-highlighted code - same look as the committed diff.
      const show = Math.min(lines.length, APPROVAL_DIFF_MAX_LINES);
      lines.slice(0, show).forEach((l, i) => preview.push(
        <Text key={`l${i}`}><Text dimColor>{String(i + 1).padStart(4)} </Text><Text color="green">{"+ "}</Text>{highlightLine(expandTabs(l))}</Text>,
      ));
      if (lines.length > show) preview.push(<Text key="more" dimColor>{`  … +${lines.length - show} more lines`}</Text>);
    }
  } else if (toolName === "edit") {
    pushEditDiff(preview, args);
  } else if (toolName === "multi_edit") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    preview.push(<Text key="p" color="gray">multi_edit {args.path ?? "?"} ({edits.length} edit{edits.length === 1 ? "" : "s"})</Text>);
    const budget = { left: APPROVAL_DIFF_MAX_LINES };
    for (let k = 0; k < edits.length; k++) {
      if (budget.left <= 0) {
        preview.push(<Text key={`e${k}-skip`} dimColor>{`  … +${edits.length - k} more edits not shown`}</Text>);
        break;
      }
      const edit = edits[k] ?? {};
      preview.push(<Text key={`e${k}-h`} dimColor>{`#${k + 1}`}</Text>);
      budget.left--;
      pushElidedDiff(preview, String(edit.old_string ?? ""), String(edit.new_string ?? ""), `e${k}`, budget);
    }
  } else {
    preview.push(<Text key="a" color="gray">{trunc(JSON.stringify(args), 200)}</Text>);
  }
  return (
    <Box borderStyle="round" borderColor={color ?? "yellow"} paddingX={1} flexDirection="column" flexShrink={0} width={width}>
      <Text bold color={color ?? "yellow"}>{status ?? `Approve ${toolName}?`}</Text>
      {preview}
      {status ? null : <OptionRow options={approvalOptions(toolName)} hover={hover} />}
      {status || !hint ? null : <Text color="yellow">{hint}</Text>}
    </Box>
  );
}
