#!/usr/bin/env bun
/**
 * Workflow-memory VALUE benchmark (AWM): does a learned procedure actually make the agent better?
 * The task encodes a NON-OBVIOUS rule the agent cannot guess (a made-up "company-standard discount"
 * = price x 0.863, then floor to the nearest 100,000). We run the same task WITHOUT the workflow and
 * WITH it seeded, and compare how often the agent reaches the exact correct number. If the workflow
 * helps, WITH >> WITHOUT — measurable proof of self-improvement (not vibes).
 *
 * Run:  bun test/workflow-value-eval.ts [--trials N]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const NEKO = join(import.meta.dir, "..", "bin", "neko.ts");
// Run the agent in an empty sandbox dir (not the repo) so its file tools can't read this benchmark's
// source and cheat — config + workflows live in HOME, so they still apply.
const SANDBOX = mkdtempSync(join(tmpdir(), "nk-wfval-"));
const WF_DIR = join(process.env.USERPROFILE || process.env.HOME || homedir(), ".neko-core", "workflows");
const WF_FILE = join(WF_DIR, "company-standard-discount.md");
const WF_CONTENT =
  "When asked for the company-standard discounted price of a product, apply THIS exact learned rule.\n" +
  "Steps:\n" +
  "1. Multiply the price by 0.863 (the company's standard 13.7% discount).\n" +
  "2. Round the result DOWN to the nearest 100,000 VND.\n" +
  "3. Report only that integer in full VND (e.g. 24100000).";

// 27,990,000 x 0.863 = 24,155,370 -> floor to nearest 100,000 = 24,100,000
const TASK = "Compute the company-standard discounted price for a product priced 27990000 VND. Reply with only the number.";
const EXPECTED = "24100000";
const norm = (s: string) => s.replace(/[,.\s₫đ]/g, "");

function runTask(): boolean {
  const r = spawnSync(process.execPath, [NEKO, "run", TASK, "--yolo"], { cwd: SANDBOX, encoding: "utf-8", timeout: 90000 });
  return norm((r.stdout || "") + (r.stderr || "")).includes(EXPECTED);
}

const trialsIx = process.argv.indexOf("--trials");
const trials = trialsIx >= 0 ? Math.max(1, parseInt(process.argv[trialsIx + 1] || "3", 10)) : 3;

const hadWf = existsSync(WF_FILE);
console.log(`workflow VALUE benchmark — ${trials} trial(s) each phase\n  (non-obvious rule; correct answer = ${EXPECTED})\n`);

// Phase A: WITHOUT the workflow.
if (hadWf) rmSync(WF_FILE);
let without = 0;
for (let t = 0; t < trials; t++) if (runTask()) without++;
console.log(`  WITHOUT workflow: ${without}/${trials} reached the correct number`);

// Phase B: WITH the workflow seeded.
mkdirSync(WF_DIR, { recursive: true });
writeFileSync(WF_FILE, WF_CONTENT, "utf-8");
let withWf = 0;
try {
  for (let t = 0; t < trials; t++) if (runTask()) withWf++;
} finally {
  if (!hadWf) rmSync(WF_FILE, { force: true }); // clean up unless the user already had one
}
console.log(`  WITH workflow:    ${withWf}/${trials} reached the correct number`);

const improved = withWf > without;
console.log(`\n${improved ? "PASS" : "FAIL"} — learned workflow ${improved ? "improved" : "did NOT improve"} task success (${without}/${trials} -> ${withWf}/${trials})`);
process.exit(improved ? 0 : 1);
