import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextProjection } from "../experiments/context-projection/projection.ts";
import { loadProjection, saveProjection } from "../experiments/context-projection/storage.ts";
import { createTaskScope, revokeTaskScope } from "../src/core/task-scope.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "neko-projection-store-"));
  const root = join(home, "one", "app"), other = join(home, "two", "app");
  mkdirSync(root, {recursive: true}); mkdirSync(other, {recursive: true});
  const scope = createTaskScope("same-task", root);
  const prefix = ["HOST_POLICY", "CURRENT_TASK"];
  const binding = createHash("sha256").update("working checkpoint v1").digest("hex");
  const view = new ContextProjection(scope, prefix, 8192, () => {});
  view.append(scope, {id: "original", text: "Use npm"});
  view.append(scope, {id: "correction", text: "Correction: use pnpm"});
  view.apply(scope, 2, [{kind: "note", text: "Use pnpm", sources: ["correction"]}]);
  return {home, root, other, scope, prefix, binding, view};
}

test("durable projection recovery preserves exact revisions, evidence and undo in a new activation", () => {
  const f = fixture();
  const before = f.view.snapshot(f.scope);
  expect(saveProjection(f.home, f.scope, f.view, f.binding, null)).toBe(1);
  revokeTaskScope(f.scope);
  const scope = createTaskScope("same-task", f.root);
  try {
    const loaded = loadProjection(f.home, scope, f.prefix, 8192, () => {}, f.binding);
    expect(loaded.revision).toBe(1);
    expect(loaded.view.snapshot(scope)).toEqual(before);
    expect(loaded.view.evidence(scope, "original").text).toBe("Use npm");
    expect(loaded.view.evidence(scope, "correction").text).toBe("Correction: use pnpm");
    expect(() => loaded.view.apply(scope, before.revision - 1, [])).toThrow("Stale");
    loaded.view.undo(scope, before.revision);
    expect(loaded.view.snapshot(scope).parts).toEqual([{kind: "source", id: "original"}, {kind: "source", id: "correction"}]);
    expect(saveProjection(f.home, scope, loaded.view, f.binding, 1)).toBe(2);
    expect(() => saveProjection(f.home, scope, loaded.view, f.binding, 1)).toThrow("revision conflict");
    expect(loadProjection(f.home, scope, f.prefix, 8192, () => {}, f.binding).revision).toBe(2);
  } finally { revokeTaskScope(scope); }
});

test("wrong working checkpoint, prefix, root, busy state and existing lock fail closed", () => {
  const f = fixture();
  saveProjection(f.home, f.scope, f.view, f.binding, null);
  const foreign = createTaskScope("same-task", f.other);
  try {
    expect(() => loadProjection(f.home, f.scope, f.prefix, 8192, () => {}, "b".repeat(64))).toThrow("working checkpoint");
    expect(() => loadProjection(f.home, f.scope, ["REPLACED_POLICY"], 8192, () => {}, f.binding)).toThrow("foreign");
    expect(() => loadProjection(f.home, foreign, f.prefix, 8192, () => {}, f.binding)).toThrow();
    expect(() => loadProjection(f.home, f.scope, f.prefix, 8192, () => {throw new Error("Turn active");}, f.binding)).toThrow("Turn active");
    const dir = join(f.home, ".neko-core", "context-projection-experiment");
    const path = join(dir, readdirSync(dir).find(name => name.endsWith(".json"))!);
    const before = readFileSync(path, "utf8"), lock = path.replace(/\.json$/, ".lock");
    writeFileSync(lock, "existing owner");
    expect(() => saveProjection(f.home, f.scope, f.view, f.binding, 1)).toThrow();
    expect(readFileSync(lock, "utf8")).toBe("existing owner");
    expect(readFileSync(path, "utf8")).toBe(before);
    // Read-only diagnosis/recovery never removes or acquires the writer lease.
    expect(loadProjection(f.home, f.scope, f.prefix, 8192, () => {}, f.binding).revision).toBe(1);
  } finally { revokeTaskScope(f.scope); revokeTaskScope(foreign); }
});

test("corrupt payload and unknown sources cannot be restored or overwrite the old checkpoint", () => {
  const f = fixture();
  try {
    const exported = f.view.checkpoint(f.scope);
    const invalid = {...exported, parts: [{kind: "source", id: "missing"}]};
    expect(() => ContextProjection.restore(f.scope, f.prefix, 8192, () => {}, invalid)).toThrow("Unknown evidence");
    expect(f.view.snapshot(f.scope).revision).toBe(3);
    saveProjection(f.home, f.scope, f.view, f.binding, null);
    const dir = join(f.home, ".neko-core", "context-projection-experiment");
    const path = join(dir, readdirSync(dir).find(name => name.endsWith(".json"))!);
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.payload.archive[0].text = "CORRUPTED";
    writeFileSync(path, JSON.stringify(value));
    expect(() => loadProjection(f.home, f.scope, f.prefix, 8192, () => {}, f.binding)).toThrow("integrity");
    expect(() => saveProjection(f.home, f.scope, f.view, f.binding, 1)).toThrow("integrity");
  } finally { revokeTaskScope(f.scope); }
});

test("a fresh process restores the projection from bytes rather than retained heap state", async () => {
  const f = fixture();
  saveProjection(f.home, f.scope, f.view, f.binding, null);
  revokeTaskScope(f.scope);
  const storage = new URL("../experiments/context-projection/storage.ts", import.meta.url).href;
  const scopes = new URL("../src/core/task-scope.ts", import.meta.url).href;
  const script = `import {loadProjection} from ${JSON.stringify(storage)};
    import {createTaskScope} from ${JSON.stringify(scopes)};
    const scope=createTaskScope('same-task',${JSON.stringify(f.root)});
    const loaded=loadProjection(${JSON.stringify(f.home)},scope,${JSON.stringify(f.prefix)},8192,()=>{},${JSON.stringify(f.binding)});
    console.log(JSON.stringify({store:loaded.revision,view:loaded.view.snapshot(scope).revision,evidence:loaded.view.evidence(scope,'correction').text}));`;
  const child = Bun.spawn([process.execPath, "--eval", script], {stdin: "ignore", stdout: "pipe", stderr: "pipe"});
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({code, error}).toEqual({code: 0, error: ""});
  expect(JSON.parse(output)).toEqual({store: 1, view: 3, evidence: "Correction: use pnpm"});
});

test("candidate validation cannot reenter mutations or persist an uncommitted archive", () => {
  const f = fixture();
  try {
    const before = f.view.snapshot(f.scope);
    expect(() => f.view.apply(f.scope, before.revision, [], () => {
      f.view.append(f.scope, {id: "nested", text: "must not commit"});
    })).toThrow("reenter");
    expect(f.view.snapshot(f.scope)).toEqual(before);
    expect(() => f.view.append(f.scope, {id: "candidate", text: "must not persist"}, () => {
      saveProjection(f.home, f.scope, f.view, f.binding, null);
    })).toThrow("uncommitted");
    expect(f.view.snapshot(f.scope)).toEqual(before);
    expect(() => f.view.evidence(f.scope, "candidate")).toThrow("Unknown");
    const exhausted = {...f.view.checkpoint(f.scope), revision: Number.MAX_SAFE_INTEGER};
    const restored = ContextProjection.restore(f.scope, f.prefix, 8192, () => {}, exhausted);
    expect(() => restored.apply(f.scope, Number.MAX_SAFE_INTEGER, [])).toThrow("exhausted");
    expect(restored.snapshot(f.scope).revision).toBe(Number.MAX_SAFE_INTEGER);
  } finally { revokeTaskScope(f.scope); }
});

test.each([false, true])("process interruption at atomic publication preserves a readable old or new checkpoint (%s)", async (afterRename) => {
  const f = fixture();
  saveProjection(f.home, f.scope, f.view, f.binding, null);
  revokeTaskScope(f.scope);
  const storage = new URL("../experiments/context-projection/storage.ts", import.meta.url).href;
  const scopes = new URL("../src/core/task-scope.ts", import.meta.url).href;
  const script = `import {mock} from 'bun:test';
    import * as fs from 'node:fs';
    const rename=fs.renameSync;
    mock.module('node:fs',()=>({...fs,renameSync(from,to){if(${afterRename}) rename(from,to);process.exit(91);}}));
    const {loadProjection,saveProjection}=await import(${JSON.stringify(storage)});
    const {createTaskScope}=await import(${JSON.stringify(scopes)});
    const scope=createTaskScope('same-task',${JSON.stringify(f.root)});
    const loaded=loadProjection(${JSON.stringify(f.home)},scope,${JSON.stringify(f.prefix)},8192,()=>{},${JSON.stringify(f.binding)});
    loaded.view.apply(scope,loaded.view.snapshot(scope).revision,[]);
    saveProjection(${JSON.stringify(f.home)},scope,loaded.view,${JSON.stringify(f.binding)},1);`;
  const child = Bun.spawn([process.execPath, "--eval", script], {stdin: "ignore", stdout: "pipe", stderr: "pipe"});
  const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect({code, error}).toEqual({code: 91, error: ""});
  const scope = createTaskScope("same-task", f.root);
  try {
    const loaded = loadProjection(f.home, scope, f.prefix, 8192, () => {}, f.binding);
    expect(loaded.revision).toBe(afterRename ? 2 : 1);
    expect(loaded.view.snapshot(scope).parts.length).toBe(afterRename ? 0 : 1);
    expect(loaded.view.evidence(scope, "correction").text).toBe("Correction: use pnpm");
    expect(() => saveProjection(f.home, scope, loaded.view, f.binding, loaded.revision)).toThrow();
    const dir = join(f.home, ".neko-core", "context-projection-experiment");
    expect(readdirSync(dir).filter(name => name.endsWith(".lock"))).toHaveLength(1);
  } finally { revokeTaskScope(scope); }
});


for (const failureKind of ["directory_fsync", "lease_cleanup"] as const) {
test.skipIf(failureKind === "directory_fsync" && process.platform === "win32")(`post-publication ${failureKind} failure reports the committed revision without pretending nothing changed`, async () => {
  const f = fixture();
  saveProjection(f.home, f.scope, f.view, f.binding, null);
  revokeTaskScope(f.scope);
  const storage = new URL("../experiments/context-projection/storage.ts", import.meta.url).href;
  const scopeModule = new URL("../src/core/task-scope.ts", import.meta.url).href;
  const script = `import {mock} from 'bun:test'; import * as fs from 'node:fs';
    const sync = fs.fsyncSync, stat = fs.fstatSync, unlink = fs.unlinkSync;
    mock.module('node:fs',()=>({...fs,
      fsyncSync(fd){if(${JSON.stringify(failureKind)}==='directory_fsync'&&stat(fd).isDirectory())throw new Error('synthetic directory fsync failure');return sync(fd);},
      unlinkSync(path){if(${JSON.stringify(failureKind)}==='lease_cleanup'&&path.endsWith('.lock'))throw new Error('synthetic lease cleanup failure');return unlink(path);}
    }));
    const {loadProjection,saveProjection,ContextCheckpointPublishedError}=await import(${JSON.stringify(storage)});
    const {createTaskScope}=await import(${JSON.stringify(scopeModule)});
    const scope=createTaskScope('same-task',${JSON.stringify(f.root)});
    const loaded=loadProjection(${JSON.stringify(f.home)},scope,${JSON.stringify(f.prefix)},8192,()=>{},${JSON.stringify(f.binding)});
    loaded.view.apply(scope,loaded.view.snapshot(scope).revision,[]);
    let result={typed:false,revision:0};
    try{saveProjection(${JSON.stringify(f.home)},scope,loaded.view,${JSON.stringify(f.binding)},1);}
    catch(e){result={typed:e instanceof ContextCheckpointPublishedError,revision:e.revision};}
    console.log(JSON.stringify(result));`;
  const child = Bun.spawn([process.execPath, "--eval", script], {stdin: "ignore", stdout: "pipe", stderr: "pipe"});
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({code, error}).toEqual({code: 0, error: ""});
  expect(JSON.parse(output)).toEqual({typed: true, revision: 2});
  const scope = createTaskScope("same-task", f.root);
  try {
    const saved = loadProjection(f.home, scope, f.prefix, 8192, () => {}, f.binding);
    expect(saved.revision).toBe(2);
    expect(saved.view.snapshot(scope).parts).toHaveLength(0);
    if (failureKind === "directory_fsync") expect(() => saveProjection(f.home, scope, saved.view, f.binding, 1)).toThrow("revision conflict");
    else {
      const directory = join(f.home, ".neko-core", "context-projection-experiment");
      expect(readdirSync(directory).filter(name => name.endsWith(".lock"))).toHaveLength(1);
      expect(() => saveProjection(f.home, scope, saved.view, f.binding, 1)).toThrow("EEXIST");
    }
  } finally { revokeTaskScope(scope); }
});
}
