import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpTools } from "../core/ports.ts";
import { homeDir } from "../shared/home.ts";

export const NEKO_BROWSER_EXTENSION_ID = "koalaflndbcddboachbdfmppdeblldje";
export const NEKO_BROWSER_ORIGIN = `chrome-extension://${NEKO_BROWSER_EXTENSION_ID}`;
export const DEFAULT_BROWSER_BRIDGE_PORT = 8766;
const DISCOVERY_FILE = () => join(homeDir(), ".neko-core", "browser-bridge.json");
const STATUS_FILE = () => join(homeDir(), ".neko-core", "browser-bridge-status.json");

export interface BrowserCapability {
  version: 1;
  host: "127.0.0.1";
  port: number;
  session: string;
  token: string;
}

type SocketData = { authenticated: boolean };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function readBrowserCapability(): BrowserCapability | null {
  try {
    const value = JSON.parse(readFileSync(DISCOVERY_FILE(), "utf8"));
    if (value?.version !== 1 || value.host !== "127.0.0.1" || !Number.isInteger(value.port)
      || typeof value.session !== "string" || typeof value.token !== "string") return null;
    return value as BrowserCapability;
  } catch { return null; }
}

export function ensureBrowserCapability(rotate = false, port = DEFAULT_BROWSER_BRIDGE_PORT): BrowserCapability {
  const current = rotate ? null : readBrowserCapability();
  if (current && current.port === port) return current;
  const capability: BrowserCapability = {
    version: 1,
    host: "127.0.0.1",
    port,
    session: randomUUID(),
    token: randomBytes(32).toString("base64url"),
  };
  mkdirSync(join(homeDir(), ".neko-core"), { recursive: true, mode: 0o700 });
  writeFileSync(DISCOVERY_FILE(), JSON.stringify(capability, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return capability;
}

export function readBrowserBridgeStatus(): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(STATUS_FILE(), "utf8"));
    if (!value || typeof value !== "object") return undefined;
    if (value.online && Date.now() - Number(value.updatedAt ?? 0) > 30_000) return { ...value, online: false, stale: true };
    return value;
  } catch { return undefined; }
}

export type BrowserBridgeStage = "not_configured" | "offline" | "bridge_online" | "extension_connected" | "tab_attached";

/** Report only states Neko can verify; local extension files alone do not mean Chrome installed them. */
export function browserBridgeStage(
  capability: BrowserCapability | null = readBrowserCapability(),
  status: Record<string, unknown> | undefined = readBrowserBridgeStatus(),
): BrowserBridgeStage {
  if (!capability) return "not_configured";
  if (!status?.online) return "offline";
  if (status.attached) return "tab_attached";
  if (status.extensionConnected) return "extension_connected";
  return "bridge_online";
}

const BRIDGE_SCHEMAS = [
  { name: "status", description: "Read the locally attached Neko Browser Bridge tab and permission state.", properties: {} },
  { name: "snapshot", description: "Read a compact visible accessibility snapshot from the explicitly attached tab.", properties: { maxItems: { type: "number", minimum: 1, maximum: 200 } } },
  { name: "watch", description: "Wait inside the attached tab until visible text changes and settles, then return the fresh compact snapshot plus elapsed time. Avoids model-side polling for chat and other live pages.", properties: { durationMs: { type: "number", minimum: 250, maximum: 30000 }, settleMs: { type: "number", minimum: 100, maximum: 2000 }, maxItems: { type: "number", minimum: 1, maximum: 200 } } },
  { name: "click", description: "Click an element reference from the latest Neko browser snapshot.", properties: { ref: { type: "string" }, reason: { type: "string" } }, required: ["ref"] },
  { name: "type", description: "Type text into a non-sensitive element reference. Password, payment, and one-time-code fields are always blocked.", properties: { ref: { type: "string" }, text: { type: "string" }, reason: { type: "string" } }, required: ["ref", "text"] },
  { name: "scroll", description: "Scroll the attached tab by a bounded number of CSS pixels.", properties: { deltaY: { type: "number", minimum: -4000, maximum: 4000 }, reason: { type: "string" } }, required: ["deltaY"] },
  { name: "navigate", description: "Navigate the attached tab to an http(s) URL.", properties: { url: { type: "string" }, reason: { type: "string" } }, required: ["url"] },
  { name: "detach", description: "Emergency-detach Neko from the selected browser tab.", properties: { reason: { type: "string" } } },
].map((tool) => ({
  type: "function",
  function: {
    name: `mcp__neko_browser__${tool.name}`,
    description: tool.description,
    parameters: { type: "object", properties: tool.properties, required: tool.required ?? [], additionalProperties: false },
  },
}));

class BrowserBridgeTools implements McpTools {
  constructor(private readonly capability: BrowserCapability) {}
  toolSchemas(): any[] { return BRIDGE_SCHEMAS; }
  has(name: string): boolean { return BRIDGE_SCHEMAS.some((spec) => spec.function.name === name); }
  permission(name: string): "safe" | "gated" {
    return new Set([
      "mcp__neko_browser__status",
      "mcp__neko_browser__snapshot",
      "mcp__neko_browser__watch",
    ]).has(name) ? "safe" : "gated";
  }
  temporal(name: string): boolean { return name === "mcp__neko_browser__watch"; }
  indexBlock(): string { return "Neko Browser Bridge tools are local-only and control only the tab explicitly attached in the extension."; }
  async call(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const action = name.replace("mcp__neko_browser__", "");
    const requestedDuration = Number(args.durationMs);
    const watchDuration = Number.isFinite(requestedDuration)
      ? Math.max(250, Math.min(30_000, requestedDuration))
      : 10_000;
    const timeoutSignal = AbortSignal.timeout(action === "watch" ? watchDuration + 10_000 : 35_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(`http://${this.capability.host}:${this.capability.port}/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.capability.token}`, "content-type": "application/json" },
      body: JSON.stringify({ action, args }),
      signal: requestSignal,
    }).catch((error) => {
      if (signal?.aborted) throw new Error("Neko Browser Bridge request interrupted");
      if (timeoutSignal.aborted) throw new Error("Neko Browser Bridge request timed out");
      throw new Error(`Neko Browser Bridge is offline: ${(error as Error).message}`);
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `bridge HTTP ${response.status}`);
    return text;
  }
}

class CompositeTools implements McpTools {
  constructor(private readonly sources: McpTools[]) {}
  toolSchemas(): any[] { return this.sources.flatMap((source) => source.toolSchemas()); }
  has(name: string): boolean { return this.sources.some((source) => source.has(name)); }
  permission(name: string): "safe" | "gated" {
    const source = this.sources.find((candidate) => candidate.has(name));
    return source?.permission?.(name) ?? "gated";
  }
  temporal(name: string): boolean {
    const source = this.sources.find((candidate) => candidate.has(name));
    return source?.temporal?.(name) ?? false;
  }
  call(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const source = this.sources.find((candidate) => candidate.has(name));
    if (!source) return Promise.resolve(`Error: unknown external tool ${name}`);
    return source.call(name, args, signal);
  }
  indexBlock(): string { return this.sources.map((source) => source.indexBlock?.() ?? "").filter(Boolean).join("\n"); }
  loadTools(names: string[]): string {
    return this.sources.map((source) => source.loadTools?.(names) ?? "").filter(Boolean).join("\n");
  }
}

/** Add the bridge as another edge tool source only after `neko browser bridge` created its capability. */
export function withBrowserBridge(source?: McpTools): McpTools | undefined {
  const capability = readBrowserCapability();
  if (!capability) return source;
  const bridge = new BrowserBridgeTools(capability);
  return source ? new CompositeTools([source, bridge]) : bridge;
}

export interface BrowserBridge {
  readonly port: number;
  readonly session: string;
  status(): Record<string, unknown>;
  command(action: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/** Start the bridge inside a normal Neko process once the user has opted in by creating a capability. */
export function startManagedBrowserBridge(options: {
  capability?: BrowserCapability | null;
  extensionIds?: string[];
  persistStatus?: boolean;
} = {}): BrowserBridge | null {
  const capability = options.capability === undefined ? readBrowserCapability() : options.capability;
  if (!capability) return null;
  try {
    return startBrowserBridge({
      capability,
      extensionOrigins: (options.extensionIds?.length ? options.extensionIds : [NEKO_BROWSER_EXTENSION_ID])
        .map((id) => `chrome-extension://${id}`),
      persistStatus: options.persistStatus,
    });
  } catch (error) {
    // A dedicated `neko browser bridge` may already own the loopback port. Sharing that authenticated
    // process is expected; every other startup error must remain visible.
    if (/EADDRINUSE|address already in use|port .* in use|Failed to start server/i.test(String(error))) return null;
    throw error;
  }
}

export function startBrowserBridge(options: {
  capability?: BrowserCapability;
  extensionOrigins?: string[];
  /** @deprecated Prefer extensionOrigins; kept for callers that accept exactly one origin. */
  extensionOrigin?: string;
  pairingMs?: number;
  port?: number;
  persistStatus?: boolean;
} = {}): BrowserBridge {
  const capability = options.capability ?? ensureBrowserCapability(false, options.port ?? DEFAULT_BROWSER_BRIDGE_PORT);
  const extensionOrigins = new Set(options.extensionOrigins?.length
    ? options.extensionOrigins
    : [options.extensionOrigin ?? NEKO_BROWSER_ORIGIN]);
  const pairingDeadline = Date.now() + (options.pairingMs ?? 600_000);
  const pending = new Map<string, Pending>();
  const audit: { at: string; action: string; status: string }[] = [];
  let client: Bun.ServerWebSocket<SocketData> | null = null;
  let attached: { tabId: number; host: string; grants: Record<string, boolean> } | null = null;

  const record = (action: string, status: string) => {
    audit.push({ at: new Date().toISOString(), action, status });
    if (audit.length > 200) audit.shift();
  };
  const publicStatus = () => ({
    online: true,
    session: capability.session,
    extensionConnected: !!client,
    attached,
    pairing: !client && Date.now() <= pairingDeadline,
    audit: audit.slice(-20),
  });
  const persistStatus = (online = true) => {
    if (options.persistStatus === false) return;
    const status = publicStatus();
    mkdirSync(join(homeDir(), ".neko-core"), { recursive: true, mode: 0o700 });
    writeFileSync(STATUS_FILE(), JSON.stringify({
      online,
      session: capability.session,
      extensionConnected: status.extensionConnected,
      attached: status.attached,
      updatedAt: Date.now(),
    }), { encoding: "utf8", mode: 0o600 });
  };
  const command = async (action: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (action === "status") return publicStatus();
    if (!client || !attached) throw new Error("no browser tab is attached");
    const id = randomUUID();
    return await new Promise((resolve, reject) => {
      const requestedDuration = Number(args.durationMs);
      const watchDuration = Number.isFinite(requestedDuration)
        ? Math.max(250, Math.min(30_000, requestedDuration))
        : 10_000;
      const timeoutMs = action === "watch" ? watchDuration + 5_000 : 30_000;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`browser command '${action}' timed out`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      client!.send(JSON.stringify({ type: "command", id, action, args }));
      record(action, "sent");
    });
  };

  const server = Bun.serve<SocketData>({
    hostname: capability.host,
    port: capability.port,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") return Response.json(publicStatus());
      if (url.pathname === "/bridge") {
        if (!extensionOrigins.has(req.headers.get("origin") ?? "")) return new Response("forbidden origin", { status: 403 });
        return server.upgrade(req, { data: { authenticated: false } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname !== "/command" || req.method !== "POST") return new Response("not found", { status: 404 });
      const auth = req.headers.get("authorization") ?? "";
      if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), capability.token)) return new Response("unauthorized", { status: 401 });
      if (Number(req.headers.get("content-length") ?? 0) > 65_536) return new Response("body too large", { status: 413 });
      let body: any;
      try { body = await req.json(); } catch { return new Response("invalid JSON", { status: 400 }); }
      if (typeof body?.action !== "string" || !BRIDGE_SCHEMAS.some((spec) => spec.function.name.endsWith(`__${body.action}`))) {
        return new Response("unknown browser action", { status: 400 });
      }
      try { return Response.json(await command(body.action, body.args ?? {})); }
      catch (error) { return new Response((error as Error).message, { status: 409 }); }
    },
    websocket: {
      message(ws, raw) {
        if (typeof raw !== "string" || raw.length > 65_536) return ws.close(1009, "message too large");
        let message: any;
        try { message = JSON.parse(raw); } catch { return ws.close(1003, "invalid JSON"); }
        if (!ws.data.authenticated) {
          const paired = message?.type === "pair" && Date.now() <= pairingDeadline;
          const resumed = message?.type === "hello" && message.session === capability.session && safeEqual(String(message.token ?? ""), capability.token);
          if (!paired && !resumed) return ws.close(1008, "authentication failed");
          ws.data.authenticated = true;
          client?.close(1000, "replaced by a newer Neko browser connection");
          client = ws;
          if (paired) ws.send(JSON.stringify({ type: "paired", session: capability.session, token: capability.token }));
          ws.send(JSON.stringify({ type: "ready", session: capability.session }));
          record("connect", paired ? "paired" : "resumed");
          persistStatus();
          return;
        }
        if (message?.type === "attached" && Number.isInteger(message.tab?.id)) {
          let host = "";
          try { host = new URL(String(message.tab.url ?? "")).host; } catch { /* blank */ }
          attached = { tabId: message.tab.id, host, grants: message.grants ?? {} };
          record("attach", "ok");
          persistStatus();
        } else if (message?.type === "detached") {
          attached = null;
          record("detach", String(message.reason ?? "user"));
          persistStatus();
        } else if (message?.type === "result" && typeof message.id === "string") {
          const call = pending.get(message.id);
          if (!call) return;
          clearTimeout(call.timer);
          pending.delete(message.id);
          record(String(message.action ?? "command"), message.ok ? "ok" : "error");
          message.ok ? call.resolve(message.result) : call.reject(new Error(String(message.error ?? "browser command failed")));
        }
      },
      close(ws) {
        if (client !== ws) return;
        client = null;
        attached = null;
        for (const [id, call] of pending) { clearTimeout(call.timer); call.reject(new Error("browser extension disconnected")); pending.delete(id); }
        record("disconnect", "closed");
        persistStatus();
      },
    },
  });
  persistStatus();
  const heartbeat = setInterval(() => persistStatus(), 10_000);
  (heartbeat as { unref?: () => void }).unref?.();

  return {
    port: server.port ?? capability.port,
    session: capability.session,
    status: publicStatus,
    command,
    close() {
      client?.close(1001, "Neko bridge stopped");
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("browser bridge stopped")); }
      pending.clear();
      clearInterval(heartbeat);
      persistStatus(false);
      server.stop(true);
    },
  };
}

export function browserExtensionPath(root = process.cwd()): string {
  const installed = join(homeDir(), ".neko-core", "browser-extension");
  const candidates = [join(root, "browser-extension"), resolve(import.meta.dir, "..", "..", "browser-extension"), installed];
  return candidates.find((path) => existsSync(path)) ?? installed;
}
