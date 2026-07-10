/** `neko doctor` terminal/input diagnostics - the "renders but won't take keys" triage surface. */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/adapters/config.ts";
import { collectChecks, collectTerminalChecks, terminalName } from "../src/adapters/doctor.ts";

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

test("doctor WARNS when a top-level config model shadows the selected profile's preset (names the file)", () => {
  delete process.env.NEKO_MODEL; // other test FILES set it and env leaks across files (bun shares the process)
  const dir = mkdtempSync(join(tmpdir(), "neko-doc-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ model: "z-ai/glm-4.6" }));
  const model = collectChecks(loadConfig({ path, profile: "openai" })).find((c) => c.name === "model")!;
  expect(model.status).toBe("warn");
  expect(model.detail).toContain(path); // the EXACT file to fix
  expect(model.detail).toContain("gpt-4o-mini"); // what the profile would have used
  expect(model.detail).toContain("profiles.openai.model"); // the fix
  // ...and a clean profile pick stays ok
  writeFileSync(path, JSON.stringify({}));
  expect(collectChecks(loadConfig({ path, profile: "openai" })).find((c) => c.name === "model")!.status).toBe("ok");
});
