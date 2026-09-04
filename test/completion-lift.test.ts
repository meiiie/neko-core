import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  __withBenchmarkCallBudgetForTest,
  renderCompletionCampaignReport,
  renderCompletionLiftReport,
  runBench,
  runCompletionCampaign,
  runCompletionLift,
  type BenchTask,
} from "../src/adapters/bench.ts";
import { NekoConfig } from "../src/adapters/config.ts";
import type { Provider, ProviderResponse } from "../src/core/ports.ts";

function config(model = "scripted-model"): NekoConfig {
  return new NekoConfig({
    provider: "openai_compat",
    model,
    reasoning_effort: "off",
    max_steps: 8,
    adaptive_effort: false,
    sandbox: false,
  }, null, {}, "");
}

function scriptedFactory(): () => Provider {
  let sequence = 0;
  return () => {
    let mainTurn = 0;
    let validatorTurn = 0;
    return {
      async complete(messages) {
        const system = messages
          .filter((message: any) => message.role === "system")
          .map((message: any) => String(message.content ?? ""))
          .join("\n");
        let response: ProviderResponse;
        if (system.includes("completion-standard author")) {
          response = {
            content: JSON.stringify({ baselineFacts: [], criteria: [{
              phase: "final_state",
              requirement: "out.txt contains ok",
              source: "user",
              verification: "Read out.txt and compare its entire trimmed content with ok",
              required: true,
              coverageArea: "output",
              weight: 1,
            }] }),
            tool_calls: [],
          };
        } else if (system.includes("independent completion validator")) {
          response = validatorTurn++ === 0
            ? { content: null, tool_calls: [{ id: `review-${sequence}`, name: "read_file", arguments: { path: "out.txt" } }] }
            : {
                content: JSON.stringify({
                  verdict: "pass",
                  coverageComplete: true,
                  criteria: [{ id: "C1", status: "passed", evidence: "out.txt was inspected", receipts: ["R1"] }],
                  findings: [],
                  additionalCriteria: [],
                }),
                tool_calls: [],
              };
        } else {
          const scripts = [
            { content: null, tool_calls: [{ id: `read-seed-${sequence}`, name: "read_file", arguments: { path: "request.txt" } }] },
            { content: null, tool_calls: [{ id: `write-${sequence}`, name: "write_file", arguments: { path: "out.txt", content: "ok\n" } }] },
            { content: null, tool_calls: [{ id: `read-out-${sequence}`, name: "read_file", arguments: { path: "out.txt" } }] },
            { content: "DONE", tool_calls: [] },
          ];
          response = scripts[Math.min(mainTurn++, scripts.length - 1)];
        }
        sequence++;
        return {
          ...response,
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, model_calls: 1 },
        };
      },
    };
  };
}

const task: BenchTask = {
  id: "completion-contract-smoke",
  files: { "request.txt": "write ok to out.txt\n" },
  prompt: "Inspect request.txt, create out.txt whose entire trimmed content is ok, verify the result, and preserve request.txt.",
  verify: (root) => readFileSync(`${root}/out.txt`, "utf8").trim() === "ok",
  constraints: [{ id: "keep-request", keep: "request.txt" }],
};

test("completion A/B repeats fixed tasks under the same provider-call cap", async () => {
  const report = await runCompletionLift(config(), undefined, {
    tasks: [task],
    suite: "offline-smoke",
    trials: 2,
    modelCallBudget: 7,
    maxSteps: 8,
    providerFactory: scriptedFactory(),
  });

  expect(report.comparisonValid).toBe(true);
  expect(report.baseline.passed).toBe(2);
  expect(report.contract.passed).toBe(2);
  expect(report.baseline.modelCallBudget).toBe(7);
  expect(report.contract.modelCallBudget).toBe(7);
  expect(report.baseline.calls).toBeLessThanOrEqual(14);
  expect(report.contract.calls).toBeLessThanOrEqual(14);
  expect(report.baseline.completionMode).toBe("self-review");
  expect(report.contract.completionMode).toBe("contract");
  expect(report.contract.results[0]).toMatchObject({
    coveragePassedWeight: 2,
    coverageTotalWeight: 2,
    instrumentExpansions: 0,
  });
  const rendered = renderCompletionLiftReport(report);
  expect(rendered).toContain("matched cap: 7 provider calls/trial");
  expect(rendered).toContain("token use is reported, not forced equal");
  expect(rendered).toContain("coverage 2/2, expansions 0");
}, 30_000);

test("completion campaign keeps profile/model cells separate and reports replicate uncertainty", async () => {
  const report = await runCompletionCampaign([
    { profile: "alpha", config: config("model-a") },
    { profile: "beta", config: config("model-b") },
  ], undefined, {
    tasks: [task],
    suite: "offline-matrix",
    trials: 1,
    modelCallBudget: 7,
    maxSteps: 8,
    providerFactory: () => scriptedFactory(),
  });

  expect(report.cells.map((cell) => [cell.profile, cell.model])).toEqual([
    ["alpha", "model-a"],
    ["beta", "model-b"],
  ]);
  expect(report.cells.every((cell) => cell.report.contract.passed === 1)).toBe(true);
  expect(report.sampling).toBe("provider-replicates");
  const rendered = renderCompletionCampaignReport(report);
  expect(rendered).toContain("2 model/profile cell(s) x 1 provider replicate(s)/task x 2 controllers");
  expect(rendered).toContain("not a controllable API seed on Anthropic-compatible routes");
}, 20_000);

test("one shared benchmark budget covers independent provider instances", async () => {
  const budget = { max: 1, used: 0 };
  const provider = (): Provider => ({ complete: async () => ({ content: "ok", tool_calls: [] }) });
  await __withBenchmarkCallBudgetForTest(provider(), budget).complete([]);
  await expect(__withBenchmarkCallBudgetForTest(provider(), budget).complete([])).rejects.toThrow("model-call budget exhausted (1)");
});

test("budgeted reports count harness admissions rather than provider-internal calls", async () => {
  let admissions = 0;
  const report = await runBench(config(), {
    tasks: [{ id: "admission-count", files: {}, prompt: "finish", verify: () => true }],
    trials: 1,
    modelCallBudget: 2,
    providerFactory: () => ({
      complete: async () => {
        admissions++;
        return {
          content: "done",
          tool_calls: [],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, model_calls: 7 },
        };
      },
    }),
  });
  expect(report.calls).toBe(admissions);
  expect(report.calls).toBe(2);
});

test("external artifact grading still runs after the controller exhausts its call budget", async () => {
  const report = await runBench(config(), {
    tasks: [{ id: "post-budget-grade", files: { "out.txt": "ok\n" }, prompt: "confirm the result", verify: (root) => readFileSync(`${root}/out.txt`, "utf8").trim() === "ok" }],
    trials: 1,
    completionMode: "self-review",
    modelCallBudget: 1,
    providerFactory: () => ({
      complete: async (): Promise<ProviderResponse> => ({ content: "The work may be done.", tool_calls: [] }),
    }),
  });
  expect(report.artifactPassed).toBe(1);
  expect(report.controllerPassed).toBe(0);
  expect(report.passed).toBe(0);
  expect(report.modelFailures).toBe(1);
  expect(report.results[0].budgetExhaustions).toBe(1);
});
