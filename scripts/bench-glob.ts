// Deeper benchmark: is Bun.Glob slow because it scans node_modules before filtering?
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const N = 20;
const median = (a) => { a.sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const p95 = (a) => { a.sort((x, y) => x - y); return a[Math.floor(a.length * 0.95)]; };
const ms = (f, n) => { const o = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); o.push(performance.now() - t); } return o; };
const fmt = (a) => `median=${median(a).toFixed(2)}ms p95=${p95(a).toFixed(2)}ms min=${Math.min(...a).toFixed(2)}ms`;

// How big is node_modules?
let nmFiles = 0, nmBytes = 0;
try { const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name === ".git") continue; walk(p); } else { nmFiles++; try { nmBytes += statSync(p).size; } catch {} } } }; walk(join(ROOT, "node_modules")); } catch {}
console.log(`node_modules: ${nmFiles} files, ${(nmBytes / 1024 / 1024).toFixed(1)} MB\n`);

// Bun.Glob WITH ignore
const t1 = ms(() => { const g = new Bun.Glob("**/*.ts"); let n = 0; for (const _ of g.scanSync({ cwd: ROOT, onlyFiles: true })) n++; }, N);
console.log(`[GLOB] Bun.Glob "**/*.ts" (default, scans node_modules): ${fmt(t1)}`);

// Custom walk that prunes node_modules BEFORE descending
const IGNORE = new Set(["node_modules", ".git", "dist", ".bun", "target", "build"]);
function* walkPruned(base, pattern = /\.tsx?$/i) {
  const stack = [base];
  while (stack.length) {
    const d = stack.pop();
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (pattern.test(e.name)) yield p;
    }
  }
}
const t2 = ms(() => { let n = 0; for (const _ of walkPruned(ROOT)) n++; }, N);
console.log(`[GLOB] prune-walk "*.ts" (skip node_modules):         ${fmt(t2)}`);

// ripgrep detection variants on Windows
console.log(`\n[RG] Bun.which("rg") = ${Bun.which("rg")}`);
const { spawnSync } = require("node:child_process");
const r1 = spawnSync("where", ["rg"], { encoding: "utf-8" });
console.log(`[RG] where rg: exit=${r1.status} ${r1.stdout?.trim() || r1.stderr?.trim()}`);
const r2 = spawnSync("rg", ["--version"], { encoding: "utf-8", shell: true });
console.log(`[RG] rg --version (shell:true): exit=${r2.status} ${r2.stdout?.trim().slice(0, 30) || r2.error?.message}`);
const r3 = spawnSync("rg", ["--version"], { encoding: "utf-8" });
console.log(`[RG] rg --version (no shell): exit=${r3.status} ${r3.stdout?.trim().slice(0, 30) || r3.error?.code}`);

// fd detection
const r4 = spawnSync("fd", ["--version"], { encoding: "utf-8", shell: true });
console.log(`[FD] fd --version: exit=${r4.status} ${r4.stdout?.trim() || r4.error?.code}`);
console.log(`[FD] Bun.which("fd") = ${Bun.which("fd")}`);
