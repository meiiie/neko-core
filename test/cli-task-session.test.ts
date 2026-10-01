import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, COMPACTION_PROMPT } from "../src/core/agent.ts";
import { createTaskScope } from "../src/core/task-scope.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

const entry = join(import.meta.dir, "..", "bin", "neko.ts");

interface CliResult { exitCode: number; stdout: string; stderr: string }
interface CompletionRequest {
  model: string;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
}

function childEnv(home: string) {
  const passThrough = ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "ComSpec"];
  const env: Record<string, string> = {};
  for (const name of passThrough) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TEMP: home,
    TMP: home,
    NEKO_AUTO_UPDATE: "0",
    NEKO_AUTO_UPDATE_CHECK: "0",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

async function runCli(args: string[], cwd: string, home: string): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", entry, ...args], {
    cwd,
    env: childEnv(home),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error(`CLI timed out: ${args.slice(0, 2).join(" ")}`));
        }, 12_000);
      }),
    ]);
    return { exitCode, stdout: await stdout, stderr: await stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function jsonLine<T>(result: CliResult): T {
  expect(result.exitCode).toBe(0);
  const line = result.stdout.trim().split(/\r?\n/).findLast((value) => value.startsWith("{"));
  expect(line).toBeDefined();
  // SAFETY: each caller invokes a known local CLI metadata command and asserts its expected fields.
  return JSON.parse(line!) as T;
}

function requestText(request: CompletionRequest): string {
  return JSON.stringify(request.messages);
}

async function syntheticCompactionArchive(taskId: string, root: string) {
  writeFileSync(join(root, "config.ts"), "packageManager=pnpm", "utf8");
  const registry = new ToolRegistry(root, "auto", () => false);
  registry.bindTaskScope(createTaskScope(taskId, root));
  let ordinaryCalls = 0;
  const agent = new Agent({
    provider: { complete: async (messages) => {
      if (messages[0]?.content === COMPACTION_PROMPT) {
        return { content: "Synthetic summary omits the file source", tool_calls: [] };
      }
      if (++ordinaryCalls === 1) return {
        content: null, tool_calls: [{ id: "cli-source-read", name: "read_file", arguments: { path: "config.ts" } }],
      };
      return { content: "Read complete", tool_calls: [] };
    } },
    tools: registry,
    verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
  });
  await agent.run("Inspect A");
  for (let i = 0; i < 6; i++) await agent.run(`tail ${i}`);
  await agent.compact();
  const events = agent.compactionSourceEvents();
  expect(events.length).toBeGreaterThan(0);
  expect(JSON.stringify(events)).toContain("cli-source-read");
  return events;
}

test("CLI task session isolates A→B→A across processes, excludes legacy v2, and rejects another root", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "neko-cli-task-session-"));
  const home = join(fixture, "home");
  const rootA = join(fixture, "root-a");
  const rootB = join(fixture, "root-b");
  mkdirSync(home);
  mkdirSync(rootA);
  mkdirSync(rootB);
  const requests: CompletionRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return new Response("unexpected local fixture request", { status: 404 });
      }
      // SAFETY: this loopback fixture accepts only the local CLI's completion request; assertions inspect its fields.
      const payload = await request.json() as CompletionRequest;
      requests.push(payload);
      const answer = `FIXTURE_ANSWER_${requests.length}`;
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const configDir = join(home, ".neko-core");
    mkdirSync(configDir);
    const configPath = join(configDir, "config.json");
    const fixtureConfig = {
      active_profile: "fixture",
      profiles: {
        fixture: {
          provider: "openai_compat",
          auth: "none",
          base_url: `http://127.0.0.1:${server.port}/v1`,
          model: "synthetic-local-model",
        },
      },
      verify_before_exit: false,
      max_retries: 0,
      offline_retry_seconds: 0,
      completion_sound: false,
    };
    writeFileSync(configPath, JSON.stringify(fixtureConfig));

    const created = jsonLine<{ sessionId: string; activeTaskId: string }>(
      await runCli(["task-session", "new", "Task A"], rootA, home),
    );
    expect(created.sessionId).toMatch(/^[a-f0-9]{32}$/);
    expect(created.activeTaskId).toMatch(/^[a-f0-9]{32}$/);

    // A valid legacy v2 session with the SAME id must remain untouched and absent from model input.
    const legacyDir = join(configDir, "sessions");
    mkdirSync(legacyDir);
    const legacyPath = join(legacyDir, `${created.sessionId}.json`);
    const legacyBytes = JSON.stringify({
      schemaVersion: 2,
      id: created.sessionId,
      cwd: rootA,
      model: "synthetic-local-model",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
      messages: [{ role: "user", content: "LEGACY_V2_SECRET_MARKER" }],
    });
    writeFileSync(legacyPath, legacyBytes);
    writeFileSync(join(configDir, "NEKO.md"), "LEGACY_GLOBAL_CONTEXT_MARKER\n");

    const legacyOnlyId = "f".repeat(32);
    writeFileSync(join(legacyDir, `${legacyOnlyId}.json`), legacyBytes.replaceAll(created.sessionId, legacyOnlyId));
    const legacyOnly = await runCli(["run", "--task-session", legacyOnlyId, "--once", "--no-tools", "MUST_NOT_RUN"], rootA, home);
    expect(legacyOnly.exitCode).not.toBe(0);
    expect(legacyOnly.stderr).toMatch(/ENOENT|no such file|cannot find/i);
    expect(requests).toHaveLength(0);

    const runA1 = await runCli(["run", "--task-session", created.sessionId, "--once", "--no-tools", "A_FIRST_UNIQUE_MARKER"], rootA, home);
    expect(runA1.exitCode).toBe(0);
    expect(runA1.stdout).toContain("FIXTURE_ANSWER_1");
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe("synthetic-local-model");
    expect(requestText(requests[0])).toContain("A_FIRST_UNIQUE_MARKER");

    // Seed a real, task-scoped Agent compaction archive into this synthetic session.
    // Subsequent CLI metadata commands and `run` must round-trip it without cross-task admission.
    const taskStorePath = join(configDir, "task-sessions", `${created.sessionId}.json`);
    const sourceEvents = await syntheticCompactionArchive(created.activeTaskId, rootA);
    const seeded = JSON.parse(readFileSync(taskStorePath, "utf8"));
    seeded.tasks[0].sourceEvents = sourceEvents;
    writeFileSync(taskStorePath, JSON.stringify(seeded));
    const taskArchive = (id: string) => {
      const stored = JSON.parse(readFileSync(taskStorePath, "utf8"));
      return stored.tasks.find((task: { id: string }) => task.id === id)?.sourceEvents ?? [];
    };

    const added = jsonLine<{ taskId: string }>(await runCli(["task-session", "add", created.sessionId, "Task B"], rootA, home));
    expect(added.taskId).toMatch(/^[a-f0-9]{32}$/);
    expect(taskArchive(created.activeTaskId)).toEqual(sourceEvents);
    jsonLine(await runCli(["task-session", "use", created.sessionId, added.taskId], rootA, home));
    expect(taskArchive(added.taskId)).toEqual([]);
    const runB = await runCli(["run", "--task-session", created.sessionId, "--once", "--no-tools", "B_FIRST_UNIQUE_MARKER"], rootA, home);
    expect(runB.exitCode).toBe(0);
    expect(runB.stdout).toContain("FIXTURE_ANSWER_2");
    expect(requests).toHaveLength(2);
    expect(requestText(requests[1])).toContain("B_FIRST_UNIQUE_MARKER");
    expect(requestText(requests[1])).not.toContain("A_FIRST_UNIQUE_MARKER");
    expect(requestText(requests[1])).not.toContain("FIXTURE_ANSWER_1");

    jsonLine(await runCli(["task-session", "use", created.sessionId, created.activeTaskId], rootA, home));
    const runA2 = await runCli(["run", "--task-session", created.sessionId, "--once", "--no-tools", "A_SECOND_UNIQUE_MARKER"], rootA, home);
    expect(runA2.exitCode).toBe(0);
    expect(runA2.stdout).toContain("FIXTURE_ANSWER_3");
    expect(requests).toHaveLength(3);
    expect(requestText(requests[2])).toContain("A_FIRST_UNIQUE_MARKER");
    expect(requestText(requests[2])).toContain("FIXTURE_ANSWER_1");
    expect(requestText(requests[2])).toContain("A_SECOND_UNIQUE_MARKER");
    expect(requestText(requests[2])).not.toContain("B_FIRST_UNIQUE_MARKER");
    expect(requestText(requests[2])).not.toContain("FIXTURE_ANSWER_2");
    expect(taskArchive(created.activeTaskId)).toEqual(sourceEvents);

    const stableTaskBytes = readFileSync(taskStorePath, "utf8");
    const changedConfigs = [
      { name: "model", value: { ...fixtureConfig, profiles: { fixture: { ...fixtureConfig.profiles.fixture, model: "changed-local-model" } } } },
      { name: "endpoint", value: { ...fixtureConfig, profiles: { fixture: { ...fixtureConfig.profiles.fixture, base_url: `http://127.0.0.1:${server.port}/mismatch` } } } },
      { name: "mode", value: { ...fixtureConfig, mode: "plan" } },
    ];
    for (const variant of changedConfigs) {
      writeFileSync(configPath, JSON.stringify(variant.value));
      const refused = await runCli(["run", "--task-session", created.sessionId, "--once", "--no-tools", `CHANGED_${variant.name}_MUST_NOT_RUN`], rootA, home);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toMatch(/config.*(changed|mismatch|different)/i);
      expect(requests).toHaveLength(3);
      expect(readFileSync(taskStorePath, "utf8")).toBe(stableTaskBytes);
    }
    writeFileSync(configPath, JSON.stringify(fixtureConfig));
    const resumed = await runCli(["run", "--task-session", created.sessionId, "--once", "--no-tools", "A_RESTARTED_UNIQUE_MARKER"], rootA, home);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout).toContain("FIXTURE_ANSWER_4");
    expect(requests).toHaveLength(4);
    expect(requestText(requests[3])).toContain("A_FIRST_UNIQUE_MARKER");
    expect(requestText(requests[3])).toContain("A_SECOND_UNIQUE_MARKER");
    expect(requestText(requests[3])).toContain("A_RESTARTED_UNIQUE_MARKER");
    expect(requestText(requests[3])).not.toContain("B_FIRST_UNIQUE_MARKER");

    writeFileSync(configPath, JSON.stringify({ ...fixtureConfig, mode: "plan" }));
    const planTask = jsonLine<{ sessionId: string }>(await runCli(["task-session", "new", "Plan task"], rootA, home));
    const planPath = join(configDir, "task-sessions", `${planTask.sessionId}.json`);
    const planBytes = readFileSync(planPath, "utf8");
    const widened = await runCli([
      "run", "--task-session", planTask.sessionId, "--yolo", "--once", "--no-tools", "PLAN_TO_AUTO_MUST_NOT_RUN",
    ], rootA, home);
    expect(widened.exitCode).not.toBe(0);
    expect(widened.stderr).toMatch(/config.*changed/i);
    expect(requests).toHaveLength(4);
    expect(readFileSync(planPath, "utf8")).toBe(planBytes);
    writeFileSync(configPath, JSON.stringify(fixtureConfig));

    const status = jsonLine<{ sessionId: string; activeTaskId: string; tasks: Array<{ id: string }> }>(
      await runCli(["task-session", "status", created.sessionId], rootA, home),
    );
    expect(status.activeTaskId).toBe(created.activeTaskId);
    expect(status.tasks.map((task) => task.id)).toEqual([created.activeTaskId, added.taskId]);

    const beforeRejected = requests.length;
    const wrongRoot = await runCli(["run", "--task-session", created.sessionId, "--once", "--no-tools", "WRONG_ROOT_MARKER"], rootB, home);
    expect(wrongRoot.exitCode).not.toBe(0);
    expect(wrongRoot.stderr).toMatch(/root changed|not host-authorized/i);
    expect(requests).toHaveLength(beforeRejected);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacyBytes);
    for (const request of requests) {
      expect(requestText(request)).not.toContain("LEGACY_V2_SECRET_MARKER");
      expect(requestText(request)).not.toContain("LEGACY_GLOBAL_CONTEXT_MARKER");
    }
  } finally {
    server.stop(true);
    rmSync(fixture, { recursive: true, force: true });
  }
}, 90_000);

test("CLI scoped runtime exposes read-only historical source lookup after restart, and denies another task", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "neko-cli-source-lookup-"));
  const home = join(fixture, "home");
  const root = join(fixture, "root");
  mkdirSync(home);
  mkdirSync(root);
  const requests: CompletionRequest[] = [];
  const observations = new Map<string, string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return new Response("unexpected local fixture request", { status: 404 });
      }
      // SAFETY: this loopback provider only emits a bounded source_lookup call for the exact
      // ID in the most recent user prompt; no external model or file read is involved.
      const payload = await request.json() as CompletionRequest;
      requests.push(payload);
      const latestUser = payload.messages.filter((message) => message.role === "user").at(-1)?.content;
      const match = /^LOOKUP_(A1|B1|A2):([a-f0-9]{64})$/.exec(String(latestUser ?? ""));
      if (!match) return new Response("unexpected lookup prompt", { status: 400 });
      const [, turn, id] = match;
      const callId = `lookup-${turn}`;
      const result = payload.messages.findLast((message) => message.role === "tool" && message.tool_call_id === callId);
      const delta = result
        ? { content: `LOCAL_${turn}_DONE` }
        : { tool_calls: [{ index: 0, id: callId, type: "function", function: {
          name: "source_lookup", arguments: JSON.stringify({ id }),
        } }] };
      if (result) observations.set(turn, String(result.content));
      const finish_reason = result ? "stop" : "tool_calls";
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n` +
        "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const configDir = join(home, ".neko-core");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      active_profile: "fixture",
      profiles: { fixture: {
        provider: "openai_compat", auth: "none",
        base_url: `http://127.0.0.1:${server.port}/v1`, model: "synthetic-local-model",
      } },
      verify_before_exit: false, max_retries: 0, offline_retry_seconds: 0,
      completion_sound: false, mode: "auto",
    }));
    const created = jsonLine<{ sessionId: string; activeTaskId: string }>(
      await runCli(["task-session", "new", "Task A"], root, home),
    );
    const sourceEvents = await syntheticCompactionArchive(created.activeTaskId, root);
    expect(sourceEvents).toHaveLength(1);
    expect(sourceEvents[0]?.callId).toBe("cli-source-read");
    expect(sourceEvents[0]?.result.content).toContain("packageManager=pnpm");
    const sourceId = sourceEvents[0]!.id;
    expect(sourceId).toMatch(/^[a-f0-9]{64}$/);
    const storePath = join(configDir, "task-sessions", `${created.sessionId}.json`);
    const stored = JSON.parse(readFileSync(storePath, "utf8"));
    stored.tasks[0].sourceEvents = sourceEvents;
    writeFileSync(storePath, JSON.stringify(stored));
    // The archived observation and current file now disagree. Lookup must label the old
    // result as historical; no model-supplied path is accepted as proof of current bytes.
    writeFileSync(join(root, "config.ts"), "packageManager=bun", "utf8");
    const ask = async (turn: "A1" | "B1" | "A2") => runCli([
      "run", "--task-session", created.sessionId, "--once", `LOOKUP_${turn}:${sourceId}`,
    ], root, home);
    const first = await ask("A1");
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("LOCAL_A1_DONE");
    expect(observations.get("A1")).toContain("packageManager=pnpm");
    expect(observations.get("A1")).toMatch(/historical.*read_file/i);
    expect(observations.get("A1")).toMatch(/new read_file.*current/i);
    expect(observations.get("A1")).not.toContain("packageManager=bun");

    const added = jsonLine<{ taskId: string }>(await runCli(["task-session", "add", created.sessionId, "Task B"], root, home));
    jsonLine(await runCli(["task-session", "use", created.sessionId, added.taskId], root, home));
    const denied = await ask("B1");
    expect(denied.exitCode).toBe(0);
    expect(denied.stdout).toContain("LOCAL_B1_DONE");
    expect(observations.get("B1")).toMatch(/not found in the active task/i);
    expect(observations.get("B1")).not.toContain("packageManager=pnpm");

    jsonLine(await runCli(["task-session", "use", created.sessionId, created.activeTaskId], root, home));
    const resumed = await ask("A2");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout).toContain("LOCAL_A2_DONE");
    expect(observations.get("A2")).toContain("packageManager=pnpm");
    expect(readFileSync(join(root, "config.ts"), "utf8")).toBe("packageManager=bun");
    const finalStore = JSON.parse(readFileSync(storePath, "utf8"));
    expect(finalStore.tasks.find((task: { id: string }) => task.id === created.activeTaskId).sourceEvents).toEqual(sourceEvents);
    expect(finalStore.tasks.find((task: { id: string }) => task.id === added.taskId).sourceEvents).toEqual([]);
    expect(requests).toHaveLength(6); // one tool call and one final response per resumed CLI turn
    for (const request of requests.filter((_, index) => index % 2 === 0)) {
      expect(request.tools?.some((tool) => tool.function?.name === "source_lookup")).toBe(true);
    }
    for (const request of requests) {
      expect(JSON.stringify(request.messages)).not.toContain("packageManager=bun");
    }
  } finally {
    server.stop(true);
    rmSync(fixture, { recursive: true, force: true });
  }
}, 90_000);
