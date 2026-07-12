import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assetName, cleanupStaleUpdate, isNewer } from "../src/adapters/update.ts";

test("cleanupStaleUpdate removes the leftover <exe>.old; no-op when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-upd-"));
  const exe = join(dir, "neko.exe");
  try {
    writeFileSync(`${exe}.old`, "stale");
    cleanupStaleUpdate(exe);
    expect(existsSync(`${exe}.old`)).toBe(false); // swept
    cleanupStaleUpdate(exe); // absent -> silent no-op
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isNewer compares versions numerically, ignoring a leading v", () => {
  expect(isNewer("v0.3.0", "0.2.0")).toBe(true);
  expect(isNewer("0.2.1", "0.2.0")).toBe(true);
  expect(isNewer("v1.0.0", "0.9.9")).toBe(true);
  expect(isNewer("0.2.10", "0.2.9")).toBe(true); // numeric, not lexical
  expect(isNewer("0.2.0", "0.2.0")).toBe(false);
  expect(isNewer("0.1.9", "0.2.0")).toBe(false);
  expect(isNewer("v0.2.0", "v0.2.0")).toBe(false);
});

test("assetName picks the right release asset per platform/arch (matches release.yml)", () => {
  expect(assetName("win32", "x64")).toBe("neko-windows-x64.exe");
  expect(assetName("darwin", "arm64")).toBe("neko-macos-arm64");
  expect(assetName("darwin", "x64")).toBe("neko-macos-x64");
  expect(assetName("linux", "x64")).toBe("neko-linux-x64");
  expect(assetName("linux", "arm64")).toBe("neko-linux-arm64");
});

test("normalizeTag: bare or v-prefixed x.y.z -> vX.Y.Z; junk -> null", () => {
  const { normalizeTag } = require("../src/adapters/update.ts");
  expect(normalizeTag("0.7.7")).toBe("v0.7.7");
  expect(normalizeTag("v0.7.7")).toBe("v0.7.7");
  expect(normalizeTag("  0.8.0 ")).toBe("v0.8.0");
  expect(normalizeTag("latest")).toBe(null);
  expect(normalizeTag("0.7")).toBe(null);       // must be full x.y.z
  expect(normalizeTag("v0.7.7-rc1")).toBe(null); // no pre-release suffix
});

test("setAutoUpdate writes the hold flag to the user config (rollback sticks)", () => {
  const saved = { up: process.env.USERPROFILE, home: process.env.HOME };
  const home = mkdtempSync(join(tmpdir(), "neko-pin-"));
  process.env.USERPROFILE = home; process.env.HOME = home;
  try {
    const { setAutoUpdate } = require("../src/adapters/project.ts");
    setAutoUpdate(false); // pin/hold
    const cfgPath = join(home, ".neko-core", "config.json");
    expect(JSON.parse(require("node:fs").readFileSync(cfgPath, "utf-8")).auto_update).toBe(false);
    setAutoUpdate(true);  // resume
    expect(JSON.parse(require("node:fs").readFileSync(cfgPath, "utf-8")).auto_update).toBe(true);
  } finally {
    process.env.USERPROFILE = saved.up; process.env.HOME = saved.home;
    rmSync(home, { recursive: true, force: true });
  }
});

test("plain update resumes auto-updates even when no binary replacement can run", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-resume-update-"));
  const configDir = join(home, ".neko-core");
  require("node:fs").mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ auto_update: false }));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "bin", "neko.ts"), "update"], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    await child.exited;
    expect(output).toContain("Auto-updates resumed.");
    expect(JSON.parse(require("node:fs").readFileSync(join(configDir, "config.json"), "utf8")).auto_update).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
