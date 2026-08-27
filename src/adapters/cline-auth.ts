/** Cline Account device OAuth. Neko owns this file and never imports another client's credentials. */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../shared/atomic.ts";
import { abortableDelay, requestSignal, throwIfAborted } from "../shared/abort.ts";
import { homeDir } from "../shared/home.ts";
import { VERSION } from "../shared/version.ts";
import { isJsonNumber, isJsonObject, isText, type JsonObject, type JsonValue } from "../shared/wire.ts";
import { openBrowser } from "./chatgpt-auth.ts";

export const CLINE_API_ORIGIN = "https://api.cline.bot";
export const CLINE_API_BASE_URL = `${CLINE_API_ORIGIN}/api/v1`;
export const CLINE_WORKOS_ORIGIN = "https://api.workos.com";
export const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
const REFRESH_SKEW_MS = 5 * 60_000;
const RETRYABLE_TOKEN_GRACE_MS = 30_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

class ClineTokenError extends Error {
  constructor(message: string, readonly status: number, readonly code = "") {
    super(message);
    this.name = "ClineTokenError";
  }

  isInvalidGrant(): boolean {
    return [400, 401, 403].includes(this.status) && /invalid|expired|revoked|unauthorized/i.test(`${this.code} ${this.message}`);
  }
}

export interface ClineCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
  name?: string;
  tokenType: string;
}

export interface ClineLoginOptions {
  notify?: (message: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  openUrl?: (url: string) => void;
  signal?: AbortSignal;
}

function authPath(): string {
  return join(homeDir(), ".neko-core", "cline-auth.json");
}

function requiredText(value: JsonValue | undefined, field: string, max = 16_384): string {
  if (!isText(value) || value.length > max) throw new Error(`Cline OAuth returned an invalid ${field}.`);
  return value;
}

async function boundedJson(response: Response, label: string): Promise<JsonValue> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw new Error(`${label} was too large.`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error(`${label} was too large.`);
  try {
    // SAFETY: JSON syntax can produce only the JsonValue domain.
    return JSON.parse(text) as JsonValue;
  }
  catch { throw new Error(`${label} was not valid JSON.`); }
}

function errorDetail(data: JsonValue, fallback: string): string {
  if (!isJsonObject(data)) return fallback;
  if (isText(data.error_description)) return data.error_description.slice(0, 300);
  if (isText(data.error)) return data.error.slice(0, 300);
  if (isText(data.message)) return data.message.slice(0, 300);
  return fallback;
}

function apiResponseData(payload: JsonValue, label: string): JsonObject {
  if (!isJsonObject(payload) || payload.success !== true || !isJsonObject(payload.data)) {
    throw new Error(`Cline ${label} returned an invalid response.`);
  }
  return payload.data;
}

function parseClineCredentials(data: JsonObject, previous?: ClineCredentials): ClineCredentials {
  const accessToken = requiredText(data.accessToken, "access token");
  const refreshToken = isText(data.refreshToken) ? requiredText(data.refreshToken, "refresh token") : previous?.refreshToken;
  if (!refreshToken) throw new Error("Cline OAuth returned no refresh token.");
  const expiresAtText = requiredText(data.expiresAt, "expiry", 128);
  const expiresAt = Date.parse(expiresAtText);
  if (!Number.isFinite(expiresAt)) throw new Error("Cline OAuth returned an invalid expiry.");
  const user = isJsonObject(data.userInfo) ? data.userInfo : {};
  return {
    accessToken,
    refreshToken,
    expiresAt,
    accountId: isText(user.clineUserId) ? user.clineUserId : previous?.accountId,
    email: isText(user.email) ? user.email : previous?.email,
    name: isText(user.name) ? user.name : previous?.name,
    tokenType: isText(data.tokenType) ? data.tokenType : previous?.tokenType ?? "Bearer",
  };
}

export function clineIdentityHeaders() {
  return {
    "HTTP-Referer": "https://github.com/meiiie/neko-core",
    "X-Title": "Neko Core",
    "X-CLIENT-TYPE": "neko-core",
    "X-CLIENT-VERSION": VERSION,
    "User-Agent": `NekoCore/${VERSION}`,
  };
}

export function loadClineCredentials(): ClineCredentials | null {
  if (!existsSync(authPath())) return null;
  try {
    const raw: JsonValue = JSON.parse(readFileSync(authPath(), "utf8"));
    if (!isJsonObject(raw)) return null;
    const credentials: ClineCredentials = {
      accessToken: isText(raw.access_token) && raw.access_token.length <= 16_384 ? raw.access_token : "",
      refreshToken: isText(raw.refresh_token) && raw.refresh_token.length <= 16_384 ? raw.refresh_token : "",
      expiresAt: Number(raw.expires_at ?? 0),
      accountId: isText(raw.account_id) && raw.account_id.length <= 1024 ? raw.account_id : undefined,
      email: isText(raw.email) && raw.email.length <= 1024 ? raw.email : undefined,
      name: isText(raw.name) && raw.name.length <= 1024 ? raw.name : undefined,
      tokenType: isText(raw.token_type) && raw.token_type.length <= 128 ? raw.token_type : "Bearer",
    };
    return credentials.refreshToken && Number.isFinite(credentials.expiresAt) ? credentials : null;
  } catch {
    return null;
  }
}

export function saveClineCredentials(credentials: ClineCredentials): void {
  const dir = join(homeDir(), ".neko-core");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* Windows does not implement POSIX modes. */ }
  const payload: JsonObject = {
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expires_at: credentials.expiresAt,
    token_type: credentials.tokenType,
  };
  if (credentials.accountId) payload.account_id = credentials.accountId;
  if (credentials.email) payload.email = credentials.email;
  if (credentials.name) payload.name = credentials.name;
  atomicWriteFileSync(authPath(), JSON.stringify(payload, null, 2) + "\n", 0o600);
  try { chmodSync(authPath(), 0o600); } catch { /* Windows does not implement POSIX modes. */ }
}

export function hasClineCredentials(): boolean {
  return loadClineCredentials() !== null;
}

export function clearClineCredentials(): string {
  const existed = existsSync(authPath());
  rmSync(authPath(), { force: true });
  return existed ? "Cline Account sign-in removed." : "Cline Account was already signed out.";
}

function formatAccessToken(token: string): string {
  return token.startsWith("workos:") ? token : `workos:${token}`;
}

let refreshFlight: Promise<string> | null = null;

export async function validClineAccessToken(options: { fetchImpl?: typeof fetch; force?: boolean } = {}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const current = loadClineCredentials();
  if (!current) throw new Error("Cline Account is not signed in. Run /login or `neko login cline account`.");
  if (!options.force && current.accessToken && current.expiresAt > Date.now() + REFRESH_SKEW_MS) return formatAccessToken(current.accessToken);
  if (refreshFlight) return refreshFlight;
  refreshFlight = (async () => {
    const latest = loadClineCredentials() ?? current;
    if (!options.force && latest.accessToken && latest.expiresAt > Date.now() + REFRESH_SKEW_MS) return formatAccessToken(latest.accessToken);
    try {
      const response = await fetchImpl(`${CLINE_API_BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { ...clineIdentityHeaders(), Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: latest.refreshToken, grantType: "refresh_token" }),
        signal: requestSignal(),
      });
      const payload = await boundedJson(response, "Cline token refresh");
      if (!response.ok) {
        const code = isJsonObject(payload) && isText(payload.error) ? payload.error : "";
        throw new ClineTokenError(`Cline token refresh failed (HTTP ${response.status}): ${errorDetail(payload, "run /login again")}`, response.status, code);
      }
      const refreshed = parseClineCredentials(apiResponseData(payload, "token refresh"), latest);
      saveClineCredentials(refreshed);
      return formatAccessToken(refreshed.accessToken);
    } catch (error) {
      if (error instanceof ClineTokenError && error.isInvalidGrant()) {
        throw new Error("Cline Account session expired or was revoked. Run /login again.");
      }
      // A transient refresh failure must not log the user out. The old token remains usable while
      // it still has a small safety margin; an actually expired token surfaces the real failure.
      if (latest.accessToken && latest.expiresAt > Date.now() + RETRYABLE_TOKEN_GRACE_MS) return formatAccessToken(latest.accessToken);
      throw error;
    }
  })();
  try { return await refreshFlight; }
  finally { refreshFlight = null; }
}

/** Official WorkOS RFC 8628 device flow, followed by exchange for Cline-scoped credentials. */
export async function loginCline(options: ClineLoginOptions = {}): Promise<ClineCredentials> {
  const fetchImpl = options.fetchImpl ?? fetch;
  throwIfAborted(options.signal);
  const startedResponse = await fetchImpl(`${CLINE_WORKOS_ORIGIN}/user_management/authorize/device`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID }),
    signal: requestSignal(options.signal),
  });
  const started = await boundedJson(startedResponse, "Cline device authorization");
  if (!startedResponse.ok || !isJsonObject(started)) {
    throw new Error(`Cline device authorization failed (HTTP ${startedResponse.status}): ${errorDetail(started, "unknown error")}`);
  }
  const deviceCode = requiredText(started.device_code, "device code");
  const userCode = requiredText(started.user_code, "user code", 128);
  const verificationValue = isText(started.verification_uri_complete) ? started.verification_uri_complete : started.verification_uri;
  const verificationUrl = new URL(requiredText(verificationValue, "verification URL"));
  if (verificationUrl.protocol !== "https:" || verificationUrl.hostname !== "authkit.cline.bot") {
    throw new Error("Cline device authorization returned an untrusted verification URL.");
  }
  const expiresIn = isJsonNumber(started.expires_in) ? started.expires_in : 300;
  let intervalSeconds = isJsonNumber(started.interval) ? Math.max(1, started.interval) : 5;
  options.notify?.(`Open this URL to sign in to Cline:\n${verificationUrl.toString()}\nCode: ${userCode}`);
  try { (options.openUrl ?? openBrowser)(verificationUrl.toString()); }
  catch { /* URL and code are already visible. */ }

  const deadline = Date.now() + Math.max(1, expiresIn) * 1000;
  let workosAccess = "";
  let workosRefresh = "";
  while (Date.now() <= deadline) {
    throwIfAborted(options.signal);
    const response = await fetchImpl(`${CLINE_WORKOS_ORIGIN}/user_management/authenticate`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: CLINE_WORKOS_CLIENT_ID,
      }),
      signal: requestSignal(options.signal),
    });
    const payload = await boundedJson(response, "Cline device token");
    if (response.ok && isJsonObject(payload)) {
      workosAccess = requiredText(payload.access_token, "WorkOS access token");
      workosRefresh = requiredText(payload.refresh_token, "WorkOS refresh token");
      break;
    }
    const code = isJsonObject(payload) ? String(payload.error ?? "") : "";
    if (code === "access_denied" || code === "expired_token" || code === "invalid_grant") {
      throw new Error(`Cline sign-in failed: ${errorDetail(payload, code)}`);
    }
    if (code === "slow_down") intervalSeconds += 1;
    else if (code !== "authorization_pending") {
      throw new Error(`Cline sign-in failed (HTTP ${response.status}): ${errorDetail(payload, "unknown error")}`);
    }
    options.notify?.("Waiting for Cline browser sign-in...");
    if (options.sleep) {
      await options.sleep(intervalSeconds * 1000);
      throwIfAborted(options.signal);
    } else {
      await abortableDelay(intervalSeconds * 1000, options.signal);
    }
  }
  if (!workosAccess || !workosRefresh) throw new Error("Cline sign-in timed out. Run /login and try again.");

  const registeredResponse = await fetchImpl(`${CLINE_API_BASE_URL}/auth/register`, {
    method: "POST",
    headers: { ...clineIdentityHeaders(), Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: workosAccess, refreshToken: workosRefresh }),
    signal: requestSignal(options.signal),
  });
  const registered = await boundedJson(registeredResponse, "Cline token registration");
  if (!registeredResponse.ok) {
    throw new Error(`Cline token registration failed (HTTP ${registeredResponse.status}): ${errorDetail(registered, "unknown error")}`);
  }
  const credentials = parseClineCredentials(apiResponseData(registered, "token registration"));
  saveClineCredentials(credentials);
  return credentials;
}
