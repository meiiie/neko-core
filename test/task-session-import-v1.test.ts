import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTaskSessionV1, loadTaskSession, TaskSessionImportCommittedError, writeNewStore, type TaskRuntimeInput } from "../src/adapters/task-session.ts";
import { createTaskScope } from "../src/core/task-scope.ts";

const CONFIG_ID = "a".repeat(64);
const SOURCE_ID = "1".repeat(32);
const SOURCE_TASK_A = "2".repeat(32);
const SOURCE_TASK_B = "3".repeat(32);

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "neko-v1-import-"));
  const home = join(base, "home");
  const root = join(base, "a", "app");
  const otherRoot = join(base, "b", "app");
  mkdirSync(home);
  mkdirSync(root, { recursive: true });
  mkdirSync(otherRoot, { recursive: true });
  const dir = join(home, ".neko-core", "task-sessions");
  mkdirSync(dir, { recursive: true });
  const sourcePath = join(dir, `${SOURCE_ID}.json`);
  const canonicalRoot = createTaskScope("fixture", root).canonicalRoot;
  const source = {
    schemaVersion: 1, id: SOURCE_ID,
    createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T01:00:00.000Z",
    canonicalRoot, authorityId: "local", configId: CONFIG_ID, revision: 2,
    activeTaskId: SOURCE_TASK_B,
    tasks: [
      { id: SOURCE_TASK_A, label: "A", canonicalRoot, revision: 1,
        messages: [
          { role: "tool", tool_call_id: "old-read", content: "config.ts: A uses pnpm" },
          { role: "assistant", content: "Old summary claims A uses pnpm" },
        ] },
      { id: SOURCE_TASK_B, label: "B", canonicalRoot, revision: 1,
        messages: [{ role: "user", content: "SYNTHETIC_SENSITIVE_LEGACY_MARKER" }] },
    ],
  };
  const oldBytes = JSON.stringify(source, null, 2) + "\n";
  writeFileSync(sourcePath, oldBytes);
  return { home, root, otherRoot, dir, sourcePath, source, oldBytes,
    cleanup() { rmSync(base, { recursive: true, force: true }); } };
}

function runtimeFactory(input: TaskRuntimeInput) {
  return { getMessages: () => input.messages, getSourceEvents: () => input.sourceEvents,
    assertQuiescent: () => {}, close: () => {} };
}

test("explicit v1 import creates a distinct scoped v2 session; historical transcript stays quarantined", async () => {
  const f = fixture();
  try {
    const imported = await importTaskSessionV1({
      home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sourceSessionId: SOURCE_ID,
    });
    expect(imported.sessionId).toMatch(/^[a-f0-9]{32}$/);
    expect(imported.sessionId).not.toBe(SOURCE_ID);
    expect(imported.sourceSha256).toBe(createHash("sha256").update(f.oldBytes).digest("hex"));
    expect(readFileSync(f.sourcePath, "utf8")).toBe(f.oldBytes);
    const targetPath = join(f.dir, `${imported.sessionId}.json`);
    const targetBytes = readFileSync(targetPath, "utf8");
    expect(targetBytes).not.toContain("SYNTHETIC_SENSITIVE_LEGACY_MARKER");
    expect(targetBytes).not.toContain("Old summary claims A uses pnpm");
    expect(targetBytes).not.toContain("config.ts: A uses pnpm");
    const target = JSON.parse(targetBytes);
    expect(target.schemaVersion).toBe(2);
    expect(target.activeTaskId).toBe(imported.activeTaskId);
    expect(target.activeTaskId).toBe(target.tasks[1].id);
    const taskMap = [
      { sourceTaskId: SOURCE_TASK_A, importedTaskId: target.tasks[0].id },
      { sourceTaskId: SOURCE_TASK_B, importedTaskId: target.tasks[1].id },
    ];
    expect(target.importedFrom).toEqual({
      schemaVersion: 1, sourceSessionId: SOURCE_ID, sourceSha256: imported.sourceSha256,
      sourceRevision: 2, sourceActiveTaskId: SOURCE_TASK_B,
      importedActiveTaskId: target.tasks[1].id, taskMap,
    });
    expect(target.tasks.map((task: { label: string }) => task.label)).toEqual(["A", "B"]);
    expect(target.tasks.map((task: { id: string }) => task.id)).not.toEqual([SOURCE_TASK_A, SOURCE_TASK_B]);
    for (const task of target.tasks) {
      expect(task.messages).toEqual([]);
      expect(task.sourceEvents).toEqual([]);
    }
    const session = await loadTaskSession({
      home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID,
      sessionId: imported.sessionId, runtimeFactory,
    });
    try {
      expect(session.active.runtime.getMessages()).toEqual([]);
      expect(session.active.runtime.getSourceEvents()).toEqual([]);
      await session.switchTask(session.tasks[0]!.id);
      expect(session.active.runtime.getMessages()).toEqual([]);
    } finally { await session.close(); }
    expect(readFileSync(f.sourcePath, "utf8")).toBe(f.oldBytes);
    for (const importedFrom of [
      { ...target.importedFrom, sourceSha256: "bad-digest" },
      { ...target.importedFrom, taskMap: [{ sourceTaskId: SOURCE_TASK_A, importedTaskId: "f".repeat(32) }] },
      { ...target.importedFrom, taskMap: [taskMap[1], taskMap[0]], sourceActiveTaskId: SOURCE_TASK_A },
    ]) {
      writeFileSync(targetPath, JSON.stringify({ ...target, importedFrom }));
      await expect(loadTaskSession({
        home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID,
        sessionId: imported.sessionId, runtimeFactory,
      })).rejects.toThrow(/import origin|import mapping|import source|import active mapping/);
    }
    writeFileSync(targetPath, targetBytes);
    writeFileSync(f.sourcePath, f.oldBytes.replace("Old summary claims A uses pnpm", "Old summary changed after import"));
    let resumed = await loadTaskSession({
      home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID,
      sessionId: imported.sessionId, runtimeFactory,
    });
    expect(resumed.active.runtime.getMessages()).toEqual([]);
    await resumed.close();
    unlinkSync(f.sourcePath);
    resumed = await loadTaskSession({
      home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID,
      sessionId: imported.sessionId, runtimeFactory,
    });
    expect(resumed.active.runtime.getMessages()).toEqual([]);
    await resumed.close();
  } finally { f.cleanup(); }
});

test("new session publish never overwrites and reports committed but unverified cleanup", () => {
  const f = fixture();
  try {
    const oldPath = join(f.dir, `${"4".repeat(32)}.json`);
    writeFileSync(oldPath, "EXISTING_SESSION_BYTES");
    expect(() => writeNewStore(oldPath, "REPLACEMENT_BYTES", "4".repeat(32))).toThrow();
    expect(readFileSync(oldPath, "utf8")).toBe("EXISTING_SESSION_BYTES");

    const committed = join(f.dir, `${"6".repeat(32)}.json`);
    let error: unknown;
    let attempts = 0;
    try {
      writeNewStore(committed, "COMPLETE_BYTES", "6".repeat(32), {
        removeTemporary: () => { attempts++; throw new Error("synthetic temp cleanup failure"); },
      });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(TaskSessionImportCommittedError);
    if (!(error instanceof TaskSessionImportCommittedError)) throw new Error("Missing committed import error");
    expect(error.committed).toBe(true);
    expect(error.sessionId).toBe("6".repeat(32));
    expect(error.path).toBe(committed);
    expect(existsSync(error.temporaryPath)).toBe(true);
    expect(attempts).toBe(2);
    expect(lstatSync(committed).nlink).toBe(2);

    const ackLost = join(f.dir, `${"7".repeat(32)}.json`);
    writeNewStore(ackLost, "COMPLETE_BYTES", "7".repeat(32), {
      removeTemporary: (temporary) => {
        unlinkSync(temporary);
        throw new Error("synthetic acknowledgement lost after unlink");
      },
    });
    expect(readFileSync(ackLost, "utf8")).toBe("COMPLETE_BYTES");
    expect(lstatSync(ackLost).nlink).toBe(1);
  } finally { f.cleanup(); }
});

test("v1 import rejects hardlinked and oversized source files before destination creation", async () => {
  const f = fixture();
  try {
    const options = { home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sourceSessionId: SOURCE_ID };
    const sibling = join(f.dir, "same-bytes-hardlink.tmp");
    linkSync(f.sourcePath, sibling);
    await expect(importTaskSessionV1(options)).rejects.toThrow(/regular unlinked file/);
    expect(readFileSync(f.sourcePath, "utf8")).toBe(f.oldBytes);
    unlinkSync(sibling);
    truncateSync(f.sourcePath, 64 * 1024 * 1024 + 1);
    await expect(importTaskSessionV1(options)).rejects.toThrow(/size limit|regular unlinked file/);
    expect(readdirSync(f.dir).filter((name) => name.endsWith(".json"))).toEqual([`${SOURCE_ID}.json`]);
  } finally { f.cleanup(); }
});

test("v1 import refuses wrong root, authority, config, ambiguous task root and active writer without writing target", async () => {
  const f = fixture();
  try {
    const options = { home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sourceSessionId: SOURCE_ID };
    const before = () => readdirSync(f.dir).filter((name) => name.endsWith(".json"));
    for (const variant of [
      { ...options, root: f.otherRoot },
      { ...options, authorityId: "acp:other" },
      { ...options, configId: "b".repeat(64) },
    ]) {
      await expect(importTaskSessionV1(variant)).rejects.toThrow();
      expect(before()).toEqual([`${SOURCE_ID}.json`]);
      expect(readFileSync(f.sourcePath, "utf8")).toBe(f.oldBytes);
    }
    const malformed = { ...f.source, tasks: [f.source.tasks[0], { ...f.source.tasks[1], canonicalRoot: f.otherRoot }] };
    writeFileSync(f.sourcePath, JSON.stringify(malformed));
    await expect(importTaskSessionV1(options)).rejects.toThrow();
    expect(before()).toEqual([`${SOURCE_ID}.json`]);
    writeFileSync(f.sourcePath, f.oldBytes);
    writeFileSync(join(f.dir, `${SOURCE_ID}.lock`), "synthetic-active-writer");
    await expect(importTaskSessionV1(options)).rejects.toThrow(/writer|lock/);
    expect(before()).toEqual([`${SOURCE_ID}.json`]);
  } finally { f.cleanup(); }
});
