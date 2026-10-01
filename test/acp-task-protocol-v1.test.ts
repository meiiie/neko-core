import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNekoAcpAgent } from "../src/adapters/acp.ts";
import { loadConfig } from "../src/adapters/config.ts";
import { newSessionId, saveSession, setSessionsDir } from "../src/adapters/session.ts";
import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

const protocol = { version: 1, mode: "fixed-active-task" } as const;

interface Receipt {
  version: 1;
  mode: "fixed-active-task";
  id: string;
  label: string;
  root: string;
  activationEpoch: number;
  activationId: string;
}

function taskReceipt(raw: any): Receipt {
  if (!raw) throw new Error("Missing task activation receipt");
  // SAFETY: assertions below validate every receipt field used by this in-memory protocol fixture.
  const receipt = raw as Receipt;
  expect(receipt).toMatchObject(protocol);
  expect(receipt.id).toMatch(/^[a-f0-9]{32}$/);
  expect(receipt.activationEpoch).toBeGreaterThan(0);
  expect(receipt.activationId).toMatch(/^[a-f0-9]{32}$/);
  return receipt;
}

function echo(receipt: Receipt) {
  return { version: 1, id: receipt.id,
    activationEpoch: receipt.activationEpoch, activationId: receipt.activationId };
}

function expected(receipt: Receipt) {
  return { id: receipt.id, root: receipt.root,
    activationEpoch: receipt.activationEpoch, activationId: receipt.activationId };
}

test("ACP v1 fixed task requires echoes and tags pre-response updates, permission, and prompt result", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-v1-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-v1-home-"));
  try {
    writeFileSync(join(root, "sample.txt"), "old", "utf8");
    const cfg = loadConfig({ cwd: root, home });
    cfg.data.mode = "default";
    let builds = 0;
    let providerCalls = 0;
    let permissionCalls = 0;
    const updates: any[] = [];
    const permissions: any[] = [];
    const app = createNekoAcpAgent({
      config: cfg,
      buildRuntime: async (runtimeConfig, options) => {
        builds++;
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        registry.memoryHome = runtimeConfig.resolvedHome;
        registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
        if (options.computer === false) registry.disabled.add("computer");
        else if (options.computer) registry.computerPort = options.computer;
        if (options.taskScope) registry.bindTaskScope(options.taskScope);
        return {
          agent: new Agent({
            provider: { complete: async () => {
              providerCalls++;
              return providerCalls === 1
                ? { content: null, tool_calls: [{ id: "edit-v1", name: "edit",
                  arguments: { path: "sample.txt", old_string: "old", new_string: "new" } }] }
                : { content: "The edit was denied.", tool_calls: [] };
            } },
            tools: registry, maxSteps: 3,
            onDelta: options.onDelta, onEvent: options.onEvent, onCheckpoint: options.onCheckpoint,
            verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
          }),
          registry, config: runtimeConfig, close: async () => {},
        };
      },
    });
    await acp.client({ name: "fixed-task-v1" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissions.push(params);
        permissionCalls++;
        return { outcome: { outcome: "selected", optionId: "reject_once" } };
      })
      .connectWith(app, async (ctx) => {
        const initialized = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        expect(acp.PROTOCOL_VERSION).toBe(1);
        expect(initialized._meta?.["neko.taskProtocol"]).toEqual(protocol);
        await expect(ctx.request(acp.methods.agent.session.new, {
          cwd: root, mcpServers: [], _meta: { "neko.taskProtocol": protocol },
        })).rejects.toThrow();
        await expect(ctx.request(acp.methods.agent.session.new, {
          cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Task A",
            "neko.taskProtocol": { version: 2, mode: "fixed-active-task" } },
        })).rejects.toThrow();
        expect(builds).toBe(0);

        const created = await ctx.request(acp.methods.agent.session.new, {
          cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Task A", "neko.taskProtocol": protocol },
        });
        const receipt = taskReceipt(created._meta?.["neko.task"]);
        expect(receipt.label).toBe("Task A");
        // Receipts bind the physical root, including macOS /var aliases and Windows casing.
        const physicalRoot = realpathSync.native(root);
        expect(receipt.root).toBe(process.platform === "win32" ? physicalRoot.toLowerCase() : physicalRoot);
        expect(updates.length).toBeGreaterThan(0); // attach emitted these before the new response.
        expect(updates.every((params) => params.sessionId === created.sessionId
          && JSON.stringify(params._meta?.["neko.task"]) === JSON.stringify(receipt))).toBe(true);
        const announcedTask = updates.find((params) => params.update.sessionUpdate === "available_commands_update")
          ?.update.availableCommands.find((command: { name: string }) => command.name === "task");
        expect(announcedTask?.description).toContain("list or status");
        expect(announcedTask?.description).not.toContain("use <id>");

        const beforeHelp = updates.length;
        const help = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId, prompt: [{ type: "text", text: "/help" }],
          _meta: { "neko.task": echo(receipt) },
        });
        expect(help.stopReason).toBe("end_turn");
        const helpText = updates.slice(beforeHelp).find((params) => params.update.sessionUpdate === "agent_message_chunk")
          ?.update.content.text;
        expect(helpText).toContain("list or status");
        expect(helpText).not.toContain("use <id>");
        expect(providerCalls).toBe(0);

        await expect(ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId, prompt: [{ type: "text", text: "Edit sample.txt." }],
        })).rejects.toThrow();
        await expect(ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId, prompt: [{ type: "text", text: "Edit sample.txt." }],
          _meta: { "neko.task": { ...echo(receipt), activationId: "stale" } },
        })).rejects.toThrow();
        expect(providerCalls).toBe(0);
        await expect(ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId, prompt: [{ type: "text", text: "/task new Task B" }],
          _meta: { "neko.task": echo(receipt) },
        })).rejects.toThrow();
        await expect(ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId, prompt: [{ type: "text", text: `/task use ${receipt.id}` }],
          _meta: { "neko.task": echo(receipt) },
        })).rejects.toThrow();
        expect(providerCalls).toBe(0);

        const prompt = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId, prompt: [{ type: "text", text: "Edit sample.txt if approved." }],
          _meta: { "neko.task": echo(receipt) },
        });
        expect(prompt.stopReason).toBe("end_turn");
        expect(prompt._meta?.["neko.task"]).toEqual(receipt);
        expect(providerCalls).toBe(2);
        expect(permissionCalls).toBe(1);
        expect(permissions[0]._meta?.["neko.task"]).toEqual(receipt);
        expect(updates.every((params) => params._meta?.["neko.task"]?.activationId === receipt.activationId))
          .toBe(true);
        expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("old");

        await expect(ctx.request(acp.methods.agent.session.close, {
          sessionId: created.sessionId,
        })).rejects.toThrow();
        const closed = await ctx.request(acp.methods.agent.session.close, {
          sessionId: created.sessionId, _meta: { "neko.task": echo(receipt) },
        });
        expect(closed._meta?.["neko.task"]).toEqual(receipt);

        const legacy = await ctx.request(acp.methods.agent.session.new, {
          cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Legacy Task" },
        });
        expect(legacy._meta?.["neko.task"]).not.toHaveProperty("activationEpoch");
        const legacyTask = updates.filter((params) => params.update.sessionUpdate === "available_commands_update")
          .at(-1)?.update.availableCommands.find((command: { name: string }) => command.name === "task");
        expect(legacyTask?.description).toContain("use <id>");
        expect((await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: legacy.sessionId, prompt: [{ type: "text", text: "/task new Legacy B" }],
        })).stopReason).toBe("end_turn");
        await ctx.request(acp.methods.agent.session.close, { sessionId: legacy.sessionId });
      });
  } finally {
    for (const path of [root, home]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP v1 load and resume require expected activation and ignore stale cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-v1-load-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-v1-load-home-"));
  const v2Store = mkdtempSync(join(tmpdir(), "neko-acp-v1-collision-"));
  setSessionsDir(v2Store);
  try {
    const cfg = loadConfig({ cwd: root, home });
    let builds = 0;
    let providerCalls = 0;
    let providerAborted = false;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const app = () => createNekoAcpAgent({
      config: cfg,
      buildRuntime: async (runtimeConfig, options) => {
        const build = ++builds;
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        registry.memoryHome = runtimeConfig.resolvedHome;
        registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
        if (options.computer === false) registry.disabled.add("computer");
        else if (options.computer) registry.computerPort = options.computer;
        if (options.taskScope) registry.bindTaskScope(options.taskScope);
        return {
          agent: new Agent({
            provider: { complete: async (_messages, _tools, _delta, signal) => {
              providerCalls++;
              if (build !== 2) return { content: "done", tool_calls: [] };
              started();
              return new Promise((resolve, reject) => {
                signal?.addEventListener("abort", () => {
                  providerAborted = true;
                  reject(new DOMException("aborted", "AbortError"));
                }, { once: true });
              });
            } },
            tools: registry, maxSteps: 2,
            onDelta: options.onDelta, onEvent: options.onEvent, onCheckpoint: options.onCheckpoint,
            verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
          }),
          registry, config: runtimeConfig, close: async () => {},
        };
      },
    });
    let sessionId = "";
    let first!: Receipt;
    await acp.client({ name: "fixed-task-create" }).connectWith(app(), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      const created = await ctx.request(acp.methods.agent.session.new, {
        cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Task A", "neko.taskProtocol": protocol },
      });
      sessionId = created.sessionId;
      first = taskReceipt(created._meta?.["neko.task"]);
      const closed = await ctx.request(acp.methods.agent.session.close, {
        sessionId, _meta: { "neko.task": echo(first) },
      });
      expect(closed._meta?.["neko.task"]).toEqual(first);
    });
    expect(builds).toBe(1);
    // A colliding legacy record must never win routing over this v1-bound task session.
    const now = new Date().toISOString();
    saveSession({ id: sessionId, createdAt: now, updatedAt: now, cwd: root,
      profile: "__legacy_profile_must_never_load__",
      model: cfg.model, provider: cfg.provider, messages: [] });

    const updates: any[] = [];
    let second!: Receipt;
    await acp.client({ name: "fixed-task-load" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); })
      .connectWith(app(), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        await expect(ctx.request(acp.methods.agent.session.load, {
          sessionId, cwd: root, mcpServers: [],
        })).rejects.toThrow();
        await expect(ctx.request(acp.methods.agent.session.load, {
          sessionId, cwd: root, mcpServers: [], _meta: { "neko.taskProtocol": protocol },
        })).rejects.toThrow();
        await expect(ctx.request(acp.methods.agent.session.load, {
          sessionId, cwd: root, mcpServers: [], _meta: { "neko.taskProtocol": protocol,
            "neko.taskExpected": { ...expected(first), activationEpoch: first.activationEpoch + 1 } },
        })).rejects.toThrow();
        await expect(ctx.request(acp.methods.agent.session.load, {
          sessionId, cwd: root, mcpServers: [], _meta: { "neko.taskProtocol": protocol,
            "neko.taskExpected": { ...expected(first), root: home } },
        })).rejects.toThrow();
        expect(builds).toBe(1); // Every rejected load must stop before constructing a runtime.

        const loaded = await ctx.request(acp.methods.agent.session.load, {
          sessionId, cwd: root, mcpServers: [], _meta: { "neko.taskProtocol": protocol,
            "neko.taskExpected": expected(first) },
        });
        second = taskReceipt(loaded._meta?.["neko.task"]);
        expect(loaded._meta?.["neko.taskRecovery"]).toBeUndefined();
        expect(second.id).toBe(first.id);
        expect(second.activationEpoch).toBe(first.activationEpoch + 1);
        expect(second.activationId).not.toBe(first.activationId);
        expect(builds).toBe(2);
        expect(updates.length).toBeGreaterThan(0);
        expect(updates.every((params) => params.sessionId === sessionId
          && JSON.stringify(params._meta?.["neko.task"]) === JSON.stringify(second))).toBe(true);

        // A contender on this same ACP app must use the same typed recovery contract
        // as a contender on a separate AgentApp/connection; neither may activate a runtime.
        await expect(ctx.request(acp.methods.agent.session.load, {
          sessionId, cwd: root, mcpServers: [], _meta: { "neko.taskProtocol": protocol,
            "neko.taskExpected": expected(second) },
        })).rejects.toMatchObject({ code: -32002, data: { "neko.taskError": {
          version: 1, kind: "writer_unavailable", action: "retain_mapping_and_request_recovery",
        } } });
        expect(builds).toBe(2);
        await expect(ctx.request(acp.methods.agent.session.resume, {
          sessionId, cwd: root, mcpServers: [], _meta: { "neko.taskProtocol": protocol,
            "neko.taskExpected": expected(second) },
        })).rejects.toMatchObject({ code: -32002, data: { "neko.taskError": {
          version: 1, kind: "writer_unavailable", action: "retain_mapping_and_request_recovery",
        } } });
        expect(builds).toBe(2);

        await acp.client({ name: "fixed-task-lock-contender" }).connectWith(app(), async (contender) => {
          await contender.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
          });
          await expect(contender.request(acp.methods.agent.session.load, {
            sessionId, cwd: root, mcpServers: [], _meta: { "neko.taskProtocol": protocol,
              "neko.taskExpected": expected(second) },
          })).rejects.toMatchObject({ code: -32002, data: { "neko.taskError": {
            version: 1, kind: "writer_unavailable", action: "retain_mapping_and_request_recovery",
          } } });
        });

        const running = ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: "Wait until cancelled." }],
          _meta: { "neko.task": echo(second) },
        });
        await didStart;
        await ctx.notify(acp.methods.agent.session.cancel, {
          sessionId,
        });
        expect(providerAborted).toBe(false);
        await ctx.notify(acp.methods.agent.session.cancel, {
          sessionId, _meta: { "neko.task": echo(first) },
        });
        expect(providerAborted).toBe(false);
        await ctx.notify(acp.methods.agent.session.cancel, {
          sessionId, _meta: { "neko.task": echo(second) },
        });
        expect((await running).stopReason).toBe("cancelled");
        expect(providerAborted).toBe(true);
        expect(providerCalls).toBe(1);
        await expect(ctx.request(acp.methods.agent.session.close, {
          sessionId, _meta: { "neko.task": echo(first) },
        })).rejects.toThrow();
        const closed = await ctx.request(acp.methods.agent.session.close, {
          sessionId, _meta: { "neko.task": echo(second) },
        });
        expect(closed._meta?.["neko.task"]).toEqual(second);
        await expect(ctx.request(acp.methods.agent.session.close, {
          sessionId, _meta: { "neko.task": echo(second) },
        })).rejects.toThrow();
      });

    let third!: Receipt;
    await acp.client({ name: "fixed-task-resume" }).connectWith(app(), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      const resumed = await ctx.request(acp.methods.agent.session.resume, {
        sessionId, cwd: root, mcpServers: [], _meta: { "neko.taskProtocol": protocol,
          "neko.taskExpected": expected(second) },
      });
      third = taskReceipt(resumed._meta?.["neko.task"]);
      expect(third.activationEpoch).toBe(second.activationEpoch + 1);
      expect(third.activationId).not.toBe(second.activationId);
      expect(resumed._meta?.["neko.taskRecovery"]).toBeUndefined();
      await ctx.request(acp.methods.agent.session.close, {
        sessionId, _meta: { "neko.task": echo(third) },
      });
    });

    // A lost load response can be retried once using the immediate prior receipt.
    // The retry creates a fresh activation; an older receipt cannot be replayed again.
    await acp.client({ name: "fixed-task-retry" }).connectWith(app(), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      const retried = await ctx.request(acp.methods.agent.session.load, {
        sessionId, cwd: root, mcpServers: [], _meta: { "neko.taskProtocol": protocol,
          "neko.taskExpected": expected(second) },
      });
      const fourth = taskReceipt(retried._meta?.["neko.task"]);
      expect(retried._meta?.["neko.taskRecovery"]).toEqual({ version: 1, kind: "prior_receipt_retry" });
      expect(fourth.activationEpoch).toBe(third.activationEpoch + 1);
      expect(fourth.activationId).not.toBe(third.activationId);
      await ctx.request(acp.methods.agent.session.close, {
        sessionId, _meta: { "neko.task": echo(fourth) },
      });
      await expect(ctx.request(acp.methods.agent.session.load, {
        sessionId, cwd: root, mcpServers: [], _meta: { "neko.taskProtocol": protocol,
          "neko.taskExpected": expected(first) },
      })).rejects.toMatchObject({ code: -32002, data: { "neko.taskError": {
        version: 1, kind: "recovery_required", action: "retain_mapping_and_request_recovery",
      } } });
    });
  } finally {
    setSessionsDir(null);
    for (const path of [root, home, v2Store]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP legacy load still selects its saved profile after probing the task store", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-v0-profile-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-v0-profile-home-"));
  const v2Store = mkdtempSync(join(tmpdir(), "neko-acp-v0-profile-store-"));
  setSessionsDir(v2Store);
  try {
    const defaultConfig = loadConfig({ cwd: root, home });
    const savedProfile = Object.keys(defaultConfig.profiles).find((name) => name !== defaultConfig.profile);
    if (!savedProfile) throw new Error("The fixture needs two built-in profiles");
    const savedConfig = loadConfig({ cwd: root, home, profile: savedProfile });
    const id = newSessionId();
    const now = new Date().toISOString();
    saveSession({ id, createdAt: now, updatedAt: now, cwd: root, profile: savedProfile,
      model: savedConfig.model, provider: savedConfig.provider, messages: [] });
    const builtProfiles: (string | null)[] = [];
    const app = createNekoAcpAgent({
      configForRoot: (_root, profile) => loadConfig({ cwd: root, home,
        ...(profile ? { profile } : undefined) }),
      buildRuntime: async (runtimeConfig, options) => {
        builtProfiles.push(runtimeConfig.profile);
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        return { agent: new Agent({
          provider: { complete: async () => { throw new Error("Legacy profile load must not call a model"); } },
          tools: registry,
        }), registry, config: runtimeConfig, close: async () => {} };
      },
    });
    await acp.client({ name: "legacy-profile-restore" }).connectWith(app, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      const loaded = await ctx.request(acp.methods.agent.session.load, {
        sessionId: id, cwd: root, mcpServers: [],
      });
      expect(loaded._meta?.["neko.task"]).toBeUndefined();
      expect(builtProfiles).toEqual([savedProfile]);
      expect(await ctx.request(acp.methods.agent.session.close, { sessionId: id })).toEqual({});
    });
  } finally {
    setSessionsDir(null);
    for (const path of [root, home, v2Store]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP v1 cancel keeps a later tool result tagged and ordered before the terminal receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-v1-late-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-v1-late-home-"));
  try {
    writeFileSync(join(root, "sample.txt"), "unchanged", "utf8");
    const cfg = loadConfig({ cwd: root, home });
    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((resolve) => { releaseTool = resolve; });
    let sawToolCall!: () => void;
    const toolCallSeen = new Promise<void>((resolve) => { sawToolCall = resolve; });
    const wire: string[] = [];
    const updates: any[] = [];
    let clientToolState = "pending";
    let providerCalls = 0;
    const app = createNekoAcpAgent({
      config: cfg,
      buildRuntime: async (runtimeConfig, options) => {
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        registry.memoryHome = runtimeConfig.resolvedHome;
        registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
        if (options.computer === false) registry.disabled.add("computer");
        else if (options.computer) registry.computerPort = options.computer;
        if (options.taskScope) registry.bindTaskScope(options.taskScope);
        const originalExecute = registry.execute.bind(registry);
        registry.execute = async (...args: Parameters<typeof originalExecute>) => {
          if (args[0] !== "read_file") return originalExecute(...args);
          await toolReleased;
          return "Synthetic read completed after the client sent cancel.";
        };
        return { agent: new Agent({
          provider: { complete: async () => {
            providerCalls++;
            return { content: null, tool_calls: [{ id: "late-read-v1", name: "read_file",
              arguments: { path: "sample.txt" } }] };
          } },
          tools: registry, maxSteps: 2,
          onDelta: options.onDelta, onEvent: options.onEvent, onCheckpoint: options.onCheckpoint,
          verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
        }), registry, config: runtimeConfig, close: async () => {} };
      },
    });
    await acp.client({ name: "fixed-task-cancel-late-tool" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
        if (params.update.sessionUpdate === "tool_call" && params.update.toolCallId === "late-read-v1") {
          wire.push("tool_call");
          sawToolCall();
        }
        if (params.update.sessionUpdate === "tool_call_update" && params.update.toolCallId === "late-read-v1") {
          wire.push("tool_call_update");
          clientToolState = params.update.status ?? "unknown";
        }
      })
      .connectWith(app, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        const created = await ctx.request(acp.methods.agent.session.new, {
          cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Late read", "neko.taskProtocol": protocol },
        });
        const receipt = taskReceipt(created._meta?.["neko.task"]);
        const running = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId, prompt: [{ type: "text", text: "Read sample.txt." }],
          _meta: { "neko.task": echo(receipt) },
        });
        await toolCallSeen;
        clientToolState = "provisional_cancelled"; // ACP client may show this locally on cancel send.
        wire.push("client_provisional_cancelled");
        await ctx.notify(acp.methods.agent.session.cancel, {
          sessionId: created.sessionId, _meta: { "neko.task": echo(receipt) },
        });
        releaseTool();
        const result = await running;
        wire.push("prompt_cancelled");
        expect(result.stopReason).toBe("cancelled");
        expect(result._meta?.["neko.task"]).toEqual(receipt);
        expect(wire).toEqual(["tool_call", "client_provisional_cancelled", "tool_call_update", "prompt_cancelled"]);
        expect(clientToolState).toBe("completed");
        expect(updates.filter((params) => params.update.sessionUpdate === "tool_call_update"
          && params.update.toolCallId === "late-read-v1")).toHaveLength(1);
        expect(updates.filter((params) => params.update.sessionUpdate === "tool_call"
          || params.update.sessionUpdate === "tool_call_update")
          .every((params) => params.sessionId === created.sessionId
            && JSON.stringify(params._meta?.["neko.task"]) === JSON.stringify(receipt))).toBe(true);
        expect(providerCalls).toBe(1);
        expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("unchanged");
        await ctx.request(acp.methods.agent.session.close, {
          sessionId: created.sessionId, _meta: { "neko.task": echo(receipt) },
        });
      });
  } finally {
    for (const path of [root, home]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP v1 cancellation while approval is pending ends the turn without executing the edit", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-v1-approval-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-v1-approval-home-"));
  try {
    writeFileSync(join(root, "sample.txt"), "old", "utf8");
    const cfg = loadConfig({ cwd: root, home });
    cfg.data.mode = "default";
    let permissionStarted!: () => void;
    const requestSeen = new Promise<void>((resolve) => { permissionStarted = resolve; });
    let providerCalls = 0;
    let permissionCalls = 0;
    let permissionSignalAborted = false;
    const updates: any[] = [];
    const app = createNekoAcpAgent({
      config: cfg,
      buildRuntime: async (runtimeConfig, options) => {
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        registry.memoryHome = runtimeConfig.resolvedHome;
        registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
        if (options.computer === false) registry.disabled.add("computer");
        else if (options.computer) registry.computerPort = options.computer;
        if (options.taskScope) registry.bindTaskScope(options.taskScope);
        return { agent: new Agent({
          provider: { complete: async () => {
            providerCalls++;
            return { content: null, tool_calls: [{ id: "approval-edit-v1", name: "edit",
              arguments: { path: "sample.txt", old_string: "old", new_string: "new" } }] };
          } },
          tools: registry, maxSteps: 2,
          onDelta: options.onDelta, onEvent: options.onEvent, onCheckpoint: options.onCheckpoint,
          verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
        }), registry, config: runtimeConfig, close: async () => {} };
      },
    });
    await acp.client({ name: "fixed-task-cancel-approval" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); })
      .onRequest(acp.methods.client.session.requestPermission, ({ signal }) => {
        permissionCalls++;
        permissionStarted();
        return new Promise<{ outcome: { outcome: "cancelled" } }>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Permission cancel signal was not delivered")), 1_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            permissionSignalAborted = true;
            resolve({ outcome: { outcome: "cancelled" } });
          }, { once: true });
        });
      })
      .connectWith(app, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        const created = await ctx.request(acp.methods.agent.session.new, {
          cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Approval cancel", "neko.taskProtocol": protocol },
        });
        const receipt = taskReceipt(created._meta?.["neko.task"]);
        const running = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId, prompt: [{ type: "text", text: "Edit sample.txt." }],
          _meta: { "neko.task": echo(receipt) },
        });
        await requestSeen;
        await ctx.notify(acp.methods.agent.session.cancel, {
          sessionId: created.sessionId, _meta: { "neko.task": echo(receipt) },
        });
        const result = await running;
        expect(result.stopReason).toBe("cancelled");
        expect(result._meta?.["neko.task"]).toEqual(receipt);
        expect(permissionCalls).toBe(1);
        expect(permissionSignalAborted).toBe(true);
        expect(providerCalls).toBe(1);
        expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("old");
        const toolResults = updates.filter((params) => params.update.sessionUpdate === "tool_call_update"
          && params.update.toolCallId === "approval-edit-v1");
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].update.status).toBe("failed");
        expect(toolResults[0].sessionId).toBe(created.sessionId);
        expect(toolResults[0]._meta?.["neko.task"]).toEqual(receipt);
        await ctx.request(acp.methods.agent.session.close, {
          sessionId: created.sessionId, _meta: { "neko.task": echo(receipt) },
        });
      });
  } finally {
    for (const path of [root, home]) rmSync(path, { recursive: true, force: true });
  }
});
