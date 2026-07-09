import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// The dependency rule from ARCHITECTURE.md (Ports & Adapters): dependencies point inward.
// If this fails, a layering violation crept in - move the logic / add a port, don't loosen.
const files = (layer: string) => readdirSync(join(import.meta.dir, "..", "src", layer), { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
  .map((entry) => entry.name);
const CORE = files("core");
const ADAPTERS = files("adapters");
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

test("developer scripts have no broken relative imports", () => {
  const dir = join(import.meta.dir, "..", "scripts");
  for (const f of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf-8");
    const imports = [...src.matchAll(/(?:from\s+|import\()\s*["'](\.[^"']+)["']/g)];
    for (const match of imports) {
      const target = resolve(dir, match[1]);
      expect(existsSync(target), `${f}: missing relative import ${match[1]}`).toBe(true);
    }
  }
});
