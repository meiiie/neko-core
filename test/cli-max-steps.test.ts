import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "bin", "neko.ts");

function runCli(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "neko-max-steps-"));
  try {
    const result = Bun.spawnSync([process.execPath, entry, ...args], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NEKO_SANDBOX: "0",
        NEKO_AUTO_UPDATE: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("--max-steps overrides config default for doctor (same load() path as neko run)", () => {
  const baseline = runCli(["doctor"]);
  expect(baseline.status).toBe(0);
  expect(baseline.output).toMatch(/max_steps:\s*40\b/);

  const raised = runCli(["--max-steps", "80", "doctor"]);
  expect(raised.status).toBe(0);
  expect(raised.output).toMatch(/max_steps:\s*80\b/);
  expect(raised.output).not.toMatch(/max_steps:\s*40\b/);
});

test("--max-steps rejects non-integer / out-of-range by keeping config default", () => {
  // Parser stores Number(...) || undefined; "nope" -> NaN -> undefined -> default 40.
  const bad = runCli(["--max-steps", "nope", "doctor"]);
  expect(bad.status).toBe(0);
  expect(bad.output).toMatch(/max_steps:\s*40\b/);

  // 0 floors to 0 and fails the 1..512 guard -> default 40.
  const zero = runCli(["--max-steps", "0", "doctor"]);
  expect(zero.status).toBe(0);
  expect(zero.output).toMatch(/max_steps:\s*40\b/);
});

test("neko --help documents --max-steps for run|bench", () => {
  const help = runCli(["--help"]);
  expect(help.status).toBe(0);
  expect(help.output).toMatch(/--max-steps <n>/);
  expect(help.output).toMatch(/run\|bench/);
});

test("README documents wired --max-steps for neko run --loop", async () => {
  const readme = await Bun.file(join(import.meta.dir, "..", "README.md")).text();
  expect(readme).toMatch(/neko run --loop --max-steps 80/);
  expect(readme).toMatch(/honored through the same `load\(\)` path/);
  // Lived HardMix A/B honesty: runners passed 80 but effective cap was still 40 pre-#62.
  expect(readme).toMatch(/effective cap \*\*40\*\*|config default \*\*40\*\*/);
});

test("HARNESS-ARCHITECTURE documents CLI --max-steps override + loop review guard", async () => {
  const arch = await Bun.file(join(import.meta.dir, "..", "docs", "HARNESS-ARCHITECTURE.md")).text();
  expect(arch).toMatch(/CLI `--max-steps <n>`/);
  expect(arch).toMatch(/exitWhenIdle/);
  expect(arch).toMatch(/required artifact file already exists/);
});
