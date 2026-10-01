import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, ProviderResponse } from "../src/adapters/providers.ts";
import { TaskSessionCoordinator } from "../src/adapters/task-session.ts";
import { Agent, COMPACTION_PROMPT } from "../src/core/agent.ts";
import { createCompactionSourceEvent } from "../src/core/compaction-source.ts";
import { createTaskScope } from "../src/core/task-scope.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { ChatApp, type ChatTaskLifecycle } from "../src/ui/chat.tsx";

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate: () => boolean, ms = 6000) => {
  for (let elapsed = 0; elapsed < ms && !predicate(); elapsed += 25) await tick();
  return predicate();
};

const taskLifecycle = (): ChatTaskLifecycle => ({ activeSessionId: null, shutdown: async () => {} });

// Windows can keep an already-closed fixture directory busy briefly after Ink unmount.
// Retry only that transient filesystem error; a persistent handle still fails this test.
const removeFixture = async (path: string) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EBUSY") || attempt === 9) throw error;
      await tick(100);
    }
  }
};

// Run every teardown step even when a previous close fails, and report every failure.
// Otherwise a rejected session close leaves cwd/HOME pointed at a test fixture.
const finishFixture = async (
  closeSteps: Array<() => void | Promise<void>>,
  restoreEnvironment: () => void,
  paths: string[],
) => {
  const failures: unknown[] = [];
  for (const step of closeSteps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  try { restoreEnvironment(); } catch (error) { failures.push(error); }
  for (const path of paths) {
    try { await removeFixture(path); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Task fixture teardown failed");
};

async function syntheticCompactionArchive(taskId: string, root: string) {
  writeFileSync(join(root, "config.ts"), "packageManager=pnpm", "utf8");
  const registry = new ToolRegistry(root, "auto", () => false);
  registry.bindTaskScope(createTaskScope(taskId, root));
  let ordinaryCalls = 0;
  const agent = new Agent({
    provider: { complete: async (messages) => {
      if (messages[0]?.content === COMPACTION_PROMPT) {
        return { content: "Synthetic summary omits the file source", tool_calls: [] };
      }
      if (++ordinaryCalls === 1) return {
        content: null, tool_calls: [{ id: "tui-source-read", name: "read_file", arguments: { path: "config.ts" } }],
      };
      return { content: "Read complete", tool_calls: [] };
    } },
    tools: registry,
    verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
  });
  await agent.run("Inspect A");
  for (let i = 0; i < 6; i++) await agent.run(`tail ${i}`);
  await agent.compact();
  const events = agent.compactionSourceEvents();
  expect(events.length).toBeGreaterThan(0);
  expect(JSON.stringify(events)).toContain("tui-source-read");
  return events;
}

class ProbeProvider implements Provider {
  calls: string[] = [];
  async complete(messages: any[]): Promise<ProviderResponse> {
    this.calls.push(JSON.stringify(messages));
    return { content: `reply ${this.calls.length}`, tool_calls: [] };
  }
}

test("TUI /task A -> B -> A and restart keeps working history and direct memory in the selected task", async () => {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const previousRoot = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "neko-ui-task-home-"));
  const root = mkdtempSync(join(tmpdir(), "neko-ui-task-root-"));
  let firstUnmount: (() => void) | undefined;
  let secondUnmount: (() => void) | undefined;
  const firstLifecycle = taskLifecycle();
  const secondLifecycle = taskLifecycle();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(root);
  const neko = join(home, ".neko-core");
  mkdirSync(join(neko, "memory"), { recursive: true });
  writeFileSync(join(neko, "config.json"), JSON.stringify({ auto_update_check: false, auto_update: false }));
  writeFileSync(join(neko, "memory", "shared.md"), "LEGACY SECRET ONLY\n");
  const provider = new ProbeProvider();
  const send = async (stdin: { write: (value: string) => void }, text: string) => {
    stdin.write(text);
    await tick(30);
    stdin.write("\r");
  };
  try {
    const first = render(<ChatApp fullscreen={false} yolo profile="local" provider={provider} taskLifecycle={firstLifecycle} />);
    firstUnmount = first.unmount;
    await send(first.stdin, "/task new Alpha");
    const storeDir = join(neko, "task-sessions");
    expect(await until(() => existsSync(storeDir) && readdirSync(storeDir).some((name) => name.endsWith(".json")))).toBe(true);
    const sessionId = readdirSync(storeDir).find((name) => name.endsWith(".json"))!.slice(0, -5);
    let snapshot = JSON.parse(readFileSync(join(storeDir, `${sessionId}.json`), "utf8"));
    // SAFETY: the test reads a coordinator-written fixture and asserts its persisted identity below.
    const alpha = snapshot.activeTaskId as string;
    await send(first.stdin, "/memory read shared.md");
    expect(await until(() => first.frames.join("\n").includes("(no memory 'shared.md')"))).toBe(true);
    expect(first.frames.join("\n")).not.toContain("LEGACY SECRET ONLY");
    await send(first.stdin, "/remember --user must-not-cross-task");
    expect(await until(() => first.frames.join("\n").includes("Shared /remember --user is unavailable"))).toBe(true);
    await send(first.stdin, "/resume");
    expect(await until(() => first.frames.join("\n").includes("Legacy /resume cannot enter"))).toBe(true);
    await send(first.stdin, "/model different-model");
    expect(await until(() => first.frames.join("\n").includes("Model changes are unavailable"))).toBe(true);
    await send(first.stdin, "/skills");
    expect(await until(() => first.frames.join("\n").includes("Shared skills are unavailable"))).toBe(true);
    await send(first.stdin, "/recipes");
    expect(await until(() => first.frames.join("\n").includes("Shared recipes are unavailable"))).toBe(true);
    await send(first.stdin, "/tools skill");
    expect(await until(() => first.frames.join("\n").includes("skill is unavailable in a scoped task"))).toBe(true);
    await send(first.stdin, "/sandbox network on example.com");
    expect(await until(() => first.frames.join("\n").includes("Sandbox network changes are unavailable"))).toBe(true);
    await send(first.stdin, "# alpha-scoped-fact");
    expect(await until(() => first.frames.join("\n").includes("Appended memory 'notes.md'"))).toBe(true);
    await send(first.stdin, "alpha-only request");
    expect(await until(() => provider.calls.length === 1)).toBe(true);
    await send(first.stdin, "/task new Beta");
    expect(await until(() => {
      snapshot = JSON.parse(readFileSync(join(storeDir, `${sessionId}.json`), "utf8"));
      return snapshot.activeTaskId !== alpha;
    })).toBe(true);
    expect(first.lastFrame()).not.toContain("alpha-only request");
    // SAFETY: the active id came from the coordinator's just-written test fixture.
    const beta = snapshot.activeTaskId as string;
    await send(first.stdin, "/memory read notes.md");
    expect(await until(() => first.frames.slice(-5).join("\n").includes("(no memory 'notes.md')"))).toBe(true);
    await send(first.stdin, "# beta-scoped-fact");
    await send(first.stdin, "beta-only request");
    expect(await until(() => provider.calls.length === 2)).toBe(true);
    expect(provider.calls[1]).toContain("beta-only request");
    expect(provider.calls[1]).not.toContain("alpha-only request");
    expect(provider.calls[1]).not.toContain("alpha-scoped-fact");
    await send(first.stdin, `/task use ${alpha}`);
    expect(await until(() => {
      snapshot = JSON.parse(readFileSync(join(storeDir, `${sessionId}.json`), "utf8"));
      return snapshot.activeTaskId === alpha;
    })).toBe(true);
    await send(first.stdin, "/memory read notes.md");
    expect(await until(() => first.frames.slice(-5).join("\n").includes("alpha-scoped-fact"))).toBe(true);
    expect(first.lastFrame()).not.toContain("beta-scoped-fact");
    expect(first.lastFrame()).not.toContain("beta-only request");
    await send(first.stdin, "alpha-again request");
    expect(await until(() => provider.calls.length === 3)).toBe(true);
    expect(provider.calls[2]).toContain("alpha-only request");
    expect(provider.calls[2]).toContain("alpha-again request");
    expect(provider.calls[2]).not.toContain("beta-only request");
    first.unmount();
    firstUnmount = undefined;
    await firstLifecycle.shutdown();
    expect(await until(() => !existsSync(join(storeDir, `${sessionId}.lock`)))).toBe(true);

    // Resume through Ink with a real Agent-produced source archive. Task switching must preserve
    // the source anchor even though the synthetic summary intentionally omitted it.
    const sourceEvents = await syntheticCompactionArchive(alpha, root);
    const seeded = JSON.parse(readFileSync(join(storeDir, `${sessionId}.json`), "utf8"));
    seeded.tasks.find((task: { id: string }) => task.id === alpha).sourceEvents = sourceEvents;
    writeFileSync(join(storeDir, `${sessionId}.json`), JSON.stringify(seeded));

    const second = render(<ChatApp fullscreen={false} yolo profile="local" provider={provider} taskLifecycle={secondLifecycle} />);
    secondUnmount = second.unmount;
    await send(second.stdin, `/task resume ${sessionId}`);
    if (!await until(() => second.frames.join("\n").includes(`Task Alpha (${alpha})`))) {
      throw new Error(`Task resume did not activate Alpha: ${(second.lastFrame() ?? "").slice(-1200)}`);
    }
    await send(second.stdin, "alpha-after-restart request");
    expect(await until(() => provider.calls.length === 4)).toBe(true);
    expect(provider.calls[3]).toContain("alpha-only request");
    expect(provider.calls[3]).not.toContain("beta-only request");
    await send(second.stdin, `/task use ${beta}`);
    expect(await until(() => JSON.parse(readFileSync(join(storeDir, `${sessionId}.json`), "utf8")).activeTaskId === beta)).toBe(true);
    const afterSwitch = JSON.parse(readFileSync(join(storeDir, `${sessionId}.json`), "utf8"));
    expect(afterSwitch.tasks.find((task: { id: string }) => task.id === alpha).sourceEvents).toEqual(sourceEvents);
    expect(afterSwitch.tasks.find((task: { id: string }) => task.id === beta).sourceEvents ?? []).toEqual([]);
    await send(second.stdin, `/task use ${alpha}`);
    expect(await until(() => JSON.parse(readFileSync(join(storeDir, `${sessionId}.json`), "utf8")).activeTaskId === alpha)).toBe(true);
    expect(readFileSync(join(neko, "memory", "shared.md"), "utf8")).toBe("LEGACY SECRET ONLY\n");
    expect(readdirSync(join(neko, "memory")).includes("notes.md")).toBe(false);
    expect(readFileSync(join(storeDir, `${sessionId}.json`), "utf8")).not.toContain("must-not-cross-task");
    expect(beta).not.toBe(alpha);
  } finally {
    await finishFixture(
      [() => secondUnmount?.(), () => firstUnmount?.(), () => secondLifecycle.shutdown(), () => firstLifecycle.shutdown()],
      () => {
        process.chdir(previousRoot);
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
      },
      [home, root],
    );
  }
}, 30_000);

test("TUI task shutdown barrier waits for checkpoint/lease close before handoff", async () => {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const previousRoot = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "neko-ui-task-close-home-"));
  const root = mkdtempSync(join(tmpdir(), "neko-ui-task-close-root-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(root);
  mkdirSync(join(home, ".neko-core"), { recursive: true });
  writeFileSync(join(home, ".neko-core", "config.json"), JSON.stringify({ auto_update_check: false, auto_update: false }));
  const originalClose = TaskSessionCoordinator.prototype.close;
  let releaseClose: (() => void) | undefined;
  TaskSessionCoordinator.prototype.close = async function () {
    await new Promise<void>((resolve) => { releaseClose = resolve; });
    return originalClose.call(this);
  };
  const lifecycle = taskLifecycle();
  const provider: Provider = { complete: async () => ({ content: "unused", tool_calls: [] }) };
  let unmount: (() => void) | undefined;
  try {
    const app = render(<ChatApp fullscreen={false} yolo profile="local" provider={provider} taskLifecycle={lifecycle} />);
    unmount = app.unmount;
    app.stdin.write("/task new Alpha"); await tick(30); app.stdin.write("\r");
    expect(await until(() => Boolean(lifecycle.activeSessionId))).toBe(true);
    const id = lifecycle.activeSessionId!;
    const lock = join(home, ".neko-core", "task-sessions", `${id}.lock`);
    expect(existsSync(lock)).toBe(true);
    app.unmount(); unmount = undefined;
    let closed = false;
    const shutdown = lifecycle.shutdown().then(() => { closed = true; });
    expect(await until(() => Boolean(releaseClose))).toBe(true);
    expect(closed).toBe(false);
    expect(existsSync(lock)).toBe(true);
    releaseClose?.();
    await shutdown;
    expect(closed).toBe(true);
    expect(existsSync(lock)).toBe(false);
  } finally {
    await finishFixture(
      [
        () => releaseClose?.(),
        () => unmount?.(),
        () => { TaskSessionCoordinator.prototype.close = originalClose; },
        () => lifecycle.shutdown(),
      ],
      () => {
        process.chdir(previousRoot);
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
      },
      [home, root],
    );
  }
}, 15_000);

test("TUI task switch does not carry an always-allow grant into the next task", async () => {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const previousMode = process.env.NEKO_MODE;
  const previousSandbox = process.env.NEKO_SANDBOX;
  const previousRoot = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "neko-ui-task-approval-home-"));
  const root = mkdtempSync(join(tmpdir(), "neko-ui-task-approval-root-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.NEKO_MODE = "default";
  process.env.NEKO_SANDBOX = "0";
  process.chdir(root);
  mkdirSync(join(home, ".neko-core"), { recursive: true });
  writeFileSync(join(home, ".neko-core", "config.json"), JSON.stringify({ auto_update_check: false, auto_update: false }));
  let calls = 0;
  const lifecycle = taskLifecycle();
  const trace: string[] = [];
  const provider: Provider = { complete: async (messages) => {
    calls++;
    const task = messages.some((message) => message.role === "user" && message.content === "write B") ? "b" : "a";
    const wrote = messages.some((message) => message.role === "tool" && message.tool_call_id === `${task}-write`);
    const inspected = messages.some((message) => message.role === "tool" && message.tool_call_id === `${task}-read`);
    trace.push(`${calls}:${task}:wrote=${wrote}:inspected=${inspected}`);
    if (!wrote) return {
      content: null,
      tool_calls: [{
        id: `${task}-write`,
        name: "write_file",
        arguments: { path: `${task}.txt`, content: task === "a" ? "A approved\n" : "B must ask\n" },
      }],
    };
    if (!inspected) return {
      content: null,
      tool_calls: [{ id: `${task}-read`, name: "read_file", arguments: { path: `${task}.txt` } }],
    };
    return { content: task === "a" ? "A finished" : "B finished", tool_calls: [] };
  } };
  const app = render(<ChatApp fullscreen={false} yolo={false} profile="local" provider={provider} taskLifecycle={lifecycle} />);
  const send = async (text: string) => { app.stdin.write(text); await tick(30); app.stdin.write("\r"); };
  try {
    await send("/task new Alpha");
    expect(await until(() => app.frames.join("\n").includes("Task Alpha"))).toBe(true);
    await send("write A");
    expect(await until(() => (app.lastFrame() ?? "").includes("Approve write_file?"))).toBe(true);
    app.stdin.write("a"); // explicit always allow for this task only
    if (!await until(() => existsSync(join(root, "a.txt")) && app.frames.join("\n").includes("A finished"))) {
      throw new Error(`A approval did not complete: calls=${calls}; wrote=${existsSync(join(root, "a.txt"))}; trace=${trace.join("|")}; frame=${(app.lastFrame() ?? "").slice(-900)}`);
    }
    await send("/task new Beta");
    expect(await until(() => (app.lastFrame() ?? "").includes("Task Beta"))).toBe(true);
    await send("write B");
    expect(await until(() => (app.lastFrame() ?? "").includes("Approve write_file?"))).toBe(true);
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    app.stdin.write("n");
    expect(await until(() => app.frames.join("\n").includes("B finished"))).toBe(true);
    expect(existsSync(join(root, "b.txt"))).toBe(false);
  } finally {
    await finishFixture(
      [() => app.unmount(), () => lifecycle.shutdown()],
      () => {
        process.chdir(previousRoot);
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
        if (previousMode === undefined) delete process.env.NEKO_MODE; else process.env.NEKO_MODE = previousMode;
        if (previousSandbox === undefined) delete process.env.NEKO_SANDBOX; else process.env.NEKO_SANDBOX = previousSandbox;
      },
      [home, root],
    );
  }
}, 30_000);

test("TUI task checkpoint rejects a configured key in a source archive without changing the saved task", async () => {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const previousKey = process.env.NEKO_API_KEY;
  const previousRoot = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "neko-ui-task-key-home-"));
  const root = mkdtempSync(join(tmpdir(), "neko-ui-task-key-root-"));
  const syntheticKey = "synthetic-fixture-key-no-account-123456";
  const lifecycle = taskLifecycle();
  let unmount: (() => void) | undefined;
  const originalSources = Agent.prototype.compactionSourceEvents;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.NEKO_API_KEY = syntheticKey;
  process.chdir(root);
  mkdirSync(join(home, ".neko-core"), { recursive: true });
  writeFileSync(join(home, ".neko-core", "config.json"), JSON.stringify({ auto_update_check: false, auto_update: false }));
  try {
    const provider: Provider = { complete: async () => ({ content: "unused", tool_calls: [] }) };
    const app = render(<ChatApp fullscreen={false} yolo profile="local" provider={provider} taskLifecycle={lifecycle} />);
    unmount = app.unmount;
    const send = async (value: string) => { app.stdin.write(value); await tick(30); app.stdin.write("\r"); };
    const storeDir = join(home, ".neko-core", "task-sessions");
    await send("/task new Alpha");
    expect(await until(() => existsSync(storeDir) && readdirSync(storeDir).some((name) => name.endsWith(".json")))).toBe(true);
    const path = join(storeDir, readdirSync(storeDir).find((name) => name.endsWith(".json"))!);
    const alpha = JSON.parse(readFileSync(path, "utf8")).activeTaskId;
    await send("/task new Beta");
    expect(await until(() => JSON.parse(readFileSync(path, "utf8")).activeTaskId !== alpha)).toBe(true);
    const beta = JSON.parse(readFileSync(path, "utf8")).activeTaskId;
    await send(`/task use ${alpha}`);
    expect(await until(() => JSON.parse(readFileSync(path, "utf8")).activeTaskId === alpha)).toBe(true);
    const before = readFileSync(path, "utf8");
    const event = createCompactionSourceEvent(createTaskScope(alpha, root), 1, "synthetic-secret-read", "config.ts", {
      role: "tool", tool_call_id: "synthetic-secret-read", content: `response includes ${syntheticKey}`,
    });
    // Inject only into the live Agent's export seam. The persisted fixture starts clean.
    Agent.prototype.compactionSourceEvents = function () { return [event]; };
    await send(`/task use ${beta}`);
    expect(await until(() => app.frames.join("\n").includes("source archive contains a configured credential"))).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readFileSync(path, "utf8")).not.toContain(syntheticKey);
  } finally {
    Agent.prototype.compactionSourceEvents = originalSources;
    await finishFixture(
      [() => unmount?.(), () => lifecycle.shutdown()],
      () => {
        process.chdir(previousRoot);
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
        if (previousKey === undefined) delete process.env.NEKO_API_KEY; else process.env.NEKO_API_KEY = previousKey;
      },
      [home, root],
    );
  }
}, 15_000);

test("TUI task source lookup survives two compactions and restart without crossing A to B", async () => {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const previousRoot = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "neko-ui-source-home-"));
  const root = mkdtempSync(join(tmpdir(), "neko-ui-source-root-"));
  const firstLifecycle = taskLifecycle();
  const secondLifecycle = taskLifecycle();
  let firstUnmount: (() => void) | undefined;
  let secondUnmount: (() => void) | undefined;
  const lookupObservations: string[] = [];
  let advertisedLookups = 0;
  let compactions = 0;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(root);
  mkdirSync(join(home, ".neko-core"), { recursive: true });
  writeFileSync(join(home, ".neko-core", "config.json"), JSON.stringify({ auto_update_check: false, auto_update: false }));
  writeFileSync(join(root, "config.ts"), "packageManager=pnpm\n", "utf8");
  const provider: Provider = { complete: async (messages, schemas) => {
    if (messages[0]?.content === COMPACTION_PROMPT) {
      compactions++;
      return { content: "Synthetic summary omits the file source", tool_calls: [] };
    }
    const user = [...messages].reverse().find((message) => message.role === "user"
      && String(message.content ?? "").length > 0 && !message._neko_internal);
    const request = String(user?.content ?? "");
    const last = messages.at(-1);
    if (request === "Capture config.ts") {
      return last?.role === "tool"
        ? { content: "Capture complete", tool_calls: [] }
        : { content: null, tool_calls: [{ id: "tui-real-read", name: "read_file", arguments: { path: "config.ts" } }] };
    }
    const sourceId = /^Historical source ID: ([a-f0-9]{64})$/.exec(request)?.[1];
    if (sourceId) {
      if (last?.role === "tool") {
        lookupObservations.push(String(last.content ?? ""));
        return { content: "Historical lookup complete", tool_calls: [] };
      }
      if (!schemas?.some((schema) => schema.function.name === "source_lookup")) {
        throw new Error("TUI did not advertise source_lookup to the fake provider");
      }
      advertisedLookups++;
      return { content: null, tool_calls: [{ id: "tui-source-lookup", name: "source_lookup", arguments: { id: sourceId } }] };
    }
    return { content: `done ${request}`, tool_calls: [] };
  } };
  const send = async (stdin: { write: (value: string) => void }, value: string) => {
    stdin.write(value);
    await tick(30);
    stdin.write("\r");
  };
  const storeDir = join(home, ".neko-core", "task-sessions");
  const saved = (sessionId: string) => JSON.parse(readFileSync(join(storeDir, `${sessionId}.json`), "utf8"));
  try {
    const first = render(<ChatApp fullscreen={false} yolo profile="local" provider={provider} taskLifecycle={firstLifecycle} />);
    firstUnmount = first.unmount;
    await send(first.stdin, "/task new Alpha");
    expect(await until(() => existsSync(storeDir) && readdirSync(storeDir).some((name) => name.endsWith(".json")))).toBe(true);
    const sessionId = readdirSync(storeDir).find((name) => name.endsWith(".json"))!.slice(0, -5);
    // SAFETY: this fixture reads a task-session record just created by the coordinator.
    const alphaId = saved(sessionId).activeTaskId as string;
    await send(first.stdin, "Capture config.ts");
    expect(await until(() => first.frames.join("\n").includes("Capture complete"))).toBe(true);
    expect(await until(() => saved(sessionId).tasks.find((task: { id: string }) => task.id === alphaId).sourceEvents.length === 1)).toBe(true);
    // SAFETY: the wait above confirmed this coordinator-written task has one source event.
    const sourceId = saved(sessionId).tasks.find((task: { id: string }) => task.id === alphaId).sourceEvents[0].id as string;
    expect(sourceId).toMatch(/^[a-f0-9]{64}$/);
    for (let index = 0; index < 6; index++) {
      await send(first.stdin, `tail ${index}`);
      expect(await until(() => first.frames.join("\n").includes(`done tail ${index}`))).toBe(true);
    }
    await send(first.stdin, "/compact");
    expect(await until(() => compactions === 1 && first.frames.join("\n").includes("Compacted"))).toBe(true);
    for (let index = 6; index < 12; index++) {
      await send(first.stdin, `tail ${index}`);
      expect(await until(() => first.frames.join("\n").includes(`done tail ${index}`))).toBe(true);
    }
    await send(first.stdin, "/compact");
    expect(await until(() => compactions === 2)).toBe(true);
    expect(await until(() => saved(sessionId).tasks.find((task: { id: string }) => task.id === alphaId).messages
      .some((message: { _neko_compaction_source_ids?: string[] }) => message._neko_compaction_source_ids?.includes(sourceId)))).toBe(true);

    await send(first.stdin, "/task new Beta");
    expect(await until(() => saved(sessionId).activeTaskId !== alphaId)).toBe(true);
    // SAFETY: the wait above confirmed this coordinator-written task switched away from Alpha.
    const betaId = saved(sessionId).activeTaskId as string;
    await send(first.stdin, `Historical source ID: ${sourceId}`);
    expect(await until(() => lookupObservations.length === 1)).toBe(true);
    expect(lookupObservations[0]).toContain("not found in the active task");
    expect(lookupObservations[0]).not.toContain("packageManager=pnpm");
    await send(first.stdin, `/task use ${alphaId}`);
    expect(await until(() => saved(sessionId).activeTaskId === alphaId)).toBe(true);
    await send(first.stdin, `Historical source ID: ${sourceId}`);
    expect(await until(() => lookupObservations.length === 2)).toBe(true);
    expect(lookupObservations[1]).toContain("packageManager=pnpm");
    expect(lookupObservations[1]).toContain("config.ts");
    expect(lookupObservations[1]).toContain("historical observed-byte digest sha256:");
    expect(lookupObservations[1]).toContain("not a current filesystem revision");
    expect(lookupObservations[1]).toContain("new read_file");
    first.unmount();
    firstUnmount = undefined;
    await firstLifecycle.shutdown();
    expect(await until(() => !existsSync(join(storeDir, `${sessionId}.lock`)))).toBe(true);

    const second = render(<ChatApp fullscreen={false} yolo profile="local" provider={provider} taskLifecycle={secondLifecycle} />);
    secondUnmount = second.unmount;
    await send(second.stdin, `/task resume ${sessionId}`);
    expect(await until(() => second.frames.join("\n").includes(`Task Alpha (${alphaId})`))).toBe(true);
    await send(second.stdin, `Historical source ID: ${sourceId}`);
    expect(await until(() => lookupObservations.length === 3)).toBe(true);
    expect(lookupObservations[2]).toContain("packageManager=pnpm");
    expect(lookupObservations[2]).toContain("historical observed-byte digest sha256:");
    expect(lookupObservations[2]).toContain("not a current filesystem revision");
    expect(lookupObservations[2]).toContain("new read_file");
    expect(advertisedLookups).toBe(3);
    expect(saved(sessionId).tasks.find((task: { id: string }) => task.id === betaId).sourceEvents).toEqual([]);
  } finally {
    await finishFixture(
      [() => secondUnmount?.(), () => firstUnmount?.(), () => secondLifecycle.shutdown(), () => firstLifecycle.shutdown()],
      () => {
        process.chdir(previousRoot);
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
      },
      [home, root],
    );
  }
}, 60_000);
