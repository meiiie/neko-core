import {expect, test} from "bun:test";
import {join} from "node:path";

// Isolate filesystem spies in a child so unrelated persistence tests cannot see them.
for (const stage of ["write", "file-sync", "rename", "directory-sync"] as const) {
  test.skipIf(stage === "directory-sync" && process.platform === "win32")(`structured checkpoint distinguishes ${stage} failure from no publication`, async () => {
    const module = join(import.meta.dir, "..", "src", "adapters", "context", "durable-write.ts");
    const script = `
      import {spyOn} from 'bun:test';
      import * as fs from 'node:fs';
      import {tmpdir} from 'node:os';
      import {join} from 'node:path';
      import assert from 'node:assert/strict';
      const {writeStructuredCheckpoint, StructuredCheckpointPublishedError} = await import(${JSON.stringify(module)});
      const folder = fs.mkdtempSync(join(tmpdir(), 'neko-publication-fault-'));
      const path = join(folder, 'parent.json'); fs.writeFileSync(path, 'old');
      const stage = ${JSON.stringify(stage)};
      const target = stage === 'write' ? 'writeFileSync' : stage === 'rename' ? 'renameSync' : 'fsyncSync';
      const original = fs[target]; let count = 0;
      const mock = spyOn(fs, target).mockImplementation((...args) => {
        count++;
        if (stage !== 'directory-sync' || count === 2) throw new Error('injected ' + stage);
        return original(...args);
      });
      let failure;
      try { writeStructuredCheckpoint(path, 'new'); } catch (error) { failure = error; }
      finally { mock.mockRestore(); }
      assert.ok(failure, 'injection must execute');
      assert.equal(failure instanceof StructuredCheckpointPublishedError, stage === 'directory-sync');
      assert.equal(fs.readFileSync(path, 'utf8'), stage === 'directory-sync' ? 'new' : 'old');
      assert.deepEqual(fs.readdirSync(folder), ['parent.json']);
      fs.rmSync(folder, {recursive: true});
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {stdout: "pipe", stderr: "pipe"});
    const output = new Response(child.stdout).text(), error = new Response(child.stderr).text();
    const status = await child.exited;
    expect({status, stdout: await output, stderr: await error}).toEqual({status: 0, stdout: "", stderr: ""});
  });
}
