/**
 * Skills: load *.md instruction files from ~/.neko-core/skills/ and ./.neko-core/skills/
 * (either `skills/<name>.md` or `skills/<name>/SKILL.md`, Claude-Code style). `/skill <name>`
 * in chat injects the skill body into the system prompt so the model follows it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { dirname, join } from "node:path";
import { builtinSkillsDir } from "./builtin-skills.ts";
import type { ToolRegistry } from "../core/tool-runtime.ts";
import { inspectProjectTrust } from "./project-trust.ts";

export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string; // the skill's own directory — so bundled scripts/assets can be run by absolute path
  source?: "user" | "project" | "builtin";
  match?: string; // optional frontmatter regex: an unambiguous trigger that deterministically loads this
                  // skill (e.g. a platform URL for web-reach), where description token-overlap is too coarse.
}

function trustedSkillDirs(home: string): string[] {
  return [
    join(home, ".neko-core", "skills"), // user skills
    builtinSkillsDir(), // skills bundled with Neko (lowest priority; user/project override)
  ];
}

function frontmatterDescription(frontmatter: string): string {
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex((line) => /^description:\s*/.test(line));
  if (index < 0) return "";
  const value = lines[index].replace(/^description:\s*/, "").trim();
  const header = value.replace(/\s+#.*$/, "");
  const scalarHeader = header.replace(/^(?:(?:!\S+|&\S+)\s+)*/, "");
  if (!/^[>|](?:(?:[1-9][+-]?)|(?:[+-][1-9]?))?$/.test(scalarHeader)) return value;

  const block: string[] = [];
  let contentIndent = Number(scalarHeader.match(/[1-9]/)?.[0] ?? 0);
  for (const line of lines.slice(index + 1)) {
    if (line.trim() === "") {
      if (block.length) block.push("");
      continue;
    }
    const leading = line.match(/^ */)?.[0].length ?? 0;
    const isComment = line.slice(leading).startsWith("#");
    if (!contentIndent) {
      if (!leading) {
        if (isComment) continue;
        break;
      }
      contentIndent = leading;
    }
    if (leading < contentIndent) {
      if (isComment) continue;
      break;
    }
    block.push(line.slice(contentIndent).trimEnd());
  }
  return block.join(" ");
}

function parse(file: string, suppliedText?: string, dirOverride?: string, source?: Skill["source"]): Skill | null {
  let text: string;
  if (suppliedText !== undefined) text = suppliedText;
  else try { text = readFileSync(file, "utf-8"); }
  catch { return null; }
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
    description = frontmatterDescription(fm[1]);
    const m = fm[1].match(/^match:\s*(.+)$/m);
    if (m) match = m[1].trim();
  }
  return { name, description: description.replace(/\s+/g, " ").slice(0, 120), body: body.trim(), dir: dirOverride ?? dirname(file), match, source };
}

function addSkillFile(file: string, out: Skill[], seen: Set<string>, text?: string, dirOverride?: string, source?: Skill["source"]): void {
  const skill = parse(file, text, dirOverride, source);
  // The `computer` tool executes scripts from this support pack. Project prompts may describe
  // computer use, but cannot shadow its trusted user/bundled implementation.
  if (source === "project" && skill?.name === "computer-use") return;
  if (skill && !seen.has(skill.name)) {
    seen.add(skill.name);
    out.push(skill);
  }
}

function addSkillDir(dir: string, out: Skill[], seen: Set<string>, source: "user" | "builtin"): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let file = "";
    try {
      if (entry.endsWith(".md") && statSync(p).isFile()) file = p;
      else if (statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"))) file = join(p, "SKILL.md");
    } catch {
      continue;
    }
    if (file) addSkillFile(file, out, seen, undefined, undefined, source);
  }
}

export function listSkills(cwd = process.cwd(), home = homeDir()): Skill[] {
  const out: Skill[] = [];
  const seen = new Set<string>();
  addSkillDir(trustedSkillDirs(home)[0], out, seen, "user");
  const project = inspectProjectTrust(cwd, home);
  if (project.state === "trusted") {
    const prefix = ".neko-core/skills/";
    for (const file of Object.values(project.projectFiles)) {
      if (!file.relative.startsWith(prefix)) continue;
      const suffix = file.relative.slice(prefix.length);
      if (/^[^/]+\.md$/.test(suffix) || /^[^/]+\/SKILL\.md$/.test(suffix)) {
        // Project skills are prompt-only. Do not expose their mutable live directory as an
        // executable support pack; mutations revoke the next inspection instead.
        addSkillFile(file.path, out, seen, file.bytes.toString("utf-8"), "", "project");
      }
    }
  }
  addSkillDir(trustedSkillDirs(home)[1], out, seen, "builtin");
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function listNonProjectSkills(home: string): Skill[] {
  const out: Skill[] = [];
  const [userDir, builtinDir] = trustedSkillDirs(home);
  // Capability proof checks both trusted catalogs independently. User overrides still apply to the
  // normal model-facing catalog, but an override must not erase a built-in widening signal here.
  addSkillDir(userDir, out, new Set<string>(), "user");
  if (!existsSync(builtinDir) || !statSync(builtinDir).isDirectory()) {
    throw new Error("built-in skill catalog is unavailable");
  }
  addSkillDir(builtinDir, out, new Set<string>(), "builtin");
  if (!out.some((skill) => skill.source === "builtin")) {
    throw new Error("built-in skill catalog is empty");
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkill(name: string, cwd = process.cwd(), home = homeDir()): Skill | null {
  return listSkills(cwd, home).find((s) => s.name === name) ?? null;
}

/** Progressive disclosure (SOTA): inject just the skill names + one-line descriptions into context
 * (~cheap) so the model KNOWS what domain capabilities exist and can pull the full instructions in
 * on demand via the `skill` tool — never bloating context with skill bodies it isn't using. */
export function skillsContextBlock(registry?: Pick<ToolRegistry, "isToolAvailable" | "loadSkill" | "noTools" | "skillUnavailableReason">, cwd = process.cwd(), home = homeDir()): string {
  if (registry && (registry.noTools || !registry.isToolAvailable("skill") || !registry.loadSkill)) return "";
  const list = listSkills(cwd, home).filter((skill) => !registry?.skillUnavailableReason(skill.name));
  if (!list.length) return "";
  const CAP = 50;
  const lines = list.slice(0, CAP).map((s) => `- ${s.name}: ${s.description || "(no description)"}`);
  if (list.length > CAP) lines.push(`- ... +${list.length - CAP} more`);
  return (
    "# NEKO SKILL CATALOG\n" +
    "Every exact name below is callable only through Neko's dynamic `skill` tool. Provider-native skill " +
    "names are a separate catalog and are not callable through this tool. IMPORTANT: if the user's task matches a skill's " +
    "description below, you MUST call the `skill` tool to load it BEFORE planning or acting — the skill " +
    "carries required domain rules and bundled tools you otherwise lack. Exception: for a single-file microtask " +
    "with an exact target/test and no domain-specific machinery, skip generic debugging/TDD skills and inspect, edit, " +
    "then verify directly; domain, security, artifact-format, browser, GUI, and research skills remain mandatory. " +
    "Do not ask Neko's `skill` tool for " +
    "a provider-native name. Don't hand-roll a task a Neko skill covers.\n" +
    lines.join("\n")
  );
}

const GENERIC_MICROTASK_SKILLS = new Set(["systematic-debugging", "test-driven-development"]);
const MICROTASK_SKILL_REASON =
  "exact single-file inspect/edit/verify microtask; inspect the named file, make the smallest change, and run the requested tests directly";

export function isGenericMicrotaskSkill(name: string): boolean {
  return GENERIC_MICROTASK_SKILLS.has(name);
}

export function explicitSkillRequest(userText: string, name: string): boolean {
  const text = normalizeSkillText(userText);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|\\s)(?:/skill\\s+|\\$)${escaped}\\b`, "i").test(text)) return true;
  const request = new RegExp(
    `\\b(?:use|load|apply|invoke|follow|call|run|read|dung|su dung|nap|ap dung|goi|doc)\\s+` +
    `(?:the\\s+)?(?:skill\\s+)?${escaped}(?:\\s+skill)?\\b`,
    "gi",
  );
  for (const match of text.matchAll(request)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
    if (!/(?:do not|don't|dont|never|avoid|skip|khong|dung)\s*$/i.test(prefix)) return true;
  }
  return false;
}

/** Project metadata cannot turn ordinary words into capability authority. A project skill therefore
 * needs provider-style explicit syntax or an adjacent `skill` marker around its exact name. */
export function explicitProjectSkillRequest(userText: string, name: string): boolean {
  const text = normalizeSkillText(userText);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|\\s)(?:/skill\\s+|\\$)${escaped}\\b`, "i").test(text)) return true;
  const marked = new RegExp(`\\b(?:skill\\s+${escaped}|${escaped}\\s+skill)\\b`, "i");
  return marked.test(text) && explicitSkillRequest(userText, name);
}

function hasExplicitSkillRequest(userText: string): boolean {
  const text = normalizeSkillText(userText);
  if (/(?:^|\s)(?:\/skill\s+|\$)[\w.-]+\b/i.test(text)) return true;
  const request = /\b(?:use|load|apply|invoke|follow|call|run|read|dung|su dung|nap|ap dung|goi|doc)\s+(?:the\s+)?(?:[\w.-]+\s+skill|skill\s+[\w.-]+)\b/gi;
  for (const match of text.matchAll(request)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
    if (!/(?:do not|don't|dont|never|avoid|skip|khong|dung)\s*$/i.test(prefix)) return true;
  }
  return false;
}

/** A deliberately narrow trajectory shortcut: one named source file, an explicit validator, and an
 * explicit request for the smallest fix. Ambiguous, broad, domain-specific, or research work stays on
 * the normal skill path. */
export function isSingleFileMicrotask(userText: string): boolean {
  const text = normalizeSkillText(userText).replace(/[’]/g, "'");
  if (hasExplicitSkillRequest(text)) return false;
  if ([...GENERIC_MICROTASK_SKILLS].some((name) => explicitSkillRequest(text, name))) return false;
  if (/https?:\/\//i.test(text)) return false;
  if (/\b(?:research|investigat\w*|look up|authoritative|documentation|docs|papers?|literature|latest|newest|sota|benchmark|internet|web search|security|auth\w*|bypass|inject\w*|xss|csrf|credential\w*|secrets?|crypt\w*|permissions?|access control|sandbox|vulnerab\w*|threat\w*|exploit\w*|malware|unsafe|audit|browser|chrome|firefox|gui|\bui\b|\bux\b|tui|frontend|rendering|dom|html|css|accessibility|a11y|aria|layout|typography|animation|screenshot|visual|image|photo|video|artifact|csv|document|spreadsheet|presentation|word|excel|powerpoint|docx|xlsx|pptx|pdf|database|sql|docker|container|procurement|purchase|pricing|messenger|zalo|wechat)\b/i.test(text)) return false;
  if (/\b(?:refactor|redesign|architect\w*|migration|new feature|multiple files|several files|whole (?:repo|repository|codebase)|entire (?:repo|repository|codebase)|across (?:the )?(?:repo|repository|codebase))\b/i.test(text)) return false;

  const paths = mentionedFilePaths(userText);
  if (paths.size !== 1) return false;

  const change = /\b(?:fix|correct|repair|edit|change|replace|patch|sua|chinh)\b/i.test(text);
  const validate = /\b(?:run|rerun|execute|chay)\b.{0,32}\btests?\b|\btests?\b.{0,32}\bpass(?:es|ed)?\b|\b(?:bun|npm|pnpm|yarn)\s+test\b|\b(?:pytest|vitest|jest|cargo test|go test)\b/i.test(text);
  const bounded = /\b(?:smallest|minimal|single[ -]file|one[ -](?:line|character|file)|typo|exact(?:ly)?|nho nhat|toi thieu)\b/i.test(text);
  return change && validate && bounded;
}

function mentionedFilePaths(userText: string): Map<string, string> {
  const paths = new Map<string, string>();
  const pathPattern = /(?:^|[\s"'`(])((?:\.{1,2}[\\/])?(?:[\w@.-]+[\\/])+[\w@.-]+\.[a-z0-9]{1,12})(?=$|[\s"'`,;:)])/gi;
  for (const match of userText.matchAll(pathPattern)) {
    const original = match[1].replaceAll("\\", "/");
    const key = original.toLowerCase();
    if (!paths.has(key)) paths.set(key, original);
  }
  return paths;
}

/** Exact path carried by the existing proof-grade microtask predicate, preserving source casing. */
export function singleFileMicrotaskPath(userText: string): string | null {
  if (!isSingleFileMicrotask(userText)) return null;
  const paths = mentionedFilePaths(userText);
  return paths.size === 1 ? [...paths.values()][0] : null;
}

/** Pure name-level decision. Only the two known generic process skills are suppressible, and an
 * explicit request for either wins. The host hides the whole tool only after ruling out domain routes. */
export function skillUnavailableForTurn(name: string, userText: string): string | null {
  if (!GENERIC_MICROTASK_SKILLS.has(name)) return null;
  if (!isSingleFileMicrotask(userText) || explicitSkillRequest(userText, name)) return null;
  return MICROTASK_SKILL_REASON;
}

export function applySkillPolicyForTurn(
  registry: Pick<ToolRegistry, "setSkillPolicyForTurn">,
  userText: string,
  cwd = process.cwd(),
  home = homeDir(),
): void {
  registry.setSkillPolicyForTurn(undefined);
  const hasExplicitInstalledSkill = listSkills(cwd, home)
    .some((skill) => explicitSkillRequest(userText, skill.name));
  const hasDomainRoute = matchSkills(userText, 3, cwd, home)
    .some((skill) => !GENERIC_MICROTASK_SKILLS.has(skill.name));
  if (!isSingleFileMicrotask(userText) || hasExplicitInstalledSkill || hasDomainRoute) {
    return;
  }
  registry.setSkillPolicyForTurn(
    (name) => skillUnavailableForTurn(name, userText),
    MICROTASK_SKILL_REASON,
  );
}

const SKILL_STOP = new Set(
  ("the a an and or for to of in on at by with you your i it is are be do can will this that these those" +
   " cua cho voi cac mot nay tai khi ban toi lam gium giup hay duoc khong neu thi va la").split(/\s+/),
);
function normalizeSkillText(s: string): string {
  return s.normalize("NFKD").toLowerCase().replace(/\p{Mark}/gu, "").replace(/đ/g, "d");
}
function skillTokens(s: string): Set<string> {
  return new Set(
    normalizeSkillText(s).replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/).filter((w) => w.length >= 3 && !SKILL_STOP.has(w)),
  );
}

function regexMatches(skill: Skill, userText: string): boolean {
  if (!skill.match) return false;
  try {
    const pattern = new RegExp(skill.match, "i");
    return pattern.test(userText) || pattern.test(normalizeSkillText(userText));
  } catch {
    return false; // a malformed user-authored pattern must not break the REPL
  }
}

function overlapScore(skill: Skill, userTokens: Set<string>): number {
  let hits = 0;
  for (const word of skillTokens(`${skill.name} ${skill.description}`)) if (userTokens.has(word)) hits++;
  return hits;
}

/** Test one named capability independently of competing skills. UX preflights must not disappear merely
 * because a compositional request also matches procurement, browser work, or another stronger route. */
export function matchesSkill(name: string, userText: string, cwd = process.cwd(), home = homeDir()): boolean {
  const skill = loadSkill(name, cwd, home);
  if (!skill) return false;
  if (skill.match) return regexMatches(skill, userText);
  const userTokens = skillTokens(userText);
  return userTokens.size >= 3 && overlapScore(skill, userTokens) >= 4;
}

/** Bounded skill shortlist: explicit activation metadata wins, then at most one strong lexical route is
 * added. This preserves compositional tasks without injecting the full skill catalog into context. */
export function matchSkills(userText: string, limit = 3, cwd = process.cwd(), home = homeDir()): Skill[] {
  return routeSkills(listSkills(cwd, home), userText, limit);
}

/** Capability planning may trust built-in/user-global routing policy, but project-authored metadata
 * is prompt data and cannot widen a turn surface. An explicitly named project skill is handled
 * separately from the raw user envelope. */
export function matchNonProjectSkills(userText: string, limit = 3, cwd = process.cwd(), home = homeDir()): Skill[] {
  void cwd; // Deliberately do not inspect project metadata at this authority boundary.
  return routeSkills(listNonProjectSkills(home), userText, limit);
}

function routeSkills(skills: Skill[], userText: string, limit: number): Skill[] {
  // Deterministic trigger first: a skill's frontmatter `match` regex is an unambiguous signal (e.g. a
  // platform URL for web-reach) - load it directly, since description token-overlap is too coarse to catch
  // short or other-language asks (a Vietnamese "lay transcript youtube ..." shares only ~3 English tokens).
  const routed = skills.filter((skill) => regexMatches(skill, userText));
  const ut = skillTokens(userText);
  if (ut.size >= 3) {
    let best: Skill | null = null;
    let bestScore = 0;
    for (const skill of skills) {
      const score = overlapScore(skill, ut);
      if (score > bestScore) { bestScore = score; best = skill; }
    }
    if (bestScore >= 4 && best && !routed.some((skill) => skill.name === best!.name)) routed.push(best);
  }
  return routed.slice(0, Math.max(0, Math.floor(limit)));
}

/** Backwards-compatible best route for callers that need one skill. */
export function matchSkill(userText: string, cwd = process.cwd(), home = homeDir()): Skill | null {
  return matchSkills(userText, 1, cwd, home)[0] ?? null;
}

export function renderSkills(cwd = process.cwd(), home = homeDir()): string {
  const list = listSkills(cwd, home);
  if (!list.length) {
    return "No skills found. Add *.md to ~/.neko-core/skills/ or ./.neko-core/skills/.";
  }
  return ["Neko Core skills:", ...list.map((s) => `- ${s.name}${s.description ? "  " + s.description : ""}`)].join("\n");
}
