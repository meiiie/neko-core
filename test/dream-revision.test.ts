import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskScope } from "../src/core/task-scope.ts";
import { taskMemoryDirectory } from "../src/core/memory.ts";
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


test("Dream revision fences a concurrent candidate across apply/rollback ABA", () => {
  const f = fixture();
  try {
    const revision = f.store.revision();
    const first = f.store.prepare(f.input, f.proposal, { provider: "fake", model: "first" });
    const pending = f.store.prepare(f.input, f.proposal, { provider: "fake", model: "pending" });
    expect(f.store.revision()).toBe(revision);
    expect(f.store.apply(first.id, f.input, undefined, revision)).toBe("applied");
    const applied = f.store.revision();
    expect(applied).not.toBe(revision);
    f.store.rollback(first.id);
    expect(f.store.revision()).not.toBe(applied);
    expect(() => f.store.apply(pending.id, f.input, undefined, revision)).toThrow(/revision/i);
    expect(f.store.status(pending.id)).toBe("prepared");
    expect(f.store.apply(pending.id, f.input, undefined, f.store.revision())).toBe("applied");
  } finally { f.cleanup(); }
});

test("Dream revision is shared across stores and rejects malformed or linked records", () => {
  const f = fixture();
  try {
    const candidate = f.store.prepare(f.input, f.proposal, { provider: "fake", model: "test" });
    f.store.apply(candidate.id, f.input);
    expect(new DreamStore(f.home, f.scope).revision()).toBe(f.store.revision());
    const path = join(taskMemoryDirectory(f.home, f.scope), ".dreams", "revision");
    writeFileSync(path, "invalid");
    expect(() => f.store.revision()).toThrow(/revision/i);
    rmSync(path);
    const elsewhere = join(f.home, "external");
    writeFileSync(elsewhere, "00000000-0000-4000-8000-000000000000");
    symlinkSync(elsewhere, path);
    expect(() => f.store.revision()).toThrow(/unsafe/i);
  } finally { f.cleanup(); }
});
