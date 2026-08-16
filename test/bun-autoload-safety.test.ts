import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const sourceLauncher = join(repo, "bin", "neko-source.cjs");
const safeBunfig = join(repo, "bunfig.neko.toml");
const tempDirs: string[] = [];

function fixture(prefix: string): any {
  const base = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(base);
  const project = join(base, "project");
  const home = join(base, "home");
  const marker = join(base, "PRELOAD_RAN");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(project, ".env"), "NEKO_MODEL=DOTENV_PROJECT_SENTINEL\nBUN_AUTOLOAD_SENTINEL=DOTENV_RAN\n");
  writeFileSync(join(project, "preload.ts"), `await Bun.write(${JSON.stringify(marker)}, "ran");\nprocess.env.BUN_AUTOLOAD_SENTINEL = "BUNFIG_RAN";\n`);
  writeFileSync(join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  return { base, project, home, marker };
}

function cleanEnv(home: string): any {
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && !key.startsWith("NEKO_") && key !== "BUN_AUTOLOAD_SENTINEL")) as Record<string, string>;
  return { ...env, HOME: home, USERPROFILE: home, NEKO_AUTO_UPDATE: "0" };
}

async function removeFixture(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) throw error;
      // A just-exited Windows executable can retain a short-lived loader/AV handle. Retry only the exact
      // mkdtemp fixture; never weaken the test or leave its compiled probe behind.
      await Bun.sleep(Math.min(500, 50 * (2 ** attempt)));
    }
  }
}

afterEach(async () => {
  let firstError: unknown;
  for (const dir of tempDirs.splice(0)) {
    try { await removeFixture(dir); } catch (error) { firstError ??= error; }
  }
  if (firstError) throw firstError;
});

const nodeExecutable = Bun.which("node");
test.skipIf(!nodeExecutable)("public source bootstrap resolves trusted package paths before starting Bun", () => {
  const f = fixture("neko-node-bootstrap-");
  const result = Bun.spawnSync([nodeExecutable!, sourceLauncher, "config"], {
    cwd: f.project,
    env: cleanEnv(f.home),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  expect(output).not.toContain("DOTENV_PROJECT_SENTINEL");
  expect(output).not.toContain("BUNFIG_RAN");
  expect(existsSync(f.marker)).toBe(false);
}, { timeout: 20_000 });

test.skipIf(!nodeExecutable)("source bootstrap accepts the user's Bun install when cwd is their home", () => {
  const f = fixture("neko-node-home-bootstrap-");
  const installed = join(f.home, ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  mkdirSync(join(f.home, ".bun", "bin"), { recursive: true });
  copyFileSync(process.execPath, installed);
  if (process.platform !== "win32") chmodSync(installed, 0o755);
  const env = cleanEnv(f.home);
  delete env.BUN_INSTALL;
  env.PATH = "";
  const result = Bun.spawnSync([nodeExecutable!, sourceLauncher, "config"], {
    cwd: f.home,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
}, { timeout: 30_000 });

test("compiled Bun opt-outs block cwd dotenv and bunfig preloads before the entrypoint", () => {
  const f = fixture("neko-compile-autoload-");
  const probe = join(f.base, "probe.ts");
  const outputBase = join(f.base, "probe-bin");
  const executable = process.platform === "win32" ? `${outputBase}.exe` : outputBase;
  writeFileSync(probe, 'console.log(process.env.BUN_AUTOLOAD_SENTINEL ?? "clean");\n');

  const build = Bun.spawnSync([
    process.execPath,
    "--no-env-file",
    "--no-install",
    `--config=${safeBunfig}`,
    "build", "--compile",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--outfile", outputBase,
    probe,
  ], {
    cwd: f.project,
    env: cleanEnv(f.home),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(build.exitCode, build.stderr.toString()).toBe(0);

  const run = Bun.spawnSync([executable], {
    cwd: f.project,
    env: cleanEnv(f.home),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString().trim()).toBe("clean");
  expect(existsSync(f.marker)).toBe(false);
}, { timeout: 30_000 });

const prebuiltExecutable = process.env.NEKO_TEST_PREBUILT;
test.skipIf(!prebuiltExecutable)("a prebuilt Neko binary ignores malicious cwd dotenv and bunfig", () => {
  const f = fixture("neko-prebuilt-autoload-");
  const result = Bun.spawnSync([prebuiltExecutable!, "config"], {
    cwd: f.project,
    env: cleanEnv(f.home),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  expect(output).not.toContain("DOTENV_PROJECT_SENTINEL");
  expect(output).not.toContain("BUNFIG_RAN");
  expect(existsSync(f.marker)).toBe(false);
}, { timeout: 20_000 });

test.skipIf(!prebuiltExecutable)("a one-line-install binary carries its built-in skills in every cwd", () => {
  const f = fixture("neko-prebuilt-skills-");
  const result = Bun.spawnSync([prebuiltExecutable!, "skills"], {
    cwd: f.project,
    env: cleanEnv(f.home),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  expect(output).toContain("procurement");
  expect(output).toContain("systematic-debugging");
  // The installer downloads one verified standalone binary; built-ins must not depend on a project
  // .neko-core/skills directory or on pre-populating the new user's ~/.neko-core/skills.
  expect(existsSync(join(f.project, ".neko-core", "skills"))).toBe(false);
  expect(existsSync(join(f.home, ".neko-core", "skills"))).toBe(false);
}, { timeout: 20_000 });

test("active source-launch documentation never recommends the pre-trust Bun entry", () => {
  const active = [
    "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.md", "BENCHMARK-REPORT.md",
    "docs/EXTENDING.md", "docs/process/ARCHITECTURE.md", "docs/process/RELEASE.md",
    "docs/process/RULES.md", "docs/process/TESTING.md", "docs/process/WEB.md",
    ".github/workflows/ci.yml",
    "skills/procurement/SKILL.md", "skills/tui-self-test/SKILL.md",
    "scripts/selftest.sh", "scripts/stresstest.sh",
  ];
  for (const relative of active) {
    const text = readFileSync(join(repo, ...relative.split("/")), "utf-8");
    expect(text, relative).not.toMatch(/\bbun(?:\.exe)?\s+(?:run\s+)?bin[\\/]neko\.ts\b/i);
  }
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf-8"));
  expect(pkg.bin.neko).toBe("bin/neko-source.cjs");
  expect(pkg.bin["neko-core"]).toBe("bin/neko-source.cjs");
  expect(readFileSync(join(repo, "bin", "neko.ts"), "utf-8")).not.toStartWith("#!");
});
