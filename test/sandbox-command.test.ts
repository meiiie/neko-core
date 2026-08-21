import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { runSlashCommand } from "../src/ui/commands.ts";

const HOME = mkdtempSync(join(tmpdir(), "neko-sandbox-command-"));
const OLD_HOME = process.env.HOME;
const OLD_USERPROFILE = process.env.USERPROFILE;

beforeAll(() => {
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
});

afterAll(() => {
  if (OLD_HOME === undefined) delete process.env.HOME; else process.env.HOME = OLD_HOME;
  if (OLD_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = OLD_USERPROFILE;
  rmSync(HOME, { recursive: true, force: true });
});

test("/sandbox network changes the live registry and persists the next-session policy", async () => {
  const registry = new ToolRegistry(process.cwd(), "auto", () => true);
  const lines: string[] = [];
  // SAFETY: /sandbox uses only cfg, registry, and addLine from this focused fixture.
  const ctx = {
    cfg: {},
    registry,
    addLine: (_kind: string, text: string) => lines.push(text),
  } as any;

  await runSlashCommand("/sandbox network on example.com api.github.com", ctx);
  expect(registry.sandboxAllowNetwork).toBe(true);
  expect(registry.sandboxDomains).toEqual(["example.com", "api.github.com"]);
  expect(lines.at(-1)).toContain("applied now");
  const saved = JSON.parse(readFileSync(join(HOME, ".neko-core", "config.json"), "utf8"));
  expect(saved.sandbox_network).toBe(true);
  expect(saved.sandbox_domains).toEqual(["example.com", "api.github.com"]);

  await runSlashCommand("/sandbox", ctx);
  expect(lines.at(-1)).toContain("allowlisted [example.com, api.github.com]");
  expect(lines.at(-1)).toContain("applies now");

  await runSlashCommand("/sandbox network off", ctx);
  expect(registry.sandboxAllowNetwork).toBe(false);
  expect(lines.at(-1)).toContain("applied now");
});
