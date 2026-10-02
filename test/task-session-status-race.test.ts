import { expect, test } from "bun:test";

// Isolate the built-in fs mock in a child so it cannot affect other test files.
test("status retries a real atomic replacement between checkpoint stat and open", async () => {
  const moduleUrl = new URL("../src/adapters/task-session.ts", import.meta.url).href;
  const script = `
    import { mock } from 'bun:test';
    import * as fs from 'node:fs';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    const stat = fs.lstatSync, write = fs.writeFileSync, rename = fs.renameSync;
    const base = fs.mkdtempSync(join(tmpdir(), 'neko-status-race-'));
    const home = join(base, 'home'), root = join(base, 'app');
    const dir = join(home, '.neko-core', 'task-sessions');
    fs.mkdirSync(root); fs.mkdirSync(dir, {recursive:true});
    const physical = fs.realpathSync.native(root);
    const canonicalRoot = process.platform === 'win32' ? physical.toLowerCase() : physical;
    const id = '1'.repeat(32), taskId = '2'.repeat(32), path = join(dir, id + '.json');
    const state = { schemaVersion:2, id, createdAt:'2026-10-02', updatedAt:'2026-10-02',
      canonicalRoot, authorityId:'local', configId:'a'.repeat(64), revision:1, activeTaskId:taskId,
      tasks:[{id:taskId,label:'synthetic',canonicalRoot,revision:1,messages:[],sourceEvents:[]}] };
    write(path, JSON.stringify(state));
    let reads = 0;
    mock.module('node:fs', () => ({...fs, lstatSync(p, ...args) {
      const before = stat(p, ...args);
      // First stat is the existence check; second is the validated read's pre-open stat.
      if (p === path && ++reads === 2) {
        write(path + '.next', JSON.stringify({...state, revision:2}));
        rename(path + '.next', path);
      }
      return before;
    }}));
    try {
      const {inspectTaskSession} = await import(${JSON.stringify(moduleUrl)});
      const result = inspectTaskSession({home,root,authorityId:'local',configId:'a'.repeat(64),sessionId:id});
      console.log(JSON.stringify({revision:result.revision,reads,lock:result.writerLock}));
    } finally { fs.rmSync(base, {recursive:true,force:true}); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout.trim())).toEqual({ revision: 2, reads: 3, lock: "absent" });
}, 15_000);
