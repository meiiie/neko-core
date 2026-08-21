import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearOpenCodeCredentials,
  loadOpenCodeAccountConfig,
  loadOpenCodeCredentials,
  loginOpenCode,
  saveOpenCodeCredentials,
  validOpenCodeAccessToken,
} from "../src/adapters/opencode-auth.ts";

const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
let tempHome = "";

function isolatedHome(): string {
  tempHome = mkdtempSync(join(tmpdir(), "neko-opencode-auth-"));
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

test("OpenCode device OAuth polls, selects a deterministic org, and never prints the device credential", async () => {
  const home = isolatedHome();
  const notices: string[] = [];
  const opened: string[] = [];
  const calls: Array<{ url: string; body: any; headers: Headers }> = [];
  let polls = 0;
  // SAFETY: test-built fetch fixture implements the two fetch arguments and returns a Response for every path.
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
    if (url.endsWith("/auth/device/code")) return Response.json({
      device_code: "device-secret-never-print",
      user_code: "ABCD-EFGH",
      verification_uri_complete: "/device?user_code=ABCD-EFGH&client_id=opencode-cli",
      expires_in: 900,
      interval: 1,
    });
    if (url.endsWith("/auth/device/token")) {
      polls++;
      if (polls === 1) return Response.json({ error: "authorization_pending", error_description: "pending" }, { status: 400 });
      return Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.endsWith("/api/user")) return Response.json({ id: "account-1", email: "user@example.com" });
    if (url.endsWith("/api/orgs")) return Response.json([
      { id: "org-z", name: "Zulu" },
      { id: "org-a", name: "Alpha" },
    ]);
    return Response.json({}, { status: 404 });
  }) as typeof fetch;

  const credentials = await loginOpenCode({
    fetchImpl: mockFetch,
    server: "https://opencode.ai/console",
    notify: (message) => notices.push(message),
    openUrl: (url) => opened.push(url),
    sleep: async () => {},
  });

  expect(calls[0]?.body).toEqual({ client_id: "opencode-cli" });
  expect(calls.filter((call) => call.url.endsWith("/auth/device/token"))[0]?.body).toMatchObject({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: "opencode-cli",
  });
  expect(calls.find((call) => call.url.endsWith("/api/user"))?.headers.get("authorization")).toBe("Bearer access-secret");
  expect(credentials).toMatchObject({ email: "user@example.com", orgId: "org-a", orgName: "Alpha" });
  expect(notices.join("\n")).toContain("ABCD-EFGH");
  expect(notices.join("\n")).not.toContain("device-secret-never-print");
  expect(opened).toEqual(["https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli"]);
  expect(loadOpenCodeCredentials()?.refreshToken).toBe("refresh-secret");
  const path = join(home, ".neko-core", "opencode-auth.json");
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8")).not.toContain("device-secret-never-print");
});

test("OpenCode token refresh rotates both tokens and keeps OAuth JSON off stdout-facing config", async () => {
  isolatedHome();
  saveOpenCodeCredentials({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    server: "https://opencode.ai/console",
    accountId: "account-1",
    email: "user@example.com",
    orgId: "org-1",
  });
  let sent: any;
  // SAFETY: test-built fetch fixture implements the two fetch arguments and always returns a Response.
  const mockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
  }) as typeof fetch;
  expect(await validOpenCodeAccessToken({ fetchImpl: mockFetch })).toBe("new-access");
  expect(sent).toEqual({ grant_type: "refresh_token", refresh_token: "old-refresh", client_id: "opencode-cli" });
  expect(loadOpenCodeCredentials()).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
});

test("OpenCode account config sends bearer and selected org without persisting the catalog", async () => {
  const home = isolatedHome();
  saveOpenCodeCredentials({
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 3600_000,
    server: "https://opencode.ai/console",
    accountId: "account-1",
    email: "user@example.com",
    orgId: "org-1",
  });
  let headers = new Headers();
  // SAFETY: test-built fetch fixture implements the two fetch arguments and always returns a Response.
  const mockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    return Response.json({ config: { provider: { console: { npm: "@ai-sdk/openai", api: "https://api.opencode.ai/v1", models: {} } } } });
  }) as typeof fetch;
  const loaded = await loadOpenCodeAccountConfig(mockFetch);
  expect(loaded.config.provider).toBeDefined();
  expect(headers.get("authorization")).toBe("Bearer access-secret");
  expect(headers.get("x-org-id")).toBe("org-1");
  expect(readFileSync(join(home, ".neko-core", "opencode-auth.json"), "utf8")).not.toContain("api.opencode.ai");
  expect(clearOpenCodeCredentials()).toContain("removed");
});

test("OpenCode login rejects a verification URL on another origin before opening it", async () => {
  isolatedHome();
  let opened = false;
  // SAFETY: test-built fetch fixture implements the two fetch arguments and always returns a Response.
  const mockFetch = (async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
    device_code: "device",
    user_code: "ABCD",
    verification_uri_complete: "https://evil.example/device",
    expires_in: 900,
    interval: 5,
  })) as typeof fetch;
  await expect(loginOpenCode({
    fetchImpl: mockFetch,
    server: "https://opencode.ai/console",
    openUrl: () => { opened = true; },
  })).rejects.toThrow(/untrusted verification URL/i);
  expect(opened).toBe(false);
  expect(loadOpenCodeCredentials()).toBeNull();
});
