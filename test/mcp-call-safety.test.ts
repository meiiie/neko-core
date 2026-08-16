import { expect, test } from "bun:test";

import { __resolveWindowsTaskkillForTest, McpHub } from "../src/adapters/mcp.ts";

type PrivateHub = {
  toolMap: Map<string, { server: string; tool: string }>;
  resourceTools: Map<string, string>;
  clients: Map<string, any>;
  configs: Map<string, any>;
  makeClient: (server: string, config: any) => Promise<{ client: any; type: string }>;
  connectOne: (server: string) => Promise<any>;
};

/** Tests reach McpHub's private wiring on purpose; this is the typed view of that internal state. */
function privateView(hub: any): PrivateHub {
  return hub;
}

function installTool(hub: McpHub, client: any): PrivateHub {
  const internal = privateView(hub);
  internal.toolMap.set("mcp__test__mutate", { server: "test", tool: "mutate" });
  internal.clients.set("test", client);
  internal.configs.set("test", { command: "unused" });
  return internal;
}

test("MCP transport failure is outcome-unknown and never replayed automatically", async () => {
  const controller = new AbortController();
  let calls = 0;
  let reconnects = 0;
  let requestOptions: any;
  const hub = new McpHub();
  const internal = installTool(hub, {
    async callTool(_params: any, _schema: any, options: any) {
      calls++;
      requestOptions = options;
      throw new Error("response was lost");
    },
  });
  internal.makeClient = async () => {
    reconnects++;
    return {
      type: "stdio",
      client: {
        async callTool() {
          calls++;
          return { content: [{ type: "text", text: "unexpected replay" }] };
        },
      },
    };
  };

  const result = await hub.call("mcp__test__mutate", {}, controller.signal);

  expect(result).toContain("outcome unknown");
  expect(result).toContain("not retried");
  expect(calls).toBe(1);
  expect(reconnects).toBe(0);
  expect(requestOptions.signal).toBe(controller.signal);
  expect(requestOptions.timeout).toBeGreaterThan(0);
  expect(requestOptions.maxTotalTimeout).toBe(requestOptions.timeout);
});

test("MCP reconnects only when a later explicit call follows an outcome-unknown failure", async () => {
  let failedCalls = 0;
  let closes = 0;
  let reconnects = 0;
  let recoveredCalls = 0;
  const hub = new McpHub();
  const internal = installTool(hub, {
    async callTool() {
      failedCalls++;
      throw new Error("transport closed after send");
    },
    async close() { closes++; },
  });
  internal.connectOne = async (server) => {
    reconnects++;
    const recovered = {
      async callTool() {
        recoveredCalls++;
        return { content: [{ type: "text", text: "recovered" }] };
      },
    };
    internal.clients.set(server, recovered);
    return recovered;
  };

  const first = await hub.call("mcp__test__mutate", {});
  expect(first).toContain("outcome unknown");
  expect(failedCalls).toBe(1);
  expect(closes).toBe(1);
  expect(reconnects).toBe(0);
  expect(internal.clients.has("test")).toBe(false);

  expect(await hub.call("mcp__test__mutate", {})).toBe("recovered");
  expect(reconnects).toBe(1);
  expect(recoveredCalls).toBe(1);
});

test("a failed real connect keeps the cached tool surface retryable", async () => {
  let connects = 0;
  let failedCloses = 0;
  const hub = new McpHub();
  const internal = privateView(hub);
  internal.toolMap.set("mcp__test__mutate", { server: "test", tool: "mutate" });
  internal.configs.set("test", { command: "unused" });
  internal.makeClient = async () => {
    connects++;
    if (connects === 1) {
      return {
        type: "stdio",
        client: {
          async listTools() { throw new Error("list failed"); },
          async close() { failedCloses++; },
        },
      };
    }
    return {
      type: "stdio",
      client: {
        async listTools() {
          return { tools: [{ name: "mutate", inputSchema: { type: "object" } }] };
        },
        async listResources() { return { resources: [] }; },
        async listPrompts() { return { prompts: [] }; },
        async callTool() { return { content: [{ type: "text", text: "recovered live" }] }; },
        async close() {},
      },
    };
  };

  expect(await hub.call("mcp__test__mutate", {})).toContain("outcome unknown");
  expect(failedCloses).toBe(1);
  expect(hub.has("mcp__test__mutate")).toBe(true);
  expect(await hub.call("mcp__test__mutate", {})).toBe("recovered live");
  expect(connects).toBe(2);
});

test("resource and prompt failures evict dead clients for later explicit retries", async () => {
  const resourceHub = new McpHub();
  const resource = privateView(resourceHub);
  resource.resourceTools.set("mcp__test__read_resource", "test");
  resource.configs.set("test", { command: "unused" });
  resource.clients.set("test", {
    async readResource() { throw new Error("dead resource transport"); },
    async close() {},
  });
  expect(await resourceHub.call("mcp__test__read_resource", { uri: "x:" })).toContain("dead resource transport");
  expect(resource.clients.has("test")).toBe(false);
  resource.connectOne = async (server) => {
    const client = { async readResource() { return { contents: [{ text: "resource recovered" }] }; } };
    resource.clients.set(server, client);
    return client;
  };
  expect(await resourceHub.call("mcp__test__read_resource", { uri: "x:" })).toBe("resource recovered");

  const promptHub = new McpHub();
  const prompt = privateView(promptHub);
  prompt.configs.set("test", { command: "unused" });
  prompt.clients.set("test", {
    async getPrompt() { throw new Error("dead prompt transport"); },
    async close() {},
  });
  expect(await promptHub.getPrompt("test", "review", {})).toContain("dead prompt transport");
  expect(prompt.clients.has("test")).toBe(false);
  prompt.connectOne = async (server) => {
    const client = { async getPrompt() { return { messages: [{ content: "prompt recovered" }] }; } };
    prompt.clients.set(server, client);
    return client;
  };
  expect(await promptHub.getPrompt("test", "review", {})).toBe("prompt recovered");
});

test("parallel first-use MCP calls share one lazy connection", async () => {
  let connects = 0;
  const hub = new McpHub();
  const internal = privateView(hub);
  internal.toolMap.set("mcp__test__one", { server: "test", tool: "one" });
  internal.toolMap.set("mcp__test__two", { server: "test", tool: "two" });
  internal.configs.set("test", { command: "unused" });
  internal.connectOne = async (server) => {
    connects++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const client = {
      async callTool(params: { name: string }) {
        return { content: [{ type: "text", text: params.name }] };
      },
    };
    internal.clients.set(server, client);
    return client;
  };

  expect(await Promise.all([
    hub.call("mcp__test__one", {}),
    hub.call("mcp__test__two", {}),
  ])).toEqual(["one", "two"]);
  expect(connects).toBe(1);
});

test("Windows MCP cleanup resolves only an absolute System32 taskkill", () => {
  expect(__resolveWindowsTaskkillForTest("C:\\Windows", () => true))
    .toBe("C:\\Windows\\System32\\taskkill.exe");
  expect(__resolveWindowsTaskkillForTest(".\\Windows", () => true)).toBeNull();
  expect(__resolveWindowsTaskkillForTest("C:\\Windows", () => false)).toBeNull();
});

test("MCP call forwards cancellation to the SDK request", async () => {
  const controller = new AbortController();
  let calls = 0;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const hub = new McpHub();
  installTool(hub, {
    callTool(_params: any, _schema: any, options: { signal?: AbortSignal }) {
      calls++;
      started();
      return new Promise((_resolve, reject) => {
        if (!options?.signal) return reject(new Error("missing abort signal"));
        if (options.signal.aborted) return reject(new Error("aborted"));
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });

  const pending = hub.call("mcp__test__mutate", {}, controller.signal);
  await didStart;
  controller.abort();
  const result = await pending;

  expect(result).toContain("outcome unknown");
  expect(result).toContain("aborted");
  expect(calls).toBe(1);
});
