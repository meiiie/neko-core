/**
 * Subagent types: named agent definitions the `task` tool can target. A `*.md` in
 * ~/.neko-core/agents/ or ./.neko-core/agents/ defines one — frontmatter `description`, body is the
 * agent's system prompt (its role). `task(prompt, subagent_type: "reviewer")` runs a sub-agent with
 * that prompt. Available types are injected into context so the model knows what it can delegate to.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { join } from "node:path";

export interface AgentDef {
  name: string;
  description: string;
  body: string;
}

function agentDirs(): string[] {
  return [join(homeDir(), ".neko-core", "agents"), join(process.cwd(), ".neko-core", "agents")];
}

function parse(file: string): AgentDef | null {
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

export function listAgents(): AgentDef[] {
  const out: AgentDef[] = [];
  const seen = new Set<string>();
  for (const dir of agentDirs()) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const p = join(dir, entry);
      try {
        if (!statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      const a = parse(p);
      if (a && !seen.has(a.name)) {
        seen.add(a.name);
        out.push(a);
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadAgent(name: string): AgentDef | null {
  return listAgents().find((a) => a.name === name) ?? null;
}

/** A one-line-per-agent context block so the model knows which subagent types it can delegate to. */
export function agentsContextBlock(): string {
  const list = listAgents();
  if (!list.length) return "";
  return ["Available subagent types for the `task` tool (pass as subagent_type):", ...list.map((a) => `- ${a.name}: ${a.description || "(no description)"}`)].join("\n");
}

export function renderAgents(): string {
  const list = listAgents();
  if (!list.length) {
    return "No subagent types. Add *.md to ~/.neko-core/agents/ or ./.neko-core/agents/ (body = the agent's system prompt).";
  }
  return ["Neko subagent types:", ...list.map((a) => `- ${a.name}${a.description ? "  " + a.description : ""}`)].join("\n");
}
