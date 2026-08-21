/** Bounded host-network diagnostics. This deliberately does not execute a shell: it gives an agent
 * DNS/TCP reachability when Bash egress is sandboxed without granting arbitrary host execution. */
import { lookup } from "node:dns/promises";
import { createConnection, isIP } from "node:net";
import { domainToASCII } from "node:url";

const MAX_PORTS = 16;
const MAX_ADDRESSES = 4;
const DEFAULT_TIMEOUT_MS = 1_500;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5_000;

type Address = { address: string; family: number };

function targetName(value: any): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("network_probe needs a target hostname or IP address");
  if (raw.length > 253 || /[\s\x00-\x1f\x7f/\\@?#]/.test(raw) || raw.includes("://")) {
    throw new Error("target must be one hostname or IP address, without a URL scheme, path, or credentials");
  }
  const unwrapped = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (isIP(unwrapped)) return unwrapped;
  const ascii = domainToASCII(unwrapped).toLowerCase();
  if (!ascii || ascii.length > 253 || ascii === "*" || ascii.split(".").some((label) =>
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error("target is not a valid hostname or IP address");
  }
  return ascii;
}

function probePorts(value: any): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("network_probe needs a non-empty ports array");
  }
  if (value.length > MAX_PORTS) throw new Error(`network_probe accepts at most ${MAX_PORTS} ports per call`);
  const ports = value.map(Number);
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error("ports must be integers from 1 through 65535");
  }
  return [...new Set(ports)];
}

function probeTimeout(value: any): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be an integer from ${MIN_TIMEOUT_MS} through ${MAX_TIMEOUT_MS}`);
  }
  return timeout;
}

async function resolveBounded(target: string, timeoutMs: number, signal?: AbortSignal): Promise<Address[]> {
  if (signal?.aborted) return [];
  return new Promise<Address[]>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, addresses?: Address[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(addresses ?? []);
    };
    const onAbort = () => finish();
    const timer = setTimeout(() => finish(new Error(`DNS lookup timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    lookup(target, { all: true, verbatim: true }).then(
      (addresses) => finish(undefined, addresses),
      (error: NodeJS.ErrnoException) => finish(new Error(`DNS lookup failed (${error.code ?? "unknown"})`)),
    );
  });
}

function connectStatus(address: Address, port: number, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket: ReturnType<typeof createConnection> | undefined;
    const finish = (status: string) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket?.destroy();
      resolve(`${address.address}:${port} ${status} (${Date.now() - started}ms)`);
    };
    const onAbort = () => finish("interrupted");
    if (signal?.aborted) return finish("interrupted");
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      socket = createConnection({ host: address.address, port, family: address.family });
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish("open"));
      socket.once("timeout", () => finish("timeout"));
      socket.once("error", (error: NodeJS.ErrnoException) => {
        const status = error.code === "ECONNREFUSED" ? "closed"
          : error.code === "ENETUNREACH" || error.code === "EHOSTUNREACH" || error.code === "EADDRNOTAVAIL" ? "unreachable"
          : `error(${error.code ?? "unknown"})`;
        finish(status);
      });
    } catch (error) {
      // SAFETY: synchronous failures from node:net createConnection use Node's errno Error shape.
      finish(`error(${(error as NodeJS.ErrnoException).code ?? "unknown"})`);
    }
  });
}

export async function runNetworkProbe(args: any, signal?: AbortSignal): Promise<string> {
  const target = targetName(args?.target);
  const ports = probePorts(args?.ports);
  const timeoutMs = probeTimeout(args?.timeout_ms);
  const addresses = (await resolveBounded(target, timeoutMs, signal))
    .filter((entry, index, all) => all.findIndex((other) => other.address === entry.address) === index)
    .slice(0, MAX_ADDRESSES);
  if (signal?.aborted) return "(interrupted)";
  if (!addresses.length) return `Network probe target=${target}\nresolved: none`;
  const results = await Promise.all(addresses.flatMap((address) =>
    ports.map((port) => connectStatus(address, port, timeoutMs, signal))));
  if (signal?.aborted) return "(interrupted)";
  return [
    `Network probe target=${target}`,
    `resolved: ${addresses.map((entry) => entry.address).join(", ")}`,
    ...results.map((result) => `- ${result}`),
  ].join("\n");
}
