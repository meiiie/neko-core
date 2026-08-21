/** OpenCode Console device OAuth. Neko owns this token file and never imports another CLI's state. */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";
import { isJsonNumber, isJsonObject, isText, type JsonObject, type JsonValue } from "../shared/wire.ts";
import { openBrowser } from "./chatgpt-auth.ts";

export const OPENCODE_CONSOLE_URL = "https://opencode.ai/console";
export const OPENCODE_CLIENT_ID = "opencode-cli";
const REFRESH_SKEW_MS = 5 * 60_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export interface OpenCodeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  server: string;
  accountId: string;
  email: string;
  orgId?: string;
  orgName?: string;
}

export interface OpenCodeLoginOptions {
  notify?: (message: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  openUrl?: (url: string) => void;
  server?: string;
}

export interface OpenCodeAccountConfig {
  credentials: OpenCodeCredentials;
  token: string;
  config: JsonObject;
}

function authPath(): string {
  return join(homeDir(), ".neko-core", "opencode-auth.json");
}

function fixedServer(input = OPENCODE_CONSOLE_URL): string {
  const url = new URL(input);
  const normalized = url.toString().replace(/\/+$/, "");
  if (normalized !== OPENCODE_CONSOLE_URL) throw new Error("OpenCode Console must use the official opencode.ai endpoint.");
  return normalized;
}

function requiredText(value: JsonValue | undefined, field: string): string {
  if (!isText(value) || value.length > 16_384) throw new Error(`OpenCode OAuth returned an invalid ${field}.`);
  return value;
}

async function boundedJson(response: Response, label: string): Promise<JsonValue> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw new Error(`${label} was too large.`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error(`${label} was too large.`);
  try {
    // SAFETY: JSON.parse can only produce the JsonValue domain; functions and undefined are not JSON syntax.
    const value: JsonValue = JSON.parse(text);
    return value;
  } catch {
    throw new Error(`${label} was not valid JSON.`);
  }
}

async function postJson(fetchImpl: typeof fetch, url: string, body: Record<string, string>): Promise<{ response: Response; data: JsonObject }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await boundedJson(response, "OpenCode OAuth response");
  if (!isJsonObject(data)) throw new Error("OpenCode OAuth response was not a JSON object.");
  return { response, data };
}

function oauthError(prefix: string, response: Response, data: JsonObject): Error {
  const detail = isText(data.error_description) ? data.error_description
    : isText(data.error) ? data.error
      : `HTTP ${response.status}`;
  return new Error(`${prefix}: ${detail.slice(0, 300)}`);
}

export function loadOpenCodeCredentials(): OpenCodeCredentials | null {
  if (!existsSync(authPath())) return null;
  try {
    // SAFETY: credential storage contains JSON only and is narrowed to an object immediately below.
    const raw: JsonValue = JSON.parse(readFileSync(authPath(), "utf8"));
    if (!isJsonObject(raw)) return null;
    const credentials: OpenCodeCredentials = {
      accessToken: String(raw.access_token ?? ""),
      refreshToken: String(raw.refresh_token ?? ""),
      expiresAt: Number(raw.expires_at ?? 0),
      server: String(raw.server ?? OPENCODE_CONSOLE_URL),
      accountId: String(raw.account_id ?? ""),
      email: String(raw.email ?? ""),
      orgId: isText(raw.org_id) ? raw.org_id : undefined,
      orgName: isText(raw.org_name) ? raw.org_name : undefined,
    };
    if (!credentials.refreshToken || !credentials.server || !credentials.accountId || !credentials.email) return null;
    fixedServer(credentials.server);
    return credentials;
  } catch {
    return null;
  }
}

export function saveOpenCodeCredentials(credentials: OpenCodeCredentials): void {
  const dir = join(homeDir(), ".neko-core");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* Windows does not implement POSIX modes. */ }
  const payload: JsonObject = {
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expires_at: credentials.expiresAt,
    server: credentials.server,
    account_id: credentials.accountId,
    email: credentials.email,
  };
  if (credentials.orgId) payload.org_id = credentials.orgId;
  if (credentials.orgName) payload.org_name = credentials.orgName;
  atomicWriteFileSync(authPath(), JSON.stringify(payload, null, 2) + "\n", 0o600);
  try { chmodSync(authPath(), 0o600); } catch { /* Windows does not implement POSIX modes. */ }
}

export function hasOpenCodeCredentials(): boolean {
  return loadOpenCodeCredentials() !== null;
}

export function clearOpenCodeCredentials(): string {
  const existed = existsSync(authPath());
  rmSync(authPath(), { force: true });
  return existed ? "OpenCode Console sign-in removed." : "OpenCode Console was already signed out.";
}

let refreshFlight: Promise<string> | null = null;

export async function validOpenCodeAccessToken(options: { fetchImpl?: typeof fetch; force?: boolean } = {}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const current = loadOpenCodeCredentials();
  if (!current) throw new Error("OpenCode Console is not signed in. Run /login or `neko login opencode`.");
  if (!options.force && current.accessToken && current.expiresAt > Date.now() + REFRESH_SKEW_MS) return current.accessToken;
  if (refreshFlight) return refreshFlight;
  refreshFlight = (async () => {
    const latest = loadOpenCodeCredentials() ?? current;
    if (!options.force && latest.accessToken && latest.expiresAt > Date.now() + REFRESH_SKEW_MS) return latest.accessToken;
    const { response, data } = await postJson(fetchImpl, `${fixedServer(latest.server)}/auth/device/token`, {
      grant_type: "refresh_token",
      refresh_token: latest.refreshToken,
      client_id: OPENCODE_CLIENT_ID,
    });
    if (!response.ok) throw oauthError("OpenCode token refresh failed; run /login again", response, data);
    const accessToken = requiredText(data.access_token, "access token");
    const refreshToken = requiredText(data.refresh_token, "refresh token");
    const expiresIn = data.expires_in;
    if (!isJsonNumber(expiresIn) || expiresIn <= 0) throw new Error("OpenCode OAuth returned an invalid expiry.");
    saveOpenCodeCredentials({ ...latest, accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 });
    return accessToken;
  })();
  try { return await refreshFlight; }
  finally { refreshFlight = null; }
}

async function getJson(fetchImpl: typeof fetch, url: string, token: string, orgId?: string): Promise<JsonValue> {
  const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${token}` });
  if (orgId) headers.set("x-org-id", orgId);
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await boundedJson(response, "OpenCode Console response");
  if (!response.ok) throw oauthError("OpenCode Console request failed", response, isJsonObject(data) ? data : {});
  return data;
}

/** Fetch the account-managed provider catalog without persisting its dynamic contents. */
export async function loadOpenCodeAccountConfig(fetchImpl: typeof fetch = fetch): Promise<OpenCodeAccountConfig> {
  const token = await validOpenCodeAccessToken({ fetchImpl });
  const credentials = loadOpenCodeCredentials();
  if (!credentials) throw new Error("OpenCode Console credentials disappeared during refresh. Run /login again.");
  const body = await getJson(fetchImpl, `${fixedServer(credentials.server)}/api/config`, token, credentials.orgId);
  if (!isJsonObject(body) || !isJsonObject(body.config) || !isJsonObject(body.config.provider)) {
    throw new Error("OpenCode Console returned no usable provider catalog for this account.");
  }
  return { credentials, token, config: body.config };
}

/** Official RFC 8628-style device login used by OpenCode's public `opencode-cli` client. */
export async function loginOpenCode(options: OpenCodeLoginOptions = {}): Promise<OpenCodeCredentials> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const server = fixedServer(options.server);
  const started = await postJson(fetchImpl, `${server}/auth/device/code`, { client_id: OPENCODE_CLIENT_ID });
  if (!started.response.ok) throw oauthError("OpenCode device authorization failed", started.response, started.data);
  const deviceCode = requiredText(started.data.device_code, "device code");
  const userCode = requiredText(started.data.user_code, "user code");
  const expiresIn = started.data.expires_in;
  const interval = started.data.interval;
  let intervalSeconds = isJsonNumber(interval) ? Math.max(1, interval) : 5;
  if (!isJsonNumber(expiresIn) || expiresIn <= 0) throw new Error("OpenCode device authorization returned an invalid expiry.");
  const verificationPath = requiredText(started.data.verification_uri_complete, "verification URL");
  const verification = new URL(verificationPath.startsWith("/") ? `${server}${verificationPath}` : verificationPath, `${server}/`);
  const expected = new URL(server);
  if (verification.protocol !== "https:" || verification.origin !== expected.origin) {
    throw new Error("OpenCode device authorization returned an untrusted verification URL.");
  }
  options.notify?.(`Open this URL to sign in to OpenCode Console:\n${verification.toString()}\nCode: ${userCode}`);
  try { (options.openUrl ?? openBrowser)(verification.toString()); }
  catch { /* The URL and code are already visible. */ }

  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const polled = await postJson(fetchImpl, `${server}/auth/device/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: OPENCODE_CLIENT_ID,
    });
    if (polled.response.ok && isText(polled.data.access_token)) {
      const accessToken = requiredText(polled.data.access_token, "access token");
      const refreshToken = requiredText(polled.data.refresh_token, "refresh token");
      const tokenExpiresIn = polled.data.expires_in;
      if (!isJsonNumber(tokenExpiresIn) || tokenExpiresIn <= 0) throw new Error("OpenCode OAuth returned an invalid expiry.");
      const [user, orgBody] = await Promise.all([
        getJson(fetchImpl, `${server}/api/user`, accessToken),
        getJson(fetchImpl, `${server}/api/orgs`, accessToken),
      ]);
      if (!isJsonObject(user)) throw new Error("OpenCode Console returned an invalid user record.");
      const accountId = requiredText(user.id, "account id");
      const email = requiredText(user.email, "account email");
      const orgs: JsonValue[] = Array.isArray(orgBody) ? orgBody : isJsonObject(orgBody) && Array.isArray(orgBody.orgs) ? orgBody.orgs : [];
      const org = orgs
        .map((value) => isJsonObject(value) && isText(value.id) && isText(value.name) ? { id: value.id, name: value.name } : null)
        .filter((value): value is { id: string; name: string } => value !== null)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0];
      const credentials: OpenCodeCredentials = {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + tokenExpiresIn * 1000,
        server,
        accountId,
        email,
        orgId: org?.id,
        orgName: org?.name,
      };
      saveOpenCodeCredentials(credentials);
      return credentials;
    }
    const error = String(polled.data.error ?? "");
    if (error === "authorization_pending") continue;
    if (error === "slow_down") { intervalSeconds += 5; continue; }
    if (error === "access_denied") throw oauthError("OpenCode sign-in was denied", polled.response, polled.data);
    if (error === "expired_token") break;
    throw oauthError("OpenCode sign-in failed", polled.response, polled.data);
  }
  throw new Error("OpenCode sign-in timed out. Run /login and try again.");
}
