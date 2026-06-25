/**
 * Recipes: runnable prompt templates (Goose recipes / Claude custom-commands). A `*.md` file in
 * ~/.neko-core/recipes/ or ./.neko-core/recipes/ becomes `/recipe <name> [args]`; its body is a
 * prompt run as a turn, with $ARGUMENTS and $1..$n substituted. Save a workflow once, replay it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { join } from "node:path";

export interface Recipe {
  name: string;
  description: string;
  body: string;
}

function recipeDirs(): string[] {
  return [join(homeDir(), ".neko-core", "recipes"), join(process.cwd(), ".neko-core", "recipes")];
}

function parse(file: string): Recipe | null {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const name = file.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/, "");
  let description = "";
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2];
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (d) description = d[1].trim();
  }
  return { name, description: description.replace(/\s+/g, " ").slice(0, 120), body: body.trim() };
}

export function listRecipes(): Recipe[] {
  const out: Recipe[] = [];
  const seen = new Set<string>();
  for (const dir of recipeDirs()) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const p = join(dir, entry);
      try {
        if (!statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      const r = parse(p);
      if (r && !seen.has(r.name)) {
        seen.add(r.name);
        out.push(r);
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadRecipe(name: string): Recipe | null {
  return listRecipes().find((r) => r.name === name) ?? null;
}

/** Substitute $ARGUMENTS (all args) and $1..$n (positional) into a recipe body. */
export function fillRecipe(body: string, args: string): string {
  const all = args.trim();
  const argv = all ? all.split(/\s+/) : [];
  return body.replace(/\$ARGUMENTS\b/g, all).replace(/\$(\d+)/g, (_, n) => argv[Number(n) - 1] ?? "");
}

export function renderRecipes(): string {
  const list = listRecipes();
  if (!list.length) {
    return "No recipes. Add *.md to ~/.neko-core/recipes/ or ./.neko-core/recipes/ (body = the prompt; use $ARGUMENTS).";
  }
  return ["Neko Code recipes:", ...list.map((r) => `- ${r.name}${r.description ? "  " + r.description : ""}`)].join("\n");
}
