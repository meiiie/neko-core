import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, NekoConfig, redactSecrets } from "../src/adapters/config.ts";

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("NEKO_") || ["OPENAI_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY"].includes(key)) delete process.env[key];
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

test("image normalization limits are config-first and bounded", () => {
  const defaults = loadConfig({ path: tmpConfig({}) });
  expect(defaults.imageLongEdge).toBe(1568);
  expect(defaults.imageMaxBytes).toBe(450_000);
  expect(defaults.codexKeepalive).toBe(15);
  const highRes = loadConfig({ path: tmpConfig({ image_long_edge: 2576, image_max_bytes: 4_500_000 }) });
  expect(highRes.imageLongEdge).toBe(2576);
  expect(highRes.imageMaxBytes).toBe(4_500_000);
  const bounded = loadConfig({ path: tmpConfig({ image_long_edge: 99_999, image_max_bytes: 99_999_999 }) });
  expect(bounded.imageLongEdge).toBe(4096);
  expect(bounded.imageMaxBytes).toBe(5_000_000);
});

test("current GLM and high-resolution Fable routes are first-class profiles", () => {
  const glm = loadConfig({ path: tmpConfig({}), profile: "nvidia" });
  expect(glm.model).toBe("z-ai/glm-5.2");
  expect(glm.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
  const fable = loadConfig({ path: tmpConfig({}), profile: "fable" });
  expect(fable.model).toBe("claude-fable-5");
  expect(fable.vision).toBe(true);
  expect(fable.imageLongEdge).toBe(2576);
  expect(fable.imageMaxBytes).toBe(4_500_000);
});

test("Claude and xAI use current official native API profiles", () => {
  const claude = loadConfig({ path: tmpConfig({}), profile: "claude" });
  expect(claude.provider).toBe("anthropic");
  expect(claude.model).toBe("claude-sonnet-5");
  expect(claude.contextWindow).toBe(1_000_000);
  expect(claude.maxTokens).toBe(32_768);
  expect(claude.effortCeiling).toBe("max");

  const grok = loadConfig({ path: tmpConfig({}), profile: "xai" });
  expect(grok.provider).toBe("responses");
  expect(grok.model).toBe("grok-4.5");
  expect(grok.contextWindow).toBe(1_000_000);

  const build = loadConfig({ path: tmpConfig({}), profile: "grok-build" });
  expect(build.provider).toBe("responses");
  expect(build.model).toBe("grok-build-0.1");
  expect(build.contextWindow).toBe(256_000);
});

test("Kimi and DeepSeek profiles use their current official first-party routes", () => {
  const kimi = loadConfig({ path: tmpConfig({}), profile: "kimi" });
  expect(kimi.provider).toBe("kimi");
  expect(kimi.usesKimiAuth).toBe(true);
  expect(kimi.baseUrl).toBe("https://api.kimi.com/coding/v1");
  expect(kimi.model).toBe("kimi-for-coding");
  expect(kimi.contextWindow).toBe(262_144);
  expect(kimi.maxTokens).toBe(32_000);
  expect(kimi.vision).toBe(true);
  expect(kimi.effortCeiling).toBe("high");
  expect(kimi.thinkingWire).toBe("toggle");
  expect(kimi.completionTokensField).toBe("max_tokens");

  const kimiApi = loadConfig({ path: tmpConfig({}), profile: "moonshot" });
  expect(kimiApi.provider).toBe("kimi");
  expect(kimiApi.usesKimiAuth).toBe(false);
  expect(kimiApi.baseUrl).toBe("https://api.moonshot.ai/v1");
  expect(kimiApi.model).toBe("kimi-k2.5");
  expect(kimiApi.contextWindow).toBe(262_144);
  expect(kimiApi.maxTokens).toBe(32_000);

  const deepseek = loadConfig({ path: tmpConfig({}), profile: "deepseek" });
  expect(deepseek.provider).toBe("openai_compat");
  expect(deepseek.baseUrl).toBe("https://api.deepseek.com");
  expect(deepseek.model).toBe("deepseek-v4-pro");
  expect(deepseek.contextWindow).toBe(1_000_000);
  expect(deepseek.maxTokens).toBe(65_536);
  expect(deepseek.thinkingWire).toBe("toggle");
});

test("ChatGPT subscription defaults to a completion-usable vision model", () => {
  const cfg = loadConfig({ path: tmpConfig({}), profile: "chatgpt" });
  expect(cfg.provider).toBe("chatgpt");
  expect(cfg.model).toBe("gpt-5.5");
  expect(cfg.vision).toBe(true);
  expect(cfg.contextWindow).toBe(272_000);
});

test("Gemini account and API-key routes are separate config-first profiles", () => {
  const account = loadConfig({ path: tmpConfig({}), profile: "gemini" });
  expect(account.provider).toBe("gemini_cli");
  expect(account.usesGeminiAuth).toBe(true);
  expect(account.model).toBe("auto");
  expect(account.vision).toBe(true);
  expect(account.contextWindow).toBe(1_000_000);
  const api = loadConfig({ path: tmpConfig({}), profile: "gemini-api" });
  expect(api.provider).toBe("openai_compat");
  expect(api.usesGeminiAuth).toBe(false);
  expect(api.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
  expect(api.model).toBe("gemini-3.5-flash");
  expect(api.contextWindow).toBe(1_048_576);
  expect(api.vision).toBe(true);
  expect(api.effortCeiling).toBe("high");
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

test("Kimi API accepts the official key env and the legacy Moonshot fallback", () => {
  process.env.MOONSHOT_API_KEY = "LEGACY";
  expect(loadConfig({ path: tmpConfig({}), profile: "moonshot" }).apiKey).toBe("LEGACY");
  process.env.KIMI_API_KEY = "OFFICIAL";
  expect(loadConfig({ path: tmpConfig({}), profile: "moonshot" }).apiKey).toBe("OFFICIAL");
  delete process.env.KIMI_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
});

test("a scoped profile never falls back to another provider's credential when its own key is missing", () => {
  process.env.OPENAI_API_KEY = "OPENAI-STRAY";
  const xai = loadConfig({ path: tmpConfig({}), profile: "xai" });
  expect(xai.apiKey).toBe("");
  const claude = loadConfig({ path: tmpConfig({}), profile: "claude" });
  expect(claude.apiKey).toBe("");
  delete process.env.OPENAI_API_KEY;
});

test("mcp_allow / mcp_deny parse to string arrays", () => {
  const cfg = loadConfig({ path: tmpConfig({ mcp_allow: ["fs"], mcp_deny: ["fs__delete", "danger"] }) });
  expect(cfg.mcpAllow).toEqual(["fs"]);
  expect(cfg.mcpDeny).toEqual(["fs__delete", "danger"]);
  expect(loadConfig({ path: tmpConfig({}) }).mcpAllow).toEqual([]); // absent -> empty
});

test("browser extension ids are config-first, normalized, unique, and validated", () => {
  const dev = loadConfig({ path: tmpConfig({}) });
  expect(dev.browserExtensionIds).toEqual(["koalaflndbcddboachbdfmppdeblldje"]);
  expect(dev.browserExtensionStoreId).toBe("");
  const cfg = loadConfig({ path: tmpConfig({
    browser_extension_ids: ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "bad", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    browser_extension_store_id: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  }) });
  expect(cfg.browserExtensionIds).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
  expect(cfg.browserExtensionStoreId).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  process.env.NEKO_BROWSER_EXTENSION_IDS = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,cccccccccccccccccccccccccccccccc";
  expect(loadConfig({ path: tmpConfig({}) }).browserExtensionIds).toEqual([
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "cccccccccccccccccccccccccccccccc",
  ]);
});

test("defaults when overlay missing", () => {
  const cfg = loadConfig({ path: join(tmpdir(), "neko-missing-xyz.json") });
  expect(cfg.provider).toBe("openai_compat");
  expect(cfg.maxSteps).toBe(40);
  expect(cfg.adaptiveEffort).toBe(false);
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

test("bash timeout ceiling is env-configurable and bounded", () => {
  expect(loadConfig({ path: tmpConfig({}) }).bashTimeoutCapMs).toBe(600_000);
  process.env.NEKO_BASH_TIMEOUT_CAP_MS = "180000";
  expect(loadConfig({ path: tmpConfig({}) }).bashTimeoutCapMs).toBe(180_000);
  process.env.NEKO_BASH_TIMEOUT_CAP_MS = "not-a-number";
  expect(loadConfig({ path: tmpConfig({}) }).bashTimeoutCapMs).toBe(600_000);
  process.env.NEKO_BASH_TIMEOUT_CAP_MS = "9999999";
  expect(loadConfig({ path: tmpConfig({}) }).bashTimeoutCapMs).toBe(600_000);
  process.env.NEKO_BASH_TIMEOUT_CAP_MS = "1";
  expect(loadConfig({ path: tmpConfig({}) }).bashTimeoutCapMs).toBe(1_000);
});

test("modelShadow: a top-level file model that overrides the profile preset is DETECTED (the --profile trap)", () => {
  const path = tmpConfig({ model: "z-ai/glm-4.6" });
  const cfg = loadConfig({ path, profile: "openai" }); // openai preset: gpt-4o-mini
  expect(cfg.model).toBe("z-ai/glm-4.6"); // behaviour unchanged - the file still wins...
  expect(cfg.modelShadow).toEqual({ source: path, profileModel: "gpt-4o-mini" }); // ...but the shadowing is named
});

test("modelShadow: null when no profile, when models agree, and when the preset has no model to shadow", () => {
  expect(loadConfig({ path: tmpConfig({ model: "m" }) }).modelShadow).toBeNull(); // no profile selected
  expect(loadConfig({ path: tmpConfig({ model: "gpt-4o-mini" }), profile: "openai" }).modelShadow).toBeNull(); // same model
  expect(loadConfig({ path: tmpConfig({ model: "m" }), profile: "openrouter" }).modelShadow).toBeNull(); // empty preset - the file IS the model source, not a shadow
});

test("modelShadow: NEKO_MODEL is named as the source (env wins over files)", () => {
  process.env.NEKO_MODEL = "env-model";
  const cfg = loadConfig({ path: tmpConfig({ model: "file-model" }), profile: "openai" });
  expect(cfg.model).toBe("env-model");
  expect(cfg.modelShadow).toEqual({ source: "NEKO_MODEL (env)", profileModel: "gpt-4o-mini" });
});

test("boolean NEKO_* overrides parse false/true instead of using string truthiness", () => {
  process.env.NEKO_SANDBOX = "0";
  process.env.NEKO_VERIFY_BEFORE_EXIT = "false";
  process.env.NEKO_MCP_LAZY = "off";
  process.env.NEKO_VISION = "yes";
  process.env.NEKO_ADAPTIVE_EFFORT = "on";
  const cfg = loadConfig({ path: tmpConfig({ sandbox: true, verify_before_exit: true, mcp_lazy: true }) });
  expect(cfg.sandbox).toBe(false);
  expect(cfg.verifyBeforeExit).toBe(false);
  expect(cfg.mcpLazy).toBe(false);
  expect(cfg.vision).toBe(true);
  expect(cfg.adaptiveEffort).toBe(true);
  expect(cfg.data.sandbox).toBe(false);
});

test("resident UIA is on by default and has config/env rollback switches", () => {
  expect(loadConfig({ path: tmpConfig({}) }).computerUseResident).toBe(true);
  expect(loadConfig({ path: tmpConfig({ computer_use_resident: false }) }).computerUseResident).toBe(false);
  process.env.NEKO_COMPUTER_USE_RESIDENT = "0";
  expect(loadConfig({ path: tmpConfig({ computer_use_resident: true }) }).computerUseResident).toBe(false);
});

test("invalid boolean NEKO_* override fails clearly", () => {
  process.env.NEKO_SANDBOX = "sometimes";
  expect(() => loadConfig({ path: tmpConfig({}) })).toThrow(/NEKO_SANDBOX.*boolean/i);
});

test("redactSecrets recursively masks MCP headers and env values", () => {
  const shown = redactSecrets({
    model: "m",
    mcp_servers: {
      web: {
        headers: { Authorization: "Bearer secret", "X-API-Key": "secret-2" },
        env: { PATH: "also-hide", CUSTOM: "hide-this-too" },
      },
    },
    nested: { access_token: "token", harmless: "visible" },
  }) as any;
  expect(JSON.stringify(shown)).not.toContain("secret");
  expect(JSON.stringify(shown)).not.toContain("also-hide");
  expect(JSON.stringify(shown)).not.toContain("hide-this-too");
  expect(shown.nested.harmless).toBe("visible");
  expect(shown.mcp_servers.web.headers.Authorization).toBe("<redacted>");
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

test("Windows PowerShell UTF-8 BOM does not invalidate config JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-cfg-bom-"));
  const path = join(dir, "config.json");
  writeFileSync(path, `\uFEFF${JSON.stringify({ model: "bom-model", auto_update: true })}`, "utf8");
  const cfg = loadConfig({ path });
  expect(cfg.model).toBe("bom-model");
  expect(cfg.autoUpdate).toBe(true);
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

test("fullscreen: ON by default; config false or NEKO_FULLSCREEN=0 opts out; env wins", () => {
  const prev = process.env.NEKO_FULLSCREEN;
  delete process.env.NEKO_FULLSCREEN;
  try {
    expect(loadConfig({ path: tmpConfig({}) }).fullscreen).toBe(true);                      // the default
    expect(loadConfig({ path: tmpConfig({ fullscreen: false }) }).fullscreen).toBe(false);  // permanent opt-out
    process.env.NEKO_FULLSCREEN = "0";
    expect(loadConfig({ path: tmpConfig({}) }).fullscreen).toBe(false);                     // env opt-out
    process.env.NEKO_FULLSCREEN = "1";
    expect(loadConfig({ path: tmpConfig({ fullscreen: false }) }).fullscreen).toBe(true);   // env beats config
  } finally {
    if (prev === undefined) delete process.env.NEKO_FULLSCREEN; else process.env.NEKO_FULLSCREEN = prev;
  }
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

test("auto_update: ON by default; config false or NEKO_AUTO_UPDATE=0 opts out to notify-only", () => {
  const prev = process.env.NEKO_AUTO_UPDATE;
  delete process.env.NEKO_AUTO_UPDATE;
  try {
    expect(new NekoConfig({}, null, {}, "").autoUpdate).toBe(true);                    // the default
    expect(new NekoConfig({ auto_update: false }, null, {}, "").autoUpdate).toBe(false); // config opt-out
    process.env.NEKO_AUTO_UPDATE = "0";
    expect(new NekoConfig({}, null, {}, "").autoUpdate).toBe(false);                   // env opt-out
  } finally {
    if (prev === undefined) delete process.env.NEKO_AUTO_UPDATE; else process.env.NEKO_AUTO_UPDATE = prev;
  }
});
