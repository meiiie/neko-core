import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAgentRuntime } from "../src/adapters/agent-runtime.ts";
import { loadConfig } from "../src/adapters/config.ts";
import {
  hostProfileHash,
  hostToolName,
  hostToolNames,
  NEKOCUT_HOST_PROFILE,
  resolveHostCapabilityProfile,
  sameHostProfile,
  storedHostProfile,
} from "../src/adapters/host-profile.ts";
import type { McpTools } from "../src/core/ports.ts";

test("built-in host profile is stable and round-trips durable authority", () => {
  expect(resolveHostCapabilityProfile("NEKOCUT")).toBe(NEKOCUT_HOST_PROFILE);
  expect(hostProfileHash(NEKOCUT_HOST_PROFILE)).toMatch(/^[a-f0-9]{64}$/);
  expect(sameHostProfile(storedHostProfile(NEKOCUT_HOST_PROFILE), NEKOCUT_HOST_PROFILE)).toBe(true);
  expect(sameHostProfile(undefined, NEKOCUT_HOST_PROFILE)).toBe(false);
  expect(() => resolveHostCapabilityProfile("unknown")).toThrow("Unknown host profile");
});

test("host runtime excludes native/global tools and closes its in-band MCP", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-host-runtime-"));
  const home = mkdtempSync(join(tmpdir(), "neko-host-home-"));
  const processHome = mkdtempSync(join(tmpdir(), "neko-host-process-home-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  let closed = false;
  const schemas = NEKOCUT_HOST_PROFILE.tools.map((tool) => ({
    type: "function",
    function: {
      name: hostToolName(NEKOCUT_HOST_PROFILE, tool.name),
      description: tool.name,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  }));
  schemas.push({
    type: "function",
    function: {
      name: "mcp__nekocut__undeclared",
      description: "must stay hidden",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  });
  const hostTools: McpTools = {
    toolSchemas: () => schemas,
    has: (name) => schemas.some((schema) => schema.function.name === name),
    call: async () => "ok",
    close: async () => { closed = true; },
  };
  process.env.HOME = processHome;
  process.env.USERPROFILE = processHome;
  try {
    const cfg = loadConfig({ cwd: root, home });
    cfg.data.mcp = { configured_but_forbidden: { command: process.execPath, args: ["--version"] } };
    const runtime = await buildAgentRuntime(cfg, {
      root,
      approval: async () => false,
      hostProfile: NEKOCUT_HOST_PROFILE,
      hostTools,
    });
    expect(existsSync(join(home, ".neko-core", "memory", "user.md"))).toBe(true);
    expect(existsSync(join(home, ".neko-core", "NEKO.md"))).toBe(true);
    expect(existsSync(join(processHome, ".neko-core", "memory", "user.md"))).toBe(false);
    expect(runtime.registry.schemas().map((schema: any) => schema.function.name)).toEqual(hostToolNames(NEKOCUT_HOST_PROFILE));
    expect(runtime.registry.readOutsideRoot).toBe(false);
    expect(runtime.registry.allowBackgroundBash).toBe(false);
    expect(runtime.registry.subagent).toBeUndefined();
    expect(runtime.registry.web).toBeUndefined();
    await runtime.close();
    expect(closed).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(processHome, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
});
