import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The dependency rule from ARCHITECTURE.md (Ports & Adapters): dependencies point inward.
// If this fails, a layering violation crept in - move the logic / add a port, don't loosen.
const CORE = ["agent.ts", "tools.ts", "tool-runtime.ts", "permissions.ts", "cost.ts", "ports.ts"];
const ADAPTERS = ["providers.ts", "mcp.ts", "config.ts", "session.ts", "context.ts", "skills.ts", "project.ts", "doctor.ts", "registry.ts"];
const read = (layer: string, f: string) => readFileSync(join(import.meta.dir, "..", "src", layer, f), "utf-8");

test("core depends only inward (no adapters, no ui, no UI framework)", () => {
  for (const f of CORE) {
    const src = read("core", f);
    expect(src, `${f}: core must not import adapters`).not.toMatch(/from ["']\.\.\/adapters/);
    expect(src, `${f}: core must not import ui`).not.toMatch(/from ["']\.\.\/ui/);
    expect(src, `${f}: core must not import a UI framework`).not.toMatch(/from ["'](ink|react)/);
  }
});

test("adapters never import the ui layer or a UI framework", () => {
  for (const f of ADAPTERS) {
    const src = read("adapters", f);
    expect(src, `${f}: adapters must not import ui`).not.toMatch(/from ["']\.\.\/ui/);
    expect(src, `${f}: adapters must not import a UI framework`).not.toMatch(/from ["'](ink|react)/);
  }
});
