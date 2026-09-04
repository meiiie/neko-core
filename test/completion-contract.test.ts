import { describe, expect, test } from "bun:test";
import {
  applyCompletionReview,
  completionCoverage,
  createCompletionContract,
  isCompletionContract,
  renderCompletionContract,
} from "../src/core/completion-contract.ts";

describe("completion contract", () => {
  test("normalizes an independent draft into stable criteria", () => {
    const contract = createCompletionContract("Ship the feature", {
      criteria: [
        { requirement: "  Existing tests still pass  ", source: "repository", verification: "Run bun test" },
        { requirement: "Existing tests still pass", source: "runtime", verification: "duplicate" },
        { requirement: "The CLI prints OK", source: "runtime", verification: "Run the CLI and compare stdout", required: false },
        { requirement: "missing procedure" },
      ],
    }, "2026-08-29T00:00:00.000Z");

    expect(contract).toMatchObject({ schemaVersion: 1, revision: 1, goal: "Ship the feature" });
    expect(contract.criteria).toEqual([
      { id: "C1", requirement: "Existing tests still pass", source: "repository", verification: "Run bun test", required: true, coverageArea: "general", weight: 1 },
      { id: "C2", requirement: "The CLI prints OK", source: "runtime", verification: "Run the CLI and compare stdout", required: false, coverageArea: "general", weight: 1 },
    ]);
    expect(isCompletionContract(contract)).toBe(true);
  });

  test("persists grounded pre-work facts separately from final criteria", () => {
    const digest = "a".repeat(64);
    const contract = createCompletionContract("Fix the failure", {
      baselineFacts: [
        { statement: "The current test fails with concatenated output", receipts: ["B1"] },
        { statement: "Ungrounded claim", receipts: ["B2"] },
      ],
      criteria: [{ requirement: "The test passes", source: "runtime", verification: "Run the test" }],
      measurements: [
        { id: "B1", tool: "bash", outcome: "productive", digest },
        { id: "B2", tool: "bash", outcome: "failed", digest: "b".repeat(64) },
      ],
    });

    expect(contract.baselineFacts).toEqual([{ statement: "The current test fails with concatenated output", receipts: ["B1"] }]);
    expect(renderCompletionContract(contract)).toContain("Pre-work facts:");
    expect(isCompletionContract(contract)).toBe(true);
    expect(isCompletionContract({ ...contract, baselineFacts: [{ statement: "invented", receipts: ["B2"] }] })).toBe(false);
  });

  test("cannot pass when a required criterion is missing or failed", () => {
    const original = createCompletionContract("Ship", { criteria: [
      { requirement: "Tests pass", source: "repository", verification: "bun test" },
      { requirement: "CLI works", source: "runtime", verification: "run CLI" },
    ] }, "2026-08-29T00:00:00.000Z");

    const missing = applyCompletionReview(original, {
      verdict: "pass",
      criteria: [{ id: "C1", status: "passed", evidence: "10 tests passed" }],
    }, 2, "2026-08-29T00:01:00.000Z");
    expect(missing.lastReview?.verdict).toBe("blocked");
    expect(missing.lastReview?.evidence[1].status).toBe("unknown");

    const failed = applyCompletionReview(original, {
      verdict: "pass",
      criteria: [
        { id: "C1", status: "passed", evidence: "10 tests passed" },
        { id: "C2", status: "failed", evidence: "exit 1" },
      ],
    }, 3, "2026-08-29T00:02:00.000Z");
    expect(failed.lastReview?.verdict).toBe("fail");
  });

  test("a measured review cannot pass on model prose without a real tool receipt", () => {
    const original = createCompletionContract("Ship", { criteria: [
      { requirement: "Tests pass", source: "repository", verification: "bun test" },
    ] }, "2026-08-29T00:00:00.000Z");
    const ungrounded = applyCompletionReview(original, {
      verdict: "pass",
      criteria: [{ id: "C1", status: "passed", evidence: "All tests passed", receipts: ["R1"] }],
      measurements: [],
    }, 1, "2026-08-29T00:01:00.000Z");

    expect(ungrounded.lastReview?.verdict).toBe("blocked");
    expect(ungrounded.lastReview?.evidence[0]).toMatchObject({ status: "unknown", receipts: [] });

    const grounded = applyCompletionReview(original, {
      verdict: "pass",
      criteria: [{ id: "C1", status: "passed", evidence: "bun test exited 0", receipts: ["R1"] }],
      measurements: [{ id: "R1", tool: "bash", outcome: "productive", digest: "a".repeat(64) }],
    }, 1, "2026-08-29T00:02:00.000Z");

    expect(grounded.lastReview?.verdict).toBe("pass");
    expect(grounded.lastReview?.evidence[0].receipts).toEqual(["R1"]);
    expect(isCompletionContract(grounded)).toBe(true);
  });

  test("an exact preservation claim needs a matching pre-work measurement", () => {
    const digest = "a".repeat(64);
    const contract = createCompletionContract("Fix parse.mjs without touching st.mjs", {
      criteria: [{
        requirement: "st.mjs remains unchanged",
        source: "user",
        verification: "Read st.mjs and compare it byte-for-byte",
        baselineReceipts: ["B1"],
        baselineRelation: "same",
      }],
      measurements: [{ id: "B1", tool: "read_file", outcome: "productive", digest, digestKind: "artifact", subject: "read_file:st.mjs" }],
    });
    const changed = applyCompletionReview(contract, {
      verdict: "pass",
      criteria: [{ id: "C1", status: "passed", evidence: "inspected", receipts: ["R1"] }],
      findings: [],
      measurements: [{ id: "R1", tool: "read_file", outcome: "productive", digest: "b".repeat(64), digestKind: "artifact", subject: "read_file:st.mjs" }],
    }, 1);
    const unchanged = applyCompletionReview(contract, {
      verdict: "pass",
      criteria: [{ id: "C1", status: "passed", evidence: "same bytes", receipts: ["R1"] }],
      findings: [],
      measurements: [{ id: "R1", tool: "read_file", outcome: "productive", digest, digestKind: "artifact", subject: "read_file:st.mjs" }],
    }, 1);

    expect(changed.lastReview?.verdict).toBe("blocked");
    expect(changed.lastReview?.evidence[0].status).toBe("unknown");
    expect(unchanged.lastReview?.verdict).toBe("pass");
    expect(isCompletionContract(unchanged)).toBe(true);
  });

  test("a required file change is established mechanically from fresh same-subject measurements", () => {
    const contract = createCompletionContract("Fix parse.mjs", {
      criteria: [{
        requirement: "parse.mjs differs from its pre-work state",
        source: "user",
        verification: "Read parse.mjs and compare the bytes",
        baselineReceipts: ["B1", "B2"],
        baselineRelation: "different",
      }],
      measurements: [
        { id: "B1", tool: "read_file", outcome: "productive", digest: "a".repeat(64), digestKind: "artifact", subject: "read_file:parse.mjs" },
        { id: "B2", tool: "read_file", outcome: "productive", digest: "c".repeat(64), digestKind: "artifact", subject: "read_file:summary.mjs" },
      ],
    });
    const reviewed = applyCompletionReview(contract, {
      verdict: "pass",
      criteria: [{ id: "C1", status: "passed", evidence: "behavior changed as required", receipts: ["R2"] }],
      findings: [],
      measurements: [
        { id: "R1", tool: "read_file", outcome: "productive", digest: "b".repeat(64), digestKind: "artifact", subject: "read_file:parse.mjs" },
        { id: "R2", tool: "bash", outcome: "productive", digest: "d".repeat(64) },
      ],
    }, 1);
    expect(contract.criteria[0].baselineReceipts).toEqual(["B1"]);
    expect(reviewed.lastReview?.verdict).toBe("pass");
  });

  test("an unrelated baseline cannot demote a conclusive runtime criterion", () => {
    const contract = createCompletionContract("Fix parse.mjs", {
      criteria: [{
        requirement: "bun st.mjs exits 0 and prints ok",
        source: "runtime",
        verification: "Run bun st.mjs",
        baselineReceipts: ["B1"],
        baselineRelation: "different",
      }],
      measurements: [{
        id: "B1",
        tool: "read_file",
        outcome: "productive",
        digest: "a".repeat(64),
        digestKind: "artifact",
        subject: "read_file:st.mjs",
      }],
    });
    const reviewed = applyCompletionReview(contract, {
      verdict: "pass",
      criteria: [{ id: "C1", status: "passed", evidence: "exit 0, stdout ok", receipts: ["R1"] }],
      findings: [],
      measurements: [{ id: "R1", tool: "bash", outcome: "productive", digest: "b".repeat(64) }],
    }, 1);

    expect(contract.criteria[0].baselineReceipts).toBeUndefined();
    expect(reviewed.lastReview?.verdict).toBe("pass");
  });

  test("an exact preservation claim without a pre-work measurement cannot self-certify", () => {
    const contract = createCompletionContract("Keep st.mjs", { criteria: [{
      requirement: "Keep st.mjs unchanged",
      source: "user",
      verification: "Inspect st.mjs",
    }] });
    const reviewed = applyCompletionReview(contract, {
      verdict: "pass",
      criteria: [{ id: "C1", status: "passed", evidence: "looks unchanged", receipts: ["R1"] }],
      findings: [],
      measurements: [{ id: "R1", tool: "read_file", outcome: "productive", digest: "c".repeat(64) }],
    }, 1);
    expect(reviewed.lastReview?.verdict).toBe("blocked");
    expect(reviewed.lastReview?.evidence[0].status).toBe("unknown");
  });

  test("review updates evidence without allowing criteria to be weakened", () => {
    const original = createCompletionContract("Ship", { criteria: [
      { requirement: "Tests pass", source: "repository", verification: "bun test" },
    ] }, "2026-08-29T00:00:00.000Z");
    const reviewed = applyCompletionReview(original, {
      verdict: "pass",
      criteria: [{ id: "C1", status: "passed", evidence: "exit 0", requirement: "weakened" }],
      findings: ["all clear"],
    }, 4, "2026-08-29T00:03:00.000Z");

    expect(reviewed.criteria).toEqual(original.criteria);
    expect(reviewed.lastReview?.verdict).toBe("pass");
    expect(reviewed.lastReview?.artifactRevision).toBe(4);
    expect(isCompletionContract(reviewed)).toBe(true);
    expect(renderCompletionContract(reviewed)).toContain("[x] C1 Tests pass");
  });

  test("a validator may append a missing criterion but cannot pass it without a later review", () => {
    const original = createCompletionContract("Ship", { criteria: [
      { requirement: "Tests pass", source: "repository", verification: "bun test" },
    ] }, "2026-08-29T00:00:00.000Z");
    const expanded = applyCompletionReview(original, {
      verdict: "pass",
      criteria: [{ id: "C1", status: "passed", evidence: "green" }],
      additionalCriteria: [{
        requirement: "The CLI output matches the public contract",
        source: "runtime",
        verification: "Run the CLI and compare stdout",
        coverageArea: "cli-output",
        weight: 20,
      }],
    }, 2, "2026-08-29T00:01:00.000Z");

    expect(expanded.criteria[0]).toEqual(original.criteria[0]);
    expect(expanded.criteria[1]).toMatchObject({ id: "C2", source: "runtime", required: true });
    expect(expanded.instrumentRevision).toBe(2);
    expect(expanded.lastReview?.evidence[1]).toEqual({ criterionId: "C2", status: "unknown", evidence: "" });
    expect(expanded.lastReview?.verdict).toBe("blocked");
    expect(isCompletionContract(expanded)).toBe(true);
  });

  test("weighted coverage is diagnostic while every required outcome remains mandatory", () => {
    const contract = createCompletionContract("Rebuild the behavior", { criteria: [
      { requirement: "Core commands match", source: "reference", verification: "Run the command matrix", coverageArea: "commands", weight: 90 },
      { requirement: "Error behavior matches", source: "reference", verification: "Run invalid-input cases", coverageArea: "errors", weight: 10 },
    ] });
    const reviewed = applyCompletionReview(contract, {
      verdict: "pass",
      coverageComplete: true,
      criteria: [
        { id: "C1", status: "passed", evidence: "matrix passed" },
        { id: "C2", status: "failed", evidence: "wrong error" },
      ],
    }, 1);

    expect(completionCoverage(reviewed)).toEqual({
      totalWeight: 100,
      passedWeight: 90,
      failedWeight: 10,
      blockedWeight: 0,
      unknownWeight: 0,
      score: 0.9,
    });
    expect(reviewed.lastReview?.verdict).toBe("fail");
    expect(renderCompletionContract(reviewed)).toContain("Weighted coverage: 90/100 (90%)");
  });

  test("an incomplete instrument cannot certify completion", () => {
    const contract = createCompletionContract("Ship", { criteria: [{
      requirement: "Primary flow works",
      source: "user",
      verification: "Exercise the primary flow",
      coverageArea: "primary",
      weight: 100,
    }] });
    const reviewed = applyCompletionReview(contract, {
      verdict: "pass",
      coverageComplete: false,
      criteria: [{ id: "C1", status: "passed", evidence: "primary flow passed" }],
      findings: ["The error surface is not measured yet"],
    }, 1);

    expect(reviewed.lastReview?.coverageComplete).toBe(false);
    expect(reviewed.lastReview?.verdict).toBe("blocked");
    expect(isCompletionContract(reviewed)).toBe(true);
  });

  test("rejects malformed persisted contracts", () => {
    const valid = createCompletionContract("Ship", { criteria: [
      { requirement: "Tests pass", source: "repository", verification: "bun test" },
    ] }, "2026-08-29T00:00:00.000Z");
    expect(isCompletionContract({ ...valid, criteria: [] })).toBe(false);
    expect(isCompletionContract({ ...valid, goal: "x".repeat(32_001) })).toBe(false);
    expect(isCompletionContract({ ...valid, criteria: [{ ...valid.criteria[0], source: "secret" }] })).toBe(false);
    const reviewed = applyCompletionReview(valid, {
      verdict: "pass",
      criteria: [{ id: "C1", status: "passed", evidence: "green" }],
    }, 1, "2026-08-29T00:01:00.000Z");
    const two = applyCompletionReview(createCompletionContract("Ship two", { criteria: [
      { requirement: "Tests pass", source: "repository", verification: "bun test" },
      { requirement: "CLI works", source: "runtime", verification: "run CLI" },
    ] }, "2026-08-29T00:00:00.000Z"), {
      verdict: "pass",
      criteria: [
        { id: "C1", status: "passed", evidence: "green" },
        { id: "C2", status: "passed", evidence: "works" },
      ],
    }, 1, "2026-08-29T00:01:00.000Z");
    expect(isCompletionContract({
      ...two,
      lastReview: { ...two.lastReview, evidence: [two.lastReview!.evidence[0], two.lastReview!.evidence[0]] },
    })).toBe(false);
    expect(isCompletionContract({
      ...reviewed,
      lastReview: {
        ...reviewed.lastReview,
        verdict: "pass",
        evidence: [{ criterionId: "C1", status: "unknown", evidence: "" }],
      },
    })).toBe(false);
  });
});
