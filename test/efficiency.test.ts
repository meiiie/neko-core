import { expect, test } from "bun:test";
import { EfficiencyTracker } from "../src/core/efficiency.ts";
import { Agent } from "../src/core/agent.ts";
import { headlessRunOutcome } from "../src/adapters/run-outcome.ts";
import type { Provider } from "../src/core/ports.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

test("request diagnostics distinguish prefix changes, latency and failures without exposing payloads", () => {
  let now = 0;
  const metrics = new EfficiencyTracker(() => now);
  const provider = { apiKey: "credential-sentinel", complete: async () => ({ content: "ok", tool_calls: [] }) };
  const parts = { base: "private system", session: "private project", turn: "state1", tools: "secret tool", effort: "configured" };
  const first = metrics.start(provider, parts);
  now = 10;
  first.firstEvent();
  now = 30;
  expect(first.finish("success")).toMatchObject({ elapsedMs: 30, firstEventMs: 10, prefixChanges: [] });
  first.finish("error");
  const changed = metrics.start(provider, { ...parts, turn: "state2" });
  now = 90;
  expect(changed.finish("error")).toMatchObject({ prefixChanges: ["turn"], firstEventMs: null });
  metrics.start({ complete: provider.complete }, { ...parts, effort: "low" }).finish("aborted");
  const snapshot = metrics.snapshot();
  expect(snapshot).toMatchObject({ requests: 3, errors: 1, aborts: 1, firstEventSamples: 1, p50FirstEventMs: 10 });
  expect(snapshot.prefixChanges).toMatchObject({ provider: 1, effort: 1, base: 0, session: 0, tools: 0 });
  for (const secret of [...Object.values(parts), provider.apiKey]) {
    expect(JSON.stringify(metrics)).not.toContain(secret);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  }
  expect(metrics.summary()).toContain("not proof of a cache miss");
});

test("latency samples are bounded and unstreamed requests are never reported as zero TTFT", () => {
  let now = 0;
  const metrics = new EfficiencyTracker(() => now);
  const provider: Provider = { complete: async () => ({ content: "ok", tool_calls: [] }) };
  for (let i = 0; i < 100; i++) {
    const request = metrics.start(provider, { base: "", session: "", turn: "", tools: "", effort: "" });
    now += 20;
    request.finish("success");
  }
  expect(metrics.snapshot()).toMatchObject({ requests: 100, latencySamples: 64, firstEventSamples: 0, p50RequestMs: 20, p95RequestMs: 20, p50FirstEventMs: null });
});

test("identical read observations are counted but never across mutations, waits or user turns", () => {
  const metrics = new EfficiencyTracker();
  const read = () => metrics.observeTool('read_file:{"path":"private path"}', "private content", false, false, false);
  read(); read();
  expect(metrics.snapshot().repeatedObservations).toBe(1);
  metrics.observeTool("edit", "changed", true, false, false);
  read();
  metrics.resetObservations();
  read();
  for (let i = 0; i < 3; i++) metrics.observeTool("computer:watch", "same", false, false, true);
  metrics.observeTool("read_file", "Error: denied", false, true, false);
  expect(metrics.snapshot()).toMatchObject({ repeatedObservations: 1, failedTools: 1 });
  expect(JSON.stringify(metrics)).not.toMatch(/private path|private content|Error: denied/);
});

function fixtureTools(execute: (name: string) => Promise<string>) {
  const tools = new ToolRegistry(".", "auto", () => true);
  tools.schemas = () => [];
  tools.execute = execute;
  return tools;
}

test("missing state evidence stops after two nudges, fails headless and preserves the no-replay trajectory", async () => {
  let calls = 0;
  let mutations = 0;
  const provider: Provider = { complete: async () => ++calls === 1
    ? { content: null, tool_calls: [{ id: "edit-once", name: "write_file", arguments: { path: "a.txt", content: "new" } }] }
    : { content: "I am certain everything is verified.", tool_calls: [] } };
  const agent = new Agent({ provider, maxSteps: 50, verifyStateChangesBeforeExit: true,
    tools: fixtureTools(async () => { mutations++; return "wrote a.txt"; }) });
  const result = await agent.run("fix a.txt");
  expect(calls).toBe(4);
  expect(mutations).toBe(1);
  expect(result).toStartWith("Verification incomplete:");
  expect(agent.messages.at(-1).content).toBe(result);
  expect(agent.messages.filter(message => message.role === "tool")).toHaveLength(1);
  expect(agent.completionStatus).toEqual({ ok: false, reason: "outcome_unverified" });
  expect(headlessRunOutcome(true, agent.completionStatus).exitCode).toBe(1);
  expect(agent.cost.efficiency.snapshot()).toMatchObject({ requests: 4, verificationNudges: 2, unverifiedStops: 1 });
});

test("fresh evidence avoids duplicate verification and later writes invalidate it", async () => {
  const calls = ["write_file", "read_file", "write_file", "final", "read_file", "final"];
  const metrics: unknown[] = [];
  const provider: Provider = { complete: async () => {
    const name = calls.shift()!;
    return name === "final" ? { content: "verified", tool_calls: [] } : { content: null, tool_calls: [{ id: String(calls.length), name, arguments: { path: "x" } }] };
  } };
  const agent = new Agent({ provider, verifyStateChangesBeforeExit: true, verifyBeforeExit: true,
    tools: fixtureTools(async () => "current state"),
    onEvent: (kind, data) => { if (kind === "request_metrics") metrics.push(data); },
  });
  expect(await agent.run("fix x")).toBe("verified");
  expect(agent.completionStatus.ok).toBe(true);
  expect(agent.cost.efficiency.snapshot()).toMatchObject({ verificationNudges: 1, unverifiedStops: 0 });
  expect(metrics).toHaveLength(6);
  expect(JSON.stringify(metrics)).not.toContain("current state");
  expect(agent.cost.summary()).toContain("local efficiency");
});

test("an independent passing review resolves missing observations without replaying a mutation", async () => {
  let calls = 0;
  let mutations = 0;
  let reviews = 0;
  const provider: Provider = { complete: async () => ++calls === 1
    ? { content: null, tool_calls: [{ id: "edit-once", name: "write_file", arguments: { path: "a.txt", content: "new" } }] }
    : { content: "Everything is verified.", tool_calls: [] } };
  const agent = new Agent({ provider, maxSteps: 50, verifyStateChangesBeforeExit: true,
    tools: fixtureTools(async () => { mutations++; return "wrote a.txt"; }),
    completionSupervisor: {
      create: async () => ({ value: { criteria: [{ requirement: "a.txt contains new", source: "user", verification: "Read a.txt" }] } }),
      review: async () => {
        reviews++;
        return { value: { verdict: "pass", criteria: [{ id: "C1", status: "passed", evidence: "Read a.txt; contents equal new." }] } };
      },
    },
  });
  const result = await agent.runUntilDone("write a.txt", { maxIters: 3 });
  expect(result).toStartWith("Independent verification passed");
  expect(agent.messages.at(-1).content).toBe(result);
  expect(agent.completionStatus.ok).toBe(true);
  expect(calls).toBe(4);
  expect(reviews).toBe(1);
  expect(mutations).toBe(1);
});

test("a step limit with unknown outcome preserves the tool call and avoids a useless wrap-up", async () => {
  let calls = 0;
  const provider: Provider = { complete: async () => {
    calls++;
    return { content: null, tool_calls: [{ id: "edit-once", name: "write_file", arguments: { path: "x", content: "new" } }] };
  } };
  const agent = new Agent({ provider, maxSteps: 1, verifyStateChangesBeforeExit: true,
    tools: fixtureTools(async () => "wrote x"),
  });
  expect(await agent.run("write x")).toStartWith("Verification incomplete:");
  expect(calls).toBe(1);
  expect(agent.messages.some(message => message.tool_calls?.[0]?.id === "edit-once")).toBe(true);
  expect(agent.messages.some(message => message.tool_call_id === "edit-once")).toBe(true);
  expect(agent.cost.efficiency.snapshot().purposes.wrapup).toBe(0);
});

test("stream timing instrumentation preserves opt-in streaming, error usage and cancellation", async () => {
  const abort = new AbortController();
  const provider: Provider = { complete: async (_messages, _tools, delta, _signal, options) => {
    expect(delta).toBeUndefined();
    options?.onUsage?.({ prompt_tokens: 10, completion_tokens: 2 });
    abort.abort();
    throw new Error("secret error detail");
  } };
  const agent = new Agent({ provider, tools: fixtureTools(async () => "") });
  expect(await agent.run("hello", abort.signal)).toBe("[interrupted]");
  expect(agent.cost.totalTokens).toBe(12);
  expect(agent.cost.efficiency.snapshot()).toMatchObject({ requests: 1, aborts: 1, errors: 0, firstEventSamples: 0 });
});
