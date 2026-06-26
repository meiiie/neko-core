import { expect, test } from "bun:test";
import { join } from "node:path";

import { buildMcpHub } from "../src/adapters/mcp.ts";

const serverCfg = () => ({ test: { command: process.execPath, args: [join(import.meta.dir, "fixtures", "mcp-server.ts")] } });

test("mcp lazy: lists tool names in context, loads schemas on demand", async () => {
  const hub = await buildMcpHub(serverCfg(), {}, true); // force lazy
  try {
    expect(hub.toolNames().length).toBe(3); // all three are known to the hub
    // lazy: the model's tool list shows only the loader meta-tool, not the 3 tool schemas
    const before = hub.toolSchemas().map((s: any) => s.function.name);
    expect(before).toContain("mcp_load");
    expect(before).not.toContain("mcp__test__toolA");
    // the index block lists every tool name + description so the model knows what to load
    const idx = hub.indexBlock();
    expect(idx).toContain("mcp__test__toolA");
    expect(idx).toContain("mcp__test__toolC");
    // load one -> its schema is returned and it becomes callable; siblings stay hidden
    expect(hub.loadTools(["mcp__test__toolA"])).toContain("mcp__test__toolA");
    const after = hub.toolSchemas().map((s: any) => s.function.name);
    expect(after).toContain("mcp__test__toolA");
    expect(after).not.toContain("mcp__test__toolB");
    // the loaded tool actually invokes
    expect(await hub.call("mcp__test__toolA", { x: "hi" })).toContain("ran toolA");
  } finally {
    await hub.close();
  }
});

test("mcp non-lazy: all tool schemas are exposed upfront (no index block)", async () => {
  const hub = await buildMcpHub(serverCfg(), {}, false); // force non-lazy
  try {
    const names = hub.toolSchemas().map((s: any) => s.function.name);
    expect(names).toContain("mcp__test__toolA");
    expect(names).toContain("mcp__test__toolB");
    expect(names).not.toContain("mcp_load");
    expect(hub.indexBlock()).toBe("");
  } finally {
    await hub.close();
  }
});
