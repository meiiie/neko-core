import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskScope } from "../src/core/task-scope.ts";
import { memoryTool, coreMemoryBlock } from "../src/core/memory.ts";
import type { Provider } from "../src/core/ports.ts";
import type { TaskRuntimeInput } from "../src/adapters/task-session.ts";
import { buildDreamInput } from "../src/adapters/dream-input.ts";
import { prepareDream } from "../src/adapters/dream.ts";
import { DreamStore } from "../src/adapters/dream-store.ts";
import { DisplayHistory } from "../src/adapters/display-history.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "neko-dream-runtime-")), root = join(home, "repo-alias");
  const physicalRoot = join(home, "repo"); mkdirSync(physicalRoot);
  // Exercise canonical task admission even on Linux, where tmpdir is usually already physical.
  symlinkSync(physicalRoot, root, process.platform === "win32" ? "junction" : "dir");
  const scope = createTaskScope("task", root);
  const task: TaskRuntimeInput = { scope, root: scope.canonicalRoot, taskId: scope.id, label: "test", sessionId: "session",
    messages: [{ role: "system", content: "SECRET POLICY" }, { role: "user", content: "Use bun to run tests." },
      { role: "user", content: "INTERNAL SUMMARY", _neko_internal: true }, { role: "assistant", content: "I will use bun." }], sourceEvents: [] };
  return { home, root, scope, task, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
const output = (sourceId: string) => JSON.stringify({ summary: "Build", claims: [{ title: "Test runner", text: "Use bun to run tests.", status: "observed",
  citations: [{ sourceId, quote: "Use bun to run tests." }], corrects: [], related: [] }] });

test("dream captures only this task/home and calls one tool-free provider before reviewable activation", async () => {
  const f = fixture();
  try {
    memoryTool({ action: "write", name: "foreign", content: "FOREIGN LEGACY" }, f.home);
    const input = await buildDreamInput(f.home, f.task);
    expect(JSON.stringify(input)).not.toContain("SECRET POLICY");
    expect(JSON.stringify(input)).not.toContain("INTERNAL SUMMARY");
    expect(JSON.stringify(input)).not.toContain("FOREIGN LEGACY");
    let calls = 0;
    const provider: Provider = { complete: async (messages, tools, _delta, _signal, options) => {
      calls++; expect(tools).toEqual([]); expect(options?.executeTool).toBeUndefined();
      expect(messages[0].role).toBe("system"); expect(messages[1].role).toBe("user");
      return { content: output(input.sources[0].id), tool_calls: [] };
    } };
    const result = await prepareDream({ home: f.home, task: f.task, provider, providerName: "fake", model: "test" });
    expect(calls).toBe(1); expect(result.candidate).toBeDefined();
    expect(coreMemoryBlock(f.home, f.scope)).not.toContain("Test runner");
    const current = await buildDreamInput(f.home, f.task);
    new DreamStore(f.home, f.scope).apply(result.candidate!.id, current);
    expect(coreMemoryBlock(f.home, f.scope)).toContain("Test runner");
    expect(coreMemoryBlock(f.home, createTaskScope("other", f.root))).not.toContain("Test runner");
  } finally { f.cleanup(); }
});

test("display originals survive working history compaction and oversize evidence is reported, not clipped", async () => {
  const f = fixture();
  try {
    const display = new DisplayHistory(f.home, { sessionId: f.task.sessionId, taskId: f.task.taskId, root: f.task.root });
    display.append("user", "Use bun to run tests.");
    display.append("tool_result", "x".repeat(100_000));
    f.task.displayHistory = await display.flush();
    f.task.messages = [{ role: "user", content: "COMPACTED FALSE NOTE", _neko_internal: true }];
    const input = await buildDreamInput(f.home, f.task);
    expect(input.coverage.origin).toBe("display");
    expect(input.coverage.omitted).toBe(1);
    expect(input.sources.map(source => source.text)).toEqual(["Use bun to run tests."]);
    expect(JSON.stringify(input)).not.toContain("COMPACTED FALSE NOTE");
  } finally { f.cleanup(); }
});

test("secrets, unexpected tools, truncation, provider failure and cancellation never publish memory", async () => {
  const f = fixture();
  try {
    const input = await buildDreamInput(f.home, f.task);
    for (const response of [
      { content: output(input.sources[0].id), tool_calls: [{ id: "bad", name: "bash", arguments: { command: "bad" } }] },
      { content: output(input.sources[0].id), tool_calls: [], truncated: true },
      { content: "api_key = sk-this-is-a-fake-test-secret-123", tool_calls: [] },
    ]) {
      await expect(prepareDream({ home: f.home, task: f.task, provider: { complete: async () => response }, providerName: "fake", model: "test" })).rejects.toThrow();
    }
    const abort = new AbortController(); abort.abort();
    let called = false;
    await expect(prepareDream({ home: f.home, task: f.task, signal: abort.signal,
      provider: { complete: async () => { called = true; throw new Error("must not call"); } }, providerName: "fake", model: "test" })).rejects.toThrow();
    expect(called).toBe(false);
    f.task.messages.push({ role: "user", content: "password=not-a-real-secret-12345" });
    await expect(buildDreamInput(f.home, f.task)).rejects.toThrow(/secret/i);
    expect(coreMemoryBlock(f.home, f.scope)).toBe("");
  } finally { f.cleanup(); }
});

test("journal preserves original corrections through repeated compaction and includes the newest unarchived turn", async () => {
  const f = fixture();
  try {
    const { PagedSources } = await import("../src/adapters/context/paged-sources.ts");
    const { captureSourceGroup } = await import("../src/core/context/structured-sources.ts");
    const journal = new PagedSources(f.home, f.scope);
    journal.append(captureSourceGroup(f.scope, 1, [{ role: "user", content: "Originally we used npm." }]));
    journal.append(captureSourceGroup(f.scope, 2, [{ role: "user", content: "Correction: now use bun." }]));
    journal.append(captureSourceGroup(f.scope, 3, [{ role: "user", content: "FALSE COMPACTED CLAIM", _neko_internal: true }], [], "runtime"));
    f.task.contextState = { version: 1, journal: journal.reference(), capsule: null };
    f.task.messages = [{ role: "assistant", content: "FALSE COMPACTED CLAIM", _neko_internal: true },
      { role: "user", content: "Newest decision: use bun test." }];
    const input = await buildDreamInput(f.home, f.task);
    expect(input.coverage.origin).toBe("journal");
    expect(input.sources.map(source => source.text)).toEqual(["Originally we used npm.", "Correction: now use bun.", "Newest decision: use bun test."]);
    expect(JSON.stringify(input.sources)).not.toContain("FALSE COMPACTED CLAIM");
  } finally { f.cleanup(); }
});

test("in-flight cancellation, disabled memory and source changes never create an activatable candidate", async () => {
  const f = fixture();
  try {
    const input = await buildDreamInput(f.home, f.task);
    const { setMemoryEnabled } = await import("../src/core/memory.ts");
    const abort = new AbortController();
    await expect(prepareDream({ home: f.home, task: f.task, signal: abort.signal, providerName: "fake", model: "test",
      provider: { complete: async () => { abort.abort(); return { content: output(input.sources[0].id), tool_calls: [] }; } } })).rejects.toThrow();
    await expect(prepareDream({ home: f.home, task: f.task, providerName: "fake", model: "test",
      provider: { complete: async () => { setMemoryEnabled(false, f.home); return { content: output(input.sources[0].id), tool_calls: [] }; } } })).rejects.toThrow(/off/i);
    setMemoryEnabled(true, f.home);
    await expect(prepareDream({ home: f.home, task: f.task, providerName: "fake", model: "test",
      provider: { complete: async () => { f.task.messages.push({ role: "user", content: "Changed during dream" }); return { content: output(input.sources[0].id), tool_calls: [] }; } } })).rejects.toThrow(/source/i);
  } finally { f.cleanup(); }
});

test("display checkpoint reconciliation keeps later cross-client corrections and rejects legacy summaries", async () => {
  const f = fixture();
  try {
    const display = new DisplayHistory(f.home, { sessionId: f.task.sessionId, taskId: f.task.taskId, root: f.task.root });
    const prefix = [{ role: "user", content: "Use npm for this repository." }];
    display.append("user", "Use npm for this repository."); await display.flush();
    f.task.displayHistory = display.captureCheckpoint(prefix);
    f.task.messages = [...prefix, { role: "user", content: "Correction: use bun, not npm." },
      { role: "user", content: "[Summary of earlier conversation] FALSE FACT" }];
    const input = await buildDreamInput(f.home, f.task);
    expect(input.sources.map(source => source.text)).toEqual(["Use npm for this repository.", "Correction: use bun, not npm."]);
  } finally { f.cleanup(); }
});

test("memory tool results and unbound display tool observations cannot launder inference into observed claims", async () => {
  const f = fixture();
  try {
    f.task.messages = [{ role: "user", content: "Read the old note." }, { role: "assistant", content: null,
      tool_calls: [{ id: "m1", type: "function", function: { name: "memory", arguments: '{"action":"read","name":"old"}' } }] },
      { role: "tool", tool_call_id: "m1", content: "Unverified idea: release is safe." }];
    let input = await buildDreamInput(f.home, f.task);
    expect(input.sources.some(source => source.kind === "tool")).toBe(false);
    const display = new DisplayHistory(f.home, { sessionId: f.task.sessionId, taskId: f.task.taskId, root: f.task.root });
    display.append("tool_result", "Unverified idea: release is safe.");
    f.task.displayHistory = await display.flush(); f.task.messages = [];
    input = await buildDreamInput(f.home, f.task);
    expect(input.sources.some(source => source.kind === "tool")).toBe(false);
  } finally { f.cleanup(); }
});

test("small model context fails before any provider request", async () => {
  const f = fixture();
  try {
    let calls = 0;
    await expect(prepareDream({ home: f.home, task: f.task, providerName: "fake", model: "test", maxInputTokens: 50,
      provider: { complete: async () => { calls++; return { content: "", tool_calls: [] }; } } })).rejects.toThrow(/context budget/i);
    expect(calls).toBe(0);
  } finally { f.cleanup(); }
});

test("successive dreams retain original cited evidence even after it leaves the current history window", async () => {
  const f = fixture();
  try {
    const initial = await buildDreamInput(f.home, f.task);
    const prepared = await prepareDream({ home: f.home, task: f.task, providerName: "fake", model: "test",
      provider: { complete: async () => ({ content: output(initial.sources[0].id), tool_calls: [] }) } });
    new DreamStore(f.home, f.scope).apply(prepared.candidate!.id, initial);
    f.task.messages = [{ role: "user", content: "A later unrelated question has replaced the compacted working tail." }];
    const next = await buildDreamInput(f.home, f.task);
    expect(next.sources.map(source => source.text)).toContain("Use bun to run tests.");
    expect(next.coverage.retained).toBe(1);
    expect(next.sources[0].id).toBe(initial.sources[0].id);
  } finally { f.cleanup(); }
});

test("cancellation returns even if an injected provider ignores its signal", async () => {
  const f = fixture();
  try {
    const abort = new AbortController();
    const result = prepareDream({ home: f.home, task: f.task, providerName: "fake", model: "test", signal: abort.signal,
      provider: { complete: () => new Promise(() => {}) } });
    setTimeout(() => abort.abort(new Error("test cancellation")), 5);
    await expect(Promise.race([result, new Promise((_, reject) => setTimeout(() => reject(new Error("did not cancel")), 500))])).rejects.toThrow("test cancellation");
  } finally { f.cleanup(); }
});

test("second pass explicitly supplies allowed memory filenames to the model", async () => {
  const f = fixture();
  try {
    const initial = await buildDreamInput(f.home, f.task);
    const first = await prepareDream({ home: f.home, task: f.task, providerName: "fake", model: "test",
      provider: { complete: async () => ({ content: output(initial.sources[0].id), tool_calls: [] }) } });
    new DreamStore(f.home, f.scope).apply(first.candidate!.id, initial);
    const second = await prepareDream({ home: f.home, task: f.task, providerName: "fake", model: "test",
      provider: { complete: async (messages) => {
        expect(messages[0].content).toContain('Allowed memory filenames for corrects and related: ["dream.md"]');
        expect(messages[0].content).toContain('not claim titles');
        const p = JSON.parse(output(initial.sources[0].id)); p.claims[0].related = ["dream.md"];
        return { content: JSON.stringify(p), tool_calls: [] };
      } } });
    expect(second.candidate!.proposal.claims[0].related).toEqual(["dream.md"]);
  } finally { f.cleanup(); }
});
