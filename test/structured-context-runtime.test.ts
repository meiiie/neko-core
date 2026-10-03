import {expect, test} from "bun:test";
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Agent} from "../src/core/agent.ts";
import {ToolRegistry} from "../src/core/tool-runtime.ts";
import {StructuredContextCompactor} from "../src/adapters/context/compactor.ts";
import {createTaskSession, loadTaskSession, type TaskRuntimeInput, type TaskSessionCoordinator} from "../src/adapters/task-session.ts";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "neko-context-runtime-")), home = join(base, "home"), root = join(base, "project");
  mkdirSync(home); mkdirSync(root); writeFileSync(join(root, "fixture.txt"), "ORIGINAL_TOOL_BYTES");
  let session: TaskSessionCoordinator<ReturnType<typeof factory>> | undefined;
  let calls = 0;
  const factory = (input: TaskRuntimeInput) => {
    const registry = new ToolRegistry(input.root, "plan", () => false); registry.bindTaskScope(input.scope);
    const context = new StructuredContextCompactor({home, scope: input.scope, messages: input.messages, state: input.contextState,
      inputBudget: () => 100000, credential: () => undefined,
      publish: (digest, messages, state) => session!.checkpointCompaction(digest, messages, state)});
    registry.bindContextSourceLookup(input.scope, id => context.lookup(id));
    const agent = new Agent({tools: registry, prepareCompaction: context.prepare, sourceArchiveCredential: () => undefined,
      onCheckpoint: () => session?.checkpoint(), maxSteps: 3, verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
      provider: {complete: async messages => {
        calls++;
        if (messages.length === 2 && String(messages[0].content).includes("Summarize")) return {content: "Historical work preserved. Current project is comet.", tool_calls: []};
        const last = messages.at(-1);
        if (last?.role === "user" && String(last.content).startsWith("read fixture")) return {content: null,
          tool_calls: [{id: `read-${calls}`, name: "read_file", arguments: {path: "fixture.txt"}}]};
        return {content: "ack", tool_calls: []};
      }}});
    agent.messages = input.messages; agent.restoreCompactionSourceEvents(input.sourceEvents);
    return {agent, registry, context,
      getMessages: () => {agent.assertContextReady(); return agent.messages;},
      getSourceEvents: () => agent.compactionSourceEvents(), getStructuredContextState: () => context.snapshot(agent.messages),
      assertQuiescent() {}, close() {}};
  };
  const options = {home, root, authorityId: "local", configId: "a".repeat(64), contextMode: "structured" as const, runtimeFactory: factory};
  return {options, setSession: (value: TaskSessionCoordinator<ReturnType<typeof factory>>) => {session = value;}, calls: () => calls};
}

test("real Agent/tool runtime compacts through one durable parent and restores scoped conversation lookup", async () => {
  const f = fixture(); let session = await createTaskSession({...f.options, label: "A"}); f.setSession(session);
  const runtime = session.active.runtime;
  for (let i = 0; i < 10; i++) {
    runtime.agent.messages.push({role: "user", content: `ORIGINAL_REQUEST_${i}: project comet uses pnpm port 4821`},
      {role: "assistant", content: "historical observation ".repeat(100)});
  }
  await runtime.agent.run("read fixture and preserve the exact bytes");
  session.checkpoint();
  expect(await runtime.agent.compact()).not.toBe("");
  const capsule = runtime.agent.messages.find(message => message._neko_context_capsule === true);
  expect(capsule?.role).toBe("assistant");
  expect(capsule?.content).toContain("Unverified derived note");
  const state = runtime.context.snapshot(runtime.agent.messages);
  expect(state.capsule).not.toBeNull();
  const stored = JSON.parse(readFileSync(join(f.options.home, ".neko-core", "task-sessions", `${session.id}.json`), "utf8"));
  expect(stored.tasks[0].messages).toEqual(runtime.agent.messages);
  expect(stored.tasks[0].contextState).toEqual(state);
  const id = state.capsule!.sources[0];
  const lookup = await runtime.registry.execute("source_lookup", {id});
  expect(String(lookup)).toContain("historical_context_snapshot");
  expect(String(lookup)).toContain("ORIGINAL_REQUEST_");
  expect(String(lookup)).not.toContain(f.options.root);
  await session.close();
  session = await loadTaskSession({...f.options, sessionId: session.id}); f.setSession(session);
  expect(session.active.runtime.agent.messages).toEqual(stored.tasks[0].messages);
  expect(String(await session.active.runtime.registry.execute("source_lookup", {id}))).toContain("ORIGINAL_REQUEST_");
  const other = session.createTask("B"); await session.switchTask(other);
  expect(String(await session.active.runtime.registry.execute("source_lookup", {id}))).not.toContain("ORIGINAL_REQUEST_");
  await session.close();
});
