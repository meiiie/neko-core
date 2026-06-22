import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadProjectContext } from "../src/adapters/context.ts";

test("loads NEKO.md from the project root", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-ctx-"));
  mkdirSync(join(root, ".git")); // mark a repo root so the walk stops here
  writeFileSync(join(root, "NEKO.md"), "hello project context");
  const files = loadProjectContext(root);
  expect(files.some((f) => f.text.includes("hello project context"))).toBe(true);
});
