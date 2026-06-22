/**
 * A tiny stdio MCP server used only to verify Neko Code's MCP client end-to-end.
 * Exposes one tool, `echo`, that returns its input prefixed with "echo: ".
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "neko-echo", version: "0.0.0" });

server.tool("echo", "Echo back the given text", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text: `echo: ${text}` }],
}));

await server.connect(new StdioServerTransport());
