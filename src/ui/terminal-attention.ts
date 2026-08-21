import type { Writable } from "node:stream";

/** DEC focus reporting: supporting terminals emit CSI I / CSI O when their tab or window gains / loses focus. */
export const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
export const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

/** Ink strips the leading ESC before useInput sees an unknown CSI sequence, so accept both forms. */
export function terminalFocusFromInput(input: string): boolean | null {
  let state: boolean | null = null;
  const reports = /\x1b?\[([IO])/g;
  let match: RegExpExecArray | null;
  while ((match = reports.exec(input))) state = match[1] === "I";
  return state;
}

function tty(out: Writable | undefined): out is Writable {
  // SAFETY: terminal streams optionally expose Node's isTTY flag; only the checked boolean is read.
  return Boolean(out && (out as Writable & { isTTY?: boolean }).isTTY === true);
}

/** Unsupported terminals ignore DECSET 1004. The caller remains conservatively "focused" until a real focus-out arrives. */
export function setFocusReporting(out: Writable | undefined, enabled: boolean): void {
  if (!tty(out)) return;
  try { out.write(enabled ? ENABLE_FOCUS_REPORTING : DISABLE_FOCUS_REPORTING); }
  catch { /* A disappearing terminal must not affect the agent turn. */ }
}

/** Approval replaces the composer, so its hardware caret must disappear instead of lingering in the box border. */
export function setApprovalCursorHidden(out: Writable | undefined, hidden: boolean): void {
  if (!tty(out)) return;
  try { out.write(hidden ? "\x1b[?25l" : "\x1b[?25h"); }
  catch { /* Best-effort terminal polish only. */ }
}
