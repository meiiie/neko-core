/**
 * Alternate screen buffer (DEC private mode 1049) lifecycle, with GUARANTEED restore.
 *
 * Fullscreen mode runs in the terminal's alternate screen (like vim/less/htop): the app owns a viewport
 * it fully controls (real scrolling, no scrollback pollution), and on exit the user's original screen +
 * scrollback come back untouched. The hazard is leaving the terminal corrupt if we crash mid-session
 * (alt-screen still active, cursor hidden, mouse tracking on). installAltScreenGuard() registers exit +
 * signal + fatal-error handlers so the sequences are ALWAYS undone, even on SIGINT/SIGTERM/uncaught throw.
 *
 * Sequences (kept here so there's one source of truth):
 *   ?1049h enter alt-screen · ?1049l leave · ?25l hide cursor · ?25h show cursor
 */
import type { Writable } from "node:stream";
import { DISABLE_MOUSE, disableMouse, enableMouse } from "./mouse.ts";

export const ENTER_ALT = "\x1b[?1049h";
export const LEAVE_ALT = "\x1b[?1049l";
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
// Kitty keyboard protocol, "disambiguate" tier (flag 1): a supporting terminal starts reporting
// modified keys as CSI-u (Shift+Enter arrives distinct from Enter - multi-line input with zero
// keybinding setup) and Esc/Alt as their CSI-u forms, ALL of which Ink 7 parses (probe-verified:
// Esc -> escape, Alt+C -> meta c, Ctrl+A -> ctrl a, Shift+Tab -> shift+tab). Terminals without the
// protocol ignore both sequences, and popping an empty stack is a no-op - safe everywhere. Pushed
// on entering the alt screen, popped on EVERY leave path (incl. the external-editor suspend, which
// rides leaveAltScreen - the editor gets the user's normal keyboard back).
export const KITTY_PUSH = "\x1b[>1u";
export const KITTY_POP = "\x1b[<u";

/** Unconditional terminal restore for ANY exit path - including crashes that get CAUGHT (a caught
 * render error never reaches the guard's uncaughtException handler, and that exact path once left the
 * user's shell with mouse tracking + the alt screen active, spraying "[<...M" reports into the prompt).
 * Every sequence here is a no-op when the state is already clean, so calling it repeatedly is safe. */
export function emergencyRestore(out: Writable = process.stdout): void {
  try {
    if (!(out as any).isTTY) return;
    // No title pop on Windows: we never pushed there (WT's title stack reverts the tab mid-session; see
    // title.ts). Elsewhere, pop to restore the user's shell title on exit.
    const titlePop = process.platform === "win32" ? "" : "\x1b[23;0t";
    out.write(KITTY_POP + SHOW_CURSOR + DISABLE_MOUSE + LEAVE_ALT + titlePop); // keyboard, cursor, mouse off, main screen, (title)
  } catch { /* stream gone - nothing left to protect */ }
}

/** Whether a stream can host fullscreen: an interactive TTY with room to draw. A non-TTY (piped output,
 * CI, `neko run`) or a tiny window can't - callers degrade to inline instead of corrupting the terminal. */
export function canFullscreen(out: Writable = process.stdout): boolean {
  const s = out as any;
  if (s.isTTY === false) return false; // explicitly not a TTY (piped/redirected)
  const rows = s.rows === undefined ? 24 : s.rows; // dims may be absent on some streams - assume a sane default
  const cols = s.columns === undefined ? 80 : s.columns;
  return rows >= 10 && cols >= 40;
}

// Explicit clear + home after entering: ?1049h clears the alt buffer on most terminals but the CURSOR
// position is unspecified - without homing, the first frame can paint mid-screen until the next redraw.
export const CLEAR_HOME = "\x1b[2J\x1b[H";

/** Enter the alternate screen (clear + home, hide the cursor - the app draws its own - and ask the
 * terminal for kitty-protocol key disambiguation where supported). */
export function enterAltScreen(out: Writable = process.stdout): void {
  out.write(ENTER_ALT + CLEAR_HOME + HIDE_CURSOR + KITTY_PUSH);
}

/** Leave the alternate screen (restoring the primary screen + scrollback), restoring the keyboard
 * encoding first and showing the cursor. */
export function leaveAltScreen(out: Writable = process.stdout): void {
  out.write(KITTY_POP + SHOW_CURSOR + LEAVE_ALT);
}

/**
 * Enter the alt-screen and register teardown on every exit path. Returns a disposer that leaves the
 * alt-screen and unhooks the handlers; it is idempotent (safe to call from a React unmount AND have the
 * exit handler fire) so we never double-write or leave the screen half-restored. Fatal signals re-raise
 * after cleanup so the process still terminates with the right code.
 */
export function installAltScreenGuard(out: Writable = process.stdout, opts: { mouse?: boolean } = {}): () => void {
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try { if (opts.mouse) disableMouse(out); leaveAltScreen(out); } catch { /* stream may be gone at exit - best effort */ }
    process.off("exit", onExit);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("uncaughtException", onFatal);
  };
  const onExit = () => restore();
  const onSigint = () => { restore(); process.kill(process.pid, "SIGINT"); };
  const onSigterm = () => { restore(); process.kill(process.pid, "SIGTERM"); };
  const onFatal = (err: unknown) => { restore(); throw err; }; // restore first, then let it crash normally

  enterAltScreen(out);
  if (opts.mouse) enableMouse(out);
  process.once("exit", onExit);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.once("uncaughtException", onFatal);
  return restore;
}
