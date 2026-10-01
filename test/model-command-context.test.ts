import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NekoConfig } from "../src/adapters/config.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { runSlashCommand } from "../src/ui/commands.ts";

test("direct /model updates the running agent's context budget for the selected model", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-model-budget-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const cfg = new NekoConfig({
      provider: "openai_compat",
      base_url: "http://127.0.0.1:9/v1",
      model: "big",
      context_window: 16_384,
      model_context: { big: 32_768, small: 8_192 },
    }, null, {}, "", null, [], { state: "none", files: [] }, home);
    let activeBudget = cfg.contextWindow;
    // SAFETY: the direct /model branch only reads cfg and calls agent.setMaxContextTokens/addLine.
    const ctx: any = {
      cfg,
      agent: { setMaxContextTokens: (tokens: number) => { activeBudget = tokens; } },
      registry: new ToolRegistry(home, "default", () => true),
      addLine: () => {},
    };

    expect(activeBudget).toBe(32_768);
    await runSlashCommand("/model small", ctx);

    expect(cfg.model).toBe("small");
    expect(cfg.contextWindow).toBe(8_192);
    expect(activeBudget).toBe(8_192);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});
