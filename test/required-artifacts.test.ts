import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractMentionedVerifierCommands,
  extractRequiredArtifactPaths,
  failureTracePracticeGuidance,
  missingRequiredArtifacts,
} from "../src/core/required-artifacts.ts";

describe("required artifact extraction (rule-based, task-id-free)", () => {
  test("extracts create/write paths under /app without baking task ids", () => {
    const instruction = [
      "Write a JSON file called /app/re.json that lists [regex, replacement] pairs.",
      "Also create /app/polyglot/main.rs as a polyglot source file.",
      "Look at the provided /app/check.py helper if useful.",
    ].join("\n");
    const paths = extractRequiredArtifactPaths(instruction);
    expect(paths).toContain("/app/re.json");
    expect(paths).toContain("/app/polyglot/main.rs");
    expect(paths.some((p) => p.endsWith("check.py"))).toBe(false);
  });

  test("extracts curl/redirect deliverables like hello.html", () => {
    const instruction = [
      'echo "hello world" > hello.html',
      "git add hello.html && git commit && git push",
      "curl http://server:8080/hello.html",
    ].join("\n");
    const paths = extractRequiredArtifactPaths(instruction);
    expect(paths.some((p) => p.endsWith("hello.html"))).toBe(true);
  });

  test("missingRequiredArtifacts reports absent and empty files", () => {
    const root = mkdtempSync(join(tmpdir(), "neko-artifacts-"));
    try {
      const instruction = "Write re.json with the regex list and create data.comp.";
      writeFileSync(join(root, "re.json"), "");
      const rows = missingRequiredArtifacts(root, instruction, { requireNonEmpty: true });
      expect(rows.some((m) => m.path.endsWith("re.json") && m.reason === "empty")).toBe(true);
      expect(rows.some((m) => m.path.endsWith("data.comp") && m.reason === "missing")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("failureTracePracticeGuidance fires only for deliverable-shaped prompts", () => {
    expect(failureTracePracticeGuidance("say hello")).toBe("");
    const tip = failureTracePracticeGuidance(
      "Write /app/gates.txt then verify with /app/sim 208 and check.py",
    );
    expect(tip).toContain("Completion verification practice");
    expect(tip).toContain("/app/gates.txt");
    expect(extractMentionedVerifierCommands("run check.py and /app/sim 208").length).toBeGreaterThan(0);
  });
});
