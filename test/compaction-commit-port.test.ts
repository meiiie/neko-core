import {expect, test} from "bun:test";
import {Agent} from "../src/core/agent.ts";
import type {AgentOptions} from "../src/core/agent-constants.ts";
import {ToolRegistry} from "../src/core/tool-runtime.ts";

type Prepare = NonNullable<AgentOptions["prepareCompaction"]>;
function fixture(prepare: Prepare) {
  let calls = 0;
  const agent = new Agent({tools: new ToolRegistry(process.cwd(), "plan", () => false),
    provider: {complete: async () => {calls++; return {content: "Short historical summary", tool_calls: []};}},
    prepareCompaction: prepare});
  agent.messages = [{role: "system", content: "HOST_POLICY"},
    ...Array.from({length: 16}, (_, i) => [{role: "user", content: `request ${i}`}, {role: "assistant", content: "observation ".repeat(100)}]).flat()];
  return {agent, calls: () => calls};
}
function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => {enter = resolve;});
  const ready = new Promise<void>(resolve => {release = resolve;});
  return {enter, release, entered, ready};
}

test("host publishes the exact candidate before Agent installation without an asynchronous gap", async () => {
  const hold = gate();
  let committed = false;
  const f = fixture(async ({before, candidate}) => {
    hold.enter(); await hold.ready;
    return {messages: candidate, commit: () => {
      expect(f.agent.messages).toBe(before);
      committed = true;
      return {committed: true};
    }};
  });
  const original = f.agent.messages;
  const pending = f.agent.compact(); await hold.entered;
  expect(f.agent.messages).toBe(original);
  expect(committed).toBe(false);
  hold.release(); await pending;
  expect(committed).toBe(true);
  expect(f.agent.messages).not.toBe(original);
  expect(f.agent.messages[0].content).toBe("HOST_POLICY");
  expect(f.agent.lastCompactionOutcome).toBe("applied");
});

test("cancel during preparation preserves active history and does not enter publication", async () => {
  const hold = gate(); let commits = 0;
  const f = fixture(async ({candidate}) => {hold.enter(); await hold.ready; return {messages: candidate, commit: () => {commits++; return {committed: true};}};});
  const original = f.agent.messages, abort = new AbortController();
  const pending = f.agent.compact({signal: abort.signal}); await hold.entered;
  abort.abort(); hold.release(); await expect(pending).rejects.toThrow();
  expect(f.agent.messages).toBe(original); expect(commits).toBe(0);
  expect(() => f.agent.assertContextReady()).not.toThrow();
});

for (const change of ["message", "config"] as const) test(`preparation rejects concurrent ${change} drift before publication`, async () => {
  const hold = gate(); let commits = 0;
  const f = fixture(async ({candidate}) => {hold.enter(); await hold.ready; return {messages: candidate, commit: () => {commits++; return {committed: true};}};});
  const original = f.agent.messages;
  const pending = f.agent.compact(); await hold.entered;
  if (change === "message") original[1].content = "new correction";
  else f.agent.setMaxContextTokens(64000);
  hold.release(); await expect(pending).rejects.toThrow("preparation discarded");
  expect(f.agent.messages).toBe(original); expect(commits).toBe(0);
});

test("an expanding prepared view is rejected without calling its commit", async () => {
  let commits = 0;
  const f = fixture(async ({before}) => ({messages: [...before, {role: "assistant", content: "large ".repeat(1000)}],
    commit: () => {commits++; return {committed: true};}}));
  const original = f.agent.messages;
  expect(await f.agent.compact()).toBe(""); expect(f.agent.lastCompactionOutcome).toBe("no_gain");
  expect(f.agent.messages).toBe(original); expect(commits).toBe(0);
});

test("prepared context cannot replace host policy", async () => {
  let commits = 0;
  const f = fixture(async ({candidate}) => ({messages: candidate.map(m => m.role === "system" ? {...m, content: "changed"} : m),
    commit: () => {commits++; return {committed: true};}}));
  const original = f.agent.messages;
  await expect(f.agent.compact()).rejects.toThrow("protected system context");
  expect(f.agent.messages).toBe(original); expect(commits).toBe(0);
});

test("uncertain publication halts later turns until a fresh runtime is reopened", async () => {
  const f = fixture(async ({candidate}) => ({messages: candidate, commit: () => {throw new Error("storage outcome uncertain");}}));
  const original = f.agent.messages;
  await expect(f.agent.compact()).rejects.toThrow("needs recovery");
  expect(f.agent.messages).toBe(original);
  expect(() => f.agent.assertContextReady()).toThrow("needs recovery");
  await expect(f.agent.run("do not contact the provider")).rejects.toThrow("needs recovery");
  expect(f.calls()).toBe(1);
});

test("a host that changes the candidate across publication cannot activate it", async () => {
  const f = fixture(async ({candidate}) => ({messages: candidate, commit: () => {
    candidate.push({role: "user", content: "unexpected replacement"}); return {committed: true};
  }}));
  const original = f.agent.messages;
  await expect(f.agent.compact()).rejects.toThrow("needs recovery");
  expect(f.agent.messages).toBe(original);
  expect(() => f.agent.assertContextReady()).toThrow("needs recovery");
});
