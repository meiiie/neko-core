import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import {
  createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, jest, test } from "bun:test";

import type { Provider } from "../src/core/ports.ts";
import {
  ToolRegistry,
  type NativeToolBackend,
  type NativeToolBackendAttestation,
  type NativeToolCallContext,
} from "../src/core/tool-runtime.ts";
import {
  HarborHostProtocol,
  HARBOR_CONTROLLER_FINALIZATION_RESERVE_MS,
  HARBOR_FINALIZATION_OBSERVATION,
  HARBOR_FRAME_LIMITS,
  HARBOR_HOST_SESSION_BUDGET_MS,
  HARBOR_LEASE_MARGIN_MS,
  HARBOR_NATIVE_TOOLS,
  HARBOR_REMOTE_SCHEMA,
  HARBOR_RUN_DEADLINE_MS,
  HARBOR_TOOL_FINALIZATION_RESERVE_MS,
  decodeHarborFrameForTest,
  encodeHarborFrame,
  runHarborHostSession,
  verifyHarborCredentialLease,
  verifyExpectedCodexForHarbor,
  type HarborFinalMetrics,
  type HarborHello,
  type HarborProtocolIo,
} from "../evals/harbor/host_runner.ts";
import { discoverCodexSupport } from "../src/adapters/codex-app-server.ts";

import { isText } from "../src/shared/wire.ts";

const ATTESTATION: NativeToolBackendAttestation = {
  protocol: "neko-native-posix-v1",
  canonicalPosixRoot: "/workspace",
  pathChecks: "backend-enforced",
  structuredWriteConfinement: "backend-enforced",
  exactEditTarget: "backend-enforced",
  bashSandbox: "backend-enforced",
  exactValidatorSandbox: "unsupported",
  boundedObservations: "backend-enforced",
  deadlineAndCancellation: "backend-enforced-quiescent",
  checkpointRewind: "unsupported",
};

const EMPTY_METRICS = {
  completionStatus: "ok",
  usageComplete: false,
  providerCompleteCalls: 0,
  providerReportedModelCalls: null,
  inputTokens: null,
  outputTokens: null,
  cachedTokens: null,
  totalTokens: null,
  wallTimeMs: 0,
  hitMaxSteps: false,
  toolCalls: { requested: 0, completed: 0, productive: 0, empty: 0, failed: 0 },
} satisfies HarborFinalMetrics;

class AsyncBytes implements AsyncIterable<Uint8Array> {
  private readonly queued: Uint8Array[] = [];
  private readonly waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  private closed = false;

  push(value: Uint8Array): void {
    if (this.closed) throw new Error("input is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.queued.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        const value = this.queued.shift();
        if (value) return { value, done: false };
        if (this.closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<Uint8Array>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function hello(
  networkMode: "no-network" | "allowlist" | "public" = "no-network",
  allowedHosts: string[] = [],
): HarborHello {
  return {
    schema: HARBOR_REMOTE_SCHEMA,
    type: "hello",
    instruction: "Inspect, edit, and validate the remote task.",
    tools: [...HARBOR_NATIVE_TOOLS],
    attestation: { ...ATTESTATION },
    posture: {
      execution: "harbor-base-environment",
      hostCredentialsInTask: false,
      hostDaemonSocketInTask: false,
      obviousHostRootMountInTask: false,
      networkMode,
      allowedHosts,
    },
  };
}

type Fixture = {
  input: AsyncBytes;
  frames: Record<string, any>[];
  diagnostics: string[];
  protocol: HarborHostProtocol;
  hello: HarborHello;
};

async function fixture(
  helloFrame = hello(),
  onFrame: (frame: Record<string, any>, input: AsyncBytes) => void | Promise<void> = () => {},
): Promise<Fixture> {
  const input = new AsyncBytes();
  const frames: Record<string, any>[] = [];
  const diagnostics: string[] = [];
  const io: HarborProtocolIo = {
    input,
    write: async (wire) => {
      const frame = decodeHarborFrameForTest(wire);
      frames.push(frame);
      await onFrame(frame, input);
    },
    closeInput: () => input.close(),
    diagnostic: (code) => diagnostics.push(code),
  };
  const protocol = new HarborHostProtocol(io);
  input.push(encodeHarborFrame(helloFrame));
  const accepted = await protocol.waitForHello();
  return { input, frames, diagnostics, protocol, hello: accepted };
}

function context(
  options: { signal?: AbortSignal; deadlineAt?: number; allowNetwork?: boolean; domains?: string[] } = {},
): NativeToolCallContext {
  return {
    ...(options.signal ? { signal: options.signal } : undefined),
    ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : undefined),
    workspace: {
      canonicalPosixRoot: "/workspace",
      readOutsideRoot: false,
      strictEditMatch: false,
    },
    sandbox: {
      enabled: true,
      allowNetwork: options.allowNetwork ?? false,
      domains: options.domains ?? [],
      denyReadFiles: [],
      readOnlyWorkspace: false,
    },
  };
}

function result(input: AsyncBytes, id: string, value: string): void {
  input.push(encodeHarborFrame({ schema: HARBOR_REMOTE_SCHEMA, type: "result", id, result: value }));
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function within<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("operation exceeded its test deadline")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function flushProtocol(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function cleanupFakeProtocol(fixture: Fixture | undefined): Promise<void> {
  if (!fixture) return;
  if (!fixture.protocol.failed && !fixture.protocol.finished) {
    await fixture.protocol.failSession("test_cleanup").catch(() => {});
  }
  jest.runAllTimers();
  await flushProtocol();
  await fixture.protocol.quiesce().catch(() => {});
}

test("host session exposes one copy of each native schema and preserves read-edit-validator completion", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-test-host-"));
  const secret = `host-secret-${crypto.randomUUID()}`;
  const seenMessages: any[][] = [];
  const seenSchemas: string[][] = [];
  let providerCall = 0;
  let disposed = false;
  let finalAfterDispose = false;
  const usage = {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    cached_tokens: 4,
    model_calls: 1,
  };
  const provider: Provider = {
    async complete(messages, tools, _onDelta, _signal, opts) {
      seenMessages.push(structuredClone(messages));
      seenSchemas.push((tools ?? []).map((schema: any) => String(schema.function.name)));
      providerCall++;
      if (providerCall === 1) {
        const call = { id: "read", name: "read_file", arguments: { path: "src/x.ts" } };
        opts?.onToolCallReady?.(call);
        return { content: null, tool_calls: [call], usage };
      }
      if (providerCall === 2) return {
        content: null,
        tool_calls: [{ id: "edit", name: "edit", arguments: {
          path: "src/x.ts", old_string: "false", new_string: "true",
        } }],
        usage,
      };
      if (providerCall === 3) return {
        content: null,
        tool_calls: [{ id: "validate", name: "bash", arguments: { command: "bun test test/x.test.ts" } }],
        usage,
      };
      return { content: "done", tool_calls: [], usage };
    },
    dispose() { disposed = true; },
  };
  const f = await fixture(hello("public"), (frame, input) => {
    if (frame.type === "request") {
      const replies: Record<string, string> = {
        read_file: "1: const enabled = false;",
        edit: "Edited src/x.ts  (+1 -1)",
        bash: "(exit 0)\n1 pass",
      };
      result(input, frame.id, replies[frame.tool]);
    }
    if (frame.type === "final") finalAfterDispose = disposed;
  });

  try {
    process.env.NEKO_HARBOR_SENTINEL = secret;
    const session = await runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 8,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
    });

    expect(session.output).toBe("done");
    expect(session.completionStatus).toEqual({ ok: true });
    expect(session.schemaNames).toEqual([...HARBOR_NATIVE_TOOLS]);
    expect(new Set(session.schemaNames).size).toBe(HARBOR_NATIVE_TOOLS.length);
    expect(seenSchemas.every((names) => JSON.stringify(names) === JSON.stringify(HARBOR_NATIVE_TOOLS))).toBe(true);
    expect(f.frames.filter((frame) => frame.type === "request").map((frame) => frame.tool))
      .toEqual(["read_file", "edit", "bash"]);
    const requestIndexes = f.frames.flatMap((frame, index) => frame.type === "request" ? [index] : []);
    for (const [requestNumber, index] of requestIndexes.entries()) {
      expect(f.frames[index - 1]).toMatchObject({
        type: "metrics_checkpoint",
        metrics: {
          toolCalls: { requested: requestNumber + 1, completed: requestNumber },
        },
      });
    }
    expect(f.frames.at(-2)).toMatchObject({ type: "metrics_checkpoint" });
    expect(f.frames.at(-1)).toEqual({
      schema: HARBOR_REMOTE_SCHEMA,
      type: "final",
      metrics: {
        completionStatus: "ok",
        usageComplete: true,
        providerCompleteCalls: 4,
        providerReportedModelCalls: 4,
        inputTokens: 40,
        outputTokens: 8,
        cachedTokens: 16,
        totalTokens: 48,
        wallTimeMs: session.metrics.wallTimeMs,
        hitMaxSteps: false,
        toolCalls: { requested: 3, completed: 3, productive: 3, empty: 0, failed: 0 },
      },
    });
    expect(Number.isSafeInteger(session.metrics.wallTimeMs)).toBe(true);
    expect(session.metrics.wallTimeMs).toBeGreaterThanOrEqual(0);
    expect(f.frames.filter((frame) => frame.type === "request")[0].context.sandbox)
      .toMatchObject({ enabled: true, allowNetwork: true, domains: [], readOnlyWorkspace: false });
    expect(finalAfterDispose).toBe(true);
    const observable = JSON.stringify({ frames: f.frames, diagnostics: f.diagnostics, messages: seenMessages });
    expect(observable).not.toContain(secret);
    expect(observable).not.toContain(hostRoot);
  } finally {
    delete process.env.NEKO_HARBOR_SENTINEL;
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("the Harbor finalization reserve cancels an active tool and denies later remote requests", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-finalization-reserve-"));
  const observedToolResults = new Map<string, string>();
  let providerCall = 0;
  const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, model_calls: 1 };
  const provider: Provider = {
    async complete(messages) {
      for (const message of messages) {
        if (message.role === "tool" && isText(message.content)) {
          observedToolResults.set(String(message.tool_call_id), message.content);
        }
      }
      providerCall++;
      if (providerCall === 1) return {
        content: null,
        tool_calls: [{ id: "active-read", name: "read_file", arguments: { path: "src/x.ts" } }],
        usage,
      };
      if (providerCall === 2) return {
        content: null,
        tool_calls: [{ id: "denied-ls", name: "ls", arguments: { path: "." } }],
        usage,
      };
      return { content: "final after reserve", tool_calls: [], usage };
    },
  };
  const f = await fixture(hello(), (frame, input) => {
    if (frame.type === "cancel") {
      input.push(encodeHarborFrame({
        schema: HARBOR_REMOTE_SCHEMA,
        type: "cancelled",
        id: frame.id,
        result: "(interrupted)",
      }));
    }
  });

  try {
    const session = await runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 4,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
      sessionDeadlineAt: Date.now() + HARBOR_TOOL_FINALIZATION_RESERVE_MS + 500,
    });

    expect(session.output).toBe("final after reserve");
    expect(f.frames.filter((frame) => frame.type === "request")).toHaveLength(1);
    expect(f.frames.filter((frame) => frame.type === "cancel")).toHaveLength(1);
    expect([...observedToolResults.values()]).toEqual([
      HARBOR_FINALIZATION_OBSERVATION,
      HARBOR_FINALIZATION_OBSERVATION,
    ]);
    expect(session.metrics.toolCalls).toEqual({
      requested: 2,
      completed: 2,
      productive: 0,
      empty: 0,
      failed: 2,
    });
    expect(f.frames.at(-1)).toMatchObject({
      type: "final",
      metrics: { toolCalls: session.metrics.toolCalls },
    });
    expect(f.protocol.finished).toBe(true);
    expect(f.protocol.failed).toBe(false);
    const finalWire = JSON.stringify(f.frames.at(-1));
    expect(finalWire).not.toContain("deadlineAt");
    expect(finalWire).not.toContain(HARBOR_FINALIZATION_OBSERVATION);
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("a protocol failure during reserve cancellation still prevents a final frame", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-reserve-protocol-failure-"));
  const provider: Provider = {
    async complete() {
      return {
        content: null,
        tool_calls: [{ id: "active-read", name: "read_file", arguments: { path: "src/x.ts" } }],
      };
    },
  };
  const f = await fixture(hello(), (frame, input) => {
    if (frame.type === "cancel") result(input, frame.id, "late result must not win");
  });

  try {
    await expect(runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 2,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
      sessionDeadlineAt: Date.now() + HARBOR_TOOL_FINALIZATION_RESERVE_MS + 500,
    })).rejects.toThrow("session_failed");
    expect(f.protocol.failureCode).toBe("late_or_duplicate_result");
    expect(f.frames.some((frame) => frame.type === "final")).toBe(false);
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("bash keeps its existing settlement reserve ahead of the Harbor tool cutoff", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-bash-finalization-reserve-"));
  let providerCall = 0;
  let budgetObservation = "";
  const provider: Provider = {
    async complete(messages) {
      if (messages.some((message) => message.role === "tool"
        && message.tool_call_id === "late-bash" && message.content === HARBOR_FINALIZATION_OBSERVATION)) {
        budgetObservation = HARBOR_FINALIZATION_OBSERVATION;
      }
      providerCall++;
      return providerCall === 1
        ? {
            content: null,
            tool_calls: [{ id: "late-bash", name: "bash", arguments: { command: "bun test" } }],
          }
        : { content: "final without late bash", tool_calls: [] };
    },
  };
  const f = await fixture();

  try {
    const session = await runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 2,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
      sessionDeadlineAt: Date.now() + HARBOR_TOOL_FINALIZATION_RESERVE_MS
        + HARBOR_FRAME_LIMITS.bashSettlementReserveMs - 1,
    });
    expect(f.frames.some((frame) => frame.type === "request")).toBe(false);
    expect(budgetObservation).toBe(HARBOR_FINALIZATION_OBSERVATION);
    expect(session.metrics.toolCalls).toEqual({
      requested: 1,
      completed: 1,
      productive: 0,
      empty: 0,
      failed: 1,
    });
    expect(f.frames.at(-1)).toMatchObject({ type: "final" });
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("the Harbor controller cutoff prevents a new closed-loop review pass and still finalizes", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-controller-reserve-"));
  let providerCalls = 0;
  let providerSawAbort = false;
  const provider: Provider = {
    async complete(_messages, _tools, _onDelta, signal) {
      providerCalls++;
      signal?.addEventListener("abort", () => { providerSawAbort = true; }, { once: true });
      const blocksUntil = Date.now() + 550;
      while (Date.now() < blocksUntil) { /* hold the event loop past the timer to exercise the absolute guard */ }
      return {
        content: "initial final",
        tool_calls: [],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, model_calls: 1 },
      };
    },
  };
  const f = await fixture();

  try {
    const session = await runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 1,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: true,
      sessionDeadlineAt: Date.now() + HARBOR_CONTROLLER_FINALIZATION_RESERVE_MS + 500,
    });
    expect(session.output).toBe("[interrupted]");
    expect(providerCalls).toBe(1);
    expect(providerSawAbort).toBe(true);
    expect(f.frames.some((frame) => frame.type === "request")).toBe(false);
    expect(f.frames.at(-1)).toMatchObject({ type: "final", metrics: { usageComplete: true } });
    expect(f.protocol.finished).toBe(true);
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("final metrics reduce secret-bearing completion evidence to one fixed status", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-sanitized-final-"));
  const argumentSecret = `argument-${crypto.randomUUID()}`;
  const observationSecret = `observation-${crypto.randomUUID()}`;
  const outputSecret = `output-${crypto.randomUUID()}`;
  const usage = {
    prompt_tokens: 7,
    completion_tokens: 3,
    total_tokens: 10,
    cached_tokens: 2,
  };
  let call = 0;
  const provider: Provider = {
    async complete() {
      call++;
      if (call === 1) return {
        content: null,
        tool_calls: [{
          id: "edit",
          name: "edit",
          arguments: { path: `src/${argumentSecret}.ts`, old_string: "false", new_string: "true" },
        }],
        usage,
      };
      if (call === 2) return {
        content: null,
        tool_calls: [{
          id: "validate",
          name: "bash",
          arguments: { command: `bun test ${argumentSecret}` },
        }],
        usage,
      };
      return { content: outputSecret, tool_calls: [], usage };
    },
  };
  const f = await fixture(hello("public"), (frame, input) => {
    if (frame.type !== "request") return;
    result(input, frame.id, frame.tool === "edit"
      ? "Edited remote target (+1 -1)"
      : `(exit 1 -- command FAILED)\n${observationSecret}`);
  });

  try {
    const session = await runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 4,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
    });
    expect(session.output).toBe(outputSecret);
    expect(session.completionStatus).toMatchObject({
      ok: false,
      reason: "validation_failed",
      command: `bun test ${argumentSecret}`,
    });
    expect(session.completionStatus.detail).toContain(observationSecret);
    expect(session.metrics).toMatchObject({
      completionStatus: "validation_failed",
      usageComplete: true,
      providerCompleteCalls: 4,
      providerReportedModelCalls: 4,
      inputTokens: 28,
      outputTokens: 12,
      cachedTokens: 8,
      totalTokens: 40,
      hitMaxSteps: false,
      toolCalls: { requested: 2, completed: 2, productive: 1, empty: 0, failed: 1 },
    });
    const final = JSON.stringify(f.frames.at(-1));
    expect(final).not.toContain(argumentSecret);
    expect(final).not.toContain(observationSecret);
    expect(final).not.toContain(outputSecret);
    for (const forbidden of ['"command"', '"detail"', '"args"', '"output"', '"result"']) {
      expect(final).not.toContain(forbidden);
    }
    const checkpoints = f.frames.filter((frame) => frame.type === "metrics_checkpoint");
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of checkpoints) {
      expect(Object.keys(checkpoint).sort()).toEqual(["metrics", "schema", "type"]);
      expect(Object.keys(checkpoint.metrics).sort()).toEqual([
        "cachedTokens", "hitMaxSteps", "inputTokens", "outputTokens", "providerCompleteCalls",
        "providerReportedModelCalls", "providerUsageObservedCalls", "toolCalls", "totalTokens", "wallTimeMs",
      ]);
      expect(Object.keys(checkpoint.metrics.toolCalls).sort())
        .toEqual(["completed", "empty", "failed", "productive", "requested"]);
      const serialized = JSON.stringify(checkpoint);
      expect(serialized).not.toContain(argumentSecret);
      expect(serialized).not.toContain(observationSecret);
      expect(serialized).not.toContain(outputSecret);
      for (const forbidden of ['"command"', '"path"', '"args"', '"error"', '"result"']) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("a failure before final preserves an ordered privacy-safe checkpoint", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-partial-metrics-"));
  const secret = `tool-argument-${crypto.randomUUID()}`;
  const provider: Provider = {
    async complete() {
      return {
        content: null,
        tool_calls: [{ id: "read", name: "read_file", arguments: { path: `src/${secret}.ts` } }],
        usage: {
          prompt_tokens: 17,
          completion_tokens: 4,
          total_tokens: 21,
          cached_tokens: 5,
          model_calls: 2,
        },
      };
    },
  };
  const f = await fixture(hello(), (frame, input) => {
    if (frame.type !== "request") return;
    input.push(encodeHarborFrame({
      schema: HARBOR_REMOTE_SCHEMA,
      type: "error",
      id: null,
      code: "fixture_failure",
      message: "fixed peer failure",
    }));
  });
  try {
    await expect(runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 2,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
    })).rejects.toThrow("session_failed");
    const requestIndex = f.frames.findIndex((frame) => frame.type === "request");
    expect(requestIndex).toBeGreaterThan(0);
    expect(f.frames[requestIndex - 1]).toEqual({
      schema: HARBOR_REMOTE_SCHEMA,
      type: "metrics_checkpoint",
      metrics: {
        providerCompleteCalls: 1,
        providerUsageObservedCalls: 1,
        providerReportedModelCalls: 2,
        inputTokens: 17,
        outputTokens: 4,
        cachedTokens: 5,
        totalTokens: 21,
        wallTimeMs: f.frames[requestIndex - 1].metrics.wallTimeMs,
        hitMaxSteps: false,
        toolCalls: { requested: 1, completed: 0, productive: 0, empty: 0, failed: 0 },
      },
    });
    expect(f.frames.some((frame) => frame.type === "final")).toBe(false);
    expect(JSON.stringify(f.frames.filter((frame) => frame.type === "metrics_checkpoint")))
      .not.toContain(secret);
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("stream-eager execution checkpoints requested before enqueue when the provider fails before return", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-eager-partial-"));
  const secret = `provider-failure-${crypto.randomUUID()}`;
  let requestStarted!: () => void;
  const requestSeen = new Promise<void>((resolve) => { requestStarted = resolve; });
  const provider: Provider = {
    async complete(_messages, _tools, _onDelta, _signal, opts) {
      opts?.onToolCallReady?.({ id: "eager-read", name: "read_file", arguments: { path: "src/x.ts" } });
      await requestSeen;
      throw new Error(secret);
    },
  };
  const f = await fixture(hello(), (frame) => {
    if (frame.type === "request") requestStarted();
  });
  try {
    await expect(within(runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 2,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
    }), 2_000)).rejects.toThrow("session_failed");
    const requestIndex = f.frames.findIndex((frame) => frame.type === "request");
    expect(requestIndex).toBeGreaterThan(0);
    expect(f.frames[requestIndex - 1]).toMatchObject({
      type: "metrics_checkpoint",
      metrics: { toolCalls: { requested: 1, completed: 0, productive: 0, empty: 0, failed: 0 } },
    });
    expect(f.frames.filter((frame) => frame.type === "request")).toHaveLength(1);
    expect(f.frames.filter((frame) => frame.type === "metrics_checkpoint")
      .some((frame) => frame.metrics.toolCalls.requested === 1)).toBe(true);
    expect(JSON.stringify(f.frames)).not.toContain(secret);
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("Agent preflight refusals keep requested and completed totals balanced without remote enqueue", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-preflight-metrics-"));
  let providerCall = 0;
  const provider: Provider = {
    async complete() {
      providerCall++;
      if (providerCall === 1) {
        return { content: null, tool_calls: [{ id: "missing-path", name: "read_file", arguments: {} }] };
      }
      return { content: "done", tool_calls: [] };
    },
  };
  const f = await fixture();
  try {
    const session = await runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 2,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
    });
    expect(f.frames.some((frame) => frame.type === "request")).toBe(false);
    expect(session.metrics.toolCalls).toEqual({
      requested: 1,
      completed: 1,
      productive: 0,
      empty: 0,
      failed: 1,
    });
    const checkpoints = f.frames.filter((frame) => frame.type === "metrics_checkpoint");
    expect(checkpoints.some((frame) => frame.metrics.toolCalls.requested === 1
      && frame.metrics.toolCalls.completed === 0)).toBe(true);
    expect(checkpoints.some((frame) => frame.metrics.toolCalls.requested === 1
      && frame.metrics.toolCalls.completed === 1)).toBe(true);
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("a failed tool checkpoint aborts the session before the remote request", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-checkpoint-failure-"));
  let providerCalls = 0;
  const provider: Provider = {
    async complete() {
      providerCalls++;
      return {
        content: null,
        tool_calls: [{ id: "read", name: "read_file", arguments: { path: "src/x.ts" } }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      };
    },
  };
  const f = await fixture(hello(), (frame) => {
    if (frame.type === "metrics_checkpoint" && frame.metrics.toolCalls.requested === 1) {
      throw new Error("fixture checkpoint transport failure");
    }
  });
  try {
    await expect(runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 2,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
    })).rejects.toThrow("session_failed");
    expect(providerCalls).toBe(1);
    expect(f.protocol.failed).toBe(true);
    expect(f.frames.some((frame) => frame.type === "request")).toBe(false);
    expect(f.frames.at(-1)).toMatchObject({
      type: "metrics_checkpoint",
      metrics: { toolCalls: { requested: 1, completed: 0 } },
    });
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("a failed live-usage checkpoint aborts the in-flight provider", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-usage-checkpoint-failure-"));
  let providerCalls = 0;
  let providerAborted = false;
  const provider: Provider = {
    async complete(_messages, _tools, _onDelta, signal, opts) {
      providerCalls++;
      opts?.onUsage?.({ prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 });
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          providerAborted = true;
          reject(new Error("provider aborted"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
      throw new Error("unreachable provider continuation");
    },
  };
  const f = await fixture(hello(), (frame) => {
    if (frame.type === "metrics_checkpoint" && frame.metrics.providerUsageObservedCalls === 1) {
      throw new Error("fixture usage-checkpoint transport failure");
    }
  });
  try {
    await expect(within(runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 2,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
    }), 2_000)).rejects.toThrow("session_failed");
    expect(providerCalls).toBe(1);
    expect(providerAborted).toBe(true);
    expect(f.protocol.failed).toBe(true);
    expect(f.frames.some((frame) => frame.type === "request" || frame.type === "final")).toBe(false);
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("empty and partial provider usage null every reported usage total", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-missing-usage-"));
  let call = 0;
  const provider: Provider = {
    async complete() {
      call++;
      if (call === 1) return {
        content: null,
        tool_calls: [{ id: "read-1", name: "read_file", arguments: { path: "src/x.ts" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 3 },
      };
      if (call === 2) return {
        content: null,
        tool_calls: [{ id: "read-2", name: "read_file", arguments: { path: "src/y.ts" } }],
        usage: {},
      };
      return { content: "done", tool_calls: [], usage: { prompt_tokens: 5 } };
    },
  };
  const f = await fixture(hello(), (frame, input) => {
    if (frame.type === "request") result(input, frame.id, "remote read");
  });
  try {
    const session = await runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 3,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
    });
    expect(session.metrics).toMatchObject({
      usageComplete: false,
      providerCompleteCalls: 3,
      providerReportedModelCalls: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      totalTokens: null,
      toolCalls: { requested: 2, completed: 2, productive: 2, empty: 0, failed: 0 },
    });
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("a final live usage snapshot is authoritative when the response omits usage", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-live-usage-"));
  const provider: Provider = {
    async complete(_messages, _tools, _onDelta, _signal, opts) {
      opts?.onUsage?.({
        prompt_tokens: 30,
        completion_tokens: 6,
        total_tokens: 36,
        cached_tokens: 12,
        model_calls: 2,
      });
      return { content: "done", tool_calls: [] };
    },
  };
  const f = await fixture();
  try {
    const session = await runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 1,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
    });
    expect(session.metrics).toMatchObject({
      usageComplete: true,
      providerCompleteCalls: 1,
      providerReportedModelCalls: 2,
      inputTokens: 30,
      outputTokens: 6,
      cachedTokens: 12,
      totalTokens: 36,
      toolCalls: { requested: 0, completed: 0, productive: 0, empty: 0, failed: 0 },
    });
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("final metrics include the max-step wrap-up call and terminal budget status", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-max-step-metrics-"));
  let call = 0;
  const usage = { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 };
  const provider: Provider = {
    async complete() {
      call++;
      return call === 1
        ? {
            content: null,
            tool_calls: [{ id: "read", name: "read_file", arguments: { path: "src/x.ts" } }],
            usage,
          }
        : { content: "wrapped", tool_calls: [], usage };
    },
  };
  const f = await fixture(hello(), (frame, input) => {
    if (frame.type === "request") result(input, frame.id, "remote read");
  });
  try {
    const session = await runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 1,
      maxContextTokens: 100_000,
      adaptiveEffort: false,
      loop: false,
    });
    expect(session.output).toBe("wrapped");
    expect(session.metrics).toMatchObject({
      hitMaxSteps: true,
      usageComplete: true,
      providerCompleteCalls: 2,
      providerReportedModelCalls: 2,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      toolCalls: { requested: 1, completed: 1, productive: 1, empty: 0, failed: 0 },
    });
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("AbortSignal sends cancel and waits for a settled cancellation", async () => {
  const f = await fixture(hello(), (frame, input) => {
    if (frame.type === "cancel") {
      input.push(encodeHarborFrame({
        schema: HARBOR_REMOTE_SCHEMA,
        type: "cancelled",
        id: frame.id,
        result: "(interrupted)",
      }));
    }
  });
  const backend = f.protocol.nativeBackend();

  const abort = new AbortController();
  const reading = backend.execute("read_file", { path: "x.ts" }, context({ signal: abort.signal }));
  await eventually(() => f.frames.filter((frame) => frame.type === "request").length === 1);
  abort.abort();
  expect(await reading).toBe("(interrupted)");

  expect(f.frames.map((frame) => frame.type)).toEqual(["request", "cancel"]);
  expect(f.frames[0].context.deadlineAt).toBeGreaterThan(Date.now() + 20_000);
  await f.protocol.finish(EMPTY_METRICS);
  await f.protocol.quiesce();
});

test("bash gives remote execution 540s and reserves 60s before host cancellation", async () => {
  const now = 1_900_000_000_000;
  jest.useFakeTimers({ now });
  let f: Fixture | undefined;
  try {
    f = await fixture();
    const execution = f.protocol.nativeBackend().execute(
      "bash",
      { command: "sleep 600" },
      context({ deadlineAt: now + HARBOR_FRAME_LIMITS.maxBashSettlementMs }),
    );
    await flushProtocol();

    expect(f.frames).toHaveLength(1);
    expect(f.frames[0]).toMatchObject({
      type: "request",
      context: { deadlineAt: now + HARBOR_FRAME_LIMITS.maxBashExecutionMs },
    });
    expect(HARBOR_FRAME_LIMITS.maxBashSettlementMs - HARBOR_FRAME_LIMITS.maxBashExecutionMs)
      .toBe(HARBOR_FRAME_LIMITS.bashSettlementReserveMs);

    jest.advanceTimersByTime(HARBOR_FRAME_LIMITS.maxBashExecutionMs);
    await flushProtocol();
    expect(f.frames.map((frame) => frame.type)).toEqual(["request"]);

    jest.advanceTimersByTime(HARBOR_FRAME_LIMITS.bashSettlementReserveMs);
    await flushProtocol();
    expect(f.frames.map((frame) => frame.type)).toEqual(["request", "cancel"]);
    f.input.push(encodeHarborFrame({
      schema: HARBOR_REMOTE_SCHEMA,
      type: "cancelled",
      id: f.frames[1].id,
      result: "(interrupted)",
    }));
    expect(await execution).toBe("(interrupted)");

    const shortNow = Date.now();
    const shortExecution = f.protocol.nativeBackend().execute(
      "bash",
      { command: "sleep 1" },
      context({ deadlineAt: shortNow + 1_000 }),
    );
    void shortExecution.catch(() => {});
    await flushProtocol();
    expect(f.frames.at(-1)).toMatchObject({
      type: "request",
      context: { deadlineAt: shortNow + 1_000 },
    });
    jest.advanceTimersByTime(60_999);
    await flushProtocol();
    expect(f.frames.at(-1)?.type).toBe("request");
    jest.advanceTimersByTime(1);
    await flushProtocol();
    expect(f.frames.at(-1)?.type).toBe("cancel");
    f.input.push(encodeHarborFrame({
      schema: HARBOR_REMOTE_SCHEMA,
      type: "cancelled",
      id: f.frames.at(-1)!.id,
      result: "(interrupted)",
    }));
    expect(await shortExecution).toBe("(interrupted)");
    await f.protocol.finish(EMPTY_METRICS);
    await f.protocol.quiesce();
  } finally {
    await cleanupFakeProtocol(f);
    jest.useRealTimers();
  }
});

test("host accepts a cancellation acknowledgement delayed beyond the former 5s cap", async () => {
  const now = 1_900_000_000_000;
  jest.useFakeTimers({ now });
  let f: Fixture | undefined;
  try {
    f = await fixture();
    const execution = f.protocol.nativeBackend().execute(
      "bash",
      { command: "sleep 600" },
      context({ deadlineAt: now + HARBOR_FRAME_LIMITS.maxBashSettlementMs }),
    );
    void execution.catch(() => {});
    await flushProtocol();
    jest.advanceTimersByTime(HARBOR_FRAME_LIMITS.maxBashSettlementMs);
    await flushProtocol();
    expect(f.frames.at(-1)?.type).toBe("cancel");

    jest.advanceTimersByTime(6_000);
    await flushProtocol();
    expect(f.protocol.failed).toBe(false);
    f.input.push(encodeHarborFrame({
      schema: HARBOR_REMOTE_SCHEMA,
      type: "cancelled",
      id: f.frames.at(-1)!.id,
      result: "(interrupted)",
    }));
    expect(await execution).toBe("(interrupted)");
    await f.protocol.finish(EMPTY_METRICS);
    await f.protocol.quiesce();
  } finally {
    await cleanupFakeProtocol(f);
    jest.useRealTimers();
  }
});

test("missing cancellation acknowledgement fails closed at the 50s cap", async () => {
  const now = 1_900_000_000_000;
  jest.useFakeTimers({ now });
  let f: Fixture | undefined;
  try {
    f = await fixture();
    const execution = f.protocol.nativeBackend().execute(
      "bash",
      { command: "sleep 600" },
      context({ deadlineAt: now + HARBOR_FRAME_LIMITS.maxBashSettlementMs }),
    );
    let rejection: unknown;
    let settled = false;
    void execution.then(
      () => { settled = true; },
      (error) => { rejection = error; settled = true; },
    );
    await flushProtocol();
    jest.advanceTimersByTime(HARBOR_FRAME_LIMITS.maxBashSettlementMs);
    await flushProtocol();
    expect(f.frames.at(-1)?.type).toBe("cancel");

    jest.advanceTimersByTime(HARBOR_FRAME_LIMITS.cancelAckMs - 1);
    await flushProtocol();
    expect(f.protocol.failed).toBe(false);
    jest.advanceTimersByTime(1);
    await flushProtocol();
    expect(f.protocol.failureCode).toBe("cancel_ack_timeout");
    expect(settled).toBe(true);
    expect(String(rejection)).toContain("cancel_ack_timeout");
    await f.protocol.quiesce();
  } finally {
    await cleanupFakeProtocol(f);
    jest.useRealTimers();
  }
});

test("expired bash deadlines fail closed before a request crosses the protocol", async () => {
  const f = await fixture();
  await expect(f.protocol.nativeBackend().execute(
    "bash",
    { command: "echo no" },
    context({ deadlineAt: Date.now() }),
  )).rejects.toThrow("insufficient_bash_deadline");
  expect(f.frames).toHaveLength(0);
  await f.protocol.finish(EMPTY_METRICS);
  await f.protocol.quiesce();
});

test("the Harbor allowlist remains an exact network posture instead of being normalized", async () => {
  const allowedHosts = ["api.example.test", "api.example.test"];
  const f = await fixture(hello("allowlist", allowedHosts), (frame, input) => {
    if (frame.type === "request") result(input, frame.id, "remote read");
  });
  expect(await f.protocol.nativeBackend().execute(
    "read_file",
    { path: "x.ts" },
    context({ allowNetwork: true, domains: allowedHosts }),
  )).toBe("remote read");
  expect(f.frames[0].context.sandbox).toMatchObject({ allowNetwork: true, domains: allowedHosts });
  await f.protocol.finish(EMPTY_METRICS);
  await f.protocol.quiesce();
});

test("peer EOF aborts an in-flight request write before it crosses the protocol", async () => {
  const input = new AsyncBytes();
  let requestWriteStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestWriteStarted = resolve; });
  let releaseWrite!: () => void;
  let writeObservedAbort = false;
  const crossed: Record<string, any>[] = [];
  const protocol = new HarborHostProtocol({
    input,
    write: (wire, signal) => {
      const frame = decodeHarborFrameForTest(wire);
      if (frame.type !== "request") throw new Error("unexpected outbound frame");
      requestWriteStarted();
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        releaseWrite = () => {
          if (settled) return;
          settled = true;
          crossed.push(frame);
          resolve();
        };
        signal?.addEventListener("abort", () => {
          if (settled) return;
          settled = true;
          writeObservedAbort = true;
          reject(new Error("request write aborted"));
        }, { once: true });
      });
    },
    closeInput: () => input.close(),
  });
  input.push(encodeHarborFrame(hello()));
  await protocol.waitForHello();
  const execution = protocol.nativeBackend().execute("read_file", { path: "x.ts" }, context());
  await within(started);
  input.close();

  await expect(within(execution)).rejects.toThrow("unexpected_eof");
  await within(protocol.quiesce());
  releaseWrite();
  expect(writeObservedAbort).toBe(true);
  expect(crossed).toHaveLength(0);
});

test("transport EOF fails closed and never falls back to the host workspace", async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-no-fallback-"));
  writeFileSync(join(hostRoot, "secret.txt"), "HOST FILE MUST NOT BE READ", "utf8");
  const f = await fixture(hello(), (frame, input) => {
    if (frame.type === "request") input.close();
  });
  const registry = new ToolRegistry(hostRoot, "auto", () => true, undefined, f.protocol.nativeBackend());
  registry.allowOnlyTools(HARBOR_NATIVE_TOOLS);
  registry.readOutsideRoot = false;
  registry.sandboxBash = true;
  registry.sandboxAllowNetwork = false;
  registry.sandboxDomains = [];
  registry.sandboxDenyReadFiles = [];

  try {
    const output = String(await registry.execute("read_file", { path: "secret.txt" }));
    expect(output).toContain("native backend failed for read_file");
    expect(output).toContain("unexpected_eof");
    expect(output).not.toContain("HOST FILE MUST NOT BE READ");
    expect(f.protocol.failed).toBe(true);
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("unknown hello fields and duplicate replies are fatal protocol errors", async () => {
  const badInput = new AsyncBytes();
  const badFrames: Record<string, any>[] = [];
  const bad = new HarborHostProtocol({
    input: badInput,
    write: (wire) => { badFrames.push(decodeHarborFrameForTest(wire)); },
    closeInput: () => badInput.close(),
  });
  badInput.push(encodeHarborFrame({ ...hello(), extra: true }));
  await expect(bad.waitForHello()).rejects.toThrow("invalid_hello");
  await eventually(() => badFrames.length === 1);
  expect(badFrames[0]).toEqual({
    schema: HARBOR_REMOTE_SCHEMA,
    type: "error",
    id: null,
    code: "invalid_hello",
    message: "protocol failure",
  });
  await bad.quiesce();

  let completedId = "";
  const duplicate = await fixture(hello(), (frame, input) => {
    if (frame.type === "request") {
      completedId = frame.id;
      result(input, frame.id, "remote read");
    }
  });
  expect(await duplicate.protocol.nativeBackend().execute("read_file", { path: "x" }, context()))
    .toBe("remote read");
  duplicate.input.push(encodeHarborFrame({
    schema: HARBOR_REMOTE_SCHEMA,
    type: "result",
    id: completedId,
    result: "duplicate",
  }));
  await eventually(() => duplicate.protocol.failed);
  expect(duplicate.protocol.failureCode).toBe("late_or_duplicate_result");
  expect(duplicate.frames.at(-1)).toMatchObject({ type: "error", id: null, code: "late_or_duplicate_result" });
  await duplicate.protocol.quiesce();
});

test("frame, argument, and result bounds fail closed before unbounded data crosses the seam", async () => {
  const framedInput = new AsyncBytes();
  const framed = new HarborHostProtocol({ input: framedInput, write: () => {}, closeInput: () => framedInput.close() });
  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32BE(HARBOR_FRAME_LIMITS.frameBytes + 1);
  framedInput.push(oversizedHeader);
  await expect(framed.waitForHello()).rejects.toThrow("invalid_frame_length");
  await framed.quiesce();

  const argsFixture = await fixture();
  await expect(argsFixture.protocol.nativeBackend().execute(
    "write_file",
    { path: "large.txt", content: "x".repeat(HARBOR_FRAME_LIMITS.argumentBytes + 1) },
    context(),
  )).rejects.toThrow("invalid_tool_request");
  expect(argsFixture.frames).toHaveLength(0);
  await expect(argsFixture.protocol.finish({ ...EMPTY_METRICS, surprise: true } as any))
    .rejects.toThrow("invalid_final_metrics");
  await expect(argsFixture.protocol.finish({
    ...EMPTY_METRICS,
    providerReportedModelCalls: 0,
  } as any)).rejects.toThrow("invalid_final_metrics");
  await expect(argsFixture.protocol.finish({
    ...EMPTY_METRICS,
    toolCalls: { ...EMPTY_METRICS.toolCalls, surprise: 1 },
  } as any)).rejects.toThrow("invalid_final_metrics");
  expect(argsFixture.frames).toHaveLength(0);
  await argsFixture.protocol.finish(EMPTY_METRICS);
  await argsFixture.protocol.quiesce();

  const resultFixture = await fixture(hello(), (frame, input) => {
    if (frame.type === "request") {
      result(input, frame.id, "x".repeat(HARBOR_FRAME_LIMITS.resultBytes + 1));
    }
  });
  await expect(resultFixture.protocol.nativeBackend().execute("read_file", { path: "x" }, context()))
    .rejects.toThrow("invalid_result");
  expect(resultFixture.protocol.failed).toBe(true);
  await resultFixture.protocol.quiesce();
});

test("outbound frame writes and input shutdown have abortable hard deadlines", async () => {
  const writeInput = new AsyncBytes();
  let writeAborted = false;
  let writeCloseCalls = 0;
  const blockedWrite = new HarborHostProtocol({
    input: writeInput,
    write: (_wire, signal) => new Promise<void>(() => {
      signal?.addEventListener("abort", () => { writeAborted = true; }, { once: true });
    }),
    closeInput: () => { writeCloseCalls++; writeInput.close(); },
    writeDeadlineMs: 20,
  });
  writeInput.push(encodeHarborFrame(hello()));
  await blockedWrite.waitForHello();
  await expect(within(blockedWrite.nativeBackend().execute(
    "read_file",
    { path: "x.ts" },
    context(),
  ))).rejects.toThrow("write_timeout");
  expect(writeAborted).toBe(true);
  expect(blockedWrite.failureCode).toBe("write_timeout");
  await within(blockedWrite.quiesce());
  expect(writeCloseCalls).toBe(1);

  const closeInput = new AsyncBytes();
  const frames: Record<string, any>[] = [];
  let closeAborted = false;
  const blockedClose = new HarborHostProtocol({
    input: closeInput,
    write: (wire) => { frames.push(decodeHarborFrameForTest(wire)); },
    closeInput: (signal) => new Promise<void>(() => {
      signal?.addEventListener("abort", () => { closeAborted = true; }, { once: true });
    }),
    closeDeadlineMs: 20,
  });
  closeInput.push(encodeHarborFrame(hello()));
  await blockedClose.waitForHello();
  await expect(within(blockedClose.finish(EMPTY_METRICS))).rejects.toThrow("close_timeout");
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({ type: "final", metrics: EMPTY_METRICS });
  expect(closeAborted).toBe(true);
  expect(blockedClose.failureCode).toBe("close_timeout");
  await within(blockedClose.quiesce());
});

test("a blocked terminal failure frame cannot hang provider failure settlement", async () => {
  const secret = `blocked-terminal-${crypto.randomUUID()}`;
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-blocked-terminal-"));
  const input = new AsyncBytes();
  let writeAborted = false;
  let inputClosed = false;
  const protocol = new HarborHostProtocol({
    input,
    write: (wire, signal) => {
      if (decodeHarborFrameForTest(wire).type === "metrics_checkpoint") return;
      return new Promise<void>(() => {
        signal?.addEventListener("abort", () => { writeAborted = true; }, { once: true });
      });
    },
    closeInput: () => { inputClosed = true; input.close(); },
    writeDeadlineMs: 20,
  });
  input.push(encodeHarborFrame(hello()));
  const accepted = await protocol.waitForHello();
  try {
    await expect(within(runHarborHostSession({
      protocol,
      hello: accepted,
      provider: { async complete() { throw new Error(secret); } },
      hostRoot,
      maxSteps: 2,
      maxContextTokens: 20_000,
      adaptiveEffort: false,
      loop: false,
    }))).rejects.toThrow("session_failed");
    expect(writeAborted).toBe(true);
    expect(inputClosed).toBe(true);
    expect(protocol.failureCode).toBe("session_failed");
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await within(protocol.quiesce());
  }
});

test("provider failures are sanitized after disposal and never emit host secrets", async () => {
  const secret = `provider-secret-${crypto.randomUUID()}`;
  const hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-provider-failure-"));
  let disposed = false;
  const provider: Provider = {
    async complete() { throw new Error(secret); },
    dispose() { disposed = true; },
  };
  const f = await fixture();
  try {
    await expect(runHarborHostSession({
      protocol: f.protocol,
      hello: f.hello,
      provider,
      hostRoot,
      maxSteps: 2,
      maxContextTokens: 20_000,
      adaptiveEffort: false,
      loop: false,
    })).rejects.toThrow("session_failed");
    await eventually(() => f.frames.some((frame) => frame.type === "error"));
    expect(disposed).toBe(true);
    expect(JSON.stringify({ frames: f.frames, diagnostics: f.diagnostics })).not.toContain(secret);
    expect(f.frames.at(-1)).toEqual({
      schema: HARBOR_REMOTE_SCHEMA,
      type: "error",
      id: null,
      code: "session_failed",
      message: "protocol failure",
    });
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
    await f.protocol.quiesce();
  }
});

test("Harbor ChatGPT access leases are refreshless and cover the fixed run deadline", () => {
  expect(HARBOR_HOST_SESSION_BUDGET_MS).toBe(29 * 60 * 1000);
  const now = 1_900_000_000_000;
  const boundary = now + HARBOR_RUN_DEADLINE_MS + HARBOR_LEASE_MARGIN_MS;
  const config = { provider: "chatgpt", model: "gpt-5.6-sol" } as const;
  const credentials = {
    accessToken: "bounded-access",
    refreshToken: "",
    expiresAt: boundary,
    accountId: "acct-fixture",
  };
  expect(() => verifyHarborCredentialLease(config, {
    leaseMode: "1",
    now,
    loadCredentials: () => credentials,
  })).not.toThrow();
  for (const invalid of [
    { ...credentials, expiresAt: boundary - 1 },
    { ...credentials, expiresAt: boundary + 0.5 },
    { ...credentials, refreshToken: "durable-refresh-must-not-enter" },
    { ...credentials, accountId: undefined },
  ]) {
    expect(() => verifyHarborCredentialLease(config, {
      leaseMode: "1",
      now,
      loadCredentials: () => invalid as any,
    })).toThrow("credential_lease_invalid");
  }
  expect(() => verifyHarborCredentialLease(
    { provider: "openai_compat", model: "gpt-5.6-sol" },
    { leaseMode: "1", now, loadCredentials: () => credentials },
  )).toThrow("credential_lease_profile_mismatch");
  expect(() => verifyHarborCredentialLease(
    { provider: "openai_compat", model: "fixture" },
    { leaseMode: "", now, loadCredentials: () => { throw new Error("must not load"); } },
  )).not.toThrow();
});

test("GPT-5.6 digest gate hashes the executable actually chosen by managed-first Codex discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-harbor-codex-gate-"));
  const managedRoot = join(root, ".neko-core", "codex-support");
  mkdirSync(managedRoot, { recursive: true });
  const managed = join(managedRoot, "managed-app-server.bin");
  const explicit = join(root, "explicit-app-server.bin");
  writeFileSync(managed, "managed selected bytes", "utf8");
  writeFileSync(explicit, "explicit override bytes", "utf8");
  writeFileSync(join(managedRoot, "support-pack.json"), JSON.stringify({
    protocolVersion: "0.144.0",
    executable: "managed-app-server.bin",
  }), "utf8");

  try {
    const status = discoverCodexSupport({
      env: { PATH: "", NEKO_CODEX_PATH: explicit },
      home: root,
      platform: process.platform,
      cwd: root,
      pathExists: existsSync,
      realpath: realpathSync,
      isRegularFile: (path) => statSync(path).isFile(),
      readText: (path) => readFileSync(path, "utf8"),
      runVersion: () => "0.144.0",
    });
    expect(status).toMatchObject({ state: "ready", executable: { source: "managed" } });
    expect(status.executable?.path).toBe(realpathSync(managed));

    const config = { provider: "chatgpt", model: "gpt-5.6-test" } as const;
    const explicitDigest = await sha256(explicit);
    const managedDigest = await sha256(managed);
    const discover = () => status;
    expect(() => verifyExpectedCodexForHarbor(config, { expectedDigest: explicitDigest, discover }))
      .toThrow("codex_digest_mismatch");
    expect(() => verifyExpectedCodexForHarbor(config, { expectedDigest: managedDigest, discover }))
      .not.toThrow();
    expect(() => verifyExpectedCodexForHarbor(config, { expectedDigest: "", discover }))
      .toThrow("codex_digest_required");

    let directDiscoveryCalls = 0;
    expect(() => verifyExpectedCodexForHarbor(
      { provider: "chatgpt", model: "gpt-5.5" },
      { expectedDigest: "", discover: () => { directDiscoveryCalls++; return status; } },
    )).not.toThrow();
    expect(directDiscoveryCalls).toBe(0);

    const errors: string[] = [];
    for (const expectedDigest of [explicitDigest, ""]) {
      try { verifyExpectedCodexForHarbor(config, { expectedDigest, discover }); }
      catch (error) { errors.push(String(error)); }
    }
    expect(JSON.stringify(errors)).not.toContain(root);
    expect(JSON.stringify(errors)).not.toContain(explicitDigest);
    expect(JSON.stringify(errors)).not.toContain(managedDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || isText(address)) throw new Error("fake provider did not bind TCP");
  return address.port;
}

async function* childFrames(child: ChildProcessWithoutNullStreams): AsyncGenerator<Record<string, any>> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of child.stdout) {
    buffered = buffered.length ? Buffer.concat([buffered, Buffer.from(chunk)]) : Buffer.from(chunk);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (buffered.length < length + 4) break;
      const wire = buffered.subarray(0, length + 4);
      buffered = buffered.subarray(length + 4);
      yield decodeHarborFrameForTest(wire);
    }
  }
  if (buffered.length) throw new Error("subprocess returned a truncated frame");
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

test("a deterministic single-file host artifact runs framed stdio and checkpoints a pre-final failure", async () => {
  const secret = `subprocess-secret-${crypto.randomUUID()}`;
  const tempHome = mkdtempSync(join(tmpdir(), "neko-harbor-subprocess-"));
  const buildA = mkdtempSync(join(tmpdir(), "neko-harbor-build-a-"));
  const buildB = mkdtempSync(join(tmpdir(), "neko-harbor-build-b-"));
  const protocolFrames: Record<string, any>[] = [];
  const authHeaders: string[] = [];
  let providerCalls = 0;
  const server = createServer(async (request, response) => {
    authHeaders.push(String(request.headers.authorization ?? ""));
    for await (const _chunk of request) { /* consume the bounded local request */ }
    providerCalls++;
    const tool = providerCalls === 1
      ? { id: "read", name: "read_file", arguments: { path: "src/x.ts" } }
      : providerCalls === 2
        ? { id: "edit", name: "edit", arguments: { path: "src/x.ts", old_string: "a", new_string: "b" } }
        : providerCalls === 3
          ? { id: "test", name: "bash", arguments: { command: "bun test test/x.test.ts" } }
          : undefined;
    const body = tool
      ? {
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: tool.id,
                type: "function",
                function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
              }],
            },
          }],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, cached_tokens: 5 },
        }
      : {
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, cached_tokens: 5 },
        };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const port = await listen(server);
  const source = realpathSync(fileURLToPath(new URL("../evals/harbor/host_runner.ts", import.meta.url)));
  const artifactName = process.platform === "win32" ? "neko-harbor-host.exe" : "neko-harbor-host";
  const runnerA = join(buildA, artifactName);
  const runnerB = join(buildB, artifactName);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const build = promisify(execFile);
    await Promise.all([
      build(process.execPath, ["build", source, "--compile", "--outfile", runnerA]),
      build(process.execPath, ["build", source, "--compile", "--outfile", runnerB]),
    ]);
    expect(statSync(runnerA).nlink).toBe(1);
    expect(statSync(runnerB).nlink).toBe(1);
    expect(await sha256(runnerA)).toBe(await sha256(runnerB));
    expect(realpathSync(runnerA)).toBe(realpathSync(join(buildA, artifactName)));

    child = spawn(runnerA, [], {
      cwd: tempHome,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        NEKO_PROFILE: "",
        NEKO_PROVIDER: "openai_compat",
        NEKO_BASE_URL: `http://127.0.0.1:${port}/v1`,
        NEKO_MODEL: "fake-harbor-model",
        NEKO_API_KEY: secret,
        NEKO_MAX_STEPS: "8",
        NEKO_MAX_RETRIES: "0",
        NEKO_OFFLINE_RETRY_SECONDS: "0",
        NEKO_TIMEOUT_SECONDS: "5",
        NEKO_ADAPTIVE_EFFORT: "0",
        NEKO_HARBOR_LOOP: "0",
        NEKO_HARBOR_HOST_MODE: "1",
        NEKO_HARBOR_SESSION_DEADLINE_AT_MS: String(Date.now() + HARBOR_HOST_SESSION_BUDGET_MS),
        NEKO_AUTO_UPDATE: "0",
        NEKO_AUTO_UPDATE_CHECK: "0",
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    const frames = childFrames(child)[Symbol.asyncIterator]();
    child.stdin.write(Buffer.from(encodeHarborFrame(hello("public"))));

    for (;;) {
      const next = await Promise.race([
        frames.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("subprocess frame timeout")), 10_000)),
      ]);
      if (next.done) throw new Error("subprocess closed before final");
      const frame = next.value;
      protocolFrames.push(frame);
      if (frame.type === "request") {
        const replies: Record<string, string> = {
          read_file: "1: a",
          edit: "Edited src/x.ts  (+1 -1)",
          bash: "(exit 0)\n1 pass",
        };
        child.stdin.write(Buffer.from(encodeHarborFrame({
          schema: HARBOR_REMOTE_SCHEMA,
          type: "result",
          id: frame.id,
          result: replies[frame.tool],
        })));
      }
      if (frame.type === "final") break;
    }
    child.stdin.end();
    const [code, signal] = await exited;
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(protocolFrames.filter((frame) => frame.type === "request").map((frame) => frame.tool))
      .toEqual(["read_file", "edit", "bash"]);
    expect(protocolFrames.at(-1)).toMatchObject({
      schema: HARBOR_REMOTE_SCHEMA,
      type: "final",
      metrics: {
        completionStatus: "ok",
        usageComplete: true,
        providerCompleteCalls: 4,
        providerReportedModelCalls: 4,
        inputTokens: 44,
        outputTokens: 12,
        cachedTokens: 20,
        totalTokens: 56,
        hitMaxSteps: false,
        toolCalls: { requested: 3, completed: 3, productive: 3, empty: 0, failed: 0 },
      },
    });
    expect(Number.isSafeInteger(protocolFrames.at(-1)?.metrics?.wallTimeMs)).toBe(true);
    expect(authHeaders).toHaveLength(4);
    expect(authHeaders.every((value) => value === `Bearer ${secret}`)).toBe(true);
    expect(JSON.stringify(protocolFrames)).not.toContain(secret);
    expect(stderr).not.toContain(secret);

    providerCalls = 0;
    authHeaders.length = 0;
    const failureFrames: Record<string, any>[] = [];
    child = spawn(runnerA, [], {
      cwd: tempHome,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        NEKO_PROFILE: "",
        NEKO_PROVIDER: "openai_compat",
        NEKO_BASE_URL: `http://127.0.0.1:${port}/v1`,
        NEKO_MODEL: "fake-harbor-model",
        NEKO_API_KEY: secret,
        NEKO_MAX_STEPS: "2",
        NEKO_MAX_RETRIES: "0",
        NEKO_OFFLINE_RETRY_SECONDS: "0",
        NEKO_TIMEOUT_SECONDS: "5",
        NEKO_ADAPTIVE_EFFORT: "0",
        NEKO_HARBOR_LOOP: "0",
        NEKO_HARBOR_HOST_MODE: "1",
        NEKO_HARBOR_SESSION_DEADLINE_AT_MS: String(Date.now() + HARBOR_HOST_SESSION_BUDGET_MS),
        NEKO_AUTO_UPDATE: "0",
        NEKO_AUTO_UPDATE_CHECK: "0",
      },
    });
    let failureStderr = "";
    child.stderr.on("data", (chunk) => { failureStderr += String(chunk); });
    const failureExit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    const failureStream = childFrames(child)[Symbol.asyncIterator]();
    child.stdin.write(Buffer.from(encodeHarborFrame(hello("public"))));
    for (;;) {
      const next = await Promise.race([
        failureStream.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("failure checkpoint timeout")), 10_000)),
      ]);
      if (next.done) break;
      failureFrames.push(next.value);
      if (next.value.type === "request") {
        child.stdin.write(Buffer.from(encodeHarborFrame({
          schema: HARBOR_REMOTE_SCHEMA,
          type: "error",
          id: null,
          code: "fixture_failure",
          message: "fixed peer failure",
        })));
      }
    }
    const [failureCode, failureSignal] = await failureExit;
    expect(failureSignal).toBeNull();
    expect(failureCode).not.toBe(0);
    expect(failureFrames.some((frame) => frame.type === "final")).toBe(false);
    const failedRequestIndex = failureFrames.findIndex((frame) => frame.type === "request");
    expect(failedRequestIndex).toBeGreaterThan(0);
    expect(failureFrames[failedRequestIndex - 1]).toMatchObject({
      schema: HARBOR_REMOTE_SCHEMA,
      type: "metrics_checkpoint",
      metrics: {
        providerCompleteCalls: 1,
        providerUsageObservedCalls: 1,
        providerReportedModelCalls: 1,
        inputTokens: 11,
        outputTokens: 3,
        cachedTokens: 5,
        totalTokens: 14,
        toolCalls: { requested: 1, completed: 0, productive: 0, empty: 0, failed: 0 },
      },
    });
    expect(authHeaders).toEqual([`Bearer ${secret}`]);
    expect(JSON.stringify(failureFrames)).not.toContain(secret);
    expect(failureStderr).not.toContain(secret);
  } finally {
    child?.kill();
    server.close();
    await once(server, "close").catch(() => {});
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(buildA, { recursive: true, force: true });
    rmSync(buildB, { recursive: true, force: true });
  }
}, 60_000);
