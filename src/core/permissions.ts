/**
 * Permission modes — the named autonomy states (Claude-Code style), cycled with Shift+Tab.
 *
 *   default       prompt before write/edit/bash
 *   accept-edits  auto-approve file edits; still prompt for bash
 *   plan          read-only: block all writes/commands (propose a plan)
 *   auto          auto-approve bounded tools; host desktop control still requires consent
 *   --yolo        explicit startup authority: no approval prompts while mode remains auto
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
  { mode: "auto", label: "auto", detail: "auto-approve bounded tools; prompt for host computer control" },
];

const MODE_ORDER: PermissionMode[] = ["default", "accept-edits", "plan", "auto"];
const EDIT_TOOLS = new Set(["write_file", "edit", "multi_edit"]);

export function isMode(value: string): value is PermissionMode {
  // SAFETY: value was just membership-checked against the mode list.
  return MODE_ORDER.includes(value as PermissionMode);
}

export function decide(
  mode: PermissionMode,
  spec: ToolSpec,
  args: any = {},
  opts: { sandboxedBash?: boolean; yolo?: boolean } = {},
): Decision {
  const permission = effectivePermission(spec, args);
  // Desktop control crosses out of the workspace/sandbox and acts as the logged-in user. Ordinary
  // `auto` grants bounded coding autonomy, not ambient host-GUI authority. Explicit `--yolo` is the
  // up-front session consent; plan mode remains a hard deny after the user cycles away from auto.
  // A semantic host port may mark status/observe/release safe; those calls do not control the seat.
  if (spec.name === "computer" && permission === GATED) {
    return mode === "plan" ? "deny" : mode === "auto" && opts.yolo ? "allow" : "prompt";
  }
  if (permission !== GATED) return "allow";
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
