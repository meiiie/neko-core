import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "bin", "neko.ts");

function childEnv(home: string) {
  const env: Record<string, string> = {};
  for (const name of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "ComSpec"]) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  return { ...env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home,
    NEKO_AUTO_UPDATE: "0", NEKO_AUTO_UPDATE_CHECK: "0", NO_PROXY: "127.0.0.1,localhost" };
}

async function cli(args: string[], cwd: string, home: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", entry, ...args], {
    cwd, env: childEnv(home), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { child.kill(); reject(new Error("CLI import fixture timed out")); }, 12_000);
      }),
    ]);
    return { exitCode, stdout: await stdout, stderr: await stderr };
  } finally { if (timer) clearTimeout(timer); }
}

function lastJson<T>(stdout: string): T {
  const line = stdout.trim().split(/\r?\n/).findLast((value) => value.startsWith("{"));
  expect(line).toBeDefined();
  // SAFETY: caller invokes only our local CLI metadata commands, and checks the returned fields.
  return JSON.parse(line!) as T;
}

test("CLI import-v1 is explicit, keeps old bytes, and never sends old transcript to provider", async () => {
  const base = mkdtempSync(join(tmpdir(), "neko-cli-v1-import-"));
  const home = join(base, "home");
  const rootA = join(base, "a", "app");
  const rootB = join(base, "b", "app");
  mkdirSync(home); mkdirSync(rootA, { recursive: true }); mkdirSync(rootB, { recursive: true });
  const requests: Array<{ messages: unknown[] }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      // SAFETY: no network outside this synthetic loopback provider fixture.
      const payload = await request.json() as { messages: unknown[] };
      requests.push(payload);
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "SYNTHETIC_OK" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const configDir = join(home, ".neko-core");
    mkdirSync(configDir);
    const configPath = join(configDir, "config.json");
    const config = { active_profile: "fixture", profiles: { fixture: {
      provider: "openai_compat", auth: "none", base_url: `http://127.0.0.1:${server.port}/v1`,
      model: "synthetic-local-model",
    } }, verify_before_exit: false, max_retries: 0, offline_retry_seconds: 0, completion_sound: false };
    writeFileSync(configPath, JSON.stringify(config));
    const createdResult = await cli(["task-session", "new", "Old task"], rootA, home);
    expect(createdResult.exitCode).toBe(0);
    const created = lastJson<{ sessionId: string; activeTaskId: string }>(createdResult.stdout);
    const sourcePath = join(configDir, "task-sessions", `${created.sessionId}.json`);
    const old = JSON.parse(readFileSync(sourcePath, "utf8"));
    old.schemaVersion = 1;
    delete old.tasks[0].sourceEvents;
    old.tasks[0].messages = [
      { role: "tool", tool_call_id: "old-read", content: "OLD_UNVERIFIED_FILE_MARKER" },
      { role: "assistant", content: "OLD_UNVERIFIED_SUMMARY_MARKER" },
    ];
    const oldBytes = JSON.stringify(old, null, 2) + "\n";
    writeFileSync(sourcePath, oldBytes);

    const refusedRoot = await cli(["task-session", "import-v1", created.sessionId], rootB, home);
    expect(refusedRoot.exitCode).not.toBe(0);
    expect(refusedRoot.stderr).toMatch(/root changed|not host-authorized/i);
    expect(readFileSync(sourcePath, "utf8")).toBe(oldBytes);
    const importedResult = await cli(["task-session", "import-v1", created.sessionId], rootA, home);
    expect(importedResult.exitCode).toBe(0);
    expect(importedResult.stdout).toContain("not resumed or sent to the model");
    expect(importedResult.stdout).not.toContain("OLD_UNVERIFIED_FILE_MARKER");
    const imported = lastJson<{ sessionId: string; activeTaskId: string; sourceSessionId: string }>(importedResult.stdout);
    expect(imported.sessionId).not.toBe(created.sessionId);
    expect(imported.sourceSessionId).toBe(created.sessionId);
    expect(readFileSync(sourcePath, "utf8")).toBe(oldBytes);

    const targetPath = join(configDir, "task-sessions", `${imported.sessionId}.json`);
    expect(readFileSync(targetPath, "utf8")).not.toContain("OLD_UNVERIFIED_FILE_MARKER");
    const status = await cli(["task-session", "status", imported.sessionId], rootA, home);
    expect(status.exitCode).toBe(0);
    const metadata = lastJson<{ activeTaskId: string; tasks: Array<{ id: string; label: string; root: string }> }>(status.stdout);
    expect(metadata.activeTaskId).toBe(imported.activeTaskId);
    expect(metadata.tasks).toEqual([{ id: imported.activeTaskId, label: "Old task", root: old.canonicalRoot }]);

    const run = await cli(["run", "--task-session", imported.sessionId, "--once", "--no-tools", "NEW_CURRENT_TASK"], rootA, home);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("SYNTHETIC_OK");
    expect(requests).toHaveLength(1);
    const modelInput = JSON.stringify(requests[0]);
    expect(modelInput).toContain("NEW_CURRENT_TASK");
    expect(modelInput).not.toContain("OLD_UNVERIFIED_FILE_MARKER");
    expect(modelInput).not.toContain("OLD_UNVERIFIED_SUMMARY_MARKER");
    expect(readFileSync(sourcePath, "utf8")).toBe(oldBytes);
    writeFileSync(sourcePath, '{"schemaVersion":1,"content":"SYNTHETIC_SENSITIVE_PARSE_MARKER"');
    const malformed = await cli(["task-session", "import-v1", created.sessionId], rootA, home);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stderr).toContain("Invalid task session v1 JSON");
    expect(malformed.stderr).not.toContain("SYNTHETIC_SENSITIVE_PARSE_MARKER");
  } finally {
    server.stop(true);
    rmSync(base, { recursive: true, force: true });
  }
}, 90_000);
