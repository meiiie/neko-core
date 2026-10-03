import {expect, test} from "bun:test";
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {createTaskSession, loadTaskSession, type TaskRuntimeInput} from "../src/adapters/task-session.ts";
import {PagedSources} from "../src/adapters/context/paged-sources.ts";
import {captureSourceGroup} from "../src/core/context/structured-sources.ts";
import {structuredCapsuleDigest, structuredScopeDigest, type StructuredContextState} from "../src/core/context/state.ts";
import type {JsonObject} from "../src/shared/wire.ts";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "neko-structured-task-"));
  const home = join(base, "home"), root = join(base, "project");
  mkdirSync(home); mkdirSync(root);
  let activations = 0;
  const runtimeFactory = (input: TaskRuntimeInput) => {
    activations++;
    // SAFETY: this fixture supplies the exact versioned empty context shape with a runtime-owned scope.
    const runtime = {messages: input.messages, state: input.contextState ?? {version: 1, journal: {version: 1,
      scope: structuredScopeDigest(input.taskId, input.scope.canonicalRoot), head: null}, capsule: null} as StructuredContextState,
      getMessages: () => runtime.messages, getSourceEvents: () => [], getStructuredContextState: () => runtime.state,
      assertQuiescent() {}, close() {}};
    return runtime;
  };
  return {home, root, runtimeFactory, activations: () => activations, authorityId: "local", configId: "a".repeat(64), contextMode: "structured" as const};
}
const digest = (messages: unknown[]) => createHash("sha256").update(JSON.stringify(messages)).digest("hex");

async function candidate(f: ReturnType<typeof fixture>) {
  const session = await createTaskSession({...f, label: "structured"});
  const original: JsonObject[] = [{role: "user", content: "original instruction"}, {role: "assistant", content: "original observation"}];
  session.active.runtime.messages = original;
  session.checkpoint();
  const journal = new PagedSources(f.home, session.active.scope);
  const source = captureSourceGroup(session.active.scope, 1, original);
  journal.append(source);
  const note: JsonObject = {role: "assistant", content: "Unverified derived note: original instruction", _neko_internal: true,
    _neko_context_capsule: true, _neko_context_sources: [source.id]};
  const messages = [note, {role: "user", content: "next turn"}];
  const state: StructuredContextState = {version: 1, journal: journal.reference(), capsule: {messageDigest: structuredCapsuleDigest(note), sources: [source.id]}};
  return {session, original, messages, state};
}

test("schema 3 publishes messages and context provenance together before active installation and requires matching resume opt-in", async () => {
  const f = fixture(); const {session, original, messages, state} = await candidate(f);
  const path = join(f.home, ".neko-core", "task-sessions", `${session.id}.json`);
  expect(session.checkpointCompaction(digest(original), messages, state)).toEqual({committed: true});
  expect(session.active.runtime.messages).toBe(original);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.schemaVersion).toBe(3);
  expect(saved.tasks[0].messages).toEqual(messages);
  expect(saved.tasks[0].contextState).toEqual(state);
  session.active.runtime.messages = messages; session.active.runtime.state = state;
  await session.close();
  await expect(loadTaskSession({...f, contextMode: undefined, sessionId: session.id})).rejects.toThrow("format opt-in changed");
  const restored = await loadTaskSession({...f, sessionId: session.id});
  expect(restored.active.runtime.messages).toEqual(messages);
  expect(restored.active.runtime.state).toEqual(state);
  await restored.close();
});

test("a foreign context scope or changed working snapshot cannot replace the saved parent", async () => {
  const f = fixture(); const {session, original, messages, state} = await candidate(f);
  const path = join(f.home, ".neko-core", "task-sessions", `${session.id}.json`), before = readFileSync(path, "utf8");
  try {
    expect(() => session.checkpointCompaction("f".repeat(64), messages, state)).toThrow("Working context changed");
    expect(() => session.checkpointCompaction(digest(original), messages, {...state, journal: {...state.journal, scope: "f".repeat(64)}})).toThrow("foreign");
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally { await session.close(); }
});

test("resume validates the immutable source journal before constructing an executable runtime", async () => {
  const f = fixture(); const {session, original, messages, state} = await candidate(f);
  session.checkpointCompaction(digest(original), messages, state);
  session.active.runtime.messages = messages; session.active.runtime.state = state;
  await session.close();
  writeFileSync(join(f.home, ".neko-core", "context-source-journal", state.journal.scope, `${state.journal.head}.json`), "{}");
  const before = f.activations();
  await expect(loadTaskSession({...f, sessionId: session.id})).rejects.toThrow("integrity mismatch");
  expect(f.activations()).toBe(before);
});

test("a publication revision conflict halts the coordinator and close cannot overwrite the saved parent", async () => {
  const f = fixture(); const {session, original, messages, state} = await candidate(f);
  const path = join(f.home, ".neko-core", "task-sessions", `${session.id}.json`);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  saved.revision++;
  const external = JSON.stringify(saved); writeFileSync(path, external);
  expect(() => session.checkpointCompaction(digest(original), messages, state)).toThrow("revision conflict");
  expect(session.recoveryRequired).toBe(true);
  expect(() => session.checkpoint()).toThrow("recovery");
  expect(() => session.createTask("must not run")).toThrow("recovery");
  await session.close();
  expect(readFileSync(path, "utf8")).toBe(external);
  const reopened = await loadTaskSession({...f, sessionId: session.id});
  expect(reopened.active.runtime.messages).toEqual(original);
  await reopened.close();
});
