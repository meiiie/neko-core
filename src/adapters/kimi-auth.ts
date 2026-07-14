/** Official Kimi Code device OAuth. Tokens belong to Neko and never come from another CLI. */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { arch, hostname, release, type as osType } from "node:os";
import { join } from "node:path";

import { homeDir } from "../shared/home.ts";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { VERSION } from "../shared/version.ts";
import { openBrowser } from "./chatgpt-auth.ts";

export const KIMI_OAUTH_HOST = "https://auth.kimi.com";
export const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

export interface KimiCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  expiresIn: number;
  scope?: string;
  tokenType?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface KimiLoginOptions {
  notify?: (message: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  openUrl?: (url: string) => void;
  oauthHost?: string;
  baseUrl?: string;
}

function authPath(): string {
  return join(homeDir(), ".neko-core", "kimi-auth.json");
}

function deviceIdPath(): string {
  return join(homeDir(), ".neko-core", "kimi-device-id");
}

function asciiHeader(value: string, fallback = "unknown"): string {
  const clean = value.replace(/[^\x20-\x7e]/g, "").trim();
  return clean || fallback;
}

let volatileDeviceId: { path: string; id: string } | null = null;

function kimiDeviceId(): string {
  const path = deviceIdPath();
  try {
    const current = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f-]{36}$/i.test(current)) return current;
  } catch { /* First use creates the stable id below. */ }
  if (volatileDeviceId?.path === path) return volatileDeviceId.id;
  const id = randomUUID();
  volatileDeviceId = { path, id };
  const dir = join(homeDir(), ".neko-core");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(path, id + "\n", 0o600);
    try { chmodSync(path, 0o600); } catch { /* Windows ACLs do not implement POSIX modes. */ }
  } catch { /* Requests can still use the process-local id if the home directory is read-only. */ }
  return id;
}

/** Stable host identity required by the official Kimi Code OAuth protocol. */
export function kimiIdentityHeaders(): Record<string, string> {
  return {
    "User-Agent": `NekoCore/${asciiHeader(VERSION)}`,
    "X-Msh-Platform": "kimi_code_cli",
    "X-Msh-Version": asciiHeader(VERSION),
    "X-Msh-Device-Name": asciiHeader(hostname()),
    "X-Msh-Device-Model": asciiHeader(`${osType()} ${release()} ${arch()}`),
    "X-Msh-Os-Version": asciiHeader(release()),
    "X-Msh-Device-Id": kimiDeviceId(),
  };
}

export function loadKimiCredentials(): KimiCredentials | null {
  const path = authPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const credentials: KimiCredentials = {
      accessToken: String(raw.access_token ?? raw.accessToken ?? ""),
      refreshToken: String(raw.refresh_token ?? raw.refreshToken ?? ""),
      expiresAt: Number(raw.expires_at ?? raw.expiresAt ?? 0),
      expiresIn: Number(raw.expires_in ?? raw.expiresIn ?? 0),
      scope: String(raw.scope ?? ""),
      tokenType: String(raw.token_type ?? raw.tokenType ?? "Bearer"),
    };
    return credentials.accessToken || credentials.refreshToken ? credentials : null;
  } catch {
    return null;
  }
}

export function saveKimiCredentials(credentials: KimiCredentials): void {
  const dir = join(homeDir(), ".neko-core");
  const path = authPath();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* Windows ACLs do not implement POSIX modes. */ }
  atomicWriteFileSync(path, JSON.stringify({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expires_at: credentials.expiresAt,
    expires_in: credentials.expiresIn,
    scope: credentials.scope ?? "",
    token_type: credentials.tokenType ?? "Bearer",
  }, null, 2) + "\n", 0o600);
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs do not implement POSIX modes. */ }
}

export function hasKimiCredentials(): boolean {
  const credentials = loadKimiCredentials();
  return Boolean(credentials?.accessToken || credentials?.refreshToken);
}

export function clearKimiCredentials(): string {
  const existed = existsSync(authPath());
  rmSync(authPath(), { force: true });
  return existed ? "Kimi Code sign-in removed." : "Kimi Code was already signed out.";
}

function credentialsFromToken(payload: TokenResponse, previousRefreshToken = ""): KimiCredentials {
  const accessToken = String(payload.access_token ?? "");
  const refreshToken = String(payload.refresh_token ?? previousRefreshToken);
  const expiresIn = Number(payload.expires_in ?? 0);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Kimi OAuth returned incomplete credentials.");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    expiresIn,
    scope: payload.scope ?? "",
    tokenType: payload.token_type ?? "Bearer",
  };
}

async function postForm(fetchImpl: typeof fetch, url: string, fields: Record<string, string>): Promise<{ response: Response; data: TokenResponse }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      ...kimiIdentityHeaders(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(30_000),
  });
  let data: TokenResponse = {};
  try { data = await response.json() as TokenResponse; } catch { /* handled by the status/error below */ }
  return { response, data };
}

function oauthError(prefix: string, response: Response, data: TokenResponse): Error {
  const detail = data.error_description || data.error || `HTTP ${response.status}`;
  return new Error(`${prefix}: ${detail}`);
}

function apiErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const detail = parsed?.error?.message ?? parsed?.error ?? parsed?.message;
    if (detail) return String(detail).slice(0, 300);
  } catch { /* Fall back to the response text. */ }
  return body.trim().slice(0, 300);
}

function accessError(status: number, detail = ""): Error {
  const reason = detail ? ` ${detail}` : "";
  return new Error(
    `Kimi Code access was rejected (HTTP ${status}).${reason} ` +
    "Check that this account has an active Kimi Code benefit, then use /logout followed by /login again.",
  );
}

/** Convert Kimi OAuth authorization failures into an actionable error without hiding other failures. */
export function explainKimiAccessError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\bHTTP (401|402|403)\b/i);
  return match ? accessError(Number(match[1])) : (error instanceof Error ? error : new Error(message));
}

async function verifyKimiCodeAccess(fetchImpl: typeof fetch, accessToken: string, baseUrl: string): Promise<void> {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: {
      ...kimiIdentityHeaders(),
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) return;
  const detail = apiErrorDetail(await response.text());
  if ([401, 402, 403].includes(response.status)) throw accessError(response.status, detail);
  throw new Error(`Kimi Code model validation failed (HTTP ${response.status}).${detail ? ` ${detail}` : ""}`);
}

let refreshFlight: Promise<string> | null = null;

/** Return a fresh access token, coalescing concurrent refreshes in this process. */
export async function validKimiAccessToken(options: { fetchImpl?: typeof fetch; oauthHost?: string; force?: boolean } = {}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const oauthHost = (options.oauthHost ?? KIMI_OAUTH_HOST).replace(/\/+$/, "");
  const current = loadKimiCredentials();
  if (!current) throw new Error("Kimi Code is not signed in. Run /login or `neko login kimi`.");
  const now = Math.floor(Date.now() / 1000);
  if (!options.force && current.accessToken && current.expiresAt > now + 300) return current.accessToken;
  if (refreshFlight) return refreshFlight;

  refreshFlight = (async () => {
    // A peer process may have refreshed while this call was queued. Re-read before rotating again.
    const latest = loadKimiCredentials() ?? current;
    const freshNow = Math.floor(Date.now() / 1000);
    if (!options.force && latest.accessToken && latest.expiresAt > freshNow + 300) return latest.accessToken;
    if (!latest.refreshToken) throw new Error("Kimi Code refresh token is missing. Run /login again.");
    const { response, data } = await postForm(fetchImpl, `${oauthHost}/api/oauth/token`, {
      client_id: KIMI_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: latest.refreshToken,
    });
    if (!response.ok) throw oauthError("Kimi token refresh failed; run /login again", response, data);
    const refreshed = credentialsFromToken(data, latest.refreshToken);
    saveKimiCredentials(refreshed);
    return refreshed.accessToken;
  })();

  try { return await refreshFlight; }
  finally { refreshFlight = null; }
}

/** RFC 8628 device login against the official Kimi Code OAuth public client. */
export async function loginKimi(options: KimiLoginOptions = {}): Promise<KimiCredentials> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const oauthHost = (options.oauthHost ?? KIMI_OAUTH_HOST).replace(/\/+$/, "");
  const baseUrl = options.baseUrl ?? KIMI_CODE_BASE_URL;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { response, data } = await postForm(fetchImpl, `${oauthHost}/api/oauth/device_authorization`, {
    client_id: KIMI_CLIENT_ID,
  });
  if (!response.ok) throw oauthError("Kimi device authorization failed", response, data);

  const auth = data as TokenResponse & {
    user_code?: string;
    device_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number | string;
  };
  const code = String(auth.user_code ?? "");
  const deviceCode = String(auth.device_code ?? "");
  const verificationUrl = String(auth.verification_uri_complete ?? auth.verification_uri ?? "");
  const expiresIn = Number(auth.expires_in ?? 1800);
  let intervalSeconds = Math.max(1, Number(auth.interval ?? 5));
  if (!code || !deviceCode || !verificationUrl || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Kimi device authorization returned an invalid response.");
  }
  let parsedUrl: URL;
  try { parsedUrl = new URL(verificationUrl); }
  catch { throw new Error("Kimi device authorization returned an invalid verification URL."); }
  if (parsedUrl.protocol !== "https:") throw new Error("Kimi verification URL must use HTTPS.");

  options.notify?.(`Open this URL to sign in to Kimi Code:\n${verificationUrl}\nCode: ${code}`);
  try { (options.openUrl ?? openBrowser)(verificationUrl); }
  catch { /* the URL is printed, so browser launch failure is recoverable */ }

  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    const polled = await postForm(fetchImpl, `${oauthHost}/api/oauth/token`, {
      client_id: KIMI_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (polled.response.ok) {
      const credentials = credentialsFromToken(polled.data);
      // Do not report a browser login as usable until the account and stable device identity are
      // accepted by the coding endpoint. This catches expired/ineligible memberships up front.
      await verifyKimiCodeAccess(fetchImpl, credentials.accessToken, baseUrl);
      saveKimiCredentials(credentials);
      return credentials;
    }
    const error = polled.data.error ?? "";
    if (error === "slow_down") intervalSeconds += 5;
    else if (error === "access_denied") throw oauthError("Kimi sign-in was denied", polled.response, polled.data);
    else if (error === "expired_token") break;
    else if (error !== "authorization_pending") throw oauthError("Kimi sign-in failed", polled.response, polled.data);
    await sleep(intervalSeconds * 1000);
  }
  throw new Error("Kimi sign-in timed out. Run /login and try again.");
}
