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
    return { client, type: made.type };
  }

  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    for (const [name, cfg] of Object.entries(servers ?? {})) {
      try {
        this.configs.set(name, cfg);
        const { client, type } = await this.makeClient(name, cfg);
        const res: any = await client.listTools();
        let tools = 0;
        for (const tool of res.tools ?? []) {
          if (!this.allowed(name, tool.name)) continue; // mcp_allow/mcp_deny filter
          const prefixed = `mcp__${name}__${tool.name}`;
          this.toolMap.set(prefixed, { server: name, tool: tool.name });
          this.specs.push({
            type: "function",
            function: {
              name: prefixed,
              description: tool.description ?? "",
              parameters: tool.inputSchema ?? { type: "object", properties: {} },
            },
          });
          tools++;
        }
        // Resources are part of full MCP: expose a synthetic read_resource tool the agent can use.
        let resourceList: any[] = [];
        try { resourceList = ((await client.listResources()) as any).resources ?? []; } catch { /* unsupported */ }
        if (resourceList.length) {
          const rt = `mcp__${name}__read_resource`;
          this.resourceTools.set(rt, name);
          this.specs.push({
            type: "function",
            function: {
              name: rt,
              description: `Read a resource from MCP server '${name}'. Available URIs: ${resourceList.slice(0, 25).map((r: any) => r.uri).join(", ")}`,
              parameters: { type: "object", properties: { uri: { type: "string", description: "The resource URI to read." } }, required: ["uri"] },
            },
          });
        }
        let promptNames: string[] = [];
        try { promptNames = (((await client.listPrompts()) as any).prompts ?? []).map((p: any) => p.name); } catch { /* unsupported */ }
        if (promptNames.length) this.prompts.set(name, promptNames);
        this.meta.set(name, { type, tools, resources: resourceList.length, prompts: promptNames.length });
        this.clients.set(name, client);
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
      const client = this.clients.get(resourceServer)!;
      try {
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
    const client = this.clients.get(server)!;
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
    const client = this.clients.get(server);
    if (!client) return `Error: no MCP server '${server}'`;
    try {
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
