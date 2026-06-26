#!/usr/bin/env bun
/**
 * ACE VALUE benchmark — does the always-on playbook actually let the agent LEARN then REUSE, across
 * separate runs? A non-obvious rule (company discount = price x0.863, floor to nearest 100k):
 *   - BASELINE: with an empty playbook, ask task 2 (rule not given) -> the agent can't know it.
 *   - LEARN:    fresh, run task 1 (rule given) telling it to `playbook add` the rule.
 *   - REUSE:    run task 2 again (rule NOT given) -> the learned playbook bullet (always in context)
 *               should let it apply the rule. If REUSE >> BASELINE, the self-improving loop works.
 *
 * Run:  bun test/ace-value-eval.ts [--trials N]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const NEKO = join(import.meta.dir, "..", "bin", "neko.ts");
const PB = join(process.env.USERPROFILE || process.env.HOME || homedir(), ".neko-core", "playbook.md");
// Run the agent in an EMPTY sandbox dir (not the repo) so its file tools can't read this benchmark's
// source and cheat — config + playbook live in HOME, so they still apply; only the cwd-scoped tools change.
const SANDBOX = mkdtempSync(join(tmpdir(), "nk-ace-"));

// An ARBITRARY fixed-constant rule (not a guessable % discount) so the answer is unreachable without it.
const RULE = "the company-standard price = take the listed price and subtract EXACTLY 3,141,592 VND (a fixed internal company adjustment), then report that integer";
// task 1: rule GIVEN. 27,990,000 - 3,141,592 = 24,848,408.
const TASK1 = `Apply this rule to a listed price of 27990000 and reply with the number: ${RULE}. ALSO save this exact rule to your playbook with \`playbook add\` so you can reuse it next time.`;
// task 2: rule NOT given. 19,990,000 - 3,141,592 = 16,848,408 (unguessable without the rule).
const TASK2 = "Compute the company-standard price for a product with a listed price of 19990000 VND. Reply with only the number.";
const T2_ANSWER = "16848408";
const norm = (s: string) => s.replace(/[,.\s₫đ]/g, "");

function run(task: string): string {
  const r = spawnSync(process.execPath, [NEKO, "run", task, "--yolo"], { cwd: SANDBOX, encoding: "utf-8", timeout: 90000 });
  return (r.stdout || "") + (r.stderr || "");
}
const setPlaybook = (text: string) => { mkdirSync(join(PB, ".."), { recursive: true }); writeFileSync(PB, text, "utf-8"); };
const clearPlaybook = () => { try { rmSync(PB); } catch { /* none */ } };

const trialsIx = process.argv.indexOf("--trials");
const trials = trialsIx >= 0 ? Math.max(1, parseInt(process.argv[trialsIx + 1] || "3", 10)) : 3;
const backup = existsSync(PB) ? readFileSync(PB, "utf-8") : null;
console.log(`ACE value benchmark — ${trials} trial(s)\n  (task 2 correct answer = ${T2_ANSWER}; rule never given in task 2)\n`);

try {
  // BASELINE: empty playbook, task 2 cold.
  let baseline = 0;
  for (let t = 0; t < trials; t++) { clearPlaybook(); if (norm(run(TASK2)).includes(T2_ANSWER)) baseline++; }
  console.log(`  BASELINE (empty playbook):     ${baseline}/${trials} solved task 2`);

  // LEARN: fresh, run task 1 so the agent writes the rule to its playbook.
  clearPlaybook();
  run(TASK1);
  const learned = existsSync(PB) && /3[,. ]?141[,. ]?592|subtract/i.test(readFileSync(PB, "utf-8"));
  console.log(`  LEARN (task 1 -> playbook):    ${learned ? "rule captured in playbook" : "NOT captured"}`);

  // REUSE: task 2 with the learned playbook in context (do NOT clear it between trials).
  let reuse = 0;
  for (let t = 0; t < trials; t++) if (norm(run(TASK2)).includes(T2_ANSWER)) reuse++;
  console.log(`  REUSE (learned playbook on):   ${reuse}/${trials} solved task 2`);

  const improved = reuse > baseline;
  console.log(`\n${improved ? "PASS" : "FAIL"} — the always-on playbook ${improved ? "let the agent learn then reuse" : "did NOT help"} (baseline ${baseline}/${trials} -> reuse ${reuse}/${trials})`);
  process.exitCode = improved ? 0 : 1;
} finally {
  if (backup !== null) setPlaybook(backup);
  else clearPlaybook();
}
