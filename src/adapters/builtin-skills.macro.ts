/** Build-time macro: inline every bundled skill file into the standalone executable. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export function readBuiltinSkillFiles(): Record<string, string> {
  const root = join(import.meta.dir, "..", "..", "skills");
  const files: Record<string, string> = {};
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (![".git", "node_modules", "dist"].includes(entry.name)) walk(path);
      } else if (entry.isFile()) {
        const data = readFileSync(path);
        total += data.length;
        if (total > 10 * 1024 * 1024) throw new Error("bundled skills exceed the 10 MB safety cap");
        files[relative(root, path).replace(/\\/g, "/")] = data.toString("base64");
      }
    }
  };
  walk(root);
  return files;
}
