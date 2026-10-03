import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDisplayHistory } from "../src/ui/display-history.ts";

test("returning from a client without display hooks does not hide its saved reply", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-display-coverage-"));
  const scope = { sessionId: "mixedclients", root: process.cwd() };
  const messages = [{ role: "user", content: "FIRST_PROMPT" }, { role: "assistant", content: "FIRST_REPLY" }];
  const first = await createDisplayHistory(home, scope, messages);
  const reference = await first.flush();
  messages.push({ role: "user", content: "SECOND_PROMPT" }, { role: "assistant", content: "HEADLESS_REPLY" });
  const resumed = await createDisplayHistory(home, scope, messages, reference);
  const page = await resumed.page();
  expect(page.entries.some(entry => entry.text === "HEADLESS_REPLY")).toBe(true);
});

test("an unchanged checkpoint reopens without duplicating the archive", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-display-same-"));
  const scope = {sessionId: "unchanged", root: process.cwd()};
  const messages = [{role: "user", content: "same"}, {role: "assistant", content: "same"}];
  const first = await createDisplayHistory(home, scope, messages);
  let ref = first.reference();
  for (let i = 0; i < 4; i++) {
    const next = await createDisplayHistory(home, scope, messages, ref);
    expect((await next.page()).entries.map(entry => entry.text)).toEqual(["same", "same"]);
    expect(next.reference().head).toBe(ref.head);
    ref = next.reference();
  }
});

test("matching prefixes append repeated new text exactly once rather than deduplicating by content", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-display-repeat-"));
  const scope = {sessionId: "repeat", root: process.cwd()};
  const messages = [{role: "user", content: "again"}, {role: "assistant", content: "answer"}];
  const first = await createDisplayHistory(home, scope, messages);
  const updated = [...messages, ...structuredClone(messages)];
  const next = await createDisplayHistory(home, scope, updated, first.reference());
  expect((await next.page()).entries.map(entry => entry.text)).toEqual(["again", "answer", "again", "answer"]);
  const reopened = await createDisplayHistory(home, scope, updated, next.reference());
  expect((await reopened.page()).entries).toHaveLength(4);
});

test("a rewritten or compacted checkpoint keeps old evidence and labels its new snapshot", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-display-rewrite-"));
  const scope = {sessionId: "rewrite", root: process.cwd()};
  const first = await createDisplayHistory(home, scope, [{role: "user", content: "PRECOMPACT_ORIGINAL"}]);
  const compacted = [{role: "assistant", content: "CHECKPOINT_SUMMARY", reasoning_content: "OPAQUE_MUST_NOT_RENDER", provider_data: [{secret: "OPAQUE_MUST_NOT_RENDER"}]}];
  const next = await createDisplayHistory(home, scope, compacted, first.reference());
  const entries = (await next.page()).entries;
  expect(entries[0].text).toBe("PRECOMPACT_ORIGINAL");
  expect(entries[1].kind).toBe("info");
  expect(entries[1].text).toContain("may overlap");
  expect(entries[2].text).toBe("CHECKPOINT_SUMMARY");
  expect(JSON.stringify(entries)).not.toContain("OPAQUE_MUST_NOT_RENDER");
  expect((await (await createDisplayHistory(home, scope, compacted, next.reference())).page()).entries).toHaveLength(3);
});

test("an interrupted display checkpoint cannot claim complete canonical coverage", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-display-inflight-"));
  const scope = {sessionId: "interrupted", root: process.cwd()};
  const messages = [{role: "user", content: "PROMPT"}];
  const first = await createDisplayHistory(home, scope, messages);
  const checkpoint = [...messages, {role: "assistant", content: "RETURNED_BUT_NOT_PAINTED"}];
  const reference = first.captureCheckpoint(checkpoint, false);
  expect(reference.checkpoint).toBeUndefined();
  const next = await createDisplayHistory(home, scope, checkpoint, reference);
  expect((await next.page()).entries.some(entry => entry.text === "RETURNED_BUT_NOT_PAINTED")).toBe(true);
});

test("task coordinator preserves coverage across display and headless clients", async () => {
  const {createTaskSession, loadTaskSession} = await import("../src/adapters/task-session.ts");
  const home = mkdtempSync(join(tmpdir(), "neko-display-task-clients-"));
  const common = {home, root: process.cwd(), authorityId: "local", configId: "a".repeat(64)};
  const displayFactory = async (input: import("../src/adapters/task-session.ts").TaskRuntimeInput) => {
    const display = await createDisplayHistory(home, {sessionId: input.sessionId, taskId: input.taskId, root: input.root}, input.messages, input.displayHistory, input.displayPending);
    return {
      display, messages: input.messages,
      getMessages: () => input.messages, getSourceEvents: () => input.sourceEvents,
      getDisplayHistory: () => display.captureCheckpoint(input.messages),
      assertQuiescent: async () => { await display.flush(); }, close() {},
    };
  };
  const first = await createTaskSession({...common, label: "A", runtimeFactory: displayFactory});
  const id = first.id;
  first.active.runtime.messages.push({role: "user", content: "ARCHIVED_A"});
  first.active.runtime.display.append("user", "ARCHIVED_A");
  await first.close();
  const headless = await loadTaskSession({...common, sessionId: id, runtimeFactory: (input) => ({
    messages: input.messages, getMessages: () => input.messages, getSourceEvents: () => input.sourceEvents,
    assertQuiescent() {}, close() {},
  })});
  headless.active.runtime.messages.push({role: "assistant", content: "HEADLESS_TASK_REPLY"});
  await headless.close();
  const restored = await loadTaskSession({...common, sessionId: id, runtimeFactory: displayFactory});
  try {
    const entries = (await restored.active.runtime.display.page()).entries;
    expect(entries.map(entry => entry.text)).toEqual(["ARCHIVED_A", "HEADLESS_TASK_REPLY"]);
  } finally { await restored.close(); }
});
