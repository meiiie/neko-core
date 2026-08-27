import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClineAccountProvider, listClineModelOptions } from "../src/adapters/cline.ts";
import { saveClineCredentials } from "../src/adapters/cline-auth.ts";
import { DEFAULTS, NekoConfig } from "../src/adapters/config.ts";

const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
const realFetch = globalThis.fetch;
let tempHome = "";

function fetchFixture(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  const fixture = Object.assign(impl, { preconnect(_url: string | URL): void {} });
  // SAFETY: the fixture implements Fetch's call signature and Bun's side-effect-free preconnect property.
  return fixture as typeof fetch;
}

function isolatedHome(): void {
  tempHome = mkdtempSync(join(tmpdir(), "neko-cline-provider-"));
  process.env.USERPROFILE = tempHome;
  process.env.HOME = tempHome;
}

function config(): NekoConfig {
  const profiles = structuredClone(DEFAULTS.profiles);
  return new NekoConfig({ ...DEFAULTS, ...profiles["cline-account"], max_retries: 0, reasoning_effort: "off" }, "cline-account", profiles, "");
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = "";
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
});

test("Cline model picker uses the public free and account catalogs without requiring login", async () => {
  isolatedHome();
  const mockFetch = fetchFixture(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/recommended-models")) return Response.json({
      free: [{ id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", description: "free" }],
      recommended: [{ id: "openai/gpt-5.6-sol", name: "GPT 5.6 Sol", description: "frontier" }],
      clinePass: [{ id: "cline-pass/glm-5.3", name: "GLM 5.3", description: "pass" }],
    });
    return Response.json({}, { status: 404 });
  });
  const options = await listClineModelOptions(config(), mockFetch);
  expect(options.map((option) => option.id)).toEqual(expect.arrayContaining([
    "z-ai/glm-5.3-flash",
    "openai/gpt-5.6-sol",
    "cline-pass/glm-5.3",
  ]));
  expect(options.find((option) => option.id === "z-ai/glm-5.3-flash")?.description).toContain("Free");
});

test("Cline account provider sends an honest client identity and a WorkOS-prefixed bearer", async () => {
  isolatedHome();
  saveClineCredentials({ accessToken: "cline-access", refreshToken: "cline-refresh", expiresAt: Date.now() + 3_600_000, tokenType: "Bearer" });
  let headers = new Headers();
  globalThis.fetch = fetchFixture(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.cline.bot/api/v1/chat/completions");
    headers = new Headers(init?.headers);
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: {} });
  });
  const result = await new ClineAccountProvider(config()).complete([{ role: "user", content: "hello" }]);
  expect(result.content).toBe("ok");
  expect(headers.get("authorization")).toBe("Bearer workos:cline-access");
  expect(headers.get("x-client-type")).toBe("neko-core");
  expect(headers.get("user-agent")).toMatch(/^NekoCore\//);
});

test("Cline account provider refreshes once after an early HTTP 401", async () => {
  isolatedHome();
  saveClineCredentials({ accessToken: "old-access", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000, tokenType: "Bearer" });
  const authHeaders: string[] = [];
  let chatCalls = 0;
  globalThis.fetch = fetchFixture(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/refresh")) return Response.json({ success: true, data: {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      userInfo: { clineUserId: "user", email: "user@example.com", name: "User", accounts: [] },
    } });
    chatCalls++;
    authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
    if (chatCalls === 1) return Response.json({ error: { message: "expired" } }, { status: 401 });
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "recovered" } }] });
  });
  const result = await new ClineAccountProvider(config()).complete([{ role: "user", content: "hello" }]);
  expect(result.content).toBe("recovered");
  expect(authHeaders).toEqual(["Bearer workos:old-access", "Bearer workos:new-access"]);
});

test("Cline Account refuses a configured lookalike endpoint before exposing its bearer", async () => {
  isolatedHome();
  saveClineCredentials({ accessToken: "never-send", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000, tokenType: "Bearer" });
  let fetched = false;
  globalThis.fetch = fetchFixture(async () => {
    fetched = true;
    return Response.json({});
  });
  const unsafe = config();
  unsafe.data.base_url = "https://api.cline.bot.evil.example/api/v1";
  await expect(new ClineAccountProvider(unsafe).complete([{ role: "user", content: "hello" }])).rejects.toThrow(/official.*api\.cline\.bot/i);
  expect(fetched).toBe(false);
});
