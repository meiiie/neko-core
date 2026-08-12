import { afterEach, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNekoAcpAgent } from "../src/adapters/acp.ts";
import { loadConfig } from "../src/adapters/config.ts";
import { Agent } from "../src/core/agent.ts";
import type { Provider } from "../src/core/ports.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
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
