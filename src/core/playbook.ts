/**
 * Playbook — ACE (Agentic Context Engineering, arXiv 2510.04618), clean-room. An evolving, ALWAYS-in-
 * context list of operating strategies/lessons the agent refines from its own runs. Distinct from the
 * other memory legs: `memory` = facts (JIT), `workflows` = task procedures (JIT-recalled), but the
 * playbook shapes HOW the agent operates EVERY turn. The ACE-specific mechanic is incremental DELTA
 * updates (add one bullet / revise one bullet) + grow-and-refine de-dup — never rewriting the whole
 * thing into a vague summary ("context collapse"), which is what loses hard-won detail over time.
 * One bullet per line in ~/.neko-core/playbook.md. Pure + node-only (stays core), mirroring memory.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { join } from "node:path";

const MAX_BULLETS = 80; // keep the always-on injection bounded; over this, the oldest is dropped

function pbFile(): string {
  return join(homeDir(), ".neko-core", "playbook.md");
}

function readBullets(): string[] {
  try {
    return readFileSync(pbFile(), "utf-8")
      .split("\n")
      .map((l) => l.replace(/^\s*-\s?/, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeBullets(bullets: string[]): void {
  const dir = join(homeDir(), ".neko-core");
  mkdirSync(dir, { recursive: true });
  writeFileSync(pbFile(), bullets.map((b) => `- ${b}`).join("\n") + "\n", "utf-8");
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The `playbook` tool: read | add | revise | remove — incremental delta edits (ACE Curator). */
export function playbookTool(args: Record<string, any>): string {
  const action = String(args.action ?? "").toLowerCase();
  const bullets = readBullets();
  switch (action) {
    case "read":
      return bullets.length ? bullets.map((b) => `- ${b}`).join("\n") : "(playbook is empty)";
    case "add": {
      const text = String(args.content ?? "").replace(/\s+/g, " ").trim();
      if (!text) return "Error: add needs content";
      // grow-and-refine: skip a near-duplicate (one bullet already covers it) to avoid bloat.
      if (bullets.some((b) => norm(b) === norm(text) || norm(b).includes(norm(text)) || norm(text).includes(norm(b)))) {
        return "(a similar bullet already exists - revise it instead of adding a duplicate)";
      }
      bullets.push(text);
      while (bullets.length > MAX_BULLETS) bullets.shift(); // drop oldest, stay bounded
      writeBullets(bullets);
      return `Added playbook bullet (${bullets.length} total)`;
    }
    case "revise": {
      const find = norm(String(args.find ?? ""));
      const text = String(args.content ?? "").replace(/\s+/g, " ").trim();
      if (!find || !text) return "Error: revise needs `find` (text in the bullet) and `content` (the refined bullet)";
      const i = bullets.findIndex((b) => norm(b).includes(find));
      if (i < 0) return `(no playbook bullet matching '${args.find}')`;
      bullets[i] = text; // anti-collapse: refine ONE bullet, keep the rest verbatim
      writeBullets(bullets);
      return "Revised playbook bullet";
    }
    case "remove": {
      const find = norm(String(args.find ?? ""));
      if (!find) return "Error: remove needs `find`";
      const next = bullets.filter((b) => !norm(b).includes(find));
      if (next.length === bullets.length) return `(no playbook bullet matching '${args.find}')`;
      writeBullets(next);
      return `Removed ${bullets.length - next.length} bullet(s)`;
    }
    default:
      return "Error: playbook action must be one of read | add | revise | remove";
  }
}

/** The playbook injected into context EVERY turn (ACE: the evolving operating context). Bounded. */
export function playbookContextBlock(): string {
  const bullets = readBullets();
  if (!bullets.length) return "";
  return (
    "Your operating playbook (lessons you've learned - apply them). After a task, especially one that " +
    "was non-obvious or went wrong, REFLECT and `playbook add` a specific reusable lesson, or `playbook " +
    "revise` an existing one to sharpen it (one bullet at a time; merge near-duplicates; keep specifics, " +
    "never collapse to vague advice):\n" +
    bullets.map((b) => `- ${b}`).join("\n")
  );
}
