import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { createTaskSession, inspectTaskSession, loadTaskSession, taskSessionConfigId, taskSessionExists, TaskSessionRecoveryRequiredError, TaskSessionWriterUnavailableError, TaskSwitchCommittedError, type TaskRuntimeInput, type TaskSessionCoordinator } from "../src/adapters/task-session.ts";
import { NekoConfig } from "../src/adapters/config.ts";
import { Agent } from "../src/core/agent.ts";
import { createCompactionSourceEvent, sourceProjectionDigest } from "../src/core/compaction-source.ts";
import { memoryTool, readMemoryFile } from "../src/core/memory.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

const CONFIG_ID = "a".repeat(64);

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "neko-task-session-"));
  const root = join(base, "a", "app");
  const otherRoot = join(base, "b", "app");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(otherRoot, { recursive: true });
  mkdirSync(home);
  return {
    base, root, otherRoot, home,
    cleanup() {
      const tempRoot = resolve(tmpdir()) + sep;
      if (!resolve(base).startsWith(tempRoot) || !basename(base).startsWith("neko-task-session-")) {
        throw new Error("Refusing to remove fixture outside the task temp directory");
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function fakeRuntimeFactory(home: string) {
  const activations: TaskRuntimeInput[] = [];
  const runtimeFactory = (input: TaskRuntimeInput) => {
    activations.push(input);
    const registry = new ToolRegistry(input.root, "auto", () => false);
    registry.memoryHome = home;
    registry.bindTaskScope(input.scope);
    const messages = input.messages;
    let quiescent = true;
    let closed = false;
    return {
      registry,
      messages,
      get closed() { return closed; },
      getMessages: () => messages,
      getSourceEvents: () => input.sourceEvents,
      assertQuiescent() { if (!quiescent) throw new Error("Turn still active"); },
      close() { closed = true; },
      setQuiescent(value: boolean) { quiescent = value; },
    };
  };
  return { runtimeFactory, activations };
}

type FakeRuntime = ReturnType<ReturnType<typeof fakeRuntimeFactory>["runtimeFactory"]>;

test("explicit A to B to A switches fresh runtime, transcript and scoped memory in one root", async () => {
  const f = fixture();
  const { runtimeFactory, activations } = fakeRuntimeFactory(f.home);
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    memoryTool({ action: "write", name: "config", content: "# Legacy uses npm" }, f.home);
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, label: "Task A", runtimeFactory });
    const taskA = session.active.id;
    session.active.runtime.messages.push({ role: "user", content: "A uses pnpm" });
    memoryTool({ action: "write", name: "config", content: "# A uses pnpm" }, f.home, session.active.scope);
    const taskB = session.createTask("Task B");

    await session.switchTask(taskB);
    expect(session.active.runtime.messages).toEqual([]);
    expect(session.active.runtime.registry.taskScope?.id).toBe(taskB);
    expect(memoryTool({ action: "read", name: "config" }, f.home, session.active.scope)).toContain("no memory");
    expect(memoryTool({ action: "search", query: "pnpm" }, f.home, session.active.scope)).toContain("no memory matches");
    expect(memoryTool({ action: "read", name: "config" }, f.home, session.active.scope)).not.toContain("Legacy uses npm");
    session.active.runtime.messages.push({ role: "user", content: "B uses bun" });
    memoryTool({ action: "write", name: "config", content: "# B uses bun" }, f.home, session.active.scope);

    await session.switchTask(taskA);
    expect(session.active.runtime.messages).toEqual([{ role: "user", content: "A uses pnpm" }]);
    expect(session.active.runtime.registry.taskScope?.id).toBe(taskA);
    expect(readMemoryFile("config", f.home, session.active.scope)).toBe("# A uses pnpm");
    expect(activations.map(({ taskId }) => taskId)).toEqual([taskA, taskB, taskA]);
    expect(activations[0]!.scope).not.toBe(activations[2]!.scope);
    expect(activations[0]!.root).toBe(activations[2]!.root);
    expect(activations[1]!.messages).toEqual([{ role: "user", content: "B uses bun" }]);
    expect(activations[2]!.messages).toEqual([{ role: "user", content: "A uses pnpm" }]);
    expect(readMemoryFile("config", f.home)).toBe("# Legacy uses npm");
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("restart restores only active B, then A; v2 legacy bytes are untouched", async () => {
  const f = fixture();
  const { runtimeFactory } = fakeRuntimeFactory(f.home);
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    const legacyDir = join(f.home, ".neko-core", "sessions");
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, "old-v2.json");
    const legacyBytes = '{"schemaVersion":2,"messages":[{"role":"user","content":"Legacy fact"}]}';
    writeFileSync(legacyPath, legacyBytes);
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, label: "A", runtimeFactory });
    const id = session.id;
    const taskA = session.active.id;
    session.active.runtime.messages.push({ role: "user", content: "A only" });
    const taskB = session.createTask("B");
    await session.switchTask(taskB);
    session.active.runtime.messages.push({ role: "user", content: "B only" });
    await session.close();
    session = await loadTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sessionId: id, runtimeFactory });
    expect(session.active.id).toBe(taskB);
    expect(session.active.runtime.messages).toEqual([{ role: "user", content: "B only" }]);
    expect(JSON.stringify(session.active.runtime.messages)).not.toContain("Legacy fact");
    await session.switchTask(taskA);
    expect(session.active.runtime.messages).toEqual([{ role: "user", content: "A only" }]);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacyBytes);
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("active writer, ungranted root, and missing root fail closed before runtime activation", async () => {
  const f = fixture();
  const { runtimeFactory, activations } = fakeRuntimeFactory(f.home);
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, label: "A", runtimeFactory });
    const id = session.id;
    await expect(loadTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sessionId: id, runtimeFactory })).rejects.toThrow(/writer/);
    await session.close();
    await expect(loadTaskSession({ home: f.home, root: f.root, authorityId: "acp:other-profile", configId: CONFIG_ID, sessionId: id, runtimeFactory })).rejects.toThrow(/authority/);
    await expect(loadTaskSession({ home: f.home, root: f.otherRoot, authorityId: "local", configId: CONFIG_ID, sessionId: id, runtimeFactory })).rejects.toThrow(/root/);
    expect(activations).toHaveLength(1);
    rmSync(f.root, { recursive: true });
    await expect(loadTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sessionId: id, runtimeFactory })).rejects.toThrow();
    expect(activations).toHaveLength(1);
  } finally {
    if (session) { try { await session.close(); } catch { /* it may already be closed */ } }
    f.cleanup();
  }
});

test("config digest binds model and safety profile before runtime load", async () => {
  const f = fixture();
  const { runtimeFactory, activations } = fakeRuntimeFactory(f.home);
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    const cfg = new NekoConfig({
      provider: "openai_compat", model: "fixture-free", base_url: "https://example.invalid/v1",
      mode: "plan", sandbox: true, read_outside_root: false,
    }, null, {}, "");
    cfg.resolvedHome = f.home;
    const configId = taskSessionConfigId(cfg);
    expect(configId).toMatch(/^[a-f0-9]{64}$/);
    expect(taskSessionConfigId(cfg)).toBe(configId);
    expect(taskSessionConfigId(cfg.withModel("different-model"))).not.toBe(configId);
    expect(taskSessionConfigId(cfg, "auto")).not.toBe(configId);
    const lessRestrictive = new NekoConfig({ ...cfg.data, sandbox: false }, null, {}, "");
    lessRestrictive.resolvedHome = f.home;
    expect(taskSessionConfigId(lessRestrictive)).not.toBe(configId);
    const mcpAtA = new NekoConfig({ ...cfg.data, mcp_servers: {
      tools: { type: "http", url: "https://tools.example.invalid/a?access_token=synthetic-one" },
    } }, null, {}, "");
    const mcpAtB = new NekoConfig({ ...cfg.data, mcp_servers: {
      tools: { type: "http", url: "https://tools.example.invalid/b?access_token=synthetic-one" },
    } }, null, {}, "");
    const rotatedSecret = new NekoConfig({ ...cfg.data, mcp_servers: {
      tools: { type: "http", url: "https://tools.example.invalid/a?access_token=synthetic-two" },
    } }, null, {}, "");
    for (const variant of [mcpAtA, mcpAtB, rotatedSecret]) variant.resolvedHome = f.home;
    expect(taskSessionConfigId(mcpAtA)).not.toBe(taskSessionConfigId(mcpAtB));
    expect(taskSessionConfigId(mcpAtA)).toBe(taskSessionConfigId(rotatedSecret));

    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local", configId, label: "A", runtimeFactory });
    const id = session.id;
    await session.close();
    await expect(loadTaskSession({
      home: f.home, root: f.root, authorityId: "local", configId: taskSessionConfigId(cfg.withModel("different-model")),
      sessionId: id, runtimeFactory,
    })).rejects.toThrow(/configuration changed/);
    expect(activations).toHaveLength(1);
    session = await loadTaskSession({ home: f.home, root: f.root, authorityId: "local", configId, sessionId: id, runtimeFactory });
    expect(activations).toHaveLength(2);
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("stale writer lock is retained and load fails closed until explicit recovery", async () => {
  const f = fixture();
  const { runtimeFactory, activations } = fakeRuntimeFactory(f.home);
  try {
    const session = await createTaskSession({
      home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, label: "A", runtimeFactory,
    });
    const id = session.id;
    await session.close();
    const lockPath = join(f.home, ".neko-core", "task-sessions", `${id}.lock`);
    const staleBytes = JSON.stringify({ pid: 999999999, token: "synthetic-stale-lock" });
    writeFileSync(lockPath, staleBytes);
    await expect(loadTaskSession({
      home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sessionId: id, runtimeFactory,
    })).rejects.toThrow(/stale lock/);
    expect(readFileSync(lockPath, "utf8")).toBe(staleBytes);
    expect(activations).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("pending turn or failed target runtime leaves the previous task selected with checkpoint intact", async () => {
  const f = fixture();
  const original = fakeRuntimeFactory(f.home);
  let failTarget = false;
  const runtimeFactory = (input: TaskRuntimeInput) => {
    if (failTarget && input.label === "B") throw new Error("Factory failed");
    return original.runtimeFactory(input);
  };
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, label: "A", runtimeFactory });
    const taskA = session.active.id;
    const taskB = session.createTask("B");
    session.active.runtime.messages.push({ role: "user", content: "A correction" });
    session.active.runtime.setQuiescent(false);
    await expect(session.switchTask(taskB)).rejects.toThrow(/Turn still active/);
    expect(session.active.id).toBe(taskA);
    session.active.runtime.setQuiescent(true);
    failTarget = true;
    await expect(session.switchTask(taskB)).rejects.toThrow(/Factory failed/);
    expect(session.active.id).toBe(taskA);
    expect(session.active.runtime.messages).toEqual([{ role: "user", content: "A correction" }]);
    failTarget = false;
    await session.switchTask(taskB);
    await session.switchTask(taskA);
    expect(session.active.runtime.messages).toEqual([{ role: "user", content: "A correction" }]);
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("failure to retire A reports committed B explicitly and B resumes after restart", async () => {
  const f = fixture();
  const baseFactory = fakeRuntimeFactory(f.home).runtimeFactory;
  const runtimeFactory = (input: TaskRuntimeInput) => {
    const runtime = baseFactory(input);
    if (input.label === "A") {
      return { ...runtime, close() { throw new Error("synthetic cleanup failure"); } };
    }
    return runtime;
  };
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, label: "A", runtimeFactory });
    const id = session.id;
    const taskB = session.createTask("B");
    let error: unknown;
    try { await session.switchTask(taskB); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(TaskSwitchCommittedError);
    if (!(error instanceof TaskSwitchCommittedError)) throw error;
    expect(error.committed).toBe(true);
    expect(error.activeTaskId).toBe(taskB);
    expect(session.active.id).toBe(taskB);
    session.active.runtime.messages.push({ role: "user", content: "B only after cleanup error" });
    await session.close();
    session = await loadTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sessionId: id, runtimeFactory });
    expect(session.active.id).toBe(taskB);
    expect(session.active.runtime.messages).toEqual([{ role: "user", content: "B only after cleanup error" }]);
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("interrupted tool blocks switching but close seals unknown outcome before checkpoint", async () => {
  const f = fixture();
  const baseFactory = fakeRuntimeFactory(f.home).runtimeFactory;
  let interrupted = true;
  const runtimeFactory = (input: TaskRuntimeInput) => {
    const runtime = baseFactory(input);
    return {
      ...runtime,
      assertQuiescent() { if (interrupted) throw new Error("Tool outcome unsettled"); },
      settleForClose() {
        if (interrupted) {
          runtime.messages.push({ role: "tool", tool_call_id: "call-1", content: "[outcome unknown; inspect before retry]" });
          interrupted = false;
        }
      },
    };
  };
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    session = await createTaskSession({
      home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, label: "A", runtimeFactory,
    });
    const id = session.id;
    const taskB = session.createTask("B");
    session.active.runtime.messages.push({
      role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "write", arguments: "{}" } }],
    });
    await expect(session.switchTask(taskB)).rejects.toThrow(/Tool outcome unsettled/);
    expect(session.active.label).toBe("A");
    await session.close();
    session = await loadTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sessionId: id, runtimeFactory });
    expect(session.active.label).toBe("A");
    expect(session.active.runtime.messages.at(-1)).toEqual({
      role: "tool", tool_call_id: "call-1", content: "[outcome unknown; inspect before retry]",
    });
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("stale revision rejects overwrite of a newer checkpoint", async () => {
  const f = fixture();
  const { runtimeFactory } = fakeRuntimeFactory(f.home);
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, label: "A", runtimeFactory });
    const path = join(f.home, ".neko-core", "task-sessions", `${session.id}.json`);
    const newer = JSON.parse(readFileSync(path, "utf8"));
    newer.revision += 1;
    writeFileSync(path, JSON.stringify(newer));
    session.active.runtime.messages.push({ role: "user", content: "must not replace newer" });
    const event = createCompactionSourceEvent(session.active.scope, 1, "stale-read", "config.ts",
      { role: "tool", tool_call_id: "stale-read", content: "stale source" });
    session.active.runtime.getSourceEvents().push(event);
    expect(() => session!.checkpoint()).toThrow(/revision conflict/);
    expect(readFileSync(path, "utf8")).not.toContain("must not replace newer");
    expect(readFileSync(path, "utf8")).not.toContain(event.id);
    // The stale coordinator deliberately keeps its writer lock until the process ends;
    // test cleanup removes only this synthetic fixture.
  } finally {
    f.cleanup();
  }
});

test("task v2 checkpoints source and working history together; direct-ID lookup survives restart", async () => {
  const f = fixture();
  const { runtimeFactory } = fakeRuntimeFactory(f.home);
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, label: "A", runtimeFactory });
    const id = session.id;
    const event = createCompactionSourceEvent(session.active.scope, 1, "read-a", "config.ts",
      { role: "tool", tool_call_id: "read-a", content: "historical packageManager=pnpm" });
    session.active.runtime.getSourceEvents().push(event);
    session.active.runtime.messages.push({ role: "assistant", content: null, tool_calls: [{ id: "read-a", name: "read_file", arguments: { path: "config.ts" } }] });
    session.active.runtime.messages.push({ ...event.result, _neko_source_event_id: event.id,
      _neko_source_projection_digest: sourceProjectionDigest(event.result) });
    session.checkpoint();
    const path = join(f.home, ".neko-core", "task-sessions", `${id}.json`);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.schemaVersion).toBe(2);
    expect(stored.tasks[0].sourceEvents[0].id).toBe(event.id);
    expect(stored.tasks[0].messages[1]._neko_source_event_id).toBe(event.id);
    await session.close();
    session = await loadTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sessionId: id, runtimeFactory });
    const registry = new ToolRegistry(f.root, "auto", () => false);
    registry.bindTaskScope(session.active.scope);
    // SAFETY: provider is never called by this exact-ID restore test.
    const agent = new Agent({ provider: { complete: async () => ({ content: "", tool_calls: [] }) } as any, tools: registry });
    agent.messages = session.active.runtime.getMessages();
    agent.restoreCompactionSourceEvents(session.active.runtime.getSourceEvents());
    expect(agent.compactionSourceEvent(event.id)?.result.content).toBe("historical packageManager=pnpm");
    expect(agent.compactionSourceEvent(event.id)?.verifiedPath).toBeNull();
    expect(agent.compactionSourceEvent(event.id)?.resourceRevision).toBeNull();
    await session.close();
    session = undefined;
    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.tasks[0].sourceEvents = [];
    const tamperedBytes = JSON.stringify(tampered);
    writeFileSync(path, tamperedBytes);
    await expect(loadTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sessionId: id, runtimeFactory }))
      .rejects.toThrow(/no matching raw observation/);
    expect(readFileSync(path, "utf8")).toBe(tamperedBytes);
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("task v1 requires explicit import without rewriting old bytes", async () => {
  const f = fixture();
  const { runtimeFactory } = fakeRuntimeFactory(f.home);
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, label: "A", runtimeFactory });
    const path = join(f.home, ".neko-core", "task-sessions", `${session.id}.json`);
    const id = session.id;
    await session.close();
    session = undefined;
    const old = JSON.parse(readFileSync(path, "utf8"));
    old.schemaVersion = 1;
    delete old.tasks[0].sourceEvents;
    const oldBytes = JSON.stringify(old);
    writeFileSync(path, oldBytes);
    await expect(loadTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sessionId: id, runtimeFactory }))
      .rejects.toThrow(/explicit import is required/);
    expect(readFileSync(path, "utf8")).toBe(oldBytes);
  } finally {
    await session?.close();
    f.cleanup();
  }
});

const FIXED_TASK_PROTOCOL = { version: 1, mode: "fixed-active-task" } as const;

test("fixed task receipt is durable, checkpoint-stable, and advances exactly once on explicit resume", async () => {
  const f = fixture();
  const { runtimeFactory, activations } = fakeRuntimeFactory(f.home);
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: CONFIG_ID, label: "A", taskProtocol: FIXED_TASK_PROTOCOL, runtimeFactory });
    const id = session.id;
    const first = session.receipt!;
    expect(first).toEqual({ version: 1, mode: "fixed-active-task", id: session.active.id,
      label: "A", root: session.active.root, activationEpoch: 1, activationId: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(Object.isFrozen(first)).toBe(true);
    expect(taskSessionExists(f.home, id)).toBe(true);
    expect(taskSessionExists(f.home, "f".repeat(32))).toBe(false);
    expect(() => session!.createTask("B")).toThrow(/Fixed task protocol/);
    await expect(session.switchTask(first.id)).rejects.toThrow(/Fixed task protocol/);
    session.active.runtime.messages.push({ role: "user", content: "A only" });
    session.checkpoint();
    expect(session.receipt).toEqual(first);
    await session.close();
    session = undefined;
    const path = join(f.home, ".neko-core", "task-sessions", `${id}.json`);
    const before = JSON.parse(readFileSync(path, "utf8"));
    expect(before.activeTaskId).toBe(first.id);
    expect(before.taskProtocol).toEqual({ version: 1, mode: "fixed-active-task",
      activationEpoch: 1, activationId: first.activationId });
    session = await loadTaskSession({ home: f.home, root: join(f.root, "."), authorityId: "local",
      configId: CONFIG_ID, sessionId: id, taskProtocol: FIXED_TASK_PROTOCOL, expectedTask: first, runtimeFactory });
    const second = session.receipt!;
    expect(second.id).toBe(first.id);
    expect(second.root).toBe(first.root);
    expect(second.activationEpoch).toBe(2);
    expect(second.activationId).toMatch(/^[a-f0-9]{32}$/);
    expect(second.activationId).not.toBe(first.activationId);
    expect(session.active.runtime.messages).toEqual([{ role: "user", content: "A only" }]);
    expect(activations.map(({ taskId }) => taskId)).toEqual([first.id, first.id]);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.taskProtocol.activationEpoch).toBe(2);
    expect(after.taskProtocol.activationId).toBe(second.activationId);
    expect(after.activeTaskId).toBe(first.id);
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("fixed resume rejects stale, wrong-root and absent protocol before runtime admission", async () => {
  const f = fixture();
  const { runtimeFactory, activations } = fakeRuntimeFactory(f.home);
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: CONFIG_ID, label: "A", taskProtocol: FIXED_TASK_PROTOCOL, runtimeFactory });
    const id = session.id;
    const first = session.receipt!;
    await session.close();
    session = undefined;
    const path = join(f.home, ".neko-core", "task-sessions", `${id}.json`);
    const bytes = readFileSync(path, "utf8");
    const request = { home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID,
      sessionId: id, taskProtocol: FIXED_TASK_PROTOCOL, runtimeFactory };
    await expect(loadTaskSession({ ...request, expectedTask: { ...first, id: "b".repeat(32) } }))
      .rejects.toThrow(/receipt does not match/);
    await expect(loadTaskSession({ ...request, expectedTask: { ...first, root: f.otherRoot } }))
      .rejects.toThrow(/receipt does not match/);
    await expect(loadTaskSession({ ...request, expectedTask: { ...first, activationEpoch: 0 } }))
      .rejects.toThrow(/valid prior task activation/);
    await expect(loadTaskSession({ ...request, expectedTask: { ...first, activationId: "b".repeat(32) } }))
      .rejects.toThrow(/receipt does not match/);
    await expect(loadTaskSession(request)).rejects.toThrow(/valid prior task activation/);
    await expect(loadTaskSession({ ...request, taskProtocol: undefined, expectedTask: undefined }))
      .rejects.toThrow(/protocol opt-in changed/);
    await expect(loadTaskSession({ ...request, configId: "b".repeat(64), expectedTask: first }))
      .rejects.toThrow(/provider or safety configuration changed/);
    expect(activations).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    session = await loadTaskSession({ ...request, expectedTask: first });
    const second = session.receipt!;
    await session.close();
    session = undefined;
    const resumedBytes = readFileSync(path, "utf8");
    // The epoch-2 response was lost; an epoch-1 retry may select recovery, but gets a new origin fence.
    session = await loadTaskSession({ ...request, expectedTask: first });
    expect(session.recoveredFromPriorReceipt).toBe(true);
    const third = session.receipt!;
    expect(third.activationEpoch).toBe(3);
    expect(third.activationId).not.toBe(second.activationId);
    expect(readFileSync(path, "utf8")).not.toBe(resumedBytes);
    await session.close();
    session = undefined;
    const thirdBytes = readFileSync(path, "utf8");
    await expect(loadTaskSession({ ...request, expectedTask: first }))
      .rejects.toBeInstanceOf(TaskSessionRecoveryRequiredError);
    expect(readFileSync(path, "utf8")).toBe(thirdBytes);
    session = await loadTaskSession({ ...request, expectedTask: third });
    expect(session.recoveredFromPriorReceipt).toBe(false);
    expect(session.receipt?.activationEpoch).toBe(4);
    expect(session.receipt?.activationId).not.toBe(third.activationId);
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("legacy task store never silently gains a protocol or admits a receipt", async () => {
  const f = fixture();
  const { runtimeFactory, activations } = fakeRuntimeFactory(f.home);
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: CONFIG_ID, label: "Legacy task", runtimeFactory });
    const id = session.id;
    expect(session.receipt).toBeNull();
    await session.close();
    session = undefined;
    const path = join(f.home, ".neko-core", "task-sessions", `${id}.json`);
    const bytes = readFileSync(path, "utf8");
    expect(bytes).not.toContain("taskProtocol");
    await expect(loadTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: CONFIG_ID, sessionId: id, taskProtocol: FIXED_TASK_PROTOCOL,
      expectedTask: { id: "a".repeat(32), root: f.root, activationEpoch: 1,
        activationId: "b".repeat(32) }, runtimeFactory })).rejects.toThrow(/protocol opt-in changed/);
    expect(activations).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    session = await loadTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: CONFIG_ID, sessionId: id, runtimeFactory });
    expect(session.receipt).toBeNull();
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("failed fixed activation leaves prior receipt durable and writer lock is typed", async () => {
  const f = fixture();
  const baseFactory = fakeRuntimeFactory(f.home).runtimeFactory;
  let failFactory = false;
  const runtimeFactory = (input: TaskRuntimeInput) => {
    if (failFactory) throw new Error("synthetic factory failure");
    return baseFactory(input);
  };
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: CONFIG_ID, label: "A", taskProtocol: FIXED_TASK_PROTOCOL, runtimeFactory });
    const first = session.receipt!;
    const id = session.id;
    await expect(loadTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID,
      sessionId: id, taskProtocol: FIXED_TASK_PROTOCOL, expectedTask: first, runtimeFactory }))
      .rejects.toBeInstanceOf(TaskSessionWriterUnavailableError);
    await session.close();
    session = undefined;
    const path = join(f.home, ".neko-core", "task-sessions", `${id}.json`);
    const bytes = readFileSync(path, "utf8");
    failFactory = true;
    await expect(loadTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID,
      sessionId: id, taskProtocol: FIXED_TASK_PROTOCOL, expectedTask: first, runtimeFactory }))
      .rejects.toThrow(/synthetic factory failure/);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    failFactory = false;
    session = await loadTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID,
      sessionId: id, taskProtocol: FIXED_TASK_PROTOCOL, expectedTask: first, runtimeFactory });
    expect(session.receipt?.activationEpoch).toBe(2);
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("malformed fixed protocol is present for routing but rejected before runtime admission", async () => {
  const f = fixture();
  const { runtimeFactory, activations } = fakeRuntimeFactory(f.home);
  let session: TaskSessionCoordinator<FakeRuntime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: CONFIG_ID, label: "A", taskProtocol: FIXED_TASK_PROTOCOL, runtimeFactory });
    const id = session.id;
    const first = session.receipt!;
    await session.close();
    session = undefined;
    const path = join(f.home, ".neko-core", "task-sessions", `${id}.json`);
    const corrupt = JSON.parse(readFileSync(path, "utf8"));
    corrupt.taskProtocol.priorActivation = { activationEpoch: 1,
      activationId: corrupt.taskProtocol.activationId };
    const corruptBytes = JSON.stringify(corrupt);
    writeFileSync(path, corruptBytes);
    expect(taskSessionExists(f.home, id)).toBe(true);
    await expect(loadTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: CONFIG_ID, sessionId: id, taskProtocol: FIXED_TASK_PROTOCOL,
      expectedTask: first, runtimeFactory })).rejects.toThrow(/Invalid fixed task protocol/);
    expect(activations).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(corruptBytes);
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("360 offline turns retain exact task/root memory through switches and clean restarts", async () => {
  const f = fixture();
  const { runtimeFactory } = fakeRuntimeFactory(f.home);
  const roots = [f.root, f.otherRoot];
  const sessions: TaskSessionCoordinator<FakeRuntime>[] = [];
  const ids: string[][] = [];
  const expected = new Map<string, { messages: unknown[]; memory: string }>();
  try {
    for (const [r, root] of roots.entries()) {
      const s = await createTaskSession({ home: f.home, root, authorityId: "local", configId: CONFIG_ID, label: `Root ${r} A`, runtimeFactory });
      sessions.push(s);
      ids.push([s.active.id, s.createTask(`Root ${r} B`)]);
      for (const id of ids[r]!) expected.set(id, { messages: [], memory: "" });
    }
    for (let turn = 0; turn < 360; turn++) {
      const rootIndex = turn % 2;
      const s = sessions[rootIndex]!;
      const taskId = ids[rootIndex]![Math.floor(turn / 2) % 2]!;
      await s.switchTask(taskId);
      const state = expected.get(taskId)!;
      expect(s.active.runtime.messages).toEqual(state.messages);
      if (state.memory) expect(readMemoryFile("current", f.home, s.active.scope)).toBe(state.memory);
      else expect(memoryTool({ action: "read", name: "current" }, f.home, s.active.scope)).toContain("no memory");
      const marker = `root-${rootIndex}/task-${taskId}/revision-${turn}`;
      const messages = [{ role: "user", content: `Correction: ${marker}` }, { role: "assistant", content: marker }];
      s.active.runtime.messages.push(...messages);
      state.messages.push(...messages);
      state.memory = `# ${marker}`;
      memoryTool({ action: "write", name: "current", content: state.memory }, f.home, s.active.scope);
      s.checkpoint();
      expect(readMemoryFile("current", f.home, s.active.scope)).toBe(state.memory);
      if ((turn + 1) % 60 === 0) {
        for (let r = 0; r < sessions.length; r++) {
          const previous = sessions[r]!;
          const sessionId = previous.id;
          const oldScope = previous.active.scope;
          await previous.close();
          expect(() => readMemoryFile("current", f.home, oldScope)).toThrow();
          await expect(loadTaskSession({ home: f.home, root: roots[1 - r]!, authorityId: "local", configId: CONFIG_ID, sessionId, runtimeFactory }))
            .rejects.toThrow("root changed");
          sessions[r] = await loadTaskSession({ home: f.home, root: roots[r]!, authorityId: "local", configId: CONFIG_ID, sessionId, runtimeFactory });
          expect(sessions[r]!.active.runtime.messages).toEqual(expected.get(sessions[r]!.active.id)!.messages);
        }
      }
    }
    for (const s of sessions) {
      for (const task of s.tasks) {
        await s.switchTask(task.id);
        expect(s.active.runtime.messages).toEqual(expected.get(task.id)!.messages);
        expect(readMemoryFile("current", f.home, s.active.scope)).toBe(expected.get(task.id)!.memory);
      }
    }
  } finally {
    for (const s of sessions) await s.close();
    f.cleanup();
  }
}, 30_000);

test("read-only status inspects active and stale locks without altering checkpoint or exposing content", async () => {
  const f = fixture();
  const { runtimeFactory } = fakeRuntimeFactory(f.home);
  const s = await createTaskSession({ home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, label: "A", runtimeFactory });
  const options = { home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID, sessionId: s.id };
  const path = join(f.home, ".neko-core", "task-sessions", `${s.id}.json`);
  const lockPath = join(f.home, ".neko-core", "task-sessions", `${s.id}.lock`);
  let closed = false;
  try {
    s.active.runtime.messages.push({ role: "assistant", content: "SYNTHETIC_PRIVATE_CONTENT", _neko_inflight: true });
    s.checkpoint();
    const checkpoint = readFileSync(path, "utf8");
    const lock = readFileSync(lockPath, "utf8");
    const report = inspectTaskSession(options);
    expect(report.writerLock).toBe("present");
    expect(report.tasks[0]!.inflightAssistantCount).toBe(1);
    expect(report.tasks[0]!.messageCount).toBe(1);
    expect(report.checkpointSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain("SYNTHETIC_PRIVATE_CONTENT");
    expect(JSON.stringify(report)).not.toContain(JSON.parse(lock).token);
    expect(readFileSync(path, "utf8")).toBe(checkpoint);
    expect(readFileSync(lockPath, "utf8")).toBe(lock);
    expect(() => inspectTaskSession({ ...options, root: f.otherRoot })).toThrow("root changed");
    expect(() => inspectTaskSession({ ...options, authorityId: "different" })).toThrow("authority changed");
    expect(() => inspectTaskSession({ ...options, configId: "b".repeat(64) })).toThrow("configuration changed");
    expect(readFileSync(path, "utf8")).toBe(checkpoint);
    await s.close();
    closed = true;
    expect(inspectTaskSession(options).writerLock).toBe("absent");
    const closedCheckpoint = readFileSync(path, "utf8");
    const stale = JSON.stringify({ pid: 5, token: "synthetic-unknown-owner", acquiredAt: "2000-01-01" });
    writeFileSync(lockPath, stale);
    expect(inspectTaskSession(options).writerLock).toBe("present");
    expect(readFileSync(lockPath, "utf8")).toBe(stale);
    expect(readFileSync(path, "utf8")).toBe(closedCheckpoint);
    await expect(loadTaskSession({ ...options, runtimeFactory })).rejects.toBeInstanceOf(TaskSessionWriterUnavailableError);
    expect(readFileSync(lockPath, "utf8")).toBe(stale);
  } finally {
    if (!closed) await s.close();
    f.cleanup();
  }
});

test("read-only status never creates a missing task store", () => {
  const f = fixture();
  try {
    expect(() => inspectTaskSession({ home: join(f.home, "never-created"), root: f.root,
      authorityId: "local", configId: CONFIG_ID, sessionId: "c".repeat(32) })).toThrow("not found");
    expect(existsSync(join(f.home, "never-created"))).toBe(false);
  } finally { f.cleanup(); }
});
