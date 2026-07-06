import { expect, test } from "bun:test";
import { BSU, ESU, isSyncOutputSupported, parseDecrpm2026, syncOutputDecision, wrapStdoutForSync } from "../src/ui/sync-stdout.ts";

test("syncOutputDecision: yes/no are DECIDED (never probed); only true unknowns probe", () => {
  expect(syncOutputDecision({ TERM_PROGRAM: "WezTerm" } as any)).toBe("yes");
  expect(syncOutputDecision({ NEKO_SYNC: "0", TERM_PROGRAM: "WezTerm" } as any)).toBe("no"); // forced off = no probe
  expect(syncOutputDecision({ WT_SESSION: "1" } as any)).toBe("no");  // WT advertises 2026 but corrupts under it
  expect(syncOutputDecision({ TMUX: "/tmp/x" } as any)).toBe("no");
  // A bare unknown terminal: on Windows the answer is decided ("no" - conhost has no 2026, and the
  // probe itself has hurt stdin); elsewhere it is genuinely unknown (SSH) and MAY be probed.
  expect(syncOutputDecision({ TERM: "xterm-256color" } as any)).toBe(process.platform === "win32" ? "no" : "unknown");
});

test("parseDecrpm2026: DECRPM reply -> supported/unsupported/none", () => {
  expect(parseDecrpm2026("\x1b[?2026;1$y")).toBe(true);  // set -> supported
  expect(parseDecrpm2026("\x1b[?2026;2$y")).toBe(true);  // reset (but recognized) -> supported
  expect(parseDecrpm2026("\x1b[?2026;0$y")).toBe(false); // not recognized -> unsupported
  expect(parseDecrpm2026("garbage")).toBe(null);         // no reply yet
});

test("isSyncOutputSupported: env allowlist + overrides", () => {
  // Windows Terminal advertises 2026 but corrupts under it at Neko's write cadence (the duplicated
  // footer ghost, images #77/#78) - deliberately EXCLUDED; NEKO_SYNC=1 remains the force-on hatch.
  expect(isSyncOutputSupported({ WT_SESSION: "1" } as any)).toBe(false);
  expect(isSyncOutputSupported({ TERM: "xterm-kitty" } as any)).toBe(true);   // kitty
  expect(isSyncOutputSupported({ TERM_PROGRAM: "iTerm.app" } as any)).toBe(true);
  expect(isSyncOutputSupported({ VTE_VERSION: "6800" } as any)).toBe(true);   // VTE 0.68+
  expect(isSyncOutputSupported({ TERM: "xterm-256color" } as any)).toBe(false); // unknown
  expect(isSyncOutputSupported({ TMUX: "/tmp/x", WT_SESSION: "1" } as any)).toBe(false); // tmux opts out
  expect(isSyncOutputSupported({ NEKO_SYNC: "0", WT_SESSION: "1" } as any)).toBe(false); // forced off
  expect(isSyncOutputSupported({ NEKO_SYNC: "1" } as any)).toBe(true);        // forced on
});

function fakeTty(isTTY: boolean) {
  const writes: string[] = [];
  const stream: any = {
    isTTY,
    columns: 120,
    rows: 40,
    write: (s: any) => { writes.push(String(s)); return true; },
  };
  return { stream, writes };
}

test("wrapStdoutForSync: brackets each write in BSU..ESU when supported", () => {
  const { stream, writes } = fakeTty(true);
  const wrapped = wrapStdoutForSync(stream, { env: { TERM_PROGRAM: "WezTerm" } as any });
  wrapped.write("frame-A");
  wrapped.write("frame-B");
  expect(writes).toEqual([BSU + "frame-A" + ESU, BSU + "frame-B" + ESU]);
  expect(wrapped.columns).toBe(120); // non-write props read through
});

test("wrapStdoutForSync: no-op when unsupported or not a TTY; probe override wins", () => {
  const a = fakeTty(true);
  expect(wrapStdoutForSync(a.stream, { env: { TERM: "dumb" } as any })).toBe(a.stream); // unsupported -> same object
  const b = fakeTty(false);
  expect(wrapStdoutForSync(b.stream, { env: { TERM_PROGRAM: "WezTerm" } as any })).toBe(b.stream); // not a TTY -> same object
  const c = fakeTty(true);
  expect(wrapStdoutForSync(c.stream, { env: { TERM: "dumb" } as any, supported: true })).not.toBe(c.stream); // probe says yes
});
