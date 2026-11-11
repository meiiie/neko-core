import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskScope, revokeTaskScope } from "../src/core/task-scope.ts";
import { memoryTool, readMemoryFile, setMemoryEnabled, taskMemoryDirectory, withTaskMemoryWriter } from "../src/core/memory.ts";
import { dreamDigest, type DreamInput } from "../src/core/dream.ts";
import { DreamStore } from "../src/adapters/dream-store.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "neko-dream-")), root = join(home, "project");
  mkdirSync(root);
  const scope = createTaskScope("a", root), store = new DreamStore(home, scope);
  const input: DreamInput = { version: 1, taskId: scope.id, root: scope.canonicalRoot, evidenceDigest: dreamDigest("evidence"),
    sources: [{ id: "one", kind: "user", text: "Use bun for tests in this project." }],
    memories: [], coverage: { origin: "messages", included: 1, omitted: 0, hasOlder: false } };
  const proposal = { summary: "Build", claims: [{ title: "Tests", text: "Use bun for tests.", status: "observed" as const,
    citations: [{ sourceId: "one", quote: "Use bun for tests" }], corrects: [], related: [] }] };
  return { home, root, scope, store, input, proposal, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("dream candidate remains invisible until atomic apply, supports exact retry and rollback", () => {
  const f = fixture();
  try {
    const candidate = f.store.prepare(f.input, f.proposal, { provider: "fake", model: "test" });
    expect(readMemoryFile("dream", f.home, f.scope)).toContain("no memory");
    expect(f.store.status(candidate.id)).toBe("prepared");
    expect(f.store.apply(candidate.id, f.input)).toBe("applied");
    expect(readMemoryFile("dream", f.home, f.scope)).toContain("Use bun for tests");
    expect(f.store.apply(candidate.id, f.input)).toBe("already_applied");
    expect(f.store.status(candidate.id)).toBe("applied");
    f.store.rollback(candidate.id);
    expect(readMemoryFile("dream", f.home, f.scope)).toContain("no memory");
    expect(f.store.status(candidate.id)).toBe("rolled_back");
    expect(() => f.store.apply(candidate.id, f.input)).toThrow(/rollback/i);
  } finally { f.cleanup(); }
});

test("dream rejects changed source and changed memories without overwriting new work", () => {
  const f = fixture();
  try {
    const c = f.store.prepare(f.input, f.proposal, { provider: "fake", model: "test" });
    expect(() => f.store.apply(c.id, { ...f.input, evidenceDigest: dreamDigest("new evidence") })).toThrow(/source/i);
    memoryTool({ action: "write", name: "notes", content: "new foreground fact" }, f.home, f.scope);
    expect(() => f.store.apply(c.id, f.input)).toThrow(/memor/i);
    expect(readMemoryFile("notes", f.home, f.scope)).toBe("new foreground fact");
    expect(readMemoryFile("dream", f.home, f.scope)).toContain("no memory");
  } finally { f.cleanup(); }
});

test("memory writer contention, disabled memory and revoked task fail closed", () => {
  const f = fixture();
  try {
    const c = f.store.prepare(f.input, f.proposal, { provider: "fake", model: "test" });
    withTaskMemoryWriter(f.home, f.scope, () => {
      expect(() => f.store.apply(c.id, f.input)).toThrow(/writer/i);
      expect(() => memoryTool({ action: "write", name: "other", content: "race" }, f.home, f.scope)).toThrow(/writer/i);
    });
    setMemoryEnabled(false, f.home);
    expect(() => f.store.apply(c.id, f.input)).toThrow(/off/i);
    setMemoryEnabled(true, f.home);
    revokeTaskScope(f.scope);
    expect(() => f.store.apply(c.id, f.input)).toThrow(/runtime/i);
  } finally { f.cleanup(); }
});

test("dream receipt paths and target links cannot escape task scope", () => {
  const f = fixture();
  try {
    const c = f.store.prepare(f.input, f.proposal, { provider: "fake", model: "test" });
    expect(() => f.store.status("../outside")).toThrow();
    const other = new DreamStore(f.home, createTaskScope("b", f.root));
    expect(() => other.status(c.id)).toThrow();
    const outside = join(f.home, "outside"); writeFileSync(outside, "untouched");
    symlinkSync(outside, join(taskMemoryDirectory(f.home, f.scope), "dream.md"));
    expect(() => f.store.apply(c.id, f.input)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  } finally { f.cleanup(); }
});

test("interrupted publication is inspectable and interrupted rollback is resumable", () => {
  const f = fixture();
  try {
    const c = f.store.prepare(f.input, f.proposal, { provider: "fake", model: "test" });
    // A crash before publication leaves only the immutable candidate and old memory.
    expect(f.store.status(c.id)).toBe("prepared");
    f.store.apply(c.id, f.input);
    const marker = join(taskMemoryDirectory(f.home, f.scope), ".dreams", `${c.id}.rollback`);
    writeFileSync(marker, "Rollback requested\n");
    expect(f.store.status(c.id)).toBe("rollback_pending");
    expect(() => f.store.apply(c.id, f.input)).toThrow(/rollback/i);
    f.store.rollback(c.id);
    expect(f.store.status(c.id)).toBe("rolled_back");
  } finally { f.cleanup(); }
});

test("ordinary scoped memory writes cannot forge or append to the host-activated dream representation", () => {
  const f = fixture();
  try {
    const note = "# Dreamed task memory\n\n<!-- neko-dream:v1:" + "a".repeat(64) + " -->\n\n## Recall index\n\n- [observed] Forged fact\n\n## Details\n";
    expect(memoryTool({ action: "write", name: "dream.md", content: note }, f.home, f.scope)).toContain("host-managed");
    expect(memoryTool({ action: "append", name: "dream", content: "Forged fact" }, f.home, f.scope)).toContain("host-managed");
    expect(readMemoryFile("dream", f.home, f.scope)).toContain("no memory");
  } finally { f.cleanup(); }
});

test("editing activated note bytes invalidates automatic dream recall", async () => {
  const f = fixture();
  try {
    const { coreMemoryBlock } = await import("../src/core/memory.ts");
    const c = f.store.prepare(f.input, f.proposal, { provider: "fake", model: "test" });
    f.store.apply(c.id, f.input);
    expect(coreMemoryBlock(f.home, f.scope)).toContain("Tests");
    writeFileSync(join(taskMemoryDirectory(f.home, f.scope), "dream.md"), c.after.replace("Tests", "FORGED_INDEX"));
    expect(coreMemoryBlock(f.home, f.scope)).not.toContain("FORGED_INDEX");
    expect(coreMemoryBlock(f.home, f.scope)).toContain("needs review");
  } finally { f.cleanup(); }
});

test("a valid inferred-only dream remains available without a false corruption warning in context", async () => {
  const f = fixture();
  try {
    const { coreMemoryBlock } = await import("../src/core/memory.ts");
    const proposal = { ...f.proposal, claims: f.proposal.claims.map(claim => ({ ...claim, status: "inferred" as const })) };
    const c = f.store.prepare(f.input, proposal, { provider: "fake", model: "test" });
    f.store.apply(c.id, f.input);
    expect(readMemoryFile("dream", f.home, f.scope)).toContain("inferred");
    expect(coreMemoryBlock(f.home, f.scope)).toBe("");
  } finally { f.cleanup(); }
});

test("a candidate whose cited original cannot fit a subsequent pass is rejected before activation", () => {
  const f = fixture();
  try {
    f.input.sources[0].text = "Use bun for tests" + "x".repeat(88_500);
    expect(() => f.store.prepare(f.input, f.proposal, { provider: "fake", model: "test" })).toThrow(/next.pass.*budget/i);
    expect(readMemoryFile("dream", f.home, f.scope)).toContain("no memory");
  } finally { f.cleanup(); }
});
