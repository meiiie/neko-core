import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activateStagedBinary, assetName, cleanupStaleUpdate, isNewer, latestVersion, parseSha256Sidecar } from "../src/adapters/update.ts";

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

test("activateStagedBinary restores the original if activation fails after the backup rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-activate-"));
  const exe = join(dir, "neko");
  try {
    writeFileSync(exe, "known-good");
    expect(() => activateStagedBinary(exe, join(dir, "missing-stage"))).toThrow();
    expect(readFileSync(exe, "utf8")).toBe("known-good");
    expect(existsSync(`${exe}.old`)).toBe(false);
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

test("latestVersion falls back to GitHub's official redirect when the public API is rate-limited", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("api.github.com")) return { ok: false, status: 403 } as Response;
    return { ok: true, url: "https://github.com/meiiie/neko-core/releases/tag/v0.11.3" } as Response;
  }) as typeof fetch;
  try {
    expect(await latestVersion()).toBe("v0.11.3");
    expect(calls).toHaveLength(2);
  } finally {
    globalThis.fetch = original;
  }
});

test("release checksum sidecars are parsed strictly", () => {
  const sha = "a".repeat(64);
  expect(parseSha256Sidecar(`${sha} *neko-windows-x64.exe\n`)).toBe(sha);
  expect(parseSha256Sidecar("abc *neko")).toBe(null);
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
  // Windows PowerShell 5's `Set-Content -Encoding utf8` writes this BOM. The CLI writer must preserve
  // the user's settings and still clear the installer pin, not merely print a success message.
  writeFileSync(join(configDir, "config.json"), `\uFEFF${JSON.stringify({ auto_update: false })}`);
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
