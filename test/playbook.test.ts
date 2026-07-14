import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { playbookContextBlock, playbookTool } from "../src/core/playbook.ts";

// playbook.ts resolves ~/.neko-core/playbook.md via homedir(); point HOME at a temp dir per test.
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
afterEach(() => {
  for (const k of ["HOME", "USERPROFILE"] as const) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});
function freshHome(): void {
  const tmp = mkdtempSync(join(tmpdir(), "nk-pb-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
}

test("playbook add + read + always-on context block (ACE operating context)", () => {
  freshHome();
  expect(playbookTool({ action: "add", content: "For JS-rendered shop pages, use browser MCP not web_fetch" })).toContain("Added");
  const block = playbookContextBlock();
  expect(block).toContain("operating playbook");
  expect(block).toContain("browser MCP not web_fetch");
});

test("add de-dups near-duplicates (grow-and-refine, no bloat)", () => {
  freshHome();
  playbookTool({ action: "add", content: "Always check official retailers first" });
  expect(playbookTool({ action: "add", content: "Always check official retailers first" })).toContain("already exists");
  expect(playbookTool({ action: "read" }).split("\n").length).toBe(1); // still one bullet
});

test("revise refines ONE bullet (anti-collapse), remove drops it", () => {
  freshHome();
  playbookTool({ action: "add", content: "Prices: take the lowest variant" });
  playbookTool({ action: "add", content: "Shipping: prefer warehouses near the buyer" });
  expect(playbookTool({ action: "revise", find: "lowest variant", content: "Prices: take the lowest variant; ignore the strikethrough listed price" })).toContain("Revised");
  expect(playbookTool({ action: "read" })).toContain("strikethrough listed price");
  expect(playbookTool({ action: "read" })).toContain("warehouses near the buyer"); // the other bullet is untouched
  expect(playbookTool({ action: "remove", find: "warehouses" })).toContain("Removed");
  expect(playbookTool({ action: "read" })).not.toContain("warehouses");
});

test("context uses compact excerpts while search returns the lossless lesson", () => {
  freshHome();
  const lesson = ("When a provider repeats a large stable prefix, keep dynamic state at the end and measure cache reads before changing the harness. " + "detail ".repeat(80)).trim();
  playbookTool({ action: "add", content: lesson });
  const block = playbookContextBlock();
  expect(block).toContain("excerpts only");
  expect(block.length).toBeLessThan(lesson.length * 0.7);
  expect(block).not.toContain(lesson.slice(-120));
  expect(playbookTool({ action: "search", query: "stable prefix cache" })).toContain(lesson);
});
