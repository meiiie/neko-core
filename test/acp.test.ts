import { afterEach, beforeEach, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNekoAcpAgent } from "../src/adapters/acp.ts";
import { loadConfig } from "../src/adapters/config.ts";
import { Agent } from "../src/core/agent.ts";
import type { Provider } from "../src/core/ports.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { loadSession, newSessionId, saveSession, setSessionsDir } from "../src/adapters/session.ts";
import { hostToolNames, NEKOCUT_HOST_PROFILE } from "../src/adapters/host-profile.ts";
import { isJsonObject } from "../src/shared/wire.ts";

const roots: string[] = [];
let sessionStore = "";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-test-"));
  roots.push(root);
  return root;
}

beforeEach(() => {
  sessionStore = tempRoot();
  setSessionsDir(sessionStore);
});

afterEach(() => {
  setSessionsDir(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scriptedEditProvider(): Provider {
  let call = 0;
  return {
    async complete(_messages, _tools, onDelta, signal) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      call++;
      if (call === 1) {
        onDelta?.("checking", "content");
        return {
          content: null,
          tool_calls: [{
            id: "edit-1",
            name: "edit",
            arguments: { path: "sample.txt", old_string: "old", new_string: "new" },
          }],
        };
      }
      return { content: "done", tool_calls: [] };
    },
  };
}

function repeatedEditProvider(): Provider {
  let call = 0;
  const edits = [
    ["one", "two"],
    ["two", "three"],
    ["three", "four"],
  ] as const;
  return {
    async complete() {
      call++;
      if (call % 2 === 1) {
        const [oldString, newString] = edits[(call - 1) / 2] ?? edits[2];
        return {
          content: null,
          tool_calls: [{
            id: `edit-${call}`,
            name: "edit",
            arguments: {
              path: "sample.txt",
              old_string: oldString,
              new_string: newString,
            },
          }],
        };
      }
      return { content: "done", tool_calls: [] };
    },
  };
}

test("ACP v1 maps Neko modes, permission gating, tool updates, and streaming", async () => {
  const root = tempRoot();
  const home = tempRoot();
  writeFileSync(join(root, "sample.txt"), "old", "utf8");
  const cfg = loadConfig({ cwd: root, home });
  cfg.data.mode = "default";
  const events: string[] = [];
  let permissionRequests = 0;
  let closed = false;

  const agentApp = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      const agent = new Agent({
        provider: scriptedEditProvider(),
        tools: registry,
        maxSteps: 4,
        onDelta: options.onDelta,
        onEvent: options.onEvent,
        verifyBeforeExit: false,
        verifyStateChangesBeforeExit: false,
      });
      return {
        agent,
        registry,
        config: runtimeConfig,
        close: async () => { closed = true; },
      };
    },
  });

  const clientApp = acp.client({ name: "neko-acp-test" })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      permissionRequests++;
      events.push(`permission:${params.toolCall.toolCallId}`);
      expect(params.options.map((option) => option.kind)).toEqual([
        "allow_once", "allow_always", "reject_once", "reject_always",
      ]);
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const update = params.update;
      events.push(update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
        ? `${update.sessionUpdate}:${update.toolCallId}`
        : update.sessionUpdate);
    });

  await clientApp.connectWith(agentApp, async (ctx) => {
    const initialized = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { auth: { terminal: true } },
      clientInfo: { name: "test", version: "1" },
    });
    expect(initialized.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    expect(initialized.agentCapabilities?.loadSession).toBe(true);
    expect(initialized.agentCapabilities?.sessionCapabilities?.list).toEqual({});
    expect(initialized.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
    expect(initialized.agentCapabilities?.sessionCapabilities?.close).toEqual({});
    expect(initialized.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
    expect(initialized.authMethods).toEqual([{
      id: "neko-chatgpt-login",
      name: "Sign in to ChatGPT with Neko",
      description: "Run Neko's browser-based subscription OAuth flow in a separate terminal.",
      type: "terminal",
      args: ["login", "openai", "chatgpt"],
      env: {},
    }]);

    const created = await ctx.request(acp.methods.agent.session.new, {
      cwd: root,
      mcpServers: [],
    });
    expect(created.modes?.currentModeId).toBe("default");
    expect(created.modes?.availableModes.map((mode) => mode.id)).toEqual([
      "default", "accept-edits", "plan", "auto",
    ]);
    const autoMode = created.modes?.availableModes.find((mode) => mode.id === "auto");
    expect(autoMode?.description).toMatch(/outside writes/i);
    expect(autoMode?.description).toMatch(/computer/i);
    expect(autoMode?.description).toMatch(/destructive bash still asks/i);
    expect(autoMode?.description).not.toMatch(/host-computer consent remain/i);

    await expect(ctx.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [],
    })).rejects.toThrow("must contain text");

    const result = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Replace old with new in sample.txt." }],
    });
    expect(result.stopReason).toBe("end_turn");
    expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("new");
    expect(permissionRequests).toBe(1);
    expect(events.indexOf("tool_call:edit-1")).toBeLessThan(events.indexOf("permission:edit-1"));
    expect(events).toContain("tool_call_update:edit-1");
    expect(events).toContain("agent_message_chunk");
    expect(events.filter((event) => event === "agent_message_chunk")).toHaveLength(2);

    await ctx.request(acp.methods.agent.session.setMode, {
      sessionId: created.sessionId,
      modeId: "plan",
    });
    expect(events).toContain("current_mode_update");
    await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
  });

  expect(closed).toBe(true);
}, 15_000);

test("ACP rejected edit records one canonical result for provider follow-up and durable replay", async () => {
  const root = tempRoot();
  const home = tempRoot();
  writeFileSync(join(root, "sample.txt"), "old", "utf8");
  const cfg = loadConfig({ cwd: root, home });
  cfg.data.mode = "default";
  const toolId = "deny-edit-1";
  const updates: acp.SessionUpdate[] = [];
  let sessionId = "";
  let permissionRequests = 0;
  let providerCalls = 0;
  let followUpHistory: any[] = [];

  const app = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      const provider: Provider = {
        async complete(messages) {
          providerCalls++;
          if (providerCalls === 1) return {
            content: null,
            tool_calls: [{ id: toolId, name: "edit", arguments: {
              path: "sample.txt", old_string: "old", new_string: "new",
            } }],
          };
          followUpHistory = structuredClone(messages);
          return { content: "Final: edit was denied; sample.txt remains old.", tool_calls: [] };
        },
      };
      return {
        agent: new Agent({
          provider, tools: registry, maxSteps: 3,
          onDelta: options.onDelta, onEvent: options.onEvent,
          verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
        }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });
  const client = acp.client({ name: "denial-result-once" })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      permissionRequests++;
      expect(params.toolCall.toolCallId).toBe(toolId);
      return { outcome: { outcome: "selected", optionId: "reject_once" } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); });

  await client.connectWith(app, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
    });
    sessionId = (await ctx.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] })).sessionId;
    const result = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId, prompt: [{ type: "text", text: "Replace old with new in sample.txt only if approved." }],
    });
    expect(result.stopReason).toBe("end_turn");
    expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("old");
    expect(permissionRequests).toBe(1);
    expect(providerCalls).toBe(2);

    const providerResults = followUpHistory.filter((message) => message.role === "tool" && message.tool_call_id === toolId);
    expect(providerResults).toHaveLength(1);
    expect(String(providerResults[0].content)).toContain("Denied by user: edit");
    const providerCallsForId = followUpHistory.flatMap((message) => message.role === "assistant"
      ? (message.tool_calls ?? []).filter((call: { id?: string }) => call.id === toolId) : []);
    expect(providerCallsForId).toHaveLength(1);

    const saved = loadSession(sessionId);
    expect(saved?.turnState).toMatchObject({ status: "idle", lastStopReason: "end_turn" });
    const durableResults = saved?.messages.filter((message) => message.role === "tool" && message.tool_call_id === toolId) ?? [];
    expect(durableResults).toHaveLength(1);
    expect(String(durableResults[0].content)).toContain("Denied by user: edit");
    const durableCalls = saved?.messages.flatMap((message) => message.role === "assistant"
      ? (message.tool_calls ?? []).filter((call: { id?: string }) => call.id === toolId) : []) ?? [];
    expect(durableCalls).toHaveLength(1);
    expect(updates.filter((update) => update.sessionUpdate === "tool_call" && update.toolCallId === toolId)).toHaveLength(1);
    const results = updates.filter((update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === toolId);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "failed" });
    await ctx.request(acp.methods.agent.session.close, { sessionId });
  });

  let replayProviderCalls = 0;
  let replayToolExecutions = 0;
  const replayUpdates: acp.SessionUpdate[] = [];
  const replayApp = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      const originalExecute = registry.execute.bind(registry);
      registry.execute = async (...args: Parameters<typeof originalExecute>) => {
        replayToolExecutions++;
        return originalExecute(...args);
      };
      return {
        agent: new Agent({
          provider: { async complete() {
            replayProviderCalls++;
            throw new Error("ACP load must not call the provider");
          } },
          tools: registry, onEvent: options.onEvent,
          verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
        }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });
  await acp.client({ name: "denial-result-replay" })
    .onNotification(acp.methods.client.session.update, ({ params }) => { replayUpdates.push(params.update); })
    .connectWith(replayApp, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: root, mcpServers: [] });
      expect(replayUpdates.filter((update) => update.sessionUpdate === "tool_call" && update.toolCallId === toolId))
        .toHaveLength(1);
      const replayedResults = replayUpdates.filter((update) =>
        update.sessionUpdate === "tool_call_update" && update.toolCallId === toolId);
      expect(replayedResults).toHaveLength(1);
      expect(replayedResults[0]).toMatchObject({ status: "failed" });
      expect(replayProviderCalls).toBe(0);
      expect(replayToolExecutions).toBe(0);
      expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("old");
      await ctx.request(acp.methods.agent.session.close, { sessionId });
    });
});

test("ACP does not turn an unexpected provider error after edit denial into a successful turn", async () => {
  const root = tempRoot();
  const home = tempRoot();
  writeFileSync(join(root, "sample.txt"), "old", "utf8");
  const cfg = loadConfig({ cwd: root, home });
  cfg.data.mode = "default";
  let providerCalls = 0;
  let permissionRequests = 0;
  const app = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      return {
        agent: new Agent({
          provider: { async complete() {
            providerCalls++;
            if (providerCalls === 1) return {
              content: null,
              tool_calls: [{ id: "deny-then-error", name: "edit", arguments: {
                path: "sample.txt", old_string: "old", new_string: "new",
              } }],
            };
            throw new Error("synthetic nonrecoverable provider error");
          } },
          tools: registry, maxSteps: 3,
          onEvent: options.onEvent,
          verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
        }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });
  const client = acp.client({ name: "denial-follow-up-error" })
    .onRequest(acp.methods.client.session.requestPermission, () => {
      permissionRequests++;
      return { outcome: { outcome: "selected", optionId: "reject_once" } };
    });
  await client.connectWith(app, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
    });
    const sessionId = (await ctx.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] })).sessionId;
    await expect(ctx.request(acp.methods.agent.session.prompt, {
      sessionId, prompt: [{ type: "text", text: "Edit sample.txt only if approved." }],
    })).rejects.toThrow("Internal error");
    expect(providerCalls).toBe(2);
    expect(permissionRequests).toBe(1);
    expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("old");
    expect(loadSession(sessionId)?.turnState).toMatchObject({ status: "interrupted", lastStopReason: "error" });
    await ctx.request(acp.methods.agent.session.close, { sessionId });
  });
});

test("ACP advertises terminal auth only to capable clients", async () => {
  const app = createNekoAcpAgent();
  await acp.client({ name: "auth-capability-test" }).connectWith(app, async (ctx) => {
    const plain = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(plain.authMethods).toEqual([]);

    const registryCompatible = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        terminal: true,
        _meta: { "terminal-auth": true },
      },
    });
    const method = registryCompatible.authMethods?.[0];
    expect(method && "type" in method ? method.type : undefined).toBe("terminal");
  });
});

test("ACP runtime failures retain their error checkpoint after abort cleanup", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const cfg = loadConfig({ cwd: root, home });
  let providerCalls = 0;
  let providerSignal: AbortSignal | undefined;
  const streamed: string[] = [];

  const agentApp = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      const provider: Provider = {
        complete: async (_messages, _tools, onDelta, signal) => {
          providerCalls++;
          providerSignal = signal;
          onDelta?.("partial answer", "content");
          throw new Error("fixture provider failure");
        },
      };
      return {
        agent: new Agent({
          provider,
          tools: registry,
          maxSteps: 2,
          onDelta: options.onDelta,
          onEvent: options.onEvent,
          verifyBeforeExit: false,
        }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });
  const client = acp.client({ name: "runtime-error-test" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
        streamed.push(params.update.content.text);
      }
    });

  await client.connectWith(agentApp, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const created = await ctx.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
    await expect(ctx.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Fail after streaming." }],
    })).rejects.toThrow("Internal error");
    expect(loadSession(created.sessionId)?.turnState).toMatchObject({
      status: "interrupted",
      lastStopReason: "error",
      activeToolCallIds: [],
    });
    expect(providerSignal?.aborted).toBe(true);
    expect(providerCalls).toBe(1);
    expect(streamed.join("")).toBe("partial answer");
    await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
    expect(loadSession(created.sessionId)?.turnState?.lastStopReason).toBe("error");
  });
});

test("ACP cancellation aborts an active Neko prompt and closes cleanly", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const cfg = loadConfig({ cwd: root, home });
  let providerAborted = false;

  const agentApp = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      const provider: Provider = {
        complete: (_messages, _tools, _delta, signal) => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            providerAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        }),
      };
      return {
        agent: new Agent({ provider, tools: registry, maxSteps: 2 }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });

  await acp.client({ name: "cancel-test" }).connectWith(agentApp, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const created = await ctx.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
    const prompting = ctx.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Wait for cancellation." }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ctx.notify(acp.methods.agent.session.cancel, { sessionId: created.sessionId });
    expect((await prompting).stopReason).toBe("cancelled");
    expect(loadSession(created.sessionId)?.turnState?.lastStopReason).toBe("cancelled");
    await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
  });

  expect(providerAborted).toBe(true);
});

test("ACP always-allow is session-local and plan mode still hard-denies", async () => {
  const root = tempRoot();
  const home = tempRoot();
  writeFileSync(join(root, "sample.txt"), "one", "utf8");
  const cfg = loadConfig({ cwd: root, home });
  cfg.data.mode = "default";
  let permissionRequests = 0;

  const agentApp = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      return {
        agent: new Agent({ provider: repeatedEditProvider(), tools: registry, maxSteps: 3 }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });
  const client = acp.client({ name: "permission-test" })
    .onRequest(acp.methods.client.session.requestPermission, () => {
      permissionRequests++;
      return { outcome: { outcome: "selected", optionId: "allow_always" } };
    });

  await client.connectWith(agentApp, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const created = await ctx.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
    await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "First edit." }],
    });
    await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Second edit." }],
    });
    expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("three");
    expect(permissionRequests).toBe(1);

    await ctx.request(acp.methods.agent.session.setMode, { sessionId: created.sessionId, modeId: "plan" });
    const deniedBeforePrompt = permissionRequests;
    await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Third edit must be denied in plan mode." }],
    });
    expect(readFileSync(join(root, "sample.txt"), "utf8")).toBe("three");
    expect(permissionRequests).toBe(deniedBeforePrompt);
    await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
  });
});

test("ACP refuses overlapping prompts and close waits for cancelled work to settle", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const cfg = loadConfig({ cwd: root, home });
  let closeBeforeProviderSettled = false;
  let providerSettled = false;
  let markProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolveStarted) => { markProviderStarted = resolveStarted; });

  const agentApp = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      const provider: Provider = {
        complete: (_messages, _tools, _delta, signal) => new Promise((resolveProvider) => {
          markProviderStarted();
          signal?.addEventListener("abort", () => {
            setTimeout(() => {
              providerSettled = true;
              resolveProvider({ content: "[interrupted]", tool_calls: [] });
            }, 10);
          }, { once: true });
        }),
      };
      return {
        agent: new Agent({ provider, tools: registry, maxSteps: 2 }),
        registry,
        config: runtimeConfig,
        close: async () => { closeBeforeProviderSettled = !providerSettled; },
      };
    },
  });

  await acp.client({ name: "overlap-test" }).connectWith(agentApp, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const created = await ctx.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
    const first = ctx.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "First" }],
    });
    await providerStarted;
    await expect(ctx.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Second" }],
    })).rejects.toThrow("already active");
    const closing = ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
    expect((await first).stopReason).toBe("cancelled");
    await closing;
  });

  expect(closeBeforeProviderSettled).toBe(false);
});

test("ACP refuses client authority expansion before building a session runtime", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const cfg = loadConfig({ cwd: root, home });
  let builds = 0;
  const agentApp = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async () => {
      builds++;
      throw new Error("must not build");
    },
  });

  await acp.client({ name: "authority-test" }).connectWith(agentApp, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    await expect(ctx.request(acp.methods.agent.session.new, {
      cwd: root,
      mcpServers: [{
        name: "untrusted",
        command: process.execPath,
        args: ["--version"],
        env: [],
      }],
    })).rejects.toThrow("Client-supplied ACP MCP servers are disabled");
    await expect(ctx.request(acp.methods.agent.session.new, {
      cwd: root,
      additionalDirectories: [tmpdir()],
      mcpServers: [],
    })).rejects.toThrow("additionalDirectories");
  });
  expect(builds).toBe(0);
});

test("ACP host profile exposes only its in-band MCP surface and persists its authority", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const cfg = loadConfig({ cwd: root, home });
  const expected = hostToolNames(NEKOCUT_HOST_PROFILE);
  const mcpCalls: string[] = [];
  let advertised: string[] = [];
  let providerCall = 0;

  const agentApp = createNekoAcpAgent({
    config: cfg,
    hostProfile: NEKOCUT_HOST_PROFILE,
    buildRuntime: async (runtimeConfig, options) => {
      expect(options.hostProfile?.id).toBe("nekocut");
      expect(options.hostTools).toBeDefined();
      const registry = new ToolRegistry(options.root, options.mode, options.approval, options.hostTools);
      registry.allowOnlyTools(expected);
      const agent = new Agent({
        provider: {
          complete: async (_messages, schemas) => {
            advertised = (schemas ?? []).map((schema: any) => schema.function?.name).filter(Boolean);
            providerCall++;
            return providerCall === 1
              ? { content: null, tool_calls: [{ id: "snapshot-1", name: expected[0], arguments: {} }] }
              : { content: "snapshot inspected", tool_calls: [] };
          },
        },
        tools: registry,
        onEvent: options.onEvent,
        onCheckpoint: options.onCheckpoint,
        onDelta: options.onDelta,
        verifyBeforeExit: false,
        verifyStateChangesBeforeExit: false,
      });
      return {
        agent,
        registry,
        config: runtimeConfig,
        close: async () => { await options.hostTools?.close?.(); },
      };
    },
  });

  const identity = { parse: (value: any) => {
    if (!isJsonObject(value)) throw new Error("test MCP params must be a JSON object");
    return value;
  } };
  const tools = NEKOCUT_HOST_PROFILE.tools.map((tool) => ({
    name: tool.name,
    description: tool.name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }));
  const clientApp = acp.client({ name: "nekocut-host-test" })
    .onRequest("mcp/connect", identity, ({ params }) => {
      expect(params.serverId).toBe("nekocut-test-server");
      return { connectionId: "nekocut-test-connection" };
    })
    .onRequest("mcp/message", identity, ({ params }) => {
      expect(params.connectionId).toBe("nekocut-test-connection");
      if (params.method === "initialize") return {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "nekocut", version: "1" },
      };
      if (params.method === "tools/list") return { tools };
      if (params.method === "tools/call") {
        mcpCalls.push(isJsonObject(params.params) ? String(params.params.name) : "");
        return { content: [{ type: "text", text: "bounded project snapshot" }] };
      }
      throw new Error(`unexpected inner MCP method ${params.method}`);
    })
    .onRequest("mcp/disconnect", identity, ({ params }) => {
      expect(params.connectionId).toBe("nekocut-test-connection");
      return {};
    })
    .onNotification("mcp/message", identity, ({ params }) => {
      expect(params.method).toBe("notifications/initialized");
    });

  let id = "";
  await clientApp.connectWith(agentApp, async (ctx) => {
    const initialized = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initialized.agentCapabilities?.mcpCapabilities).toEqual({ acp: true });
    const initializedHost = initialized._meta?.["neko.hostProfile"];
    expect(isJsonObject(initializedHost) ? initializedHost.id : undefined).toBe("nekocut");

    await expect(ctx.request(acp.methods.agent.session.new, {
      cwd: root,
      mcpServers: [{ name: "evil", command: process.execPath, args: [], env: [] }],
    })).rejects.toThrow("accepts only");

    const created = await ctx.request(acp.methods.agent.session.new, {
      cwd: root,
      mcpServers: [{ type: "acp", name: "nekocut", serverId: "nekocut-test-server" }],
    });
    id = created.sessionId;
    expect(created.modes?.availableModes.map((mode) => mode.id)).toEqual(["default", "auto"]);
    await expect(ctx.request(acp.methods.agent.session.setMode, {
      sessionId: id,
      modeId: "plan",
    })).rejects.toThrow("outside host profile");
    const result = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: id,
      prompt: [{ type: "text", text: "Inspect this editing project." }],
    });
    expect(result.stopReason).toBe("end_turn");
    expect(advertised).toEqual(expected);
    expect(mcpCalls).toEqual(["project_snapshot"]);
    const listed = await ctx.request(acp.methods.agent.session.list, { cwd: root });
    expect(listed.sessions.map((session) => session.sessionId)).toContain(id);
    await ctx.request(acp.methods.agent.session.close, { sessionId: id });
    const resumed = await ctx.request(acp.methods.agent.session.resume, {
      sessionId: id,
      cwd: root,
      mcpServers: [{ type: "acp", name: "nekocut", serverId: "nekocut-test-server" }],
    });
    expect(resumed.modes?.availableModes.map((mode) => mode.id)).toEqual(["default", "auto"]);
    await ctx.request(acp.methods.agent.session.close, { sessionId: id });
  });

  expect(loadSession(id)?.hostProfile?.id).toBe("nekocut");
});

test("ACP connection loss closes sessions even without session/close", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const cfg = loadConfig({ cwd: root, home });
  let runtimeClosed = false;
  let cleanupTask: Promise<void> | undefined;
  const agentApp = createNekoAcpAgent({
    config: cfg,
    trackCleanup: (task) => { cleanupTask = task; },
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      return {
        agent: new Agent({
          provider: { complete: async () => ({ content: "done", tool_calls: [] }) },
          tools: registry,
        }),
        registry,
        config: runtimeConfig,
        close: async () => { runtimeClosed = true; },
      };
    },
  });

  await acp.client({ name: "disconnect-test" }).connectWith(agentApp, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    await ctx.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
  });
  await cleanupTask;
  expect(runtimeClosed).toBe(true);
});

test("ACP durable sessions survive a process boundary, list/load replays, and resume does not replay", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const cfg = loadConfig({ cwd: root, home });
  const providerRequests: any[][] = [];
  const makeApp = () => createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      return {
        agent: new Agent({
          provider: {
            complete: async (messages) => {
              providerRequests.push(structuredClone(messages));
              return {
                content: providerRequests.length === 1 ? "durable answer" : "continued with context",
                tool_calls: [],
                usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
                ...(providerRequests.length === 1 ? { continuation: [{ type: "opaque-test", signature: "round-trip-only" }] } : undefined),
              };
            },
          },
          tools: registry,
          onDelta: options.onDelta,
          onEvent: options.onEvent,
          verifyBeforeExit: false,
        }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });

  let sessionId = "";
  await acp.client({ name: "durable-create" }).connectWith(makeApp(), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const created = await ctx.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
    sessionId = created.sessionId;
    expect(created.configOptions?.map((option) => option.id)).toEqual(["provider", "profile", "model", "reasoning_effort"]);
    expect((await ctx.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "remember durable fact" }],
    })).stopReason).toBe("end_turn");
    await ctx.request(acp.methods.agent.session.close, { sessionId });
  });

  const stored = loadSession(sessionId)!;
  expect(stored.schemaVersion).toBe(2);
  expect(stored.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
  expect(stored.turnState?.status).toBe("idle");
  expect(stored.revision).toBeGreaterThan(1);
  expect(stored.provider).toBe(cfg.provider);
  expect(stored.usage).toMatchObject({ promptTokens: 11, completionTokens: 3, totalTokens: 14, calls: 1 });
  const storedUserMessageId = stored.messages.find((message) => message.role === "user")?._neko_acp_message_id;
  const storedAgentMessageId = stored.messages.find((message) => message.role === "assistant")?._neko_acp_message_id;
  expect(storedUserMessageId).toBeString();
  expect(storedAgentMessageId).toBeString();
  expect(stored.messages.find((message) => message.role === "assistant")?.provider_data)
    .toEqual([{ type: "opaque-test", signature: "round-trip-only" }]);

  const replayed: acp.SessionUpdate[] = [];
  const loadingClient = acp.client({ name: "durable-load" })
    .onNotification(acp.methods.client.session.update, ({ params }) => { replayed.push(params.update); });
  await loadingClient.connectWith(makeApp(), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const listed = await ctx.request(acp.methods.agent.session.list, { cwd: root });
    expect(listed.sessions.find((session) => session.sessionId === sessionId)?._meta).toMatchObject({
      provider: cfg.provider,
      model: cfg.model,
      continuityLevel: "durable",
    });
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: root, mcpServers: [] });
    expect(replayed.some((update) => update.sessionUpdate === "user_message_chunk"
      && update.messageId === storedUserMessageId
      && update.content.type === "text" && update.content.text === "remember durable fact")).toBe(true);
    expect(replayed.some((update) => update.sessionUpdate === "agent_message_chunk"
      && update.messageId === storedAgentMessageId
      && update.content.type === "text" && update.content.text === "durable answer")).toBe(true);
    const callsBeforeCommand = providerRequests.length;
    await ctx.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "/cost" }],
    });
    expect(providerRequests).toHaveLength(callsBeforeCommand);
    expect(replayed.some((update) => update.sessionUpdate === "agent_message_chunk"
      && update.content.type === "text" && update.content.text.includes("session cumulative"))).toBe(true);
    await ctx.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "continue" }],
    });
    expect(JSON.stringify(providerRequests.at(-1))).toContain("remember durable fact");
    expect(JSON.stringify(providerRequests.at(-1))).toContain("round-trip-only");
    const changed = await ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: "reasoning_effort",
      value: "high",
    });
    expect(changed.configOptions.find((option) => option.id === "reasoning_effort")).toMatchObject({ currentValue: "high" });
    await ctx.request(acp.methods.agent.session.close, { sessionId });
  });
  expect(loadSession(sessionId)?.reasoningEffort).toBe("high");

  const resumed: acp.SessionUpdate[] = [];
  const resumeClient = acp.client({ name: "durable-resume" })
    .onNotification(acp.methods.client.session.update, ({ params }) => { resumed.push(params.update); });
  await resumeClient.connectWith(makeApp(), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    await ctx.request(acp.methods.agent.session.resume, { sessionId, cwd: root, mcpServers: [] });
    expect(resumed.some((update) => update.sessionUpdate === "user_message_chunk"
      || update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "tool_call")).toBe(false);
    await ctx.request(acp.methods.agent.session.close, { sessionId });
  });
});

test("ACP crash recovery seals a dangling mutation as unknown and never re-executes it", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const cfg = loadConfig({ cwd: root, home });
  const id = newSessionId();
  const now = new Date().toISOString();
  saveSession({
    schemaVersion: 2,
    id,
    createdAt: now,
    updatedAt: now,
    cwd: root,
    provider: cfg.provider,
    model: cfg.model,
    profile: cfg.profile,
    mode: "default",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "track the plan" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "todo-1", type: "function", function: { name: "todo_write", arguments: JSON.stringify({
          todos: [{ content: "perform one mutation", status: "in_progress" }],
        }) } }],
      },
      { role: "tool", tool_call_id: "todo-1", content: "updated" },
      { role: "user", content: "perform one mutation" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "mut-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "once.txt", content: "once" }) } }],
      },
    ],
    turnState: { status: "running", activeToolCallIds: ["mut-1"] },
  });

  let executions = 0;
  let providerHistory: any[] = [];
  let restoredRegistry: ToolRegistry | undefined;
  const updates: acp.SessionUpdate[] = [];
  const app = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      restoredRegistry = registry;
      const originalExecute = registry.execute.bind(registry);
      registry.execute = async (...args: Parameters<typeof originalExecute>) => {
        executions++;
        return originalExecute(...args);
      };
      return {
        agent: new Agent({
          provider: { complete: async (messages) => { providerHistory = structuredClone(messages); return { content: "checked state first", tool_calls: [] }; } },
          tools: registry,
          onDelta: options.onDelta,
          onEvent: options.onEvent,
          verifyBeforeExit: false,
        }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });
  const client = acp.client({ name: "crash-recovery" })
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update); });
  await client.connectWith(app, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    await ctx.request(acp.methods.agent.session.load, { sessionId: id, cwd: root, mcpServers: [] });
    const recovered = loadSession(id)!;
    const unknown = recovered.messages.find((message) => message.role === "tool" && message.tool_call_id === "mut-1");
    expect(String(unknown?.content)).toMatch(/outcome unknown/i);
    expect(recovered.turnState?.status).toBe("interrupted");
    expect(restoredRegistry?.todos).toEqual([{ content: "perform one mutation", status: "in_progress" }]);
    expect(updates.some((update) => update.sessionUpdate === "tool_call_update"
      && update.toolCallId === "mut-1" && update.status === "failed")).toBe(true);
    await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: id,
      prompt: [{ type: "text", text: "continue safely" }],
    });
    expect(JSON.stringify(providerHistory)).toMatch(/outcome unknown/i);
    expect(executions).toBe(0);
    await ctx.request(acp.methods.agent.session.close, { sessionId: id });
  });
});

test("ACP durable session enforces canonical cwd and one active writer, then releases its lease", async () => {
  const root = tempRoot();
  const other = tempRoot();
  const home = tempRoot();
  const cfg = loadConfig({ cwd: root, home });
  const id = newSessionId();
  const now = new Date().toISOString();
  saveSession({ id, createdAt: now, updatedAt: now, cwd: root, model: cfg.model, provider: cfg.provider, messages: [] });
  const makeApp = () => createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      return {
        agent: new Agent({ provider: { complete: async () => ({ content: "ok", tool_calls: [] }) }, tools: registry, onEvent: options.onEvent }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });

  await acp.client({ name: "writer-one" }).connectWith(makeApp(), async (first) => {
    await first.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    await first.request(acp.methods.agent.session.resume, { sessionId: id, cwd: root, mcpServers: [] });
    await acp.client({ name: "writer-two" }).connectWith(makeApp(), async (second) => {
      await second.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      await expect(second.request(acp.methods.agent.session.resume, { sessionId: id, cwd: other, mcpServers: [] }))
        .rejects.toThrow("cwd does not match");
      await expect(second.request(acp.methods.agent.session.resume, { sessionId: id, cwd: root, mcpServers: [] }))
        .rejects.toThrow("active writer");
      await first.request(acp.methods.agent.session.close, { sessionId: id });
      await second.request(acp.methods.agent.session.resume, { sessionId: id, cwd: root, mcpServers: [] });
      await second.request(acp.methods.agent.session.close, { sessionId: id });
    });
  });
});

test("ACP session/list filters by canonical cwd and paginates with opaque cursors", async () => {
  const root = tempRoot();
  const other = tempRoot();
  const now = new Date().toISOString();
  for (let i = 0; i < 52; i++) {
    saveSession({
      id: `${newSessionId()}-page-${i}`,
      createdAt: now,
      updatedAt: now,
      cwd: root,
      model: "m",
      messages: [{ role: "user", content: `item ${i}` }],
    });
  }
  saveSession({
    id: `${newSessionId()}-other`,
    createdAt: now,
    updatedAt: now,
    cwd: other,
    model: "m",
    messages: [],
  });
  const app = createNekoAcpAgent();
  await acp.client({ name: "list-pagination" }).connectWith(app, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const first = await ctx.request(acp.methods.agent.session.list, { cwd: root });
    expect(first.sessions).toHaveLength(50);
    expect(first.sessions.every((session) => session.cwd === root)).toBe(true);
    expect(first.nextCursor).toBeString();
    const second = await ctx.request(acp.methods.agent.session.list, { cwd: root, cursor: first.nextCursor });
    expect(second.sessions).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    await expect(ctx.request(acp.methods.agent.session.list, { cwd: root, cursor: "not-a-neko-cursor" }))
      .rejects.toThrow("Invalid ACP session cursor");
  });
});

test("ACP checkpoints redact the resolved provider credential without losing ordinary context", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const cfg = loadConfig({ cwd: root, home });
  const secret = "neko-test-provider-secret-123456789";
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  (cfg as any).apiKeyFromFile = secret;
  const app = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      return {
        agent: new Agent({
          provider: { complete: async () => ({ content: `received ${secret}`, tool_calls: [] }) },
          tools: registry,
          onEvent: options.onEvent,
        }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });
  let id = "";
  await acp.client({ name: "credential-redaction" }).connectWith(app, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    id = (await ctx.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] })).sessionId;
    await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: id,
      prompt: [{ type: "text", text: `ordinary context plus ${secret}` }],
    });
    await ctx.request(acp.methods.agent.session.close, { sessionId: id });
  });
  const raw = readFileSync(join(sessionStore, `${id}.json`), "utf8");
  expect(raw).not.toContain(secret);
  expect(raw).toContain("ordinary context plus [redacted credential]");
  expect(loadSession(id)?.messages.some((message) => String(message.content).includes("[redacted credential]"))).toBe(true);
});
