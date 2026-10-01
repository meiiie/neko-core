import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { createTaskSession, loadTaskSession, type TaskRuntimeInput, type TaskSessionCoordinator } from "../src/adapters/task-session.ts";
import { Agent } from "../src/core/agent.ts";
import { COMPACTION_PROMPT } from "../src/core/agent-constants.ts";
import { assertNoConfiguredCredentialInSourceEvents, createCompactionSourceEvent, MAX_COMPACTION_SOURCE_EVENTS, sourceProjectionDigest, sourceProjectionMatches } from "../src/core/compaction-source.ts";
import { createTaskScope } from "../src/core/task-scope.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

test("repeated compaction retains a task's raw source anchor when the first summary omits it", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-source-provenance-"));
  try {
    const scope = createTaskScope("task-a", root);
    const registry = new ToolRegistry(root, "auto", () => true);
    registry.bindTaskScope(scope);
    writeFileSync(join(root, "config.ts"), "packageManager=pnpm\n" + "synthetic=".repeat(400), "utf8");
    const sourceInputs: string[] = [];
    let workCalls = 0;
    const provider = { async complete(messages: any[]) {
      if (messages[0]?.content === COMPACTION_PROMPT) {
        sourceInputs.push(String(messages[1]?.content ?? ""));
        return { content: sourceInputs.length === 1 ? "Summary intentionally omits all source paths and IDs" : "Continue", tool_calls: [] };
      }
      if (workCalls++ === 0) return { content: null, tool_calls: [
        { id: "read-a", name: "read_file", arguments: { path: "config.ts" } },
      ] };
      return { content: "Done inspecting synthetic config", tool_calls: [] };
    } };
    // SAFETY: deterministic in-process provider; Agent executes only read_file on the synthetic fixture.
    const agent = new Agent({ provider: provider as any, tools: registry });
    await agent.run("Inspect task A config.ts");
    const event = agent.compactionSourceEvents()[0];
    expect(event).toBeDefined();
    expect(event.taskId).toBe(scope.id);
    expect(event.canonicalRoot).toBe(scope.canonicalRoot);
    expect(event.callId).toBe("read-a");
    expect(event.requestedPath).toBe("config.ts");
    const physical = realpathSync.native(join(root, "config.ts"));
    expect(event.verifiedPath).toBe(process.platform === "win32" ? physical.toLowerCase() : physical);
    expect(event.resourceRevision).toBe("sha256:" + createHash("sha256")
      .update("packageManager=pnpm\n" + "synthetic=".repeat(400)).digest("hex"));
    expect(event.messageDigest).toBe(createHash("sha256").update(JSON.stringify(event.result)).digest("hex"));
    const rawResult = String(event.result.content);
    // SAFETY: exercise local in-loop observation masking after a real Agent read_file result.
    expect((agent as any).shrinkOldObservations(0, 0)).toBe(true);
    const masked = agent.messages.find((message) => message.tool_call_id === "read-a");
    expect(masked?.content).toContain("chars elided to fit context");
    expect(String(agent.compactionSourceEvent(event.id)?.result.content)).toBe(rawResult);
    agent.messages.push(...Array.from({ length: 6 }, (_, i) => [
      { role: "user", content: `tail ${i}` }, { role: "assistant", content: `ack ${i}` },
    ]).flat());

    await agent.compact();
    agent.messages.push(...Array.from({ length: 5 }, (_, i) => [
      { role: "user", content: `new ${i}` }, { role: "assistant", content: `new ack ${i}` },
    ]).flat());
    await agent.compact();

    expect(sourceInputs).toHaveLength(2);
    expect(sourceInputs[1]).toContain(event.id); // bounded source ID, not a second full raw transcript
    expect(sourceInputs[1]).not.toContain("packageManager=pnpm");
    const historical = agent.compactionSourceEvent(event.id);
    expect(historical?.result.content).toContain("packageManager=pnpm");
    agent.messages.push({ role: "user", content: "Correction: config.ts now uses bun" });
    expect(agent.compactionSourceEvent(event.id)?.resourceRevision).toBe(event.resourceRevision); // historical bytes, not current truth
  } finally {
    const tempRoot = resolve(tmpdir()) + sep;
    if (!resolve(root).startsWith(tempRoot) || !basename(root).startsWith("neko-source-provenance-")) {
      throw new Error("Refusing to remove fixture outside its task temp directory");
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive overflow checkpoints one completed read result, then blocks compaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-source-provenance-"));
  try {
    const scope = createTaskScope("task-a", root);
    const registry = new ToolRegistry(root, "auto", () => true);
    registry.bindTaskScope(scope);
    writeFileSync(join(root, "config.ts"), "packageManager=pnpm\n", "utf8");
    const full = Array.from({ length: MAX_COMPACTION_SOURCE_EVENTS }, (_, i) =>
      createCompactionSourceEvent(scope, i + 1, `prior-${i}`, null,
        { role: "tool", tool_call_id: `prior-${i}`, content: `prior ${i}` }));
    let workCalls = 0;
    const checkpoints: string[] = [];
    let agent: Agent;
    const provider = { async complete() {
      if (workCalls++ === 0) return { content: null, tool_calls: [
        { id: "read-overflow", name: "read_file", arguments: { path: "config.ts" } },
      ] };
      return { content: "Unexpected second provider call", tool_calls: [] };
    } };
    // SAFETY: deterministic fixture provider; no external model or network request is made.
    agent = new Agent({ provider: provider as any, tools: registry,
      onCheckpoint: () => { checkpoints.push(JSON.stringify(agent.messages)); } });
    agent.restoreCompactionSourceEvents(full);
    await expect(agent.run("Read synthetic config")).rejects.toThrow(/source archive unavailable/);
    expect(workCalls).toBe(1);
    const results = agent.messages.filter((message) => message.role === "tool" && message.tool_call_id === "read-overflow");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("packageManager=pnpm");
    expect(results[0]._neko_source_unavailable).toBe(true);
    expect(checkpoints.some((snapshot) => snapshot.includes("packageManager=pnpm") && snapshot.includes("_neko_source_unavailable"))).toBe(true);
    expect(agent.compactionSourceEvents()).toHaveLength(MAX_COMPACTION_SOURCE_EVENTS);
    expect(JSON.stringify(agent.providerHistory())).not.toContain("_neko_source_unavailable");
    agent.messages.push(...Array.from({ length: 6 }, (_, i) => [
      { role: "user", content: `tail ${i}` }, { role: "assistant", content: `ack ${i}` },
    ]).flat());
    await expect(agent.compact()).rejects.toThrow(/no trusted result marker/);
    expect(agent.messages.some((message) => message.tool_call_id === "read-overflow")).toBe(true);
  } finally {
    const tempRoot = resolve(tmpdir()) + sep;
    if (!resolve(root).startsWith(tempRoot) || !basename(root).startsWith("neko-source-provenance-")) {
      throw new Error("Refusing to remove fixture outside its task temp directory");
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive overflow result survives task-session checkpoint and restart without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-source-provenance-"));
  let session: TaskSessionCoordinator<ReturnType<typeof runtimeFactory>> | undefined;
  let workCalls = 0;
  const provider = { async complete() {
    if (workCalls++ === 0) return { content: null, tool_calls: [
      { id: "read-overflow", name: "read_file", arguments: { path: "config.ts" } },
    ] };
    return { content: "Unexpected replay", tool_calls: [] };
  } };
  function runtimeFactory(input: TaskRuntimeInput) {
    const registry = new ToolRegistry(input.root, "auto", () => true);
    registry.bindTaskScope(input.scope);
    // SAFETY: fake provider performs no network call; checkpoint writes only this synthetic task store.
    const agent = new Agent({ provider: provider as any, tools: registry,
      onCheckpoint: () => { session?.checkpoint(); } });
    agent.messages = input.messages;
    agent.restoreCompactionSourceEvents(input.sourceEvents);
    return { agent, getMessages: () => agent.messages, getSourceEvents: () => agent.compactionSourceEvents(),
      assertQuiescent() {}, close() {} };
  }
  try {
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(root, "config.ts"), "packageManager=pnpm\n", "utf8");
    session = await createTaskSession({ home, root, authorityId: "local", configId: "a".repeat(64),
      label: "A", runtimeFactory });
    const id = session.id;
    const scope = session.active.scope;
    const full = Array.from({ length: MAX_COMPACTION_SOURCE_EVENTS }, (_, i) =>
      createCompactionSourceEvent(scope, i + 1, `prior-${i}`, null,
        { role: "tool", tool_call_id: `prior-${i}`, content: `prior ${i}` }));
    session.active.runtime.agent.restoreCompactionSourceEvents(full);
    await expect(session.active.runtime.agent.run("Read synthetic config")).rejects.toThrow(/source archive unavailable/);
    const path = join(home, ".neko-core", "task-sessions", `${id}.json`);
    const saved = JSON.parse(await Bun.file(path).text());
    expect(saved.tasks[0].messages.filter((message: { tool_call_id?: string }) => message.tool_call_id === "read-overflow")).toHaveLength(1);
    expect(saved.tasks[0].messages.some((message: { _neko_source_unavailable?: boolean }) => message._neko_source_unavailable)).toBe(true);
    expect(saved.tasks[0].sourceEvents).toHaveLength(MAX_COMPACTION_SOURCE_EVENTS);
    await session.close();
    session = await loadTaskSession({ home, root, authorityId: "local", configId: "a".repeat(64),
      sessionId: id, runtimeFactory });
    expect(session.active.runtime.agent.messages.filter((message) => message.tool_call_id === "read-overflow")).toHaveLength(1);
    expect(workCalls).toBe(1);
  } finally {
    await session?.close();
    const tempRoot = resolve(tmpdir()) + sep;
    if (!resolve(root).startsWith(tempRoot) || !basename(root).startsWith("neko-source-provenance-")) {
      throw new Error("Refusing to remove fixture outside its task temp directory");
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical source IDs reject another task/root and a forged clipped projection", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-source-provenance-"));
  try {
    mkdirSync(join(root, "a", "app"), { recursive: true });
    mkdirSync(join(root, "b", "app"), { recursive: true });
    const scopeA = createTaskScope("task-a", join(root, "a", "app"));
    const scopeB = createTaskScope("task-b", join(root, "b", "app"));
    const content = "a".repeat(2000);
    const event = createCompactionSourceEvent(scopeA, 1, "read-a", "config.ts",
      { role: "tool", tool_call_id: "read-a", content });
    const registry = new ToolRegistry(scopeB.canonicalRoot, "auto", () => true);
    registry.bindTaskScope(scopeB);
    // SAFETY: this test does not call the fixture provider.
    const agent = new Agent({ provider: { complete: async () => ({ content: "", tool_calls: [] }) } as any, tools: registry });
    expect(() => agent.restoreCompactionSourceEvents([event])).toThrow(/source event identity or digest/);
    expect(agent.compactionSourceEvent(event.id)).toBeUndefined();
    const clipped = { ...event.result, content: content.slice(0, 1200) + "\n... [800 chars elided to fit context] ...",
      _neko_source_event_id: event.id, _neko_source_clipped: true, _neko_source_projection_digest: "" };
    clipped._neko_source_projection_digest = sourceProjectionDigest(clipped);
    expect(sourceProjectionMatches(event, clipped)).toBe(true);
    clipped.content = "x" + String(clipped.content).slice(1);
    clipped._neko_source_projection_digest = sourceProjectionDigest(clipped);
    expect(sourceProjectionMatches(event, clipped)).toBe(false);
  } finally {
    const tempRoot = resolve(tmpdir()) + sep;
    if (!resolve(root).startsWith(tempRoot) || !basename(root).startsWith("neko-source-provenance-")) {
      throw new Error("Refusing to remove fixture outside its task temp directory");
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped image-array read evidence refuses masking before history mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-source-provenance-"));
  try {
    const scope = createTaskScope("task-a", root);
    const registry = new ToolRegistry(root, "auto", () => true);
    registry.bindTaskScope(scope);
    const result = { role: "tool", tool_call_id: "read-image", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] };
    const event = createCompactionSourceEvent(scope, 1, "read-image", "config.ts", result);
    // SAFETY: this test only invokes a local masking method; no provider call is possible.
    const agent = new Agent({ provider: { complete: async () => ({ content: "", tool_calls: [] }) } as any, tools: registry });
    agent.restoreCompactionSourceEvents([event]);
    agent.messages = [
      { role: "user", content: "synthetic image masking boundary" },
      { role: "assistant", tool_calls: [{ id: "read-image", name: "read_file", arguments: { path: "config.ts" } }] },
      { ...result, _neko_source_event_id: event.id, _neko_source_projection_digest: sourceProjectionDigest(result) },
      { role: "tool", tool_call_id: "later-1", content: result.content },
      { role: "tool", tool_call_id: "later-2", content: result.content },
    ];
    const before = JSON.stringify(agent.messages);
    // SAFETY: exercise the private masking boundary with synthetic image observations only.
    expect(() => (agent as any).shrinkOldObservations(0, 0)).toThrow(/cannot be masked/);
    expect(JSON.stringify(agent.messages)).toBe(before);
  } finally {
    const tempRoot = resolve(tmpdir()) + sep;
    if (!resolve(root).startsWith(tempRoot) || !basename(root).startsWith("neko-source-provenance-")) {
      throw new Error("Refusing to remove fixture outside its task temp directory");
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured credential guard checks nested values and keys with token-free error", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-source-provenance-"));
  try {
    const scope = createTaskScope("task-a", root);
    const key = "synthetic_credential_123";
    const event = createCompactionSourceEvent(scope, 1, "read-a", "config.ts",
      { role: "tool", tool_call_id: "read-a", content: [{ [key]: "fixture" }] });
    let message = "";
    try { assertNoConfiguredCredentialInSourceEvents([event], key); }
    catch (error) { message = String(error); }
    expect(message).toContain("checkpoint blocked");
    expect(message).not.toContain(key);
    assertNoConfiguredCredentialInSourceEvents([event], undefined);
    assertNoConfiguredCredentialInSourceEvents([event], "short");
  } finally {
    const tempRoot = resolve(tmpdir()) + sep;
    if (!resolve(root).startsWith(tempRoot) || !basename(root).startsWith("neko-source-provenance-")) {
      throw new Error("Refusing to remove fixture outside its task temp directory");
    }
    rmSync(root, { recursive: true, force: true });
  }
});
