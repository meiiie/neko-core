import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";

import { Agent } from "../src/core/agent.ts";
import {
  ToolRegistry,
  type NativeToolBackend,
  type NativeToolBackendAttestation,
  type NativeToolCallContext,
  type NativeToolName,
} from "../src/core/tool-runtime.ts";

const ATTESTATION: NativeToolBackendAttestation = {
  protocol: "neko-native-posix-v1",
  canonicalPosixRoot: "/workspace",
  pathChecks: "backend-enforced",
  structuredWriteConfinement: "backend-enforced",
  exactEditTarget: "backend-enforced",
  bashSandbox: "backend-enforced",
  exactValidatorSandbox: "backend-enforced",
  boundedObservations: "backend-enforced",
  deadlineAndCancellation: "backend-enforced-quiescent",
  checkpointRewind: "unsupported",
};

type BackendCall = {
  name: NativeToolName;
  args: Readonly<any>;
  context: NativeToolCallContext;
};

class FakeNativeBackend implements NativeToolBackend {
  readonly calls: BackendCall[] = [];

  constructor(
    readonly tools: readonly NativeToolName[],
    readonly reply: (call: BackendCall) => string | any[] | Promise<string | any[]>,
    readonly attestation: NativeToolBackendAttestation = ATTESTATION,
  ) {}

  async execute(name: NativeToolName, args: Readonly<any>, context: NativeToolCallContext) {
    const call = { name, args, context };
    this.calls.push(call);
    return await this.reply(call);
  }
}

function registry(backend: NativeToolBackend, mode: "default" | "plan" | "auto" = "auto", prompt = () => true) {
  const root = mkdtempSync(join(tmpdir(), "neko-native-backend-"));
  return new ToolRegistry(root, mode, prompt, undefined, backend);
}

test("remote ownership reuses each existing native schema exactly once", () => {
  const backend = new FakeNativeBackend(["read_file", "edit", "bash"], () => "ok");
  const tools = registry(backend).schemas();
  const names = tools.map((schema) => String(schema.function.name));

  expect(new Set(names).size).toBe(names.length);
  for (const name of ["read_file", "edit", "bash"]) {
    expect(names.filter((candidate) => candidate === name)).toHaveLength(1);
  }
});

test("backend construction fails closed without the full confinement and quiescence attestation", () => {
  const backend = new FakeNativeBackend(
    ["read_file"],
    () => "should not run",
    // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
    { ...ATTESTATION, deadlineAndCancellation: "best-effort" } as any,
  );
  const root = mkdtempSync(join(tmpdir(), "neko-native-invalid-attestation-"));

  expect(() => new ToolRegistry(root, "auto", () => true, undefined, backend))
    .toThrow("missing the required confinement/quiescence attestation");
});

test("backend-owned native names cannot be shadowed by colliding MCP tools", async () => {
  let mcpCalls = 0;
  const mcp = {
    toolSchemas: () => ["edit", "bash"].map((name) => ({
      type: "function",
      function: { name, description: "collision", parameters: { type: "object", properties: {} } },
    })),
    has: (name: string) => name === "edit" || name === "bash",
    call: async () => { mcpCalls++; return "MCP MUST NOT RUN"; },
  };
  const backend = new FakeNativeBackend(["edit", "bash"], ({ name }) =>
    name === "edit" ? "Edited x.ts  (+1 -1)" : "(exit 0)\nremote");
  const root = mkdtempSync(join(tmpdir(), "neko-native-mcp-collision-"));
  const reg = new ToolRegistry(root, "auto", () => true, mcp, backend);
  const schemaNames = reg.schemas().map((schema) => String(schema.function.name));

  expect(schemaNames.filter((name) => name === "edit")).toHaveLength(1);
  expect(schemaNames.filter((name) => name === "bash")).toHaveLength(1);
  expect(await reg.execute("edit", { path: "x.ts", old_string: "a", new_string: "b" }))
    .toStartWith("Edited x.ts");
  expect(await reg.execute("bash", { command: "bun test" })).toStartWith("(exit 0)");
  expect(backend.calls.map((call) => call.name)).toEqual(["edit", "bash"]);
  expect(mcpCalls).toBe(0);
});

test("read, edit, and bash route remotely with POSIX policy context and explicit rewind limits", async () => {
  const backend = new FakeNativeBackend(["read_file", "edit", "bash"], ({ name }) => {
    if (name === "read_file") return "REMOTE READ";
    if (name === "edit") return "Edited src/only.ts  (+1 -1)";
    return "(exit 0)\nremote validator passed";
  });
  const reg = registry(backend);
  reg.sandboxBash = true;
  reg.sandboxAllowNetwork = true;
  reg.sandboxDomains = ["standing.example.com"];
  reg.clearCheckpoint();
  const lease = reg.enterTurn({
    name: "exact",
    allowedTools: ["read_file", "edit", "bash"],
    editTarget: "src/only.ts",
    bashPolicy: "foreground-validator-only",
  });
  try {
    const bashSchema = reg.schemas().find((schema) => schema.function.name === "bash");
    expect(bashSchema?.function.parameters.properties.network_domains).toBeUndefined();
    expect(await reg.execute("read_file", { path: "src/only.ts" })).toBe("REMOTE READ");
    expect(await reg.execute("edit", { path: "src/only.ts", old_string: "a", new_string: "b" }))
      .toStartWith("Edited src/only.ts");
    expect(await reg.execute("bash", {
      command: "bun test",
      network_domains: ["example.com"],
    })).toContain("restricted to a foreground validator");
    expect(await reg.execute("bash", { command: "bun test", timeout: 2500 })).toStartWith("(exit 0)");
  } finally {
    lease.close();
  }

  expect(backend.calls.map((call) => call.name)).toEqual(["read_file", "edit", "bash"]);
  expect(backend.calls[0].context.workspace.canonicalPosixRoot).toBe("/workspace");
  expect(backend.calls[1].context.workspace).toMatchObject({
    canonicalPosixRoot: "/workspace",
    strictEditMatch: true,
    exactEditTarget: "src/only.ts",
  });
  expect(backend.calls[2].context.sandbox).toMatchObject({
    allowNetwork: false,
    domains: [],
    readOnlyWorkspace: true,
  });
  expect(reg.restoreCheckpoint()).toBe(0);
  expect(reg.consumeRestoreConflicts()).toEqual([
    "src/only.ts (remote backend checkpoint rewind unsupported)",
  ]);
});

test("safe and gated decisions plus adversarial review happen before remote dispatch", async () => {
  let prompts = 0;
  const backend = new FakeNativeBackend(["read_file", "edit"], ({ name }) =>
    name === "read_file" ? "safe read" : "Edited x.ts  (+1 -1)");
  const reg = registry(backend, "default", () => { prompts++; return false; });

  expect(await reg.execute("read_file", { path: "x.ts" })).toBe("safe read");
  expect(await reg.execute("edit", { path: "x.ts", old_string: "a", new_string: "b" }))
    .toStartWith("Denied by user");
  expect(prompts).toBe(1);
  expect(backend.calls.map((call) => call.name)).toEqual(["read_file"]);

  reg.mode = "auto";
  reg.checkAction = async () => ({ ok: false, reason: "review refused it" });
  expect(await reg.execute("edit", { path: "x.ts", old_string: "a", new_string: "b" }))
    .toBe("Blocked by adversarial check: review refused it");
  expect(backend.calls.map((call) => call.name)).toEqual(["read_file"]);
});

test("bash network egress is one-call, exact, and self-approved only in auto mode", async () => {
  let prompts = 0;
  const backend = new FakeNativeBackend(["bash"], () => "(exit 0)\nnetwork ok");
  const reg = registry(backend, "default", () => { prompts++; return true; });
  reg.sandboxBash = true;
  reg.sandboxAutoApprove = true;
  reg.sandboxAllowNetwork = false;
  reg.sandboxDomains = ["stale.example.com"];

  expect(await reg.execute("bash", { command: "echo local" })).toStartWith("(exit 0)");
  expect(prompts).toBe(0); // live confined bash still avoids redundant approval
  expect(backend.calls[0].context.sandbox).toMatchObject({ allowNetwork: false, domains: [] });

  expect(await reg.execute("bash", {
    command: "curl https://api.example.com",
    network_domains: ["API.Example.com:443", "api.example.com:443"],
  })).toStartWith("(exit 0)");
  expect(prompts).toBe(1); // egress is a distinct consequence outside auto/yolo
  expect(backend.calls[1].context.sandbox).toMatchObject({
    allowNetwork: true,
    domains: ["api.example.com:443"],
  });

  reg.mode = "auto";
  expect(await reg.execute("bash", {
    command: "curl https://files.example.com",
    network_domains: ["files.example.com"],
  })).toStartWith("(exit 0)");
  expect(prompts).toBe(1);
  expect(backend.calls[2].context.sandbox.domains).toEqual(["files.example.com"]);

  expect(await reg.execute("bash", {
    command: "curl https://example.com",
    network_domains: ["https://example.com"],
  })).toContain("invalid network domain");
  expect(backend.calls).toHaveLength(3);
});

test("a refusing pre-tool hook blocks a backend-owned native call before dispatch", async () => {
  const backend = new FakeNativeBackend(["read_file"], () => "should not run");
  const reg = registry(backend);
  reg.hooks = { preToolUse: "exit 3" };

  expect(await reg.execute("read_file", { path: "x.ts" })).toContain("Blocked by pre_tool_use hook");
  expect(backend.calls).toHaveLength(0);
});

test("catastrophic bash is refused without contacting the remote backend", async () => {
  const backend = new FakeNativeBackend(["bash"], () => "(exit 0)\nshould not run");
  const reg = registry(backend);

  expect(await reg.execute("bash", { command: "rm -rf /" })).toContain("blocked as catastrophic");
  expect(backend.calls).toHaveLength(0);
});

test("abort signal and clamped bash deadline propagate to the backend", async () => {
  let receivedSignal: AbortSignal | undefined;
  let deadlineAt: number | undefined;
  const backend = new FakeNativeBackend(["bash"], ({ context }) => new Promise<string>((resolve) => {
    receivedSignal = context.signal;
    deadlineAt = context.deadlineAt;
    context.signal?.addEventListener("abort", () => resolve("(interrupted)"), { once: true });
  }));
  const reg = registry(backend);
  const abort = new AbortController();
  const started = Date.now();
  const running = reg.execute("bash", { command: "bun test", timeout: 1250 }, abort.signal);
  abort.abort();

  expect(await running).toBe("(interrupted)");
  expect(receivedSignal).toBe(abort.signal);
  expect(deadlineAt).toBeGreaterThanOrEqual(started + 1200);
  expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 1300);
});

test("backend loss fails closed and never reads the host workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-native-no-fallback-"));
  writeFileSync(join(root, "secret.txt"), "LOCAL FALLBACK MUST NOT RUN", "utf8");
  const backend = new FakeNativeBackend(["read_file"], () => { throw new Error("transport lost"); });
  const reg = new ToolRegistry(root, "auto", () => true, undefined, backend);

  const out = String(await reg.execute("read_file", { path: "secret.txt" }));
  expect(out).toContain("native backend failed for read_file: transport lost");
  expect(out).not.toContain("LOCAL FALLBACK MUST NOT RUN");
  expect(backend.calls).toHaveLength(1);
});

test("remote native observations preserve Agent edit and validator completion accounting", async () => {
  const backend = new FakeNativeBackend(["edit", "bash"], ({ name }) =>
    name === "edit" ? "Edited src/x.ts  (+1 -1)" : "(exit 0)\n1 pass");
  const providerReplies = [
    { content: null, tool_calls: [{ id: "edit", name: "edit", arguments: { path: "src/x.ts", old_string: "false", new_string: "true" } }] },
    { content: null, tool_calls: [{ id: "test", name: "bash", arguments: { command: "bun test test/x.test.ts" } }] },
    { content: "done", tool_calls: [] },
  ];
  const provider = { async complete() { return providerReplies.shift()!; } };
  const agent = new Agent({
    // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
    provider: provider as any,
    tools: registry(backend),
    maxSteps: 5,
  });

  expect(await agent.run("edit and validate")).toBe("done");
  expect(agent.completionStatus).toEqual({ ok: true });
  expect(backend.calls.map((call) => call.name)).toEqual(["edit", "bash"]);
});

test("unsupported remote exact identity refuses clearly without host path resolution or dispatch", async () => {
  const backend = new FakeNativeBackend(
    ["edit"],
    () => "Edited should-not-run",
    { ...ATTESTATION, exactEditTarget: "unsupported" },
  );
  const reg = registry(backend);
  const lease = reg.enterTurn({ name: "exact", allowedTools: ["edit"], editTarget: "missing/remote.ts" });
  try {
    expect(await reg.execute("edit", {
      path: "missing/remote.ts",
      old_string: "a",
      new_string: "b",
    })).toContain("does not support canonical exact-file identity");
  } finally {
    lease.close();
  }
  expect(backend.calls).toHaveLength(0);
});
