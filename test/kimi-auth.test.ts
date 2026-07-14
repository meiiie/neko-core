import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearKimiCredentials,
  kimiIdentityHeaders,
  loadKimiCredentials,
  loginKimi,
  saveKimiCredentials,
  validKimiAccessToken,
} from "../src/adapters/kimi-auth.ts";
import { NekoConfig } from "../src/adapters/config.ts";
import { getProvider } from "../src/adapters/providers.ts";

const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
let tempHome = "";

function isolatedHome(): string {
  tempHome = mkdtempSync(join(tmpdir(), "neko-kimi-auth-"));
  process.env.USERPROFILE = tempHome;
  process.env.HOME = tempHome;
  return tempHome;
}

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = "";
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
});

test("Kimi credentials round-trip in a separate restricted file", () => {
  const home = isolatedHome();
  saveKimiCredentials({ accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: 123, expiresIn: 60 });
  expect(loadKimiCredentials()).toMatchObject({ accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: 123 });
  const path = join(home, ".neko-core", "kimi-auth.json");
  expect(readFileSync(path, "utf8")).not.toContain("api_key");
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(clearKimiCredentials()).toContain("removed");
  expect(loadKimiCredentials()).toBeNull();
});

test("Kimi device OAuth polls, persists, and never prints the device credential", async () => {
  isolatedHome();
  let polls = 0;
  const calls: Array<{ url: string; headers: Headers }> = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    if (url.endsWith("/device_authorization")) return Response.json({
      user_code: "ABCD-EFGH",
      device_code: "device-secret-never-print",
      verification_uri: "https://www.kimi.com/code",
      verification_uri_complete: "https://www.kimi.com/code?user_code=ABCD-EFGH",
      expires_in: 120,
      interval: 1,
    });
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "kimi-for-coding" }] });
    polls++;
    if (polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
    return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" });
  }) as typeof fetch;
  const notices: string[] = [];
  const opened: string[] = [];
  await loginKimi({
    fetchImpl: mockFetch,
    oauthHost: "https://issuer.test",
    baseUrl: "https://api.test/coding/v1",
    notify: (message) => notices.push(message),
    openUrl: (url) => opened.push(url),
    sleep: async () => {},
  });
  expect(calls.some(({ url }) => url.endsWith("/api/oauth/token"))).toBe(true);
  expect(calls.some(({ url }) => url.endsWith("/models"))).toBe(true);
  expect(new Set(calls.map(({ headers }) => headers.get("x-msh-device-id"))).size).toBe(1);
  expect(calls[0]?.headers.get("x-msh-platform")).toBe("kimi_code_cli");
  expect(calls[0]?.headers.get("user-agent")).toMatch(/^NekoCore\/\d/);
  expect(notices.join("\n")).toContain("ABCD-EFGH");
  expect(notices.join("\n")).not.toContain("device-secret-never-print");
  expect(opened[0]).toStartWith("https://www.kimi.com/");
  expect(loadKimiCredentials()?.accessToken).toBe("access");
});

test("Kimi login does not persist a token when the coding membership is rejected", async () => {
  isolatedHome();
  const mockFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/device_authorization")) return Response.json({
      user_code: "ABCD-EFGH",
      device_code: "device-secret",
      verification_uri_complete: "https://www.kimi.com/code?user_code=ABCD-EFGH",
      expires_in: 120,
      interval: 1,
    });
    if (url.endsWith("/models")) return Response.json({
      error: { message: "We're unable to verify your membership benefits at this time." },
    }, { status: 402 });
    return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  }) as typeof fetch;

  await expect(loginKimi({
    fetchImpl: mockFetch,
    oauthHost: "https://issuer.test",
    baseUrl: "https://api.test/coding/v1",
    openUrl: () => {},
    sleep: async () => {},
  })).rejects.toThrow(/membership|benefit/i);
  expect(loadKimiCredentials()).toBeNull();
});

test("Kimi OAuth completion uses the stable device identity and explains membership errors", async () => {
  isolatedHome();
  saveKimiCredentials({ accessToken: "access", refreshToken: "refresh", expiresAt: Math.floor(Date.now() / 1000) + 3600, expiresIn: 3600 });
  const originalFetch = globalThis.fetch;
  let headers = new Headers();
  let body: any;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body ?? "{}"));
    return Response.json({
      error: { message: "We're unable to verify your membership benefits at this time." },
    }, { status: 402 });
  }) as typeof fetch;
  try {
    const config = new NekoConfig({
      provider: "kimi",
      base_url: "https://api.kimi.com/coding/v1",
      model: "kimi-for-coding",
      reasoning_effort: "xhigh",
      effort_ceiling: "high",
      thinking_wire: "toggle",
      max_tokens: 32_000,
    }, "kimi", { kimi: { auth: "kimi_oauth" } }, "");
    await expect(getProvider(config).complete([{ role: "user", content: "hello" }]))
      .rejects.toThrow(/Kimi Code access.*HTTP 402/i);
    expect(headers.get("authorization")).toBe("Bearer access");
    expect(headers.get("x-msh-platform")).toBe("kimi_code_cli");
    expect(headers.get("x-msh-device-id")).toBe(kimiIdentityHeaders()["X-Msh-Device-Id"]);
    expect(body.model).toBe("kimi-for-coding");
    expect(body.max_tokens).toBe(32_000);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toEqual({ type: "enabled" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("expired Kimi OAuth refreshes atomically and retains an unrotated refresh token", async () => {
  isolatedHome();
  saveKimiCredentials({ accessToken: "old", refreshToken: "refresh-old", expiresAt: 1, expiresIn: 3600 });
  let sent = "";
  const mockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent = String(init?.body ?? "");
    return Response.json({ access_token: "new", expires_in: 3600 });
  }) as typeof fetch;
  expect(await validKimiAccessToken({ fetchImpl: mockFetch, oauthHost: "https://issuer.test" })).toBe("new");
  expect(sent).toContain("grant_type=refresh_token");
  expect(sent).toContain("refresh_token=refresh-old");
  expect(loadKimiCredentials()?.refreshToken).toBe("refresh-old");
});

test("Kimi logout leaves its API-key profile untouched", () => {
  const home = isolatedHome();
  saveKimiCredentials({ accessToken: "access", refreshToken: "refresh", expiresAt: 123, expiresIn: 60 });
  const configPath = join(home, ".neko-core", "config.json");
  writeFileSync(configPath, JSON.stringify({ profiles: { moonshot: { api_key: "KEEP-ME" } } }));
  clearKimiCredentials();
  expect(JSON.parse(readFileSync(configPath, "utf8")).profiles.moonshot.api_key).toBe("KEEP-ME");
});
