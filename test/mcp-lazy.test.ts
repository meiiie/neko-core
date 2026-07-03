import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMcpHub } from "../src/adapters/mcp.ts";

const serverCfg = () => ({ test: { command: process.execPath, args: [join(import.meta.dir, "fixtures", "mcp-server.ts")] } });

/** Run a block with ~ pointed at a fresh temp dir, so the mcp spec cache is isolated per test. */
async function withTempHome(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "neko-mcphome-"));
  const prev = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = dir;
  process.env.HOME = dir;
  try { await fn(); } finally {
    process.env.USERPROFILE = prev.USERPROFILE;
    process.env.HOME = prev.HOME;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

test("mcp lazy-CONNECT: 2nd build registers tools from the spec cache WITHOUT spawning; first call connects", async () => {
  await withTempHome(async () => {
    // Build #1: cache miss -> connects eagerly (writes the spec cache), server is live.
    const first = await buildMcpHub(serverCfg(), {}, true);
    expect(first.serverNames).toContain("test"); // connected (miss path)
    expect(first.toolNames().length).toBe(3);
    await first.close();

    // Build #2 (same config): cache hit -> full tool surface, NO connected client (nothing spawned).
    const hub = await buildMcpHub(serverCfg(), {}, true);
    try {
      expect(hub.toolNames().length).toBe(3); // surface known from cache
      expect(hub.serverNames).toEqual([]); // but no server process spawned yet
      expect(hub.indexBlock()).toContain("mcp__test__toolA"); // lazy index works from cache
      // First actual call connects on demand and works end-to-end.
      expect(await hub.call("mcp__test__toolA", { x: "hi" })).toContain("ran toolA");
      expect(hub.serverNames).toContain("test"); // now connected
    } finally {
      await hub.close();
    }

    // A config CHANGE is a cache miss -> connects eagerly again (no stale surface).
    const changed = { test: { ...serverCfg().test, env: { NEW_FLAG: "1" } } };
    const hub2 = await buildMcpHub(changed, {}, true);
    try {
      expect(hub2.serverNames).toContain("test"); // eager (different config hash)
    } finally {
      await hub2.close();
    }
  });
}, 60000);

test("mcp lazy: lists tool names in context, loads schemas on demand", async () => {
  await withTempHome(async () => {
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
});

test("mcp non-lazy: all tool schemas are exposed upfront (no index block)", async () => {
  await withTempHome(async () => {
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
});
