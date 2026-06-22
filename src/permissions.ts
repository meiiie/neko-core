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
import { GATED, type ToolSpec } from "./tools.ts";

export type PermissionMode = "default" | "accept-edits" | "plan" | "auto";
export type Decision = "allow" | "prompt" | "deny";

export const MODES: { mode: PermissionMode; label: string; detail: string }[] = [
  { mode: "default", label: "default", detail: "prompt before write/edit/bash" },
  { mode: "accept-edits", label: "accept-edits", detail: "auto-approve file edits; prompt for bash" },
  { mode: "plan", label: "plan", detail: "read-only; block all writes/commands" },
  { mode: "auto", label: "auto (yolo)", detail: "auto-approve everything (bounded autonomy)" },
];

const MODE_ORDER: PermissionMode[] = ["default", "accept-edits", "plan", "auto"];
const EDIT_TOOLS = new Set(["write_file", "edit"]);

export function isMode(value: string): value is PermissionMode {
  return MODE_ORDER.includes(value as PermissionMode);
}

export function decide(mode: PermissionMode, spec: ToolSpec): Decision {
  if (spec.permission !== GATED) return "allow";
  switch (mode) {
    case "auto":
      return "allow";
    case "plan":
      return "deny";
    case "accept-edits":
      return EDIT_TOOLS.has(spec.name) ? "allow" : "prompt";
    default:
      return "prompt";
  }
}

export function nextMode(mode: PermissionMode): PermissionMode {
  return MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
}

export function modeDetail(mode: PermissionMode): string {
  return MODES.find((m) => m.mode === mode)?.detail ?? "";
}
