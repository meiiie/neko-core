import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The dependency rule from ARCHITECTURE.md: the core domain never depends on the UI layer or
// any UI framework. If this fails, a layering violation crept in - move the logic, don't
// loosen the test.
const CORE = ["agent.ts", "tools.ts", "tool-runtime.ts", "permissions.ts", "cost.ts", "registry.ts"];
const ADAPTERS = ["providers.ts", "mcp.ts", "session.ts", "config.ts", "context.ts", "skills.ts", "project.ts", "doctor.ts"];

test("core and adapters never import the UI layer or Ink/React", () => {
  for (const file of [...CORE, ...ADAPTERS]) {
    const src = readFileSync(join(import.meta.dir, "..", "src", file), "utf-8");
    expect(src, `${file} must not import the ui/ layer`).not.toMatch(/from ["']\.\.?\/ui/);
    expect(src, `${file} must not import a UI framework`).not.toMatch(/from ["'](ink|react)/);
  }
});
