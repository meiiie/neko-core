import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDomainRuntime, DomainRequestLimit, DomainUncertainMutation, textToolEnvelope } from "../src/adapters/domain-runtime.ts";
import { nativeDomainHistory } from "../src/adapters/domain-history.ts";
import { toAnthropicMessages } from "../src/adapters/anthropic.ts";
import type { Provider, ProviderResponse } from "../src/core/ports.ts";
import type { JsonObject } from "../src/shared/wire.ts";

const read = "mcp__lifemate__contacts.search";
const write = "mcp__lifemate__phone.call";
const ask = "mcp__lifemate__sys.ask_missing_info";
const effects = { [read]: "read", [write]: "write", [ask]: "ask" } as const;
const final = (content: string): ProviderResponse => ({ content, tool_calls: [] });
const call = (name: string, args: JsonObject = {}): ProviderResponse => ({
  content: null, tool_calls: [{ id: "current_call", name, arguments: args }], reasoning: "provider-owned continuation",
  continuation: [{ type: "test_provider_metadata", message: { reasoning_content: "provider-owned continuation" } }],
});

function fixture(script: ProviderResponse[], overrides: Partial<Parameters<typeof createDomainRuntime>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "neko-domain-"));
  const executions: { name: string; args: unknown }[] = [];
  const messages: Parameters<Provider["complete"]>[0][] = [];
  const provider: Provider = {
    async complete(input) {
      messages.push(structuredClone(input));
      const response = script[messages.length - 1];
      if (!response) throw new Error("Unexpected provider request");
      return structuredClone(response);
    },
  };
  const runtime = createDomainRuntime({
    root, provider, systemPrompt: "Isolated tool simulation.", effects,
    tools: {
      has: (name) => name in effects,
      permission: (name) => name === read ? "safe" : "gated",
      toolSchemas: () => Object.keys(effects).map((name) => ({
        type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } },
      })),
      async call(name, args) { executions.push({ name, args }); return '{"ok":true}'; },
    },
    classifyReceipt: (_name, observation) => JSON.parse(observation).ok === true ? "succeeded" : "failed",
    approval: () => true, maxRequests: 6, ...overrides,
  });
  return { runtime, executions, messages, async close() { await runtime.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("preloaded text and native history retain the host policy on every provider request", async () => {
  for (const history of [
    [{ role: "user", content: "Earlier request" }, { role: "assistant", content: "Earlier result" }],
    nativeDomainHistory([
      { role: "user", text: "Earlier request" },
      { role: "assistant", text: "Earlier result", tool_calls: [{ name: "contacts.search", arguments: {} }], tool_results: [{ ok: true }] },
    ], "lifemate"),
  ]) {
    const f = fixture([call(read), final("Done")]);
    try {
      f.runtime.agent.messages.push(...structuredClone(history));
      await f.runtime.run("Current request");
      expect(f.messages).toHaveLength(2);
      for (const messages of f.messages) {
        expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
        expect(toAnthropicMessages(messages).system.trim()).toBe("Isolated tool simulation.");
        expect(toAnthropicMessages(messages).msgs[0].role).toBe("user");
      }
    } finally { await f.close(); }
  }
});

test("no-op finishes without forcing a verification read or exposing host tools", async () => {
  const f = fixture([final("Giữ nguyên, không thay đổi.")]);
  try {
    const result = await f.runtime.run("Thôi, giữ nguyên.");
    expect(result.requests).toBe(1);
    expect(result.receipts).toEqual([]);
    expect(result.semanticSuccess).toBeNull();
    expect(f.runtime.registry.schemas().map((s) => s.function.name)).toEqual(Object.keys(effects));
    expect(await f.runtime.registry.execute("bash", { command: "echo should-not-run" })).toContain("not available");
  } finally { await f.close(); }
});

test("working note carries across tool turns without changing calls, reasoning or ask-stop semantics", async () => {
  const response = call(read, { query: "Minh" });
  response.content = "<task_note>Need to identify Minh; no contact selected yet.</task_note>";
  const f = fixture([response, call(ask, { tool_name: "phone.call", params: ["contact_id"] })], { workingNote: true });
  try {
    const result = await f.runtime.run("Gọi Minh.");
    expect(f.messages).toHaveLength(2);
    expect(f.messages[1][0].content).toContain("Need to identify Minh");
    expect(f.messages[1][0].content).toContain('"outcome":"succeeded"');
    expect(f.messages[1].find((m) => m.tool_calls?.length)?.provider_data).toEqual(response.continuation);
    expect(f.executions).toEqual([{ name: read, args: { query: "Minh" } },
      { name: ask, args: { tool_name: "phone.call", params: ["contact_id"] } }]);
    expect(result.workingMemory?.originalRequest).toBe("Gọi Minh.");
    expect(result.protocolStatus).toBe("waiting_for_user");
    expect(result.semanticSuccess).toBeNull();
  } finally { await f.close(); }
});

test("a transaction receipt does not force an extra read and records a write, not evidence", async () => {
  const f = fixture([call(write, { contact_id: "person_1" }), final("Đã gọi.")]);
  try {
    const result = await f.runtime.run("Gọi người đã xác định.");
    expect(f.executions).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({ effect: "write", outcome: "succeeded" });
    expect(result.semanticSuccess).toBeNull();
    expect(f.messages[1].find((m) => m.tool_calls?.length)?.provider_data).toEqual(call(write).continuation);
  } finally { await f.close(); }
});

test("text-only call gets one native repair; its fabricated result is never executed or trusted", async () => {
  const f = fixture([
    final(JSON.stringify({ tool_calls: [{ name: "sys.ask_missing_info", arguments: { fields: ["amount"] } }], tool_results: [{ ok: true }] })),
    call(ask, { tool_name: "banking.transfer", fields: ["amount"] }), final("Bạn muốn chuyển bao nhiêu?"),
  ]);
  try {
    const result = await f.runtime.run("Chuyển tiền, chưa chọn số tiền.");
    expect(result.repairs).toBe(1);
    expect(f.executions).toEqual([{ name: ask, args: { tool_name: "banking.transfer", fields: ["amount"] } }]);
    expect(result.receipts[0].effect).toBe("ask");
    expect(result.protocolStatus).toBe("waiting_for_user");
    expect(f.messages[1].filter((m) => m.role === "tool")).toEqual([]);
  } finally { await f.close(); }
});

test("persistent malformed calls stop after one repair without converting JSON to actions", async () => {
  const prose = final('{"name":"phone.call","arguments":{"contact_id":"person_1"}}');
  const f = fixture([prose, prose]);
  try {
    const result = await f.runtime.run("Gọi điện.");
    expect(result.requests).toBe(2);
    expect(result.protocolStatus).toBe("unresolved_tool_text");
    expect(result.receipts).toEqual([]);
  } finally { await f.close(); }
});

test("successful ask terminates execution, including later writes in the same native batch", async () => {
  const response = call(ask);
  response.tool_calls.push({ id: "late_write", name: write, arguments: {} });
  const f = fixture([response]);
  try {
    const result = await f.runtime.run("Còn thiếu người nhận.");
    expect(f.executions.map((x) => x.name)).toEqual([ask]);
    expect(result.requests).toBe(1);
    expect(result.protocolStatus).toBe("waiting_for_user");
  } finally { await f.close(); }
});

test("a failed ask is not a waiting state and does not prevent correction", async () => {
  let count = 0;
  const f = fixture([call(ask), call(ask)], { classifyReceipt: () => ++count === 1 ? "failed" : "succeeded" });
  try {
    const result = await f.runtime.run("Hỏi trường thiếu.");
    expect(result.receipts.map((r) => r.outcome)).toEqual(["failed", "succeeded"]);
    expect(result.protocolStatus).toBe("waiting_for_user");
  } finally { await f.close(); }
});

test("a known no-op remains distinct from success and allows a corrected action", async () => {
  let count = 0;
  const f = fixture([call(write), call(write), final("Done")], {
    workingNote: true,
    classifyReceipt: () => ++count === 1 ? "noop" : "succeeded",
  });
  try {
    const result = await f.runtime.run("Finish the requested action.");
    expect(result.receipts.map((r) => r.outcome)).toEqual(["noop", "succeeded"]);
    expect(f.messages[1][0].content).toContain('"outcome":"noop"');
    expect(f.executions).toHaveLength(2);
    expect(result.protocolStatus).toBe("finished");
    expect(result.semanticSuccess).toBeNull();
  } finally { await f.close(); }
});

test("unknown mutation outcome is preserved and stops automatic repeat writes", async () => {
  const response = call(write);
  response.tool_calls.push({ id: "duplicate_write", name: write, arguments: {} });
  const f = fixture([response], { classifyReceipt: () => "unknown" });
  try {
    await expect(f.runtime.run("Gọi.")).rejects.toBeInstanceOf(DomainUncertainMutation);
    expect(f.executions).toHaveLength(1);
    expect(f.runtime.receipts).toHaveLength(1);
    expect(f.runtime.receipts[0].outcome).toBe("unknown");
  } finally { await f.close(); }
});

test("receipt classifier failure retains the actual observation for reconciliation", async () => {
  const f = fixture([call(write)], { classifyReceipt: () => { throw new Error("Unsupported receipt version"); } });
  try {
    await expect(f.runtime.run("Gọi.")).rejects.toBeInstanceOf(DomainUncertainMutation);
    expect(f.runtime.receipts[0]).toMatchObject({ observation: '{"ok":true}', outcome: "unknown" });
  } finally { await f.close(); }
});

test("ordinary clarification prose is not misreported as a successful ask tool", async () => {
  const f = fixture([final("Bạn chọn số tiền bao nhiêu?")]);
  try {
    const result = await f.runtime.run("Chuyển tiền.");
    expect(result.receipts.filter((r) => r.effect === "ask")).toHaveLength(0);
    expect(result.semanticSuccess).toBeNull();
    expect(result.repairs).toBe(0);
  } finally { await f.close(); }
});

test("native repair flag off preserves explicit malformed output for ablation", async () => {
  const f = fixture([final('{"name":"phone.call","arguments":{}}')], { repairTextTools: false });
  try { expect((await f.runtime.run("Gọi.")).protocolStatus).toBe("unresolved_tool_text"); }
  finally { await f.close(); }
});

test("approval and plan mode still deny writes; metadata does not grant authority", async () => {
  const f = fixture([call(write), final("Không được thực hiện.")], { mode: "plan" });
  try {
    const result = await f.runtime.run("Gọi.");
    expect(f.executions).toEqual([]);
    expect(result.receipts).toEqual([]);
    expect(f.messages[1].find((m) => m.role === "tool")?.content).toContain("Blocked");
  } finally { await f.close(); }
});

test("a runtime cannot be reused for another independent sample", async () => {
  const f = fixture([final("Không đổi.")]);
  try {
    await f.runtime.run("Giữ nguyên.");
    await expect(f.runtime.run("Bài khác.")).rejects.toThrow("fresh domain runtime");
  } finally { await f.close(); }
});

test("repair shares the original request budget rather than resetting it", async () => {
  const f = fixture([final('{"name":"phone.call","arguments":{}}'), call(write)], { maxRequests: 2 });
  try {
    await expect(f.runtime.run("Gọi.")).rejects.toBeInstanceOf(DomainRequestLimit);
    expect(f.messages).toHaveLength(2);
    expect(f.executions).toHaveLength(1);
  } finally { await f.close(); }
});

test("abort prevents provider and tool execution", async () => {
  const f = fixture([call(write)]);
  try {
    await f.runtime.run("Gọi.", AbortSignal.abort());
    expect(f.messages).toEqual([]);
    expect(f.executions).toEqual([]);
  } finally { await f.close(); }
});

test("native history preserves trusted results and IDs without inventing or replaying actions", () => {
  const result = { contacts: [{ id: "person_1", name: "Mai" }] };
  const turns = [{ role: "assistant" as const, text: "Đã tìm.", tool_calls: [{ name: "contacts.search", arguments: { query: "Mai" } }], tool_results: [result] }];
  const messages = nativeDomainHistory(turns, "lifemate");
  expect(messages).toHaveLength(2);
  expect(messages[0].tool_calls?.[0].function.name).toBe(read);
  expect(messages[1].tool_call_id).toBe(messages[0].tool_calls?.[0].id);
  expect(JSON.parse(messages[1].content!)).toEqual(result);
  expect(messages[0].content).toBe("Đã tìm.");
  expect(() => nativeDomainHistory([{ ...turns[0], tool_results: [] }], "lifemate")).toThrow("Incomplete");
  expect(() => nativeDomainHistory([{ role: "user", tool_results: [result] }], "lifemate")).toThrow("Incomplete");
});

test("protocol detector ignores arbitrary prose, data objects and unknown tool names", () => {
  const names = new Set(["phone.call"]);
  expect(textToolEnvelope('Ví dụ {"name":"phone.call","arguments":{}} trong tài liệu.', names)).toBe(false);
  expect(textToolEnvelope('{"name":"Mai","arguments":{}}', names)).toBe(false);
  expect(textToolEnvelope('```json\n{"name":"phone.call","arguments":{}}\n```', names)).toBe(true);
  expect(textToolEnvelope('<tool_call>{"name":"phone.call","arguments":{}}</tool_call>', names)).toBe(true);
  expect(textToolEnvelope('Tôi sẽ gọi.\n{"tool_calls":[{"name":"phone.call","arguments":{}}],"tool_results":[{"ok":true}]}', names)).toBe(true);
});

test("malformed tool envelope is repaired without trusting its fabricated receipt", async () => {
  const bad = final('{"tool_calls":[{"name":"phone.call","arguments":{}}], "tool_results":[{"id":"fabricated_target"}');
  const f = fixture([bad, call(ask, { tool_name: "phone.call", params: ["contact_id"] })]);
  try {
    const result = await f.runtime.run("Gọi người chưa xác định.");
    expect(result.repairs).toBe(1);
    expect(f.executions.map((c) => c.name)).toEqual([ask]);
    expect(JSON.stringify(f.messages[1])).not.toContain("fabricated_target");
  } finally { await f.close(); }
});

test("mixed fake lookup and native mutation are quarantined before the mutation", async () => {
  const bad = call(write, { contact_id: "fabricated_target" });
  bad.content = '{"tool_calls":[{"name":"contacts.search","arguments":{}}],"tool_results":[{"id":"fabricated_target"}]}';
  const f = fixture([bad, call(read, { query: "Mai" }), call(write, { contact_id: "actual_target" }), final("Done")]);
  try {
    const result = await f.runtime.run("Gọi Mai.");
    expect(result.repairs).toBe(1);
    expect(f.executions).toEqual([{ name: read, args: { query: "Mai" } }, { name: write, args: { contact_id: "actual_target" } }]);
    expect(f.messages[1].some((m) => m.provider_data)).toBe(false);
    expect(JSON.stringify(f.messages[1])).not.toContain("fabricated_target");
  } finally { await f.close(); }
});

test("evidence view uses the exact request and observed tool data without modifying the conversation", async () => {
  const f = fixture([call(read, { query: "Mai" }), call(ask, { tool_name: "phone.call", params: ["contact_id"] })], { decisionEvidence: true });
  const originalSystem = f.runtime.agent.messages[0].content;
  try {
    await f.runtime.run("Gọi Mai đồng nghiệp; đừng gọi người nhà.");
    expect(f.messages[0][0].content).toContain("Gọi Mai đồng nghiệp; đừng gọi người nhà.");
    expect(f.messages[1][0].content).toContain('"source":"receipt:1"');
    expect(f.messages[1][0].content).toContain('"query":"Mai"');
    expect(f.messages[1][0].content).toContain('\"receipt_count\":1');
    expect(f.runtime.agent.messages[0].content).toBe(originalSystem);
    expect(f.executions.map((c) => c.name)).toEqual([read, ask]);
  } finally { await f.close(); }
});

test("terminal review can replace a prose question with a native clarification", async () => {
  const f = fixture([final("Bạn chọn người nào?"), call(ask, { tool_name: "phone.call", params: ["contact_id"] })], { decisionReview: "terminal" });
  try {
    const result = await f.runtime.run("Tìm người đúng rồi hỏi tôi chọn trước khi gọi.");
    expect(result.terminalReviews).toBe(1);
    expect(result.protocolStatus).toBe("waiting_for_user");
    expect(f.executions.map((c) => c.name)).toEqual([ask]);
    expect(JSON.stringify(f.messages[1])).toContain("Tìm người đúng rồi hỏi tôi chọn trước khi gọi.");
  } finally { await f.close(); }
});

test("terminal review accepts a no-op without forcing tool use or looping", async () => {
  const f = fixture([final("Không làm gì thêm."), final("Đã giữ nguyên.")], { decisionReview: "terminal" });
  try {
    const result = await f.runtime.run("Hủy yêu cầu vừa rồi, không cần làm gì nữa.");
    expect(result.requests).toBe(2);
    expect(result.terminalReviews).toBe(1);
    expect(f.executions).toEqual([]);
  } finally { await f.close(); }
});

test("clarification review preserves native continuation, holds the whole batch, and may retrieve then act", async () => {
  const draft = call(ask, { tool_name: "phone.call", params: ["contact_id"] });
  draft.tool_calls.push({ id: "unreviewed_write", name: write, arguments: { contact_id: "wrong" } });
  const f = fixture([draft, call(read, { query: "Mai" }), call(write, { contact_id: "right" }), final("Done")], { clarificationReview: true });
  try {
    const result = await f.runtime.run("Gọi Mai đồng nghiệp, tra danh bạ nếu cần.");
    expect(result.clarificationReviews).toBe(1);
    expect(result.protocolStatus).toBe("finished");
    expect(f.executions).toEqual([{ name: read, args: { query: "Mai" } }, { name: write, args: { contact_id: "right" } }]);
    expect(f.messages[1].find((m) => m.tool_calls?.length)?.provider_data).toEqual(draft.continuation);
    expect(f.messages[1].filter((m) => m.role === "tool")).toHaveLength(2);
    expect(f.messages[1][0].content).toContain("CLARIFICATION REVIEW");
    expect(f.messages[2][0].content).not.toContain("CLARIFICATION REVIEW");
    expect(result.receipts.map((r) => r.effect)).toEqual(["read", "write"]);
  } finally { await f.close(); }
});

test("clarification review allows the necessary question once and cannot loop", async () => {
  const question = call(ask, { tool_name: "phone.call", params: ["contact_id"] });
  const f = fixture([question, question], { clarificationReview: true });
  try {
    const result = await f.runtime.run("Tôi chưa chọn Mai nào.");
    expect(result.requests).toBe(2);
    expect(result.clarificationReviews).toBe(1);
    expect(result.protocolStatus).toBe("waiting_for_user");
    expect(f.executions).toEqual([{ name: ask, args: question.tool_calls[0].arguments }]);
  } finally { await f.close(); }
});

test("clarification review leaves direct actions alone and does not hold the last available request", async () => {
  for (const response of [call(write, { contact_id: "known" }), call(ask)]) {
    const f = fixture([response], { clarificationReview: true, maxRequests: 1 });
    try {
      const result = await f.runtime.run("Current request");
      expect(result.clarificationReviews).toBe(0);
      expect(f.executions).toHaveLength(1);
      expect(f.messages[0][0].content?.trim()).toBe("Isolated tool simulation.");
    } finally { await f.close(); }
  }
});

test("prewrite review never executes the unreviewed draft or replays its continuation", async () => {
  const f = fixture([call(write, { contact_id: "unsupported_person" }), call(ask, { tool_name: "phone.call", params: ["contact_id"] })], { decisionReview: "prewrite" });
  try {
    const result = await f.runtime.run("Gọi Mai, tôi chưa chọn Mai nào.");
    expect(result.writeReviews).toBe(1);
    expect(f.executions.map((c) => c.name)).toEqual([ask]);
    expect(f.messages[1].some((m) => m.provider_data)).toBe(false);
    expect(JSON.stringify(f.messages[1])).toContain("unexecuted_proposal");
    expect(f.messages[1].filter((m) => m.role === "tool")).toEqual([]);
  } finally { await f.close(); }
});

test("reviewed write keeps native arguments and successful receipts through completion", async () => {
  const revised = call(write, { contact_id: "correct_person" });
  const f = fixture([call(write, { contact_id: "wrong_person" }), revised, final("Đã gọi."), final("Hoàn tất.")], { decisionReview: "prewrite" });
  try {
    const result = await f.runtime.run("Gọi đúng người đã chọn.");
    expect(result.writeReviews).toBe(1);
    expect(result.terminalReviews).toBe(1);
    expect(f.executions).toEqual([{ name: write, args: { contact_id: "correct_person" } }]);
    expect(f.messages[2].find((m) => m.tool_calls?.length)?.provider_data).toEqual(revised.continuation);
    expect(f.messages[3].at(-1)?.content).toContain('"outcome":"succeeded"');
  } finally { await f.close(); }
});

test("a draft cannot execute when no request budget remains to review it", async () => {
  const f = fixture([call(write, { contact_id: "unreviewed" })], { decisionReview: "prewrite", maxRequests: 1 });
  try {
    const result = await f.runtime.run("Gọi Mai.");
    expect(result.protocolStatus).toBe("step_limit");
    expect(result.requests).toBe(1);
    expect(f.executions).toEqual([]);
  } finally { await f.close(); }
});
