import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupWeb } from "../src/adapters/setup.ts";

const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
const homes: string[] = [];

afterEach(() => {
  process.env.HOME = oldHome;
  process.env.USERPROFILE = oldProfile;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function config(home: string): any {
  return JSON.parse(readFileSync(join(home, ".neko-core", "config.json"), "utf8"));
}

test("browser setup makes durable auth the default and keeps attach/isolated explicit", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-browser-setup-")); homes.push(home);
  process.env.USERPROFILE = home; process.env.HOME = home;
  const logs: string[] = [];

  expect(await setupWeb("browser", (line) => logs.push(line))).toBe(0);
  let args = config(home).mcp_servers.browser.args as string[];
  expect(args).toContain("--user-data-dir");
  expect(args).toContain(join(home, ".neko-core", "browser", "default"));
  expect(args).not.toContain("--isolated");
  expect(existsSync(join(home, ".neko-core", "browser", "default"))).toBe(true);
  expect(logs.join("\n")).toContain("Sign in once; sessions survive Neko restarts");

  expect(await setupWeb("browser", () => {}, "attach")).toBe(0);
  args = config(home).mcp_servers.browser.args;
  expect(args).toContain("--extension");
  expect(args).not.toContain("--user-data-dir");

  expect(await setupWeb("browser", () => {}, "isolated")).toBe(0);
  args = config(home).mcp_servers.browser.args;
  expect(args).toContain("--isolated");
  expect(args).not.toContain("--user-data-dir");
});

test("browser setup rejects an unknown mode without touching the user config", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-browser-setup-")); homes.push(home);
  process.env.USERPROFILE = home; process.env.HOME = home;
  const logs: string[] = [];
  expect(await setupWeb("browser", (line) => logs.push(line), "mystery")).toBe(2);
  expect(Bun.file(join(home, ".neko-core", "config.json")).size).toBe(0);
  expect(logs.join("\n")).toContain("persistent | attach | isolated");
});
