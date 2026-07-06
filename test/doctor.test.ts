/** `neko doctor` terminal/input diagnostics - the "renders but won't take keys" triage surface. */
import { expect, test } from "bun:test";

import { collectTerminalChecks, terminalName } from "../src/adapters/doctor.ts";

test("terminalName identifies the host from the env, most-specific first", () => {
  expect(terminalName({ TERM_PROGRAM: "WezTerm", WT_SESSION: "x" } as any)).toBe("WezTerm");
  expect(terminalName({ WT_SESSION: "guid" } as any)).toBe("Windows Terminal");
  expect(terminalName({ ConEmuANSI: "ON" } as any)).toBe("ConEmu/Cmder");
  expect(terminalName({ TERM: "xterm-256color" } as any)).toBe("xterm-256color");
  const bare = terminalName({} as any);
  expect(bare === "legacy console (conhost)" || bare === "unknown").toBe(true); // platform-dependent
});

test("collectTerminalChecks reports terminal, tty state, ui_fps, and the keys-probe pointer", () => {
  const checks = collectTerminalChecks();
  const names = checks.map((c) => c.name);
  expect(names).toEqual(["terminal", "tty", "ui_fps", "input_probe"]);
  // Under the test runner stdin/stdout are pipes, not TTYs - the check must SAY so, as a warn.
  const tty = checks.find((c) => c.name === "tty")!;
  if (!process.stdin.isTTY) expect(tty.status).toBe("warn");
  expect(checks.find((c) => c.name === "input_probe")!.detail).toContain("neko doctor keys");
  expect(checks.find((c) => c.name === "ui_fps")!.detail).toMatch(/\d+fps via /);
});
