import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BUILTIN_AGENT_DEFS, agentsContextBlock, listAgents, loadAgent } from "../src/adapters/agents.ts";
import { AGENTS as REGISTRY_AGENTS } from "../src/adapters/registry.ts";

const roots: string[] = [];

function fixture(): { root: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), "neko-agents-"));
  roots.push(base);
  const root = join(base, "project");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("built-in subagent roles", () => {
  test("fresh installs expose real role prompts aligned with the registry", () => {
    const { root, home } = fixture();
    const listed = listAgents(root, home);
    expect(listed.map((agent) => agent.name)).toEqual(["coder", "explorer", "reviewer"]);
    expect(BUILTIN_AGENT_DEFS.map((agent) => agent.name)).toEqual(REGISTRY_AGENTS.map((agent) => agent.name));
    expect(loadAgent("Reviewer", root, home)?.body).toContain("read-only review worker");
    expect(agentsContextBlock(root, home)).toContain("- explorer: Read-only mapper");
  });

  test("a user definition overrides a built-in name case-insensitively", () => {
    const { root, home } = fixture();
    const dir = join(home, ".neko-core", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Reviewer.md"), "---\ndescription: Personal reviewer\n---\nPERSONAL_REVIEW_ROLE\n");

    const reviewer = loadAgent("reviewer", root, home);
    expect(reviewer?.name).toBe("Reviewer");
    expect(reviewer?.description).toBe("Personal reviewer");
    expect(reviewer?.body).toBe("PERSONAL_REVIEW_ROLE");
    expect(listAgents(root, home).filter((agent) => agent.name.toLowerCase() === "reviewer")).toHaveLength(1);
  });
});
