/**
 * Playbook — ACE (Agentic Context Engineering, arXiv 2510.04618), clean-room. An evolving, lossless
 * list of operating strategies/lessons the agent refines from its own runs; a compact index is always in
 * context and exact lessons are retrieved on demand. Distinct from the
 * other memory legs: `memory` = facts (JIT), `workflows` = task procedures (JIT-recalled), but the
 * playbook shapes HOW the agent operates EVERY turn. The ACE-specific mechanic is incremental DELTA
 * updates (add one bullet / revise one bullet) + grow-and-refine de-dup — never rewriting the whole
 * thing into a vague summary ("context collapse"), which is what loses hard-won detail over time.
 * One bullet per line in ~/.neko-core/playbook.md. Pure + node-only (stays core), mirroring memory.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { join } from "node:path";

const MAX_BULLETS = 80; // durable store; over this, the oldest is dropped
const CONTEXT_BULLETS = 40;
const CONTEXT_EXCERPT_CHARS = 180;

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

/** The `playbook` tool: read/search + incremental delta edits (ACE Curator). */
export function playbookTool(args: Record<string, any>): string {
  const action = String(args.action ?? "").toLowerCase();
  const bullets = readBullets();
  switch (action) {
    case "read":
      return bullets.length ? bullets.map((b) => `- ${b}`).join("\n") : "(playbook is empty)";
    case "search": {
      const terms = norm(String(args.query ?? "")).split(" ").filter((term) => term.length >= 2);
      if (!terms.length) return "Error: search needs a query";
      const hits = bullets.filter((bullet) => {
        const text = norm(bullet);
        return terms.every((term) => text.includes(term));
      });
      return hits.length ? hits.map((b) => `- ${b}`).join("\n") : `(no playbook bullet matches '${args.query}')`;
    }
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
      return "Error: playbook action must be one of read | search | add | revise | remove";
  }
}

/** Compact always-on index. Full lessons stay losslessly on disk and are pulled with read/search.
 * This preserves ACE's anti-collapse property without re-sending multi-paragraph bullets every step. */
export function playbookContextBlock(): string {
  const bullets = readBullets();
  if (!bullets.length) return "";
  const visible = bullets.slice(-CONTEXT_BULLETS);
  const lines = visible.map((bullet) => {
    const excerpt = bullet.length > CONTEXT_EXCERPT_CHARS
      ? `${bullet.slice(0, CONTEXT_EXCERPT_CHARS - 3).trimEnd()}...`
      : bullet;
    return `- ${excerpt}`;
  });
  if (bullets.length > visible.length) lines.unshift(`- ... ${bullets.length - visible.length} older lessons (use \`playbook search\`)`);
  return (
    "Your operating playbook index (excerpts only; use `playbook search`/`read` for the lossless lessons). " +
    "Apply relevant lessons; after non-obvious work, add or revise one specific reusable lesson without " +
    "collapsing existing detail:\n" +
    lines.join("\n")
  );
}
