/**
 * ChatGPT OAuth for the Codex backend. This is intentionally separate from API-key auth:
 * a ChatGPT subscription must never silently fall back to metered API billing.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";
import { VERSION } from "../shared/version.ts";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CHATGPT_CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
export const CHATGPT_CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const EXPIRY_MARGIN_MS = 60_000;

export interface ChatGptCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

interface LoginOptions {
  device?: boolean;
  fetchImpl?: typeof fetch;
  issuer?: string;
  openUrl?: (url: string) => void;
  notify?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

function authPath(): string {
  return join(homeDir(), ".neko-core", "chatgpt-auth.json");
}

export function loadChatGptCredentials(): ChatGptCredentials | null {
  const path = authPath();
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value.accessToken !== "string" || typeof value.refreshToken !== "string" || !Number.isFinite(value.expiresAt)) return null;
    return {
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: value.expiresAt,
      accountId: typeof value.accountId === "string" && value.accountId ? value.accountId : undefined,
    };
  } catch {
    return null;
  }
}

export function hasChatGptCredentials(): boolean {
  return loadChatGptCredentials() !== null;
}

export function saveChatGptCredentials(credentials: ChatGptCredentials): void {
  const path = authPath();
  const dir = join(homeDir(), ".neko-core");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* Windows ACLs do not implement POSIX modes. */ }
  atomicWriteFileSync(path, JSON.stringify(credentials, null, 2) + "\n", 0o600);
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs do not implement POSIX modes. */ }
}

export function clearChatGptCredentials(): string {
  rmSync(authPath(), { force: true });
  return "ChatGPT sign-in removed.";
}

export function parseJwtClaims(token: string): Record<string, any> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return null; }
}

export function accountIdFromTokens(tokens: Pick<TokenResponse, "id_token" | "access_token">): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue;
    const claims = parseJwtClaims(token);
    const id = claims?.chatgpt_account_id ?? claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? claims?.organizations?.[0]?.id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

function fromTokenResponse(tokens: TokenResponse, previousRefresh = ""): ChatGptCredentials {
  if (!tokens.access_token) throw new Error("ChatGPT token response did not include an access token.");
  const refreshToken = tokens.refresh_token || previousRefresh;
  if (!refreshToken) throw new Error("ChatGPT token response did not include a refresh token.");
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + Math.max(1, tokens.expires_in ?? 3600) * 1000,
    accountId: accountIdFromTokens(tokens),
  };
}

let refreshInFlight: Promise<ChatGptCredentials> | null = null;

export async function validChatGptCredentials(fetchImpl: typeof fetch = fetch, issuer = CHATGPT_ISSUER, forceRefresh = false): Promise<ChatGptCredentials> {
  const current = loadChatGptCredentials();
  if (!current) throw new Error("ChatGPT is not signed in. Run `neko login chatgpt`.");
  if (!forceRefresh && current.expiresAt > Date.now() + EXPIRY_MARGIN_MS) return current;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const response = await fetchImpl(`${issuer}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: CLIENT_ID }),
      });
      if (!response.ok) throw new Error(`ChatGPT token refresh failed (HTTP ${response.status}). Run \`neko login chatgpt\` again.`);
      const refreshed = fromTokenResponse(await response.json() as TokenResponse, current.refreshToken);
      if (!refreshed.accountId) refreshed.accountId = current.accountId;
      saveChatGptCredentials(refreshed);
      return refreshed;
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildChatGptAuthorizeUrl(redirectUri: string, challenge: string, state: string, issuer = CHATGPT_ISSUER): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "neko",
  });
  return `${issuer}/oauth/authorize?${query}`;
}

async function exchangeCode(code: string, verifier: string, redirectUri: string, fetchImpl: typeof fetch, issuer: string): Promise<ChatGptCredentials> {
  const response = await fetchImpl(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: CLIENT_ID, code_verifier: verifier }),
  });
  if (!response.ok) throw new Error(`ChatGPT token exchange failed (HTTP ${response.status}).`);
  return fromTokenResponse(await response.json() as TokenResponse);
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {}); // the URL is also printed, so a missing opener degrades safely
  child.unref();
}

async function browserLogin(options: LoginOptions): Promise<ChatGptCredentials> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
  const codes = pkce();
  const state = randomBytes(32).toString("base64url");
  const authorizeUrl = buildChatGptAuthorizeUrl(redirectUri, codes.challenge, state, issuer);

  let resolveLogin!: (credentials: ChatGptCredentials) => void;
  let rejectLogin!: (error: Error) => void;
  const result = new Promise<ChatGptCredentials>((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject; });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", redirectUri);
    if (url.pathname !== CALLBACK_PATH) { response.writeHead(404).end("Not found"); return; }
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const stateMatches = url.searchParams.get("state") === state;
    if (!stateMatches || error || !code) {
      const message = !stateMatches ? "OAuth state mismatch" : error || "Missing authorization code";
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(`<h1>Neko sign-in failed</h1><p>${message.replace(/[<>&]/g, "")}</p>`);
      rejectLogin(new Error(message));
      return;
    }
    try {
      const credentials = await exchangeCode(code, codes.verifier, redirectUri, fetchImpl, issuer);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<h1>Neko is signed in</h1><p>You can close this tab and return to the terminal.</p>");
      resolveLogin(credentials);
    } catch (e) {
      response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" }).end("<h1>Neko sign-in failed</h1><p>Return to the terminal for details.</p>");
      rejectLogin(e instanceof Error ? e : new Error(String(e)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(CALLBACK_PORT, "localhost", resolve);
  }).catch((error) => {
    throw new Error(`Could not start the ChatGPT callback on port ${CALLBACK_PORT}. Try \`neko login chatgpt --device\`. (${error instanceof Error ? error.message : error})`);
  });
  const timeout = setTimeout(() => rejectLogin(new Error("ChatGPT sign-in timed out after 5 minutes.")), 5 * 60_000);
  options.notify?.(`Open this URL to sign in:\n${authorizeUrl}`);
  try { (options.openUrl ?? openBrowser)(authorizeUrl); }
  catch { options.notify?.("Could not open a browser automatically. Copy the URL above into your browser."); }
  try { return await result; }
  finally { clearTimeout(timeout); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

async function deviceLogin(options: LoginOptions): Promise<ChatGptCredentials> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = await fetchImpl(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": `neko-core/${VERSION}` },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!start.ok) throw new Error(`Could not start ChatGPT device sign-in (HTTP ${start.status}).`);
  const data = await start.json() as { device_auth_id?: string; user_code?: string; interval?: string | number };
  if (!data.device_auth_id || !data.user_code) throw new Error("ChatGPT device sign-in returned an invalid response.");
  options.notify?.(`Open ${issuer}/codex/device and enter code: ${data.user_code}`);
  const interval = Math.max(1, Number(data.interval) || 5) * 1000 + 3000;
  const deadline = Date.now() + 15 * 60_000;

  for (;;) {
    if (Date.now() >= deadline) throw new Error("ChatGPT device sign-in timed out after 15 minutes.");
    const poll = await fetchImpl(`${issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `neko-core/${VERSION}` },
      body: JSON.stringify({ device_auth_id: data.device_auth_id, user_code: data.user_code }),
    });
    if (poll.ok) {
      const code = await poll.json() as { authorization_code?: string; code_verifier?: string };
      if (!code.authorization_code || !code.code_verifier) throw new Error("ChatGPT device authorization returned an invalid response.");
      return exchangeCode(code.authorization_code, code.code_verifier, `${issuer}/deviceauth/callback`, fetchImpl, issuer);
    }
    if (poll.status !== 403 && poll.status !== 404) throw new Error(`ChatGPT device sign-in failed (HTTP ${poll.status}).`);
    await sleep(interval);
  }
}

export async function loginChatGpt(options: LoginOptions = {}): Promise<ChatGptCredentials> {
  const credentials = options.device ? await deviceLogin(options) : await browserLogin(options);
  saveChatGptCredentials(credentials);
  return credentials;
}
