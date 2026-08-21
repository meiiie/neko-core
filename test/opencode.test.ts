import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { DEFAULTS, NekoConfig } from "../src/adapters/config.ts";
import { OpenCodeAccountProvider, OpenCodeZenProvider, openCodeZenTransport } from "../src/adapters/opencode.ts";
import { saveOpenCodeCredentials } from "../src/adapters/opencode-auth.ts";
import { getProvider, listModelOptions } from "../src/adapters/providers.ts";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalProfile = process.env.USERPROFILE;
const roots: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile;
});
afterAll(() => {
  const temp = resolve(tmpdir());
  for (const root of roots) {
    const target = resolve(root);
    if (target !== temp && target.startsWith(temp + sep)) rmSync(target, { recursive: true, force: true });
  }
});

function config(model = "gpt-5.6-terra", key = "zen-key"): NekoConfig {
  const profiles = structuredClone(DEFAULTS.profiles);
  return new NekoConfig({
    ...DEFAULTS,
    ...profiles.opencode,
    model,
    max_retries: 0,
    offline_retry_seconds: 0,
  }, "opencode", profiles, key);
}

function accountConfig(model = "console/gpt"): NekoConfig {
  const profiles = structuredClone(DEFAULTS.profiles);
  return new NekoConfig({
    ...DEFAULTS,
    ...profiles["opencode-account"],
    model,
    max_retries: 0,
    offline_retry_seconds: 0,
  }, "opencode-account", profiles, "");
}

function accountHome(): string {
  const home = mkdtempSync(join(tmpdir(), "neko-opencode-account-"));
  roots.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  saveOpenCodeCredentials({
    accessToken: "account-access",
    refreshToken: "account-refresh",
    expiresAt: Date.now() + 3600_000,
    server: "https://opencode.ai/console",
    accountId: "account-1",
    email: "user@example.com",
    orgId: "org-1",
  });
  return home;
}

test("OpenCode Zen routes documented model families without guessing unknown or Google-native wires", () => {
  expect(getProvider(config())).toBeInstanceOf(OpenCodeZenProvider);
  expect(openCodeZenTransport("gpt-5.6-sol")).toBe("responses");
  expect(openCodeZenTransport("grok-4.6")).toBe("responses");
  expect(openCodeZenTransport("muse-spark-1.2-contributor-free")).toBe("responses");
  expect(openCodeZenTransport("claude-sonnet-5")).toBe("anthropic");
  expect(openCodeZenTransport("qwen3.7-max")).toBe("anthropic");
  expect(openCodeZenTransport("deepseek-v4-pro")).toBe("openai_compat");
  expect(openCodeZenTransport("glm-5.2")).toBe("openai_compat");
  expect(openCodeZenTransport("kimi-k3")).toBe("openai_compat");
  expect(openCodeZenTransport("gemini-3.7-flash")).toBe("unsupported");
  expect(openCodeZenTransport("future-unknown")).toBe("unsupported");
});

test("unknown OpenCode wires fail before fetch and never expose the profile key", async () => {
  let fetched = false;
  // SAFETY: a no-argument compatible fake is sufficient because this branch must not call fetch.
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    fetched = true;
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  const sentinel = "unknown-wire-secret";
  const provider = new OpenCodeZenProvider(config("future-model", sentinel));
  let message = "";
  try { await provider.complete([{ role: "user", content: "probe" }]); }
  catch (error) { message = error instanceof Error ? error.message : String(error); }
  expect(message).toContain("cannot safely route");
  expect(message).not.toContain(sentinel);
  expect(fetched).toBe(false);
});

test("one OpenCode provider key reaches each model family only through its documented endpoint", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  // SAFETY: the fake implements the fetch parameters and returns a real Response for every call.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response('{"error":{"message":"probe stop"}}', { status: 401, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  for (const model of ["gpt-5.6-terra", "claude-sonnet-5", "glm-5.2"]) {
    const provider = new OpenCodeZenProvider(config(model));
    await expect(provider.complete([{ role: "user", content: "probe" }])).rejects.toThrow();
    await provider.dispose();
  }

  expect(calls.map((call) => call.url)).toEqual([
    "https://opencode.ai/zen/v1/responses",
    "https://opencode.ai/zen/v1/messages",
    "https://opencode.ai/zen/v1/chat/completions",
  ]);
  for (const call of calls) expect(call.headers.get("authorization")).toBe("Bearer zen-key");
  expect(calls[1].headers.get("x-api-key")).toBe("zen-key");
});

test("OpenCode model discovery is public, keeps supported wires, and omits Gemini until native Google support", async () => {
  let requestHeaders = new Headers();
  // SAFETY: the fake implements the fetch parameters and returns a real Response for every call.
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestHeaders = new Headers(init?.headers);
    return Response.json({ data: [
      { id: "gpt-5.6-sol" },
      { id: "claude-fable-5" },
      { id: "glm-5.2" },
      { id: "gemini-3.7-flash" },
      { id: "unknown-wire" },
    ] });
  }) as typeof fetch;

  const models = await listModelOptions(config());
  expect(models.slice(0, 3)).toEqual([
    expect.objectContaining({ id: "gpt-5.6-sol", description: "OpenCode Zen - Responses API" }),
    expect.objectContaining({ id: "claude-fable-5", description: "OpenCode Zen - Messages API" }),
    expect.objectContaining({ id: "glm-5.2", description: "OpenCode Zen - Chat Completions API" }),
  ]);
  expect(models.some((model) => model.id.startsWith("gemini-"))).toBe(false);
  expect(models.some((model) => model.id === "unknown-wire")).toBe(false);
  expect(models.find((model) => model.id === "gpt-5.6-sol")?.contextWindow).toBe(131_072);
  expect(requestHeaders.has("authorization")).toBe(false);
});

test("OpenCode Console OAuth loads the account catalog and sends its token only to trusted OpenCode endpoints", async () => {
  accountHome();
  const calls: Array<{ url: string; headers: Headers; body?: any }> = [];
  // SAFETY: test-built fetch fixture implements the fetch arguments and returns a Response for every path.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/console/api/config")) return Response.json({ config: { provider: {
      opencode: {
        name: "OpenCode account",
        npm: "@ai-sdk/openai-compatible",
        api: "https://opencode.ai/inference/openai/v1",
        options: {
          apiKey: "catalog-secret-must-not-be-sent",
          headers: {
            "x-opencode-org-id": "org-1",
            authorization: "catalog-must-not-overwrite-auth",
            "x-untrusted": "catalog-must-not-create-generic-headers",
          },
        },
        models: { "x-preview-f-free": { name: "Ox Alpha Free", tool_call: true, attachment: true, limit: { context: 1_000_000, output: 32_000 } } },
      },
    } } });
    return Response.json({ error: { message: "probe stop" } }, { status: 401 });
  }) as typeof fetch;

  const cfg = accountConfig("opencode/x-preview-f-free");
  expect(getProvider(cfg)).toBeInstanceOf(OpenCodeAccountProvider);
  expect(await listModelOptions(cfg)).toEqual([expect.objectContaining({
    id: "opencode/x-preview-f-free",
    label: "Ox Alpha Free",
    contextWindow: 1_000_000,
    vision: true,
  })]);
  const provider = new OpenCodeAccountProvider(cfg);
  await expect(provider.complete([{ role: "user", content: "probe" }])).rejects.toThrow();
  await provider.dispose();
  expect(calls.map((call) => call.url)).toEqual([
    "https://opencode.ai/console/api/config",
    "https://opencode.ai/console/api/config",
    "https://opencode.ai/inference/openai/v1/chat/completions",
  ]);
  for (const call of calls) expect(call.headers.get("authorization")).toBe("Bearer account-access");
  expect(calls.at(-1)?.headers.get("x-opencode-org-id")).toBe("org-1");
  expect(calls.at(-1)?.headers.get("x-untrusted")).toBeNull();
  expect(JSON.stringify(calls.at(-1))).not.toContain("catalog-secret-must-not-be-sent");
  expect(calls.at(-1)?.body.model).toBe("x-preview-f-free");
});

test("OpenCode Console refuses a catalog endpoint outside opencode.ai before leaking OAuth", async () => {
  accountHome();
  let evilCalled = false;
  // SAFETY: test-built fetch fixture implements the fetch arguments and returns a Response for every path.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://evil.example")) evilCalled = true;
    return Response.json(url.endsWith("/console/api/config") ? { config: { provider: {
      console: { npm: "@ai-sdk/openai", api: "https://evil.example/v1", models: { gpt: { tool_call: true } } },
    } } } : { error: "unexpected" }, { status: url.endsWith("/console/api/config") ? 200 : 500 });
  }) as typeof fetch;
  const provider = new OpenCodeAccountProvider(accountConfig());
  await expect(provider.complete([{ role: "user", content: "probe" }])).rejects.toThrow(/untrusted or invalid endpoint/i);
  expect(evilCalled).toBe(false);
});

async function cli(home: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    HOME: home,
    USERPROFILE: home,
    NEKO_AUTO_UPDATE: "0",
    ...(process.env.PATH ? { PATH: process.env.PATH } : undefined),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : undefined),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : undefined),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : undefined),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : undefined),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : undefined),
    ...(process.env.TMP ? { TMP: process.env.TMP } : undefined),
    ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : undefined),
  };
  const child = Bun.spawn([process.execPath, "bin/neko.ts", ...args], {
    cwd: resolve("."), env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("CLI OpenCode login and logout keep the Zen key profile-scoped and never echo it", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-opencode-cli-"));
  roots.push(home);
  const sentinel = "opencode-integration-sentinel";

  const login = await cli(home, "login", "opencode", "zen", sentinel);
  expect(login.code).toBe(0);
  expect(login.stdout + login.stderr).not.toContain(sentinel);
  const configPath = join(home, ".neko-core", "config.json");
  expect(existsSync(configPath)).toBe(true);
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  expect(saved.active_profile).toBe("opencode");
  expect(saved.profiles.opencode.api_key).toBe(sentinel);
  expect(saved.api_key).toBeUndefined();

  const logout = await cli(home, "logout", "opencode");
  expect(logout.code).toBe(0);
  expect(logout.stdout + logout.stderr).not.toContain(sentinel);
  const cleared = JSON.parse(readFileSync(configPath, "utf8"));
  expect(cleared.profiles.opencode.api_key).toBeUndefined();
}, 15_000);
