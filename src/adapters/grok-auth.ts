/** Official xAI device OAuth for Grok subscriptions. Neko owns this token file. */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";
import { VERSION } from "../shared/version.ts";
import { isJsonNumber, isJsonObject, isText, type JsonObject, type JsonValue } from "../shared/wire.ts";
import { openBrowser } from "./chatgpt-auth.ts";

export const GROK_OAUTH_ISSUER = "https://auth.x.ai";
export const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
] as const;

const REFRESH_SKEW_MS = 5 * 60_000;
const DEFAULT_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export interface GrokCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  idToken?: string;
  userId: string;
  email?: string;
}

export interface GrokLoginOptions {
  notify?: (message: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  openUrl?: (url: string) => void;
}

export interface GrokCatalogModel {
  id: string;
  label: string;
  description?: string;
  contextWindow?: number;
  defaultEffort?: string;
  efforts?: Array<{ effort: string; description: string }>;
  vision?: boolean;
}

type GrokProxyHeaderSet = {
  "X-XAI-Token-Auth": string;
  "x-grok-model-override": string;
  "x-grok-client-version": string;
  "x-grok-client-mode": string;
  "x-userid"?: string;
  "x-email"?: string;
};

function authPath(): string {
  return join(homeDir(), ".neko-core", "grok-auth.json");
}

function requiredText(value: JsonValue | undefined, field: string): string {
  if (!isText(value) || value.length > 64 * 1024) throw new Error(`Grok OAuth returned an invalid ${field}.`);
  return value;
}

async function boundedJson(response: Response, label: string): Promise<JsonValue> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw new Error(`${label} was too large.`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error(`${label} was too large.`);
  try {
    // SAFETY: JSON syntax cannot create functions or undefined; callers narrow the resulting value.
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new Error(`${label} was not valid JSON.`);
  }
}

function oauthHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": `neko-core/${VERSION}`,
    // This is Neko's own semantic version, not an impersonated Grok Build version.
    "x-grok-client-version": VERSION,
    "x-grok-client-surface": "cli",
  };
}

async function postForm(fetchImpl: typeof fetch, url: string, fields: Record<string, string>): Promise<{ response: Response; data: JsonObject }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: oauthHeaders(),
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(30_000),
  });
  const parsed = await boundedJson(response, "Grok OAuth response");
  if (!isJsonObject(parsed)) throw new Error("Grok OAuth response was not a JSON object.");
  return { response, data: parsed };
}

function oauthError(prefix: string, response: Response, data: JsonObject): Error {
  const detail = isText(data.error_description) ? data.error_description
    : isText(data.error) ? data.error
      : `HTTP ${response.status}`;
  return new Error(`${prefix}: ${detail.slice(0, 300)}`);
}

/** Decode display/routing claims only. The token itself still comes from xAI over direct HTTPS. */
function jwtClaims(token: string): JsonObject {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const parsed: JsonValue = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function identityFromTokens(accessToken: string, idToken = "") {
  const idClaims = jwtClaims(idToken);
  const accessClaims = jwtClaims(accessToken);
  const principalType = isText(accessClaims.principal_type) ? accessClaims.principal_type : "";
  const principalId = isText(accessClaims.principal_id) ? accessClaims.principal_id : "";
  const userId = (principalType === "Team" || principalType === "Organization") && principalId
    ? principalId
    : isText(idClaims.sub) ? idClaims.sub
      : isText(accessClaims.sub) ? accessClaims.sub
        : "";
  const email = isText(idClaims.email) ? idClaims.email
    : isText(accessClaims.email) ? accessClaims.email
      : undefined;
  return { userId, email };
}

function credentialsFromToken(data: JsonObject, previous?: GrokCredentials): GrokCredentials {
  const accessToken = requiredText(data.access_token, "access token");
  const refreshToken = isText(data.refresh_token) ? data.refresh_token : previous?.refreshToken ?? "";
  const idToken = isText(data.id_token) ? data.id_token : previous?.idToken;
  const expiresIn = isJsonNumber(data.expires_in) && data.expires_in > 0 ? data.expires_in * 1000 : DEFAULT_TOKEN_LIFETIME_MS;
  const identity = identityFromTokens(accessToken, idToken);
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn,
    idToken,
    userId: identity.userId || previous?.userId || "",
    email: identity.email || previous?.email,
  };
}

export function loadGrokCredentials(): GrokCredentials | null {
  if (!existsSync(authPath())) return null;
  try {
    const raw: JsonValue = JSON.parse(readFileSync(authPath(), "utf8"));
    if (!isJsonObject(raw)) return null;
    const accessToken = isText(raw.access_token) && raw.access_token.length <= 64 * 1024 ? raw.access_token : "";
    const refreshToken = isText(raw.refresh_token) && raw.refresh_token.length <= 64 * 1024 ? raw.refresh_token : "";
    const expiresAt = isJsonNumber(raw.expires_at) && Number.isFinite(raw.expires_at) ? raw.expires_at : 0;
    const credentials: GrokCredentials = {
      accessToken,
      refreshToken,
      expiresAt,
      idToken: isText(raw.id_token) && raw.id_token.length <= 64 * 1024 ? raw.id_token : undefined,
      userId: isText(raw.user_id) && raw.user_id.length <= 1024 ? raw.user_id : "",
      email: isText(raw.email) && raw.email.length <= 1024 ? raw.email : undefined,
    };
    return credentials.accessToken || credentials.refreshToken ? credentials : null;
  } catch {
    return null;
  }
}

export function saveGrokCredentials(credentials: GrokCredentials): void {
  const dir = join(homeDir(), ".neko-core");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* Windows ACLs do not implement POSIX modes. */ }
  const payload: JsonObject = {
    schema_version: 1,
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expires_at: credentials.expiresAt,
    user_id: credentials.userId,
  };
  if (credentials.idToken) payload.id_token = credentials.idToken;
  if (credentials.email) payload.email = credentials.email;
  atomicWriteFileSync(authPath(), JSON.stringify(payload, null, 2) + "\n", 0o600);
  try { chmodSync(authPath(), 0o600); } catch { /* Windows ACLs do not implement POSIX modes. */ }
}

export function hasGrokCredentials(): boolean {
  const credentials = loadGrokCredentials();
  return Boolean(credentials?.accessToken || credentials?.refreshToken);
}

export function clearGrokCredentials(): string {
  const existed = existsSync(authPath());
  rmSync(authPath(), { force: true });
  return existed ? "Grok subscription sign-in removed." : "Grok subscription was already signed out.";
}

let refreshFlight: Promise<string> | null = null;

/** Return a fresh subscription bearer and coalesce concurrent refreshes in this process. */
export async function validGrokAccessToken(options: { fetchImpl?: typeof fetch; force?: boolean; rejectedToken?: string } = {}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const current = loadGrokCredentials();
  if (!current) throw new Error("Grok subscription is not signed in. Run /login or `neko login xai`.");
  if (options.rejectedToken && current.accessToken !== options.rejectedToken && current.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return current.accessToken;
  }
  if (!options.force && current.accessToken && current.expiresAt > Date.now() + REFRESH_SKEW_MS) return current.accessToken;
  if (refreshFlight) return refreshFlight;
  refreshFlight = (async () => {
    const latest = loadGrokCredentials() ?? current;
    if (options.rejectedToken && latest.accessToken !== options.rejectedToken && latest.expiresAt > Date.now() + REFRESH_SKEW_MS) {
      return latest.accessToken;
    }
    if (!options.force && latest.accessToken && latest.expiresAt > Date.now() + REFRESH_SKEW_MS) return latest.accessToken;
    if (!latest.refreshToken) throw new Error("Grok refresh token is missing. Run /logout, then /login again.");
    const { response, data } = await postForm(fetchImpl, `${GROK_OAUTH_ISSUER}/oauth2/token`, {
      grant_type: "refresh_token",
      refresh_token: latest.refreshToken,
      client_id: GROK_CLIENT_ID,
    });
    if (!response.ok) throw oauthError("Grok token refresh failed; run /login again", response, data);
    const refreshed = credentialsFromToken(data, latest);
    saveGrokCredentials(refreshed);
    return refreshed.accessToken;
  })();
  try { return await refreshFlight; }
  finally { refreshFlight = null; }
}

/** Headers documented by xAI for subscription traffic through cli-chat-proxy. */
export function grokProxyHeaders(model: string, credentials = loadGrokCredentials()) {
  const headers: GrokProxyHeaderSet = {
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-model-override": model,
    "x-grok-client-version": VERSION,
    "x-grok-client-mode": "interactive",
  };
  if (credentials?.userId) headers["x-userid"] = credentials.userId;
  if (credentials?.email) headers["x-email"] = credentials.email;
  return headers;
}

function trustedVerificationUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Grok device authorization returned an invalid verification URL."); }
  if (url.protocol !== "https:" || !["accounts.x.ai", "auth.x.ai"].includes(url.hostname.toLowerCase())) {
    throw new Error("Grok device authorization returned an untrusted verification URL.");
  }
  return url;
}

/** RFC 8628 device login using xAI's published public-client contract. */
export async function loginGrok(options: GrokLoginOptions = {}): Promise<GrokCredentials> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = await postForm(fetchImpl, `${GROK_OAUTH_ISSUER}/oauth2/device/code`, {
    client_id: GROK_CLIENT_ID,
    scope: GROK_OAUTH_SCOPES.join(" "),
    referrer: "neko-core",
  });
  if (!started.response.ok) throw oauthError("Grok device authorization failed", started.response, started.data);
  const deviceCode = requiredText(started.data.device_code, "device code");
  const userCode = requiredText(started.data.user_code, "user code");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(userCode)) throw new Error("Grok OAuth returned an invalid user code.");
  const verificationText = isText(started.data.verification_uri_complete)
    ? started.data.verification_uri_complete
    : requiredText(started.data.verification_uri, "verification URL");
  const verification = trustedVerificationUrl(verificationText);
  const expiresIn = Number(started.data.expires_in ?? 900);
  let intervalSeconds = Math.max(1, Number(started.data.interval ?? 5));
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 7200) {
    throw new Error("Grok device authorization returned an invalid expiry.");
  }
  options.notify?.(`Open this URL to sign in to Grok:\n${verification.toString()}\nCode: ${userCode}`);
  try { (options.openUrl ?? openBrowser)(verification.toString()); }
  catch { /* The URL and code are already visible. */ }

  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    // RFC 8628 requires sleeping before the first poll.
    await sleep(intervalSeconds * 1000);
    const polled = await postForm(fetchImpl, `${GROK_OAUTH_ISSUER}/oauth2/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: GROK_CLIENT_ID,
    });
    if (polled.response.ok && isText(polled.data.access_token)) {
      const credentials = credentialsFromToken(polled.data);
      saveGrokCredentials(credentials);
      return credentials;
    }
    const error = isText(polled.data.error) ? polled.data.error : "";
    if (error === "authorization_pending") continue;
    if (error === "slow_down") { intervalSeconds += 5; continue; }
    if (error === "access_denied") throw oauthError("Grok sign-in was denied", polled.response, polled.data);
    if (error === "expired_token") break;
    throw oauthError("Grok sign-in failed", polled.response, polled.data);
  }
  throw new Error("Grok sign-in timed out. Run /login and try again.");
}

function modelText(object: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (isText(value)) return value;
  }
  return undefined;
}

function modelNumber(object: JsonObject, ...keys: string[]): number | undefined {
  for (const key of keys) if (isJsonNumber(object[key]) && Number(object[key]) > 0) return Number(object[key]);
  return undefined;
}

function parseCatalogModel(value: JsonValue): GrokCatalogModel | null {
  if (!isJsonObject(value)) return null;
  const id = modelText(value, "model", "modelId", "id");
  if (!id || id.length > 256) return null;
  const backend = modelText(value, "apiBackend", "api_backend");
  if (backend && backend !== "responses") return null;
  const effortRows = Array.isArray(value.reasoningEfforts) ? value.reasoningEfforts
    : Array.isArray(value.reasoning_efforts) ? value.reasoning_efforts
      : [];
  const efforts = effortRows.flatMap((row): Array<{ effort: string; description: string; isDefault: boolean }> => {
    if (!isJsonObject(row)) return [];
    const effort = modelText(row, "value", "effort");
    if (!effort) return [];
    return [{
      effort,
      description: modelText(row, "description", "label") ?? "",
      isDefault: row.default === true,
    }];
  });
  const modalities = Array.isArray(value.input_modalities) ? value.input_modalities : [];
  return {
    id,
    label: modelText(value, "name") ?? id,
    description: modelText(value, "description"),
    contextWindow: modelNumber(value, "contextWindow", "context_window"),
    defaultEffort: efforts.find((item) => item.isDefault)?.effort ?? modelText(value, "reasoningEffort", "reasoning_effort"),
    efforts: efforts.length ? efforts.map(({ effort, description }) => ({ effort, description })) : undefined,
    vision: value.supportsImageIn === true || value.supports_image_in === true || modalities.includes("image"),
  };
}

/** Load the account-visible Responses catalog; retry once after a rejected bearer. */
export async function listGrokCatalog(model: string, fetchImpl: typeof fetch = fetch): Promise<GrokCatalogModel[]> {
  const request = async (force: boolean, rejectedToken?: string): Promise<{ response: Response; token: string }> => {
    const token = await validGrokAccessToken({ fetchImpl, force, rejectedToken });
    const response = await fetchImpl(`${GROK_PROXY_BASE_URL}/models`, {
      headers: {
        ...grokProxyHeaders(model),
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": `neko-core/${VERSION}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    return { response, token };
  };
  let attempt = await request(false);
  if (attempt.response.status === 401) attempt = await request(true, attempt.token);
  const response = attempt.response;
  const parsed = await boundedJson(response, "Grok model catalog");
  if (!response.ok) throw oauthError("Grok model catalog failed", response, isJsonObject(parsed) ? parsed : {});
  if (!isJsonObject(parsed) || !Array.isArray(parsed.data)) throw new Error("Grok returned no usable model catalog.");
  const seen = new Set<string>();
  return parsed.data.flatMap((value) => {
    const modelEntry = parseCatalogModel(value);
    if (!modelEntry || seen.has(modelEntry.id)) return [];
    seen.add(modelEntry.id);
    return [modelEntry];
  });
}
