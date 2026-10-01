import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createNekoAcpAgent } from "../src/adapters/acp.ts";
import { loadConfig } from "../src/adapters/config.ts";
import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

const taskProtocol = { version: 1, mode: "fixed-active-task" } as const;
const executionProtocol = { version: 1 };

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "neko-acp-execution-"));
  const root = join(base, "root"), home = join(base, "home");
  mkdirSync(root); mkdirSync(home);
  return { root, home, cleanup() {
    if (!resolve(base).startsWith(resolve(tmpdir()) + sep) || !basename(base).startsWith("neko-acp-execution-")) {
      throw new Error("Refusing fixture cleanup outside the test directory");
    }
    rmSync(base, { recursive: true, force: true });
  } };
}

function taskEcho(task: any) {
  return { version: 1, id: task.id, activationEpoch: task.activationEpoch, activationId: task.activationId };
}

function taskExpected(task: any) {
  return { id: task.id, root: task.root, activationEpoch: task.activationEpoch, activationId: task.activationId };
}

test("ACP execution opt-in binds target, rejects mismatches and rotates the receipt on resume", async () => {
  const f = fixture();
  const cfg = loadConfig({ cwd: f.root, home: f.home });
  cfg.data.mode = "auto"; cfg.data.sandbox = false;
  let builds = 0, providerCalls = 0;
  const registries: ToolRegistry[] = [];
  const updates: any[] = [];
  const app = createNekoAcpAgent({ config: cfg, buildRuntime: async (runtimeConfig, options) => {
    builds++;
    const registry = new ToolRegistry(options.root, options.mode, options.approval);
    registry.memoryHome = runtimeConfig.resolvedHome;
    registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
    registry.sandboxBash = runtimeConfig.sandbox;
    if (options.computer === false) registry.disabled.add("computer");
    else if (options.computer) registry.computerPort = options.computer;
    if (options.taskScope) registry.bindTaskScope(options.taskScope);
    registries.push(registry);
    return { registry, config: runtimeConfig, close: async () => {}, agent: new Agent({
      provider: { complete: async () => { providerCalls++; return { content: "Hello", tool_calls: [] }; } },
      tools: registry, onDelta: options.onDelta, onEvent: options.onEvent, onCheckpoint: options.onCheckpoint,
      verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
    }) };
  } });
  try {
    await acp.client({ name: "execution-receipt-fixture" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); })
      .connectWith(app, async (ctx) => {
        const initialized = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        expect(initialized._meta?.["neko.executionProtocol"]).toEqual(executionProtocol);
        await expect(ctx.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [],
          _meta: { "neko.executionProtocol": executionProtocol } })).rejects.toThrow();
        const created = await ctx.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [],
          _meta: { "neko.taskProtocol": taskProtocol, "neko.executionProtocol": executionProtocol,
            "neko.taskLabel": "Native auto", "neko.execution": { bashTarget: "sandbox", capabilities: ["all"] } } });
        const task: any = created._meta?.["neko.task"];
        const execution: any = created._meta?.["neko.execution"];
        expect(execution).toMatchObject({ version: 1, taskId: task.id, activationEpoch: task.activationEpoch,
          activationId: task.activationId, bashTarget: "host", confinement: "none", osAuthority: "not-attested",
          approval: { mode: "auto", yolo: false }, capabilities: { computer: "unavailable" } });
        expect(execution.authorityId).toMatch(/^[a-f0-9]{64}$/);
        expect(updates.every((update) => update._meta?.["neko.execution"]?.activationId === task.activationId)).toBe(true);
        const prompt = (binding: any) => ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId, prompt: [{ type: "text", text: "Say hello." }],
          _meta: { "neko.task": taskEcho(task), ...(binding ? { "neko.execution": binding } : undefined) },
        });
        await expect(prompt(undefined)).rejects.toThrow();
        await expect(prompt({ ...execution, bashTarget: "sandbox" })).rejects.toThrow();
        await expect(prompt({ ...execution, activationEpoch: execution.activationEpoch + 1 })).rejects.toThrow();
        expect(providerCalls).toBe(0);
        const result = await prompt(execution);
        expect(result._meta?.["neko.execution"]).toMatchObject({ bashTarget: "host", activationId: task.activationId });
        expect(providerCalls).toBe(1);
        const closed = await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId,
          _meta: { "neko.task": taskEcho(task), "neko.execution": execution } });
        const closedExecution: any = closed._meta?.["neko.execution"];
        expect(closedExecution.activationId).toBe(task.activationId);
        expect(String(await registries[0]!.execute("write_file", { path: "retired.txt", content: "blocked" }))).toContain("retired");
        const load = (expectedExecution: any) => ctx.request(acp.methods.agent.session.load, {
          sessionId: created.sessionId, cwd: f.root, mcpServers: [], _meta: {
            "neko.taskProtocol": taskProtocol, "neko.executionProtocol": executionProtocol,
            "neko.taskExpected": taskExpected(task), "neko.executionExpected": expectedExecution,
          },
        });
        await expect(load({ ...execution, bashTarget: "sandbox" })).rejects.toThrow();
        await expect(load({ ...execution, authorityId: "0".repeat(64) })).rejects.toThrow();
        expect(builds).toBe(1);
        cfg.data.hooks = { pre_tool_use: "echo changed-authority" };
        await expect(load(execution)).rejects.toThrow();
        cfg.data.hooks = undefined;
        cfg.data.sandbox = true;
        await expect(load(execution)).rejects.toThrow();
        cfg.data.sandbox = false;
        expect(builds).toBe(1);
        const loaded = await load(execution);
        const nextTask: any = loaded._meta?.["neko.task"], nextExecution: any = loaded._meta?.["neko.execution"];
        expect(nextTask.activationEpoch).toBe(task.activationEpoch + 1);
        expect(nextExecution.activationEpoch).toBe(nextTask.activationEpoch);
        expect(nextExecution.activationId).toBe(nextTask.activationId);
        expect(nextExecution.activationId).not.toBe(execution.activationId);
        expect(registries[1]!.taskScope?.activationId).toBe(nextTask.activationId);
        await expect(ctx.request(acp.methods.agent.session.prompt, { sessionId: created.sessionId,
          prompt: [{ type: "text", text: "Say hello." }], _meta: { "neko.task": taskEcho(nextTask), "neko.execution": execution },
        })).rejects.toThrow();
        await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId,
          _meta: { "neko.task": taskEcho(nextTask), "neko.execution": nextExecution } });
      });
  } finally { f.cleanup(); }
});

test("ACP resume rejects a changed negotiated computer ceiling before creating a runtime", async () => {
  const f = fixture();
  const cfg = loadConfig({ cwd: f.root, home: f.home });
  cfg.data.sandbox = false;
  let builds = 0;
  const app = createNekoAcpAgent({ config: cfg, buildRuntime: async (runtimeConfig, options) => {
    builds++;
    const registry = new ToolRegistry(options.root, options.mode, options.approval);
    registry.memoryHome = f.home;
    registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
    if (options.computer === false) registry.disabled.add("computer");
    else if (options.computer) registry.computerPort = options.computer;
    if (options.taskScope) registry.bindTaskScope(options.taskScope);
    return { registry, config: runtimeConfig, close: async () => {}, agent: new Agent({
      provider: { complete: async () => ({ content: "fixture", tool_calls: [] }) }, tools: registry,
      verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
    }) };
  } });
  try {
    await acp.client({ name: "capability-resume-fixture" }).connectWith(app, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const created = await ctx.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [],
        _meta: { "neko.taskProtocol": taskProtocol, "neko.executionProtocol": executionProtocol, "neko.taskLabel": "A" } });
      const task: any = created._meta?.["neko.task"], execution: any = created._meta?.["neko.execution"];
      await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId,
        _meta: { "neko.task": taskEcho(task), "neko.execution": execution } });
      // Capability negotiation is an existing host transport seam, not a model tool grant.
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {
        _meta: { "dev.wiii.computer.v1": { semanticProtocol: "neko-computer.semantic.v1",
          methods: ["_wiii/computer/v1/status", "_wiii/computer/v1/observe", "_wiii/computer/v1/lease/acquire",
            "_wiii/computer/v1/act", "_wiii/computer/v1/lease/release"] } },
      } });
      await expect(ctx.request(acp.methods.agent.session.load, { sessionId: created.sessionId, cwd: f.root, mcpServers: [],
        _meta: { "neko.taskProtocol": taskProtocol, "neko.executionProtocol": executionProtocol,
          "neko.taskExpected": taskExpected(task), "neko.executionExpected": execution } })).rejects.toThrow();
      expect(builds).toBe(1);
    });
  } finally { f.cleanup(); }
});

test("execution binding survives reconnect and bounded receipt retry without a metadata downgrade or fork", async () => {
  const f = fixture();
  const cfg = loadConfig({ cwd: f.root, home: f.home });
  cfg.data.mode = "auto"; cfg.data.sandbox = false;
  let builds = 0;
  const registries: ToolRegistry[] = [];
  const cleanup: Promise<void>[] = [];
  const app = () => createNekoAcpAgent({ config: cfg, trackCleanup: (task) => { cleanup.push(task); },
    buildRuntime: async (runtimeConfig, options) => {
      builds++;
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      registry.memoryHome = f.home;
      registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
      registry.disabled.add("computer");
      if (options.taskScope) registry.bindTaskScope(options.taskScope);
      registries.push(registry);
      return { registry, config: runtimeConfig, close: async () => {}, agent: new Agent({
        provider: { complete: async () => ({ content: "fixture", tool_calls: [] }) }, tools: registry,
        verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
      }) };
    } });
  let sessionId = "";
  let originalTask: any, originalExecution: any;
  try {
    await acp.client({ name: "execution-disconnect-fixture" }).connectWith(app(), async (ctx) => {
      const initialized = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      expect(initialized.agentCapabilities?.sessionCapabilities?.fork).toBeUndefined();
      const created = await ctx.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [],
        _meta: { "neko.taskProtocol": taskProtocol, "neko.executionProtocol": executionProtocol, "neko.taskLabel": "Reconnect" } });
      sessionId = created.sessionId;
      originalTask = created._meta?.["neko.task"]; originalExecution = created._meta?.["neko.execution"];
      await expect(ctx.request(acp.methods.agent.session.fork, { sessionId, cwd: f.root, mcpServers: [],
        _meta: { "neko.taskProtocol": taskProtocol, "neko.executionProtocol": executionProtocol,
          "neko.task": taskEcho(originalTask), "neko.execution": originalExecution } })).rejects.toThrow();
      expect(builds).toBe(1);
      // Closing the connection must retire the active binding without a session/close request.
    });
    await Promise.all(cleanup);
    expect(await registries[0]!.execute("write_file", { path: "after-disconnect.txt", content: "blocked" }))
      .toContain("activation is retired");
    await acp.client({ name: "execution-reconnect-fixture" }).connectWith(app(), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      await expect(ctx.request(acp.methods.agent.session.resume, { sessionId, cwd: f.root, mcpServers: [] })).rejects.toThrow();
      await expect(ctx.request(acp.methods.agent.session.resume, { sessionId, cwd: f.root, mcpServers: [],
        _meta: { "neko.taskProtocol": taskProtocol, "neko.taskExpected": taskExpected(originalTask) } })).rejects.toThrow();
      expect(builds).toBe(1);
      const resumeParams: acp.ResumeSessionRequest = { sessionId, cwd: f.root, mcpServers: [], _meta: {
        "neko.taskProtocol": taskProtocol, "neko.executionProtocol": executionProtocol,
        "neko.taskExpected": taskExpected(originalTask), "neko.executionExpected": originalExecution,
      } };
      const resumed = await ctx.request(acp.methods.agent.session.resume, resumeParams);
      const resumedTask: any = resumed._meta?.["neko.task"], resumedExecution: any = resumed._meta?.["neko.execution"];
      expect(resumedTask.activationEpoch).toBe(originalTask.activationEpoch + 1);
      expect(resumedExecution.activationId).toBe(resumedTask.activationId);
      expect(resumedExecution.authorityId).toBe(originalExecution.authorityId);
      expect(resumedExecution.bashTarget).toBe("host");
      await ctx.request(acp.methods.agent.session.close, { sessionId,
        _meta: { "neko.task": taskEcho(resumedTask), "neko.execution": resumedExecution } });
      // Simulate a lost resume ACK by retrying the original persisted receipt once.
      const retried = await ctx.request(acp.methods.agent.session.resume, resumeParams);
      const retryTask: any = retried._meta?.["neko.task"], retryExecution: any = retried._meta?.["neko.execution"];
      expect(retried._meta?.["neko.taskRecovery"]).toEqual({ version: 1, kind: "prior_receipt_retry" });
      expect(retryTask.activationEpoch).toBe(resumedTask.activationEpoch + 1);
      expect(retryExecution.activationId).toBe(retryTask.activationId);
      expect(retryExecution.activationId).not.toBe(resumedExecution.activationId);
      expect(retryExecution.authorityId).toBe(originalExecution.authorityId);
      await ctx.request(acp.methods.agent.session.close, { sessionId,
        _meta: { "neko.task": taskEcho(retryTask), "neko.execution": retryExecution } });
      await expect(ctx.request(acp.methods.agent.session.resume, resumeParams)).rejects.toMatchObject({
        code: -32002, data: { "neko.taskError": { kind: "recovery_required" } },
      });
      expect(builds).toBe(3);
    });
    await Promise.all(cleanup);
  } finally { await Promise.allSettled(cleanup); f.cleanup(); }
});

test("a helper cannot substitute host placement for an explicit sandbox activation", async () => {
  const f = fixture();
  const cfg = loadConfig({ cwd: f.root, home: f.home });
  cfg.data.mode = "auto"; cfg.data.sandbox = true;
  let providerCalls = 0;
  let retained: ToolRegistry | undefined;
  const app = createNekoAcpAgent({ config: cfg, buildRuntime: async (runtimeConfig, options) => {
    const registry = new ToolRegistry(options.root, options.mode, options.approval);
    registry.memoryHome = f.home;
    registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
    registry.sandboxBash = false; // synthetic incorrect helper fallback; never launch a real sandbox.
    registry.disabled.add("computer");
    if (options.taskScope) registry.bindTaskScope(options.taskScope);
    retained = registry;
    return { registry, config: runtimeConfig, close: async () => {}, agent: new Agent({
      provider: { complete: async () => { providerCalls++; return { content: "unexpected", tool_calls: [] }; } },
      tools: registry, verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
    }) };
  } });
  try {
    await acp.client({ name: "no-host-helper-fallback" }).connectWith(app, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      await expect(ctx.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [],
        _meta: { "neko.taskProtocol": taskProtocol, "neko.executionProtocol": executionProtocol, "neko.taskLabel": "Sandbox required" },
      })).rejects.toMatchObject({ code: -32000 });
      expect(providerCalls).toBe(0);
      expect(retained).toBeDefined();
      expect(await retained!.execute("write_file", { path: "incorrect-helper.txt", content: "blocked" }))
        .toContain("activation is retired");
    });
  } finally { f.cleanup(); }
});
