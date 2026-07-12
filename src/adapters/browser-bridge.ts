import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const BRIDGE_SCHEMAS = [
  { name: "status", description: "Read the locally attached Neko Browser Bridge tab and permission state.", properties: {} },
  { name: "snapshot", description: "Read a compact visible accessibility snapshot from the explicitly attached tab.", properties: { maxItems: { type: "number", minimum: 1, maximum: 200 } } },
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
  indexBlock(): string { return "Neko Browser Bridge tools are local-only and control only the tab explicitly attached in the extension."; }
  async call(name: string, args: Record<string, any>): Promise<string> {
    const action = name.replace("mcp__neko_browser__", "");
    const response = await fetch(`http://${this.capability.host}:${this.capability.port}/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.capability.token}`, "content-type": "application/json" },
      body: JSON.stringify({ action, args }),
      signal: AbortSignal.timeout(35_000),
    }).catch((error) => { throw new Error(`Neko Browser Bridge is offline: ${(error as Error).message}`); });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `bridge HTTP ${response.status}`);
    return text;
  }
}

class CompositeTools implements McpTools {
  constructor(private readonly sources: McpTools[]) {}
  toolSchemas(): any[] { return this.sources.flatMap((source) => source.toolSchemas()); }
  has(name: string): boolean { return this.sources.some((source) => source.has(name)); }
  call(name: string, args: Record<string, any>): Promise<string> {
    const source = this.sources.find((candidate) => candidate.has(name));
    if (!source) return Promise.resolve(`Error: unknown external tool ${name}`);
    return source.call(name, args);
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
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`browser command '${action}' timed out`)); }, 30_000);
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
  const path = join(root, "browser-extension");
  return existsSync(path) ? path : "browser-extension";
}
