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
import { appendFileSync, existsSync, readFileSync } from "node:fs";

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
  if (cur === BRANCH) return;
  // CONTINUE the existing branch across re-launches (never `-B`, which would RESET it and discard every
  // improvement committed in prior segments). Create it only if it doesn't exist yet.
  const exists = sh("git", ["rev-parse", "--verify", "--quiet", BRANCH]).ok;
  const r = exists ? sh("git", ["checkout", BRANCH]) : sh("git", ["checkout", "-b", BRANCH]);
  log(`branch ${cur} -> ${BRANCH} (${exists ? "continue" : "new"}): ${r.ok ? "ok" : "FAILED " + r.out.slice(-120)}`);
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

const STUCK_AFTER = Number(arg("--stuck-after", "3")); // research pass after this many no-improvement rounds
const REVIEW_PROFILE = arg("--review-profile", "nvidia"); // a DIFFERENT model peer-reviews the diff (independence)
const PEER_REVIEW = arg("--no-review", "") !== "true"; // anti-drift gate, on by default

/** A second, INDEPENDENT model reviews the staged diff: "is this a real, safe improvement?" — the DGM
 *  peer-review idea, the guard against drift (changes that pass tests but aren't actually better). */
function peerReview(): { approve: boolean; verdict: string } {
  const diff = sh("git", ["diff", "--cached"]).out;
  if (!diff.trim()) return { approve: false, verdict: "empty diff" };
  // Dedicated reviewer script: it reads the staged diff itself (no CLI-length limit) with a clean reviewer
  // system prompt (no coding-agent confusion). Replaces routing review through `neko run`, which on Windows
  // both asked for the diff (agent prompt) and blew the command-line limit (big diff as an arg).
  const r = sh("bun", ["scripts/review-diff.ts", "--profile", REVIEW_PROFILE], 300_000);
  const verdicts = [...r.out.matchAll(/VERDICT:\s*(APPROVE|REJECT)/gi)].map((m) => m[1].toUpperCase());
  const last = verdicts[verdicts.length - 1];
  // The decisive VERDICT line wins; else a clear single-word signal; else REJECT (anti-drift: only keep a
  // change a reviewer clearly endorses).
  const approve = last ? last === "APPROVE" : (/\bAPPROVE\b/i.test(r.out) && !/\bREJECT\b/i.test(r.out));
  return { approve, verdict: (r.out.replace(/\s+/g, " ").trim().slice(0, 180)) || "(no output)" };
}
const PREAMBLE =
  "Do NOT run git yourself (no git add / commit / checkout / reset / branch / stash) and do NOT push — leave " +
  "your change UNCOMMITTED in the working tree; the harness verifies it, has an independent model review it, " +
  "and commits it for you. Running git yourself bypasses that safety gate.\n" +
  "FIRST read docs/self-improve/STATE.md, BACKLOG.md and HARNESS.md to orient (what you are, where you are, " +
  "the levers). THEN do the task below. Keep the change SMALL, self-contained, and VERIFIABLE; do NOT break " +
  "typecheck or any existing test (the change is auto-reverted if you do). After, append ONE line to the " +
  "'## Last moves' section of docs/self-improve/STATE.md noting what you changed and why.\n\nTASK: ";

// Rotating self-critique goals (the fallback engine when the backlog is empty) — each small + verifiable.
const GOALS = [
  "Find ONE concrete improvement in src/: a real bug, a clarity fix, or a robustness hardening. Implement it, add/adjust a focused test if relevant.",
  "Find ONE function/branch in src/ that lacks a test or whose edge cases are untested, and add a single focused deterministic test. Do not change behavior.",
  "Find ONE place in src/ that could mishandle bad/empty/oversized input or a failure, and harden it (validate/guard/clear error) without changing the happy path. Add a bad-input test.",
  "Find ONE token-efficiency win in src/ (a needlessly large prompt/schema, a redundant observation) and implement it without changing behavior. Measure with `neko bench` if useful.",
  "Improve the agent HARNESS in one concrete way (the loop, a tool contract, an observation, compaction, or a skill) per docs/self-improve/HARNESS.md — minimal, verified, tested.",
];
// When STUCK (no improvement for STUCK_AFTER rounds), Neko self-researches the latest SOTA and refills the backlog.
const GOAL_RESEARCH =
  "RESEARCH PASS (no src/ changes this round). The improvement backlog is running dry — go find fresh ideas. " +
  "Use web_search to survey the LATEST SOTA on LLM-agent token efficiency, context engineering, harness/scaffold " +
  "design, and self-improving agents (read titles + abstracts of recent papers). Pick 3 concrete, VERIFIABLE " +
  "improvements for Neko (each: what to change + how the bench/tests prove it helped) and APPEND them as `- [ ] ` " +
  "items under '## Research-seeded' in docs/self-improve/BACKLOG.md. Note the key papers (title + link + 1-line " +
  "Neko mapping) in docs/self-improve/RESEARCH.md. Do not edit src/ — this round is research + backlog only.";

/** First unchecked `- [ ] ` item from the backlog (the loop's preferred concrete goal), or "" if none. */
function backlogGoal(): string {
  try {
    const p = "docs/self-improve/BACKLOG.md";
    if (!existsSync(p)) return "";
    const m = readFileSync(p, "utf8").split("\n").find((l) => /^\s*-\s*\[ \]\s+/.test(l));
    return m ? m.replace(/^\s*-\s*\[ \]\s+/, "").trim() : "";
  } catch { return ""; }
}

function pickGoal(iter: number, stuck: boolean): string {
  if (stuck) return GOAL_RESEARCH; // out of ideas -> self-research SOTA, refill the backlog
  const b = backlogGoal();
  if (b) return PREAMBLE + "Implement this backlog item, then mark it [x] in docs/self-improve/BACKLOG.md with the commit rationale: " + b;
  return PREAMBLE + GOALS[iter % GOALS.length];
}

async function runNeko(goal: string) {
  return sh("bun", ["bin/neko.ts", "run", "--profile", PROFILE, "--yolo", "--loop", goal], 900_000);
}

async function main() {
  ensureBranch();
  log(`START self-improve  profile=${PROFILE} branch=${BRANCH} max=${MAX === Infinity ? "inf" : MAX} sleep=${SLEEP_S}s`);
  let iter = 0, commits = 0, noImprove = 0, rlBackoff = 900; // rate-limit backoff grows 900s -> capped at 24h
  while (iter < MAX) {
    iter++;
    if (gitDirty()) { log("dirty at iter start -> revert to clean baseline"); revert(); }
    const stuck = noImprove >= STUCK_AFTER;
    const goal = pickGoal(iter, stuck);
    log(`iter ${iter}${stuck ? " [STUCK -> self-research SOTA]" : ""}: neko run (${goal.slice(0, 70)}...)`);
    const headBefore = sh("git", ["rev-parse", "HEAD"]).out.trim();
    const run = await runNeko(goal);

    if (isRateLimit(run.out)) {
      log(`RATE LIMIT / quota hit -> revert + back off ${Math.round(rlBackoff / 60)}min (loop stays alive, resumes after).`);
      revert(); await sleep(rlBackoff); rlBackoff = Math.min(rlBackoff * 2, 24 * 3600); continue;
    }
    rlBackoff = 900; // a non-rate-limited run resets the backoff
    if (!run.ok && isTransient(run.out)) { log(`transient error -> revert + short retry. ${run.out.slice(-160).replace(/\s+/g, " ")}`); revert(); await sleep(SLEEP_S); continue; }
    // Enforce the no-self-commit rule: if the worker committed anyway, un-commit (keep the changes in the
    // tree) so the verify+review gate still processes them instead of them sneaking in ungated.
    const headAfter = sh("git", ["rev-parse", "HEAD"]).out.trim();
    if (headBefore && headAfter !== headBefore) { log("worker self-committed -> un-committing so the gate applies"); sh("git", ["reset", headBefore]); }
    if (!gitDirty()) { log("no change produced -> next goal"); noImprove++; await sleep(SLEEP_S); continue; }

    const v = verifyGate();
    if (!v.ok) { log(`VERIFY FAILED (${v.why}) -> revert. ${(v.out ?? "").replace(/\s+/g, " ").slice(0, 200)}`); revert(); noImprove++; await sleep(SLEEP_S); continue; }

    sh("git", ["add", "-A"]);
    // Anti-drift: an INDEPENDENT model must agree the change is a real improvement (skip for the research
    // pass, which only refills the backlog/docs — there's no code change to review).
    if (PEER_REVIEW && !stuck) {
      const pr = peerReview();
      if (!pr.approve) { log(`PEER-REVIEW REJECTED -> revert (passed tests but not a real improvement). ${pr.verdict.slice(0, 120)}`); sh("git", ["reset", "-q"]); revert(); noImprove++; await sleep(SLEEP_S); continue; }
      log(`peer-review APPROVED. ${pr.verdict.slice(0, 100)}`);
    }
    const c = sh("git", ["commit", "-m", `self-improve: verified change (iter ${iter}) [auto]\n\nGoal: ${goal.slice(0, 80)}`]);
    commits++; noImprove = 0; // a green commit = real progress; resets the stuck counter
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
