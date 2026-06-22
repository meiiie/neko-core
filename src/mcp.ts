/**
 * MCP (Model Context Protocol) client — the extensibility surface. Connects to MCP servers
 * declared in config (`mcp_servers`), lists their tools, and exposes them to the agent loop
 * as `mcp__<server>__<tool>`. Safe by default: with no servers configured, this is a no-op
 * and spawns nothing.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { VERSION } from "./version.ts";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class McpHub {
  private clients = new Map<string, Client>();
  private toolMap = new Map<string, { server: string; tool: string }>();
  private specs: any[] = [];

  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    for (const [name, cfg] of Object.entries(servers ?? {})) {
      try {
        const client = new Client({ name: "neko-code", version: VERSION }, { capabilities: {} });
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
        });
        await client.connect(transport);
        const res: any = await client.listTools();
        for (const tool of res.tools ?? []) {
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
        }
        this.clients.set(name, client);
      } catch (error) {
        console.error(`neko: MCP server '${name}' failed to connect: ${(error as Error).message}`);
      }
    }
  }

  get serverNames(): string[] {
    return [...this.clients.keys()];
  }

  toolSchemas(): any[] {
    return this.specs;
  }

  toolNames(): string[] {
    return [...this.toolMap.keys()];
  }

  has(name: string): boolean {
    return this.toolMap.has(name);
  }

  async call(name: string, args: Record<string, any>): Promise<string> {
    const ref = this.toolMap.get(name);
    if (!ref) return `Error: unknown MCP tool ${name}`;
    const client = this.clients.get(ref.server)!;
    const res: any = await client.callTool({ name: ref.tool, arguments: args });
    const parts = (res.content ?? []).map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c)));
    return parts.join("\n") || "(no content)";
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

export async function buildMcpHub(servers: Record<string, McpServerConfig>): Promise<McpHub> {
  const hub = new McpHub();
  await hub.connectAll(servers);
  return hub;
}

export function renderMcp(hub: McpHub): string {
  if (!hub.serverNames.length) {
    return "No MCP servers connected.";
  }
  const lines = [`Neko Code MCP — ${hub.serverNames.length} server(s): ${hub.serverNames.join(", ")}`, "Tools:"];
  for (const name of hub.toolNames()) lines.push(`  ${name}`);
  return lines.join("\n");
}
