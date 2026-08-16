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
