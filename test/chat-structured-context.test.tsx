import {expect, spyOn, test} from "bun:test";
import {render} from "ink-testing-library";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ChatApp, type ChatTaskLifecycle} from "../src/ui/chat.tsx";
import {loadConfig} from "../src/adapters/config.ts";
import {createTaskSession, TaskSessionCoordinator, taskSessionConfigId, type TaskRuntimeInput, type TaskSessionRuntime} from "../src/adapters/task-session.ts";
import {structuredScopeDigest, type StructuredContextState} from "../src/core/context/state.ts";
import type {Provider} from "../src/core/ports.ts";

const delay = (ms = 25) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean, limit = 6000) {
  const end = Date.now() + limit;
  while (!test() && Date.now() < end) await delay();
  return test();
}

test("TUI opt-in compact publishes a structured checkpoint and restart keeps the original transcript accessible", async () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "neko-ui-structured-"));
  mkdirSync(join(home, ".neko-core"));
  writeFileSync(join(home, ".neko-core", "config.json"), JSON.stringify({context_mode: "structured", auto_update: false}));
  process.env.HOME = process.env.USERPROFILE = home;
  let app: ReturnType<typeof render> | undefined;
  let lifecycle: ChatTaskLifecycle = {activeSessionId: null, shutdown: async () => {}};
  let shutdown = false, calls = 0;
  try {
    const cfg = loadConfig({cwd: process.cwd()});
    const session = await createTaskSession({home, root: process.cwd(), authorityId: "local", contextMode: "structured",
      configId: taskSessionConfigId(cfg, "auto"), label: "Structured fixture", runtimeFactory: (input: TaskRuntimeInput) => {
        const state: StructuredContextState = {version: 1, journal: {version: 1,
          scope: structuredScopeDigest(input.taskId, input.scope.canonicalRoot), head: null}, capsule: null};
        const messages = Array.from({length: 12}, (_, i) => [{role: "user", content: `STRUCTURED_ORIGINAL_${i}`},
          {role: "assistant", content: "source observation ".repeat(100)}]).flat();
        return {getMessages: () => messages, getSourceEvents: () => [], getStructuredContextState: () => state,
          assertQuiescent() {}, close() {}};
      }});
    await session.close();
    const path = join(home, ".neko-core", "task-sessions", `${session.id}.json`);
    const provider = {complete: async () => {calls++; return {content: "Historical source-backed summary", tool_calls: []};}};
    const send = async (text: string) => {app!.stdin.write(text); await delay(); app!.stdin.write("\r");};
    app = render(<ChatApp fullscreen yolo contextMemory provider={provider} taskLifecycle={lifecycle}/>);
    await send(`/task resume ${session.id}`);
    expect(await until(() => lifecycle.activeSessionId === session.id)).toBe(true);
    expect(await until(() => Boolean(app!.lastFrame()?.includes("source observation")) && !app!.lastFrame()?.includes("Loading earlier history"))).toBe(true);
    await send("/compact");
    expect(await until(() => Boolean(app!.frames.join("\n").includes("Compacted - freed")))) .toBe(true);
    const compacted = JSON.parse(readFileSync(path, "utf8"));
    expect(compacted.schemaVersion).toBe(3);
    expect(compacted.tasks[0].contextState.capsule).not.toBeNull();
    expect(compacted.tasks[0].messages.some((m: {role: string; _neko_context_capsule?: boolean}) => m.role === "assistant" && m._neko_context_capsule)).toBe(true);
    await lifecycle.shutdown(); shutdown = true; app.unmount();
    lifecycle = {activeSessionId: null, shutdown: async () => {}}; shutdown = false;
    app = render(<ChatApp fullscreen yolo contextMemory provider={provider} taskLifecycle={lifecycle}/>);
    await send(`/task resume ${session.id}`);
    expect(await until(() => lifecycle.activeSessionId === session.id)).toBe(true);
    expect(await until(() => Boolean(app!.lastFrame()?.includes("Compacted - freed")) && !app!.lastFrame()?.includes("Loading earlier history"))).toBe(true);
    app.stdin.write("\x1b[1;5H");
    const reached = await until(() => Boolean(app!.lastFrame()?.includes("STRUCTURED_ORIGINAL_0")));
    expect({reached, frame: app.lastFrame()}).toMatchObject({reached: true});
    expect(calls).toBe(1);
  } finally {
    if (!shutdown) await lifecycle.shutdown().catch(() => {});
    app?.unmount();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  }
}, 20000);

test("TUI cancellation cannot hide an uncertain published compact or overwrite it during shutdown", async () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "neko-ui-compact-fault-"));
  mkdirSync(join(home, ".neko-core"));
  writeFileSync(join(home, ".neko-core", "config.json"), JSON.stringify({context_mode: "structured", auto_update: false}));
  process.env.HOME = process.env.USERPROFILE = home;
  let app: ReturnType<typeof render> | undefined;
  const lifecycle: ChatTaskLifecycle = {activeSessionId: null, shutdown: async () => {}};
  let signal: AbortSignal | undefined, calls = 0;
  const controllers = new Map<AbortSignal, AbortController>();
  const signalDescriptor = Object.getOwnPropertyDescriptor(AbortController.prototype, "signal")!;
  Object.defineProperty(AbortController.prototype, "signal", {...signalDescriptor, get(this: AbortController) {
    const value: AbortSignal = signalDescriptor.get!.call(this);
    controllers.set(value, this);
    return value;
  }});
  const originalPublish = TaskSessionCoordinator.prototype.checkpointCompaction;
  const publication = spyOn(TaskSessionCoordinator.prototype, "checkpointCompaction").mockImplementation(function (
    this: TaskSessionCoordinator<TaskSessionRuntime>, ...args: Parameters<typeof originalPublish>
  ) {
    originalPublish.apply(this, args);
    // Use the real signal/controller pair, cancelling at the publication acknowledgement boundary.
    const controller = controllers.get(signal!);
    if (!controller) throw new Error("Compaction fixture did not capture its controller");
    controller.abort();
    throw new Error("synthetic lost publication acknowledgement");
  });
  try {
    const cfg = loadConfig({cwd: process.cwd()});
    const session = await createTaskSession({home, root: process.cwd(), authorityId: "local", contextMode: "structured",
      configId: taskSessionConfigId(cfg, "auto"), label: "Publication fault", runtimeFactory: (input: TaskRuntimeInput) => {
        const state: StructuredContextState = {version: 1, journal: {version: 1,
          scope: structuredScopeDigest(input.taskId, input.scope.canonicalRoot), head: null}, capsule: null};
        const messages = Array.from({length: 12}, (_, i) => [{role: "user", content: `FAULT_ORIGINAL_${i}`},
          {role: "assistant", content: "fault observation ".repeat(100)}]).flat();
        return {getMessages: () => messages, getSourceEvents: () => [], getStructuredContextState: () => state,
          assertQuiescent() {}, close() {}};
      }});
    await session.close();
    const path = join(home, ".neko-core", "task-sessions", `${session.id}.json`);
    const provider: Provider = {complete: async (_messages, _tools, _delta, received) => {
      calls++; signal = received;
      expect(await until(() => Boolean(app!.lastFrame()?.toLowerCase().includes("compacting")))).toBe(true);
      return {content: "Historical summary after publication", tool_calls: []};
    }};
    const send = async (text: string) => {app!.stdin.write(text); await delay(); app!.stdin.write("\r");};
    app = render(<ChatApp fullscreen yolo contextMemory provider={provider} taskLifecycle={lifecycle}/>);
    await send(`/task resume ${session.id}`);
    expect(await until(() => lifecycle.activeSessionId === session.id && Boolean(app!.lastFrame()?.includes("fault observation"))
      && !app!.lastFrame()?.includes("Loading earlier history"))).toBe(true);
    await send("/compact");
    expect(await until(() => Boolean(app!.frames.join("\n").includes("needs recovery")))).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(app.frames.join("\n")).not.toContain("Compaction cancelled; original context retained.");
    const published = readFileSync(path, "utf8");
    expect(JSON.parse(published).tasks[0].contextState.capsule).not.toBeNull();
    await send("must not start another model call");
    await delay(150);
    expect(calls).toBe(1);
    await lifecycle.shutdown();
    expect(readFileSync(path, "utf8")).toBe(published);
  } finally {
    publication.mockRestore();
    Object.defineProperty(AbortController.prototype, "signal", signalDescriptor);
    await lifecycle.shutdown().catch(() => {});
    app?.unmount();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  }
}, 20000);
