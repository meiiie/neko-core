/** Credential-safe Harbor runner: the provider stays on the host while native tools run remotely. */
import { createHash } from "node:crypto";
import {
  closeSync, fstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  Agent,
  DEFAULT_SYSTEM_PROMPT,
  classifyToolObservation,
  unwrapToolArgs,
  type AgentCompletionStatus,
} from "../../src/core/agent.ts";
import type { Provider } from "../../src/core/ports.ts";
import { CostTracker, type Usage } from "../../src/core/cost.ts";
import {
  ToolRegistry,
  type NativeToolBackend,
  type NativeToolBackendAttestation,
  type NativeToolCallContext,
  type NativeToolName,
} from "../../src/core/tool-runtime.ts";
import { loadConfig, type NekoConfig } from "../../src/adapters/config.ts";
import { getProvider } from "../../src/adapters/providers.ts";
import { discoverCodexSupport, type CodexSupportStatus } from "../../src/adapters/codex-app-server.ts";
import { loadChatGptCredentials, type ChatGptCredentials } from "../../src/adapters/chatgpt-auth.ts";

export const HARBOR_REMOTE_SCHEMA = "neko.harbor.remote-tools.v2" as const;
export const HARBOR_RUN_DEADLINE_MS = 30 * 60 * 1000;
export const HARBOR_LEASE_MARGIN_MS = 5 * 60 * 1000;
// Keep these synchronized with neko_host_agent.py: Python owns the final 60 seconds of the
// official Harbor timeout, while this process owns the active controller budget before that.
export const HARBOR_HOST_SESSION_BUDGET_MS = HARBOR_RUN_DEADLINE_MS - 60 * 1000;
export const HARBOR_TOOL_FINALIZATION_RESERVE_MS = 90 * 1000;
export const HARBOR_CONTROLLER_FINALIZATION_RESERVE_MS = 30 * 1000;
export const HARBOR_FINALIZATION_OBSERVATION =
  "Error: Harbor finalization budget exhausted; remote tool work is closed. Return the best final answer now.";
export const HARBOR_NATIVE_TOOLS = Object.freeze([
  "read_file", "search", "glob", "ls", "write_file", "edit", "multi_edit", "bash",
] as const satisfies readonly NativeToolName[]);

export const HARBOR_FRAME_LIMITS = Object.freeze({
  frameBytes: 1_048_576,
  instructionBytes: 512 * 1024,
  argumentBytes: 512 * 1024,
  // Remote observations are capped at 48k Unicode characters. Four-byte UTF-8 must still fit.
  resultBytes: 256 * 1024,
  errorBytes: 2 * 1024,
  idBytes: 64,
  maxQueuedCalls: 64,
  nonBashDeadlineMs: 30_000,
  minBashExecutionMs: 1,
  maxBashExecutionMs: 9 * 60 * 1000,
  bashSettlementReserveMs: 60 * 1000,
  maxBashSettlementMs: 10 * 60 * 1000,
  cancelAckMs: 50_000,
  writeDeadlineMs: 5_000,
  closeDeadlineMs: 1_000,
});

type NetworkMode = "no-network" | "allowlist" | "public";

export interface HarborPosture {
  execution: "harbor-base-environment";
  hostCredentialsInTask: false;
  hostDaemonSocketInTask: false;
  obviousHostRootMountInTask: false;
  networkMode: NetworkMode;
  allowedHosts: string[];
}

export interface HarborHello {
  schema: typeof HARBOR_REMOTE_SCHEMA;
  type: "hello";
  instruction: string;
  tools: NativeToolName[];
  attestation: NativeToolBackendAttestation;
  posture: HarborPosture;
}

export type HarborSanitizedCompletionStatus = "ok" | "validation_failed" | "validation_missing";

export interface HarborFinalMetrics {
  /** Agent validation-debt gate only; this is not the Harbor verifier or task-success verdict. */
  completionStatus: HarborSanitizedCompletionStatus;
  /** True only when every outer Provider.complete invocation produced a complete final/live usage snapshot. */
  usageComplete: boolean;
  /** Exact Agent-to-Provider.complete invocations, including compaction and max-step wrap-up calls. */
  providerCompleteCalls: number;
  /** CostTracker-normalized provider model calls; null with every token field when usageComplete is false. */
  providerReportedModelCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  wallTimeMs: number;
  hitMaxSteps: boolean;
  toolCalls: {
    requested: number;
    completed: number;
    productive: number;
    empty: number;
    failed: number;
  };
}

/** Privacy-safe lower-bound telemetry that remains useful when no final frame can be emitted. */
export interface HarborPartialMetrics {
  providerCompleteCalls: number;
  providerUsageObservedCalls: number;
  providerReportedModelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  wallTimeMs: number;
  hitMaxSteps: boolean;
  toolCalls: {
    requested: number;
    completed: number;
    productive: number;
    empty: number;
    failed: number;
  };
}

export interface HarborProtocolIo {
  input: AsyncIterable<Uint8Array>;
  write(chunk: Uint8Array, signal?: AbortSignal): void | Promise<void>;
  closeInput?(signal?: AbortSignal): void | Promise<void>;
  diagnostic?(code: "protocol_failure" | "session_failure"): void;
  /** Test/embedding overrides may only shorten the production hard deadline. */
  writeDeadlineMs?: number;
  closeDeadlineMs?: number;
}

type PendingCall = {
  id: string;
  name: NativeToolName;
  args: Readonly<Record<string, any>>;
  context: NativeToolCallContext;
  resolve: (value: string | any[]) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  remoteDeadlineAt?: number;
  deadlineAt?: number;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  cancelTimer?: ReturnType<typeof setTimeout>;
  cancelSent: boolean;
  settled: boolean;
};

type ProtocolPhase = "hello" | "running" | "finishing" | "finished" | "failed";

class HostProtocolError extends Error {
  constructor(readonly code: string) {
    super(`Harbor host protocol failed (${code})`);
    this.name = "HostProtocolError";
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, any>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && byteLength(value) <= HARBOR_FRAME_LIMITS.idBytes
    && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

function validCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

function validJsonValue(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  if (++budget.nodes > 20_000 || depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000
    && value.every((entry) => validJsonValue(entry, depth + 1, budget));
  if (!isPlainObject(value) || Object.keys(value).length > 10_000) return false;
  return Object.entries(value).every(([key, entry]) => byteLength(key) <= 1024
    && validJsonValue(entry, depth + 1, budget));
}

function jsonBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new HostProtocolError("invalid_json_value");
  return byteLength(encoded);
}

function canonicalPosixRoot(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const segments = value.split("/").slice(1);
  return value.startsWith("/") && value !== "/" && !value.includes("\\") && !value.includes("//")
    && !/[\x00-\x1f\x7f]/.test(value) && !value.endsWith("/")
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function validateAllowedHosts(mode: NetworkMode, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new HostProtocolError("invalid_posture");
  const hosts = value.map((host) => {
    if (typeof host !== "string" || !host || byteLength(host) > 512 || /[\x00-\x20\x7f]/.test(host)) {
      throw new HostProtocolError("invalid_posture");
    }
    return host;
  });
  if ((mode === "no-network" || mode === "public") && hosts.length !== 0) {
    throw new HostProtocolError("network_posture_mismatch");
  }
  return hosts;
}

function validateAttestation(raw: unknown): NativeToolBackendAttestation {
  if (!isPlainObject(raw) || !exactKeys(raw, [
    "protocol", "canonicalPosixRoot", "pathChecks", "structuredWriteConfinement",
    "exactEditTarget", "bashSandbox", "exactValidatorSandbox", "boundedObservations",
    "deadlineAndCancellation", "checkpointRewind",
  ])) throw new HostProtocolError("invalid_attestation");
  if (raw.protocol !== "neko-native-posix-v1" || !canonicalPosixRoot(raw.canonicalPosixRoot)
    || raw.pathChecks !== "backend-enforced" || raw.structuredWriteConfinement !== "backend-enforced"
    || raw.exactEditTarget !== "backend-enforced" || raw.bashSandbox !== "backend-enforced"
    || raw.exactValidatorSandbox !== "unsupported" || raw.boundedObservations !== "backend-enforced"
    || raw.deadlineAndCancellation !== "backend-enforced-quiescent"
    || raw.checkpointRewind !== "unsupported") {
    throw new HostProtocolError("attestation_mismatch");
  }
  return Object.freeze({ ...raw }) as NativeToolBackendAttestation;
}

function validatePosture(raw: unknown): HarborPosture {
  if (!isPlainObject(raw) || !exactKeys(raw, [
    "execution", "hostCredentialsInTask", "hostDaemonSocketInTask", "obviousHostRootMountInTask",
    "networkMode", "allowedHosts",
  ])) throw new HostProtocolError("invalid_posture");
  if (raw.execution !== "harbor-base-environment" || raw.hostCredentialsInTask !== false
    || raw.hostDaemonSocketInTask !== false || raw.obviousHostRootMountInTask !== false
    || !new Set<unknown>(["no-network", "allowlist", "public"]).has(raw.networkMode)) {
    throw new HostProtocolError("posture_mismatch");
  }
  const networkMode = raw.networkMode as NetworkMode;
  const allowedHosts = validateAllowedHosts(networkMode, raw.allowedHosts);
  return Object.freeze({
    execution: "harbor-base-environment",
    hostCredentialsInTask: false,
    hostDaemonSocketInTask: false,
    obviousHostRootMountInTask: false,
    networkMode,
    allowedHosts: Object.freeze([...allowedHosts]) as unknown as string[],
  });
}

function validateHello(raw: unknown): HarborHello {
  if (!isPlainObject(raw) || !exactKeys(raw, ["schema", "type", "instruction", "tools", "attestation", "posture"])) {
    throw new HostProtocolError("invalid_hello");
  }
  if (raw.schema !== HARBOR_REMOTE_SCHEMA || raw.type !== "hello" || typeof raw.instruction !== "string"
    || byteLength(raw.instruction) > HARBOR_FRAME_LIMITS.instructionBytes || !Array.isArray(raw.tools)
    || !sameStrings(raw.tools, HARBOR_NATIVE_TOOLS)) {
    throw new HostProtocolError("hello_mismatch");
  }
  return Object.freeze({
    schema: HARBOR_REMOTE_SCHEMA,
    type: "hello",
    instruction: raw.instruction,
    tools: Object.freeze([...HARBOR_NATIVE_TOOLS]) as unknown as NativeToolName[],
    attestation: validateAttestation(raw.attestation),
    posture: validatePosture(raw.posture),
  });
}

function safeMetricCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function completeUsageSnapshot(value: Usage | undefined): value is Usage {
  if (!value) return false;
  const count = (raw: unknown) => typeof raw === "number" && Number.isFinite(raw) && raw >= 0;
  return count(value.prompt_tokens) && count(value.completion_tokens) && count(value.total_tokens);
}

function validateFinalMetrics(raw: unknown): HarborFinalMetrics {
  if (!isPlainObject(raw) || !exactKeys(raw, [
    "completionStatus", "usageComplete", "providerCompleteCalls", "providerReportedModelCalls",
    "inputTokens", "outputTokens", "cachedTokens", "totalTokens", "wallTimeMs", "hitMaxSteps", "toolCalls",
  ])) {
    throw new HostProtocolError("invalid_final_metrics");
  }
  if (!new Set<unknown>(["ok", "validation_failed", "validation_missing"]).has(raw.completionStatus)
    || typeof raw.usageComplete !== "boolean" || !safeMetricCount(raw.providerCompleteCalls)
    || !safeMetricCount(raw.wallTimeMs) || typeof raw.hitMaxSteps !== "boolean"
    || !isPlainObject(raw.toolCalls)
    || !exactKeys(raw.toolCalls, ["requested", "completed", "productive", "empty", "failed"])) {
    throw new HostProtocolError("invalid_final_metrics");
  }
  const reportedCounts = [
    raw.providerReportedModelCalls,
    raw.inputTokens,
    raw.outputTokens,
    raw.cachedTokens,
    raw.totalTokens,
  ];
  const toolCounts = [
    raw.toolCalls.requested,
    raw.toolCalls.completed,
    raw.toolCalls.productive,
    raw.toolCalls.empty,
    raw.toolCalls.failed,
  ];
  const completeUsageValid = reportedCounts.every(safeMetricCount)
    && raw.providerCompleteCalls > 0
    && raw.providerReportedModelCalls >= raw.providerCompleteCalls
    && raw.cachedTokens <= raw.inputTokens
    && raw.totalTokens >= raw.inputTokens + raw.outputTokens;
  if (!toolCounts.every(safeMetricCount)
    || (raw.usageComplete ? !completeUsageValid : reportedCounts.some((count) => count !== null))
    || raw.toolCalls.completed > raw.toolCalls.requested
    || raw.toolCalls.completed !== raw.toolCalls.productive + raw.toolCalls.empty + raw.toolCalls.failed) {
    throw new HostProtocolError("invalid_final_metrics");
  }
  return Object.freeze({
    completionStatus: raw.completionStatus,
    usageComplete: raw.usageComplete,
    providerCompleteCalls: raw.providerCompleteCalls,
    providerReportedModelCalls: raw.providerReportedModelCalls,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cachedTokens: raw.cachedTokens,
    totalTokens: raw.totalTokens,
    wallTimeMs: raw.wallTimeMs,
    hitMaxSteps: raw.hitMaxSteps,
    toolCalls: Object.freeze({
      requested: raw.toolCalls.requested,
      completed: raw.toolCalls.completed,
      productive: raw.toolCalls.productive,
      empty: raw.toolCalls.empty,
      failed: raw.toolCalls.failed,
    }),
  }) as HarborFinalMetrics;
}

function validatePartialMetrics(raw: unknown): HarborPartialMetrics {
  if (!isPlainObject(raw) || !exactKeys(raw, [
    "providerCompleteCalls", "providerUsageObservedCalls", "providerReportedModelCalls",
    "inputTokens", "outputTokens", "cachedTokens", "totalTokens", "wallTimeMs",
    "hitMaxSteps", "toolCalls",
  ]) || typeof raw.hitMaxSteps !== "boolean" || !isPlainObject(raw.toolCalls)
    || !exactKeys(raw.toolCalls, ["requested", "completed", "productive", "empty", "failed"])) {
    throw new HostProtocolError("invalid_partial_metrics");
  }
  const counts = [
    raw.providerCompleteCalls,
    raw.providerUsageObservedCalls,
    raw.providerReportedModelCalls,
    raw.inputTokens,
    raw.outputTokens,
    raw.cachedTokens,
    raw.totalTokens,
    raw.wallTimeMs,
    raw.toolCalls.requested,
    raw.toolCalls.completed,
    raw.toolCalls.productive,
    raw.toolCalls.empty,
    raw.toolCalls.failed,
  ];
  if (!counts.every(safeMetricCount)
    || raw.providerUsageObservedCalls > raw.providerCompleteCalls
    || (raw.providerUsageObservedCalls === 0
      ? [raw.providerReportedModelCalls, raw.inputTokens, raw.outputTokens, raw.cachedTokens, raw.totalTokens]
          .some((count) => count !== 0)
      : raw.providerReportedModelCalls < raw.providerUsageObservedCalls)
    || raw.cachedTokens > raw.inputTokens
    || raw.totalTokens < raw.inputTokens + raw.outputTokens
    || raw.toolCalls.completed > raw.toolCalls.requested
    || raw.toolCalls.completed !== raw.toolCalls.productive + raw.toolCalls.empty + raw.toolCalls.failed) {
    throw new HostProtocolError("invalid_partial_metrics");
  }
  return Object.freeze({
    providerCompleteCalls: raw.providerCompleteCalls,
    providerUsageObservedCalls: raw.providerUsageObservedCalls,
    providerReportedModelCalls: raw.providerReportedModelCalls,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cachedTokens: raw.cachedTokens,
    totalTokens: raw.totalTokens,
    wallTimeMs: raw.wallTimeMs,
    hitMaxSteps: raw.hitMaxSteps,
    toolCalls: Object.freeze({
      requested: raw.toolCalls.requested,
      completed: raw.toolCalls.completed,
      productive: raw.toolCalls.productive,
      empty: raw.toolCalls.empty,
      failed: raw.toolCalls.failed,
    }),
  }) as HarborPartialMetrics;
}

function sanitizeCompletionStatus(status: AgentCompletionStatus): HarborSanitizedCompletionStatus {
  if (status.ok) return "ok";
  if (status.reason === "validation_failed" || status.reason === "validation_missing") return status.reason;
  throw new HostProtocolError("invalid_completion_status");
}

function transportDeadline(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? Math.min(value as number, fallback)
    : fallback;
}

function boundedTransportAction(
  action: (signal: AbortSignal) => void | Promise<void>,
  deadlineMs: number,
  failureCode: string,
  timeoutCode: string,
  parentSignal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onParentAbort = () => {
      try { controller.abort(); } catch { /* transport cancellation is best effort */ }
      settle(new HostProtocolError(failureCode));
    };
    const settle = (error?: HostProtocolError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
      if (error) reject(error);
      else resolve();
    };
    if (parentSignal?.aborted) {
      onParentAbort();
      return;
    }
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    timer = setTimeout(() => {
      try { controller.abort(); } catch { /* transport cancellation is best effort */ }
      settle(new HostProtocolError(timeoutCode));
    }, deadlineMs);
    try {
      Promise.resolve(action(controller.signal)).then(
        () => settle(),
        () => {
          try { controller.abort(); } catch { /* transport cancellation is best effort */ }
          settle(new HostProtocolError(failureCode));
        },
      );
    } catch {
      try { controller.abort(); } catch { /* transport cancellation is best effort */ }
      settle(new HostProtocolError(failureCode));
    }
  });
}

function transportFailureCode(error: unknown, fallback: string): string {
  return error instanceof HostProtocolError && validCode(error.code) ? error.code : fallback;
}

/** Encode one frozen protocol frame. Exported only so deterministic no-process tests use the wire. */
export function encodeHarborFrame(frame: unknown): Uint8Array {
  if (!isPlainObject(frame)) throw new HostProtocolError("invalid_outbound_frame");
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  if (payload.length < 1 || payload.length > HARBOR_FRAME_LIMITS.frameBytes) {
    throw new HostProtocolError("outbound_frame_too_large");
  }
  const wire = Buffer.allocUnsafe(payload.length + 4);
  wire.writeUInt32BE(payload.length, 0);
  payload.copy(wire, 4);
  return wire;
}

export function decodeHarborFrameForTest(wire: Uint8Array): Record<string, any> {
  const bytes = Buffer.from(wire);
  if (bytes.length < 5 || bytes.readUInt32BE(0) !== bytes.length - 4) {
    throw new HostProtocolError("invalid_test_frame");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4)));
  if (!isPlainObject(value)) throw new HostProtocolError("invalid_test_frame");
  return value;
}

export class HarborHostProtocol {
  private phase: ProtocolPhase = "hello";
  private helloValue?: HarborHello;
  private readonly helloPromise: Promise<HarborHello>;
  private resolveHello!: (hello: HarborHello) => void;
  private rejectHello!: (error: Error) => void;
  private helloSettled = false;
  private readonly abort = new AbortController();
  private readonly outboundAbort = new AbortController();
  private readonly queue: PendingCall[] = [];
  private active?: PendingCall;
  private nextId = 1;
  private writeChain: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private terminalTask?: Promise<void>;
  private readonly readerTask: Promise<void>;
  private failure?: HostProtocolError;
  private backendValue?: HarborNativeBackend;
  private readonly writeDeadlineMs: number;
  private readonly closeDeadlineMs: number;

  constructor(private readonly io: HarborProtocolIo) {
    this.writeDeadlineMs = transportDeadline(io.writeDeadlineMs, HARBOR_FRAME_LIMITS.writeDeadlineMs);
    this.closeDeadlineMs = transportDeadline(io.closeDeadlineMs, HARBOR_FRAME_LIMITS.closeDeadlineMs);
    this.helloPromise = new Promise<HarborHello>((resolve, reject) => {
      this.resolveHello = resolve;
      this.rejectHello = reject;
    });
    this.readerTask = this.readLoop().catch(() => {
      this.fail("reader_failure", false);
    });
    void this.readerTask.catch(() => {});
  }

  get signal(): AbortSignal { return this.abort.signal; }
  get failed(): boolean { return this.phase === "failed"; }
  get finished(): boolean { return this.phase === "finished"; }
  get failureCode(): string | undefined { return this.failure?.code; }

  private terminal(): boolean {
    return this.phase === "finished" || this.phase === "failed";
  }

  async waitForHello(): Promise<HarborHello> {
    return await this.helloPromise;
  }

  nativeBackend(): NativeToolBackend {
    if (!this.helloValue || this.phase !== "running") throw new HostProtocolError("hello_not_ready");
    this.backendValue ??= new HarborNativeBackend(this, this.helloValue);
    return this.backendValue;
  }

  checkpoint(metrics: HarborPartialMetrics): Promise<void> {
    if (this.phase !== "running") {
      return Promise.reject(this.failure ?? new HostProtocolError("transport_not_running"));
    }
    const sanitized = validatePartialMetrics(metrics);
    const write = this.writeFrame({
      schema: HARBOR_REMOTE_SCHEMA,
      type: "metrics_checkpoint",
      metrics: sanitized,
    }, "running");
    const enforced = write.catch((error) => {
      this.fail(transportFailureCode(error, "checkpoint_write_failure"), false);
      throw this.failure ?? new HostProtocolError("checkpoint_write_failure");
    });
    // Replace the recoverable write tail with a fail-closed barrier before any caller can enqueue
    // a provider-dependent request behind this checkpoint.
    this.writeChain = enforced.catch(() => {});
    return enforced;
  }

  async finish(metrics: HarborFinalMetrics): Promise<void> {
    if (this.phase !== "running" || this.active || this.queue.length) {
      throw new HostProtocolError("finish_with_active_request");
    }
    const sanitized = validateFinalMetrics(metrics);
    this.phase = "finishing";
    try {
      await this.writeFrame({ schema: HARBOR_REMOTE_SCHEMA, type: "final", metrics: sanitized }, "finishing");
    } catch (error) {
      this.fail(transportFailureCode(error, "write_failure"), false);
      await this.terminalTask;
      throw this.failure ?? new HostProtocolError("transport_failed_during_final");
    }
    if (this.failed) throw this.failure ?? new HostProtocolError("transport_failed_during_final");
    try {
      await this.closeInput();
    } catch (error) {
      this.fail(transportFailureCode(error, "close_failure"), false);
      await this.terminalTask;
      throw this.failure ?? new HostProtocolError("close_failure");
    }
    if (this.failed) throw this.failure ?? new HostProtocolError("transport_failed_during_final");
    this.phase = "finished";
  }

  async failSession(code = "session_failed"): Promise<void> {
    this.fail(validCode(code) ? code : "session_failed", true, "session_failure");
    await this.writeChain.catch(() => {});
    await this.terminalTask;
  }

  async quiesce(): Promise<void> {
    await this.writeChain.catch(() => {});
    await this.terminalTask;
    await this.closeInput().catch(() => {});
    await Promise.race([
      this.readerTask.catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
  }

  enqueue(
    name: NativeToolName,
    args: Readonly<Record<string, any>>,
    context: NativeToolCallContext,
  ): Promise<string | any[]> {
    if (this.phase !== "running" || !this.helloValue) {
      return Promise.reject(this.failure ?? new HostProtocolError("transport_not_running"));
    }
    if (!HARBOR_NATIVE_TOOLS.includes(name) || !isPlainObject(args) || !validJsonValue(args)
      || jsonBytes(args) > HARBOR_FRAME_LIMITS.argumentBytes) {
      return Promise.reject(new HostProtocolError("invalid_tool_request"));
    }
    if (this.queue.length + (this.active ? 1 : 0) >= HARBOR_FRAME_LIMITS.maxQueuedCalls) {
      return Promise.reject(new HostProtocolError("tool_queue_full"));
    }
    return new Promise<string | any[]>((resolve, reject) => {
      const call: PendingCall = {
        id: `r${this.nextId++}`,
        name,
        args,
        context,
        resolve,
        reject,
        signal: context.signal,
        cancelSent: false,
        settled: false,
      };
      if (call.signal?.aborted) {
        call.settled = true;
        resolve("(interrupted)");
        return;
      }
      call.onAbort = () => this.abortCall(call);
      call.signal?.addEventListener("abort", call.onAbort, { once: true });
      this.queue.push(call);
      this.pump();
    });
  }

  private async readLoop(): Promise<void> {
    let buffered = Buffer.alloc(0);
    for await (const chunk of this.io.input) {
      if (this.terminal()) return;
      const incoming = Buffer.from(chunk);
      if (!incoming.length) continue;
      buffered = buffered.length ? Buffer.concat([buffered, incoming]) : incoming;
      for (;;) {
        if (buffered.length < 4) break;
        const length = buffered.readUInt32BE(0);
        if (length < 1 || length > HARBOR_FRAME_LIMITS.frameBytes) {
          this.fail("invalid_frame_length", true);
          return;
        }
        if (buffered.length < length + 4) break;
        const payload = buffered.subarray(4, length + 4);
        buffered = buffered.subarray(length + 4);
        let frame: unknown;
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
          frame = JSON.parse(text);
        } catch {
          this.fail("malformed_frame", true);
          return;
        }
        await this.receive(frame);
        if (this.terminal()) return;
      }
      if (buffered.length > HARBOR_FRAME_LIMITS.frameBytes + 4) {
        this.fail("frame_buffer_overflow", true);
        return;
      }
    }
    if (this.terminal() || this.phase === "finishing") return;
    this.fail(buffered.length ? "truncated_frame" : "unexpected_eof", false);
  }

  private async receive(raw: unknown): Promise<void> {
    if (!isPlainObject(raw) || raw.schema !== HARBOR_REMOTE_SCHEMA || typeof raw.type !== "string") {
      this.fail("invalid_frame", true);
      return;
    }
    if (this.phase === "hello") {
      try {
        const hello = validateHello(raw);
        this.helloValue = hello;
        this.phase = "running";
        this.helloSettled = true;
        this.resolveHello(hello);
      } catch (error) {
        this.fail(error instanceof HostProtocolError ? error.code : "invalid_hello", true);
      }
      return;
    }
    if (this.phase !== "running") {
      this.fail("frame_after_close", true);
      return;
    }
    if (raw.type === "result") return this.receiveResult(raw);
    if (raw.type === "cancelled") return this.receiveCancelled(raw);
    if (raw.type === "error") return this.receiveError(raw);
    this.fail("unexpected_frame_type", true);
  }

  private receiveResult(raw: Record<string, any>): void {
    if (!exactKeys(raw, ["schema", "type", "id", "result"]) || !validId(raw.id)
      || (typeof raw.result !== "string" && !Array.isArray(raw.result))
      || !validJsonValue(raw.result) || jsonBytes(raw.result) > HARBOR_FRAME_LIMITS.resultBytes) {
      this.fail("invalid_result", true);
      return;
    }
    const call = this.active;
    if (!call || call.id !== raw.id || call.cancelSent) {
      this.fail("late_or_duplicate_result", true);
      return;
    }
    this.settle(call, () => call.resolve(raw.result));
  }

  private receiveCancelled(raw: Record<string, any>): void {
    if (!exactKeys(raw, ["schema", "type", "id", "result"]) || !validId(raw.id)
      || raw.result !== "(interrupted)") {
      this.fail("invalid_cancelled", true);
      return;
    }
    const call = this.active;
    if (!call || call.id !== raw.id || !call.cancelSent) {
      this.fail("late_or_duplicate_cancelled", true);
      return;
    }
    this.settle(call, () => call.resolve("(interrupted)"));
  }

  private receiveError(raw: Record<string, any>): void {
    if (!exactKeys(raw, ["schema", "type", "id", "code", "message"])
      || (raw.id !== null && !validId(raw.id)) || !validCode(raw.code)
      || typeof raw.message !== "string" || byteLength(raw.message) > HARBOR_FRAME_LIMITS.errorBytes) {
      this.fail("invalid_error", true);
      return;
    }
    if (raw.id === null) {
      this.fail("peer_protocol_error", false);
      return;
    }
    const call = this.active;
    if (!call || call.id !== raw.id || call.cancelSent) {
      this.fail("late_or_duplicate_error", true);
      return;
    }
    this.settle(call, () => call.reject(new Error(`remote request failed (${raw.code}): ${raw.message}`)));
  }

  private pump(): void {
    if (this.phase !== "running" || this.active || !this.queue.length || !this.helloValue) return;
    const call = this.queue.shift()!;
    if (call.signal?.aborted) {
      this.settleQueued(call, () => call.resolve("(interrupted)"));
      this.pump();
      return;
    }
    let request: Record<string, any>;
    try {
      request = this.requestFrame(call, this.helloValue);
    } catch (error) {
      this.settleQueued(call, () => call.reject(error instanceof Error ? error : new HostProtocolError("invalid_context")));
      this.pump();
      return;
    }
    this.active = call;
    const delay = Math.max(0, Math.min(2_147_483_647, (call.deadlineAt ?? Date.now()) - Date.now()));
    call.deadlineTimer = setTimeout(() => this.cancelActive(call), delay);
    void this.writeFrame(request, "running").catch((error) => {
      this.fail(transportFailureCode(error, "write_failure"), false);
    });
  }

  private requestFrame(call: PendingCall, hello: HarborHello): Record<string, any> {
    const workspace = call.context.workspace;
    const sandbox = call.context.sandbox;
    const expectedNetwork = hello.posture.networkMode !== "no-network";
    const expectedDomains = hello.posture.networkMode === "allowlist" ? hello.posture.allowedHosts : [];
    if (workspace.canonicalPosixRoot !== hello.attestation.canonicalPosixRoot || workspace.readOutsideRoot !== false
      || sandbox.enabled !== true || sandbox.allowNetwork !== expectedNetwork
      || !sameStrings(sandbox.domains, expectedDomains) || sandbox.denyReadFiles.length !== 0
      || sandbox.readOnlyWorkspace !== false) {
      throw new HostProtocolError("context_posture_mismatch");
    }
    const now = Date.now();
    if (call.name === "bash") {
      if (!Number.isSafeInteger(call.context.deadlineAt)) throw new HostProtocolError("missing_bash_deadline");
      const requestedRemainingMs = call.context.deadlineAt! - now;
      if (requestedRemainingMs < HARBOR_FRAME_LIMITS.minBashExecutionMs) {
        throw new HostProtocolError("insufficient_bash_deadline");
      }
      // The remote owns the work cutoff. The later host deadline reserves time for the remote to
      // quiesce and return a terminal frame before the host has to send cancellation.
      call.remoteDeadlineAt = now + Math.min(requestedRemainingMs, HARBOR_FRAME_LIMITS.maxBashExecutionMs);
      call.deadlineAt = now + Math.min(
        HARBOR_FRAME_LIMITS.maxBashSettlementMs,
        requestedRemainingMs + HARBOR_FRAME_LIMITS.bashSettlementReserveMs,
      );
    } else {
      call.remoteDeadlineAt = now + HARBOR_FRAME_LIMITS.nonBashDeadlineMs;
      call.deadlineAt = call.remoteDeadlineAt;
    }
    const context = {
      deadlineAt: call.remoteDeadlineAt,
      workspace: {
        canonicalPosixRoot: workspace.canonicalPosixRoot,
        readOutsideRoot: false,
        strictEditMatch: workspace.strictEditMatch,
        ...(workspace.exactEditTarget ? { exactEditTarget: workspace.exactEditTarget } : {}),
      },
      sandbox: {
        enabled: true,
        allowNetwork: expectedNetwork,
        domains: [...expectedDomains],
        denyReadFiles: [],
        readOnlyWorkspace: false,
      },
    };
    return {
      schema: HARBOR_REMOTE_SCHEMA,
      type: "request",
      id: call.id,
      tool: call.name,
      args: call.args,
      context,
    };
  }

  private abortCall(call: PendingCall): void {
    if (call.settled) return;
    if (this.active === call) {
      this.cancelActive(call);
      return;
    }
    const index = this.queue.indexOf(call);
    if (index >= 0) this.queue.splice(index, 1);
    this.settleQueued(call, () => call.resolve("(interrupted)"));
  }

  private cancelActive(call: PendingCall): void {
    if (this.phase !== "running" || this.active !== call || call.settled || call.cancelSent) return;
    call.cancelSent = true;
    if (call.deadlineTimer) clearTimeout(call.deadlineTimer);
    void this.writeFrame({ schema: HARBOR_REMOTE_SCHEMA, type: "cancel", id: call.id }, "running")
      .catch((error) => this.fail(transportFailureCode(error, "cancel_write_failure"), false));
    call.cancelTimer = setTimeout(() => this.fail("cancel_ack_timeout", true), HARBOR_FRAME_LIMITS.cancelAckMs);
  }

  private settle(call: PendingCall, settlePromise: () => void): void {
    if (this.active !== call || call.settled) {
      this.fail("duplicate_settlement", true);
      return;
    }
    this.active = undefined;
    this.cleanupCall(call);
    settlePromise();
    this.pump();
  }

  private settleQueued(call: PendingCall, settlePromise: () => void): void {
    if (call.settled) return;
    this.cleanupCall(call);
    settlePromise();
  }

  private cleanupCall(call: PendingCall): void {
    call.settled = true;
    if (call.deadlineTimer) clearTimeout(call.deadlineTimer);
    if (call.cancelTimer) clearTimeout(call.cancelTimer);
    if (call.onAbort) call.signal?.removeEventListener("abort", call.onAbort);
  }

  private writeFrame(frame: Record<string, any>, requiredPhase?: ProtocolPhase): Promise<void> {
    const wire = encodeHarborFrame(frame);
    const write = this.writeChain.then(async () => {
      if (requiredPhase && this.phase !== requiredPhase) {
        throw this.failure ?? new HostProtocolError("write_after_phase_change");
      }
      await boundedTransportAction(
        (signal) => this.io.write(wire, signal),
        this.writeDeadlineMs,
        "write_failure",
        "write_timeout",
        this.outboundAbort.signal,
      );
    });
    this.writeChain = write.catch(() => {});
    return write;
  }

  private fail(
    code: string,
    notifyPeer: boolean,
    diagnostic: "protocol_failure" | "session_failure" = "protocol_failure",
  ): void {
    if (this.phase === "failed" || this.phase === "finished") return;
    const error = new HostProtocolError(validCode(code) ? code : "protocol_failure");
    this.failure = error;
    this.phase = "failed";
    this.abort.abort();
    this.outboundAbort.abort();
    if (!this.helloSettled) {
      this.helloSettled = true;
      this.rejectHello(error);
    }
    if (this.active) {
      const active = this.active;
      this.active = undefined;
      this.cleanupCall(active);
      active.reject(error);
    }
    for (const queued of this.queue.splice(0)) {
      this.cleanupCall(queued);
      queued.reject(error);
    }
    try { this.io.diagnostic?.(diagnostic); } catch { /* diagnostics never control protocol settlement */ }
    this.terminalTask = (async () => {
      await this.writeChain.catch(() => {});
      if (notifyPeer) {
        try {
          const wire = encodeHarborFrame({
            schema: HARBOR_REMOTE_SCHEMA,
            type: "error",
            id: null,
            code: error.code,
            message: "protocol failure",
          });
          await boundedTransportAction(
            (signal) => this.io.write(wire, signal),
            this.writeDeadlineMs,
            "write_failure",
            "write_timeout",
          );
        } catch { /* the bounded terminal write is best effort after settlement */ }
      }
      await this.closeInput().catch(() => {});
    })();
    void this.terminalTask.catch(() => {});
  }

  private closeInput(): Promise<void> {
    this.closePromise ??= boundedTransportAction(
      (signal) => this.io.closeInput?.(signal),
      this.closeDeadlineMs,
      "close_failure",
      "close_timeout",
    );
    return this.closePromise;
  }
}

class HarborNativeBackend implements NativeToolBackend {
  readonly tools = HARBOR_NATIVE_TOOLS;
  readonly attestation: NativeToolBackendAttestation;

  constructor(private readonly protocol: HarborHostProtocol, hello: HarborHello) {
    this.attestation = hello.attestation;
  }

  async execute(name: NativeToolName, args: Readonly<Record<string, any>>, context: NativeToolCallContext) {
    return await this.protocol.enqueue(name, args, context);
  }
}

type MeteredToolCall = { id: string; name: string; arguments: Record<string, any> };

function meteredToolKey(name: string, args: Readonly<Record<string, any>>): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (isPlainObject(value)) {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };
  return `${name}:${canonical(args)}`;
}

/** Reconciles Agent lifecycle events with stream-eager backend execution without exposing call data. */
class HarborToolCallMeter {
  private readonly backendFirst = new Map<string, number>();
  private readonly eventFirst = new Map<string, Array<{ id: string; checkpoint: Promise<void> }>>();

  constructor(private readonly recordRequested: () => Promise<void>) {}

  onAgentCall(call: MeteredToolCall): void {
    const key = meteredToolKey(call.name, unwrapToolArgs(call.arguments));
    const backendCount = this.backendFirst.get(key) ?? 0;
    if (backendCount > 0) {
      if (backendCount === 1) this.backendFirst.delete(key);
      else this.backendFirst.set(key, backendCount - 1);
      return;
    }
    const checkpoint = this.recordRequested();
    const waiting = this.eventFirst.get(key) ?? [];
    waiting.push({ id: call.id, checkpoint });
    this.eventFirst.set(key, waiting);
    void checkpoint.catch(() => {});
  }

  onAgentResult(call: MeteredToolCall): void {
    const key = meteredToolKey(call.name, unwrapToolArgs(call.arguments));
    const waiting = this.eventFirst.get(key);
    if (!waiting?.length) return;
    const index = waiting.findIndex((entry) => entry.id === call.id);
    if (index >= 0) waiting.splice(index, 1);
    if (!waiting.length) this.eventFirst.delete(key);
  }

  async beforeBackend(name: NativeToolName, args: Readonly<Record<string, any>>): Promise<void> {
    const key = meteredToolKey(name, args);
    const waiting = this.eventFirst.get(key);
    const eventReservation = waiting?.shift();
    if (waiting && !waiting.length) this.eventFirst.delete(key);
    if (eventReservation) {
      await eventReservation.checkpoint;
      return;
    }
    this.backendFirst.set(key, (this.backendFirst.get(key) ?? 0) + 1);
    await this.recordRequested();
  }
}

class MeteredHarborNativeBackend implements NativeToolBackend {
  readonly tools: readonly NativeToolName[];
  readonly attestation: NativeToolBackendAttestation;

  constructor(
    private readonly backend: NativeToolBackend,
    private readonly meter: HarborToolCallMeter,
  ) {
    this.tools = backend.tools;
    this.attestation = backend.attestation;
  }

  async execute(name: NativeToolName, args: Readonly<Record<string, any>>, context: NativeToolCallContext) {
    await this.meter.beforeBackend(name, args);
    return await this.backend.execute(name, args, context);
  }
}

/** Prevents a late remote request from consuming the time reserved for provider and protocol finalization. */
class FinalizationReservedHarborNativeBackend implements NativeToolBackend {
  readonly tools: readonly NativeToolName[];
  readonly attestation: NativeToolBackendAttestation;

  constructor(
    private readonly backend: NativeToolBackend,
    private readonly admissionDeadlineAt: number,
  ) {
    this.tools = backend.tools;
    this.attestation = backend.attestation;
  }

  async execute(name: NativeToolName, args: Readonly<Record<string, any>>, context: NativeToolCallContext) {
    const now = Date.now();
    const bashWorkDeadlineAt = this.admissionDeadlineAt - HARBOR_FRAME_LIMITS.bashSettlementReserveMs;
    if (now >= this.admissionDeadlineAt || (name === "bash" && now >= bashWorkDeadlineAt)) {
      return HARBOR_FINALIZATION_OBSERVATION;
    }

    const cutoff = new AbortController();
    const onParentAbort = () => cutoff.abort();
    if (context.signal?.aborted) cutoff.abort();
    else context.signal?.addEventListener("abort", onParentAbort, { once: true });
    const delay = Math.max(0, Math.min(2_147_483_647, this.admissionDeadlineAt - Date.now()));
    const timer = setTimeout(() => cutoff.abort(), delay);
    const boundedContext: NativeToolCallContext = {
      ...context,
      signal: cutoff.signal,
      ...(name === "bash"
        ? { deadlineAt: Math.min(context.deadlineAt ?? bashWorkDeadlineAt, bashWorkDeadlineAt) }
        : {}),
    };
    try {
      const observation = await this.backend.execute(name, args, boundedContext);
      return Date.now() >= this.admissionDeadlineAt
        ? HARBOR_FINALIZATION_OBSERVATION
        : observation;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onParentAbort);
    }
  }
}

export interface HarborHostSessionOptions {
  protocol: HarborHostProtocol;
  hello: HarborHello;
  provider: Provider;
  hostRoot: string;
  maxSteps: number;
  maxContextTokens: number;
  adaptiveEffort: boolean;
  loop: boolean;
  /** Test/embedding overrides may only shorten the production active-session budget. */
  sessionDeadlineAt?: number;
}

export interface HarborHostSessionResult {
  output: string;
  completionStatus: AgentCompletionStatus;
  schemaNames: string[];
  metrics: HarborFinalMetrics;
}

function remoteEnvironmentTail(hello: HarborHello): string {
  const network = hello.posture.networkMode === "allowlist"
    ? `allowlist (${hello.posture.allowedHosts.join(", ")})`
    : hello.posture.networkMode;
  return [
    "# HARBOR REMOTE ENVIRONMENT",
    `Canonical POSIX workspace: ${hello.attestation.canonicalPosixRoot}`,
    `Network policy: ${network}`,
    "The attached native tools are authoritative and execute only in Harbor's task environment.",
    "The host filesystem, host credentials, project context, identity, memory, hooks, MCP, web, computer control, and subagents are unavailable.",
  ].join("\n");
}

export interface HarborCodexDigestGateOptions {
  expectedDigest?: string;
  discover?: () => CodexSupportStatus;
  hashFile?: (path: string) => string;
}

export interface HarborCredentialLeaseGateOptions {
  leaseMode?: string;
  now?: number;
  loadCredentials?: () => ChatGptCredentials | null;
}

/** Reject a stale or refresh-capable credential before constructing the paid provider. */
export function verifyHarborCredentialLease(
  config: Pick<NekoConfig, "provider" | "model">,
  options: HarborCredentialLeaseGateOptions = {},
): void {
  const leaseMode = options.leaseMode ?? process.env.NEKO_HARBOR_ACCESS_LEASE ?? "";
  if (leaseMode !== "1") return;
  if (config.provider !== "chatgpt" || !config.model.startsWith("gpt-5.6-")) {
    throw new HostProtocolError("credential_lease_profile_mismatch");
  }
  const credentials = (options.loadCredentials ?? loadChatGptCredentials)();
  const now = options.now ?? Date.now();
  if (!credentials || !credentials.accessToken || !credentials.accountId
    || credentials.refreshToken !== ""
    || !Number.isSafeInteger(credentials.expiresAt)
    || credentials.expiresAt < now + HARBOR_RUN_DEADLINE_MS + HARBOR_LEASE_MARGIN_MS) {
    throw new HostProtocolError("credential_lease_invalid");
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Hash the exact canonical file returned by Codex discovery and reject replacement during the read. */
function stableFileSha256(path: string): string {
  try {
    const canonical = realpathSync.native(path);
    if (canonical !== path) throw new Error("non-canonical executable");
    const fd = openSync(canonical, "r");
    let before: Stats;
    let after: Stats;
    let digest: string;
    try {
      before = fstatSync(fd);
      if (!before.isFile()) throw new Error("not a regular file");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const bytes = readSync(fd, buffer, 0, buffer.length, null);
        if (!bytes) break;
        hash.update(buffer.subarray(0, bytes));
      }
      after = fstatSync(fd);
      digest = hash.digest("hex");
    } finally {
      closeSync(fd);
    }
    const currentCanonical = realpathSync.native(path);
    const current = statSync(currentCanonical);
    if (currentCanonical !== canonical || !sameFileIdentity(before!, after!) || !sameFileIdentity(after!, current)) {
      throw new Error("executable identity changed");
    }
    return digest!;
  } catch {
    throw new HostProtocolError("codex_identity_unverifiable");
  }
}

/** Bind the GPT-5.6 App Server route to the executable selected by HybridChatGptProvider's resolver. */
export function verifyExpectedCodexForHarbor(
  config: Pick<NekoConfig, "provider" | "model">,
  options: HarborCodexDigestGateOptions = {},
): void {
  // Keep this predicate identical to HybridChatGptProvider: other ChatGPT models use the direct route.
  if (config.provider !== "chatgpt" || !config.model.startsWith("gpt-5.6-")) return;
  const expected = String(options.expectedDigest ?? process.env.NEKO_EXPECTED_CODEX_SHA256 ?? "")
    .trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new HostProtocolError("codex_digest_required");
  const status = (options.discover ?? discoverCodexSupport)();
  if (status.state !== "ready" || !status.executable) {
    throw new HostProtocolError("codex_executable_unavailable");
  }
  const actual = (options.hashFile ?? stableFileSha256)(status.executable.path);
  if (actual.toLowerCase() !== expected) throw new HostProtocolError("codex_digest_mismatch");
}

export async function runHarborHostSession(options: HarborHostSessionOptions): Promise<HarborHostSessionResult> {
  const { hello, protocol, provider } = options;
  const startedAt = performance.now();
  const sessionNow = Date.now();
  const productionDeadlineAt = sessionNow + HARBOR_HOST_SESSION_BUDGET_MS;
  if (options.sessionDeadlineAt !== undefined && (!Number.isSafeInteger(options.sessionDeadlineAt)
    || options.sessionDeadlineAt <= sessionNow || options.sessionDeadlineAt > productionDeadlineAt)) {
    await protocol.failSession("session_failed");
    throw new HostProtocolError("session_failed");
  }
  const sessionDeadlineAt = options.sessionDeadlineAt ?? productionDeadlineAt;
  const toolAdmissionDeadlineAt = sessionDeadlineAt - HARBOR_TOOL_FINALIZATION_RESERVE_MS;
  const controllerDeadlineAt = sessionDeadlineAt - HARBOR_CONTROLLER_FINALIZATION_RESERVE_MS;
  const controllerAbort = new AbortController();
  const onProtocolAbort = () => controllerAbort.abort();
  if (protocol.signal.aborted) controllerAbort.abort();
  else protocol.signal.addEventListener("abort", onProtocolAbort, { once: true });
  const controllerDelay = Math.max(0, Math.min(2_147_483_647, controllerDeadlineAt - Date.now()));
  const controllerTimer = setTimeout(() => controllerAbort.abort(), controllerDelay);
  const toolCalls = { requested: 0, completed: 0, productive: 0, empty: 0, failed: 0 };
  const usageByProviderCall: Array<Usage | undefined> = [];
  let providerCompleteCalls = 0;
  let hitMaxSteps = false;
  const usageTotals = () => {
    const tracker = new CostTracker();
    for (const usage of usageByProviderCall) tracker.add(usage);
    return tracker;
  };
  const partialMetrics = (): HarborPartialMetrics => {
    const totals = usageTotals();
    return validatePartialMetrics({
      providerCompleteCalls,
      providerUsageObservedCalls: usageByProviderCall.filter(Boolean).length,
      providerReportedModelCalls: totals.calls,
      inputTokens: totals.promptTokens,
      outputTokens: totals.completionTokens,
      cachedTokens: totals.cachedTokens,
      totalTokens: totals.totalTokens,
      wallTimeMs: Math.max(0, Math.floor(performance.now() - startedAt)),
      hitMaxSteps,
      toolCalls: { ...toolCalls },
    });
  };
  const recordUsage = (callIndex: number, usage: Usage | undefined): boolean => {
    if (!completeUsageSnapshot(usage)) return false;
    const previous = usageByProviderCall[callIndex];
    const prior = new CostTracker();
    const next = new CostTracker();
    prior.add(previous);
    next.add(usage);
    const priorCounts = [prior.calls, prior.promptTokens, prior.completionTokens, prior.cachedTokens, prior.totalTokens];
    const nextCounts = [next.calls, next.promptTokens, next.completionTokens, next.cachedTokens, next.totalTokens];
    if (nextCounts.some((count, index) => count < priorCounts[index]!)) {
      throw new HostProtocolError("usage_snapshot_regressed");
    }
    if (nextCounts.every((count, index) => count === priorCounts[index])) return false;
    usageByProviderCall[callIndex] = {
      prompt_tokens: next.promptTokens,
      completion_tokens: next.completionTokens,
      total_tokens: next.totalTokens,
      cached_tokens: next.cachedTokens,
      model_calls: next.calls,
    };
    return true;
  };
  const measuredProvider: Provider = {
    async complete(messages, tools, onDelta, signal, opts) {
      // Timers are cooperative. A synchronous provider can delay their callback, so every provider
      // admission also checks the absolute cutoff before a new Agent step or closed-loop review starts.
      if (Date.now() >= controllerDeadlineAt) {
        controllerAbort.abort();
        throw new HostProtocolError("controller_deadline_reached");
      }
      const callIndex = providerCompleteCalls++;
      usageByProviderCall.push(undefined);
      await protocol.checkpoint(partialMetrics());
      const measuredOptions = {
        ...(opts ?? {}),
        onUsage: (usage: Usage) => {
          if (recordUsage(callIndex, usage)) {
            void protocol.checkpoint(partialMetrics()).catch(() => {});
          }
          opts?.onUsage?.(usage);
        },
      };
      const response = await provider.complete(messages, tools, onDelta, signal, measuredOptions);
      if (recordUsage(callIndex, response.usage)) {
        await protocol.checkpoint(partialMetrics());
      }
      return response;
    },
  };
  const toolMeter = new HarborToolCallMeter(async () => {
    toolCalls.requested++;
    await protocol.checkpoint(partialMetrics());
  });
  let registry: ToolRegistry | undefined;
  let agent: Agent | undefined;
  let lease: ReturnType<ToolRegistry["enterTurn"]> | undefined;
  let output = "";
  let failure: unknown;
  try {
    const reservedBackend = new FinalizationReservedHarborNativeBackend(
      protocol.nativeBackend(),
      toolAdmissionDeadlineAt,
    );
    const backend = new MeteredHarborNativeBackend(reservedBackend, toolMeter);
    registry = new ToolRegistry(options.hostRoot, "auto", () => true, undefined, backend);
    registry.allowOnlyTools(HARBOR_NATIVE_TOOLS);
    registry.readOutsideRoot = false;
    registry.hooks = undefined;
    registry.mcp = undefined;
    registry.web = undefined;
    registry.subagent = undefined;
    registry.summarize = undefined;
    registry.checkAction = undefined;
    registry.loadSkill = undefined;
    registry.allowBackgroundBash = false;
    registry.allowDangerousBash = false;
    registry.sandboxBash = true;
    registry.sandboxAutoApprove = true;
    registry.sandboxAllowNetwork = hello.posture.networkMode !== "no-network";
    registry.sandboxDomains = hello.posture.networkMode === "allowlist" ? [...hello.posture.allowedHosts] : [];
    registry.sandboxDenyReadFiles = [];

    lease = registry.enterTurn({
      name: "harbor-remote-eval",
      allowedTools: HARBOR_NATIVE_TOOLS,
      allowBackgroundBash: false,
      reason: "Harbor evaluation exposes only the remote native workspace.",
    });
    agent = new Agent({
      provider: measuredProvider,
      tools: registry,
      maxSteps: options.maxSteps,
      maxContextTokens: options.maxContextTokens,
      adaptiveEffort: options.adaptiveEffort,
      verifyBeforeExit: true,
      verifyStateChangesBeforeExit: true,
      systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\n${remoteEnvironmentTail(hello)}`,
      onEvent: (kind, data) => {
        if (kind === "tool_call") {
          toolMeter.onAgentCall(data);
          return;
        }
        if (kind === "max_steps") {
          hitMaxSteps = true;
          void protocol.checkpoint(partialMetrics()).catch(() => {});
          return;
        }
        if (kind !== "tool_result") return;
        toolMeter.onAgentResult(data.call);
        const result = classifyToolObservation(data?.observation);
        toolCalls.completed++;
        toolCalls[result]++;
        void protocol.checkpoint(partialMetrics()).catch(() => {});
      },
    });
    output = options.loop
      ? await agent.runUntilDone(hello.instruction, { signal: controllerAbort.signal })
      : await agent.run(hello.instruction, controllerAbort.signal);
    if (protocol.failed) throw new HostProtocolError(protocol.failureCode ?? "transport_failed");
  } catch (error) {
    failure = error;
  } finally {
    lease?.close();
    try {
      await provider.dispose?.();
    } catch (error) {
      failure ??= error;
    }
    clearTimeout(controllerTimer);
    protocol.signal.removeEventListener("abort", onProtocolAbort);
  }
  if (failure) {
    await protocol.failSession("session_failed");
    throw new HostProtocolError("session_failed");
  }
  if (!registry || !agent) {
    await protocol.failSession("session_failed");
    throw new HostProtocolError("session_failed");
  }
  const completionStatus = agent.completionStatus;
  const usageComplete = providerCompleteCalls > 0
    && usageByProviderCall.length === providerCompleteCalls
    && usageByProviderCall.every((usage) => completeUsageSnapshot(usage));
  const reportedCost = usageTotals();
  const reported = usageComplete
    ? {
        providerReportedModelCalls: reportedCost.calls,
        inputTokens: reportedCost.promptTokens,
        outputTokens: reportedCost.completionTokens,
        cachedTokens: reportedCost.cachedTokens,
        totalTokens: reportedCost.totalTokens,
      }
    : {
        providerReportedModelCalls: null,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        totalTokens: null,
      };
  const terminalCheckpoint = partialMetrics();
  const metrics = validateFinalMetrics({
    completionStatus: sanitizeCompletionStatus(completionStatus),
    usageComplete,
    providerCompleteCalls,
    ...reported,
    wallTimeMs: terminalCheckpoint.wallTimeMs,
    hitMaxSteps,
    toolCalls: { ...toolCalls },
  });
  const result = {
    output,
    completionStatus,
    schemaNames: registry.schemas().map((schema) => String(schema.function.name)),
    metrics,
  };
  await protocol.checkpoint(terminalCheckpoint);
  await protocol.finish(metrics);
  return result;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new HostProtocolError("invalid_host_setting");
}

function envAbsoluteDeadline(name: string): number {
  const raw = String(process.env[name] ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(raw)) throw new HostProtocolError("invalid_host_setting");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new HostProtocolError("invalid_host_setting");
  return value;
}

function stdioIo(): HarborProtocolIo {
  return {
    input: process.stdin,
    write: (chunk, signal) => new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => {
        try { process.stdout.destroy(); } catch { /* stdout may already be closed */ }
        settle(new Error("stdout write aborted"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        process.stdout.write(Buffer.from(chunk), (error) => settle(error));
      } catch (error) {
        settle(error instanceof Error ? error : new Error("stdout write failed"));
      }
    }),
    closeInput: () => { try { process.stdin.destroy(); } catch { /* already closed */ } },
    diagnostic: (code) => {
      const line = code === "session_failure"
        ? "neko-harbor-host: session failed\n"
        : "neko-harbor-host: protocol failed\n";
      process.stderr.write(line);
    },
  };
}

export async function runHarborHostMain(io: HarborProtocolIo = stdioIo()): Promise<number> {
  const protocol = new HarborHostProtocol(io);
  let hostRoot = "";
  let codexHome = "";
  const previousCodexHome = process.env.NEKO_CODEX_HOME;
  try {
    const hello = await protocol.waitForHello();
    hostRoot = mkdtempSync(join(tmpdir(), "neko-harbor-host-"));
    codexHome = mkdtempSync(join(tmpdir(), "neko-harbor-codex-"));
    process.env.NEKO_CODEX_HOME = codexHome;
    const cfg = loadConfig({ cwd: hostRoot });
    verifyHarborCredentialLease(cfg);
    verifyExpectedCodexForHarbor(cfg);
    const sessionDeadlineAt = envAbsoluteDeadline("NEKO_HARBOR_SESSION_DEADLINE_AT_MS");
    const sessionOptions = {
      maxSteps: cfg.maxSteps,
      maxContextTokens: cfg.contextWindow,
      adaptiveEffort: cfg.adaptiveEffort,
      loop: envBoolean("NEKO_HARBOR_LOOP", true),
      sessionDeadlineAt,
    };
    const provider = getProvider(cfg);
    await runHarborHostSession({
      protocol,
      hello,
      provider,
      hostRoot,
      ...sessionOptions,
    });
    return 0;
  } catch {
    if (!protocol.failed && !protocol.finished) await protocol.failSession("session_failed");
    return 1;
  } finally {
    let cleanupFailed = false;
    if (previousCodexHome === undefined) delete process.env.NEKO_CODEX_HOME;
    else process.env.NEKO_CODEX_HOME = previousCodexHome;
    if (codexHome) {
      try { rmSync(codexHome, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    }
    if (hostRoot) {
      try { rmSync(hostRoot, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    }
    await protocol.quiesce();
    if (cleanupFailed) throw new HostProtocolError("host_cleanup_failed");
  }
}

if (import.meta.main) {
  runHarborHostMain().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write("neko-harbor-host: session failed\n");
    process.exitCode = 1;
  });
}
