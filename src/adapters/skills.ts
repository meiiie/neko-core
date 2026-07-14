/**
 * Skills: load *.md instruction files from ~/.neko-core/skills/ and ./.neko-core/skills/
 * (either `skills/<name>.md` or `skills/<name>/SKILL.md`, Claude-Code style). `/skill <name>`
 * in chat injects the skill body into the system prompt so the model follows it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { dirname, join } from "node:path";
import { builtinSkillsDir } from "./builtin-skills.ts";

export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string; // the skill's own directory — so bundled scripts/assets can be run by absolute path
  match?: string; // optional frontmatter regex: an unambiguous trigger that deterministically loads this
                  // skill (e.g. a platform URL for web-reach), where description token-overlap is too coarse.
}

function skillDirs(): string[] {
  return [
    join(homeDir(), ".neko-core", "skills"), // user skills
    join(process.cwd(), ".neko-core", "skills"), // project skills
    builtinSkillsDir(), // skills bundled with Neko (lowest priority; user/project override)
  ];
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
  // CRLF-tolerant: a skill authored on Windows (Notepad -> \r\n) must still have its frontmatter parsed,
  // or its name/description are lost and matchSkill (which keys on description) can't find it.
  let match: string | undefined;
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2];
    const n = fm[1].match(/^name:\s*(.+)$/m);
    if (n) name = n[1].trim();
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (d) description = d[1].trim();
    const m = fm[1].match(/^match:\s*(.+)$/m);
    if (m) match = m[1].trim();
  }
  if (description === ">" || description === "|") description = ""; // YAML block scalar marker
  return { name, description: description.replace(/\s+/g, " ").slice(0, 120), body: body.trim(), dir: dirname(file), match };
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
    "Available skills (on-demand domain capabilities). IMPORTANT: if the user's task matches a skill's " +
    "description below, you MUST call the `skill` tool to load it BEFORE planning or acting — the skill " +
    "carries required domain rules and bundled tools you otherwise lack. Don't hand-roll a task a skill covers.\n" +
    lines.join("\n")
  );
}

const SKILL_STOP = new Set(
  ("the a an and or for to of in on at by with you your i it is are be do can will this that these those" +
   " cua cho voi cac mot nay tai khi ban toi lam gium giup hay duoc khong neu thi va la").split(/\s+/),
);
function skillTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/).filter((w) => w.length >= 3 && !SKILL_STOP.has(w)),
  );
}
/** Deterministic skill match: if the user's task shares enough SIGNIFICANT keywords with a skill's
 * name+description, return it — so a clearly-matching domain skill loads even when the model wouldn't
 * proactively pull it. Conservative (needs a strong multi-keyword overlap) to avoid false positives. */
export function matchSkill(userText: string): Skill | null {
  const skills = listSkills();
  // Deterministic trigger first: a skill's frontmatter `match` regex is an unambiguous signal (e.g. a
  // platform URL for web-reach) - load it directly, since description token-overlap is too coarse to catch
  // short or other-language asks (a Vietnamese "lay transcript youtube ..." shares only ~3 English tokens).
  for (const s of skills) {
    if (!s.match) continue;
    try { if (new RegExp(s.match, "i").test(userText)) return s; } catch { /* a bad regex just doesn't trigger */ }
  }
  const ut = skillTokens(userText);
  if (ut.size < 3) return null;
  let best: Skill | null = null;
  let bestScore = 0;
  for (const s of skills) {
    let hits = 0;
    for (const w of skillTokens(`${s.name} ${s.description}`)) if (ut.has(w)) hits++;
    if (hits > bestScore) { bestScore = hits; best = s; }
  }
  return bestScore >= 4 ? best : null;
}

export function renderSkills(): string {
  const list = listSkills();
  if (!list.length) {
    return "No skills found. Add *.md to ~/.neko-core/skills/ or ./.neko-core/skills/.";
  }
  return ["Neko Core skills:", ...list.map((s) => `- ${s.name}${s.description ? "  " + s.description : ""}`)].join("\n");
}
