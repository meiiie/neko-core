import { afterEach, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseWiiiWorkstationManifest,
  parseWiiiComputerCapability,
  WIII_COMPUTER_CAPABILITY,
  WIII_COMPUTER_METHODS,
  WIII_COMPUTER_PROTOCOL,
  WiiiComputerTool,
} from "../src/adapters/acp-computer.ts";
import { createNekoAcpAgent } from "../src/adapters/acp.ts";
import { loadConfig } from "../src/adapters/config.ts";
import { inheritToolRegistrySettings } from "../src/adapters/tool-registry.ts";
import { productionTurnContext } from "../src/adapters/turn-context.ts";
import { Agent } from "../src/core/agent.ts";
import type { ComputerToolPort, Provider } from "../src/core/ports.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { setSessionsDir } from "../src/adapters/session.ts";
import { isText, type JsonObject } from "../src/shared/wire.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "neko-acp-computer-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  setSessionsDir(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function advertisedCapability(): acp.ClientCapabilities {
  return {
    _meta: {
      [WIII_COMPUTER_CAPABILITY]: {
        semanticProtocol: WIII_COMPUTER_PROTOCOL,
        methods: Object.values(WIII_COMPUTER_METHODS),
      },
    },
  };
}

function workstationManifest(overrides: JsonObject = {}) {
  return {
    schemaVersion: "wiii-workstation.manifest.v1",
    contextVersion: "ctx-1234abcd",
    label: "May tinh cong viec cua Neko",
    coworkerName: "Neko",
    persistence: "durable",
    operatingSystem: "Linux - Debian 12",
    interactionMode: "semantic",
    activeProjectLabel: "Wiii",
    surfaces: ["computer", "browser", "terminal", "files"],
    apps: [
      { appId: "browser", displayName: "Trinh duyet", state: "available", actions: ["invoke"] },
      { appId: "terminal", displayName: "Terminal", state: "available", actions: ["invoke"] },
      { appId: "files", displayName: "Tep du an", state: "available", actions: ["invoke"] },
    ],
    ...overrides,
  };
}

function readyStatus(
  controlled = false,
  seatState: "available" | "agent_controlled" | "user_controlled" = controlled ? "agent_controlled" : "available",
  workstation?: any,
) {
  return {
    protocolVersion: "wiii-computer.agent.v1",
    available: true,
    code: "ready",
    detail: "must not enter the model transcript",
    computer: {
      environmentId: "private-environment-id",
      state: "ready",
      operatingSystem: "Linux",
      semanticProtocol: WIII_COMPUTER_PROTOCOL,
      seatState,
      attachUrl: "http://127.0.0.1/?token=must-not-leak",
    },
    agentHasControl: controlled,
    ...(workstation === undefined ? undefined : { workstation }),
  };
}

function semanticSnapshot(stateVersion = "state-1", name = "Send") {
  return {
    protocolVersion: WIII_COMPUTER_PROTOCOL,
    environmentId: "private-environment-id",
    stateVersion,
    capturedAt: "2026-08-27T00:00:00.000Z",
    platform: "linux_atspi",
    screen: { width: 1440, height: 900 },
    activeWindowRef: "window-1",
    nodes: [{
      ref: "button-send",
      parentRef: "window-1",
      appId: "private-app",
      role: "button",
      name,
      description: "cookie=must-not-leak",
      value: "password=must-not-leak",
      states: ["enabled", "focusable", "cookie=must-not-leak"],
      actions: ["focus", "invoke"],
      bounds: { x: 10, y: 20, width: 100, height: 30 },
    }],
    truncated: false,
  };
}

class FakeComputerClient {
  readonly calls: { method: string; params: any }[] = [];

  constructor(private readonly handle: (method: string, params: any) => any | Promise<any>) {}

  async request<Response = any, Params = any>(method: string, params?: Params): Promise<Response> {
    this.calls.push({ method, params });
    return await this.handle(method, params);
  }
}

function computerTool(client: FakeComputerClient): WiiiComputerTool {
  const capability = parseWiiiComputerCapability(advertisedCapability());
  if (!capability) throw new Error("test capability did not parse");
  return new WiiiComputerTool(client, capability, "session-test");
}

test("Wiii Computer capability negotiation is exact and fail-closed", () => {
  expect(Object.values(WIII_COMPUTER_METHODS)).toEqual([
    "_wiii/computer/v1/status",
    "_wiii/computer/v1/observe",
    "_wiii/computer/v1/lease/acquire",
    "_wiii/computer/v1/act",
    "_wiii/computer/v1/lease/release",
  ]);
  expect(parseWiiiComputerCapability({})).toBeNull();
  expect(parseWiiiComputerCapability({
    _meta: {
      [WIII_COMPUTER_CAPABILITY]: {
        semanticProtocol: WIII_COMPUTER_PROTOCOL,
        methods: [
          "wiii/computer/v1/status",
          "wiii/computer/v1/observe",
          "wiii/computer/v1/lease/acquire",
          "wiii/computer/v1/act",
          "wiii/computer/v1/lease/release",
        ],
      },
    },
  })).toBeNull();
  expect(parseWiiiComputerCapability({
    _meta: {
      [WIII_COMPUTER_CAPABILITY]: {
        semanticProtocol: WIII_COMPUTER_PROTOCOL,
        methods: [WIII_COMPUTER_METHODS.status],
      },
    },
  })).toBeNull();
  expect(parseWiiiComputerCapability(advertisedCapability())?.methods)
    .toEqual(new Set(Object.values(WIII_COMPUTER_METHODS)));
});

test("workstation manifest is bounded, allowlisted, and projected as turn context", async () => {
  const client = new FakeComputerClient((method) => {
    if (method === WIII_COMPUTER_METHODS.status) return readyStatus(false, "available", workstationManifest());
    throw new Error("unexpected method");
  });
  const tool = computerTool(client);
  expect(tool.contextBlock()).toBe("");
  await tool.prepareTurn();
  const context = tool.contextBlock();
  expect(context).toContain("## Your work computer");
  expect(context).toContain("persistent durable Wiii work computer");
  expect(context).toContain('"Linux - Debian 12"');
  expect(context).toContain('"browser": "Trinh duyet"');
  expect(context).toContain("observe max_nodes=4");
  expect(context).not.toContain("private-environment-id");
  expect(context).not.toContain("attachUrl");
  expect(tool.schema().function.description).toContain("your persistent Wiii work computer");
});

test("malformed, oversized, and secret-bearing workstation manifests are ignored without breaking old hosts", async () => {
  expect(parseWiiiWorkstationManifest(workstationManifest())).not.toBeNull();
  expect(parseWiiiWorkstationManifest(workstationManifest({ surfaces: ["computer", "unknown"] }))).toBeNull();
  expect(parseWiiiWorkstationManifest(workstationManifest({ label: "x".repeat(9_000) }))).toBeNull();
  expect(parseWiiiWorkstationManifest(workstationManifest({ activeProjectLabel: "token=must-not-leak" }))).toBeNull();
  expect(parseWiiiWorkstationManifest({ ...workstationManifest(), environmentId: "private" })).toBeNull();

  let statusIndex = 0;
  const candidates = [
    readyStatus(false),
    readyStatus(false, "available", workstationManifest({ schemaVersion: "future-schema" })),
    readyStatus(false, "available", workstationManifest({ label: "https://secret.invalid/?token=bad" })),
  ];
  const client = new FakeComputerClient((method) => {
    if (method === WIII_COMPUTER_METHODS.status) return candidates[statusIndex++];
    throw new Error("unexpected method");
  });
  const tool = computerTool(client);
  for (const _candidate of candidates) {
    expect(JSON.parse(await tool.call({ action: "status" })).outcome).toBe("ready");
    expect(tool.contextBlock()).toBe("");
  }
});

test("fast workstation observation forwards maxNodes 4 and preserves the four stable refs", async () => {
  const refs = ["workstation:main", "app:browser", "app:terminal", "app:files"];
  const client = new FakeComputerClient((method, params) => {
    if (method === WIII_COMPUTER_METHODS.status) return readyStatus();
    if (method === WIII_COMPUTER_METHODS.observe) {
      expect(params).toEqual({ maxNodes: 4 });
      const snapshot: any = semanticSnapshot();
      snapshot.nodes = refs.map((ref, index) => ({
        ref,
        parentRef: index === 0 ? null : "workstation:main",
        appId: null,
        role: index === 0 ? "desktop" : "launcher",
        name: index === 0 ? "Workstation" : ref.slice(4),
        description: null,
        value: null,
        states: ["enabled"],
        actions: index === 0 ? ["focus"] : ["invoke"],
        bounds: null,
      }));
      return snapshot;
    }
    throw new Error("unexpected method");
  });
  const result = JSON.parse(await computerTool(client).call({ action: "observe", max_nodes: 4 }));
  expect(result.snapshot.nodes.map((node: any) => node.ref)).toEqual(refs);
});

test("semantic lifecycle hides host secrets and sends stable operation ids", async () => {
  let controlled = false;
  const client = new FakeComputerClient((method, params) => {
    if (method === WIII_COMPUTER_METHODS.status) return readyStatus(controlled);
    if (method === WIII_COMPUTER_METHODS.observe) return semanticSnapshot();
    if (method === WIII_COMPUTER_METHODS.acquire) {
      controlled = true;
      return { acquired: true, seatState: "agent_controlled" };
    }
    if (method === WIII_COMPUTER_METHODS.act) {
      const observation = semanticSnapshot("state-2", "Send");
      return {
        environmentId: "private-environment-id",
        outcome: "completed",
        code: null,
        detail: "token=must-not-leak",
        action: params.action,
        targetRef: params.targetRef,
        beforeStateVersion: params.stateVersion,
        afterStateVersion: "state-2",
        verified: true,
        observation,
      };
    }
    if (method === WIII_COMPUTER_METHODS.release) {
      controlled = false;
      return { released: true };
    }
    throw new Error("unexpected method");
  });
  const tool = computerTool(client);

  expect(JSON.parse(await tool.call({ action: "acquire" })).code).toBe("observe_required");
  const status = await tool.call({ action: "status" });
  const observation = await tool.call({ action: "observe" });
  expect(`${status}${observation}`).not.toContain("private-environment-id");
  expect(`${status}${observation}`).not.toContain("must-not-leak");
  expect(`${status}${observation}`).not.toContain("attachUrl");
  expect(JSON.parse(observation).snapshot.nodes[0]).not.toHaveProperty("value");

  expect(JSON.parse(await tool.call({ action: "acquire" })).outcome).toBe("acquired");
  const acted = JSON.parse(await tool.call({
    action: "invoke",
    target_ref: "button-send",
    expected_role: "button",
    expected_name: "Send",
  }));
  expect(acted).toMatchObject({
    outcome: "completed",
    verified: true,
    after_state_version: "state-2",
    snapshot: { stateVersion: "state-2" },
  });
  expect(JSON.stringify(acted)).not.toContain("must-not-leak");
  const actedAgain = JSON.parse(await tool.call({
    action: "invoke",
    target_ref: "button-send",
    expected_role: "button",
    expected_name: "Send",
  }));
  expect(actedAgain.outcome).toBe("completed");
  expect(JSON.parse(await tool.call({ action: "release" })).outcome).toBe("released");

  expect(client.calls.filter((call) => call.method === WIII_COMPUTER_METHODS.observe)).toHaveLength(1);
  expect(client.calls.filter((call) => call.method === WIII_COMPUTER_METHODS.act)
    .every((call) => call.params.returnObservation === true)).toBe(true);

  const mutatingMethods = new Set<string>([
    WIII_COMPUTER_METHODS.acquire,
    WIII_COMPUTER_METHODS.act,
    WIII_COMPUTER_METHODS.release,
  ]);
  const mutating = client.calls.filter((call) => mutatingMethods.has(call.method));
  expect(mutating.every((call) => isText(call.params.operationId) && call.params.operationId.length > 20)).toBe(true);
  expect(new Set(mutating.map((call) => call.params.operationId)).size).toBe(mutating.length);
});

test("stale targets re-observe once and never blind-retry the action", async () => {
  let controlled = false;
  let observations = 0;
  let actions = 0;
  const client = new FakeComputerClient((method) => {
    if (method === WIII_COMPUTER_METHODS.status) return readyStatus(controlled);
    if (method === WIII_COMPUTER_METHODS.observe) {
      observations++;
      return observations === 1 ? semanticSnapshot("state-1", "Send") : semanticSnapshot("state-2", "Send now");
    }
    if (method === WIII_COMPUTER_METHODS.acquire) {
      controlled = true;
      return { acquired: true, seatState: "agent_controlled" };
    }
    if (method === WIII_COMPUTER_METHODS.act) {
      actions++;
      throw new Error("stale stateVersion");
    }
    if (method === WIII_COMPUTER_METHODS.release) return { released: true };
    throw new Error("unexpected method");
  });
  const tool = computerTool(client);
  await tool.call({ action: "observe" });
  await tool.call({ action: "acquire" });
  const result = JSON.parse(await tool.call({
    action: "invoke",
    target_ref: "button-send",
    expected_role: "button",
    expected_name: "Send",
  }));
  expect(result).toMatchObject({ outcome: "blocked", code: "stale_snapshot", next: "re_evaluate_target" });
  expect(result.snapshot).toMatchObject({ stateVersion: "state-2" });
  expect(observations).toBe(2);
  expect(actions).toBe(1);
  await tool.close();
});

test("an unknown action outcome retries the same logical operation id only after observation", async () => {
  let controlled = false;
  const actIds: string[] = [];
  const client = new FakeComputerClient((method, params) => {
    if (method === WIII_COMPUTER_METHODS.status) return readyStatus(controlled);
    if (method === WIII_COMPUTER_METHODS.observe) return semanticSnapshot("state-1", "Send");
    if (method === WIII_COMPUTER_METHODS.acquire) {
      controlled = true;
      return { acquired: true, seatState: "agent_controlled" };
    }
    if (method === WIII_COMPUTER_METHODS.act) {
      actIds.push(params.operationId);
      if (actIds.length === 1) throw new Error("connection closed before response");
      return {
        outcome: "completed",
        action: params.action,
        targetRef: params.targetRef,
        beforeStateVersion: params.stateVersion,
        afterStateVersion: "state-2",
        verified: true,
      };
    }
    if (method === WIII_COMPUTER_METHODS.release) return { released: true };
    throw new Error("unexpected method");
  });
  const tool = computerTool(client);
  await tool.call({ action: "observe" });
  await tool.call({ action: "acquire" });
  const action = {
    action: "invoke",
    target_ref: "button-send",
    expected_role: "button",
    expected_name: "Send",
  };
  expect(JSON.parse(await tool.call(action)).code).toBe("action_outcome_unknown");
  expect(JSON.parse(await tool.call(action)).code).toBe("observe_required");
  await tool.call({ action: "observe" });
  expect(JSON.parse(await tool.call(action)).outcome).toBe("completed");
  expect(actIds).toHaveLength(2);
  expect(actIds[1]).toBe(actIds[0]);
  await tool.close();
});

test("human takeover and CAPTCHA stop control without an action fallback", async () => {
  let controlled = false;
  let takeover = false;
  let captcha = false;
  let actions = 0;
  let releases = 0;
  const client = new FakeComputerClient((method) => {
    if (method === WIII_COMPUTER_METHODS.status) {
      return takeover ? readyStatus(false, "user_controlled") : readyStatus(controlled);
    }
    if (method === WIII_COMPUTER_METHODS.observe) {
      if (!captcha) return semanticSnapshot();
      const snapshot = semanticSnapshot();
      snapshot.nodes[0].name = "Verify you are human - CAPTCHA";
      return snapshot;
    }
    if (method === WIII_COMPUTER_METHODS.acquire) {
      controlled = true;
      return { acquired: true, seatState: "agent_controlled" };
    }
    if (method === WIII_COMPUTER_METHODS.act) {
      actions++;
      throw new Error("must not act");
    }
    if (method === WIII_COMPUTER_METHODS.release) {
      releases++;
      controlled = false;
      return { released: true };
    }
    throw new Error("unexpected method");
  });
  const tool = computerTool(client);
  await tool.call({ action: "observe" });
  await tool.call({ action: "acquire" });
  takeover = true;
  expect(JSON.parse(await tool.call({
    action: "invoke",
    target_ref: "button-send",
    expected_role: "button",
    expected_name: "Send",
  })).code).toBe("human_takeover");
  expect(actions).toBe(0);
  expect(releases).toBe(1);

  takeover = false;
  captcha = true;
  expect(JSON.parse(await tool.call({ action: "observe" }))).toMatchObject({
    outcome: "blocked",
    code: "human_verification",
    next: "hand_over_to_human",
  });
  expect(actions).toBe(0);
});

test("project revocation and protected inputs fail closed", async () => {
  let controlled = false;
  let active = true;
  let protectedField = true;
  let actions = 0;
  const client = new FakeComputerClient((method) => {
    if (method === WIII_COMPUTER_METHODS.status) {
      if (active) return readyStatus(controlled);
      return {
        protocolVersion: "wiii-computer.agent.v1",
        available: false,
        code: "project_not_active",
        detail: "private project path must not leak",
        computer: null,
        agentHasControl: false,
      };
    }
    if (method === WIII_COMPUTER_METHODS.observe) {
      const snapshot = semanticSnapshot();
      if (protectedField) {
        snapshot.nodes[0].role = "password text";
        snapshot.nodes[0].name = "Password";
        snapshot.nodes[0].value = "top-secret-value";
        snapshot.nodes[0].states = ["enabled", "protected"];
        snapshot.nodes[0].actions = ["focus", "set_text"];
      }
      return snapshot;
    }
    if (method === WIII_COMPUTER_METHODS.acquire) {
      controlled = true;
      return { acquired: true, seatState: "agent_controlled" };
    }
    if (method === WIII_COMPUTER_METHODS.act) {
      actions++;
      throw new Error("must not act");
    }
    if (method === WIII_COMPUTER_METHODS.release) {
      controlled = false;
      return { released: true };
    }
    throw new Error("unexpected method");
  });
  const tool = computerTool(client);
  const protectedObservation = await tool.call({ action: "observe" });
  expect(protectedObservation).not.toContain("top-secret-value");
  expect(JSON.parse(protectedObservation).snapshot.nodes[0].name).toBe("[protected]");
  await tool.call({ action: "acquire" });
  expect(JSON.parse(await tool.call({
    action: "set_text",
    target_ref: "button-send",
    expected_role: "password text",
    expected_name: "[protected]",
    text: "placeholder",
  })).code).toBe("protected_input");
  expect(actions).toBe(0);

  protectedField = false;
  active = true;
  await tool.call({ action: "observe" });
  await tool.call({ action: "acquire" });
  active = false;
  expect(JSON.parse(await tool.call({
    action: "invoke",
    target_ref: "button-send",
    expected_role: "button",
    expected_name: "Send",
  })).code).toBe("project_not_active");
  expect(actions).toBe(0);
});

test("ToolRegistry replaces the local schema, keeps observation safe, and shares one port with children", async () => {
  const root = tempRoot();
  let approvals = 0;
  let executions = 0;
  const port: ComputerToolPort = {
    schema: () => ({
      type: "function",
      function: {
        name: "computer",
        description: "semantic",
        parameters: { type: "object", properties: { action: { enum: ["status", "acquire"] } }, required: ["action"] },
      },
    }),
    permission: (args) => args.action === "status" ? "safe" : "gated",
    call: async () => { executions++; return "host action"; },
  };
  const registry = new ToolRegistry(root, "auto", async () => { approvals++; return false; });
  registry.computerPort = port;
  const computerSchema = registry.schemas().find((schema) => schema.function.name === "computer");
  expect(computerSchema.function.parameters.properties.action.enum).toEqual(["status", "acquire"]);
  expect(await registry.execute("computer", { action: "status" })).toBe("host action");
  expect(approvals).toBe(0);
  expect(await registry.execute("computer", { action: "acquire" })).toContain("Denied by user");
  expect(approvals).toBe(1);
  expect(executions).toBe(1);

  const child = inheritToolRegistrySettings(new ToolRegistry(root, "auto"), registry);
  expect(child.computerPort).toBe(port);
});

test("ACP Computer capability is connection-scoped and absent means no local fallback", async () => {
  const root = tempRoot();
  const home = tempRoot();
  setSessionsDir(tempRoot());
  const cfg = loadConfig({ cwd: root, home });
  const seen: (ComputerToolPort | false | undefined)[] = [];
  const provider: Provider = {
    async complete() { return { content: "done", tool_calls: [] }; },
  };
  const agentApp = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      seen.push(options.computer);
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      if (options.computer === false) registry.disabled.add("computer");
      else if (options.computer) registry.computerPort = options.computer;
      if (options.computer === false) expect(registry.schemas().some((schema: any) => schema.function.name === "computer")).toBe(false);
      return {
        agent: new Agent({ provider, tools: registry, maxSteps: 1 }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });
  const capable = acp.client({ name: "wiii-capable" });
  const plain = acp.client({ name: "plain-client" });

  await capable.connectWith(agentApp, async (capableContext) => {
    await capableContext.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: advertisedCapability(),
    });
    const first = await capableContext.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
    expect(seen.at(-1)).toBeInstanceOf(WiiiComputerTool);

    await plain.connectWith(agentApp, async (plainContext) => {
      await plainContext.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const created = await plainContext.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
      expect(seen.at(-1)).toBe(false);
      await plainContext.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
    });

    const second = await capableContext.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
    expect(seen.at(-1)).toBeInstanceOf(WiiiComputerTool);
    await capableContext.request(acp.methods.agent.session.close, { sessionId: first.sessionId });
    await capableContext.request(acp.methods.agent.session.close, { sessionId: second.sessionId });
  });
});

test("plain browser intent receives workstation context and proactively uses the Wiii Computer port", async () => {
  const root = tempRoot();
  const home = tempRoot();
  setSessionsDir(tempRoot());
  const cfg = loadConfig({ cwd: root, home });
  let providerStep = 0;
  let controlled = false;
  let systemContext = "";
  let releases = 0;
  const provider: Provider = {
    async complete(messages, tools) {
      if (providerStep === 0) {
        systemContext = String(messages.find((message: any) => message.role === "system")?.content ?? "");
        expect(tools?.some((schema: any) => schema.function?.name === "computer")).toBe(true);
      }
      const scripted = [
        { content: null, tool_calls: [{ id: "status", name: "computer", arguments: { action: "status" } }] },
        { content: null, tool_calls: [{ id: "discover", name: "computer", arguments: { action: "observe", max_nodes: 4 } }] },
        { content: null, tool_calls: [{ id: "acquire", name: "computer", arguments: { action: "acquire" } }] },
        { content: null, tool_calls: [{ id: "open", name: "computer", arguments: {
          action: "invoke", target_ref: "app:browser", expected_role: "launcher", expected_name: "browser",
        } }] },
        { content: null, tool_calls: [{ id: "verify", name: "computer", arguments: { action: "observe", max_nodes: 400 } }] },
        { content: null, tool_calls: [{ id: "release", name: "computer", arguments: { action: "release" } }] },
        { content: "Trang hien tai da duoc quan sat trong trinh duyet cong viec.", tool_calls: [] },
      ];
      return scripted[providerStep++];
    },
  };
  const agentApp = createNekoAcpAgent({
    config: cfg,
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      if (options.computer === false) registry.disabled.add("computer");
      else if (options.computer) registry.computerPort = options.computer;
      return {
        agent: new Agent({
          provider,
          tools: registry,
          maxSteps: 9,
          dynamicContext: () => productionTurnContext(registry, {
            model: runtimeConfig.model,
            provider: runtimeConfig.provider,
            home: runtimeConfig.resolvedHome,
          }),
          onDelta: options.onDelta,
          onEvent: options.onEvent,
          verifyStateChangesBeforeExit: true,
        }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });
  const passthrough = (params: any) => params;
  const launcherSnapshot = () => ({
    ...semanticSnapshot("state-launcher", "browser"),
    nodes: [{
      ref: "app:browser",
      parentRef: "workstation:main",
      appId: null,
      role: "launcher",
      name: "browser",
      description: null,
      value: null,
      states: ["enabled"],
      actions: ["invoke"],
      bounds: null,
    }],
  });
  const clientApp = acp.client({ name: "wiii-awareness" })
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    }))
    .onRequest(WIII_COMPUTER_METHODS.status, passthrough, () =>
      readyStatus(controlled, controlled ? "agent_controlled" : "available", workstationManifest()))
    .onRequest(WIII_COMPUTER_METHODS.observe, passthrough, ({ params }) =>
      params.maxNodes === 4 ? launcherSnapshot() : semanticSnapshot("state-browser", "Current page"))
    .onRequest(WIII_COMPUTER_METHODS.acquire, passthrough, () => {
      controlled = true;
      return { acquired: true, seatState: "agent_controlled" };
    })
    .onRequest(WIII_COMPUTER_METHODS.act, passthrough, ({ params }) => ({
      outcome: "completed",
      action: params.action,
      targetRef: params.targetRef,
      beforeStateVersion: params.stateVersion,
      afterStateVersion: "state-browser",
      verified: true,
    }))
    .onRequest(WIII_COMPUTER_METHODS.release, passthrough, () => {
      controlled = false;
      releases++;
      return { released: true };
    });

  await clientApp.connectWith(agentApp, async (context) => {
    await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: advertisedCapability(),
    });
    const session = await context.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
    const result = await context.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Mo trinh duyet cong viec va cho toi biet trang hien tai." }],
    });
    expect(result.stopReason).toBe("end_turn");
    await context.request(acp.methods.agent.session.close, { sessionId: session.sessionId });
  });
  expect(systemContext).toContain("## Your work computer");
  expect(systemContext).toContain("observe max_nodes=4");
  expect(providerStep).toBe(7);
  expect(releases).toBe(1);
});

test("ACP cancel, session close, and disconnect release the Wiii lease", async () => {
  const root = tempRoot();
  const home = tempRoot();
  setSessionsDir(tempRoot());
  const cfg = loadConfig({ cwd: root, home });
  const ports: WiiiComputerTool[] = [];
  const cleanups: Promise<void>[] = [];
  let controlled = false;
  let releases = 0;
  const provider: Provider = {
    complete: (_messages, _tools, _delta, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  };
  const agentApp = createNekoAcpAgent({
    config: cfg,
    trackCleanup: (task) => cleanups.push(task),
    buildRuntime: async (runtimeConfig, options) => {
      const registry = new ToolRegistry(options.root, options.mode, options.approval);
      if (options.computer instanceof WiiiComputerTool) {
        ports.push(options.computer);
        registry.computerPort = options.computer;
      } else {
        registry.disabled.add("computer");
      }
      return {
        agent: new Agent({ provider, tools: registry, maxSteps: 1 }),
        registry,
        config: runtimeConfig,
        close: async () => {},
      };
    },
  });
  const passthrough = (params: any) => params;
  const clientApp = acp.client({ name: "wiii-lifecycle" })
    .onRequest(WIII_COMPUTER_METHODS.status, passthrough, () => readyStatus(controlled))
    .onRequest(WIII_COMPUTER_METHODS.observe, passthrough, () => semanticSnapshot())
    .onRequest(WIII_COMPUTER_METHODS.acquire, passthrough, () => {
      controlled = true;
      return { acquired: true, seatState: "agent_controlled" };
    })
    .onRequest(WIII_COMPUTER_METHODS.release, passthrough, () => {
      releases++;
      controlled = false;
      return { released: true };
    });

  await clientApp.connectWith(agentApp, async (context) => {
    await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: advertisedCapability(),
    });
    const cancelledSession = await context.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
    await ports[0].call({ action: "observe" });
    await ports[0].call({ action: "acquire" });
    const prompting = context.request(acp.methods.agent.session.prompt, {
      sessionId: cancelledSession.sessionId,
      prompt: [{ type: "text", text: "Wait until cancelled." }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await context.notify(acp.methods.agent.session.cancel, { sessionId: cancelledSession.sessionId });
    expect((await prompting).stopReason).toBe("cancelled");
    expect(releases).toBe(1);

    await ports[0].call({ action: "observe" });
    await ports[0].call({ action: "acquire" });
    await context.request(acp.methods.agent.session.close, { sessionId: cancelledSession.sessionId });
    expect(releases).toBe(2);

    await context.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
    await ports[1].call({ action: "observe" });
    await ports[1].call({ action: "acquire" });
    // Returning closes the ACP connection with this session still open.
  });
  await Promise.all(cleanups);
  // Once the transport is already gone, Neko can only run local best-effort cleanup;
  // Wiii's peer-side bridge owns the final native release on disconnect.
  expect(releases).toBe(2);
  expect(JSON.parse(await ports[1].call({ action: "status" })).code).toBe("computer_session_closed");
});
