import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNekoAcpAgent } from "../src/adapters/acp.ts";
import { loadConfig } from "../src/adapters/config.ts";
import { Agent, COMPACTION_PROMPT } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

test("ACP task session/load looks up a historical read_file result after two compactions without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-source-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-source-home-"));
  try {
    writeFileSync(join(root, "config.ts"), "packageManager=pnpm", "utf8");
    const cfg = loadConfig({ cwd: root, home });
    let buildCount = 0;
    let providerCalls = 0;
    let advertisedLookups = 0;
    let ordinaryCalls = 0;
    let replayToolExecutions = 0;
    let createdAgent: Agent | undefined;
    let restoredAgent: Agent | undefined;
    let betaAgent: Agent | undefined;
    const app = () => createNekoAcpAgent({
      config: cfg,
      buildRuntime: async (runtimeConfig, options) => {
        const build = ++buildCount;
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        registry.memoryHome = runtimeConfig.resolvedHome;
        registry.sandboxBash = runtimeConfig.sandbox;
        registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
        if (options.computer === false) registry.disabled.add("computer");
        else if (options.computer) registry.computerPort = options.computer;
        if (options.taskScope) registry.bindTaskScope(options.taskScope);
        expect(registry.computerPort).toBe(options.computer || undefined);
        expect(registry.taskExecutionReceipt()?.capabilities.computer)
          .toBe(options.computer ? "host-port" : "unavailable");
        if (build > 1) {
          const execute = registry.execute.bind(registry);
          registry.execute = async (...args: Parameters<typeof execute>) => {
            if (args[0] === "read_file") {
              replayToolExecutions++;
              throw new Error("ACP load must not replay a historical read_file call");
            }
            return execute(...args);
          };
        }
        const agent = new Agent({
          provider: { complete: async (messages, schemas) => {
            providerCalls++;
            if (messages[0]?.content === COMPACTION_PROMPT) {
              return { content: "Summary deliberately omits the read path", tool_calls: [] };
            }
            if (build > 1) {
              const cited = [...messages].reverse().find((message) => message.role === "user"
                && String(message.content ?? "").startsWith("Historical source ID: "));
              const id = /^Historical source ID: ([a-f0-9]{64})$/.exec(String(cited?.content ?? ""))?.[1];
              if (!id) throw new Error("The lookup ID must come from the model-visible ACP prompt");
              if (messages.at(-1)?.role === "tool") return { content: "Historical evidence checked", tool_calls: [] };
              if (!schemas?.some((schema) => schema.function.name === "source_lookup")) {
                throw new Error("ACP did not advertise source_lookup to the fake provider");
              }
              advertisedLookups++;
              return { content: null, tool_calls: [{ id: `lookup-${build}`, name: "source_lookup", arguments: { id } }] };
            }
            ordinaryCalls++;
            if (ordinaryCalls === 1) return { content: null, tool_calls: [{
              id: "read-a", name: "read_file", arguments: { path: "config.ts" },
            }] };
            return { content: "Read completed", tool_calls: [] };
          } },
          tools: registry, onEvent: options.onEvent, onCheckpoint: options.onCheckpoint,
          sourceArchiveCredential: () => runtimeConfig.apiKey,
          verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
        });
        if (build === 1) createdAgent = agent;
        else if (build === 2) restoredAgent = agent;
        else betaAgent = agent;
        return { agent, registry, config: runtimeConfig, close: async () => {} };
      },
    });
    let sessionId = "";
    let taskId = "";
    let sourceEvents: ReturnType<Agent["compactionSourceEvents"]> = [];
    await acp.client({ name: "source-provenance-create" }).connectWith(app(), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      const created = await ctx.request(acp.methods.agent.session.new, {
        cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Task A" },
      });
      sessionId = created.sessionId;
      // SAFETY: this in-memory client receives task metadata from this test's Neko ACP handler.
      taskId = (created._meta?.["neko.task"] as { id: string }).id;
      const agent = createdAgent;
      if (!agent) throw new Error("Task runtime was not constructed");
      expect((await ctx.request(acp.methods.agent.session.prompt, {
        sessionId, prompt: [{ type: "text", text: "Read config.ts in Task A." }],
      })).stopReason).toBe("end_turn");
      const captured = agent.compactionSourceEvents();
      expect(captured).toHaveLength(1);
      expect(captured[0].requestedPath).toBe("config.ts");
      expect(String(captured[0].result.content)).toContain("packageManager=pnpm");
      expect(captured[0].messageDigest).toBe(createHash("sha256")
        .update(JSON.stringify(captured[0].result)).digest("hex"));
      for (let index = 0; index < 6; index++) {
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: `tail ${index}` }],
        });
      }
      expect(await agent.compact()).toBe("Summary deliberately omits the read path");
      for (let index = 6; index < 12; index++) {
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: `tail ${index}` }],
        });
      }
      expect(await agent.compact()).toBe("Summary deliberately omits the read path");
      sourceEvents = agent.compactionSourceEvents();
      expect(sourceEvents).toEqual(captured);
      expect(JSON.stringify(sourceEvents)).toContain("read-a");
      expect(JSON.stringify(sourceEvents)).toContain("config.ts");
      await ctx.request(acp.methods.agent.session.close, { sessionId });
    });

    const raw: unknown = JSON.parse(readFileSync(join(home, ".neko-core", "task-sessions", `${sessionId}.json`), "utf8"));
    // SAFETY: the fixture created this isolated task-session record and checks only its source archive.
    const saved = raw as { activeTaskId: string; tasks: { id: string; sourceEvents: unknown[] }[] };
    expect(saved.activeTaskId).toBe(taskId);
    expect(saved.tasks.find((task) => task.id === taskId)?.sourceEvents).toEqual(sourceEvents);

    const providerCallsBeforeLoad = providerCalls;
    await acp.client({ name: "source-provenance-load" }).connectWith(app(), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: root, mcpServers: [] });
      const agent = restoredAgent;
      if (!agent) throw new Error("Task runtime was not reconstructed");
      expect(agent.compactionSourceEvents()).toEqual(sourceEvents);
      expect(agent.compactionSourceEvent(sourceEvents[0].id)).toEqual(sourceEvents[0]);
      expect(providerCalls).toBe(providerCallsBeforeLoad);
      expect(replayToolExecutions).toBe(0);
      // A cited ID is supplied in a real ACP prompt after restart. The fake provider then
      // chooses the advertised tool from model-visible text, not a test-side captured ID.
      expect((await ctx.request(acp.methods.agent.session.prompt, {
        sessionId, prompt: [{ type: "text", text: `Historical source ID: ${sourceEvents[0].id}` }],
      })).stopReason).toBe("end_turn");
      const historical = String(agent.messages.filter((message) => message.role === "tool").at(-1)?.content ?? "");
      expect(historical).toContain("packageManager=pnpm");
      expect(historical).toContain("config.ts");
      expect(historical).toContain("historical observed-byte digest sha256:");
      expect(historical).toContain("not a current filesystem revision");
      expect(historical).toContain("historical");
      expect(historical).toContain("new read_file");
      expect(replayToolExecutions).toBe(0);

      // A different active task in the same ACP session cannot dereference A's ID.
      await ctx.request(acp.methods.agent.session.prompt, {
        sessionId, prompt: [{ type: "text", text: "/task new Beta" }],
      });
      const afterNew = JSON.parse(readFileSync(join(home, ".neko-core", "task-sessions", `${sessionId}.json`), "utf8"));
      // SAFETY: the test reads only its isolated, coordinator-written task-session fixture.
      const betaId = (afterNew.tasks as Array<{ id: string }>).find((task) => task.id !== taskId)?.id;
      if (!betaId) throw new Error("ACP did not create the inactive Beta task");
      await ctx.request(acp.methods.agent.session.prompt, {
        sessionId, prompt: [{ type: "text", text: `/task use ${betaId}` }],
      });
      expect((await ctx.request(acp.methods.agent.session.prompt, {
        sessionId, prompt: [{ type: "text", text: `Historical source ID: ${sourceEvents[0].id}` }],
      })).stopReason).toBe("end_turn");
      const beta = betaAgent;
      if (!beta) throw new Error("ACP did not construct the Beta runtime");
      const denied = String(beta.messages.filter((message) => message.role === "tool").at(-1)?.content ?? "");
      expect(denied).toContain("not found in the active task");
      expect(denied).not.toContain("packageManager=pnpm");
      expect(replayToolExecutions).toBe(0);
      expect(advertisedLookups).toBe(2);
      await ctx.request(acp.methods.agent.session.close, { sessionId });
    });
  } finally {
    for (const path of [root, home]) rmSync(path, { recursive: true, force: true });
  }
});

test("ACP task checkpoint refuses source evidence containing the configured credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-source-secret-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-acp-source-secret-home-"));
  try {
    const fakeSecret = "neko-fixture-credential-123456789";
    writeFileSync(join(root, "config.ts"), `packageManager=pnpm\n${fakeSecret}`, "utf8");
    const cfg = loadConfig({ cwd: root, home });
    // SAFETY: a synthetic credential is injected only into this isolated test config.
    (cfg as any).apiKeyFromFile = fakeSecret;
    expect(cfg.apiKey).toBe(fakeSecret);
    let sessionId = "";
    let snapshotBeforeResult = "";
    let providerCalls = 0;
    let createdAgent: Agent | undefined;
    const app = createNekoAcpAgent({
      config: cfg,
      buildRuntime: async (runtimeConfig, options) => {
        const registry = new ToolRegistry(options.root, options.mode, options.approval);
        registry.memoryHome = runtimeConfig.resolvedHome;
        registry.sandboxBash = runtimeConfig.sandbox;
        registry.computerInputPolicy = runtimeConfig.computerUseInputPolicy;
        if (options.computer === false) registry.disabled.add("computer");
        else if (options.computer) registry.computerPort = options.computer;
        if (options.taskScope) registry.bindTaskScope(options.taskScope);
        expect(registry.computerPort).toBe(options.computer || undefined);
        expect(registry.taskExecutionReceipt()?.capabilities.computer)
          .toBe(options.computer ? "host-port" : "unavailable");
        const execute = registry.execute.bind(registry);
        registry.execute = async (...args: Parameters<typeof execute>) => {
          if (args[0] === "read_file") {
            snapshotBeforeResult = readFileSync(join(home, ".neko-core", "task-sessions", `${sessionId}.json`), "utf8");
          }
          return execute(...args);
        };
        const agent = new Agent({
            provider: { complete: async () => {
              providerCalls++;
              return providerCalls === 1
                ? { content: null, tool_calls: [{ id: "read-secret", name: "read_file",
                  arguments: { path: "config.ts" } }] }
                : { content: "Read complete", tool_calls: [] };
            } },
            tools: registry, onEvent: options.onEvent, onCheckpoint: options.onCheckpoint,
            verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
          });
        createdAgent = agent;
        return { agent, registry, config: runtimeConfig, close: async () => {} };
      },
    });
    await acp.client({ name: "source-secret-checkpoint" }).connectWith(app, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
      });
      sessionId = (await ctx.request(acp.methods.agent.session.new, {
        cwd: root, mcpServers: [], _meta: { "neko.taskLabel": "Task A" },
      })).sessionId;
      let errorText = "";
      try {
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId, prompt: [{ type: "text", text: "Read config.ts in Task A." }],
        });
      } catch (error) { errorText = String(error); }
      expect(errorText.length).toBeGreaterThan(0);
      expect(errorText).not.toContain(fakeSecret);
      expect(snapshotBeforeResult.length).toBeGreaterThan(0);
      const stored = readFileSync(join(home, ".neko-core", "task-sessions", `${sessionId}.json`), "utf8");
      expect(stored).toBe(snapshotBeforeResult);
      expect(stored).not.toContain(fakeSecret);
      const storedRaw: unknown = JSON.parse(stored);
      // SAFETY: the prior committed record is produced by this isolated task-session fixture.
      const saved = storedRaw as { schemaVersion: number };
      expect(saved.schemaVersion).toBe(2);
      const agent = createdAgent;
      if (!agent) throw new Error("Task runtime was not constructed");
      expect(JSON.stringify(agent.compactionSourceEvents()).includes(fakeSecret)).toBe(true);
      expect(providerCalls).toBe(1);
    });
  } finally {
    for (const path of [root, home]) rmSync(path, { recursive: true, force: true });
  }
});
