import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAgentRuntime, type BuildAgentRuntimeOptions } from "../src/adapters/agent-runtime.ts";
import { NekoConfig } from "../src/adapters/config.ts";
import { NEKOCUT_HOST_PROFILE } from "../src/adapters/host-profile.ts";
import type { McpTools } from "../src/core/ports.ts";

for (const hostProfile of [false, true]) {
  test(`runtime ${hostProfile ? "host profile" : "normal"} starts with the active model context window`, async () => {
    const root = mkdtempSync(join(tmpdir(), "neko-runtime-context-root-"));
    const home = mkdtempSync(join(tmpdir(), "neko-runtime-context-home-"));
    const priorHome = process.env.HOME;
    const priorUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const cfg = new NekoConfig({
        provider: "openai_compat",
        model: "synthetic-model",
        base_url: "http://127.0.0.1:9/v1",
        context_window: 200_000,
        model_context: { "synthetic-model": 8_192 },
      }, null, {}, "", null, [], { state: "none", files: [] }, home);
      expect(cfg.contextWindow).toBe(8_192);
      const hostTools: McpTools = {
        toolSchemas: () => [],
        has: () => false,
        call: async () => "unused",
      };
      const options: BuildAgentRuntimeOptions = { root, approval: async () => false };
      if (hostProfile) {
        options.hostProfile = NEKOCUT_HOST_PROFILE;
        options.hostTools = hostTools;
      }
      const runtime = await buildAgentRuntime(cfg, options);
      try {
        // No provider request: inspect the context budget that drives Agent compaction.
        expect(Object.getOwnPropertyDescriptor(runtime.agent, "maxContextTokens")?.value).toBe(cfg.contextWindow);
      } finally {
        await runtime.close();
      }
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = priorUserProfile;
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
}
