/**
 * `neko bench` — a tiny built-in agentic-coding benchmark. Runs a handful of self-contained tasks
 * against the configured model (in-process, auto-approve, in a temp dir) and verifies each with a
 * deterministic check (no LLM judge). Reports pass@1 + tokens — so you can measure / compare models.
 * Model choice is the biggest quality lever; this makes that measurable instead of vibes.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { homeDir } from "../shared/home.ts";

import { Agent, DEFAULT_SYSTEM_PROMPT } from "../core/agent.ts";
import { ToolRegistry } from "../core/tool-runtime.ts";
import type { NekoConfig } from "./config.ts";
import { getProvider } from "./providers.ts";

interface BenchTask {
  id: string;
  files: Record<string, string>;
  prompt: string;
  verify: (dir: string) => boolean;
}

const read = (d: string, f: string) => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : null);
const lines = (s: string | null) => (s ?? "").replace(/\r/g, "").split("\n").map((x) => x.trim()).filter(Boolean);
function runJs(dir: string, file: string): { ok: boolean; out: string } {
  for (let a = 0; a < 3; a++) {
    try {
      return { ok: true, out: execFileSync("bun", [file], { cwd: dir, timeout: 30_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e: any) {
      if ((e.code === "ETIMEDOUT" || /ETIMEDOUT/.test(e.message ?? "")) && a < 2) continue; // transient cold-start
      return { ok: false, out: (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "") };
    }
  }
  return { ok: false, out: "" };
}

const TASKS: BenchTask[] = [
  {
    id: "fizzbuzz",
    files: {},
    prompt: "Create fizzbuzz.mjs (an ES module). When run it prints the numbers 1 to 100, each on its own line, except 'Fizz' for multiples of 3, 'Buzz' for multiples of 5, and 'FizzBuzz' for multiples of 15.",
    verify: (d) => { const r = runJs(d, "fizzbuzz.mjs"); const L = lines(r.out); return r.ok && L.length >= 100 && L[2] === "Fizz" && L[4] === "Buzz" && L[14] === "FizzBuzz" && L[99] === "Buzz"; },
  },
  {
    id: "bugfix",
    files: {
      "calc.mjs": "export function add(a, b) { return a - b; }\n",
      "test.mjs": "import assert from 'node:assert';\nimport { add } from './calc.mjs';\nassert.strictEqual(add(2, 3), 5);\nassert.strictEqual(add(-1, 1), 0);\nconsole.log('ok');\n",
    },
    prompt: "Running `bun test.mjs` fails an assertion. Fix the bug in calc.mjs so it passes. Do not modify test.mjs.",
    verify: (d) => runJs(d, "test.mjs").out.includes("ok") && (read(d, "test.mjs") ?? "").includes("strictEqual(add(2, 3), 5)"),
  },
  {
    id: "roman",
    files: {
      "roman.mjs": "export function toRoman(n) {\n  // TODO\n}\n",
      "rt.mjs": "import assert from 'node:assert';\nimport { toRoman } from './roman.mjs';\nfor (const [n, s] of [[4, 'IV'], [9, 'IX'], [58, 'LVIII'], [1994, 'MCMXCIV']]) assert.strictEqual(toRoman(n), s);\nconsole.log('ok');\n",
    },
    prompt: "Implement toRoman in roman.mjs so that `bun rt.mjs` passes all assertions. Do not modify rt.mjs.",
    verify: (d) => runJs(d, "rt.mjs").out.includes("ok"),
  },
  {
    id: "json-edit",
    files: { "pkg.json": '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n' },
    prompt: 'Edit pkg.json to add a top-level "license" field set to "MIT". Keep the existing "name" and "version" fields and keep it valid JSON.',
    verify: (d) => { try { const j = JSON.parse(read(d, "pkg.json") ?? ""); return j.name === "demo" && j.version === "1.0.0" && j.license === "MIT"; } catch { return false; } },
  },
  {
    // Needs a TOOL: the value is 50 rounds of modular squaring — impossible to compute by hand, so the raw
    // model must guess (fails) while the harness RUNS gen.mjs and copies the exact number (passes).
    id: "run-to-know",
    files: { "gen.mjs": "let x = 7n;\nfor (let i = 0; i < 50; i++) x = (x * x + 9n) % 1000000007n;\nconsole.log(x.toString());\n" },
    prompt: "Run `bun gen.mjs` — it prints one number. Create answer.txt whose entire content is that exact number.",
    verify: (d) => { const g = runJs(d, "gen.mjs"); const want = (g.out ?? "").trim(); const got = (read(d, "answer.txt") ?? "").trim(); return g.ok && want.length > 0 && got === want; },
  },
  // ---- harder tier (cross-file, state, algorithms, careful reading) ----
  {
    id: "two-file-bug",
    files: {
      "geometry.mjs": "export function area(w, h) {\n  return w + h;\n}\n",
      "app.mjs": "import { area } from './geometry.mjs';\nconsole.log(area(6, 7));\n",
    },
    prompt: "`bun app.mjs` should print the AREA of a 6x7 rectangle (42) but prints the wrong number. Fix the bug in geometry.mjs ONLY — do not edit app.mjs.",
    verify: (d) => runJs(d, "app.mjs").out.trim() === "42" && (read(d, "app.mjs") ?? "").includes("area(6, 7)"),
  },
  {
    id: "stateful-bug",
    files: {
      "counter.mjs": "export function makeCounter() {\n  let n = 0;\n  return { inc() { n + 1; return n; } };\n}\n",
      "ct.mjs": "import assert from 'node:assert';\nimport { makeCounter } from './counter.mjs';\nconst a = makeCounter();\nassert.strictEqual(a.inc(), 1);\nassert.strictEqual(a.inc(), 2);\nassert.strictEqual(a.inc(), 3);\nconst b = makeCounter();\nassert.strictEqual(b.inc(), 1);\nconsole.log('ok');\n",
    },
    prompt: "Fix the bug in makeCounter (counter.mjs) so `bun ct.mjs` passes — inc() must return 1, then 2, then 3, and a fresh counter is independent. Do not modify ct.mjs.",
    verify: (d) => runJs(d, "ct.mjs").out.includes("ok") && (read(d, "ct.mjs") ?? "").includes("a.inc(), 3"),
  },
  {
    id: "unique-sorted",
    files: { "uq.mjs": "import assert from 'node:assert';\nimport { uniqueSorted } from './unique.mjs';\nassert.deepStrictEqual(uniqueSorted([3,1,2,3,1]), [1,2,3]);\nassert.deepStrictEqual(uniqueSorted([]), []);\nassert.deepStrictEqual(uniqueSorted([-1,-1,0,5,5]), [-1,0,5]);\nconsole.log('ok');\n" },
    prompt: "Create unique.mjs exporting uniqueSorted(arr): return the array's DISTINCT numbers in ascending order. Make `bun uq.mjs` pass (do not modify uq.mjs).",
    verify: (d) => runJs(d, "uq.mjs").out.includes("ok"),
  },
  {
    id: "balanced-parens",
    files: { "bp.mjs": "import assert from 'node:assert';\nimport { isBalanced } from './paren.mjs';\nassert.strictEqual(isBalanced('([]{})'), true);\nassert.strictEqual(isBalanced('([)]'), false);\nassert.strictEqual(isBalanced('((('), false);\nassert.strictEqual(isBalanced(''), true);\nconsole.log('ok');\n" },
    prompt: "Create paren.mjs exporting isBalanced(s): true iff the brackets ()[]{} in s are correctly matched and nested. Make `bun bp.mjs` pass.",
    verify: (d) => runJs(d, "bp.mjs").out.includes("ok"),
  },
  {
    id: "csv-top",
    files: { "data.csv": "name,score\nAlice,80\nBob,95\nCara,70\n" },
    prompt: "Read data.csv (a header line, then name,score rows). Write top.txt whose ENTIRE content is the NAME with the highest score.",
    verify: (d) => (read(d, "top.txt") ?? "").trim() === "Bob",
  },
  {
    id: "careful-read",
    files: {},
    prompt: "Create out.txt whose content is the word 'banana' REVERSED and then UPPERCASED (the letters of 'banana' in reverse order, all capitals).",
    verify: (d) => (read(d, "out.txt") ?? "").trim() === "ANANAB",
  },
];

export interface BenchResult { id: string; passes: number; trials: number; tokens: number; inTok: number; outTok: number; calls: number; ms: number; }
export interface BenchReport { model: string; effort: string; trials: number; results: BenchResult[]; passed: number; total: number; tokens: number; inTok: number; outTok: number; calls: number; seconds: number; }

/** Run the benchmark against the configured model. Each task runs `trials` times (single-run pass@1
 * is noisy — reliability science), each in its own temp dir. */
export async function runBench(cfg: NekoConfig, opts: { trials?: number } = {}, onProgress?: (msg: string) => void): Promise<BenchReport> {
  const trials = Math.max(1, opts.trials ?? 1);
  const t0 = Date.now();
  const root = mkdtempSync(join(tmpdir(), "neko-bench-"));
  const results: BenchResult[] = [];
  try {
    for (const task of TASKS) {
      let passes = 0, tokens = 0, inTok = 0, outTok = 0, calls = 0, ms = 0;
      for (let t = 0; t < trials; t++) {
        const dir = join(root, `${task.id}-${t}`);
        mkdirSync(dir, { recursive: true });
        for (const [name, content] of Object.entries(task.files)) writeFileSync(join(dir, name), content);
        onProgress?.(`  ${task.id}${trials > 1 ? ` [${t + 1}/${trials}]` : ""} ...`);
        const registry = new ToolRegistry(dir, "auto", async () => true);
        const agent = new Agent({ provider: getProvider(cfg), tools: registry, maxSteps: cfg.maxSteps, systemPrompt: DEFAULT_SYSTEM_PROMPT });
        const tStart = Date.now();
        let pass = false, err = "";
        try { await agent.run(task.prompt); pass = task.verify(dir); } catch (e) { err = e instanceof Error ? e.message : String(e); }
        ms += Date.now() - tStart;
        if (pass) passes++;
        tokens += agent.cost.totalTokens; inTok += agent.cost.promptTokens; outTok += agent.cost.completionTokens; calls += agent.cost.calls;
        // Surface a thrown error (e.g. HTTP 401/timeout) — a swallowed exception used to read as a plain
        // "0/1 fail", which hid real problems (a bad key looked like the model failing).
        if (err) onProgress?.(`    ! ${task.id} ERRORED: ${err.replace(/\s+/g, " ").slice(0, 140)}`);
      }
      results.push({ id: task.id, passes, trials, tokens, inTok, outTok, calls, ms });
      const tps = ms > 0 ? Math.round((outTok / ms) * 1000) : 0;
      onProgress?.(`  ${task.id} -> ${passes}/${trials}  ${(ms / trials / 1000).toFixed(1)}s  ${tokens} tok (${outTok} out, ${tps} tok/s)  ${(calls / trials).toFixed(0)} calls`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const sum = (f: (r: BenchResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const report: BenchReport = {
    model: cfg.model, effort: cfg.effort || "off", trials, results,
    passed: sum((r) => r.passes), total: sum((r) => r.trials),
    tokens: sum((r) => r.tokens), inTok: sum((r) => r.inTok), outTok: sum((r) => r.outTok), calls: sum((r) => r.calls),
    seconds: (Date.now() - t0) / 1000,
  };
  appendBenchLog(report);
  return report;
}

/** Dev-log: append each bench run as one JSON line to ~/.neko-core/bench-log.jsonl, so self-improvement is
 * MEASURABLE over time — diff two runs to see if a harness change moved pass-rate, tokens, speed, or steps. */
function appendBenchLog(r: BenchReport): void {
  try {
    const dir = join(homeDir(), ".neko-core");
    mkdirSync(dir, { recursive: true });
    const rec = {
      ts: new Date().toISOString(), model: r.model, effort: r.effort, pass: r.passed, total: r.total,
      seconds: Math.round(r.seconds), tokens: r.tokens, inTok: r.inTok, outTok: r.outTok, calls: r.calls,
      tokPerSec: r.seconds > 0 ? Math.round(r.outTok / r.seconds) : 0,
      tasks: r.results.map((x) => ({ id: x.id, pass: x.passes, trials: x.trials, ms: x.ms, inTok: x.inTok, outTok: x.outTok, calls: x.calls })),
    };
    appendFileSync(join(dir, "bench-log.jsonl"), JSON.stringify(rec) + "\n", "utf8");
  } catch { /* a logging failure must never break the bench */ }
}

// ---- Harness-lift: the SAME tasks run RAW (model only, no tools/loop) vs +NEKO (tools + agentic loop).
// The thesis made measurable: Neko's edge is the HARNESS turning a given model into a capable agent. ----
export interface LiftRow { id: string; raw: boolean; harness: boolean; }
export interface LiftReport { model: string; rows: LiftRow[]; rawPass: number; harnessPass: number; total: number; seconds: number; }

/** Pull ```filename\n...``` fenced blocks out of a raw model reply (it has no tools, so it must emit files). */
function parseFileBlocks(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = (m[1] || "").trim().split(/\s+/).pop() ?? "";
    if (name && name.includes(".")) out[name] = m[2];
  }
  return out;
}

async function runRawTask(cfg: NekoConfig, task: BenchTask, dir: string): Promise<boolean> {
  for (const [n, c] of Object.entries(task.files)) writeFileSync(join(dir, n), c); // seed inputs (also so unchanged-file checks hold)
  const filesBlock = Object.keys(task.files).length
    ? "Existing files:\n" + Object.entries(task.files).map(([n, c]) => `--- ${n} ---\n${c}`).join("\n\n") + "\n\n"
    : "";
  const prompt = `${task.prompt}\n\n${filesBlock}You have NO tools and cannot run code. Reply with the FULL final content of EACH file that should exist after the task, each in its own fenced block whose info-string is the exact filename, e.g.\n\`\`\`name.ext\n...content...\n\`\`\`\nOutput ONLY the file blocks, nothing else.`;
  const res = await getProvider(cfg).complete([{ role: "user", content: prompt }]);
  for (const [n, c] of Object.entries(parseFileBlocks(res.content ?? ""))) { try { writeFileSync(join(dir, n), c); } catch {} }
  try { return task.verify(dir); } catch { return false; }
}

/** Run each task twice — raw model vs full Neko harness — and report the lift. */
export async function runHarnessLift(cfg: NekoConfig, onProgress?: (msg: string) => void): Promise<LiftReport> {
  const t0 = Date.now();
  const root = mkdtempSync(join(tmpdir(), "neko-lift-"));
  const rows: LiftRow[] = [];
  try {
    for (const task of TASKS) {
      const rdir = join(root, `${task.id}-raw`); mkdirSync(rdir, { recursive: true });
      onProgress?.(`  ${task.id}: raw ...`);
      let raw = false; try { raw = await runRawTask(cfg, task, rdir); } catch { raw = false; }
      const hdir = join(root, `${task.id}-harness`); mkdirSync(hdir, { recursive: true });
      for (const [n, c] of Object.entries(task.files)) writeFileSync(join(hdir, n), c);
      onProgress?.(`  ${task.id}: +neko ...`);
      const reg = new ToolRegistry(hdir, "auto", async () => true);
      const agent = new Agent({ provider: getProvider(cfg), tools: reg, maxSteps: cfg.maxSteps, systemPrompt: DEFAULT_SYSTEM_PROMPT });
      let harness = false; try { await agent.run(task.prompt); harness = task.verify(hdir); } catch { harness = false; }
      rows.push({ id: task.id, raw, harness });
      onProgress?.(`  ${task.id} -> raw ${raw ? "PASS" : "fail"} | +neko ${harness ? "PASS" : "fail"}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { model: cfg.model, rows, rawPass: rows.filter((r) => r.raw).length, harnessPass: rows.filter((r) => r.harness).length, total: rows.length, seconds: (Date.now() - t0) / 1000 };
}

export function renderLiftReport(r: LiftReport): string {
  const rows = r.rows.map((x) => `  ${x.id.padEnd(12)}  raw ${x.raw ? "PASS" : "----"}    +neko ${x.harness ? "PASS" : "----"}`).join("\n");
  const rp = r.total ? Math.round((r.rawPass / r.total) * 100) : 0;
  const hp = r.total ? Math.round((r.harnessPass / r.total) * 100) : 0;
  return `Harness-lift :: ${r.model}\n${rows}\n  ----------------------------------\n  RAW model alone:  ${r.rawPass}/${r.total} (${rp}%)\n  + NEKO harness:   ${r.harnessPass}/${r.total} (${hp}%)\n  LIFT: +${r.harnessPass - r.rawPass} task(s)  (+${hp - rp} pts)   ${r.seconds.toFixed(0)}s`;
}

export function renderBenchReport(r: BenchReport): string {
  const rows = r.results.map((x) => {
    const tag = x.passes === x.trials ? "PASS " : x.passes === 0 ? "FAIL " : "FLAKY";
    const s = (x.ms / x.trials / 1000).toFixed(1);
    const tps = x.ms > 0 ? Math.round((x.outTok / x.ms) * 1000) : 0;
    return `  ${tag}  ${x.id.padEnd(14)} ${x.passes}/${x.trials}  ${s.padStart(5)}s  ${String(x.tokens).padStart(6)} tok  ${String(tps).padStart(4)} tok/s  ${String(Math.round(x.calls / x.trials)).padStart(2)} steps`;
  }).join("\n");
  const pct = r.total ? Math.round((r.passed / r.total) * 100) : 0;
  const tps = r.seconds > 0 ? Math.round(r.outTok / r.seconds) : 0;
  return `Neko-bench :: ${r.model} (effort ${r.effort}, ${r.trials} trial${r.trials > 1 ? "s" : ""}/task)\n${rows}\n  --------------------------------------------------------------\n  pass@1: ${r.passed}/${r.total} (${pct}%)   ${r.tokens} tok (in ${r.inTok}/out ${r.outTok})   ${tps} tok/s   ${r.calls} steps   ${r.seconds.toFixed(0)}s\n  (metrics appended to ~/.neko-core/bench-log.jsonl)`;
}
