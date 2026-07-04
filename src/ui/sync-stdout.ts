/**
 * Synchronized Output (DEC private mode 2026) for flicker-free rendering.
 *
 * A supporting terminal renders everything between BSU (`CSI ? 2026 h`) and ESU (`CSI ? 2026 l`)
 * atomically - no partial-repaint flicker while a frame is being drawn, and no mid-frame cursor
 * movement escaping to the scrollback (which on Windows conhost yanks the view to the top,
 * microsoft/terminal#14774). This is the "no-flicker" fix modern terminals expose.
 *
 * Neko renders via Ink, which writes ONE string per frame (and one per <Static> flush). We don't fork
 * Ink; we wrap the stdout it writes to so each such write is bracketed BSU..ESU. Every write is
 * self-contained (BSU + chunk + ESU), so we never leave the terminal in a half-open synchronized state
 * even on crash/teardown - no separate cleanup handler is needed.
 *
 * Capability is detected from the environment (an allowlist of terminals with known DEC 2026 support).
 * A runtime DECRQM/XTVERSION probe (for SSH, where TERM_PROGRAM isn't forwarded) is a later phase; the
 * env allowlist already covers the common local terminals incl. Windows Terminal.
 */
import type { Writable } from "node:stream";

/** Begin/End Synchronized Update. */
export const BSU = "\x1b[?2026h";
export const ESU = "\x1b[?2026l";

/**
 * True if this terminal is known to implement DEC mode 2026 (synchronized output).
 * `NEKO_SYNC=0` forces off, `NEKO_SYNC=1` forces on - escape hatches over the detection.
 */
export function isSyncOutputSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  const forced = env.NEKO_SYNC;
  if (forced === "0" || forced === "false") return false;
  if (forced === "1" || forced === "true") return true;

  // tmux proxies every byte but historically chunks output, breaking atomicity even though BSU/ESU
  // pass through to the outer terminal. Skip (conservative) - a later phase can version-detect tmux 3.4+.
  if (env.TMUX) return false;

  const termProgram = env.TERM_PROGRAM;
  if (
    termProgram === "iTerm.app" ||
    termProgram === "WezTerm" ||
    termProgram === "WarpTerminal" ||
    termProgram === "ghostty" ||
    termProgram === "contour" ||
    termProgram === "vscode" ||
    termProgram === "alacritty"
  ) return true;

  const term = env.TERM ?? "";
  if (term.includes("kitty") || env.KITTY_WINDOW_ID) return true; // kitty
  if (term === "xterm-ghostty") return true;                       // Ghostty w/o TERM_PROGRAM
  if (term.startsWith("foot")) return true;                        // foot / foot-extra
  if (term.includes("alacritty")) return true;
  if (env.ZED_TERM) return true;                                   // Zed (alacritty_terminal crate)
  if (env.WT_SESSION) return true;                                 // Windows Terminal

  const vte = env.VTE_VERSION ? parseInt(env.VTE_VERSION, 10) : 0;  // GNOME Terminal/Tilix since VTE 0.68
  if (vte >= 6800) return true;

  return false;
}

/**
 * Wrap a stdout stream so each string write is bracketed BSU..ESU. Returns the stream UNCHANGED when
 * synchronized output isn't supported (or the stream isn't a TTY), so there is zero overhead and zero
 * risk off the happy path. The wrapper is a Proxy that overrides only `write`; every other property
 * (columns/rows/isTTY) reads through, and every forwarded method is bound to the real stream so
 * EventEmitter calls like `on("resize")` register on the actual stdout (not the Proxy).
 */
export function wrapStdoutForSync<T extends Writable>(base: T, env: NodeJS.ProcessEnv = process.env): T {
  if (!(base as any).isTTY || !isSyncOutputSupported(env)) return base;

  const wrappedWrite = (chunk: any, ...args: any[]): boolean => {
    if (typeof chunk === "string" && chunk.length > 0) {
      return (base as any).write(BSU + chunk + ESU, ...args);
    }
    return (base as any).write(chunk, ...args);
  };

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "write") return wrappedWrite;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
