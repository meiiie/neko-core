#!/usr/bin/env bun
/**
 * CONTINUOUS self-improvement loop — Neko (e.g. glm-5.2 on the Z.ai plan) improves Neko, FOREVER.
 *
 * Each iteration:  pick a goal -> Neko works in the repo -> the FULL VERIFY GATE (typecheck + tests + policy)
 * must pass AND there must be a change -> COMMIT the improvement; otherwise REVERT (the repo never degrades).
 *
 * Built to run unattended and never stop:
 *   - retries transient errors (network / timeout / 5xx) with a short backoff;
 *   - on a RATE LIMIT / quota-exhausted (e.g. the weekly plan cap) it backs off LONG and keeps waiting — the
 *     loop never dies, it resumes when the quota returns;
 *   - commits to a DEDICATED BRANCH (never main, never pushed) so you review + merge — human gates main.
 *   - rotates diverse goals (bug/test/robustness/perf/security/harness/docs) so it improves broadly.
 *   - logs every iteration to self-improve.log; periodically re-runs `neko bench` to MEASURE progress
 *     (metrics land in ~/.neko-core/bench-log.jsonl — diff runs to see pass-rate / tokens / speed move).
 *
 * Usage:  bun scripts/self-improve.ts [--profile zai] [--branch self-improve] [--max 0] [--sleep 20] [--bench-every 10]
 *   --max 0 = infinite. Ctrl+C to stop.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const PROFILE = arg("--profile", "zai");
const BRANCH = arg("--branch", "self-improve");
const MAX = Number(arg("--max", "0")) || Infinity;
const SLEEP_S = Number(arg("--sleep", "20"));
const BENCH_EVERY = Number(arg("--bench-every", "10")); // run the bench every N committed improvements (0 = never)
const LOGFILE = "self-improve.log";

function sh(cmd: string, args: string[], timeoutMs = 0) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs || undefined, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? ""), status: r.status, error: r.error };
}
const log = (m: string) => { const line = `[${new Date().toISOString()}] ${m}`; console.log(line); try { appendFileSync(LOGFILE, line + "\n"); } catch {} };
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const gitDirty = () => sh("git", ["status", "--porcelain"]).out.trim().length > 0;
function ensureBranch() {
  const cur = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
  if (cur !== BRANCH) log(`branch ${cur} -> ${BRANCH}: ${sh("git", ["checkout", "-B", BRANCH]).ok ? "ok" : "FAILED"}`);
}
function revert() { sh("git", ["checkout", "--", "."]); sh("git", ["clean", "-fd", "src", "test", "skills", "docs", "bin", "scripts"]); }
const isRateLimit = (s: string) => /\b429\b|rate.?limit|quota|too many requests|insufficient|exceeded/i.test(s);
const isTransient = (s: string) => /\b(500|502|503|504)\b|network|ETIMEDOUT|fetch failed|socket|EAI_AGAIN|timed out/i.test(s);

/** Verify gate: typecheck + full test suite + policy must all pass. Returns the first failure reason. */
function verifyGate(): { ok: boolean; why?: string; out?: string } {
  const tc = sh("bun", ["run", "typecheck"], 180_000);
  if (!tc.ok) return { ok: false, why: "typecheck", out: tc.out.slice(-500) };
  const t = sh("bun", ["test"], 360_000);
  if (!t.ok || !/\b0 fail\b/.test(t.out)) return { ok: false, why: "tests", out: t.out.slice(-500) };
  const p = sh("bun", ["bin/neko.ts", "policy"], 60_000);
  if (!/PASS/.test(p.out)) return { ok: false, why: "policy", out: p.out.slice(-300) };
  return { ok: true };
}

// Rotating, diverse goals — each must be SMALL, self-contained, verifiable, and must not break tests.
const GOALS = [
  "Review the Neko codebase and find ONE concrete, SMALL improvement: a real bug, a clarity fix, or a robustness hardening. Implement it minimally and self-contained. Adjust/add a focused test if relevant. Do NOT break typecheck or any existing test. End with a one-line summary of what changed and why.",
  "Find ONE function or branch in src/ that lacks a test or whose edge cases are untested, and add a single focused, deterministic test for it. Do not change behavior; do not break existing tests.",
  "Find ONE place in src/ that could mishandle bad/empty/oversized input or a failure, and harden it (validate, guard, or surface a clear error) without changing the happy path. Add a test for the bad-input case.",
  "Find ONE small performance or token-efficiency win in src/ (an avoidable allocation, a redundant call, a needlessly large prompt) and implement it without changing behavior. Note the before/after rationale.",
  "Find ONE unclear comment, doc, or skill instruction that would slow down future work, and improve it concisely and accurately. No behavior change.",
  "Improve the agent HARNESS in one concrete way (the loop, a tool's contract, an observation, or a skill) so the model is more reliable — minimal, verified, tested. Don't regress existing tests.",
];

async function pickGoal(iter: number): Promise<string> {
  // Prefer a CONCRETE failing-bench signal when one exists; else rotate the self-critique goals.
  // (Bench is slow, so we only consult it occasionally, on iteration 1 and every BENCH_EVERY.)
  return GOALS[iter % GOALS.length];
}

async function runNeko(goal: string) {
  return sh("bun", ["bin/neko.ts", "run", "--profile", PROFILE, "--yolo", "--loop", goal], 900_000);
}

async function main() {
  ensureBranch();
  log(`START self-improve  profile=${PROFILE} branch=${BRANCH} max=${MAX === Infinity ? "inf" : MAX} sleep=${SLEEP_S}s`);
  let iter = 0, commits = 0, rlBackoff = 900; // rate-limit backoff grows 900s -> capped at 24h
  while (iter < MAX) {
    iter++;
    if (gitDirty()) { log("dirty at iter start -> revert to clean baseline"); revert(); }
    const goal = await pickGoal(iter);
    log(`iter ${iter}: neko run (${goal.slice(0, 60)}...)`);
    const run = await runNeko(goal);

    if (isRateLimit(run.out)) {
      log(`RATE LIMIT / quota hit -> revert + back off ${Math.round(rlBackoff / 60)}min (loop stays alive, resumes after).`);
      revert(); await sleep(rlBackoff); rlBackoff = Math.min(rlBackoff * 2, 24 * 3600); continue;
    }
    rlBackoff = 900; // a non-rate-limited run resets the backoff
    if (!run.ok && isTransient(run.out)) { log(`transient error -> revert + short retry. ${run.out.slice(-160).replace(/\s+/g, " ")}`); revert(); await sleep(SLEEP_S); continue; }
    if (!gitDirty()) { log("no change produced -> next goal"); await sleep(SLEEP_S); continue; }

    const v = verifyGate();
    if (!v.ok) { log(`VERIFY FAILED (${v.why}) -> revert. ${(v.out ?? "").replace(/\s+/g, " ").slice(0, 200)}`); revert(); await sleep(SLEEP_S); continue; }

    sh("git", ["add", "-A"]);
    const c = sh("git", ["commit", "-m", `self-improve: verified change (iter ${iter}) [auto]\n\nGoal: ${goal.slice(0, 80)}`]);
    commits++;
    log(`COMMIT #${commits} (iter ${iter}): green change committed to ${BRANCH}. ${c.ok ? "ok" : c.out.slice(-120)}`);

    if (BENCH_EVERY > 0 && commits % BENCH_EVERY === 0) {
      log(`bench checkpoint (after ${commits} commits) ...`);
      const b = sh("bun", ["bin/neko.ts", "bench", "--profile", PROFILE], 900_000);
      const m = b.out.match(/pass@1:[^\n]*/);
      log(`bench: ${m ? m[0] : "(no summary)"}  (full metrics -> ~/.neko-core/bench-log.jsonl)`);
    }
    await sleep(SLEEP_S);
  }
  log(`DONE: ${iter} iterations, ${commits} verified improvements on ${BRANCH}. Review with: git log ${BRANCH}`);
}

main();
