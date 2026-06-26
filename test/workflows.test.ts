import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listWorkflows, matchWorkflow, workflowsContextBlock, workflowTool } from "../src/core/workflows.ts";

// workflows.ts resolves ~/.neko-core/workflows via homedir(); point HOME at a temp dir per test.
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
afterEach(() => {
  for (const k of ["HOME", "USERPROFILE"] as const) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});
function freshHome(): string {
  const tmp = mkdtempSync(join(tmpdir(), "nk-wf-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  return tmp;
}

test("workflow write -> read round-trip (procedural memory)", () => {
  freshHome();
  expect(workflowTool({ action: "write", name: "source-js-price", content: "When: price is JS-rendered.\n1. browser_navigate\n2. browser_snapshot" }))
    .toContain("Saved workflow 'source-js-price.md'");
  expect(workflowTool({ action: "read", name: "source-js-price" })).toContain("browser_snapshot");
});

test("list + context block surface learned workflows with their when-to-use", () => {
  freshHome();
  workflowTool({ action: "write", name: "source-js-price", content: "When: getting a price from a JS-rendered shop page" });
  expect(listWorkflows().map((w) => w.name)).toEqual(["source-js-price.md"]);
  const block = workflowsContextBlock();
  expect(block).toContain("Learned workflows");
  expect(block).toContain("source-js-price.md: When: getting a price from a JS-rendered shop page");
});

test("matchWorkflow recalls a strongly-overlapping procedure, ignores unrelated tasks", () => {
  freshHome();
  workflowTool({ action: "write", name: "source-js-price", content: "When: getting a product price from a JS-rendered shop page using browser snapshot" });
  const hit = matchWorkflow("get the product price from a JS-rendered shop page");
  expect(hit?.name).toBe("source-js-price.md");
  expect(matchWorkflow("refactor the typescript build")).toBeNull();
});
