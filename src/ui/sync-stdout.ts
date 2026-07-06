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
import { appendFileSync } from "node:fs";
import type { Writable } from "node:stream";

// Diagnostic tap (NEKO_TRACE_FRAMES=<file>): every byte that reaches the REAL stdout, base64 NDJSON.
// Replaying these bytes through the VirtualTerminal separates "our bytes are wrong" from "the
// terminal executed correct bytes wrongly" - the discriminator for ghost-row field reports.
const TRACE = process.env.NEKO_TRACE_FRAMES;
function traceWrite(kind: string, s: string): void {
  if (!TRACE) return;
  try { appendFileSync(TRACE, JSON.stringify({ t: Date.now(), ev: "write", kind, b64: Buffer.from(s, "utf8").toString("base64") }) + "\n"); } catch { /* never break rendering */ }
}

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
      // Restore raw mode, but DO NOT pause: this is the same stdin Ink is about to take over, and
      // under Bun on Windows a pre-render pause left the stream permanently silent - the session
      // rendered perfectly and never heard a key again (the e2e harness's typed-echo check exists
      // because of exactly this). A resumed-but-listenerless stdin is harmless for the few ms gap.
      try { stdin.setRawMode?.(wasRaw ?? false); } catch { /* ignore */ }
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
 * Three-state DEC 2026 decision: "yes" (known-good allowlist), "no" (known-bad or forced off -
 * NEVER probe), "unknown" (a runtime DECRQM probe MAY settle it - SSH etc.). The split matters:
 * probing costs a pre-Ink round-trip on the session's own stdin, so it must run only when the
 * environment genuinely cannot tell - and never on Windows, where the answer is decided (WT is
 * denied, conhost has no 2026) and the probe itself has hurt input.
 * `NEKO_SYNC=0` forces off, `NEKO_SYNC=1` forces on - escape hatches over the detection.
 */
export function syncOutputDecision(env: NodeJS.ProcessEnv = process.env): "yes" | "no" | "unknown" {
  const forced = env.NEKO_SYNC;
  if (forced === "0" || forced === "false") return "no";
  if (forced === "1" || forced === "true") return "yes";
  if (env.TMUX) return "no";
  if (isSyncAllowlisted(env)) return "yes";
  // Windows Terminal ADVERTISES 2026 (it answers DECRQM "supported"), so the probe would turn it
  // back on - but WT 1.24 corrupts the screen under 2026 at Neko's real write cadence (the
  // duplicated footer/prompt ghost, images #77/#78; see the e2e harness). Hard deny, no probe.
  if (env.WT_SESSION) return "no";
  // Any other Windows console: conhost and friends have no DEC 2026; probing costs stdin risk for
  // a guaranteed "no reply". Decided, not unknown.
  if (process.platform === "win32") return "no";
  return "unknown";
}

/** True if this terminal is known to implement DEC mode 2026 (synchronized output). "unknown" is
 * false here - runChat upgrades it via the DECRQM probe only when the decision is "unknown". */
export function isSyncOutputSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  return syncOutputDecision(env) === "yes";
}

/** The known-good allowlist (terminals whose 2026 is trusted at our write cadence). tmux is handled
 * in syncOutputDecision (it proxies bytes but historically chunks output, breaking atomicity). */
function isSyncAllowlisted(env: NodeJS.ProcessEnv): boolean {
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
  // Windows Terminal is deliberately NOT here - see syncOutputDecision (hard "no": WT advertises
  // 2026 but corrupts the screen under it at our real write cadence; images #77/#78).

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
  // Imperative band repaints (scroll/append/warm) bypass Ink entirely: the differ writes straight to
  // the base stream, atomically bracketed like everything else.
  (differ as any)?.setWriter?.((s: string) => { if (s) { const out = supported ? BSU + s + ESU : s; traceWrite("imperative", out); (base as any).write(out); } });

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
      // When 2026 is denied for this terminal, NO write may carry it - Ink 7 brackets its own frames
      // in BSU/ESU as separate writes (write-synchronized.js), so just not adding OUR brackets is not
      // enough. This is the ghost's true mechanism (e2e divergence probe): on WT/ConPTY an update
      // INSIDE a sync bracket is sometimes dropped (model: the new spinner glyph; screen: the old
      // one) - rows the differ believes painted go stale, and a later layout shift leaves one-row-off
      // duplicates of the chrome. Strip every 2026 sequence; swallow writes that were only brackets.
      if (!supported) {
        out = out.replaceAll(BSU, "").replaceAll(ESU, "");
        if (out.length === 0) return true;
      }
      const final = supported ? BSU + out + ESU : out;
      traceWrite(out === chunk ? "passthru" : "frame", final);
      return (base as any).write(final, ...args);
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
