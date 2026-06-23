/**
 * Agent-managed memory (SOTA 2026 "memory tool", file-based — no vector DB). The agent stores durable
 * facts/preferences/learnings in ~/.neko-core/memory/*.md across sessions and recalls them on demand
 * (JIT), keeping the active context lean. An index of memory files is injected each turn so the agent
 * knows what it remembers; it reads/searches the relevant ones itself. Pure + node-only (stays core).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function memDir(): string {
  return join(homedir(), ".neko-core", "memory");
}

/** Confine a name to the memory dir: basename only, .md, no path escape. */
function safeName(raw: string): string {
  const base = String(raw).replace(/[\\/]/g, "-").replace(/\.\.+/g, ".").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+/, "");
  const trimmed = base || "note";
  return trimmed.endsWith(".md") ? trimmed : trimmed + ".md";
}

/** First non-empty line of a memory file (its self-description), markers stripped. */
function summaryOf(file: string): string {
  try {
    const first = readFileSync(join(memDir(), file), "utf-8").split("\n").find((l) => l.trim()) ?? "";
    return first.replace(/^#+\s*/, "").replace(/^-\s*/, "").slice(0, 90);
  } catch {
    return "";
  }
}

export function listMemories(): { name: string; summary: string }[] {
  const dir = memDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f, summary: summaryOf(f) }));
}

/** The `memory` tool: list | read | write | delete | search, scoped to ~/.neko-core/memory/. */
export function memoryTool(args: Record<string, any>): string {
  const action = String(args.action ?? "").toLowerCase();
  const dir = memDir();
  switch (action) {
    case "list": {
      const m = listMemories();
      return m.length ? m.map((x) => `- ${x.name}: ${x.summary}`).join("\n") : "(no memories yet)";
    }
    case "read": {
      const p = join(dir, safeName(args.name));
      return existsSync(p) ? readFileSync(p, "utf-8") : `(no memory '${safeName(args.name)}')`;
    }
    case "write": {
      mkdirSync(dir, { recursive: true });
      const name = safeName(args.name);
      writeFileSync(join(dir, name), String(args.content ?? ""), "utf-8");
      return `Saved memory '${name}'`;
    }
    case "delete": {
      const p = join(dir, safeName(args.name));
      if (!existsSync(p)) return `(no memory '${safeName(args.name)}')`;
      rmSync(p);
      return `Deleted memory '${safeName(args.name)}'`;
    }
    case "search": {
      const q = String(args.query ?? "").toLowerCase();
      if (!q) return "Error: search needs a query";
      const hits = listMemories().filter((m) => {
        try {
          return (m.name + "\n" + readFileSync(join(dir, m.name), "utf-8")).toLowerCase().includes(q);
        } catch {
          return false;
        }
      });
      return hits.length ? hits.map((x) => `- ${x.name}: ${x.summary}`).join("\n") : `(no memory matches '${q}')`;
    }
    default:
      return "Error: memory action must be one of list | read | write | delete | search";
  }
}

/** Memory index injected into context each turn — the agent sees what it remembers and recalls JIT. */
export function memoryIndexBlock(): string {
  const m = listMemories();
  if (!m.length) return "";
  return (
    "Saved memories (read/update with the `memory` tool; recall relevant ones before you work, " +
    "and record durable facts/preferences/learnings you'll want next session):\n" +
    m.map((x) => `- ${x.name}: ${x.summary}`).join("\n")
  );
}
