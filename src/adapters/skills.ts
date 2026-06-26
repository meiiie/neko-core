/**
 * Skills: load *.md instruction files from ~/.neko-core/skills/ and ./.neko-core/skills/
 * (either `skills/<name>.md` or `skills/<name>/SKILL.md`, Claude-Code style). `/skill <name>`
 * in chat injects the skill body into the system prompt so the model follows it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  body: string;
}

function skillDirs(): string[] {
  return [join(homeDir(), ".neko-core", "skills"), join(process.cwd(), ".neko-core", "skills")];
}

function parse(file: string): Skill | null {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const parts = file.replace(/\\/g, "/").split("/");
  let name = /SKILL\.md$/i.test(file) ? parts[parts.length - 2] : parts[parts.length - 1].replace(/\.md$/, "");
  let description = "";
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2];
    const n = fm[1].match(/^name:\s*(.+)$/m);
    if (n) name = n[1].trim();
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (d) description = d[1].trim();
  }
  if (description === ">" || description === "|") description = ""; // YAML block scalar marker
  return { name, description: description.replace(/\s+/g, " ").slice(0, 120), body: body.trim() };
}

export function listSkills(): Skill[] {
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const dir of skillDirs()) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      let file = "";
      try {
        if (entry.endsWith(".md") && statSync(p).isFile()) file = p;
        else if (statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"))) file = join(p, "SKILL.md");
      } catch {
        continue;
      }
      if (!file) continue;
      const skill = parse(file);
      if (skill && !seen.has(skill.name)) {
        seen.add(skill.name);
        out.push(skill);
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkill(name: string): Skill | null {
  return listSkills().find((s) => s.name === name) ?? null;
}

/** Progressive disclosure (SOTA): inject just the skill names + one-line descriptions into context
 * (~cheap) so the model KNOWS what domain capabilities exist and can pull the full instructions in
 * on demand via the `skill` tool — never bloating context with skill bodies it isn't using. */
export function skillsContextBlock(): string {
  const list = listSkills();
  if (!list.length) return "";
  const CAP = 50;
  const lines = list.slice(0, CAP).map((s) => `- ${s.name}: ${s.description || "(no description)"}`);
  if (list.length > CAP) lines.push(`- ... +${list.length - CAP} more`);
  return (
    "Available skills (domain capabilities). When a task matches one, FIRST call the `skill` tool to " +
    "load its full instructions, then follow them:\n" + lines.join("\n")
  );
}

export function renderSkills(): string {
  const list = listSkills();
  if (!list.length) {
    return "No skills found. Add *.md to ~/.neko-core/skills/ or ./.neko-core/skills/.";
  }
  return ["Neko Code skills:", ...list.map((s) => `- ${s.name}${s.description ? "  " + s.description : ""}`)].join("\n");
}
