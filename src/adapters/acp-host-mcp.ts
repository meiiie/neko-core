/** A deliberately small MCP client carried over the existing ACP connection.
 *
 * Unlike configured MCP, this adapter never starts a process and never accepts a URL. The launch
 * authorized host profile is the authority ceiling; the ACP client merely supplies an in-band
 * implementation of that exact surface for one session.
 */
import * as acp from "@agentclientprotocol/sdk";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

import type { McpTools } from "../core/ports.ts";
import { isJsonObject, isText, type JsonObject, type JsonValue } from "../shared/wire.ts";
import { hostToolName, type HostCapabilityProfile } from "./host-profile.ts";

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOL_PAGES = 8;
const MAX_TOOL_SCHEMA_BYTES = 256 * 1024;

function cancellationSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

interface HostToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
  };
}

function objectResult(value: JsonValue, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${label} returned an invalid response`);
  return value;
}

function contentText(result: JsonObject): string {
  const parts = Array.isArray(result.content) ? result.content.map((part: JsonValue) => {
    if (isJsonObject(part) && part.type === "text" && isText(part.text)) return part.text;
    try { return JSON.stringify(part) ?? String(part); } catch { return String(part); }
  }) : [];
  const text = parts.filter(Boolean).join("\n") || "(no content)";
  return result.isError === true && !/^Error(?:\s|:|$)/i.test(text.trimStart()) ? `Error: ${text}` : text;
}

export class AcpHostMcp implements McpTools {
  private readonly specs: HostToolSchema[] = [];
  private readonly rawNames = new Map<string, string>();
  private closed = false;

  private constructor(
    private readonly profile: HostCapabilityProfile,
    private readonly client: acp.AgentContext,
    private readonly connectionId: string,
    tools: JsonObject[],
  ) {
    const declared = new Map(profile.tools.map((tool) => [tool.name, tool]));
    for (const tool of tools) {
      const rawName = isText(tool?.name) ? tool.name : "";
      if (!declared.has(rawName)) continue;
      const name = hostToolName(profile, rawName);
      this.rawNames.set(name, rawName);
      this.specs.push({
        type: "function",
        function: {
          name,
          description: isText(tool.description) ? tool.description : "",
          parameters: isJsonObject(tool.inputSchema)
            ? tool.inputSchema
            : { type: "object", properties: {}, additionalProperties: false },
        },
      });
    }
    const missing = profile.tools.filter((tool) => !this.rawNames.has(hostToolName(profile, tool.name)));
    if (missing.length) throw new Error(`host MCP is missing required tools: ${missing.map((tool) => tool.name).join(", ")}`);
  }

  static async connect(
    profile: HostCapabilityProfile,
    client: acp.AgentContext,
    server: acp.McpServerAcp & { type: "acp" },
  ): Promise<AcpHostMcp> {
    const connected = objectResult(await client.request<JsonValue>("mcp/connect", {
      serverId: server.serverId,
    }, { cancellationSignal: cancellationSignal(undefined, CONNECT_TIMEOUT_MS) }), "mcp/connect");
    if (!isText(connected.connectionId) || !connected.connectionId) {
      throw new Error("mcp/connect did not return a connectionId");
    }
    const connectionId = connected.connectionId;
    try {
      const initialized = objectResult(await client.request<JsonValue>("mcp/message", {
        connectionId,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "neko-core", version: "1" },
        },
      }, { cancellationSignal: cancellationSignal(undefined, CONNECT_TIMEOUT_MS) }), "MCP initialize");
      if (!isText(initialized.protocolVersion) || !SUPPORTED_PROTOCOL_VERSIONS.includes(initialized.protocolVersion)) {
        throw new Error(`host MCP selected unsupported protocol '${String(initialized.protocolVersion ?? "")}'`);
      }
      await client.notify("mcp/message", {
        connectionId,
        method: "notifications/initialized",
        params: {},
      });

      const tools: JsonObject[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const listed = objectResult(await client.request<JsonValue>("mcp/message", {
          connectionId,
          method: "tools/list",
          params: cursor ? { cursor } : {},
        }, { cancellationSignal: cancellationSignal(undefined, CONNECT_TIMEOUT_MS) }), "MCP tools/list");
        if (!Array.isArray(listed.tools)) throw new Error("MCP tools/list returned no tools array");
        for (const tool of listed.tools) {
          if (!isJsonObject(tool)) throw new Error("MCP tools/list returned an invalid tool descriptor");
          tools.push(tool);
        }
        if (Buffer.byteLength(JSON.stringify(tools), "utf8") > MAX_TOOL_SCHEMA_BYTES) {
          throw new Error("host MCP tool surface exceeds 256 KiB");
        }
        cursor = isText(listed.nextCursor) && listed.nextCursor ? listed.nextCursor : undefined;
        if (!cursor) return new AcpHostMcp(profile, client, connectionId, tools);
      }
      throw new Error(`host MCP tools/list exceeded ${MAX_TOOL_PAGES} pages`);
    } catch (error) {
      await client.request("mcp/disconnect", { connectionId }).catch(() => {});
      throw error;
    }
  }

  toolSchemas(): HostToolSchema[] { return this.specs; }

  has(name: string): boolean { return !this.closed && this.rawNames.has(name); }

  permission(name: string): "safe" | "gated" {
    const rawName = this.rawNames.get(name);
    return this.profile.tools.find((tool) => tool.name === rawName)?.permission ?? "gated";
  }

  async call(name: string, args: any, signal?: AbortSignal): Promise<string> {
    const rawName = this.rawNames.get(name);
    if (this.closed || !rawName) return `Error: unknown host MCP tool ${name}`;
    try {
      const result = objectResult(await this.client.request<JsonValue>("mcp/message", {
        connectionId: this.connectionId,
        method: "tools/call",
        params: { name: rawName, arguments: isJsonObject(args) ? args : {} },
      }, { cancellationSignal: cancellationSignal(signal, CALL_TIMEOUT_MS) }), `MCP tool '${rawName}'`);
      return contentText(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error: host MCP call outcome unknown; not retried: ${message}`;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.request("mcp/disconnect", { connectionId: this.connectionId }, {
      cancellationSignal: cancellationSignal(undefined, CONNECT_TIMEOUT_MS),
    }).catch(() => {});
  }
}
