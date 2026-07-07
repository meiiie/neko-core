// Benchmark current search/glob/read implementations on this codebase.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const N = 20;

function median(a) { a.sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function p95(a) { a.sort((x, y) => x - y); return a[Math.floor(a.length * 0.95)]; }
function ms(f, n) { const out = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); out.push(performance.now() - t); } return out; }
function fmt(a) { return `median=${median(a).toFixed(2)}ms p95=${p95(a).toFixed(2)}ms min=${Math.min(...a).toFixed(2)}ms`; }

function countFiles(dir) {
  let n = 0, bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist", ".bun", "target"].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { n++; try { bytes += statSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return { files: n, bytes };
}

const { files, bytes } = countFiles(ROOT);
console.log(`Tree: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB (excluding node_modules/.git/dist)\n`);

const rg = Bun.which("rg");
if (rg) {
  const t = ms(() => spawnSync(rg, ["--line-number", "--no-heading", "--color=never", "--max-count=2000", "--", "function", "src"], { encoding: "utf-8" }), N);
  console.log(`[SEARCH] ripgrep spawnSync "function" in src/: ${fmt(t)}`);
} else {
  console.log(`[SEARCH] ripgrep NOT in PATH`);
}

const IGNORE = new Set(["node_modules", ".git", "dist", ".bun", "target"]);
function* walkFiles(base) {
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const p = join(base, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else yield p;
  }
}
const t2 = ms(() => {
  const regex = /function/;
  let count = 0;
  for (const f of walkFiles("src")) { try { const t = readFileSync(f, "utf-8"); for (const l of t.split("\n")) if (regex.test(l)) count++; } catch {} }
}, 5);
console.log(`[SEARCH] JS walk "function" in src/ (fallback): ${fmt(t2)}`);

const t3 = ms(() => { const g = new Bun.Glob("**/*.ts"); let n = 0; for (const _ of g.scanSync({ cwd: ROOT, onlyFiles: true })) n++; }, N);
console.log(`[GLOB]   Bun.Glob "**/*.ts": ${fmt(t3)}`);

function largestTs(dir) {
  let best = null, bestSize = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist"].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) { const s = statSync(p).size; if (s > bestSize) { bestSize = s; best = p; } }
    }
  };
  walk(dir); return best;
}
const big = largestTs("src");
console.log(`\n[READ]   largest src .ts: ${big} (${(statSync(big).size / 1024).toFixed(1)} KB)`);
const t4 = ms(() => readFileSync(big, "utf-8"), N);
console.log(`[READ]   readFileSync whole file: ${fmt(t4)}`);
const t5 = ms(() => { const s = statSync(big).size; const b = Buffer.alloc(Math.min(s, 100000 * 4)); const fd = openSync(big, "r"); readSync(fd, b, 0, b.length, 0); closeSync(fd); }, N);
console.log(`[READ]   partial read (100k cap): ${fmt(t5)}`);
