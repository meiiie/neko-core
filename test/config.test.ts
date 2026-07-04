import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, NekoConfig } from "../src/adapters/config.ts";

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

test("isLocalEndpoint detects local model servers (no key needed)", () => {
  expect(loadConfig({ path: tmpConfig({ base_url: "http://localhost:11434/v1" }) }).isLocalEndpoint).toBe(true);
  expect(loadConfig({ path: tmpConfig({ base_url: "http://127.0.0.1:8080/v1" }) }).isLocalEndpoint).toBe(true);
  expect(loadConfig({ path: tmpConfig({ base_url: "https://integrate.api.nvidia.com/v1" }) }).isLocalEndpoint).toBe(false);
});

test("visionModel: explicit vision_model wins; NVIDIA gets a verified default; else empty", () => {
  expect(loadConfig({ path: tmpConfig({ vision_model: "my/vlm" }) }).visionModel).toBe("my/vlm");
  expect(loadConfig({ path: tmpConfig({ base_url: "https://integrate.api.nvidia.com/v1" }) }).visionModel).toBe("nvidia/llama-3.1-nemotron-nano-vl-8b-v1");
  expect(loadConfig({ path: tmpConfig({ base_url: "https://api.openai.com/v1" }) }).visionModel).toBe("");
});

test("withModel clones the config at a different model, same endpoint, original unchanged", () => {
  const cfg = loadConfig({ path: tmpConfig({ base_url: "https://x/v1", model: "main" }) });
  const v = cfg.withModel("vision-x");
  expect(v.model).toBe("vision-x");
  expect(v.baseUrl).toBe("https://x/v1");
  expect(cfg.model).toBe("main");
});

test("key_env: a built-in provider preset resolves its key from its declared env var (multi-provider)", () => {
  process.env.ZAI_API_KEY = "ZKEY";
  const cfg = loadConfig({ path: tmpConfig({}), profile: "zai" }); // built-in zai preset: provider anthropic, key_env ZAI_API_KEY
  expect(cfg.provider).toBe("anthropic");
  expect(cfg.baseUrl).toBe("https://api.z.ai/api/anthropic");
  expect(cfg.apiKey).toBe("ZKEY");
  delete process.env.ZAI_API_KEY;
});

test("a profile's resolved key beats a stray OPENAI_/NVIDIA_API_KEY (no cross-provider hijack)", () => {
  process.env.DEEPSEEK_API_KEY = "DSK";
  process.env.NVIDIA_API_KEY = "NV-stray";
  const cfg = loadConfig({ path: tmpConfig({}), profile: "deepseek" });
  expect(cfg.apiKey).toBe("DSK"); // the deepseek profile's key_env wins over the stray NVIDIA_API_KEY
  delete process.env.DEEPSEEK_API_KEY; delete process.env.NVIDIA_API_KEY;
});

test("mcp_allow / mcp_deny parse to string arrays", () => {
  const cfg = loadConfig({ path: tmpConfig({ mcp_allow: ["fs"], mcp_deny: ["fs__delete", "danger"] }) });
  expect(cfg.mcpAllow).toEqual(["fs"]);
  expect(cfg.mcpDeny).toEqual(["fs__delete", "danger"]);
  expect(loadConfig({ path: tmpConfig({}) }).mcpAllow).toEqual([]); // absent -> empty
});

test("defaults when overlay missing", () => {
  const cfg = loadConfig({ path: join(tmpdir(), "neko-missing-xyz.json") });
  expect(cfg.provider).toBe("openai_compat");
  expect(cfg.maxSteps).toBe(40);
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

test("contextWindow is per-model (model_context wins over the global default)", () => {
  const cfg = loadConfig({
    path: tmpConfig({ model: "big-model", context_window: 100000, model_context: { "big-model": 262144 } }),
  });
  expect(cfg.contextWindow).toBe(262144); // matches the active model
  const other = loadConfig({ path: tmpConfig({ model: "small-model", context_window: 100000, model_context: { "big-model": 262144 } }) });
  expect(other.contextWindow).toBe(100000); // falls back to the global window
});

test("uiFps: default 60, config + NEKO_FPS override, clamped 30..240", () => {
  const prev = process.env.NEKO_FPS;
  delete process.env.NEKO_FPS;
  try {
    expect(loadConfig({ path: tmpConfig({}) }).uiFps).toBe(60);
    expect(loadConfig({ path: tmpConfig({ ui_fps: 120 }) }).uiFps).toBe(120);
    expect(loadConfig({ path: tmpConfig({ ui_fps: 500 }) }).uiFps).toBe(240); // clamped high
    expect(loadConfig({ path: tmpConfig({ ui_fps: 5 }) }).uiFps).toBe(30);    // clamped low
    process.env.NEKO_FPS = "90";
    expect(loadConfig({ path: tmpConfig({ ui_fps: 60 }) }).uiFps).toBe(90);   // env wins
  } finally {
    if (prev === undefined) delete process.env.NEKO_FPS; else process.env.NEKO_FPS = prev;
  }
});

test("NekoConfig.adopt swaps provider/model/endpoint/key IN PLACE (the /provider live-switch)", () => {
  const a = new NekoConfig({ provider: "openai_compat", model: "gpt-oss", base_url: "https://nvidia/v1" }, "nvidia", {}, "NKEY");
  const b = new NekoConfig({ provider: "anthropic", model: "glm-5.2", base_url: "https://z.ai" }, "zai", {}, "ZKEY");
  a.adopt(b);
  expect(a.provider).toBe("anthropic");
  expect(a.model).toBe("glm-5.2");
  expect(a.baseUrl).toBe("https://z.ai");
  expect(a.apiKey).toBe("ZKEY"); // key swapped too -> no "new endpoint + old key" 401 after switching
  expect(a.profile).toBe("zai");
});
