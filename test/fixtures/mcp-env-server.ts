/** MCP fixture that reports only env presence, never values. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "env-test", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "env_status",
    description: "Reports whether named environment variables exist, without returning their values.",
    inputSchema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" } } },
      required: ["names"],
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const names = Array.isArray(request.params.arguments?.names)
    ? request.params.arguments.names.map(String)
    : [];
  return {
    content: [{
      type: "text",
      text: JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] !== undefined]))),
    }],
  };
});

await server.connect(new StdioServerTransport());
