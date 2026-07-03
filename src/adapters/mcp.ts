/**
 * MCP (Model Context Protocol) client — the extensibility surface. Connects to MCP servers
 * declared in config (`mcp_servers`), lists their tools, and exposes them to the agent loop
 * as `mcp__<server>__<tool>`. Safe by default: with no servers configured, this is a no-op
 * and spawns nothing.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";
import { VERSION } from "../shared/version.ts";
import { connectWithOAuth } from "./mcp-oauth.ts";

/** A local (stdio: command+args) or remote (url: http/sse) MCP server. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "stdio" | "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  oauth?: boolean; // interactive OAuth login for a protected remote server
}

function makeTransport(cfg: McpServerConfig): { transport: any; type: string } {
  if (cfg.url) {
    const url = new URL(cfg.url);
    const init = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
    return cfg.type === "sse"
      ? { transport: new SSEClientTransport(url, init), type: "sse" }
      : { transport: new StreamableHTTPClientTransport(url, init), type: "http" };
  }
  return {
    transport: new StdioClientTransport({
      command: cfg.command ?? "",
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
      stderr: "ignore", // keep MCP servers' banners/logs (e.g. RiveMCP trial notice) off the TUI
    }),
    type: "stdio",
  };
}

/** A hung MCP server (stdio command that never speaks, unresponsive URL) must not block Neko's startup
 *  forever. Bound each connect; on timeout the server is skipped with an error instead of hanging the loop. */
const MCP_CONNECT_TIMEOUT_MS = 15_000;
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

/** Spec cache: tool schemas/resources/prompts per server-config, so a hub can register a server's
 * tools WITHOUT spawning it (lazy-CONNECT — measured 2026-07-03: the browser MCP costs ~277MB RAM +
 * spawn latency on EVERY run even when no browser tool is ever called). Keyed by name+config hash, so
 * any config change is a clean miss; entries refresh on every real connect. */
const SPEC_CACHE_FILE = () => join(homeDir(), ".neko-core", "mcp-specs.json");
type SpecCacheEntry = { specs: any[]; resourceSpecs: any[]; prompts: string[]; meta: { type: string; tools: number; resources: number; prompts: number } };
function specCacheKey(name: string, cfg: McpServerConfig): string {
  return `${name}:${createHash("sha1").update(JSON.stringify(cfg)).digest("hex").slice(0, 16)}`;
}
function readSpecCache(): Record<string, SpecCacheEntry> {
  try {
    const data = JSON.parse(readFileSync(SPEC_CACHE_FILE(), "utf-8"));
    return data.v === 1 ? (data.servers ?? {}) : {};
  } catch { return {}; }
}
function writeSpecCacheEntry(key: string, entry: SpecCacheEntry): void {
  try {
    const servers = readSpecCache();
    servers[key] = entry;
    mkdirSync(join(homeDir(), ".neko-core"), { recursive: true });
    atomicWriteFileSync(SPEC_CACHE_FILE(), JSON.stringify({ v: 1, servers }));
  } catch { /* a cache write failure must never break MCP */ }
}

/** The synthetic meta-tool exposed in lazy mode so the model can pull tool schemas on demand. */
const MCP_LOAD_SPEC = {
  type: "function",
  function: {
    name: "mcp_load",
    description: "Load MCP tools by name so you can call them. The available MCP tools (names + one-line descriptions) are listed in your context under 'MCP tools'. Pass the exact names you need; their schemas are returned and the tools become callable.",
    parameters: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" }, description: "MCP tool names to load, e.g. mcp__server__tool." } },
      required: ["names"],
    },
  },
};

export class McpHub {
  /** Lazy mode: don't put every MCP tool schema in context — list names only, load on demand. */
  lazy = false;
  private loaded = new Set<string>();
  private clients = new Map<string, Client>();
  private toolMap = new Map<string, { server: string; tool: string }>();
  private specs: any[] = [];
  private meta = new Map<string, { type: string; tools: number; resources: number; prompts: number }>();
  private resourceTools = new Map<string, string>(); // synthetic mcp__<server>__read_resource -> server
  private prompts = new Map<string, string[]>(); // server -> prompt names
  private configs = new Map<string, McpServerConfig>(); // kept so a dead server can be reconnected
  private transports = new Map<string, any>(); // stdio transports kept for pid -> tree-kill on close
  constructor(private filter: { allow?: string[]; deny?: string[] } = {}) {}

  /** Tool passes the allow/deny filters (patterns match server / tool / "server__tool" / "*"). */
  private allowed(server: string, tool: string): boolean {
    const m = (p: string) => p === "*" || p === server || p === tool || p === `${server}__${tool}` || p === `mcp__${server}__${tool}`;
    const allow = this.filter.allow ?? [];
    const deny = this.filter.deny ?? [];
    if (allow.length && !allow.some(m)) return false;
    return !deny.some(m);
  }

  /** Create + connect one client (oauth or transport). Shared by connectAll and reconnect. */
  private async makeClient(name: string, cfg: McpServerConfig): Promise<{ client: Client; type: string }> {
    const client = new Client({ name: "neko-code", version: VERSION }, { capabilities: {} });
    if (cfg.oauth && cfg.url) {
      await connectWithOAuth(client, name, cfg.url);
      return { client, type: "http+oauth" };
    }
    const made = makeTransport(cfg);
    await client.connect(made.transport);
    this.transports.set(name, made.transport); // kept for pid -> tree-kill on close
    return { client, type: made.type };
  }

  /** Register a server's tool surface WITHOUT spawning it (specs from the cache). The first actual
   * tool call / resource read / prompt get connects on demand via ensureClient(). */
  private registerFromCache(name: string, entry: SpecCacheEntry): void {
    for (const spec of entry.specs) {
      const prefixed = String(spec.function?.name ?? "");
      const bare = prefixed.replace(`mcp__${name}__`, "");
      if (!this.allowed(name, bare)) continue;
      this.toolMap.set(prefixed, { server: name, tool: bare });
      this.specs.push(spec);
    }
    for (const spec of entry.resourceSpecs) {
      this.resourceTools.set(String(spec.function?.name ?? ""), name);
      this.specs.push(spec);
    }
    if (entry.prompts.length) this.prompts.set(name, entry.prompts);
    this.meta.set(name, { ...entry.meta, type: `${entry.meta.type} (cached, connects on first use)` });
  }

  /** Connect ONE server and (re)build its registered surface from the LIVE server; refresh the cache. */
  private async connectOne(name: string): Promise<Client> {
    const cfg = this.configs.get(name);
    if (!cfg) throw new Error(`no MCP server '${name}' configured`);
    // Drop any cache-registered entries for this server; the live listing below replaces them.
    this.specs = this.specs.filter((s) => !String(s.function?.name ?? "").startsWith(`mcp__${name}__`));
    for (const key of [...this.toolMap.keys()]) if (this.toolMap.get(key)!.server === name) this.toolMap.delete(key);
    for (const key of [...this.resourceTools.keys()]) if (this.resourceTools.get(key) === name) this.resourceTools.delete(key);

    // OAuth is user-paced (browser authorize) so it must NOT be timed out; everything else is bounded.
    const connect = this.makeClient(name, cfg);
    const { client, type } = cfg.oauth ? await connect : await withTimeout(connect, MCP_CONNECT_TIMEOUT_MS, `MCP '${name}' connect`);
    const res: any = await withTimeout(client.listTools(), MCP_CONNECT_TIMEOUT_MS, `MCP '${name}' listTools`);
    const cachedSpecs: any[] = [];
    let tools = 0;
    for (const tool of res.tools ?? []) {
      const prefixed = `mcp__${name}__${tool.name}`;
      const spec = {
        type: "function",
        function: {
          name: prefixed,
          description: tool.description ?? "",
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      };
      cachedSpecs.push(spec); // cache the FULL surface; allow/deny filters apply per-hub below
      if (!this.allowed(name, tool.name)) continue; // mcp_allow/mcp_deny filter
      this.toolMap.set(prefixed, { server: name, tool: tool.name });
      this.specs.push(spec);
      tools++;
    }
    // Resources are part of full MCP: expose a synthetic read_resource tool the agent can use.
    let resourceList: any[] = [];
    try { resourceList = ((await client.listResources()) as any).resources ?? []; } catch { /* unsupported */ }
    const resourceSpecs: any[] = [];
    if (resourceList.length) {
      const rt = `mcp__${name}__read_resource`;
      const spec = {
        type: "function",
        function: {
          name: rt,
          description: `Read a resource from MCP server '${name}'. Available URIs: ${resourceList.slice(0, 25).map((r: any) => r.uri).join(", ")}`,
          parameters: { type: "object", properties: { uri: { type: "string", description: "The resource URI to read." } }, required: ["uri"] },
        },
      };
      resourceSpecs.push(spec);
      this.resourceTools.set(rt, name);
      this.specs.push(spec);
    }
    let promptNames: string[] = [];
    try { promptNames = (((await client.listPrompts()) as any).prompts ?? []).map((p: any) => p.name); } catch { /* unsupported */ }
    if (promptNames.length) this.prompts.set(name, promptNames);
    const meta = { type, tools, resources: resourceList.length, prompts: promptNames.length };
    this.meta.set(name, meta);
    this.clients.set(name, client);
    writeSpecCacheEntry(specCacheKey(name, cfg), { specs: cachedSpecs, resourceSpecs, prompts: promptNames, meta });
    return client;
  }

  /** The connected client for a server, connecting ON DEMAND if it was registered from the cache. */
  private async ensureClient(name: string): Promise<Client> {
    return this.clients.get(name) ?? (await this.connectOne(name));
  }

  /** Connect every still-pending (cache-registered) server — for diagnostics (`neko mcp`, doctor)
   * that must report the REAL live surface, not the cached one. */
  async connectPending(): Promise<void> {
    for (const name of this.configs.keys()) {
      if (this.clients.has(name)) continue;
      try { await this.connectOne(name); } catch (error) {
        console.error(`neko: MCP server '${name}' failed to connect: ${(error as Error).message}`);
      }
    }
  }

  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    const cache = readSpecCache();
    for (const [name, cfg] of Object.entries(servers ?? {})) {
      try {
        this.configs.set(name, cfg);
        const hit = cache[specCacheKey(name, cfg)];
        // Cache hit -> register the tool surface WITHOUT spawning the server (lazy-CONNECT: no
        // process, no RAM, no startup latency until a tool is actually called). Miss (first run
        // with this config) -> connect eagerly, which also writes the cache for next time.
        if (hit) this.registerFromCache(name, hit);
        else await this.connectOne(name);
      } catch (error) {
        console.error(`neko: MCP server '${name}' failed to connect: ${(error as Error).message}`);
      }
    }
  }

  get serverNames(): string[] {
    return [...this.clients.keys()];
  }

  serverInfo(name: string): { type: string; tools: number; resources: number; prompts: number } | undefined {
    return this.meta.get(name);
  }

  toolSchemas(): any[] {
    if (!this.lazy) return this.specs;
    // Lazy: expose only the loader meta-tool + whatever's been loaded this session.
    return [MCP_LOAD_SPEC, ...this.specs.filter((s) => this.loaded.has(s.function.name))];
  }

  /** Lazy-mode context block: list all MCP tool names + one-line descriptions (cheap), so the model
   * knows what it can `mcp_load`. "" when not lazy (full schemas are already in the tool list). */
  indexBlock(): string {
    if (!this.lazy || !this.specs.length) return "";
    const lines = this.specs.map((s) => `  ${s.function.name} - ${String(s.function.description ?? "").split("\n")[0].slice(0, 100)}`);
    return `MCP tools (lazy: call mcp_load with the names you need, then call them):\n${lines.join("\n")}`;
  }

  /** Load tool schemas on demand (lazy mode). Returns their schemas so the model learns the args. */
  loadTools(names: string[]): string {
    const loaded: any[] = [];
    for (const n of names) {
      const spec = this.specs.find((s) => s.function.name === n);
      if (spec) { this.loaded.add(n); loaded.push(spec); }
    }
    if (!loaded.length) return `No matching MCP tools for: ${names.join(", ") || "(none)"}. Check the names in the 'MCP tools' list in your context.`;
    return `Loaded ${loaded.length} MCP tool(s) - now callable:\n` +
      loaded.map((s) => `${s.function.name}: ${JSON.stringify(s.function.parameters)}`).join("\n");
  }

  toolNames(): string[] {
    return [...this.toolMap.keys(), ...this.resourceTools.keys()];
  }

  has(name: string): boolean {
    return this.toolMap.has(name) || this.resourceTools.has(name);
  }

  async call(name: string, args: Record<string, any>): Promise<string> {
    // Synthetic resource reader (mcp__<server>__read_resource).
    const resourceServer = this.resourceTools.get(name);
    if (resourceServer) {
      try {
        const client = await this.ensureClient(resourceServer);
        const res: any = await client.readResource({ uri: String(args.uri ?? "") });
        const parts = (res.contents ?? []).map((c: any) => (c?.text != null ? c.text : c?.uri ?? JSON.stringify(c)));
        return parts.join("\n") || "(empty resource)";
      } catch (error) {
        return `Error reading resource: ${(error as Error).message}`;
      }
    }
    const ref = this.toolMap.get(name);
    if (!ref) return `Error: unknown MCP tool ${name}`;
    try {
      return await this.invoke(ref.server, ref.tool, args);
    } catch (error) {
      // The server may have died; reconnect once from its stored config and retry.
      const cfg = this.configs.get(ref.server);
      if (!cfg) return `Error: ${(error as Error).message}`;
      try {
        const { client } = await this.makeClient(ref.server, cfg);
        this.clients.set(ref.server, client);
        return await this.invoke(ref.server, ref.tool, args);
      } catch (retry) {
        return `Error: ${ref.server} unavailable (reconnect failed): ${(retry as Error).message}`;
      }
    }
  }

  private async invoke(server: string, tool: string, args: Record<string, any>): Promise<string> {
    const client = await this.ensureClient(server); // connects on demand when registered from cache
    const res: any = await client.callTool({ name: tool, arguments: args });
    const parts = (res.content ?? []).map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c)));
    return parts.join("\n") || "(no content)";
  }

  promptList(): { server: string; name: string }[] {
    const out: { server: string; name: string }[] = [];
    for (const [server, names] of this.prompts) for (const name of names) out.push({ server, name });
    return out;
  }

  async getPrompt(server: string, name: string, args: Record<string, any>): Promise<string> {
    if (!this.configs.has(server)) return `Error: no MCP server '${server}'`;
    try {
      const client = await this.ensureClient(server);
      const res: any = await client.getPrompt({ name, arguments: args });
      return (res.messages ?? [])
        .map((m: any) => (typeof m.content === "string" ? m.content : m.content?.text ?? JSON.stringify(m.content)))
        .join("\n\n");
    } catch (error) {
      return `Error getting prompt: ${(error as Error).message}`;
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
    // Belt-and-braces: SDK close kills its DIRECT child, but a launcher chain (bunx -> node) can
    // orphan the grandchild on Windows (observed live: 28 leaked `node mcp/server` processes
    // saturating the machine). Kill the whole tree by pid so no run can leak servers.
    for (const t of this.transports.values()) {
      const pid = t?.pid;
      if (!pid) continue;
      try {
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5000 });
        else process.kill(pid, "SIGKILL");
      } catch { /* already gone */ }
    }
    this.transports.clear();
    this.clients.clear();
  }
}

/** Above this many connected MCP tools, default to lazy loading so the context isn't flooded. */
const LAZY_TOOL_THRESHOLD = 30;

export async function buildMcpHub(
  servers: Record<string, McpServerConfig>,
  filter: { allow?: string[]; deny?: string[] } = {},
  lazy?: boolean,
): Promise<McpHub> {
  const hub = new McpHub(filter);
  await hub.connectAll(servers);
  // Lazy when explicitly enabled in config, else auto when many tools would otherwise bloat context.
  hub.lazy = lazy ?? hub.toolNames().length > LAZY_TOOL_THRESHOLD;
  return hub;
}

export function renderMcp(hub: McpHub): string {
  if (!hub.serverNames.length) {
    return "No MCP servers connected.";
  }
  const lines = [`Neko Code MCP — ${hub.serverNames.length} server(s):`];
  for (const name of hub.serverNames) {
    const m = hub.serverInfo(name);
    lines.push(`  ${name} [${m?.type ?? "?"}] — ${m?.tools ?? 0} tools, ${m?.resources ?? 0} resources, ${m?.prompts ?? 0} prompts`);
  }
  lines.push("Tools:");
  for (const name of hub.toolNames()) lines.push(`  ${name}`);
  const prompts = hub.promptList();
  if (prompts.length) {
    lines.push("Prompts:");
    for (const p of prompts) lines.push(`  ${p.server}:${p.name}`);
  }
  return lines.join("\n");
}
