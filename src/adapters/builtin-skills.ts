/**
 * Materialize build-time embedded skills for a standalone binary. Bun cannot execute PowerShell/TS helper
 * scripts directly from its virtual $bunfs, so one small per-process temp tree gives every skill a normal
 * directory while keeping the release a single file. Source runs use the repository tree directly.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { readBuiltinSkillFiles } from "./builtin-skills.macro.ts" with { type: "macro" };

const EMBEDDED = readBuiltinSkillFiles();
let extracted: string | null = null;

export function builtinSkillsDir(): string {
  const sourceDir = join(import.meta.dir, "..", "..", "skills");
  if (existsSync(sourceDir)) return sourceDir;
  if (extracted) return extracted;

  const root = mkdtempSync(join(tmpdir(), "neko-core-skills-"));
  for (const [relative, encoded] of Object.entries(EMBEDDED)) {
    const normalized = relative.replace(/\\/g, "/");
    if (!normalized || isAbsolute(normalized) || normalized.split("/").includes("..")) {
      throw new Error(`invalid embedded skill path: ${relative}`);
    }
    const target = join(root, ...normalized.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(encoded, "base64"));
  }
  extracted = root;

  process.once("exit", () => {
    const base = resolve(tmpdir()) + sep;
    const target = resolve(root);
    if (target.startsWith(base) && target.includes(`${sep}neko-core-skills-`)) {
      try { rmSync(target, { recursive: true, force: true }); } catch {}
    }
  });
  return root;
}
