import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompletionSupervisor } from "../src/adapters/completion-supervisor.ts";
import { loadConfig } from "../src/adapters/config.ts";
import { applyCompletionReview, createCompletionContract } from "../src/core/completion-contract.ts";
import type { Provider } from "../src/core/ports.ts";
import {
  ToolRegistry,
  type NativeToolBackend,
  type NativeToolName,
} from "../src/core/tool-runtime.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("completion supervisor", () => {
  test("separates read-only contract authoring from bounded foreground validation", async () => {
    const root = mkdtempSync(join(tmpdir(), "neko-completion-supervisor-"));
    roots.push(root);
    const cfg = loadConfig({ cwd: root, home: root });
    const parent = new ToolRegistry(root, "auto", async () => true);
    const observed: { system: string; tools: string[] }[] = [];
    let disposed = 0;

    const providerFactory = (): Provider => ({
      async complete(messages, tools) {
        const system = String(messages[0]?.content ?? "");
        observed.push({
          system,
          tools: (tools ?? []).map((tool: any) => String(tool?.function?.name ?? tool?.name ?? "")),
        });
        const structured = system.includes("completion-standard author")
          ? JSON.stringify({
              baselineFacts: [],
              criteria: [{
                phase: "final_state",
                requirement: "The requested artifact exists",
                source: "user",
                verification: "Inspect the requested artifact path",
                required: true,
                coverageArea: "artifact",
                weight: 1,
              }],
            })
          : JSON.stringify({
              verdict: "pass",
            coverageComplete: true,
            criteria: [{ id: "C1", status: "passed", evidence: "Artifact observed" }],
            findings: [],
            additionalCriteria: [],
          });
        const content = system.includes("completion-standard author")
          ? structured
          : `Summary with an incidental {not-json} example.\n\n\`\`\`json\n${structured}\n\`\`\``;
        return { content, tool_calls: [] };
      },
      dispose() { disposed++; },
    });

    const supervisor = createCompletionSupervisor(cfg, parent, { providerFactory });
    const draft = await supervisor.create("Create the requested artifact");
    const contract = createCompletionContract("Create the requested artifact", draft.value, "2026-08-29T00:00:00.000Z");
    const review = await supervisor.review(contract);

    expect(review.value.verdict).toBe("pass");
    expect(observed).toHaveLength(2);
    expect(observed[0].tools.sort()).toEqual(["glob", "ls", "read_file", "search"]);
    expect(observed[1].tools.sort()).toEqual(["bash", "glob", "ls", "read_file", "search"]);
    for (const call of observed) {
      expect(call.tools).not.toContain("write_file");
      expect(call.tools).not.toContain("edit");
      expect(call.tools).not.toContain("computer");
      expect(call.tools).not.toContain("task");
    }
    expect(observed[0].system).toContain("before implementation");
    expect(observed[0].system).toContain("validator command is an instrument");
    expect(observed[1].system).toContain("did not implement");
    expect(observed[1].system).toContain("unavailable optional tool is an instrument limitation");
    expect(disposed).toBe(2);
  });

  test("grounds conclusive evidence in privacy-safe receipts from actual validator tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "neko-completion-receipts-"));
    roots.push(root);
    writeFileSync(join(root, "artifact.txt"), "ready\n");
    const cfg = loadConfig({ cwd: root, home: root });
    const parent = new ToolRegistry(root, "auto", async () => true);
    let calls = 0;
    let observedToolResult = "";
    const providerFactory = (): Provider => ({
      async complete(messages) {
        if (calls++ === 0) {
          return { content: null, tool_calls: [{ id: "inspect", name: "read_file", arguments: { path: "artifact.txt" } }] };
        }
        observedToolResult = String(messages.findLast((message) => message.role === "tool")?.content ?? "");
        return {
          content: JSON.stringify({
            verdict: "pass",
            coverageComplete: true,
            criteria: [{ id: "C1", status: "passed", evidence: "artifact.txt contains ready", receipts: ["R1"] }],
            findings: [],
            additionalCriteria: [],
          }),
          tool_calls: [],
        };
      },
    });
    const contract = createCompletionContract("Create artifact.txt", { criteria: [{
      requirement: "artifact.txt contains ready",
      source: "user",
      verification: "Read artifact.txt",
    }] }, "2026-08-29T00:00:00.000Z");
    const supervisor = createCompletionSupervisor(cfg, parent, { providerFactory });
    const draft = await supervisor.review(contract);
    const reviewed = applyCompletionReview(contract, draft.value, 1, "2026-08-29T00:01:00.000Z");

    expect(observedToolResult).toMatch(/^\[measurement R1; tool=read_file; outcome=productive; artifact_sha256=[a-f0-9]{64}\]/);
    expect(draft.value.measurements).toEqual([{
      id: "R1",
      tool: "read_file",
      outcome: "productive",
      digest: createHash("sha256").update("ready\n").digest("hex"),
      digestKind: "artifact",
      subject: "read_file:artifact.txt",
    }]);
    expect(reviewed.lastReview?.verdict).toBe("pass");
    expect(reviewed.lastReview?.evidence[0].receipts).toEqual(["R1"]);
  });

  test("reviews the authoritative remote workspace instead of an empty host root", async () => {
    const root = mkdtempSync(join(tmpdir(), "neko-completion-remote-root-"));
    roots.push(root);
    const cfg = loadConfig({ cwd: root, home: root });
    const remoteCalls: string[] = [];
    const backend: NativeToolBackend = {
      tools: ["read_file"],
      attestation: {
        protocol: "neko-native-posix-v1",
        canonicalPosixRoot: "/workspace",
        pathChecks: "backend-enforced",
        structuredWriteConfinement: "backend-enforced",
        exactEditTarget: "backend-enforced",
        bashSandbox: "backend-enforced",
        exactValidatorSandbox: "unsupported",
        boundedObservations: "backend-enforced",
        deadlineAndCancellation: "backend-enforced-quiescent",
        checkpointRewind: "unsupported",
      },
      async execute(name: NativeToolName, args) {
        remoteCalls.push(`${name}:${String(args.path ?? "")}`);
        return "ready\n";
      },
    };
    const parent = new ToolRegistry(root, "auto", async () => true, undefined, backend);
    let calls = 0;
    const providerFactory = (): Provider => ({
      async complete() {
        if (calls++ === 0) {
          return { content: null, tool_calls: [{ id: "inspect", name: "read_file", arguments: { path: "artifact.txt" } }] };
        }
        return {
          content: JSON.stringify({
            verdict: "pass",
            coverageComplete: true,
            criteria: [{ id: "C1", status: "passed", evidence: "remote artifact contains ready", receipts: ["R1"] }],
            findings: [],
            additionalCriteria: [],
          }),
          tool_calls: [],
        };
      },
    });
    const contract = createCompletionContract("Create artifact.txt", { criteria: [{
      requirement: "artifact.txt contains ready",
      source: "user",
      verification: "Read artifact.txt",
    }] });

    const draft = await createCompletionSupervisor(cfg, parent, { providerFactory }).review(contract);

    expect(remoteCalls).toEqual(["read_file:artifact.txt"]);
    expect(draft.value.verdict).toBe("pass");
    expect(draft.value.measurements?.[0]).toMatchObject({
      id: "R1",
      tool: "read_file",
      outcome: "productive",
      subject: "read_file:artifact.txt",
    });
  });

  test("repairs one malformed final verdict with schema-constrained output and the same receipts", async () => {
    const root = mkdtempSync(join(tmpdir(), "neko-completion-repair-"));
    roots.push(root);
    writeFileSync(join(root, "artifact.txt"), "ready\n");
    const cfg = loadConfig({ cwd: root, home: root });
    const parent = new ToolRegistry(root, "auto", async () => true);
    let calls = 0;
    let repairSawReceipt = false;
    let repairSchema: any;
    const providerFactory = (): Provider => ({
      async complete(messages, _tools, _onDelta, _signal, options) {
        calls++;
        if (calls === 1) {
          return {
            content: null,
            tool_calls: [{ id: "inspect", name: "read_file", arguments: { path: "artifact.txt" } }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          };
        }
        if (calls === 2) {
          return {
            content: "Evidence collected. {\"verdict\":\"pass\",\"criteria\":[",
            tool_calls: [],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          };
        }
        repairSawReceipt = JSON.stringify(messages).includes("measurement R1");
        repairSchema = options?.responseSchema;
        return {
          content: JSON.stringify({
            verdict: "pass",
            coverageComplete: true,
            criteria: [{ id: "C1", status: "passed", evidence: "ready observed", receipts: ["R1"] }],
            findings: [],
            additionalCriteria: [],
          }),
          tool_calls: [],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        };
      },
    });
    const contract = createCompletionContract("Create artifact.txt", { criteria: [{
      requirement: "artifact.txt contains ready",
      source: "user",
      verification: "Read artifact.txt",
    }] });
    const draft = await createCompletionSupervisor(cfg, parent, { providerFactory }).review(contract);

    expect(calls).toBe(3);
    expect(repairSawReceipt).toBe(true);
    expect(repairSchema?.properties?.verdict?.enum).toEqual(["pass", "fail", "blocked"]);
    expect(draft.value.verdict).toBe("pass");
    expect(draft.value.measurements?.[0].id).toBe("R1");
    expect(draft.usage?.model_calls).toBe(3);
    expect(draft.usage?.total_tokens).toBe(36);
  });

  test("repairs a valid-looking verdict that omits fixed contract criteria", async () => {
    const root = mkdtempSync(join(tmpdir(), "neko-completion-coverage-"));
    roots.push(root);
    const cfg = loadConfig({ cwd: root, home: root });
    const parent = new ToolRegistry(root, "auto", async () => true);
    let calls = 0;
    let repairSchema: any;
    const providerFactory = (): Provider => ({
      async complete(_messages, _tools, _onDelta, _signal, options) {
        calls++;
        if (calls === 1) {
          return { content: JSON.stringify({
            verdict: "pass",
            coverageComplete: true,
            criteria: [{ id: "C1", status: "passed", evidence: "first checked", receipts: [] }],
            findings: [],
            additionalCriteria: [],
          }), tool_calls: [] };
        }
        repairSchema = options?.responseSchema;
        return { content: JSON.stringify({
          verdict: "pass",
          coverageComplete: true,
          criteria: [
            { id: "C1", status: "passed", evidence: "first checked", receipts: [] },
            { id: "C2", status: "passed", evidence: "second checked", receipts: [] },
          ],
          findings: [],
          additionalCriteria: [],
        }), tool_calls: [] };
      },
    });
    const contract = createCompletionContract("Ship both outcomes", { criteria: [
      { requirement: "First works", source: "runtime", verification: "check first" },
      { requirement: "Second works", source: "runtime", verification: "check second" },
    ] });
    const draft = await createCompletionSupervisor(cfg, parent, { providerFactory }).review(contract);

    expect(calls).toBe(2);
    expect(draft.value.criteria?.map((criterion) => criterion.id)).toEqual(["C1", "C2"]);
    expect(repairSchema?.properties?.criteria?.minItems).toBe(2);
    expect(repairSchema?.properties?.criteria?.maxItems).toBe(2);
    expect(repairSchema?.properties?.criteria?.items?.properties?.id?.enum).toEqual(["C1", "C2"]);
  });

  test("keeps pre-work diagnosis out of final-state completion criteria", async () => {
    const root = mkdtempSync(join(tmpdir(), "neko-completion-final-state-"));
    roots.push(root);
    writeFileSync(join(root, "bug.txt"), "broken\n");
    const cfg = loadConfig({ cwd: root, home: root });
    const parent = new ToolRegistry(root, "auto", async () => true);
    let calls = 0;
    let repairSchema: any;
    const providerFactory = (): Provider => ({
      async complete(_messages, _tools, _onDelta, _signal, options) {
        calls++;
        if (calls === 1) {
          return { content: JSON.stringify({
            baselineFacts: [],
            criteria: [{
              phase: "final_state",
              requirement: "Reproduce and understand the failure before fixing it",
              source: "runtime",
              verification: "Run the failing command",
              coverageArea: "failure",
              weight: 1,
            }],
          }), tool_calls: [] };
        }
        repairSchema = options?.responseSchema;
        return { content: JSON.stringify({
          baselineFacts: [{ statement: "bug.txt was broken before work", receipts: ["B1"] }],
          criteria: [{
            phase: "final_state",
            requirement: "bug.txt contains fixed",
            source: "user",
            verification: "Read bug.txt after work",
            required: true,
            coverageArea: "artifact",
            weight: 1,
          }],
        }), tool_calls: [] };
      },
    });
    const draft = await createCompletionSupervisor(cfg, parent, { providerFactory }).create("Fix bug.txt");

    expect(calls).toBe(2);
    expect(repairSchema?.properties?.criteria?.items?.properties?.phase?.enum).toEqual(["final_state"]);
    expect(repairSchema?.properties?.criteria?.items?.properties?.baselineReceipts?.maxItems).toBe(1);
    expect(draft.value.criteria?.[0]?.requirement).toBe("bug.txt contains fixed");
  });

  test("adjudicates inconsistent labels without changing the evidence ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "neko-completion-adjudicate-"));
    roots.push(root);
    writeFileSync(join(root, "artifact.txt"), "ready\n");
    const cfg = loadConfig({ cwd: root, home: root });
    const parent = new ToolRegistry(root, "auto", async () => true);
    let calls = 0;
    let adjudicationSchema: any;
    const evidence = "artifact.txt was read and contains exactly ready";
    const providerFactory = (): Provider => ({
      async complete(_messages, _tools, _onDelta, _signal, options) {
        calls++;
        if (calls === 1) return { content: null, tool_calls: [{ id: "read", name: "read_file", arguments: { path: "artifact.txt" } }] };
        if (calls === 2) return { content: JSON.stringify({
          verdict: "blocked",
          coverageComplete: true,
          criteria: [{ id: "C1", status: "unknown", evidence, receipts: ["R1"] }],
          findings: ["The collected evidence verifies the criterion"],
          additionalCriteria: [],
        }), tool_calls: [] };
        adjudicationSchema = options?.responseSchema;
        return { content: JSON.stringify({
          verdict: "pass",
          criteria: [{ id: "C1", status: "passed" }],
        }), tool_calls: [] };
      },
    });
    const contract = createCompletionContract("Create artifact.txt", { criteria: [{
      requirement: "artifact.txt contains ready",
      source: "user",
      verification: "Read artifact.txt",
    }] });
    const draft = await createCompletionSupervisor(cfg, parent, { providerFactory }).review(contract);

    expect(calls).toBe(3);
    expect(adjudicationSchema?.properties?.criteria?.items?.additionalProperties).toBe(false);
    expect(draft.value.verdict).toBe("pass");
    expect(draft.value.criteria?.[0]).toEqual({ id: "C1", status: "passed", evidence, receipts: ["R1"] });
  });
});
