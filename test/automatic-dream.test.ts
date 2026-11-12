import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import type { Provider } from "../src/core/ports.ts";
import { NekoConfig } from "../src/adapters/config.ts";
import { automaticDreamRecall, bindAutomaticDream, legacyDreamScope, runAutomaticDream } from "../src/adapters/automatic-dream.ts";
import { DreamStore } from "../src/adapters/dream-store.ts";
import { parseDreamInput } from "../src/core/dream.ts";
import { productionTurnContext } from "../src/adapters/turn-context.ts";

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "neko-auto-dream-")), root = join(home, "root");
  mkdirSync(root);
  const cfg = new NekoConfig({ provider: "openai_compat", model: "fixture", mode: "auto", context_window: 32000 }, null, {}, "", null, [], undefined, home);
  const registry = new ToolRegistry(root, "auto", async () => false); registry.memoryHome = home;
  const answer: Provider = { complete: async () => ({ content: "Noted.", tool_calls: [] }) };
  const agent = new Agent({ provider: answer, tools: registry, maxSteps: 2, verifyBeforeExit: false, verifyStateChangesBeforeExit: false });
  await agent.run("Use bun to run tests.");
  const notices: string[] = [];
  let calls = 0;
  const providerFactory = (): Provider => ({ complete: async (messages, tools) => {
    calls++; expect(tools).toEqual([]);
    const input = parseDreamInput(JSON.parse(String(messages[1].content)));
    const source = input.sources.find(item => item.kind === "user")!;
    return { content: JSON.stringify({ summary: "Tests", claims: [{ title: "Use Bun", text: "Use bun to run tests.", status: "observed", citations: [{ sourceId: source.id, quote: "Use bun to run tests." }], related: [], corrects: [] }] }), tool_calls: [], usage: { prompt_tokens: 20, completion_tokens: 10 } };
  } });
  return { home, root, cfg, registry, agent, sessionId: "session-a", notify: (message: string) => notices.push(message), notices, providerFactory, calls: () => calls };
}

test("default legacy Dream prepares/applies/recalls without binding task authority; same evidence and rollback do not spend twice", async () => {
  const f = await fixture();
  try {
    const scope = bindAutomaticDream(f)!;
    expect(f.registry.taskScope).toBeUndefined();
    expect(await runAutomaticDream(f)).toBe("applied");
    expect(f.calls()).toBe(1);
    expect(automaticDreamRecall(f.registry)).toContain("Use Bun");
    expect(productionTurnContext(f.registry, { home: f.home, provider: "fixture", model: "fixture" })).toContain("Use Bun");
    f.agent.messages[0].content = "Refreshed system context is not new original evidence.";
    expect(await runAutomaticDream(f)).toBe("unchanged");
    const id = f.notices.join(" ").match(/candidate ([a-f0-9]{64})/)![1];
    new DreamStore(f.home, scope).rollback(id);
    expect(await runAutomaticDream(f)).toBe("unchanged");
    expect(f.calls()).toBe(1);
    expect(automaticDreamRecall(f.registry)).not.toContain("Use Bun");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test.each(["manual", "off"])("%s does not request automatic Dream", async mode => {
  const f = await fixture();
  try { f.cfg.data.dream_mode = mode; bindAutomaticDream(f); expect(await runAutomaticDream(f)).toBe("skipped"); expect(f.calls()).toBe(0); }
  finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("session and authority scopes are separate; default does not turn task mode on", async () => {
  const f = await fixture();
  try {
    expect(legacyDreamScope("session-a", f.root).id).not.toBe(legacyDreamScope("session-b", f.root).id);
    expect(legacyDreamScope("session-a", f.root).id).not.toBe(legacyDreamScope("session-a", f.root, "acp").id);
    expect(await runAutomaticDream({ ...f, restricted: true })).toBe("skipped");
    expect(f.calls()).toBe(0);
    expect(f.registry.taskScope).toBeUndefined();
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("failed proposal does not activate and is not secretly retried for identical evidence", async () => {
  const f = await fixture(); let calls = 0;
  try {
    bindAutomaticDream(f);
    const providerFactory = (): Provider => ({ complete: async () => { calls++; return { content: "invalid", tool_calls: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }; } });
    expect(await runAutomaticDream({ ...f, providerFactory })).toBe("failed");
    expect(await runAutomaticDream({ ...f, providerFactory })).toBe("unchanged");
    expect(calls).toBe(1);
    expect(f.agent.cost.totalTokens).toBe(15);
    expect(new DreamStore(f.home, f.registry.dreamScope!).automaticStatus()?.reason).toBe("invalid_response");
    expect(automaticDreamRecall(f.registry)).toBe("");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("ordinary CLI automatically prepares and activates a Dream without --task-session", async () => {
  const { writeFileSync, readdirSync, readFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "neko-auto-dream-cli-")), root = join(home, "root");
  mkdirSync(root); mkdirSync(join(home, ".neko-core"));
  let dreams = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    // SAFETY: this test-only loopback server receives requests from the fixture CLI provider.
    const body = await request.json() as { stream?: boolean; messages: { role: string; content: string }[] };
    const isDream = body.messages[0].content.includes("Allowed memory filenames");
    let answer = "Noted.";
    if (isDream) {
      dreams++;
      const input = parseDreamInput(JSON.parse(body.messages[1].content));
      const source = input.sources.find(item => item.kind === "user")!;
      answer = JSON.stringify({ summary: "Tests", claims: [{ title: "Use Bun", text: "Use bun to run tests.", status: "observed", citations: [{ sourceId: source.id, quote: "Use bun to run tests." }], corrects: [], related: [] }] });
    }
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }] });
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    writeFileSync(join(home, ".neko-core/config.json"), JSON.stringify({ active_profile: "fixture", profiles: { fixture: { provider: "openai_compat", auth: "none", base_url: `http://127.0.0.1:${server.port}/v1`, model: "fixture" } }, max_retries: 0, offline_retry_seconds: 0, verify_before_exit: false, auto_loop: false }));
    const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", join(import.meta.dir, "../bin/neko.ts"), "run", "--once", "Use bun to run tests."], {
      cwd: root, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, NEKO_AUTO_UPDATE: "0", NEKO_AUTO_UPDATE_CHECK: "0", NO_PROXY: "127.0.0.1,localhost" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const out = new Response(child.stdout).text(), err = new Response(child.stderr).text();
    const code = await child.exited;
    const stderr = await err; expect(code, stderr).toBe(0);
    expect(await out).toContain("Noted.");
    expect(dreams).toBe(1);
    const notes: string[] = [];
    const walk = (dir: string) => { for (const item of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, item.name); if (item.isDirectory()) walk(path); else if (item.name === "dream.md") notes.push(readFileSync(path, "utf8")); } };
    walk(join(home, ".neko-core"));
    expect(notes, stderr).toHaveLength(1); expect(notes[0]).toContain("Use Bun");
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});

test("legacy Dream read routes to its sidecar but cannot change ordinary memory authority", async () => {
  const f = await fixture();
  try {
    bindAutomaticDream(f); await runAutomaticDream(f);
    const read = await f.registry.execute("memory", { action: "read", name: "dream.md" });
    expect(read).toContain("Use Bun");
    expect(await f.registry.execute("memory", { action: "write", name: "dream.md", content: "fake" })).toContain("host-managed");
    expect(f.registry.taskScope).toBeUndefined();
    const resumed = new ToolRegistry(f.root, "auto", async () => false); resumed.memoryHome = f.home;
    bindAutomaticDream({ ...f, registry: resumed });
    expect(automaticDreamRecall(resumed)).toContain("Use Bun");
    bindAutomaticDream({ ...f, registry: resumed, sessionId: "unrelated" });
    expect(automaticDreamRecall(resumed)).toBe("");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("a newly claimed turn supersedes an older in-flight automatic proposal", async () => {
  const f = await fixture();
  try {
    const scope = bindAutomaticDream(f)!;
    const original = f.providerFactory();
    const providerFactory = (): Provider => ({ complete: async (...args) => {
      new DreamStore(f.home, scope).claimAutomatic("b".repeat(64));
      return original.complete(...args);
    } });
    expect(await runAutomaticDream({ ...f, providerFactory })).toBe("failed");
    expect(automaticDreamRecall(f.registry)).toBe("");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("cancel, mode-off and changed source during the extra request never activate", async () => {
  for (const change of ["cancel", "off", "source"] as const) {
    const f = await fixture(); const controller = new AbortController();
    try {
      bindAutomaticDream(f); const original = f.providerFactory();
      const providerFactory = (): Provider => ({ complete: async (...args) => {
        if (change === "cancel") controller.abort();
        if (change === "off") f.cfg.data.dream_mode = "off";
        if (change === "source") f.agent.messages.push({ role: "user", content: "Correction: use npm now." });
        return original.complete(...args);
      } });
      expect(await runAutomaticDream({ ...f, providerFactory, signal: controller.signal })).toBe("failed");
      expect(automaticDreamRecall(f.registry)).toBe("");
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  }
});

test("explicit task sessions use their existing scope and reject a switched snapshot before any request", async () => {
  const { createTaskScope } = await import("../src/core/task-scope.ts");
  const f = await fixture();
  try {
    const scope = createTaskScope("task-a", f.root);
    f.registry.bindTaskScope(scope);
    bindAutomaticDream(f);
    const input = { sessionId: f.sessionId, taskId: scope.id, scope, root: scope.canonicalRoot, label: "Task A", messages: f.agent.messages, sourceEvents: [] };
    expect(await runAutomaticDream({ ...f, taskInput: () => ({ ...input, scope: createTaskScope("task-b", f.root) }) })).toBe("failed");
    expect(f.calls()).toBe(0);
    expect(await runAutomaticDream({ ...f, taskInput: () => input })).toBe("applied");
    expect(f.registry.taskScope).toBe(scope);
    expect(await f.registry.execute("memory", { action: "read", name: "dream.md" })).toContain("Use Bun");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

 test("task Dream accepts aliased home paths using physical identity", async () => {
  const { createTaskScope } = await import("../src/core/task-scope.ts");
  const f = await fixture();
  try {
    const alias = join(f.home, "home-alias");
    symlinkSync(f.home, alias, "junction");
    f.cfg.resolvedHome = alias;
    f.registry.memoryHome = alias;
    const scope = createTaskScope("aliased-home-task", f.root);
    f.registry.bindTaskScope(scope);
    bindAutomaticDream(f);
    expect(await runAutomaticDream(f)).toBe("applied");
    expect(f.calls()).toBe(1);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("background scheduling returns before model response; cancellation prevents activation", async () => {
  const { scheduleAutomaticDream, cancelAutomaticDream, settleAutomaticDream } = await import("../src/adapters/automatic-dream.ts");
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  try {
    bindAutomaticDream(f);
    const result = scheduleAutomaticDream({ ...f, providerFactory: () => ({ complete: async (...args) => {
      started = true; await gate; return f.providerFactory().complete(...args);
    } }) });
    expect(result).toBeUndefined();
    for (let n = 0; n < 50 && !started; n++) await Bun.sleep(5);
    expect(started).toBe(true);
    cancelAutomaticDream(f.registry);
    release();
    await settleAutomaticDream(f.registry);
    expect(automaticDreamRecall(f.registry)).toBe("");
  } finally { release(); rmSync(f.home, { recursive: true, force: true }); }
});

test("background worker snapshots evidence and coalesces to the latest pending job", async () => {
  const { scheduleAutomaticDream, settleAutomaticDream } = await import("../src/adapters/automatic-dream.ts");
  const f = await fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0, active = 0, peak = 0;
  const inputs: string[] = [];
  const providerFactory = (): Provider => ({ complete: async messages => {
    calls++; active++; peak = Math.max(peak, active);
    inputs.push(String(messages[1].content));
    if (calls === 1) await gate;
    active--;
    return { content: JSON.stringify({ summary: "Nothing", claims: [] }), tool_calls: [] };
  } });
  try {
    bindAutomaticDream(f);
    scheduleAutomaticDream({ ...f, providerFactory });
    for (let n = 0; n < 50 && calls === 0; n++) await Bun.sleep(5);
    f.agent.messages.push({ role: "user", content: "Intermediate input" });
    scheduleAutomaticDream({ ...f, providerFactory });
    f.agent.messages.push({ role: "user", content: "Latest input" });
    scheduleAutomaticDream({ ...f, providerFactory });
    await Bun.sleep(20);
    expect(calls).toBe(1);
    release(); await settleAutomaticDream(f.registry);
    expect(calls).toBe(2); expect(peak).toBe(1);
    expect(inputs[0]).not.toContain("Latest input");
    expect(inputs[1]).toContain("Latest input");
    expect(automaticDreamRecall(f.registry)).toBe("");
  } finally { release(); rmSync(f.home, { recursive: true, force: true }); }
});

test("background snapshot cannot absorb live mutations before its provider starts", async () => {
  const { scheduleAutomaticDream, settleAutomaticDream } = await import("../src/adapters/automatic-dream.ts");
  const f = await fixture(); let seen = "";
  try {
    bindAutomaticDream(f);
    scheduleAutomaticDream({ ...f, providerFactory: () => ({ complete: async messages => {
      seen = String(messages[1].content);
      return f.providerFactory().complete(messages, []);
    } }) });
    f.agent.messages.push({ role: "user", content: "A new foreground turn" });
    await settleAutomaticDream(f.registry);
    expect(seen).not.toContain("A new foreground turn");
    expect(automaticDreamRecall(f.registry)).toBe("");
    expect(f.notices.join("")).toContain("stale_context");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Dream failure reasons do not echo provider secrets", async () => {
  const f = await fixture();
  try {
    bindAutomaticDream(f);
    await runAutomaticDream({ ...f, providerFactory: () => ({ complete: async () => { throw new Error("private-credential-and-transcript"); } }) });
    expect(f.notices.join("")).toContain("provider_error");
    expect(f.notices.join("")).not.toContain("private-credential");
    const receipt = new DreamStore(f.home, f.registry.dreamScope!).automaticStatus();
    expect(receipt?.reason).toBe("provider_error");
    expect(JSON.stringify(receipt)).not.toContain("private-credential");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("late provider usage after cancellation is counted once without activation", async () => {
  const { scheduleAutomaticDream, cancelAutomaticDream, settleAutomaticDream } = await import("../src/adapters/automatic-dream.ts");
  const f = await fixture(); let release!: () => void; let started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    bindAutomaticDream(f);
    scheduleAutomaticDream({ ...f, providerFactory: () => ({ complete: async () => {
      started = true; await gate;
      return { content: "invalid", tool_calls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    } }) });
    for (let n = 0; n < 50 && !started; n++) await Bun.sleep(5);
    cancelAutomaticDream(f.registry); await Bun.sleep(5); release();
    await settleAutomaticDream(f.registry);
    expect(f.agent.cost.totalTokens).toBe(15);
    expect(automaticDreamRecall(f.registry)).toBe("");
  } finally { release(); rmSync(f.home, { recursive: true, force: true }); }
});
