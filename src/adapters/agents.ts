/**
 * Subagent types: named agent definitions the `task` tool can target. A `*.md` in
 * ~/.neko-core/agents/ or ./.neko-core/agents/ defines one — frontmatter `description`, body is the
 * agent's system prompt (its role). `task(prompt, subagent_type: "reviewer")` runs a sub-agent with
 * that prompt. Available types are injected into context so the model knows what it can delegate to.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { join } from "node:path";
import { inspectProjectTrust } from "./project-trust.ts";

export interface AgentDef {
  name: string;
  description: string;
  body: string;
}

/** Built-in roles are always available in a fresh install. User and trusted-project definitions
 * with the same name intentionally win, while the core capability policy remains authoritative. */
export const BUILTIN_AGENT_DEFS: readonly AgentDef[] = [
  {
    name: "coder",
    description: "Bounded implementation worker: inspects, changes, and verifies the requested task.",
    body: [
      "You are Neko's implementation worker.",
      "Stay within the delegated task and inherited approval boundaries.",
      "Inspect before editing, make the smallest coherent change, verify it with relevant evidence,",
      "and report changed files, checks run, and any remaining uncertainty.",
    ].join(" "),
  },
  {
    name: "explorer",
    description: "Read-only mapper: locates code, relationships, and evidence without changing state.",
    body: [
      "You are Neko's read-only exploration worker.",
      "Map the delegated area, locate relevant paths and symbols, and return concise evidence.",
      "Do not edit files, run mutating commands, or claim that state changed.",
    ].join(" "),
  },
  {
    name: "reviewer",
    description: "Read-only critic: finds correctness, safety, and regression risks with evidence.",
    body: [
      "You are Neko's read-only review worker.",
      "Review only the delegated scope. Prioritize concrete correctness, safety, and regression risks,",
      "cite paths and evidence, distinguish verified findings from hypotheses, and do not edit files.",
    ].join(" "),
  },
] as const;

function parse(file: string, suppliedText?: string): AgentDef | null {
  let text: string;
  if (suppliedText !== undefined) text = suppliedText;
  else try { text = readFileSync(file, "utf-8"); }
  catch { return null; }
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

function addAgent(file: string, out: AgentDef[], seen: Set<string>, text?: string): void {
  const agent = parse(file, text);
  const key = agent?.name.trim().toLowerCase();
  if (agent && key && !seen.has(key)) {
    seen.add(key);
    out.push(agent);
  }
}

export function listAgents(cwd = process.cwd(), home = homeDir()): AgentDef[] {
  const out: AgentDef[] = [];
  const seen = new Set<string>();
  const userDir = join(home, ".neko-core", "agents");
  if (existsSync(userDir)) {
    for (const entry of readdirSync(userDir)) {
      if (!entry.endsWith(".md")) continue;
      const p = join(userDir, entry);
      try {
        if (!statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      addAgent(p, out, seen);
    }
  }
  const project = inspectProjectTrust(cwd, home);
  if (project.state === "trusted") {
    const prefix = ".neko-core/agents/";
    for (const file of Object.values(project.projectFiles)) {
      if (!file.relative.startsWith(prefix)) continue;
      const suffix = file.relative.slice(prefix.length);
      if (/^[^/]+\.md$/.test(suffix)) addAgent(file.path, out, seen, file.bytes.toString("utf-8"));
    }
  }
  for (const agent of BUILTIN_AGENT_DEFS) {
    const key = agent.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...agent });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadAgent(name: string, cwd = process.cwd(), home = homeDir()): AgentDef | null {
  const wanted = name.trim().toLowerCase();
  return listAgents(cwd, home).find((a) => a.name.toLowerCase() === wanted) ?? null;
}

/** A one-line-per-agent context block so the model knows which subagent types it can delegate to. */
export function agentsContextBlock(cwd = process.cwd(), home = homeDir()): string {
  const list = listAgents(cwd, home);
  if (!list.length) return "";
  return ["Available subagent types for the `task` tool (pass as subagent_type):", ...list.map((a) => `- ${a.name}: ${a.description || "(no description)"}`)].join("\n");
}

export function renderAgents(cwd = process.cwd(), home = homeDir()): string {
  const list = listAgents(cwd, home);
  if (!list.length) {
    return "No subagent types. Add *.md to ~/.neko-core/agents/ or ./.neko-core/agents/ (body = the agent's system prompt).";
  }
  return ["Neko subagent types:", ...list.map((a) => `- ${a.name}${a.description ? "  " + a.description : ""}`)].join("\n");
}
