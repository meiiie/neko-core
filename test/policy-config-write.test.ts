/** Consent-gated policy-file writes: the ONE outside-workspace structured target, never
 * auto-approved, JSON-guarded, and nothing else outside the root gets through. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "../src/core/tool-runtime.ts";

const realHome = process.env.USERPROFILE;
let home = "";
let root = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "neko-policy-home-"));
  root = mkdtempSync(join(tmpdir(), "neko-policy-root-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
});
afterEach(() => {
  process.env.USERPROFILE = realHome;
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function registry(mode: "auto" | "default", approve: boolean) {
  return new ToolRegistry(root, mode, () => approve);
}

test("a write to the policy file in AUTO mode is never auto-approved: consent gate fires", async () => {
  const cfgPath = join(home, ".neko-core", "config.json");
  // mkdir the config dir + a valid starting config
  await Bun.write(cfgPath, JSON.stringify({ model: "keep-me" })).catch(() => {});
  const fs = await import("node:fs");
  fs.mkdirSync(join(home, ".neko-core"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ model: "keep-me" }), "utf-8");

  let asked = 0;
  const reg = new ToolRegistry(root, "auto", () => { asked++; return false; }); // user says NO
  const out = String(await reg.execute("write_file", {
    path: cfgPath,
    content: JSON.stringify({ model: "changed", sandbox_network: true }),
  }));
  expect(out).toContain("Denied by user");
  expect(asked).toBe(1); // the prompt WAS shown despite auto mode
  expect(JSON.parse(readFileSync(cfgPath, "utf-8")).model).toBe("keep-me"); // untouched
});

test("an APPROVED policy write lands and must be valid JSON (invalid is refused and rolled back)", async () => {
  const cfgPath = join(home, ".neko-core", "config.json");
  const fs = await import("node:fs");
  fs.mkdirSync(join(home, ".neko-core"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ model: "keep-me" }), "utf-8");

  const ok = registry("default", true);
  const good = String(await ok.execute("write_file", { path: cfgPath, content: JSON.stringify({ model: "fixed" }) }));
  expect(good).toContain("Wrote ");
  expect(JSON.parse(readFileSync(cfgPath, "utf-8")).model).toBe("fixed");

  const bad = String(await ok.execute("write_file", { path: cfgPath, content: "{ not json" }));
  expect(bad).toContain("not valid JSON");
  expect(bad).toContain("NOT changed");
  expect(JSON.parse(readFileSync(cfgPath, "utf-8")).model).toBe("keep-me"); // rolled back to the turn's first pre-image
});

test("any OTHER outside-root file stays refused even with approval", async () => {
  const secret = join(home, "secret.txt");
  const fs = await import("node:fs");
  writeFileSync(secret, "secret", "utf-8");
  const out = String(await registry("default", true).execute("write_file", { path: secret, content: "exfil" }));
  expect(out).toMatch(/Error:|refused|escapes/i);
  expect(readFileSync(secret, "utf-8")).toBe("secret");
});
