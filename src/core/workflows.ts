/**
 * Workflow memory (AWM-style procedural memory — the frontier beyond factual memory). Where `memory`
 * stores durable FACTS, workflows store reusable PROCEDURES the agent LEARNED by doing: the steps,
 * tools, and gotchas of a task that worked, distilled so a similar task next time is faster + more
 * reliable. Files live in ~/.neko-core/workflows/*.md; an index is injected each turn so the agent
 * recalls a matching procedure JIT and follows it. This makes the agent self-improving across sessions.
 * Pure + node-only (stays core), mirroring `memory.ts`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { join } from "node:path";

function wfDir(): string {
  return join(homeDir(), ".neko-core", "workflows");
}

/** Confine a name to the workflows dir: basename only, .md, no path escape. */
function safeName(raw: string): string {
  const base = String(raw).replace(/[\\/]/g, "-").replace(/\.\.+/g, ".").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+/, "");
  const trimmed = base || "workflow";
  return trimmed.endsWith(".md") ? trimmed : trimmed + ".md";
}

/** First non-empty line of a workflow file (its self-description / when-to-use), markers stripped. */
function summaryOf(file: string): string {
  try {
    const first = readFileSync(join(wfDir(), file), "utf-8").split("\n").find((l) => l.trim()) ?? "";
    return first.replace(/^#+\s*/, "").replace(/^-\s*/, "").slice(0, 100);
  } catch {
    return "";
  }
}

export function listWorkflows(): { name: string; summary: string }[] {
  const dir = wfDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f, summary: summaryOf(f) }));
}

/** The `workflow` tool: list | read | write | delete | search, scoped to ~/.neko-core/workflows/. */
export function workflowTool(args: Record<string, any>): string {
  const action = String(args.action ?? "").toLowerCase();
  const dir = wfDir();
  switch (action) {
    case "list": {
      const w = listWorkflows();
      return w.length ? w.map((x) => `- ${x.name}: ${x.summary}`).join("\n") : "(no workflows learned yet)";
    }
    case "read": {
      const p = join(dir, safeName(args.name));
      return existsSync(p) ? readFileSync(p, "utf-8") : `(no workflow '${safeName(args.name)}')`;
    }
    case "write": {
      mkdirSync(dir, { recursive: true });
      const name = safeName(args.name);
      writeFileSync(join(dir, name), String(args.content ?? ""), "utf-8");
      return `Saved workflow '${name}'`;
    }
    case "delete": {
      const p = join(dir, safeName(args.name));
      if (!existsSync(p)) return `(no workflow '${safeName(args.name)}')`;
      rmSync(p);
      return `Deleted workflow '${safeName(args.name)}'`;
    }
    case "search": {
      const q = String(args.query ?? "").toLowerCase();
      if (!q) return "Error: search needs a query";
      const hits = listWorkflows().filter((w) => {
        try {
          return (w.name + "\n" + readFileSync(join(dir, w.name), "utf-8")).toLowerCase().includes(q);
        } catch {
          return false;
        }
      });
      return hits.length ? hits.map((x) => `- ${x.name}: ${x.summary}`).join("\n") : `(no workflow matches '${q}')`;
    }
    default:
      return "Error: workflow action must be one of list | read | write | delete | search";
  }
}

/** Workflow index injected into context each turn — the agent sees what procedures it has learned and
 * recalls a matching one JIT (read it, then follow it) before redoing a similar task from scratch. */
export function workflowsContextBlock(): string {
  const w = listWorkflows();
  if (!w.length) return "";
  const CAP = 40;
  const lines = w.slice(0, CAP).map((x) => `- ${x.name}: ${x.summary}`);
  if (w.length > CAP) lines.push(`- ... +${w.length - CAP} more (use \`workflow search\`)`);
  return (
    "Learned workflows (reusable procedures from past tasks). BEFORE redoing a task that matches one, " +
    "`workflow read` it and follow the steps. AFTER finishing a non-trivial task whose approach would " +
    "help next time, `workflow write` a short procedure (when-to-use on line 1, then the steps/tools/" +
    "gotchas) - UPDATE a close existing one here instead of duplicating. This is how you get faster + " +
    "more reliable over time:\n" +
    lines.join("\n")
  );
}

/** Deterministic recall: if the user's task strongly overlaps a learned workflow's name+summary, return
 * it so the procedure is in play even if the model wouldn't pull it (mirrors the skill auto-loader). */
export function matchWorkflow(userText: string): { name: string; body: string } | null {
  const stop = new Set("the a an and or for to of in on at by with you your this that these those is are be do can how".split(/\s+/));
  const toks = (s: string) =>
    new Set(
      s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/).filter((t) => t.length >= 3 && !stop.has(t)),
    );
  const ut = toks(userText);
  if (ut.size < 3) return null;
  let best: { name: string; summary: string } | null = null;
  let bestScore = 0;
  for (const w of listWorkflows()) {
    let hits = 0;
    for (const t of toks(`${w.name} ${w.summary}`)) if (ut.has(t)) hits++;
    if (hits > bestScore) { bestScore = hits; best = w; }
  }
  if (!best || bestScore < 4) return null;
  try {
    return { name: best.name, body: readFileSync(join(wfDir(), best.name), "utf-8") };
  } catch {
    return null;
  }
}
