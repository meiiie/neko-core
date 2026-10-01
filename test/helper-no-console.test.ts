import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Inspect launch contracts without importing adapters or starting setup/cleanup processes.
function launchOptions(relativePath: string): string[] {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  return [...source.matchAll(/spawnSync\([\s\S]*?\{([^{}]*)\}\)/g)].map((match) => match[1]!);
}

test("setup probes and Docker helpers suppress Windows console windows", () => {
  const options = launchOptions("../src/adapters/setup.ts");
  expect(options.length).toBeGreaterThanOrEqual(3);
  for (const option of options) expect(option).toMatch(/\bwindowsHide:\s*true\b/);
});

test("MCP cleanup suppresses its console and discards unused output", () => {
  const options = launchOptions("../src/adapters/mcp.ts");
  expect(options).toHaveLength(1);
  expect(options[0]).toMatch(/\bwindowsHide:\s*true\b/);
  expect(options[0]).toMatch(/\bstdio:\s*"ignore"/);
  expect(options[0]).toMatch(/\btimeout:\s*5000\b/);
});
