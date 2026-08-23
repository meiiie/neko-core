import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NekoConfig } from "../src/adapters/config.ts";
import {
  GROK_CLIENT_ID,
  GROK_OAUTH_SCOPES,
  clearGrokCredentials,
  grokProxyHeaders,
  listGrokCatalog,
  loadGrokCredentials,
  loginGrok,
  saveGrokCredentials,
  validGrokAccessToken,
} from "../src/adapters/grok-auth.ts";
import { getProvider } from "../src/adapters/providers.ts";
import { VERSION } from "../src/shared/version.ts";

const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
const originalFetch = globalThis.fetch;
let tempHome = "";

function isolatedHome(): string {
  tempHome = mkdtempSync(join(tmpdir(), "neko-grok-auth-"));
  process.env.USERPROFILE = tempHome;
  process.env.HOME = tempHome;
  return tempHome;
}

function jwt(claims: { sub?: string; email?: string }): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function asFetch(implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  // SAFETY: Test doubles implement the fetch call shape exercised by these adapters; unused static fields are irrelevant.
  return implementation as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = "";
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
});

test("Grok device OAuth uses xAI's public-client contract and never prints the device credential", async () => {
  const home = isolatedHome();
  const notices: string[] = [];
  const opened: string[] = [];
  const calls: Array<{ url: string; body: URLSearchParams; headers: Headers }> = [];
  let polls = 0;
  const mockFetch = asFetch(async (input, init) => {
    const url = String(input);
    calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")), headers: new Headers(init?.headers) });
    if (url.endsWith("/oauth2/device/code")) return Response.json({
      device_code: "device-secret-never-print",
      user_code: "NEKO-2468",
      verification_uri: "https://accounts.x.ai/device",
      verification_uri_complete: "https://accounts.x.ai/device?user_code=NEKO-2468",
      expires_in: 900,
      interval: 1,
    });
    polls++;
    if (polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
    return Response.json({
      access_token: jwt({ sub: "user-1", email: "grok@example.com" }),
      refresh_token: "refresh-secret",
      id_token: jwt({ sub: "user-1", email: "grok@example.com" }),
      expires_in: 3600,
    });
  });

  const credentials = await loginGrok({
    fetchImpl: mockFetch,
    notify: (message) => notices.push(message),
    openUrl: (url) => opened.push(url),
    sleep: async () => {},
  });

  const started = calls[0];
  expect(started.body.get("client_id")).toBe(GROK_CLIENT_ID);
  expect(started.body.get("scope")?.split(" ")).toEqual([...GROK_OAUTH_SCOPES]);
  expect(started.body.get("referrer")).toBe("neko-core");
  expect(started.headers.get("x-grok-client-version")).toBe(VERSION);
  expect(calls[1].body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
  expect(credentials).toMatchObject({ userId: "user-1", email: "grok@example.com", refreshToken: "refresh-secret" });
  expect(notices.join("\n")).toContain("NEKO-2468");
  expect(notices.join("\n")).not.toContain("device-secret-never-print");
  expect(opened).toEqual(["https://accounts.x.ai/device?user_code=NEKO-2468"]);
  const path = join(home, ".neko-core", "grok-auth.json");
  expect(readFileSync(path, "utf8")).not.toContain("device-secret-never-print");
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(clearGrokCredentials()).toContain("removed");
});

test("Grok login rejects a verification URL outside xAI before opening it", async () => {
  isolatedHome();
  let opened = false;
  const mockFetch = asFetch(async () => Response.json({
    device_code: "device-secret",
    user_code: "NEKO-1234",
    verification_uri: "https://evil.example/device",
    expires_in: 900,
  }));
  await expect(loginGrok({ fetchImpl: mockFetch, openUrl: () => { opened = true; } }))
    .rejects.toThrow(/untrusted verification URL/i);
  expect(opened).toBe(false);
  expect(loadGrokCredentials()).toBeNull();
});

test("Grok credential loading rejects non-text token fields instead of stringifying them", () => {
  const home = isolatedHome();
  const dir = join(home, ".neko-core");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "grok-auth.json"), JSON.stringify({
    access_token: { injected: true },
    refresh_token: ["not", "a", "token"],
    expires_at: "never",
  }));
  expect(loadGrokCredentials()).toBeNull();
});

test("Grok refresh rotates the bearer while retaining identity and an unrotated refresh token", async () => {
  isolatedHome();
  saveGrokCredentials({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    userId: "user-1",
    email: "grok@example.com",
  });
  let fields = new URLSearchParams();
  const mockFetch = asFetch(async (_input, init) => {
    fields = new URLSearchParams(String(init?.body));
    return Response.json({ access_token: "new-access", expires_in: 3600 });
  });
  expect(await validGrokAccessToken({ fetchImpl: mockFetch })).toBe("new-access");
  expect(fields.get("grant_type")).toBe("refresh_token");
  expect(fields.get("refresh_token")).toBe("old-refresh");
  expect(loadGrokCredentials()).toMatchObject({
    accessToken: "new-access",
    refreshToken: "old-refresh",
    userId: "user-1",
    email: "grok@example.com",
  });
});

test("Grok catalog keeps only Responses models and forwards account identity", async () => {
  isolatedHome();
  saveGrokCredentials({
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 3600_000,
    userId: "user-7",
    email: "grok@example.com",
  });
  let headers = new Headers();
  const mockFetch = asFetch(async (_input, init) => {
    headers = new Headers(init?.headers);
    return Response.json({ data: [
      {
        id: "grok-4.6", model: "grok-4.6", name: "Grok 4.6", api_backend: "responses",
        context_window: 500_000, description: "Frontier", reasoning_efforts: [
          { value: "xhigh", description: "Deep", default: true }, { value: "high", description: "Fast" },
        ],
      },
      { id: "legacy-chat", model: "legacy-chat", api_backend: "chat_completions", context_window: 32_000 },
    ] });
  });
  const models = await listGrokCatalog("grok-4.6", mockFetch);
  expect(models).toEqual([expect.objectContaining({ id: "grok-4.6", contextWindow: 500_000, defaultEffort: "xhigh" })]);
  expect(headers.get("authorization")).toBe("Bearer access-secret");
  expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
  expect(headers.get("x-userid")).toBe("user-7");
  expect(headers.get("x-grok-model-override")).toBe("grok-4.6");
  expect(grokProxyHeaders("grok-4.6")["x-grok-client-version"]).toBe(VERSION);
});

test("Grok Responses retries one 401 after refreshing the subscription bearer", async () => {
  isolatedHome();
  saveGrokCredentials({
    accessToken: "old-access",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 3600_000,
    userId: "user-9",
  });
  const responseBearers: string[] = [];
  globalThis.fetch = asFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "new-access", expires_in: 3600 });
    responseBearers.push(new Headers(init?.headers).get("authorization") ?? "");
    if (responseBearers.length === 1) return Response.json({ error: { message: "expired" } }, { status: 401 });
    const body = `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }], usage: {} } })}\n\ndata: [DONE]\n\n`;
    return new Response(body, { status: 200 });
  });
  const profiles = { grok: { auth: "grok_oauth" as const } };
  const cfg = new NekoConfig({
    provider: "responses",
    base_url: "https://cli-chat-proxy.grok.com/v1",
    model: "grok-4.6",
    max_retries: 0,
  }, "grok", profiles, "");
  const result = await getProvider(cfg).complete([{ role: "user", content: "hello" }]);
  expect(result.content).toBe("ok");
  expect(responseBearers).toEqual(["Bearer old-access", "Bearer new-access"]);
});
