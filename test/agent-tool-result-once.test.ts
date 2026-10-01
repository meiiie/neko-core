import { expect, test } from "bun:test";

import { Agent, classifyToolObservation } from "../src/core/agent.ts";

type ToolArgs = { path?: string; old_string?: string; new_string?: string };
type ToolCall = { id: string; name: string; arguments: ToolArgs };

function call(id: string, name: string, args: ToolArgs = {}): ToolCall {
  return { id, name, arguments: args };
}

function resultRows(history: any[], id: string): any[] {
  return history.filter((message) => message.role === "tool" && message.tool_call_id === id);
}

function strictProvider(calls: ToolCall[], histories: any[][]) {
  let next = 0;
  return {
    async complete(messages: any[]) {
      histories.push(structuredClone(messages));
      if (next < calls.length) {
        const current = calls[next++];
        return { content: null, tool_calls: [current] };
      }
      for (const current of calls) {
        const count = resultRows(messages, current.id).length;
        if (count !== 1) throw new Error(`invalid tool trajectory: ${current.id} has ${count} results`);
      }
      return { content: "done", tool_calls: [] };
    },
  };
}

function makeAgent(provider: any, execute: (name: string, args: any, signal?: AbortSignal) => Promise<string>) {
  return new Agent({
    provider,
    // SAFETY: deterministic no-model fixture implements only the two ToolRegistry methods Agent uses.
    tools: { schemas: () => [], execute, todos: [] } as any,
    maxSteps: 12,
    verifyBeforeExit: false,
    verifyStateChangesBeforeExit: false,
  });
}

test("a denied edit has one canonical tool result in history and the next provider request", async () => {
  const histories: any[][] = [];
  let executions = 0;
  const agent = makeAgent(strictProvider([call("deny-1", "edit", { path: "sample.txt" })], histories),
    async () => { executions++; return "Denied by user: edit (edit sample.txt)"; });

  expect(await agent.run("Try the edit once.")).toBe("done");
  expect(executions).toBe(1);
  expect(histories).toHaveLength(2);
  expect(resultRows(histories[1], "deny-1")).toHaveLength(1);
  expect(resultRows(agent.messages, "deny-1")).toHaveLength(1);
  expect(String(resultRows(agent.messages, "deny-1")[0].content)).toContain("Denied by user");
  expect(String(resultRows(agent.messages, "deny-1")[0].content)).not.toContain("[recovery]");
});

test("an actual edit failure keeps recovery guidance inside its one result", async () => {
  const histories: any[][] = [];
  const agent = makeAgent(strictProvider([call("error-1", "edit", { path: "sample.txt" })], histories),
    async () => "Error running edit: synthetic disk error");

  expect(await agent.run("Try the edit once.")).toBe("done");
  expect(resultRows(histories[1], "error-1")).toHaveLength(1);
  const results = resultRows(agent.messages, "error-1");
  expect(results).toHaveLength(1);
  expect(String(results[0].content)).toContain("synthetic disk error");
  expect(String(results[0].content)).not.toContain("[recovery]");
  const providerResults = resultRows(agent.providerHistory(), "error-1");
  expect(providerResults).toHaveLength(1);
  expect(String(providerResults[0].content)).toContain("[recovery]");
  expect(String(providerResults[0].content)).toContain("DIAGNOSE");
  expect(providerResults[0]._neko_tool_guidance).toBeUndefined();
  expect(String(resultRows(histories[1], "error-1")[0].content)).toContain("[recovery]");
});

test("broad and unproductive loop nudges do not add tool results", async () => {
  const edits = Array.from({ length: 6 }, (_, index) =>
    call(`edit-${index}`, "edit", { path: "sample.txt", old_string: `a${index}`, new_string: `b${index}` }));
  const editHistories: any[][] = [];
  const editAgent = makeAgent(strictProvider(edits, editHistories), async () => "ok");
  expect(await editAgent.run("Edit the same file repeatedly.")).toBe("done");
  expect(editAgent.messages.filter((message) => message.role === "tool")).toHaveLength(6);
  expect(classifyToolObservation(resultRows(editAgent.messages, "edit-5")[0].content)).toBe("productive");
  expect(String(resultRows(editAgent.providerHistory(), "edit-5")[0].content)).toContain("[loop guard]");
  expect(String(resultRows(editHistories.at(-1)!, "edit-5")[0].content)).toContain("[loop guard]");

  const reads = Array.from({ length: 3 }, (_, index) =>
    call(`read-${index}`, "read_file", { path: `missing-${index}.txt` }));
  const readHistories: any[][] = [];
  const readAgent = makeAgent(strictProvider(reads, readHistories), async () => "[]");
  expect(await readAgent.run("Read three missing files.")).toBe("done");
  expect(readAgent.messages.filter((message) => message.role === "tool")).toHaveLength(3);
  expect(classifyToolObservation(resultRows(readAgent.messages, "read-2")[0].content)).toBe("empty");
  expect(String(resultRows(readAgent.providerHistory(), "read-2")[0].content)).toContain("[loop guard]");
  expect(String(resultRows(readHistories.at(-1)!, "read-2")[0].content)).toContain("[loop guard]");
});

test("cancellation after denial preserves one result and sealing adds no duplicate", async () => {
  const controller = new AbortController();
  const histories: any[][] = [];
  const agent = makeAgent(strictProvider([call("cancel-1", "edit", { path: "sample.txt" })], histories),
    async () => {
      controller.abort();
      return "Denied by user: edit (edit sample.txt)";
    });

  expect(await agent.run("Attempt and cancel.", controller.signal)).toBe("[interrupted]");
  agent.sealDanglingToolCalls();
  expect(resultRows(agent.messages, "cancel-1")).toHaveLength(1);
  expect(String(resultRows(agent.messages, "cancel-1")[0].content)).toContain("Denied by user");
});

test("repeated denied edits do not claim that the file was edited", async () => {
  const edits = Array.from({ length: 6 }, (_, index) =>
    call(`denied-${index}`, "edit", { path: "sample.txt", old_string: `a${index}`, new_string: `b${index}` }));
  const histories: any[][] = [];
  const agent = makeAgent(strictProvider(edits, histories), async () => "Denied by user: edit (edit sample.txt)");

  expect(await agent.run("Try distinct edits.")).toBe("done");
  expect(agent.messages.filter((message) => message.role === "tool")).toHaveLength(6);
  expect(agent.providerHistory().some((message) => String(message.content).includes("You've edited"))).toBe(false);
});

test("compaction carries recovery guidance without duplicating the tool result", async () => {
  let providerCalls = 0;
  let summaryInput = "";
  const provider = {
    async complete(messages: any[]) {
      providerCalls++;
      if (providerCalls === 1) return { content: null, tool_calls: [call("compact-1", "edit", { path: "sample.txt" })] };
      if (providerCalls === 2) return { content: "done", tool_calls: [] };
      summaryInput = String(messages[1]?.content ?? "");
      return { content: "summary", tool_calls: [] };
    },
  };
  const agent = makeAgent(provider, async () => "Error running edit: synthetic disk error");
  expect(await agent.run("Attempt the edit.")).toBe("done");
  for (let index = 0; index < 6; index++) {
    agent.messages.push({ role: "user", content: `later ${index}` });
    agent.messages.push({ role: "assistant", content: `reply ${index}` });
  }
  expect(await agent.compact()).toBe("summary");
  expect(summaryInput).toContain("synthetic disk error");
  expect(summaryInput).toContain("[recovery]");
  expect(summaryInput.match(/tool_call_id: "compact-1"/g)).toHaveLength(1);
});
