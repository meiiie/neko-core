import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearApiKey, initUser, patchUserConfig, setActiveProfile, setApiKey, setModel } from "../src/adapters/project.ts";
import { loadConfig } from "../src/adapters/config.ts";
import { trustProject } from "../src/adapters/project-trust.ts";
import { getProvider } from "../src/adapters/providers.ts";

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

test("init-user creates Neko Core identity once and force never overwrites it", () => {
  const configPath = withTempHome("{}");
  const identityPath = join(process.env.USERPROFILE!, ".neko-core", "NEKO.md");
  const first = initUser();
  expect(first).toContain("Neko Core identity ready");
  expect(first).toContain("Neko Core memory ready");
  expect(readFileSync(identityPath, "utf-8")).toContain("## Life story");

  writeFileSync(identityPath, "# User-owned identity\n", "utf-8");
  const forced = initUser(true);
  expect(forced).toContain("Neko Core identity kept");
  expect(readFileSync(identityPath, "utf-8")).toBe("# User-owned identity\n");
  expect(JSON.parse(readFileSync(configPath, "utf-8"))).toBeTruthy();
});

test("setModel with an ACTIVE profile writes into that profile and clears the shadowing top-level model", () => {
  const path = withTempHome('{ "model": "old-shadow", "profiles": { "nvidia": { "model": "preset" } } }');
  setModel("openai/gpt-oss-120b", "nvidia", 372_000, true);
  const d = JSON.parse(readFileSync(path, "utf-8"));
  expect(d.profiles.nvidia.model).toBe("openai/gpt-oss-120b"); // the model belongs to the profile...
  expect(d.profiles.nvidia.model_context["openai/gpt-oss-120b"]).toBe(372_000); // live metadata survives restart
  expect(d.profiles.nvidia.vision).toBe(true); // model capability survives restart too
  expect(d.model).toBeUndefined(); // ...and the footgun top-level shadow is GONE (/model used to recreate it)
  expect(loadConfig({ profile: "nvidia" }).contextWindow).toBe(372_000);
});

test("setModel without a profile keeps the simple top-level write", () => {
  const path = withTempHome("{}");
  setModel("solo-model");
  expect(JSON.parse(readFileSync(path, "utf-8")).model).toBe("solo-model");
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

test("setApiKey creates an override for an active built-in profile", () => {
  const path = withTempHome(JSON.stringify({ active_profile: "nvidia" }));
  expect(setApiKey("NKEY")).toContain('profile "nvidia"');
  const cfg = JSON.parse(readFileSync(path, "utf-8"));
  expect(cfg.profiles.nvidia.api_key).toBe("NKEY");
  expect(cfg.api_key).toBeUndefined();
});

test("clearApiKey can remove one named profile without changing or clearing another", () => {
  const path = withTempHome(JSON.stringify({
    active_profile: "nvidia",
    profiles: { nvidia: { api_key: "NKEY" }, openai: { api_key: "OKEY" } },
  }));
  expect(clearApiKey("openai")).toContain('profile "openai"');
  const cfg = JSON.parse(readFileSync(path, "utf-8"));
  expect(cfg.active_profile).toBe("nvidia");
  expect(cfg.profiles.nvidia.api_key).toBe("NKEY");
  expect(cfg.profiles.openai.api_key).toBeUndefined();
});

test("switching profiles preserves a legacy top-level key under the previous profile", () => {
  const path = withTempHome(JSON.stringify({ active_profile: "nvidia", api_key: "OLD-NKEY", profiles: { nvidia: { api_key: "" } } }));
  setActiveProfile("zai");
  const cfg = JSON.parse(readFileSync(path, "utf-8"));
  expect(cfg.active_profile).toBe("zai");
  expect(cfg.profiles.nvidia.api_key).toBe("OLD-NKEY");
  expect(cfg.api_key).toBeUndefined();
});

test("switching profiles does not move a scoped key onto a different legacy endpoint", () => {
  const path = withTempHome(JSON.stringify({
    active_profile: "openai",
    base_url: "https://legacy.example/v1",
    api_key: "fake-legacy-key",
    profiles: { openai: { base_url: "https://scoped.example/v1", api_key: "fake-scoped-key" } },
  }));
  setActiveProfile("zai");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.active_profile).toBe("zai");
  expect(saved.profiles.openai).toMatchObject({ base_url: "https://scoped.example/v1", api_key: "fake-scoped-key" });
  expect(saved.profiles.legacy).toMatchObject({ base_url: "https://legacy.example/v1", api_key: "fake-legacy-key" });
  expect(saved.api_key).toBeUndefined();
  expect(saved.base_url).toBeUndefined();
  const scoped = loadConfig({ path, profile: "openai" });
  const legacy = loadConfig({ path, profile: "legacy" });
  expect([scoped.baseUrl, scoped.apiKey]).toEqual(["https://scoped.example/v1", "fake-scoped-key"]);
  expect([legacy.baseUrl, legacy.apiKey]).toEqual(["https://legacy.example/v1", "fake-legacy-key"]);
});

test("a migrated legacy endpoint does not inherit the previous profile's env key", () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fake-openai-env-key";
  try {
    const path = withTempHome(JSON.stringify({
      active_profile: "openai",
      base_url: "https://legacy.example/v1",
      profiles: { legacy: { model: "keep-existing" } },
    }));
    setActiveProfile("zai");
    const scoped = loadConfig({ path, profile: "openai" });
    const legacy = loadConfig({ path, profile: "legacy-2" });
    expect([scoped.baseUrl, scoped.apiKey]).toEqual(["https://api.openai.com/v1", "fake-openai-env-key"]);
    expect([legacy.baseUrl, legacy.apiKey]).toEqual(["https://legacy.example/v1", ""]);
    expect(loadConfig({ path, profile: "legacy" }).model).toBe("keep-existing");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test.each([["fake-legacy-key"], [undefined]])("reselecting validates the scoped route instead of the legacy route (%s)", (legacyKey) => {
  const path = withTempHome(JSON.stringify({
    active_profile: "openai",
    base_url: "https://legacy.example/v1",
    api_key: legacyKey,
    profiles: { openai: { base_url: "https://scoped.example/v1", api_key: "fake-scoped-key" } },
  }));
  const live = setActiveProfile("openai", (next) => next.apiKey === "fake-scoped-key");
  const saved = loadConfig({ path });
  expect([saved.profile, saved.baseUrl, saved.apiKey]).toEqual(["openai", "https://scoped.example/v1", "fake-scoped-key"]);
  expect([live?.profile, live?.baseUrl, live?.apiKey]).toEqual([saved.profile, saved.baseUrl, saved.apiKey]);
});

test("a legacy key does not make a keyless scoped profile selectable", () => {
  const original = JSON.stringify({
    active_profile: "openai",
    base_url: "https://legacy.example/v1",
    api_key: "fake-legacy-key",
    profiles: { openai: { key_env: "NEKO_TEST_MIGRATION_KEY_ABSENT", base_url: "https://scoped.example/v1" } },
  });
  const path = withTempHome(original);
  expect(setActiveProfile("openai", (next) => Boolean(next.apiKey))).toBeUndefined();
  expect(readFileSync(path, "utf8")).toBe(original);
});

test.each([
  ["openai", "https://api.openai.com/v1", {}],
  ["custom", "https://scoped.example/v1", { custom: { base_url: "https://scoped.example/v1", api_key: "fake-scoped-key" } }],
] as const)("named API-key login writes the new key to the %s scoped route", (profile, baseUrl, profiles) => {
  const path = withTempHome(JSON.stringify({
    active_profile: profile,
    base_url: "https://legacy.example/v1",
    api_key: "fake-legacy-key",
    profiles,
  }));
  setActiveProfile(profile);
  setApiKey("fake-new-openai-key");
  const active = loadConfig({ path });
  const legacy = loadConfig({ path, profile: "legacy" });
  expect([active.profile, active.baseUrl, active.apiKey]).toEqual([profile, baseUrl, "fake-new-openai-key"]);
  expect([legacy.baseUrl, legacy.apiKey]).toEqual(["https://legacy.example/v1", "fake-legacy-key"]);
});

test.each([
  ["ollama", "http://localhost:8246/v1", undefined, {}],
  ["custom", "https://legacy.example/v1", "fake-working-key", { custom: { base_url: "https://preset.example/v1" } }],
] as const)("keyless %s profile keeps its effective legacy connection on reselection", (profile, baseUrl, key, profiles) => {
  const path = withTempHome(JSON.stringify({
    active_profile: profile,
    base_url: baseUrl,
    model: "legacy-model",
    api_key: key,
    max_tokens: 512,
    profiles,
  }));
  const before = loadConfig({ path });
  setActiveProfile(profile);
  const after = loadConfig({ path });
  expect([after.profile, after.provider, after.baseUrl, after.model, after.apiKey, after.maxTokens]).toEqual(
    [before.profile, before.provider, before.baseUrl, before.model, before.apiKey, before.maxTokens],
  );
  expect(JSON.parse(readFileSync(path, "utf8")).profiles.legacy).toBeUndefined();
});

test("selecting a scoped profile does not adopt a trusted project's top-level endpoint or save it globally", () => {
  const path = withTempHome(JSON.stringify({
    active_profile: "local",
    profiles: { openai: { api_key: "fake-scoped-key" } },
  }));
  const home = process.env.USERPROFILE!;
  const root = join(home, "fixture-project");
  mkdirSync(root);
  writeFileSync(join(root, "neko.json"), JSON.stringify({ base_url: "https://trusted-project.invalid/v1" }));
  expect(trustProject(root, home).state).toBe("trusted");
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const live = setActiveProfile("openai", () => true);
    expect([live?.baseUrl, live?.apiKey]).toEqual(["https://api.openai.com/v1", "fake-scoped-key"]);
    expect(readFileSync(path, "utf8")).not.toContain("trusted-project.invalid");
  } finally {
    process.chdir(cwd);
  }
});

test("a migrated legacy connection retains its provider's completion budget field", async () => {
  const path = withTempHome(JSON.stringify({
    active_profile: "openai",
    base_url: "https://legacy.example/v1",
    api_key: "fake-legacy-key",
    max_tokens: 512,
    profiles: { openai: { completion_tokens_field: "max_completion_tokens" } },
  }));
  setActiveProfile("zai");
  const migrated = loadConfig({ path, profile: "legacy" });
  const originalFetch = globalThis.fetch;
  let body: ReturnType<typeof JSON.parse>;
  // SAFETY: this fixture implements the fetch arguments the provider uses.
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  }) as typeof fetch;
  try {
    await getProvider(migrated).complete([{ role: "user", content: "hello" }]);
    expect(body.max_completion_tokens).toBe(512);
    expect(body.max_tokens).toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("switching profiles keeps same-route credentials on the original profile", () => {
  const path = withTempHome(JSON.stringify({
    active_profile: "openai",
    base_url: "https://api.openai.com/v1/",
    model: "legacy-model",
    api_key: "fake-legacy-key",
    profiles: { openai: { api_key: "fake-scoped-key" } },
  }));
  setActiveProfile("zai");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.profiles.openai).toMatchObject({ model: "legacy-model", api_key: "fake-scoped-key" });
  expect(saved.profiles.legacy).toBeUndefined();
});

test("switching profiles keeps Z.AI legacy URL repair on the original profile", () => {
  const path = withTempHome(JSON.stringify({
    active_profile: "zai",
    base_url: "https://api.z.ai/api/paas/v4",
    api_key: "fake-coding-key",
  }));
  setActiveProfile("openai");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.profiles.legacy).toBeUndefined();
  const coding = loadConfig({ path, profile: "zai" });
  expect([coding.baseUrl, coding.apiKey]).toEqual(["https://api.z.ai/api/anthropic", "fake-coding-key"]);
});

test("switching routes keeps a legacy endpoint and credential with their owning profile", () => {
  const path = withTempHome(JSON.stringify({
    active_profile: "zai-openai", base_url: "https://api.z.ai/api/paas/v4",
    provider: "openai_compat", model: "glm-5.2", api_key: "OLD-PAID",
    profiles: { zai: { api_key: "CODING-KEY" }, bai: { api_key: "BAI-KEY" } },
  }));
  const preview = loadConfig({ profile: "zai" });
  expect(preview.baseUrl).toBe("https://api.z.ai/api/anthropic");
  expect(preview.provider).toBe("anthropic");
  expect(preview.apiKey).toBe("CODING-KEY");
  setActiveProfile("bai");
  setActiveProfile("zai");
  const current = loadConfig();
  expect(current.baseUrl).toBe(preview.baseUrl);
  expect(current.provider).toBe("anthropic");
  expect(current.apiKey).toBe("CODING-KEY");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.base_url).toBeUndefined();
  expect(saved.profiles["zai-openai"]).toMatchObject({ base_url: "https://api.z.ai/api/paas/v4", api_key: "OLD-PAID" });
  setActiveProfile("zai-openai");
  expect(loadConfig().baseUrl).toBe("https://api.z.ai/api/paas/v4");
  expect(loadConfig().apiKey).toBe("OLD-PAID");
});

test("first login preserves an unscoped custom connection without overwriting an existing legacy profile", () => {
  const path = withTempHome(JSON.stringify({ provider: "openai_compat", base_url: "https://private.example/v1", api_key: "OLD", profiles: { legacy: { model: "keep" } } }));
  setActiveProfile("zai");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.profiles.legacy).toEqual({ model: "keep" });
  expect(saved.profiles["legacy-2"]).toMatchObject({ base_url: "https://private.example/v1", api_key: "OLD" });
  expect(loadConfig().baseUrl).toBe("https://api.z.ai/api/anthropic");
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
