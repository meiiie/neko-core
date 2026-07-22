/**
 * Permission modes — the named autonomy states (Claude-Code style), cycled with Shift+Tab.
 *
 *   default       prompt before write/edit/bash
 *   accept-edits  auto-approve file edits; still prompt for bash
 *   plan          read-only: block all writes/commands (propose a plan)
 *   auto (yolo)   auto-approve everything (bounded autonomy — a named state, not hidden)
 *
 * Safe tools (read_file/search/glob/ls) are always allowed in every mode.
 */
import { effectivePermission, GATED, type ToolSpec } from "./tools.ts";

export type PermissionMode = "default" | "accept-edits" | "plan" | "auto";
export type Decision = "allow" | "prompt" | "deny";

export const MODES: { mode: PermissionMode; label: string; detail: string }[] = [
  { mode: "default", label: "default", detail: "prompt before write/edit/bash" },
  { mode: "accept-edits", label: "accept-edits", detail: "auto-approve file edits; prompt for bash" },
  { mode: "plan", label: "plan", detail: "read-only; block all writes/commands" },
  { mode: "auto", label: "auto (yolo)", detail: "auto-approve everything (bounded autonomy)" },
];

const MODE_ORDER: PermissionMode[] = ["default", "accept-edits", "plan", "auto"];
const EDIT_TOOLS = new Set(["write_file", "edit", "multi_edit"]);

export function isMode(value: string): value is PermissionMode {
  return MODE_ORDER.includes(value as PermissionMode);
}

export function decide(
  mode: PermissionMode,
  spec: ToolSpec,
  args: Record<string, any> = {},
  opts: { sandboxedBash?: boolean } = {},
): Decision {
  if (effectivePermission(spec, args) !== GATED) return "allow";
  switch (mode) {
    case "auto":
      return "allow";
    case "plan":
      return "deny";
    case "accept-edits":
      if (opts.sandboxedBash && spec.name === "bash") return "allow";
      return EDIT_TOOLS.has(spec.name) ? "allow" : "prompt";
    default:
      // Sandboxed bash runs without a prompt (Claude Code's sandbox rationale): the OS sandbox
      // already confines writes to the workspace and blocks egress, so per-command consent adds
      // no containment. The caller only sets sandboxedBash when confinement is LIVE (primitive
      // present + provisioned) and sandbox_auto_approve is on; plan mode still denies above,
      // and the catastrophic-command seatbelt still applies in the run path.
      if (opts.sandboxedBash && spec.name === "bash") return "allow";
      return "prompt";
  }
}

export function nextMode(mode: PermissionMode): PermissionMode {
  return MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
}

export function modeDetail(mode: PermissionMode): string {
  return MODES.find((m) => m.mode === mode)?.detail ?? "";
}
