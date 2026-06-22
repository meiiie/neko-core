import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("NEKO_") || key === "OPENAI_API_KEY" || key === "NVIDIA_API_KEY") delete process.env[key];
  }
});

function tmpConfig(data: any): string {
  const dir = mkdtempSync(join(tmpdir(), "neko-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(data));
  return path;
}

test("defaults when overlay missing", () => {
  const cfg = loadConfig({ path: join(tmpdir(), "neko-missing-xyz.json") });
  expect(cfg.provider).toBe("openai_compat");
  expect(cfg.maxSteps).toBe(20);
  expect(cfg.profile).toBeNull();
});

test("explicit profile arg", () => {
  const cfg = loadConfig({ path: tmpConfig({}), profile: "openai" });
  expect(cfg.profile).toBe("openai");
  expect(cfg.baseUrl).toBe("https://api.openai.com/v1");
  expect(cfg.model).toBe("gpt-4o-mini");
});

test("active_profile from file", () => {
  expect(loadConfig({ path: tmpConfig({ active_profile: "openai" }) }).profile).toBe("openai");
});

test("env profile overrides file", () => {
  process.env.NEKO_PROFILE = "local";
  expect(loadConfig({ path: tmpConfig({ active_profile: "openai" }) }).profile).toBe("local");
});

test("unknown profile throws", () => {
  expect(() => loadConfig({ path: tmpConfig({}), profile: "nope" })).toThrow();
});

test("env overrides value", () => {
  process.env.NEKO_MODEL = "env-model";
  process.env.NEKO_MAX_STEPS = "7";
  const cfg = loadConfig({ path: tmpConfig({ model: "file-model" }) });
  expect(cfg.model).toBe("env-model");
  expect(cfg.maxSteps).toBe(7);
});

test("api key from file, never in data", () => {
  const cfg = loadConfig({ path: tmpConfig({ api_key: "sk-file" }) });
  expect(cfg.apiKey).toBe("sk-file");
  expect("api_key" in cfg.data).toBe(false);
});

test("env key wins and stays secret", () => {
  process.env.NEKO_API_KEY = "sk-env";
  const cfg = loadConfig({ path: tmpConfig({ api_key: "sk-file" }) });
  expect(cfg.apiKey).toBe("sk-env");
  expect("api_key" in cfg.data).toBe(false);
});

test("invalid json throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, "{not json");
  expect(() => loadConfig({ path })).toThrow();
});

test("mode derives from approval; NEKO_MODE overrides", () => {
  expect(loadConfig({ path: tmpConfig({ approval: "auto" }) }).mode).toBe("auto");
  process.env.NEKO_MODE = "plan";
  expect(loadConfig({ path: tmpConfig({}) }).mode).toBe("plan");
});
