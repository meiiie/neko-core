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
 * Parse a DECRPM reply to our DEC-2026 query out of a buffer: `CSI ? 2026 ; Ps $ y`. Ps 0 = not
 * recognized (unsupported); 1/2/3/4 = recognized (set/reset/perm-set/perm-reset) = SUPPORTED. Returns
 * true/false when a reply is present, else null (no reply yet). Pure - unit-testable without a terminal.
 */
export function parseDecrpm2026(buf: string): boolean | null {
  const m = /\x1b\[\?2026;(\d)\$y/.exec(buf);
  if (!m) return null;
  return m[1] !== "0";
}

/**
 * Ask the terminal directly whether it supports DEC 2026 (DECRQM `CSI ? 2026 $ p`, reply on stdin). This
 * catches terminals the env allowlist misses - notably over SSH, where TERM_PROGRAM isn't forwarded. Runs
 * BEFORE Ink takes over stdin, restores raw-mode + pauses on the way out, and times out fast so an
 * unresponsive terminal costs at most `timeoutMs`. Returns null when it can't probe (no TTY) or no reply.
 */
export function probeSyncOutput(timeoutMs = 120): Promise<boolean | null> {
  const stdin: any = process.stdin;
  const stdout: any = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY || process.env.TMUX) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = "";
    const wasRaw = stdin.isRaw;
    const finish = (result: boolean | null) => {
      clearTimeout(timer);
      stdin.off("data", onData);
      try { stdin.setRawMode?.(wasRaw ?? false); } catch { /* ignore */ }
      stdin.pause();
      resolve(result);
    };
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      const r = parseDecrpm2026(buf);
      if (r !== null) finish(r);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try { stdin.setRawMode?.(true); } catch { /* ignore */ }
    stdin.on("data", onData);
    stdin.resume();
    stdout.write("\x1b[?2026$p"); // DECRQM
  });
}

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
export function wrapStdoutForSync<T extends Writable>(base: T, opts: { env?: NodeJS.ProcessEnv; supported?: boolean; differ?: { process: (p: string) => string | null } } = {}): T {
  const env = opts.env ?? process.env;
  // `supported` from a runtime probe (SSH) wins; otherwise fall back to the env allowlist.
  const supported = opts.supported ?? isSyncOutputSupported(env);
  const differ = opts.differ;
  if (!(base as any).isTTY || (!supported && !differ)) return base;

  const wrappedWrite = (chunk: any, ...args: any[]): boolean => {
    if (typeof chunk === "string" && chunk.length > 0) {
      // FrameDiffer first: shrink Ink's full-frame rerender to the changed lines (or a hardware
      // scroll). "" = frame identical -> skip the write entirely; null = not a standard frame ->
      // pass through untouched (the differ reset itself).
      let out = chunk;
      if (differ) {
        const o = differ.process(chunk);
        if (o === "") return true;
        if (o !== null) out = o;
      }
      return (base as any).write(supported ? BSU + out + ESU : out, ...args);
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
