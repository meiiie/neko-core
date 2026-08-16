import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

export const PUBLIC_HTTP_MAX_BYTES = 2 * 1024 * 1024;
const PUBLIC_HTTP_MAX_REDIRECTS = 5;

export interface PublicAddress {
  address: string;
  family: 4 | 6;
}

export interface PublicHttpResponse {
  url: string;
  status: number;
  headers: Headers;
  text: string;
}

export type PublicLookup = (hostname: string) => Promise<PublicAddress[]>;

interface HopResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

export type PublicRequest = (
  url: URL,
  address: PublicAddress,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<HopResponse>;

export interface PublicHttpDependencies {
  lookup?: PublicLookup;
  request?: PublicRequest;
}

type PublicUrlValidationOptions = Pick<PublicHttpDependencies, "lookup"> & { signal?: AbortSignal };

// Keep families in separate lists. Bun maps IPv4 input internally, so an IPv6 ::/8 rule in the
// same BlockList would otherwise also match every IPv4 address.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["168.63.129.16", 32], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 8], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blockedV6.addSubnet(network, prefix, "ipv6");

/** True only for routable public IP literals. Unknown and special-purpose addresses fail closed. */
export function isPublicIp(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "").split("%")[0];
  const family = isIP(normalized);
  if (family === 4) return !blockedV4.check(normalized, "ipv4");
  if (family === 6) return publicV6.check(normalized, "ipv6") && !blockedV6.check(normalized, "ipv6");
  return false;
}

function parseHttpUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("invalid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http:// or https://");
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  if (!url.hostname) throw new Error("URL hostname is required");
  return url;
}

const systemLookup: PublicLookup = async (hostname) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  // SAFETY: dns.lookup returns literal 4/6; the union only widens for the call signature.
  return rows.map((row) => ({ address: row.address, family: row.family as 4 | 6 }));
};

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("request aborted");
}

async function waitForLookup<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return onAbort();
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function resolvePublic(url: URL, lookup: PublicLookup, signal?: AbortSignal): Promise<PublicAddress[]> {
  throwIfAborted(signal);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const literalFamily = isIP(hostname);
  const rows = literalFamily
    ? [{ address: hostname, family: /* SAFETY: the literal branch implies the family constant named beside it. */ literalFamily as 4 | 6 }]
    : await waitForLookup(lookup(hostname), signal);
  throwIfAborted(signal);
  if (rows.length === 0) throw new Error(`no address found for ${hostname}`);
  for (const row of rows) {
    if (isIP(row.address) !== row.family || !isPublicIp(row.address)) {
      throw new Error(`blocked non-public address for ${hostname}`);
    }
  }
  return rows;
}

/** Validate a target without fetching it (used before handing a public URL to a hosted reader). */
export async function assertPublicHttpUrl(input: string, options: PublicUrlValidationOptions = {}): Promise<void> {
  const url = parseHttpUrl(input);
  await resolvePublic(url, options.lookup ?? systemLookup, options.signal);
}

/** Collect a response incrementally and refuse it before aggregate allocation can exceed the cap. */
export async function readBoundedBody(
  stream: AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void },
  maxBytes = PUBLIC_HTTP_MAX_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    if (total + chunk.byteLength > maxBytes) {
      const error = new Error(`response body exceeds ${maxBytes} bytes`);
      stream.destroy?.(error);
      throw error;
    }
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    chunks.push(buffer);
    total += buffer.byteLength;
  }
  return Buffer.concat(chunks, total);
}

function parsedContentLength(raw: string | string[] | null | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

/** Read a Fetch Response with the same hard cap as public HTTP, including chunked bodies. */
export async function readBoundedResponseText(response: Response): Promise<string> {
  const length = parsedContentLength(response.headers.get("content-length"));
  if (length !== null && length > PUBLIC_HTTP_MAX_BYTES) {
    const error = new Error(`response body exceeds ${PUBLIC_HTTP_MAX_BYTES} bytes`);
    void response.body?.cancel(error).catch(() => {});
    throw error;
  }
  if (!response.body) return "";
  return (await readBoundedBody(response.body)).toString("utf8");
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

function contentLength(headers: IncomingHttpHeaders): number | null {
  return parsedContentLength(headers["content-length"]);
}

const requestPinned: PublicRequest = (url, address, init) => new Promise((resolve, reject) => {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const request = transport(url, {
    agent: false,
    headers: init.headers,
    lookup,
    maxHeaderSize: 32 * 1024,
    signal: init.signal,
  }, async (response) => {
    try {
      const length = contentLength(response.headers);
      if (length !== null && length > PUBLIC_HTTP_MAX_BYTES) {
        throw new Error(`response body exceeds ${PUBLIC_HTTP_MAX_BYTES} bytes`);
      }
      const body = await readBoundedBody(response);
      resolve({ status: response.statusCode ?? 0, headers: toHeaders(response.headers), body });
    } catch (error) {
      response.destroy();
      reject(error);
    }
  });
  request.on("error", reject);
  request.end();
});

function redirectedHeaders(headers: Record<string, string>, from: URL, to: URL) {
  if (from.origin === to.origin) return headers;
  const next = { ...headers };
  for (const name of Object.keys(next)) {
    if (["authorization", "cookie", "proxy-authorization"].includes(name.toLowerCase())) delete next[name];
  }
  return next;
}

/** GET a public HTTP(S) resource. Every redirect is re-resolved, validated, and pinned to that IP. */
export async function publicHttpFetch(
  input: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  dependencies: PublicHttpDependencies = {},
): Promise<PublicHttpResponse> {
  const lookup = dependencies.lookup ?? systemLookup;
  const request = dependencies.request ?? requestPinned;
  let url = parseHttpUrl(input);
  let headers = { ...(init.headers ?? {}) };

  for (let redirects = 0; ; redirects++) {
    const addresses = await resolvePublic(url, lookup, init.signal);
    let response: HopResponse | undefined;
    let lastError: unknown;
    for (const address of addresses) {
      try {
        response = await request(url, address, { headers, signal: init.signal });
        break;
      } catch (error) {
        throwIfAborted(init.signal);
        lastError = error;
      }
    }
    if (!response) throw lastError ?? new Error(`could not connect to ${url.hostname}`);
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      return {
        url: url.href,
        status: response.status,
        headers: response.headers,
        text: response.body.toString("utf8"),
      };
    }
    if (redirects >= PUBLIC_HTTP_MAX_REDIRECTS) throw new Error("too many redirects");
    const next = parseHttpUrl(new URL(location, url).href);
    headers = redirectedHeaders(headers, url, next);
    url = next;
  }
}
