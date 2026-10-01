import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { createTaskSession, loadTaskSession, type TaskRuntimeInput, type TaskSessionCoordinator } from "../src/adapters/task-session.ts";
import { createTaskScope, taskScopeIsActive, type TaskScope } from "../src/core/task-scope.ts";
import { ToolRegistry, type NativeToolBackend } from "../src/core/tool-runtime.ts";

const CONFIG_ID = "a".repeat(64);
const AUTHORITY_ID = "b".repeat(64);
const FIXED_PROTOCOL = { version: 1, mode: "fixed-active-task", executionVersion: 1 } as const;

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "neko-task-binding-"));
  const root = join(base, "root");
  const home = join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
  return {
    root, home,
    cleanup() {
      const normalized = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
      if (!normalized(base).startsWith(normalized(tmpdir()) + sep)
        || !basename(base).startsWith("neko-task-binding-")) {
        throw new Error("Refusing cleanup outside the task binding fixture");
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function fakeRuntime(input: TaskRuntimeInput, home: string) {
  const registry = new ToolRegistry(input.root, "auto", () => false);
  registry.memoryHome = home;
  registry.sandboxBash = false;
  registry.bindTaskScope(input.scope);
  return {
    registry,
    getMessages: () => input.messages,
    getSourceEvents: () => input.sourceEvents,
    assertQuiescent() {},
    close() {},
  };
}

type Runtime = ReturnType<typeof fakeRuntime>;

function expectExecutionReceipt(registry: ToolRegistry, scope: TaskScope) {
  expect(registry.taskExecutionReceipt()).toMatchObject({
    version: 1, taskId: scope.id, root: scope.canonicalRoot,
    activationEpoch: scope.activationEpoch, activationId: scope.activationId,
    authorityId: scope.executionAuthorityId ?? null,
    bashTarget: "host", confinement: "none", osAuthority: "not-attested",
  });
}

test("A to B to A creates fresh execution activations and retires retained registries", async () => {
  const f = fixture();
  let session: TaskSessionCoordinator<Runtime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: CONFIG_ID, label: "A", runtimeFactory: (input) => fakeRuntime(input, f.home) });
    const a = session.active;
    writeFileSync(join(f.root, "rewind.txt"), "original", "utf8");
    expect(await a.runtime.registry.execute("write_file", { path: "rewind.txt", content: "A wrote" }))
      .toStartWith("Wrote ");
    const taskB = session.createTask("B");
    await session.switchTask(taskB);
    const b = session.active;
    expect(() => a.runtime.registry.restoreCheckpoint()).toThrow("activation is retired");
    expect(readFileSync(join(f.root, "rewind.txt"), "utf8")).toBe("A wrote");
    expect(b.scope.activationEpoch).toBe(a.scope.activationEpoch + 1);
    expect(b.scope.activationId).not.toBe(a.scope.activationId);
    expect(await a.runtime.registry.execute("write_file", { path: "retired-a.txt", content: "blocked" }))
      .toContain("activation is retired");
    expect(existsSync(join(f.root, "retired-a.txt"))).toBe(false);

    await session.switchTask(a.id);
    const resumedA = session.active;
    expect(resumedA.id).toBe(a.id);
    expect(resumedA.scope).not.toBe(a.scope);
    expect(resumedA.scope.activationEpoch).toBe(b.scope.activationEpoch + 1);
    expect(resumedA.scope.activationId).not.toBe(a.scope.activationId);
    expect(await b.runtime.registry.execute("write_file", { path: "retired-b.txt", content: "blocked" }))
      .toContain("activation is retired");
    expect(existsSync(join(f.root, "retired-b.txt"))).toBe(false);
    expectExecutionReceipt(resumedA.runtime.registry, resumedA.scope);
    expect(await resumedA.runtime.registry.execute("write_file", { path: "active-a.txt", content: "active" }))
      .toStartWith("Wrote ");
    expect(readFileSync(join(f.root, "active-a.txt"), "utf8")).toBe("active");
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("fixed-task close and resume rotate the scope and agree with the runtime receipt", async () => {
  const f = fixture();
  const options = { home: f.home, root: f.root, authorityId: "local", configId: CONFIG_ID,
    executionAuthorityId: AUTHORITY_ID, taskProtocol: FIXED_PROTOCOL,
    runtimeFactory: (input: TaskRuntimeInput) => fakeRuntime(input, f.home) };
  let session: TaskSessionCoordinator<Runtime> | undefined;
  try {
    session = await createTaskSession({ ...options, label: "Fixed task" });
    const id = session.id;
    const initial = session.active;
    const priorReceipt = session.receipt!;
    expect(priorReceipt).toMatchObject({ id: initial.id, root: initial.scope.canonicalRoot,
      activationEpoch: initial.scope.activationEpoch, activationId: initial.scope.activationId });
    expectExecutionReceipt(initial.runtime.registry, initial.scope);
    await session.close();
    session = undefined;
    expect(taskScopeIsActive(initial.scope)).toBe(false);
    expect(await initial.runtime.registry.execute("write_file", { path: "closed.txt", content: "blocked" }))
      .toContain("activation is retired");
    expect(existsSync(join(f.root, "closed.txt"))).toBe(false);

    session = await loadTaskSession({ ...options, sessionId: id, expectedTask: priorReceipt });
    const resumed = session.active;
    expect(resumed.id).toBe(initial.id);
    expect(resumed.scope).not.toBe(initial.scope);
    expect(resumed.scope.activationEpoch).toBe(initial.scope.activationEpoch + 1);
    expect(resumed.scope.activationId).not.toBe(initial.scope.activationId);
    expect(session.receipt).toMatchObject({ id: resumed.id, root: resumed.scope.canonicalRoot,
      activationEpoch: resumed.scope.activationEpoch, activationId: resumed.scope.activationId });
    expectExecutionReceipt(resumed.runtime.registry, resumed.scope);
    expect(await resumed.runtime.registry.execute("write_file", { path: "resumed.txt", content: "resumed" }))
      .toStartWith("Wrote ");
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("explicit host auto writes without a routine prompt and reports approval independently", async () => {
  const f = fixture();
  let prompts = 0;
  try {
    const registry = new ToolRegistry(f.root, "auto", () => { prompts++; return false; });
    registry.memoryHome = f.home;
    registry.sandboxBash = false;
    const scope = createTaskScope("host-auto", f.root);
    registry.bindTaskScope(scope);
    expect(await registry.execute("write_file", { path: "auto.txt", content: "host auto" })).toStartWith("Wrote ");
    expect(readFileSync(join(f.root, "auto.txt"), "utf8")).toBe("host auto");
    expect(prompts).toBe(0);
    expectExecutionReceipt(registry, scope);
    expect(registry.taskExecutionReceipt()?.approval).toEqual({ mode: "auto", yolo: false });
    registry.mode = "default";
    expect(registry.taskExecutionReceipt()).toMatchObject({ bashTarget: "host",
      approval: { mode: "default", yolo: false } });
  } finally { f.cleanup(); }
});

for (const ceiling of ["denied", "allowlist"] as const) {
  test(`activated ${ceiling} capability ceiling survives public set widening`, async () => {
    const f = fixture();
    try {
      const registry = new ToolRegistry(f.root, "auto", () => false);
      registry.memoryHome = f.home;
      if (ceiling === "denied") registry.disabled.add("write_file");
      else registry.allowOnlyTools(["read_file"]);
      registry.bindTaskScope(createTaskScope(`ceiling-${ceiling}`, f.root));
      if (ceiling === "denied") registry.disabled.clear();
      else registry.toolAllowlist!.add("write_file");
      expect(registry.isToolAvailable("write_file")).toBe(false);
      expect(registry.schemas().some((schema) => schema.function.name === "write_file")).toBe(false);
      expect(await registry.execute("write_file", { path: "widened.txt", content: "blocked" }))
        .toContain("activated task capability ceiling");
      expect(existsSync(join(f.root, "widened.txt"))).toBe(false);
    } finally { f.cleanup(); }
  });
}

for (const native of [false, true]) {
  test(`target drift during approval blocks ${native ? "native backend" : "local host"} mutation`, async () => {
    const f = fixture();
    let dispatches = 0;
    let approve!: (value: boolean) => void;
    let awaitingApproval!: () => void;
    const approvalStarted = new Promise<void>((resolve) => { awaitingApproval = resolve; });
    const approvalResult = new Promise<boolean>((resolve) => { approve = resolve; });
    const backend: NativeToolBackend = {
      tools: ["write_file"],
      attestation: {
        protocol: "neko-native-posix-v1", canonicalPosixRoot: "/workspace",
        pathChecks: "backend-enforced", structuredWriteConfinement: "backend-enforced",
        exactEditTarget: "backend-enforced", bashSandbox: "unsupported", exactValidatorSandbox: "unsupported",
        boundedObservations: "backend-enforced", deadlineAndCancellation: "backend-enforced-quiescent",
        checkpointRewind: "unsupported",
      },
      execute: async () => { dispatches++; return "Wrote pending.txt"; },
    };
    try {
      const registry = new ToolRegistry(f.root, "default", () => {
        awaitingApproval();
        return approvalResult;
      }, undefined, native ? backend : undefined);
      registry.memoryHome = f.home;
      registry.sandboxBash = false;
      registry.bindTaskScope(createTaskScope("approval-drift", f.root));
      const pending = registry.execute("write_file", { path: "pending.txt", content: "blocked" });
      await approvalStarted;
      registry.sandboxBash = true;
      approve(true);
      expect(await pending).toContain("execution target or capabilities changed");
      expect(dispatches).toBe(0);
      expect(existsSync(join(f.root, "pending.txt"))).toBe(false);
    } finally {
      approve(false);
      f.cleanup();
    }
  });
}

test("JSON that copies a runtime scope cannot activate execution authority", () => {
  const f = fixture();
  try {
    const scope = createTaskScope("trusted", f.root, { activationEpoch: 7,
      activationId: "c".repeat(32), executionAuthorityId: AUTHORITY_ID });
    // SAFETY: this intentionally unbranded JSON copy tests rejection at the exported boundary.
    const forged = JSON.parse(JSON.stringify(scope)) as TaskScope;
    expect(forged).toEqual(scope);
    const registry = new ToolRegistry(f.root, "auto", () => false);
    registry.memoryHome = f.home;
    expect(() => registry.bindTaskScope(forged)).toThrow("active runtime");
    expect(registry.taskScope).toBeUndefined();
    expect(registry.taskExecutionReceipt()).toBeUndefined();
    registry.bindTaskScope(scope);
    expectExecutionReceipt(registry, scope);
  } finally { f.cleanup(); }
});

test("a factory that retains a registry then throws cannot retain the candidate activation", async () => {
  const f = fixture();
  let retained: ToolRegistry | undefined;
  let rejectActivation = false;
  const runtimeFactory = (input: TaskRuntimeInput) => {
    const runtime = fakeRuntime(input, f.home);
    if (rejectActivation) {
      retained = runtime.registry;
      throw new Error("Synthetic factory failure");
    }
    return runtime;
  };
  let session: TaskSessionCoordinator<Runtime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: CONFIG_ID, label: "A", runtimeFactory });
    const active = session.active;
    const taskB = session.createTask("B");
    rejectActivation = true;
    await expect(session.switchTask(taskB)).rejects.toThrow("Synthetic factory failure");
    expect(session.active.id).toBe(active.id);
    expect(session.active.scope).toBe(active.scope);
    expect(taskScopeIsActive(active.scope)).toBe(true);
    expect(retained).toBeDefined();
    expect(await retained!.execute("write_file", { path: "failed-activation.txt", content: "blocked" }))
      .toContain("activation is retired");
    expect(existsSync(join(f.root, "failed-activation.txt"))).toBe(false);
    expect(await active.runtime.registry.execute("write_file", { path: "still-active.txt", content: "active" }))
      .toStartWith("Wrote ");
  } finally {
    await session?.close();
    f.cleanup();
  }
});

test("failed close cleanup still retires the durably closed execution activation", async () => {
  const f = fixture();
  let failClose = true;
  let session: TaskSessionCoordinator<Runtime> | undefined;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: CONFIG_ID, label: "Close failure", runtimeFactory: (input) => ({
        ...fakeRuntime(input, f.home),
        close() { if (failClose) throw new Error("Synthetic cleanup failure"); },
      }) });
    const active = session.active;
    await expect(session.close()).rejects.toThrow("Synthetic cleanup failure");
    expect(taskScopeIsActive(active.scope)).toBe(false);
    expect(await active.runtime.registry.execute("write_file", { path: "failed-close.txt", content: "blocked" }))
      .toContain("activation is retired");
    expect(existsSync(join(f.root, "failed-close.txt"))).toBe(false);
  } finally {
    failClose = false;
    await session?.close();
    f.cleanup();
  }
});
for (const replacement of ["root", "nativeBackend"] as const) {
  test(`runtime JavaScript cannot replace the activated ${replacement}`, async () => {
    const f = fixture();
    let dispatches = 0;
    const backend: NativeToolBackend = {
      tools: ["write_file"], attestation: {
        protocol: "neko-native-posix-v1", canonicalPosixRoot: "/workspace",
        pathChecks: "backend-enforced", structuredWriteConfinement: "backend-enforced",
        exactEditTarget: "backend-enforced", bashSandbox: "unsupported", exactValidatorSandbox: "unsupported",
        boundedObservations: "backend-enforced", deadlineAndCancellation: "backend-enforced-quiescent",
        checkpointRewind: "unsupported",
      }, execute: async () => { dispatches++; return "Wrote redirected.txt"; },
    };
    try {
      const registry = new ToolRegistry(f.root, "auto", () => false, undefined, backend);
      registry.memoryHome = f.home;
      registry.bindTaskScope(createTaskScope(`replace-${replacement}`, f.root));
      Object.defineProperty(registry, replacement, { value: replacement === "root" ? f.home : { ...backend } });
      expect(await registry.execute("write_file", { path: "redirected.txt", content: "blocked" }))
        .toContain("execution target or capabilities changed");
      expect(dispatches).toBe(0);
      expect(existsSync(join(f.home, "redirected.txt"))).toBe(false);
    } finally { f.cleanup(); }
  });
}
