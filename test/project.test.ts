import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearApiKey, patchUserConfig, setApiKey, setModel } from "../src/adapters/project.ts";

// project.ts resolves the user config under homedir(); point that at a temp dir per test.
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
afterEach(() => {
  for (const k of ["HOME", "USERPROFILE"] as const) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});

function withTempHome(configText: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "nk-home-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  mkdirSync(join(tmp, ".neko-core"), { recursive: true });
  const path = join(tmp, ".neko-core", "config.json");
  writeFileSync(path, configText, "utf-8");
  return path;
}

test("a malformed user config is NOT clobbered by setModel (no data loss)", () => {
  const path = withTempHome('{ "api_key": "SECRET", "mcp_servers": { "x": {} } BROKEN');
  expect(() => setModel("m")).toThrow(/invalid JSON/);
  expect(readFileSync(path, "utf-8")).toContain("SECRET"); // api_key preserved, not overwritten
});

test("setApiKey reports a malformed config instead of crashing or wiping it", () => {
  const path = withTempHome("{ broken");
  expect(setApiKey("k")).toContain("invalid JSON");
  expect(readFileSync(path, "utf-8")).toBe("{ broken"); // untouched
});

test("setModel updates a valid config without losing other keys", () => {
  const path = withTempHome('{ "api_key": "SECRET" }');
  setModel("kimi");
  const after = JSON.parse(readFileSync(path, "utf-8"));
  expect(after.model).toBe("kimi");
  expect(after.api_key).toBe("SECRET");
});

test("setApiKey saves to the ACTIVE profile (not top-level); clearApiKey removes it + strays", () => {
  const path = withTempHome(JSON.stringify({
    active_profile: "zai",
    api_key: "STRAY", // an old top-level key that used to shadow the profile (the 401 bug)
    profiles: { zai: { provider: "anthropic", model: "glm-5.2" }, nvidia: { model: "gpt-oss" } },
  }));
  expect(setApiKey("ZKEY")).toContain('profile "zai"');
  let cfg = JSON.parse(readFileSync(path, "utf-8"));
  expect(cfg.profiles.zai.api_key).toBe("ZKEY");        // key lands on the active profile's endpoint
  expect(cfg.profiles.nvidia.api_key).toBeUndefined();  // other profiles untouched
  expect(cfg.api_key).toBe("STRAY");                    // setApiKey doesn't touch the stray...
  expect(clearApiKey()).toContain("top-level");         // ...but clearApiKey cleans BOTH
  cfg = JSON.parse(readFileSync(path, "utf-8"));
  expect(cfg.profiles.zai.api_key).toBeUndefined();
  expect(cfg.api_key).toBeUndefined();
});

test("patchUserConfig merges keys and preserves api_key (used by `neko setup web`)", () => {
  const path = withTempHome('{ "api_key": "SECRET", "model": "m1" }');
  patchUserConfig({ searxng_url: "http://localhost:8888", search_backend: "searxng" });
  const after = JSON.parse(readFileSync(path, "utf-8"));
  expect(after.searxng_url).toBe("http://localhost:8888");
  expect(after.search_backend).toBe("searxng");
  expect(after.api_key).toBe("SECRET"); // key untouched
  expect(after.model).toBe("m1");
});
