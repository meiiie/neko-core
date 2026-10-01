import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createNekoAcpAgent } from "../src/adapters/acp.ts";
import { WIII_COMPUTER_CAPABILITY, WIII_COMPUTER_METHODS, WIII_COMPUTER_PROTOCOL } from "../src/adapters/acp-computer.ts";
import type { BuildAgentRuntimeOptions } from "../src/adapters/agent-runtime.ts";
import { NekoConfig } from "../src/adapters/config.ts";
import { createTaskSession, loadTaskSession, taskSessionConfigId, type TaskRuntimeInput, type TaskSessionCoordinator } from "../src/adapters/task-session.ts";
import { Agent } from "../src/core/agent.ts";
import type { ComputerInputPolicy } from "../src/core/computer-input-policy.ts";
import type { ComputerToolPort } from "../src/core/ports.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

const taskProtocol = { version: 1, mode: "fixed-active-task" } as const;
const executionProtocol = { version: 1 };
// Captured from pre-integration v1 for fixtureConfig with an empty synthetic write-root ceiling.
const OLD_CONFIG_ID = "77baf3c61a132caca308e57e2b462560643aa4602274326f44930527e5541682";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "neko-acp-input-"));
  const root = join(base, "root"), home = join(base, "home");
  mkdirSync(root); mkdirSync(home);
  return { root, home, cleanup() {
    if (!resolve(base).startsWith(resolve(tmpdir()) + sep) || !basename(base).startsWith("neko-acp-input-")) {
      throw new Error("Refusing fixture cleanup outside the test directory");
    }
    rmSync(base, { recursive: true, force: true });
  } };
}

function fixtureConfig(home: string) {
  const cfg = new NekoConfig({ provider: "openai_compat", model: "fixture-free",
    base_url: "https://example.invalid/v1", mode: "auto", sandbox: false }, null, {}, "");
  cfg.resolvedHome = home;
  return cfg;
}

function taskEcho(task: any) {
  return { version: 1, id: task.id, activationEpoch: task.activationEpoch, activationId: task.activationId };
}

function taskExpected(task: any) {
  return { id: task.id, root: task.root, activationEpoch: task.activationEpoch, activationId: task.activationId };
}

function negotiatedComputer(): acp.ClientCapabilities {
  return { _meta: { [WIII_COMPUTER_CAPABILITY]: { semanticProtocol: WIII_COMPUTER_PROTOCOL,
    methods: Object.values(WIII_COMPUTER_METHODS) } } };
}

const fakePort = (): ComputerToolPort => ({
  schema: () => ({ name: "computer", description: "Fake only", parameters: { type: "object", properties: {} } }),
  permission: () => "safe", call: async () => "fake-port",
});

type FactoryMutation = (registry: ToolRegistry, options: BuildAgentRuntimeOptions, cfg: NekoConfig) => void;

function harness(f: ReturnType<typeof fixture>, cfg: NekoConfig,
  beforeBind?: FactoryMutation, afterBind?: FactoryMutation) {
  const registries: ToolRegistry[] = [];
  const cleanup: Promise<void>[] = [];
  let providerCalls = 0;
  const app = () => createNekoAcpAgent({ config: cfg, trackCleanup: (task) => { cleanup.push(task); },
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      registry.memoryHome = f.home;
      registry.sandboxBash = runtimeConfig.sandbox;
      registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
      if (options.computer === false) registry.disabled.add("computer");
      else if (options.computer) registry.computerPort = options.computer;
      beforeBind?.(registry, options, runtimeConfig);
      if (options.taskScope) registry.bindTaskScope(options.taskScope);
      afterBind?.(registry, options, runtimeConfig);
      registries.push(registry);
      return { registry, config: runtimeConfig, close: async () => {}, agent: new Agent({
        provider: { complete: async () => { providerCalls++; return { content: "fixture", tool_calls: [] }; } },
        tools: registry, verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
      }) };
    } });
  return { app, registries, cleanup, get providerCalls() { return providerCalls; } };
}

function localFactory(f: ReturnType<typeof fixture>, cfg: NekoConfig) {
  const activations: TaskRuntimeInput[] = [];
  const runtimeFactory = (input: TaskRuntimeInput) => {
    activations.push(input);
    const registry = new ToolRegistry(input.root, "auto", () => false);
    registry.memoryHome = f.home;
    registry.computerInputPolicy = cfg.computerUseInputPolicy;
    registry.disabled.add("computer");
    registry.bindTaskScope(input.scope);
    return { registry, getMessages: () => input.messages, getSourceEvents: () => input.sourceEvents,
      assertQuiescent() {}, close() {} };
  };
  return { runtimeFactory, activations };
}

test("task configuration identity normalizes the background default and binds input policy independently of approval", () => {
  const cfg = fixtureConfig("unused-fixture-home");
  const implicitBackground = taskSessionConfigId(cfg);
  cfg.data.computer_use_input_policy = "background";
  expect(taskSessionConfigId(cfg)).toBe(implicitBackground);
  cfg.data.computer_use_input_policy = "foreground";
  expect(taskSessionConfigId(cfg)).not.toBe(implicitBackground);
  expect(cfg.mode).toBe("auto");
  expect(cfg.sandbox).toBe(false);
});

for (const from of ["background", "foreground"] as const) {
  const to: ComputerInputPolicy = from === "background" ? "foreground" : "background";
  test(`local task resume rejects ${from} to ${to} before runtime construction`, async () => {
    const f = fixture(), cfg = fixtureConfig(f.home);
    cfg.resolvedHome = f.home;
    cfg.data.computer_use_input_policy = from;
    const { runtimeFactory, activations } = localFactory(f, cfg);
    let session: TaskSessionCoordinator<ReturnType<typeof runtimeFactory>> | undefined;
    let unexpected: typeof session;
    try {
      session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local",
        configId: taskSessionConfigId(cfg), label: "Input policy", runtimeFactory });
      const sessionId = session.id, firstActivation = session.active.scope.activationId;
      await session.close(); session = undefined;
      session = await loadTaskSession({ home: f.home, root: f.root, authorityId: "local",
        configId: taskSessionConfigId(cfg), sessionId, runtimeFactory });
      expect(session.active.scope.activationId).not.toBe(firstActivation);
      await session.close(); session = undefined;
      cfg.data.computer_use_input_policy = to;
      await expect(loadTaskSession({ home: f.home, root: f.root, authorityId: "local",
        configId: taskSessionConfigId(cfg), sessionId, runtimeFactory }).then(value => { unexpected = value; return value; }))
        .rejects.toThrow(/configuration changed/);
      expect(activations).toHaveLength(2);
    } finally { await unexpected?.close(); await session?.close(); f.cleanup(); }
  });
}

test("pre-policy v1 task configuration identity requires explicit recovery before a factory can run", async () => {
  const f = fixture(), cfg = fixtureConfig(f.home);
  Object.defineProperty(cfg, "additionalWriteRoots", { get: () => [] });
  const { runtimeFactory, activations } = localFactory(f, cfg);
  let session: TaskSessionCoordinator<ReturnType<typeof runtimeFactory>> | undefined;
  let unexpected: typeof session;
  try {
    session = await createTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: OLD_CONFIG_ID, label: "Old digest fixture", runtimeFactory });
    const sessionId = session.id;
    await session.close(); session = undefined;
    await expect(loadTaskSession({ home: f.home, root: f.root, authorityId: "local",
      configId: taskSessionConfigId(cfg), sessionId, runtimeFactory }).then(value => { unexpected = value; return value; }))
      .rejects.toThrow(/configuration changed/);
    expect(activations).toHaveLength(1);
  } finally { await unexpected?.close(); await session?.close(); f.cleanup(); }
});

test("ACP task-v1 and execution-v1 preserve normalized background and rotate receipts on matching resume", async () => {
  const f = fixture(), cfg = fixtureConfig(f.home), h = harness(f, cfg);
  try {
    await acp.client({ name: "background-receipt-fixture" }).connectWith(h.app(), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      for (const optedIn of [false, true]) {
        const protocolMeta = { "neko.taskProtocol": taskProtocol,
          ...(optedIn ? { "neko.executionProtocol": executionProtocol } : undefined) };
        const created = await ctx.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [], _meta: {
          ...protocolMeta, "neko.taskLabel": "Background", "neko.execution": { interaction: { policy: "foreground" } },
          "neko.computer": { capabilities: ["local-host", "foreground"] },
        } });
        const task: any = created._meta?.["neko.task"], execution: any = created._meta?.["neko.execution"];
        expect(execution).toMatchObject({ bashTarget: "host", approval: { mode: "auto", yolo: false },
          osAuthority: "not-attested", capabilities: { computer: "unavailable" },
          interaction: { policy: "background", scope: "owned-local-computer-helpers",
            appliesToComputer: false, desktopIsolation: "not-attested" } });
        await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId,
          _meta: { "neko.task": taskEcho(task), ...(optedIn ? { "neko.execution": execution } : undefined) } });
        cfg.data.computer_use_input_policy = "background";
        const resumed = await ctx.request(acp.methods.agent.session.resume, { sessionId: created.sessionId,
          cwd: f.root, mcpServers: [], _meta: { ...protocolMeta, "neko.taskExpected": taskExpected(task),
            ...(optedIn ? { "neko.executionExpected": execution } : undefined) } });
        const nextTask: any = resumed._meta?.["neko.task"], nextExecution: any = resumed._meta?.["neko.execution"];
        expect(nextTask.activationEpoch).toBe(task.activationEpoch + 1);
        expect(nextExecution.activationId).not.toBe(execution.activationId);
        expect(nextExecution.interaction).toEqual(execution.interaction);
        expect(nextExecution.authorityId).toBe(execution.authorityId);
        await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId,
          _meta: { "neko.task": taskEcho(nextTask), ...(optedIn ? { "neko.execution": nextExecution } : undefined) } });
      }
      expect(h.registries).toHaveLength(4);
      expect(h.providerCalls).toBe(0);
    });
  } finally { await Promise.allSettled(h.cleanup); f.cleanup(); }
});

for (const optedIn of [false, true]) {
  for (const from of ["background", "foreground"] as const) {
    const to: ComputerInputPolicy = from === "background" ? "foreground" : "background";
    test(`ACP ${optedIn ? "execution-v1" : "task-v1"} reconnect rejects ${from} to ${to} before factory despite forged metadata`, async () => {
      const f = fixture(), cfg = fixtureConfig(f.home);
      cfg.data.computer_use_input_policy = from;
      const h = harness(f, cfg);
      const protocolMeta = { "neko.taskProtocol": taskProtocol,
        ...(optedIn ? { "neko.executionProtocol": executionProtocol } : undefined) };
      let sessionId = "", originalTask: any, originalExecution: any;
      try {
        await acp.client({ name: "input-disconnect-fixture" }).connectWith(h.app(), async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
          const created = await ctx.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [],
            _meta: { ...protocolMeta, "neko.taskLabel": "Reconnect" } });
          sessionId = created.sessionId; originalTask = created._meta?.["neko.task"];
          originalExecution = created._meta?.["neko.execution"];
        });
        await Promise.all(h.cleanup);
        cfg.data.computer_use_input_policy = to;
        await acp.client({ name: "input-reconnect-fixture" }).connectWith(h.app(), async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
          await expect(ctx.request(acp.methods.agent.session.resume, { sessionId, cwd: f.root, mcpServers: [], _meta: {
            ...protocolMeta, "neko.taskExpected": taskExpected(originalTask),
            "neko.executionExpected": { ...originalExecution, interaction: {
              policy: to, scope: "owned-local-computer-helpers", appliesToComputer: true, desktopIsolation: "isolated" } },
            "neko.computerUseInputPolicy": to, "neko.computer": { capabilities: ["local-host", to] },
          } })).rejects.toThrow();
          expect(h.registries).toHaveLength(1);
          expect(h.providerCalls).toBe(0);
        });
      } finally { await Promise.allSettled(h.cleanup); f.cleanup(); }
    });
  }
}

test("trusted ACP authority digest changes with input policy and normalizes the default", async () => {
  const f = fixture(), cfg = fixtureConfig(f.home), h = harness(f, cfg);
  const receipts: any[] = [];
  try {
    await acp.client({ name: "input-authority-digest-fixture" }).connectWith(h.app(), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      for (const policy of [undefined, "background", "foreground", "background"]) {
        cfg.data.computer_use_input_policy = policy;
        const created = await ctx.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [],
          _meta: { "neko.taskProtocol": taskProtocol, "neko.executionProtocol": executionProtocol, "neko.taskLabel": "Digest" } });
        const task: any = created._meta?.["neko.task"], execution: any = created._meta?.["neko.execution"];
        receipts.push(execution);
        await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId,
          _meta: { "neko.task": taskEcho(task), "neko.execution": execution } });
      }
      expect(receipts[1].authorityId).toBe(receipts[0].authorityId);
      expect(receipts[2].authorityId).not.toBe(receipts[1].authorityId);
      expect(receipts[3].authorityId).toBe(receipts[0].authorityId);
      expect(h.providerCalls).toBe(0);
    });
  } finally { await Promise.allSettled(h.cleanup); f.cleanup(); }
});

async function rejectsFactory(name: string, beforeBind?: FactoryMutation, afterBind?: FactoryMutation,
  capabilities: acp.ClientCapabilities = {}) {
  const f = fixture(), cfg = fixtureConfig(f.home), h = harness(f, cfg, beforeBind, afterBind);
  try {
    await acp.client({ name }).connectWith(h.app(), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: capabilities });
      await expect(ctx.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [], _meta: {
        "neko.taskProtocol": taskProtocol, "neko.executionProtocol": executionProtocol, "neko.taskLabel": "Invalid factory",
        "neko.execution": { interaction: { policy: "foreground" }, capabilities: { computer: "local-host" } },
      } })).rejects.toMatchObject({ code: -32000 });
      expect(h.providerCalls).toBe(0);
      expect(h.registries).toHaveLength(1);
      expect(await h.registries[0]!.execute("write_file", { path: "invalid-factory.txt", content: "blocked" }))
        .toContain("activation is retired");
    });
  } finally { await Promise.allSettled(h.cleanup); f.cleanup(); }
}

test("ACP factory admission rejects bound foreground under trusted background", async () => {
  await rejectsFactory("bound-foreground-fixture", registry => { registry.computerInputPolicy = "foreground"; });
});

test("ACP factory admission rejects current policy drift even when its frozen receipt was background", async () => {
  await rejectsFactory("policy-drift-fixture", undefined, registry => { registry.computerInputPolicy = "foreground"; });
});

for (const route of ["local-host", "injected-handler"] as const) {
  test(`ACP computer:false cannot be replaced by ${route} through a custom factory or metadata`, async () => {
    await rejectsFactory(`no-${route}-fixture`, registry => {
      registry.disabled.delete("computer");
      if (route === "injected-handler") registry.computerHandler = () => "fake-handler";
    });
  });
}

for (const route of ["replacement-port", "injected-handler"] as const) {
  test(`ACP negotiated computer identity cannot be replaced by ${route}`, async () => {
    await rejectsFactory(`wrong-${route}-fixture`, registry => {
      registry.computerPort = route === "replacement-port" ? fakePort() : undefined;
      if (route === "injected-handler") registry.computerHandler = () => "fake-handler";
    }, undefined, negotiatedComputer());
  });
}

test("ACP accepts the exact negotiated host port and scopes the receipt to owned local helpers", async () => {
  const f = fixture(), cfg = fixtureConfig(f.home), h = harness(f, cfg);
  try {
    await acp.client({ name: "exact-port-fixture" }).connectWith(h.app(), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: negotiatedComputer() });
      const created = await ctx.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [],
        _meta: { "neko.taskProtocol": taskProtocol, "neko.executionProtocol": executionProtocol, "neko.taskLabel": "Host port" } });
      const task: any = created._meta?.["neko.task"], execution: any = created._meta?.["neko.execution"];
      expect(execution).toMatchObject({ capabilities: { computer: "host-port" }, osAuthority: "not-attested",
        interaction: { policy: "background", scope: "owned-local-computer-helpers",
          appliesToComputer: false, desktopIsolation: "not-attested" } });
      expect(h.registries[0]!.computerPort).toBeDefined();
      await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId,
        _meta: { "neko.task": taskEcho(task), "neko.execution": execution } });
      expect(h.providerCalls).toBe(0);
    });
  } finally { await Promise.allSettled(h.cleanup); f.cleanup(); }
});

test("ACP factory cannot rewrite the trusted input policy used for its own admission", async () => {
  await rejectsFactory("config-mutation-fixture", (registry, _options, runtimeConfig) => {
    runtimeConfig.data.computer_use_input_policy = "foreground";
    registry.computerInputPolicy = "foreground";
  });
});

for (const boundRoute of ["wrong-port", "local-host"] as const) {
  test(`ACP factory publication rejects a bound ${boundRoute} replaced by the expected live port after binding`, async () => {
    await rejectsFactory(`bound-${boundRoute}-drift-fixture`, registry => {
      registry.computerPort = boundRoute === "wrong-port" ? fakePort() : undefined;
    }, (registry, options) => {
      if (options.computer) registry.computerPort = options.computer;
    }, negotiatedComputer());
  });
}

test("ACP factory publication rejects Bash target drift after binding even when its frozen receipt matches config", async () => {
  await rejectsFactory("bound-bash-drift-fixture", undefined, registry => { registry.sandboxBash = true; });
});

test("ACP factory publication preserves a truthful noTools narrowing independently of tool availability", async () => {
  const f = fixture(), cfg = fixtureConfig(f.home);
  const h = harness(f, cfg, registry => { registry.noTools = true; });
  try {
    await acp.client({ name: "no-tools-publication-fixture" }).connectWith(h.app(), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: negotiatedComputer() });
      const created = await ctx.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [],
        _meta: { "neko.taskProtocol": taskProtocol, "neko.executionProtocol": executionProtocol, "neko.taskLabel": "No tools" } });
      const task: any = created._meta?.["neko.task"], execution: any = created._meta?.["neko.execution"];
      expect(execution).toMatchObject({ bashTarget: "host", approval: { mode: "auto", yolo: false },
        capabilities: { toolsDisabled: true, computer: "unavailable" },
        interaction: { policy: "background", appliesToComputer: false } });
      expect(h.registries[0]!.noTools).toBe(true);
      expect(h.registries[0]!.isToolAvailable("computer")).toBe(false);
      expect(h.registries[0]!.computerPort).toBeDefined();
      await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId,
        _meta: { "neko.task": taskEcho(task), "neko.execution": execution } });
      expect(h.providerCalls).toBe(0);
    });
  } finally { await Promise.allSettled(h.cleanup); f.cleanup(); }
});
