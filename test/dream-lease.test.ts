import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskScope } from "../src/core/task-scope.ts";
import { setMemoryEnabled, taskMemoryDirectory } from "../src/core/memory.ts";
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



test("automatic lease excludes another store including the same PID and releases exactly once", () => {
  const f = fixture();
  try {
    const release = f.store.acquireAutomaticLease()!;
    expect(release).toBeFunction();
    const other = new DreamStore(f.home, f.scope);
    expect(other.acquireAutomaticLease()).toBeUndefined();
    release();
    const release2 = other.acquireAutomaticLease()!;
    expect(release2).toBeFunction();
    release(); // old owner cannot remove new lease
    expect(f.store.acquireAutomaticLease()).toBeUndefined();
    release2();
  } finally { f.cleanup(); }
});

test("automatic lease recovers a dead local process but never a foreign host", () => {
  const f = fixture();
  try {
    const release = f.store.acquireAutomaticLease()!; release();
    const path = join(taskMemoryDirectory(f.home, f.scope), ".dreams", "automatic-lease.json");
    const record = { version: 1, pid: 2147483647, host: hostname(), nonce: "00000000-0000-4000-8000-000000000000" };
    writeFileSync(path, JSON.stringify(record));
    const recovered = f.store.acquireAutomaticLease()!;
    expect(recovered).toBeFunction(); recovered();
    writeFileSync(path, JSON.stringify({ ...record, host: "another-host" }));
    expect(f.store.acquireAutomaticLease()).toBeUndefined();
    writeFileSync(path, "invalid");
    expect(() => f.store.acquireAutomaticLease()).toThrow();
    rmSync(path);
    const elsewhere = join(f.home, "elsewhere"); writeFileSync(elsewhere, JSON.stringify(record)); symlinkSync(elsewhere, path);
    expect(() => f.store.acquireAutomaticLease()).toThrow(/unsafe/i);
  } finally { f.cleanup(); }
});

test("lease retirement while memory is disabled can recover after re-enable", () => {
  const f = fixture();
  try {
    const release = f.store.acquireAutomaticLease()!;
    setMemoryEnabled(false, f.home);
    release();
    setMemoryEnabled(true, f.home);
    const next = f.store.acquireAutomaticLease()!;
    expect(next).toBeFunction(); next();
  } finally { f.cleanup(); }
});

test("automatic lease excludes a live second process and recovers after its exit", async () => {
  const f = fixture();
  const script = `
    import { DreamStore } from ${JSON.stringify(new URL("../src/adapters/dream-store.ts", import.meta.url).href)};
    import { createTaskScope } from ${JSON.stringify(new URL("../src/core/task-scope.ts", import.meta.url).href)};
    const store = new DreamStore(${JSON.stringify(f.home)}, createTaskScope("a", ${JSON.stringify(f.root)}));
    if (!store.acquireAutomaticLease()) process.exit(1);
    console.log("ready");
    setInterval(() => {}, 1000);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    reader.releaseLock();
    expect(f.store.acquireAutomaticLease()).toBeUndefined();
    child.kill(); await child.exited;
    const release = f.store.acquireAutomaticLease()!;
    expect(release).toBeFunction(); release();
  } finally { child.kill(); await child.exited; f.cleanup(); }
});
