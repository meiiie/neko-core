import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

const entry = join(import.meta.dir, "..", "bin", "neko.ts");

test("task-session CLI flag cannot silently start legacy chat or a default run", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-task-cli-flag-"));
  const run = (args: string[]) => Bun.spawnSync([process.execPath, entry, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NEKO_AUTO_UPDATE: "0",
      NEKO_AUTO_UPDATE_CHECK: "0",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const taskId = "a".repeat(32);
    const chat = run(["chat", "--task-session", taskId]);
    expect(chat.exitCode).toBe(2);
    expect(chat.stderr.toString()).toContain("/task resume");
    const bare = run(["--task-session", taskId]);
    expect(bare.exitCode).toBe(2);
    expect(bare.stderr.toString()).toContain("/task resume");
    const missing = run(["run", "--task-session", "--no-tools", "do not run"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr.toString()).toContain("exact task session id");
  } finally {
    const tempRoot = resolve(tmpdir()) + sep;
    if (!resolve(home).startsWith(tempRoot) || !basename(home).startsWith("neko-task-cli-flag-")) {
      throw new Error("Refusing to remove a fixture outside the task temp directory");
    }
    rmSync(home, { recursive: true, force: true });
  }
});
