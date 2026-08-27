import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLINE_WORKOS_CLIENT_ID,
  clearClineCredentials,
  loadClineCredentials,
  loginCline,
  saveClineCredentials,
  validClineAccessToken,
} from "../src/adapters/cline-auth.ts";

const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
let tempHome = "";

function fetchFixture(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  const fixture = Object.assign(impl, { preconnect(_url: string | URL): void {} });
  // SAFETY: the fixture implements Fetch's call signature and Bun's side-effect-free preconnect property.
  return fixture as typeof fetch;
}

function isolatedHome(): string {
  tempHome = mkdtempSync(join(tmpdir(), "neko-cline-auth-"));
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

test("Cline device OAuth exchanges WorkOS tokens without printing or persisting the device credential", async () => {
  const home = isolatedHome();
  const notices: string[] = [];
  const opened: string[] = [];
  const calls: Array<{ url: string; body: string; headers: Headers }> = [];
  let polls = 0;
  const mockFetch = fetchFixture(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
    if (url.endsWith("/authorize/device")) return Response.json({
      device_code: "device-secret-never-print",
      user_code: "CLINE-CODE",
      verification_uri: "https://authkit.cline.bot/device-confirm",
      verification_uri_complete: "https://authkit.cline.bot/device-confirm?user_code=CLINE-CODE",
      expires_in: 300,
      interval: 1,
    });
    if (url.endsWith("/user_management/authenticate")) {
      polls++;
      if (polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({ access_token: "workos-access", refresh_token: "workos-refresh", token_type: "Bearer" });
    }
    if (url.endsWith("/auth/register")) return Response.json({
      success: true,
      data: {
        accessToken: "cline-access",
        refreshToken: "cline-refresh",
        tokenType: "Bearer",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        userInfo: { clineUserId: "cline-user", email: "user@example.com", name: "Neko User", accounts: ["personal"] },
      },
    });
    return Response.json({}, { status: 404 });
  });

  const credentials = await loginCline({
    fetchImpl: mockFetch,
    notify: (message) => notices.push(message),
    openUrl: (url) => opened.push(url),
    sleep: async () => {},
  });

  const authorize = calls.find((call) => call.url.endsWith("/authorize/device"));
  expect(new URLSearchParams(authorize?.body).get("client_id")).toBe(CLINE_WORKOS_CLIENT_ID);
  expect(calls.find((call) => call.url.endsWith("/auth/register"))?.body).toContain("workos-access");
  expect(credentials).toMatchObject({ accessToken: "cline-access", refreshToken: "cline-refresh", email: "user@example.com" });
  expect(notices.join("\n")).toContain("CLINE-CODE");
  expect(notices.join("\n")).not.toContain("device-secret-never-print");
  expect(opened).toEqual(["https://authkit.cline.bot/device-confirm?user_code=CLINE-CODE"]);
  const path = join(home, ".neko-core", "cline-auth.json");
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  const stored = readFileSync(path, "utf8");
  expect(stored).not.toContain("device-secret-never-print");
  expect(stored).not.toContain("workos-access");
  expect(loadClineCredentials()?.accountId).toBe("cline-user");
});

test("Cline refresh rotates scoped credentials and returns the required WorkOS bearer format", async () => {
  isolatedHome();
  saveClineCredentials({ accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1, tokenType: "Bearer" });
  let sent: any;
  const mockFetch = fetchFixture(async (_input: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ success: true, data: {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      userInfo: { clineUserId: "user", email: "user@example.com", name: "User", accounts: [] },
    } });
  });
  expect(await validClineAccessToken({ fetchImpl: mockFetch })).toBe("workos:new-access");
  expect(sent).toEqual({ refreshToken: "old-refresh", grantType: "refresh_token" });
  expect(loadClineCredentials()).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
  expect(clearClineCredentials()).toContain("removed");
});

test("Cline keeps a still-valid access token when refresh has a transient failure", async () => {
  isolatedHome();
  saveClineCredentials({ accessToken: "still-valid", refreshToken: "refresh", expiresAt: Date.now() + 60_000, tokenType: "Bearer" });
  const failingFetch = fetchFixture(async () => { throw new Error("offline"); });
  expect(await validClineAccessToken({ fetchImpl: failingFetch })).toBe("workos:still-valid");
  expect(loadClineCredentials()?.refreshToken).toBe("refresh");
});

test("Cline does not reuse a rejected session after an invalid refresh grant", async () => {
  isolatedHome();
  saveClineCredentials({ accessToken: "rejected", refreshToken: "revoked", expiresAt: Date.now() + 3_600_000, tokenType: "Bearer" });
  const mockFetch = fetchFixture(async () => Response.json({ error: "invalid_grant", error_description: "refresh token revoked" }, { status: 401 }));
  await expect(validClineAccessToken({ fetchImpl: mockFetch, force: true })).rejects.toThrow(/expired or was revoked/i);
  expect(loadClineCredentials()?.refreshToken).toBe("revoked");
});

test("Cline rejects an untrusted verification host before opening it", async () => {
  isolatedHome();
  let opened = false;
  const mockFetch = fetchFixture(async () => Response.json({
    device_code: "device",
    user_code: "CODE",
    verification_uri: "https://evil.example/device",
    expires_in: 300,
    interval: 5,
  }));
  await expect(loginCline({ fetchImpl: mockFetch, openUrl: () => { opened = true; } })).rejects.toThrow(/untrusted verification URL/i);
  expect(opened).toBe(false);
  expect(loadClineCredentials()).toBeNull();
});
