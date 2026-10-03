import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNekoAcpAgent } from "../src/adapters/acp.ts";
import type { BuildAgentRuntimeOptions } from "../src/adapters/agent-runtime.ts";
import { loadConfig } from "../src/adapters/config.ts";
import { productionTurnContext } from "../src/adapters/turn-context.ts";
import { loadSession, setSessionsDir } from "../src/adapters/session.ts";
import { Agent } from "../src/core/agent.ts";
import { memoryTool } from "../src/core/memory.ts";
import type { PermissionMode } from "../src/core/permissions.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

test("ACP opt-in task session switches A→B→A and resumes only the active working transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-task-root-"));
  const other = mkdtempSync(join(tmpdir(), "neko-acp-task-other-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-task-home-"));
  const v2Store = mkdtempSync(join(tmpdir(), "neko-acp-task-v2-"));
  setSessionsDir(v2Store);
  try {
    const cfg = loadConfig({ cwd: root, home });
    const calls: { taskId: string; input: string }[] = [];
    const registries = new Map<string, ToolRegistry>();
    const app = (selectedConfig = cfg) => createNekoAcpAgent({
      config: selectedConfig,
      buildRuntime: async (runtimeConfig, options) => {
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        registry.memoryHome = runtimeConfig.resolvedHome;
        registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
        if (options.computer === false) registry.disabled.add("computer");
        else if (options.computer) registry.computerPort = options.computer;
        if (options.taskScope) registry.bindTaskScope(options.taskScope);
        const taskId = registry.taskScope?.id ?? "legacy";
        registries.set(taskId, registry);
        return {
          agent: new Agent({
            provider: { complete: async (messages) => {
              calls.push({ taskId, input: JSON.stringify(messages) });
              return { content: "fixture answer", tool_calls: [] };
            } },
            tools: registry,
            maxSteps: 2,
            onDelta: options.onDelta,
            onEvent: options.onEvent,
            dynamicContext: () => productionTurnContext(registry, {
              model: runtimeConfig.model, provider: runtimeConfig.provider,
              home: runtimeConfig.resolvedHome,
            }),
            verifyBeforeExit: false,
            verifyStateChangesBeforeExit: false,
          }),
          registry,
          config: runtimeConfig,
          close: async () => {},
        };
      },
    });
    expect(memoryTool({ action: "write", name: "stack.md", content: "LEGACY-SECRET" }, home))
      .toContain("Saved memory");

    let sessionId = "";
    let taskA = "";
    let taskB = "";
    let initialMode: PermissionMode = cfg.mode;
    const updates: acp.SessionUpdate[] = [];
    await acp.client({ name: "task-new" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); })
      .connectWith(app(), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        const created = await ctx.request(acp.methods.agent.session.new, {
          cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Task A" },
        });
        sessionId = created.sessionId;
        // SAFETY: this in-memory client receives the response produced by this test's Neko task-mode handler.
        taskA = (created._meta?.["neko.task"] as { id: string }).id;
        expect(registries.get(taskA)?.taskScope?.id).toBe(taskA);
        initialMode = registries.get(taskA)!.mode;
        expect(loadSession(sessionId)).toBeNull();
        await expect(ctx.request(acp.methods.agent.session.setMode, {
          sessionId, modeId: "plan",
        })).rejects.toThrow("cannot change mode");
        await expect(ctx.request(acp.methods.agent.session.setConfigOption, {
          sessionId, configId: "reasoning_effort", value: "high",
        })).rejects.toThrow("cannot change provider or model configuration");
        expect(registries.get(taskA)?.mode).toBe(initialMode);
        expect(memoryTool({ action: "write", name: "stack.md", content: "A-PNPM" }, home,
          registries.get(taskA)!.taskScope)).toContain("Saved memory");
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: "Task A uses pnpm." }],
        });
        expect(calls.at(-1)?.taskId).toBe(taskA);
        expect(calls.at(-1)?.input).toContain("A-PNPM");
        expect(calls.at(-1)?.input).not.toContain("LEGACY-SECRET");

        const beforeCommand = calls.length;
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: "/task new Task B" }],
        });
        expect(calls).toHaveLength(beforeCommand);
        const createdText = updates.filter((item) => item.sessionUpdate === "agent_message_chunk")
          .map((item) => item.content.type === "text" ? item.content.text : "")
          .findLast((item) => item.startsWith("Created inactive task")) ?? "";
        taskB = /Created inactive task ([a-f0-9]{32})/.exec(createdText)?.[1] ?? "";
        expect(taskB).toMatch(/^[a-f0-9]{32}$/);
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: `/task use ${taskB}` }],
        });
        expect(registries.get(taskB)?.taskScope?.id).toBe(taskB);
        expect(registries.get(taskB)?.mode).toBe(initialMode);
        expect(memoryTool({ action: "write", name: "stack.md", content: "B-BUN" }, home,
          registries.get(taskB)!.taskScope)).toContain("Saved memory");
        expect(memoryTool({ action: "read", name: "stack.md" }, home, registries.get(taskB)!.taskScope))
          .toBe("B-BUN");
        expect(memoryTool({ action: "search", query: "A-PNPM" }, home, registries.get(taskB)!.taskScope))
          .toContain("no memory matches");
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: "Task B uses bun." }],
        });
        const bInput = calls.at(-1)!;
        expect(bInput.taskId).toBe(taskB);
        expect(bInput.input).toContain("B-BUN");
        expect(bInput.input).not.toContain("A-PNPM");
        expect(bInput.input).not.toContain("Task A uses pnpm");
        expect(bInput.input).not.toContain("LEGACY-SECRET");

        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: `/task use ${taskA}` }],
        });
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: "Continue task A." }],
        });
        const aAgain = calls.at(-1)!;
        expect(aAgain.taskId).toBe(taskA);
        expect(aAgain.input).toContain("Task A uses pnpm");
        expect(aAgain.input).toContain("A-PNPM");
        expect(aAgain.input).not.toContain("Task B uses bun");
        expect(aAgain.input).not.toContain("B-BUN");
        await ctx.request(acp.methods.agent.session.close, { sessionId });
      });

    expect(loadSession(sessionId)).toBeNull();
    const altered = cfg.withModel("different-model-must-not-run");
    const callsBeforeRejectedLoad = calls.length;
    await acp.client({ name: "task-config-mismatch" }).connectWith(app(altered), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      await expect(ctx.request(acp.methods.agent.session.resume, {
        sessionId, cwd: root, mcpServers: [],
      })).rejects.toThrow("provider or safety configuration changed");
    });
    expect(calls).toHaveLength(callsBeforeRejectedLoad);
    const replay: acp.SessionUpdate[] = [];
    await acp.client({ name: "task-resume" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { replay.push(params.update); })
      .connectWith(app(), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        await expect(ctx.request(acp.methods.agent.session.load, {
          sessionId, cwd: other, mcpServers: [],
        })).rejects.toThrow(/root changed|not host-authorized/i);
        await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: root, mcpServers: [] });
        expect(registries.get(taskA)?.mode).toBe(initialMode);
        const replayText = replay.filter((item) => item.sessionUpdate === "user_message_chunk")
          .map((item) => item.content.type === "text" ? item.content.text : "").join("\n");
        expect(replayText).toContain("Task A uses pnpm");
        expect(replayText).not.toContain("Task B uses bun");
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: "After restart in task A." }],
        });
        const restored = calls.at(-1)!;
        expect(restored.taskId).toBe(taskA);
        expect(restored.input).toContain("Task A uses pnpm");
        expect(restored.input).not.toContain("Task B uses bun");
        await ctx.request(acp.methods.agent.session.close, { sessionId });
      });
  } finally {
    setSessionsDir(null);
    for (const path of [root, other, home, v2Store]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP v3 denied edit has one result across task switches and session/load replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-task-denial-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-task-denial-home-"));
  try {
    writeFileSync(join(root, "sample.txt"), "old", "utf8");
    const cfg = loadConfig({ cwd: root, home });
    cfg.data.mode = "default";
    const toolId = "deny-edit-task-1";
    const deniedText = "Denied by user: edit (edit sample.txt)";
    let builds = 0;
    let permissionRequests = 0;
    let taskBProviderCalls = 0;
    let replayProviderCalls = 0;
    let replayToolExecutions = 0;
    let followUpHistory: any[] = [];
    let taskBHistory: any[] = [];
    let taskAHistoryAfterSwitch: any[] = [];
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
        if (build === 4) {
          const execute = registry.execute.bind(registry);
          registry.execute = async (...args: Parameters<typeof execute>) => {
            replayToolExecutions++;
            return execute(...args);
          };
        }
        let calls = 0;
        return {
          agent: new Agent({
            provider: { complete: async (messages) => {
              calls++;
              if (build === 1) {
                if (calls === 1) return { content: null, tool_calls: [{ id: toolId, name: "edit",
                  arguments: { path: "sample.txt", old_string: "old", new_string: "new" } }] };
                followUpHistory = structuredClone(messages);
                return { content: "Denied edit; sample.txt remains old.", tool_calls: [] };
              }
              if (build === 2) {
                taskBProviderCalls++;
                taskBHistory = structuredClone(messages);
                return { content: "Task B has its own history.", tool_calls: [] };
              }
              if (build === 3) {
                taskAHistoryAfterSwitch = structuredClone(messages);
                return { content: "Task A resumed.", tool_calls: [] };
              }
              replayProviderCalls++;
              throw new Error("ACP session/load must not call the provider");
            } },
            tools: registry, maxSteps: 3,
            onDelta: options.onDelta, onEvent: options.onEvent,
            verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
          }),
          registry, config: runtimeConfig, close: async () => {},
        };
      },
    });
    const liveUpdates: acp.SessionUpdate[] = [];
    const commandText: string[] = [];
    let sessionId = "";
    let taskA = "";
    await acp.client({ name: "task-denial-live" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissionRequests++;
        expect(params.toolCall.toolCallId).toBe(toolId);
        return { outcome: { outcome: "selected", optionId: "reject_once" } };
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        liveUpdates.push(params.update);
        if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
          commandText.push(params.update.content.text);
        }
      })
      .connectWith(app(), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        const created = await ctx.request(acp.methods.agent.session.new, {
          cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Task A" },
        });
        sessionId = created.sessionId;
        // SAFETY: this in-memory client receives the response from this test's task-mode handler.
        taskA = (created._meta?.["neko.task"] as { id: string }).id;
        const result = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: "Edit sample.txt only if approved." }],
        });
        expect(result.stopReason).toBe("end_turn");
        expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("old");
        expect(permissionRequests).toBe(1);
        const providerResults = followUpHistory.filter((item) => item.role === "tool" && item.tool_call_id === toolId);
        expect(providerResults).toHaveLength(1);
        expect(providerResults[0].content).toBe(deniedText);
        expect(liveUpdates.filter((item) => item.sessionUpdate === "tool_call" && item.toolCallId === toolId))
          .toHaveLength(1);
        expect(liveUpdates.filter((item) => item.sessionUpdate === "tool_call_update"
          && item.toolCallId === toolId)).toEqual([expect.objectContaining({ status: "failed", rawOutput: deniedText })]);

        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: "/task new Task B" }],
        });
        const taskB = /Created inactive task ([a-f0-9]{32})/.exec(commandText.join("\n"))?.[1] ?? "";
        expect(taskB).toMatch(/^[a-f0-9]{32}$/);
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: `/task use ${taskB}` }],
        });
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: "Show Task B context." }],
        });
        expect(taskBProviderCalls).toBe(1);
        expect(taskBHistory.some((item) => item.role === "user"
          && String(item.content).includes("Show Task B context."))).toBe(true);
        expect(JSON.stringify(taskBHistory)).not.toContain(toolId);
        expect(JSON.stringify(taskBHistory)).not.toContain("Denied edit");
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: `/task use ${taskA}` }],
        });
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: "Show Task A context." }],
        });
        expect(taskAHistoryAfterSwitch.filter((item) => item.role === "tool"
          && item.tool_call_id === toolId)).toHaveLength(1);
        expect(JSON.stringify(taskAHistoryAfterSwitch)).not.toContain("Show Task B context");
        await ctx.request(acp.methods.agent.session.close, { sessionId });
      });

    const savedRaw: unknown = JSON.parse(readFileSync(join(home, ".neko-core", "task-sessions", `${sessionId}.json`), "utf8"));
    // SAFETY: this isolated fixture creates the v3 task-session JSON and checks its model history only.
    const saved = savedRaw as {
      activeTaskId: string;
      tasks: { id: string; messages: { role: string; tool_call_id?: string; content: unknown }[] }[];
    };
    expect(saved.activeTaskId).toBe(taskA);
    const savedResults = saved.tasks.find((task) => task.id === taskA)?.messages.filter((item) =>
      item.role === "tool" && item.tool_call_id === toolId);
    expect(savedResults).toHaveLength(1);
    expect(savedResults?.[0]?.content).toBe(deniedText);
    expect(saved.tasks.find((task) => task.id !== taskA)?.messages.some((item) =>
      item.role === "tool" && item.tool_call_id === toolId)).toBe(false);

    const replayUpdates: acp.SessionUpdate[] = [];
    await acp.client({ name: "task-denial-replay" })
      .onNotification(acp.methods.client.session.update, ({ params }) => { replayUpdates.push(params.update); })
      .connectWith(app(), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: root, mcpServers: [] });
        expect(replayUpdates.filter((item) => item.sessionUpdate === "tool_call"
          && item.toolCallId === toolId)).toHaveLength(1);
        expect(replayUpdates.filter((item) => item.sessionUpdate === "tool_call_update"
          && item.toolCallId === toolId)).toEqual([expect.objectContaining({ status: "failed", rawOutput: deniedText })]);
        expect(replayProviderCalls).toBe(0);
        expect(replayToolExecutions).toBe(0);
        expect(permissionRequests).toBe(1);
        expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("old");
        await ctx.request(acp.methods.agent.session.close, { sessionId });
      });
  } finally {
    for (const path of [root, home]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP task switch refuses a live prompt and cancellation keeps the original active task", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-task-pending-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-task-pending-home-"));
  try {
    const cfg = loadConfig({ cwd: root, home });
    let started!: () => void;
    const didStart = new Promise<void>((resolveStart) => { started = resolveStart; });
    const app = createNekoAcpAgent({
      config: cfg,
      buildRuntime: async (runtimeConfig, options) => {
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        registry.memoryHome = runtimeConfig.resolvedHome;
        registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
        if (options.computer === false) registry.disabled.add("computer");
        else if (options.computer) registry.computerPort = options.computer;
        if (options.taskScope) registry.bindTaskScope(options.taskScope);
        return {
          agent: new Agent({
            provider: { complete: async (_messages, _tools, _delta, signal) => {
              started();
              return new Promise((_resolve, reject) => signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")), { once: true }));
            } },
            tools: registry,
            maxSteps: 2,
            onDelta: options.onDelta,
            onEvent: options.onEvent,
            verifyBeforeExit: false,
            verifyStateChangesBeforeExit: false,
          }),
          registry,
          config: runtimeConfig,
          close: async () => {},
        };
      },
    });
    const messages: string[] = [];
    await acp.client({ name: "task-pending" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
          messages.push(params.update.content.text);
        }
      })
      .connectWith(app, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        const created = await ctx.request(acp.methods.agent.session.new, {
          cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Task A" },
        });
        const id = created.sessionId;
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: "/task new Task B" }],
        });
        const taskB = /Created inactive task ([a-f0-9]{32})/.exec(messages.join("\n"))?.[1] ?? "";
        expect(taskB).toMatch(/^[a-f0-9]{32}$/);
        const running = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: "Wait until cancelled." }],
        });
        await didStart;
        await expect(ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: `/task use ${taskB}` }],
        })).rejects.toThrow("already active");
        await ctx.notify(acp.methods.agent.session.cancel, { sessionId: id });
        expect((await running).stopReason).toBe("cancelled");
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: "/task status" }],
        });
        expect(messages.at(-1)).toContain("Task A");
        await ctx.request(acp.methods.agent.session.close, { sessionId: id });
      });
  } finally {
    for (const path of [root, home]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP rejects prompts while a task switch is constructing the next runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-task-switch-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-task-switch-home-"));
  try {
    const cfg = loadConfig({ cwd: root, home });
    let buildCount = 0;
    let reached!: () => void;
    let release!: () => void;
    const building = new Promise<void>((resolveBuild) => { reached = resolveBuild; });
    const releaseBuild = new Promise<void>((resolveBuild) => { release = resolveBuild; });
    const inputs: string[] = [];
    const app = createNekoAcpAgent({
      config: cfg,
      buildRuntime: async (runtimeConfig, options) => {
        buildCount++;
        if (buildCount === 2) { reached(); await releaseBuild; }
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        registry.memoryHome = runtimeConfig.resolvedHome;
        registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
        if (options.computer === false) registry.disabled.add("computer");
        else if (options.computer) registry.computerPort = options.computer;
        if (options.taskScope) registry.bindTaskScope(options.taskScope);
        return {
          agent: new Agent({
            provider: { complete: async (messages) => {
              inputs.push(JSON.stringify(messages));
              return { content: "ok", tool_calls: [] };
            } },
            tools: registry,
            maxSteps: 2,
            onDelta: options.onDelta,
            onEvent: options.onEvent,
            verifyBeforeExit: false,
            verifyStateChangesBeforeExit: false,
          }),
          registry,
          config: runtimeConfig,
          close: async () => {},
        };
      },
    });
    const messages: string[] = [];
    await acp.client({ name: "task-switch-race" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
          messages.push(params.update.content.text);
        }
      })
      .connectWith(app, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        const id = (await ctx.request(acp.methods.agent.session.new, {
          cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Task A" },
        })).sessionId;
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: "/task new Task B" }],
        });
        const b = /Created inactive task ([a-f0-9]{32})/.exec(messages.join("\n"))?.[1] ?? "";
        expect(b).toMatch(/^[a-f0-9]{32}$/);
        const switching = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: `/task use ${b}` }],
        });
        await building;
        await expect(ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: "Must not reach old A." }],
        })).rejects.toThrow("transition is in progress");
        expect(inputs).toHaveLength(0);
        release();
        expect((await switching).stopReason).toBe("end_turn");
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: "Only task B." }],
        });
        expect(inputs).toHaveLength(1);
        expect(inputs[0]).toContain("Only task B.");
        expect(inputs[0]).not.toContain("Must not reach old A.");
        await ctx.request(acp.methods.agent.session.close, { sessionId: id });
      });
  } finally {
    for (const path of [root, home]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP task activation rejects an unbound custom runtime while legacy ACP remains supported", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-task-bind-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-task-bind-home-"));
  try {
    const cfg = loadConfig({ cwd: root, home });
    const app = createNekoAcpAgent({
      config: cfg,
      buildRuntime: async (runtimeConfig, options) => {
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        return {
          agent: new Agent({ provider: { complete: async () => ({ content: "ok", tool_calls: [] }) }, tools: registry }),
          registry,
          config: runtimeConfig,
          close: async () => {},
        };
      },
    });
    await acp.client({ name: "task-unbound" }).connectWith(app, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      await expect(ctx.request(acp.methods.agent.session.new, {
        cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Scoped" },
      })).rejects.toThrow("must bind the exact task scope");
      const legacy = await ctx.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
      await ctx.request(acp.methods.agent.session.close, { sessionId: legacy.sessionId });
    });
  } finally {
    for (const path of [root, home]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP cancelled unknown tool outcome closes and resumes without replaying the mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-task-unknown-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-task-unknown-home-"));
  try {
    const cfg = loadConfig({ cwd: root, home });
    cfg.data.mode = "auto";
    let toolStarted!: () => void;
    const didStartTool = new Promise<void>((resolveStart) => { toolStarted = resolveStart; });
    let executed = 0;
    let resumedHistory = "";
    let activeAgent!: Agent;
    let emitEvent: BuildAgentRuntimeOptions["onEvent"];
    const app = (hangTool: boolean) => createNekoAcpAgent({
      config: cfg,
      buildRuntime: async (runtimeConfig, options) => {
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        registry.memoryHome = runtimeConfig.resolvedHome;
        registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
        if (options.computer === false) registry.disabled.add("computer");
        else if (options.computer) registry.computerPort = options.computer;
        if (options.taskScope) registry.bindTaskScope(options.taskScope);
        if (hangTool) {
          const original = registry.execute.bind(registry);
          registry.execute = async (name, args, signal) => {
            if (name !== "write_file") return original(name, args, signal);
            executed++;
            toolStarted();
            return new Promise((_resolve, reject) => signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")), { once: true }));
          };
        }
        let requests = 0;
        const agent = new Agent({
            provider: { complete: async (messages) => {
              requests++;
              if (hangTool && requests === 1) return {
                content: null,
                tool_calls: [{ id: "mutation-1", name: "write_file",
                  arguments: { path: "synthetic.txt", content: "once" } }],
              };
              resumedHistory = JSON.stringify(messages);
              return { content: "resumed", tool_calls: [] };
            } },
            tools: registry,
            maxSteps: 2,
            onDelta: options.onDelta,
            onEvent: options.onEvent,
            verifyBeforeExit: false,
            verifyStateChangesBeforeExit: false,
          });
        if (hangTool) { activeAgent = agent; emitEvent = options.onEvent; }
        return {
          agent,
          registry,
          config: runtimeConfig,
          close: async () => {},
        };
      },
    });
    let sessionId = "";
    const messages: string[] = [];
    await acp.client({ name: "task-unknown-start" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
          messages.push(params.update.content.text);
        }
      })
      .connectWith(app(true), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      sessionId = (await ctx.request(acp.methods.agent.session.new, {
        cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Mutation task" },
      })).sessionId;
      await ctx.request(acp.methods.agent.session.prompt, {
        sessionId, prompt: [{ type: "text", text: "/task new Next task" }],
      });
      const nextTask = /Created inactive task ([a-f0-9]{32})/.exec(messages.join("\n"))?.[1] ?? "";
      expect(nextTask).toMatch(/^[a-f0-9]{32}$/);
      const running = ctx.request(acp.methods.agent.session.prompt, {
        sessionId, prompt: [{ type: "text", text: "Perform a synthetic mutation." }],
      });
      await didStartTool;
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      expect((await running).stopReason).toBe("cancelled");
      // Simulate the durable interrupted boundary where a call event exists but its result was
      // never recorded. A cancelled tool that reports a result normally clears the active ID.
      activeAgent.messages.push({ role: "assistant", content: null, tool_calls: [{
        id: "unknown-2", name: "write_file", arguments: { path: "synthetic.txt", content: "unknown" },
      }] });
      emitEvent?.("tool_call", { id: "unknown-2", name: "write_file",
        arguments: { path: "synthetic.txt", content: "unknown" } });
      await expect(ctx.request(acp.methods.agent.session.prompt, {
        sessionId, prompt: [{ type: "text", text: `/task use ${nextTask}` }],
      })).rejects.toThrow("cannot switch");
      await ctx.request(acp.methods.agent.session.close, { sessionId });
    });
    expect(existsSync(join(home, ".neko-core", "task-sessions", `${sessionId}.lock`))).toBe(false);
    expect(executed).toBe(1);
    await acp.client({ name: "task-unknown-resume" }).connectWith(app(false), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      await ctx.request(acp.methods.agent.session.resume, { sessionId, cwd: root, mcpServers: [] });
      await ctx.request(acp.methods.agent.session.prompt, {
        sessionId, prompt: [{ type: "text", text: "Check state, do not retry." }],
      });
      expect(resumedHistory).toContain("Perform a synthetic mutation.");
      expect(resumedHistory).toMatch(/outcome unknown/i);
      await ctx.request(acp.methods.agent.session.close, { sessionId });
    });
    expect(executed).toBe(1);
  } finally {
    for (const path of [root, home]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP always-allow approval in task A does not authorize task B", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-task-approval-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-task-approval-home-"));
  try {
    writeFileSync(join(root, "sample.txt"), "one", "utf8");
    const cfg = loadConfig({ cwd: root, home });
    cfg.data.mode = "default";
    let buildCount = 0;
    let permissions = 0;
    const app = createNekoAcpAgent({
      config: cfg,
      buildRuntime: async (runtimeConfig, options) => {
        buildCount++;
        const edit = buildCount === 1 ? ["one", "two"] : ["two", "three"];
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        registry.memoryHome = runtimeConfig.resolvedHome;
        registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
        if (options.computer === false) registry.disabled.add("computer");
        else if (options.computer) registry.computerPort = options.computer;
        if (options.taskScope) registry.bindTaskScope(options.taskScope);
        let call = 0;
        return {
          agent: new Agent({
            provider: { complete: async () => {
              call++;
              return call === 1 ? {
                content: null,
                tool_calls: [{ id: `edit-${buildCount}`, name: "edit",
                  arguments: { path: "sample.txt", old_string: edit[0], new_string: edit[1] } }],
              } : { content: "done", tool_calls: [] };
            } },
            tools: registry,
            maxSteps: 3,
            onDelta: options.onDelta,
            onEvent: options.onEvent,
            verifyBeforeExit: false,
            verifyStateChangesBeforeExit: false,
          }),
          registry,
          config: runtimeConfig,
          close: async () => {},
        };
      },
    });
    const messages: string[] = [];
    await acp.client({ name: "task-approval" })
      .onRequest(acp.methods.client.session.requestPermission, () => {
        permissions++;
        return { outcome: { outcome: "selected", optionId: "allow_always" } };
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
          messages.push(params.update.content.text);
        }
      })
      .connectWith(app, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        const id = (await ctx.request(acp.methods.agent.session.new, {
          cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Task A" },
        })).sessionId;
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: "Edit sample.txt in task A." }],
        });
        expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("two");
        expect(permissions).toBe(1);
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: "/task new Task B" }],
        });
        const b = /Created inactive task ([a-f0-9]{32})/.exec(messages.join("\n"))?.[1] ?? "";
        expect(b).toMatch(/^[a-f0-9]{32}$/);
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: `/task use ${b}` }],
        });
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: "Edit sample.txt in task B." }],
        });
        expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("three");
        expect(permissions).toBe(2);
        await ctx.request(acp.methods.agent.session.close, { sessionId: id });
      });
  } finally {
    for (const path of [root, home]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP keeps the committed target active if old-task cleanup fails after a switch", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-task-committed-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-task-committed-home-"));
  try {
    const cfg = loadConfig({ cwd: root, home });
    let buildCount = 0;
    const seen: string[] = [];
    const app = createNekoAcpAgent({
      config: cfg,
      buildRuntime: async (runtimeConfig, options) => {
        buildCount++;
        const current = buildCount;
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        registry.memoryHome = runtimeConfig.resolvedHome;
        registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
        if (options.computer === false) registry.disabled.add("computer");
        else if (options.computer) registry.computerPort = options.computer;
        if (options.taskScope) registry.bindTaskScope(options.taskScope);
        return {
          agent: new Agent({
            provider: { complete: async (messages) => {
              seen.push(`${registry.taskScope?.id}:${JSON.stringify(messages)}`);
              return { content: "ok", tool_calls: [] };
            } },
            tools: registry,
            maxSteps: 2,
            onEvent: options.onEvent,
            verifyBeforeExit: false,
            verifyStateChangesBeforeExit: false,
          }),
          registry,
          config: runtimeConfig,
          close: async () => { if (current === 1) throw new Error("old task close fixture failure"); },
        };
      },
    });
    const messages: string[] = [];
    await acp.client({ name: "task-committed" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
          messages.push(params.update.content.text);
        }
      })
      .connectWith(app, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        const id = (await ctx.request(acp.methods.agent.session.new, {
          cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Task A" },
        })).sessionId;
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: "/task new Task B" }],
        });
        const b = /Created inactive task ([a-f0-9]{32})/.exec(messages.join("\n"))?.[1] ?? "";
        expect(b).toMatch(/^[a-f0-9]{32}$/);
        await expect(ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: `/task use ${b}` }],
        })).rejects.toThrow(`committed to ${b}`);
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: id, prompt: [{ type: "text", text: "Only task B after cleanup failure." }],
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain(`${b}:`);
        expect(seen[0]).toContain("Only task B after cleanup failure.");
        await ctx.request(acp.methods.agent.session.close, { sessionId: id });
      });
  } finally {
    for (const path of [root, home]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP structured context uses the shared compact transaction and resumes its capsule and source journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-structured-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-structured-home-"));
  const cfg = loadConfig({cwd: root, home}); cfg.data.context_mode = "structured";
  let current: Agent | undefined, registry: ToolRegistry | undefined;
  const app = () => createNekoAcpAgent({config: cfg, buildRuntime: async (config, options) => {
    registry = new ToolRegistry(options.root, options.mode, options.approval);
    registry.memoryHome = config.resolvedHome;
    registry.computerInputPolicy = config.computerUseInputPolicy;
    if (options.computer === false) registry.disabled.add("computer");
    else if (options.computer) registry.computerPort = options.computer;
    if (options.taskScope) registry.bindTaskScope(options.taskScope);
    current = new Agent({tools: registry, sourceArchiveCredential: () => undefined,
      provider: {complete: async () => ({content: "Historical source-backed summary", tool_calls: []})},
      onCheckpoint: options.onCheckpoint, onEvent: options.onEvent, onDelta: options.onDelta,
      verifyBeforeExit: false, verifyStateChangesBeforeExit: false});
    return {agent: current, registry, config, close: async () => {}};
  }});
  let sessionId = "", sourceId = "";
  try {
    await acp.client({name: "structured-compact"}).connectWith(app(), async ctx => {
      await ctx.request(acp.methods.agent.initialize, {protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}});
      const created = await ctx.request(acp.methods.agent.session.new, {cwd: root, mcpServers: [], _meta: {"neko.taskLabel": "A"}});
      sessionId = created.sessionId;
      for (let i = 0; i < 12; i++) current!.messages.push({role: "user", content: `ACP_ORIGINAL_${i}`},
        {role: "assistant", content: "historical observation ".repeat(100)});
      await ctx.request(acp.methods.agent.session.prompt, {sessionId, prompt: [{type: "text", text: "/compact"}]});
      const state = JSON.parse(readFileSync(join(home, ".neko-core", "task-sessions", `${sessionId}.json`), "utf8"));
      expect(state.schemaVersion).toBe(3);
      expect(state.tasks[0].contextState.capsule).not.toBeNull();
      expect(current!.messages.some(message => message.role === "assistant" && message._neko_context_capsule === true)).toBe(true);
      sourceId = state.tasks[0].contextState.capsule.sources[0];
      expect(String(await registry!.execute("source_lookup", {id: sourceId}))).toContain("ACP_ORIGINAL_");
      await ctx.request(acp.methods.agent.session.close, {sessionId});
    });
    await acp.client({name: "structured-resume"}).connectWith(app(), async ctx => {
      await ctx.request(acp.methods.agent.initialize, {protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}});
      await ctx.request(acp.methods.agent.session.resume, {cwd: root, mcpServers: [], sessionId});
      expect(current!.messages.some(message => message._neko_context_capsule === true)).toBe(true);
      expect(String(await registry!.execute("source_lookup", {id: sourceId}))).toContain("ACP_ORIGINAL_");
      await ctx.request(acp.methods.agent.session.close, {sessionId});
    });
  } finally {
    for (const path of [root, home]) rmSync(path, {recursive: true, force: true});
  }
});
