import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  accountIdFromTokens,
  buildChatGptAuthorizeUrl,
  clearChatGptCredentials,
  loadChatGptCredentials,
  loginChatGpt,
  saveChatGptCredentials,
  validChatGptCredentials,
} from "../src/adapters/chatgpt-auth.ts";

const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
let tempHome = "";

function isolatedHome(): string {
  tempHome = mkdtempSync(join(tmpdir(), "neko-chatgpt-auth-"));
  process.env.USERPROFILE = tempHome;
  process.env.HOME = tempHome;
  return tempHome;
}

function jwt(claims: Record<string, any>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = "";
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
});

test("ChatGPT authorize URL uses PKCE, state, offline access, and the local callback", () => {
  const url = new URL(buildChatGptAuthorizeUrl("http://localhost:1455/auth/callback", "challenge", "state", "https://issuer.test"));
  expect(url.origin).toBe("https://issuer.test");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBe("challenge");
  expect(url.searchParams.get("state")).toBe("state");
  expect(url.searchParams.get("scope")).toContain("offline_access");
  expect(url.searchParams.get("originator")).toBe("neko");
});

test("ChatGPT credentials round-trip in a separate restricted file and clear cleanly", () => {
  const home = isolatedHome();
  saveChatGptCredentials({ accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: 123, accountId: "acct" });
  expect(loadChatGptCredentials()).toEqual({ accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: 123, accountId: "acct" });
  const path = join(home, ".neko-core", "chatgpt-auth.json");
  expect(readFileSync(path, "utf8")).not.toContain("api_key");
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(clearChatGptCredentials()).toContain("removed");
  expect(loadChatGptCredentials()).toBeNull();
});

test("ChatGPT logout does not erase an OpenAI API key", () => {
  const home = isolatedHome();
  saveChatGptCredentials({ accessToken: "access", refreshToken: "refresh", expiresAt: 123 });
  const configPath = join(home, ".neko-core", "config.json");
  writeFileSync(configPath, JSON.stringify({ active_profile: "openai", profiles: { openai: { api_key: "KEEP-ME" } } }));
  clearChatGptCredentials();
  expect(JSON.parse(readFileSync(configPath, "utf8")).profiles.openai.api_key).toBe("KEEP-ME");
  expect(loadChatGptCredentials()).toBeNull();
});

test("expired ChatGPT credentials refresh and retain the old refresh token when it is not rotated", async () => {
  isolatedHome();
  saveChatGptCredentials({ accessToken: "old", refreshToken: "refresh-old", expiresAt: 1, accountId: "acct-old" });
  let sent = "";
  const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent = String(init?.body ?? "");
    return Response.json({ access_token: jwt({ chatgpt_account_id: "acct-new" }), expires_in: 3600 });
  }) as typeof fetch;
  const refreshed = await validChatGptCredentials(mockFetch, "https://issuer.test");
  expect(sent).toContain("grant_type=refresh_token");
  expect(sent).toContain("refresh_token=refresh-old");
  expect(refreshed.refreshToken).toBe("refresh-old");
  expect(refreshed.accountId).toBe("acct-new");
  expect(loadChatGptCredentials()?.accessToken).toBe(refreshed.accessToken);
});

test("device sign-in polls, exchanges the code, and persists the account", async () => {
  isolatedHome();
  const calls: string[] = [];
  let polls = 0;
  const mockFetch = (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/api/accounts/deviceauth/usercode")) return Response.json({ device_auth_id: "dev", user_code: "ABCD", interval: "1" });
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      polls++;
      return polls === 1 ? new Response("", { status: 403 }) : Response.json({ authorization_code: "code", code_verifier: "verifier" });
    }
    return Response.json({ access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-device" } }), refresh_token: "refresh", expires_in: 3600 });
  }) as typeof fetch;
  const notices: string[] = [];
  await loginChatGpt({ device: true, fetchImpl: mockFetch, issuer: "https://issuer.test", notify: (m) => notices.push(m), sleep: async () => {} });
  expect(calls.some((url) => url.endsWith("/oauth/token"))).toBe(true);
  expect(notices.join("\n")).toContain("ABCD");
  expect(loadChatGptCredentials()?.accountId).toBe("acct-device");
});

test("account id extraction accepts the nested Codex claim", () => {
  expect(accountIdFromTokens({ access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" } }) })).toBe("acct-nested");
});
