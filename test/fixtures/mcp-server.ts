/** A tiny stdio MCP server with 3 tools — a fixture for the lazy-loading test. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "toolA", description: "does A", inputSchema: { type: "object", properties: { x: { type: "string" } } } },
    { name: "toolB", description: "does B", inputSchema: { type: "object", properties: {} } },
    { name: "toolC", description: "does C", inputSchema: { type: "object", properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: `ran ${req.params.name}` }],
}));

await server.connect(new StdioServerTransport());
