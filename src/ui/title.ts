/**
 * Terminal tab/window title (the claude-code touch: the tab tells you what the session is doing).
 *
 * OSC 2 sets the title; the xterm TITLE STACK (CSI 22;0t push / CSI 23;0t pop - supported by Windows
 * Terminal, iTerm2, and friends) saves and restores whatever title the shell had, so exiting neko gives
 * the user's tab back exactly as it was. Titles are written STRAIGHT to process.stdout, bypassing the
 * frame differ (an OSC write would just reset its baseline) - titles never touch screen content.
 *
 * Convention: "* neko - <task>" while a turn is running, "neko - <task>" when idle - the tab itself
 * shows busy/done at a glance (like claude-code's spinner-prefixed tab). ASCII-only for safety.
 */
import type { Writable } from "node:stream";

export const PUSH_TITLE = "\x1b[22;0t";
export const POP_TITLE = "\x1b[23;0t";

/** Tab icon - a cat emoji for "Neko". Safe HERE (unlike on-screen text): a tab title is a terminal TITLE
 * (OSC 2), drawn by the terminal's own UI/emoji font, not the cp1252 screen buffer. Windows Terminal,
 * iTerm2, kitty et al. render it; a terminal that can't just shows a placeholder glyph in its own chrome. */
export const TAB_ICON = "\u{1F431}";
/** Branded tab title: "<icon> <name>" (e.g. "🐱 Neko Core"), with a leading dot while a turn runs so a
 * backgrounded tab still shows activity at a glance (the claude-code touch). */
export function brandTitle(name: string, busy = false): string {
  return `${busy ? "● " : ""}${TAB_ICON} ${name}`;
}

/** OSC 2 sequence for a title (control chars stripped; kept short - tabs truncate anyway). */
export function titleSeq(title: string): string {
  return `\x1b]2;${title.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80)}\x07`;
}

const out = (): Writable & { isTTY?: boolean } => process.stdout as any;

// The xterm title STACK (push on start, pop on exit) restores the user's shell title when neko quits.
// But on Windows Terminal (ConPTY) it BACKFIRES: WT restores the pushed title mid-session, so the tab
// brands for a blink then snaps back to the shell's "Windows PowerShell 5.1" (image #56 - the revert value
// is exactly what we pushed). So skip the stack on Windows; PowerShell resets its own title on exit anyway.
const useTitleStack = process.platform !== "win32";

/** Save the user's current title (stack push) - call once at startup, pair with restoreTitle on exit. */
export function saveTitle(): void {
  if (out().isTTY && useTitleStack) out().write(PUSH_TITLE);
}
/** Restore the user's title (stack pop). */
export function restoreTitle(): void {
  if (out().isTTY && useTitleStack) out().write(POP_TITLE);
}

/** Set the tab title now. No-op off-TTY (tests, pipes). */
export function setTerminalTitle(title: string): void {
  if (out().isTTY) out().write(titleSeq(title));
}
