import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createTaskSession, loadTaskSession, type TaskRuntimeInput, type TaskSessionCoordinator } from "../src/adapters/task-session.ts";
import { Agent } from "../src/core/agent.ts";
import { COMPACTION_PROMPT } from "../src/core/agent-constants.ts";
import { createCompactionSourceEvent } from "../src/core/compaction-source.ts";
import { createTaskScope } from "../src/core/task-scope.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

function fixtureRoot(): string { return mkdtempSync(join(tmpdir(), "neko-source-lookup-")); }
function removeFixture(root: string): void {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith("neko-source-lookup-")) {
    throw new Error("Refusing to remove fixture outside its task temp directory");
  }
  rmSync(root, { recursive: true, force: true });
}

test("model source_lookup recovers historical result through task session after two compactions and restart", async () => {
  const root = fixtureRoot();
  let session: TaskSessionCoordinator<ReturnType<typeof runtimeFactory>> | undefined;
  let workCalls = 0;
  let mode = "read";
  let requestedId = "";
  let visibleId = "";
  const schemasSeen: string[][] = [];
  const provider = { async complete(messages: any[], schemas: any[]) {
    if (messages[0]?.content === COMPACTION_PROMPT) return { content: "Summary omits paths and IDs", tool_calls: [] };
    schemasSeen.push((schemas ?? []).map((schema: any) => schema.function?.name));
    if (mode === "read" && workCalls++ === 0) return { content: null, tool_calls: [
      { id: "read-config", name: "read_file", arguments: { path: "config.ts" } },
    ] };
    if (mode === "lookup" && workCalls++ === 2) {
      const capsule = messages.find((message: any) => String(message.content ?? "")
        .includes("historical read_file tool-result IDs for source_lookup"));
      visibleId = String(capsule?.content ?? "").match(/\b[a-f0-9]{64}\b/)?.[0] ?? "";
      return { content: null, tool_calls: [
        { id: "lookup-config", name: "source_lookup", arguments: { id: visibleId } },
      ] };
    }
    return { content: "Done", tool_calls: [] };
  } };
  function runtimeFactory(input: TaskRuntimeInput) {
    const registry = new ToolRegistry(input.root, "auto", () => true);
    registry.bindTaskScope(input.scope);
    // SAFETY: the fake provider runs only synthetic read/lookup tool calls; no network.
    const agent = new Agent({ provider: provider as any, tools: registry, sourceArchiveCredential: () => undefined,
      onCheckpoint: () => { session?.checkpoint(); } });
    agent.messages = input.messages;
    agent.restoreCompactionSourceEvents(input.sourceEvents);
    return { agent, registry, getMessages: () => agent.messages,
      getSourceEvents: () => agent.compactionSourceEvents(), assertQuiescent() {}, close() {} };
  }
  try {
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(root, "config.ts"), "packageManager=pnpm\n", "utf8");
    session = await createTaskSession({ home, root, authorityId: "local", configId: "a".repeat(64), label: "A", runtimeFactory });
    await session.active.runtime.agent.run("Read synthetic config");
    const source = session.active.runtime.agent.compactionSourceEvents()[0];
    requestedId = source.id;
    const resolvedPath = realpathSync.native(join(root, "config.ts"));
    expect(source.verifiedPath).toBe(process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath);
    expect(source.resourceRevision).toBe("sha256:" + createHash("sha256").update("packageManager=pnpm\n").digest("hex"));
    expect(() => session?.active.runtime.agent.restoreCompactionSourceEvents([
      { ...source, verifiedPath: join(root, "other.ts") },
    ])).toThrow(/identity|digest/);
    session.active.runtime.agent.messages.push(...Array.from({ length: 6 }, (_, i) => [
      { role: "user", content: "tail " + i }, { role: "assistant", content: "ack " + i + " historical observation".repeat(100) },
    ]).flat());
    await session.active.runtime.agent.compact();
    session.active.runtime.agent.messages.push(...Array.from({ length: 6 }, (_, i) => [
      { role: "user", content: "second " + i }, { role: "assistant", content: "second ack " + i + " historical observation".repeat(100) },
    ]).flat());
    await session.active.runtime.agent.compact();
    session.checkpoint();
    const id = session.id;
    await session.close();
    session = await loadTaskSession({ home, root, authorityId: "local", configId: "a".repeat(64), sessionId: id, runtimeFactory });
    writeFileSync(join(root, "config.ts"), "packageManager=bun\n", "utf8");
    mode = "lookup";
    await session.active.runtime.agent.run("Verify earlier source by ID");
    const lookup = session.active.runtime.agent.messages.find((message: any) => message.tool_call_id === "lookup-config");
    expect(schemasSeen.at(-1)).toContain("source_lookup");
    expect(visibleId).toBe(requestedId);
    expect(lookup?.content).toContain("packageManager=pnpm");
    expect(lookup?.content).not.toContain("packageManager=bun");
    expect(lookup?.content).toContain('root-relative path "config.ts"');
    expect(String(lookup?.content).toLowerCase()).not.toContain(root.toLowerCase());
    expect(String(await session.active.runtime.registry.execute("read_file", { path: "config.ts" }))).toContain("packageManager=bun");
    expect(lookup?.content).toContain("historical");
    expect(lookup?.content).toContain("read_file");
    expect(lookup?.content).toContain(requestedId);
    expect(lookup?.content).toContain("current");
  } finally {
    await session?.close();
    removeFixture(root);
  }
});

test("source_lookup rejects unscoped, wrong-task and wrong-root IDs without fallback", async () => {
  const root = fixtureRoot();
  try {
    const aRoot = join(root, "a", "app"), bRoot = join(root, "b", "app");
    mkdirSync(aRoot, { recursive: true });
    mkdirSync(bRoot, { recursive: true });
    const scopeA = createTaskScope("task-a", aRoot);
    const event = createCompactionSourceEvent(scopeA, 1, "read-a", "config.ts",
      { role: "tool", tool_call_id: "read-a", content: "A uses pnpm" });
    const unscoped = new ToolRegistry(aRoot, "auto", () => true);
    expect(unscoped.schemas().map((schema: any) => schema.function.name)).not.toContain("source_lookup");
    expect(await unscoped.execute("source_lookup", { id: event.id })).toMatch(/unavailable|blocked/i);
    const registryA = new ToolRegistry(aRoot, "auto", () => true);
    registryA.bindTaskScope(scopeA);
    // SAFETY: this stub provider never executes a model request.
    const agentA = new Agent({ provider: { complete: async () => ({ content: "", tool_calls: [] }) } as any,
      tools: registryA, sourceArchiveCredential: () => undefined });
    agentA.restoreCompactionSourceEvents([event]);
    expect(await registryA.execute("source_lookup", { id: event.id })).toContain("A uses pnpm");
    registryA.hooks = { preToolUse: "exit 7" };
    const driftDenied = String(await registryA.execute("source_lookup", { id: event.id }));
    expect(driftDenied).toContain("task execution target or capabilities changed");
    expect(driftDenied).not.toContain("A uses pnpm");
    registryA.hooks = undefined;
    const guardedRegistry = new ToolRegistry(aRoot, "auto", () => true);
    guardedRegistry.hooks = { preToolUse: "exit 7" };
    guardedRegistry.bindTaskScope(scopeA);
    const guardedAgent = new Agent({ provider: { complete: async () => ({ content: "", tool_calls: [] }) },
      tools: guardedRegistry, sourceArchiveCredential: () => undefined });
    guardedAgent.restoreCompactionSourceEvents([event]);
    const hookDenied = String(await guardedRegistry.execute("source_lookup", { id: event.id }));
    expect(hookDenied).toMatch(/Blocked by pre_tool_use hook/);
    expect(hookDenied).not.toContain("A uses pnpm");
    for (const scope of [createTaskScope("task-b", aRoot), createTaskScope("task-b", bRoot)]) {
      const registry = new ToolRegistry(scope.canonicalRoot, "auto", () => true);
      registry.bindTaskScope(scope);
      // SAFETY: this stub provider never executes a model request.
      new Agent({ provider: { complete: async () => ({ content: "", tool_calls: [] }) } as any,
        tools: registry, sourceArchiveCredential: () => undefined });
      expect(await registry.execute("source_lookup", { id: event.id })).not.toContain("A uses pnpm");
    }
    expect(await registryA.execute("source_lookup", { id: "z".repeat(64) })).not.toContain("A uses pnpm");
  } finally { removeFixture(root); }
});

test("out-of-range read result has no certified descriptor path or byte digest", async () => {
  const root = fixtureRoot();
  try {
    writeFileSync(join(root, "config.ts"), "one line\n", "utf8");
    const registry = new ToolRegistry(root, "auto", () => true);
    registry.bindTaskScope(createTaskScope("task-a", root));
    let calls = 0;
    const provider = { async complete() {
      if (calls++ === 0) return { content: null, tool_calls: [
        { id: "read-beyond", name: "read_file", arguments: { path: "config.ts", offset: 999 } },
      ] };
      return { content: "Done", tool_calls: [] };
    } };
    // SAFETY: the provider emits one deterministic read against the synthetic fixture.
    const agent = new Agent({ provider: provider as any, tools: registry,
      sourceArchiveCredential: () => undefined });
    await agent.run("Read beyond end in a synthetic file");
    const event = agent.compactionSourceEvents()[0];
    expect(String(event.result.content)).toContain("beyond end");
    expect(event.verifiedPath).toBeNull();
    expect(event.resourceRevision).toBeNull();
    expect(String(await registry.execute("source_lookup", { id: event.id }))).toContain("source revision unverified");
  } finally { removeFixture(root); }
});

test("parallel read_file results keep descriptor metadata on their matching calls", async () => {
  const root = fixtureRoot();
  try {
    writeFileSync(join(root, "left.ts"), "left=pnpm\n", "utf8");
    writeFileSync(join(root, "right.ts"), "right=bun\n", "utf8");
    const registry = new ToolRegistry(root, "auto", () => true);
    registry.bindTaskScope(createTaskScope("task-a", root));
    let calls = 0;
    const provider = { async complete() {
      if (calls++ === 0) return { content: null, tool_calls: [
        { id: "left-call", name: "read_file", arguments: { path: "left.ts" } },
        { id: "right-call", name: "read_file", arguments: { path: "right.ts" } },
      ] };
      return { content: "Done", tool_calls: [] };
    } };
    // SAFETY: deterministic provider reads only two synthetic files, with no network.
    const agent = new Agent({ provider: provider as any, tools: registry,
      sourceArchiveCredential: () => undefined });
    await agent.run("Read the two synthetic config files");
    const events = agent.compactionSourceEvents();
    expect(events).toHaveLength(2);
    const left = events.find((event) => event.callId === "left-call")!;
    const right = events.find((event) => event.callId === "right-call")!;
    expect(left.verifiedPath?.endsWith("left.ts")).toBe(true);
    expect(right.verifiedPath?.endsWith("right.ts")).toBe(true);
    expect(left.resourceRevision).toBe("sha256:" + createHash("sha256").update("left=pnpm\n").digest("hex"));
    expect(right.resourceRevision).toBe("sha256:" + createHash("sha256").update("right=bun\n").digest("hex"));
  } finally { removeFixture(root); }
});

test("source_lookup rejects tampered archive and bounds one historical result page", async () => {
  const root = fixtureRoot();
  try {
    const scope = createTaskScope("task-a", root);
    const registry = new ToolRegistry(root, "auto", () => true);
    registry.bindTaskScope(scope);
    // SAFETY: this stub provider never executes a model request.
    const agent = new Agent({ provider: { complete: async () => ({ content: "", tool_calls: [] }) } as any,
      tools: registry, sourceArchiveCredential: () => undefined });
    const event = createCompactionSourceEvent(scope, 1, "read-a", "synthetic.txt",
      { role: "tool", tool_call_id: "read-a", content: "synthetic fixture\n" + "x".repeat(20_000) });
    expect(() => agent.restoreCompactionSourceEvents([{ ...event, result: { ...event.result, content: "forged" } }])).toThrow(/digest|identity/);
    agent.restoreCompactionSourceEvents([event]);
    const page = String(await registry.execute("source_lookup", { id: event.id }));
    expect(page.length).toBeLessThan(10_000);
    expect(page).toContain("synthetic fixture");
    expect(page).toContain("historical");
    expect(page).not.toContain("x".repeat(10_000));
    const next = String(await registry.execute("source_lookup", { id: event.id, offset: 8000 }));
    expect(next).toContain("x".repeat(100));
    expect(String(await registry.execute("source_lookup", { id: event.id, offset: 99_999 }))).toMatch(/outside|invalid|range/i);
    for (const offset of [-1, 1.5, NaN, Infinity, "0"]) {
      expect(String(await registry.execute("source_lookup", { id: event.id, offset }))).toMatch(/invalid|arguments/i);
    }
  } finally { removeFixture(root); }
});

test("lookup cannot turn a denied credential read or a configured-key archive into secret output", async () => {
  const root = fixtureRoot();
  const syntheticKey = "synthetic_key_for_lookup_fixture";
  try {
    writeFileSync(join(root, ".env"), "SECRET=" + syntheticKey, "utf8");
    const scope = createTaskScope("task-a", root);
    const registry = new ToolRegistry(root, "auto", () => true);
    registry.bindTaskScope(scope);
    const provider = { async complete(_messages: any[], _schemas: any[]) {
      if (!this.called) { this.called = true; return { content: null, tool_calls: [
        { id: "read-denied", name: "read_file", arguments: { path: ".env" } },
      ] }; }
      return { content: "Done", tool_calls: [] };
    }, called: false };
    // SAFETY: the provider emits only a denied synthetic path read; no network.
    const agent = new Agent({ provider: provider as any, tools: registry,
      sourceArchiveCredential: () => syntheticKey });
    await agent.run("Try reading the denied synthetic path");
    const denied = agent.compactionSourceEvents()[0];
    expect(denied).toBeDefined(); // denials remain source events, never successful file reads
    expect(String(denied.result.content)).not.toContain(syntheticKey);
    expect(String(await registry.execute("source_lookup", { id: denied.id }))).not.toContain(syntheticKey);
    const injected = createCompactionSourceEvent(scope, 1, "read-injected", "ordinary.txt",
      { role: "tool", tool_call_id: "read-injected", content: "fixture=" + syntheticKey });
    agent.restoreCompactionSourceEvents([injected]);
    let refusal = "";
    try { refusal = String(await registry.execute("source_lookup", { id: injected.id })); }
    catch (error) { refusal = String(error); }
    expect(refusal).toMatch(/credential|blocked/i);
    expect(refusal).not.toContain(syntheticKey);
  } finally { removeFixture(root); }
});
