import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "bin", "neko.ts");

function runDiagnostic(command: "doctor" | "policy"): { status: number; output: string } {
  const home = mkdtempSync(join(tmpdir(), "neko-yolo-diag-"));
  try {
    const result = Bun.spawnSync([process.execPath, entry, "--yolo", command], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NEKO_SANDBOX: "0",
        NEKO_READ_OUTSIDE_ROOT: "false",
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

test("--yolo policy reports effective auto mode and missing confinement", () => {
  const result = runDiagnostic("policy");
  expect(result.status).toBe(0);
  expect(result.output).toContain("Verdict: WARN");
  expect(result.output).toContain("bounded_autonomy_on");
  expect(result.output).toContain("auto_without_live_sandbox");
  expect(result.output).toContain("UNCONFINED AUTO");
});

test("--yolo doctor reports effective auto mode and missing confinement", () => {
  const result = runDiagnostic("doctor");
  expect(result.status).toBe(0);
  expect(result.output).toContain("mode: auto - UNCONFINED AUTO");
  expect(result.output).toContain("bash_sandbox: UNCONFINED AUTO");
});

test("a non-interactive agent process cannot grant project trust", () => {
  const base = mkdtempSync(join(tmpdir(), "neko-headless-trust-"));
  const project = join(base, "project");
  const home = join(base, "home");
  try {
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "UNTRUSTED_CONTROL_SURFACE");
    const result = Bun.spawnSync([process.execPath, entry, "--yolo", "trust", "add"], {
      cwd: project,
      env: { ...process.env, HOME: home, USERPROFILE: home, NEKO_AUTO_UPDATE: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(output).toContain("only be added from an interactive terminal");
    expect(existsSync(join(home, ".neko-core", "trusted-projects.d"))).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
