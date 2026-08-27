/** Wiii-owned semantic Computer capability for ACP sessions. */
import * as acp from "@agentclientprotocol/sdk";
import { createHash, randomUUID } from "node:crypto";

import type { ComputerToolPort } from "../core/ports.ts";
import type { JsonObject, JsonValue } from "../shared/wire.ts";
import { isBool, isJsonArray, isJsonNumber, isJsonObject, isText } from "../shared/wire.ts";

export const WIII_COMPUTER_CAPABILITY = "dev.wiii.computer.v1";
export const WIII_COMPUTER_PROTOCOL = "neko-computer.semantic.v1";

export const WIII_COMPUTER_METHODS = {
  status: "_wiii/computer/v1/status",
  observe: "_wiii/computer/v1/observe",
  acquire: "_wiii/computer/v1/lease/acquire",
  act: "_wiii/computer/v1/act",
  release: "_wiii/computer/v1/lease/release",
} as const;

type WiiiComputerMethod = typeof WIII_COMPUTER_METHODS[keyof typeof WIII_COMPUTER_METHODS];
type SemanticAction = "focus" | "invoke" | "set_text";
type SeatState = "available" | "agent_controlled" | "user_controlled";

const REQUIRED_METHODS = Object.freeze(Object.values(WIII_COMPUTER_METHODS));
const SAFE_ACTIONS = new Set(["status", "observe", "release"]);
const SEMANTIC_ACTIONS = new Set<SemanticAction>(["focus", "invoke", "set_text"]);
const HUMAN_CHECK = /\b(?:captcha|hcaptcha|recaptcha|turnstile|human verification|verify (?:you are|that you are) human|not a robot)\b/i;
const PROTECTED_TARGET = /\b(?:password|passcode|one[- ]time|otp|verification code|secret|credential|api key|access token|refresh token|cookie)\b/i;
const DISPLAY_SECRET = /(?:\b(?:token|key|secret|password|cookie|code)=|\bbearer\s+[a-z0-9._~-]+|\beyJ[a-z0-9_-]{20,}\.)/i;

export interface WiiiComputerCapability {
  semanticProtocol: typeof WIII_COMPUTER_PROTOCOL;
  methods: ReadonlySet<WiiiComputerMethod>;
}

interface ComputerClient {
  request<Response = any, Params = any>(
    method: string,
    params?: Params,
    options?: acp.SendRequestOptions,
  ): Promise<Response>;
}

interface SafeStatus {
  available: boolean;
  code: string;
  state: "preparing" | "ready" | "suspended" | "error" | "unknown_outcome" | null;
  seatState: SeatState | null;
  agentHasControl: boolean;
}

interface SafeNode {
  ref: string;
  parentRef: string | null;
  role: string;
  name: string;
  states: string[];
  actions: SemanticAction[];
  bounds: { x: number; y: number; width: number; height: number } | null;
}

interface SafeSnapshot {
  protocolVersion: typeof WIII_COMPUTER_PROTOCOL;
  stateVersion: string;
  platform: "linux_atspi";
  screen: { width: number; height: number };
  activeWindowRef: string | null;
  nodes: SafeNode[];
  truncated: boolean;
}

interface BlockedExtra {
  snapshot?: SafeSnapshot;
  next?: string;
}

function record(value: any): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function boundedText(value: any, max: number): string | null {
  if (!isText(value) || !value || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return null;
  return value;
}

function safeDisplayText(value: any, max: number): string {
  const text = boundedText(value, max) ?? "";
  return DISPLAY_SECRET.test(text) ? "[redacted]" : text;
}

function boundedOpaque(value: any, max: number): string | null {
  const text = boundedText(value, max);
  return text && !DISPLAY_SECRET.test(text) ? text : null;
}

function numberInRange(value: any, min: number, max: number): number | null {
  return isJsonNumber(value) && value >= min && value <= max ? value : null;
}

function safeStatusCode(value: any): string {
  const code = boundedText(value, 100) ?? "host_unavailable";
  return new Set([
    "ready",
    "computer_not_installed",
    "project_not_active",
    "computer_preparing",
    "computer_suspended",
    "computer_error",
    "computer_unknown_outcome",
  ]).has(code) ? code : "host_unavailable";
}

function json(value: any): string {
  return JSON.stringify(value);
}

function blocked(code: string, extra: BlockedExtra = {}): string {
  return json({ outcome: "blocked", code, ...extra });
}

function isSemanticAction(value: any): value is SemanticAction {
  return value === "focus" || value === "invoke" || value === "set_text";
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("release_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Strict negotiation: a partial or renamed capability grants nothing. */
export function parseWiiiComputerCapability(clientCapabilities?: acp.ClientCapabilities): WiiiComputerCapability | null {
  const meta = record(clientCapabilities?._meta);
  const offered = record(meta?.[WIII_COMPUTER_CAPABILITY]);
  if (offered?.semanticProtocol !== WIII_COMPUTER_PROTOCOL || !isJsonArray(offered.methods)) return null;
  const advertised = new Set(offered.methods.filter(isText));
  if (!REQUIRED_METHODS.every((method) => advertised.has(method))) return null;
  return { semanticProtocol: WIII_COMPUTER_PROTOCOL, methods: new Set(REQUIRED_METHODS) };
}

function parseStatus(value: JsonValue): SafeStatus {
  const outer = record(value);
  if (!outer || outer.protocolVersion !== "wiii-computer.agent.v1" || !isBool(outer.available)
    || !isBool(outer.agentHasControl)) {
    throw new Error("invalid_host_response");
  }
  const computer = outer.computer === null ? null : record(outer.computer);
  if (outer.available && !computer) throw new Error("invalid_host_response");
  const state = computer?.state;
  const seatState = computer?.seatState;
  const safeState = state === "preparing" || state === "ready" || state === "suspended"
    || state === "error" || state === "unknown_outcome" ? state : null;
  const safeSeat = seatState === "available" || seatState === "agent_controlled" || seatState === "user_controlled"
    ? seatState : null;
  if (computer && (computer.semanticProtocol !== WIII_COMPUTER_PROTOCOL || !safeState || !safeSeat)) {
    throw new Error("invalid_host_response");
  }
  return {
    available: outer.available && safeState === "ready",
    code: safeStatusCode(outer.code),
    state: safeState,
    seatState: safeSeat,
    agentHasControl: outer.agentHasControl,
  };
}

function parseBounds(value: JsonValue): SafeNode["bounds"] {
  if (value === null) return null;
  const bounds = record(value);
  if (!bounds) throw new Error("invalid_host_response");
  const x = numberInRange(bounds.x, -1_000_000, 1_000_000);
  const y = numberInRange(bounds.y, -1_000_000, 1_000_000);
  const width = numberInRange(bounds.width, 0, 1_000_000);
  const height = numberInRange(bounds.height, 0, 1_000_000);
  if (x === null || y === null || width === null || height === null) throw new Error("invalid_host_response");
  return { x, y, width, height };
}

function parseSnapshot(value: JsonValue): SafeSnapshot {
  const snapshot = record(value);
  const screen = record(snapshot?.screen);
  if (!snapshot || snapshot.protocolVersion !== WIII_COMPUTER_PROTOCOL || snapshot.platform !== "linux_atspi"
    || !isJsonArray(snapshot.nodes) || !isBool(snapshot.truncated) || !screen) {
    throw new Error("invalid_host_response");
  }
  const stateVersion = boundedOpaque(snapshot.stateVersion, 500);
  const width = numberInRange(screen.width, 1, 1_000_000);
  const height = numberInRange(screen.height, 1, 1_000_000);
  const activeWindowRef = snapshot.activeWindowRef === null ? null : boundedOpaque(snapshot.activeWindowRef, 500);
  if (!stateVersion || width === null || height === null || activeWindowRef === null && snapshot.activeWindowRef !== null) {
    throw new Error("invalid_host_response");
  }
  const nodes = snapshot.nodes.slice(0, 400).map((raw): SafeNode => {
    const node = record(raw);
    const ref = boundedOpaque(node?.ref, 500);
    const parentRef = node?.parentRef === null ? null : boundedOpaque(node?.parentRef, 500);
    const role = safeDisplayText(node?.role, 200);
    const states = isJsonArray(node?.states)
      ? node.states.map((item) => safeDisplayText(item, 100)).filter((item) => item.length > 0).slice(0, 32)
      : null;
    const actions = isJsonArray(node?.actions)
      ? node.actions.filter(isSemanticAction).slice(0, 3)
      : null;
    if (!node || !ref || (node.parentRef !== null && !parentRef) || !role || !states || !actions) {
      throw new Error("invalid_host_response");
    }
    const rawName = safeDisplayText(node.name, 2_000);
    const protectedNode = states.some((state) => /protected|password|secret/i.test(state))
      || PROTECTED_TARGET.test(`${role} ${rawName}`);
    const name = protectedNode ? "[protected]" : rawName;
    return { ref, parentRef, role, name, states, actions, bounds: parseBounds(node.bounds) };
  });
  return {
    protocolVersion: WIII_COMPUTER_PROTOCOL,
    stateVersion,
    platform: "linux_atspi",
    screen: { width, height },
    activeWindowRef,
    nodes,
    truncated: snapshot.truncated || snapshot.nodes.length > 400,
  };
}

function errorCode(error: any): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/aborted|cancel/.test(message)) return "interrupted";
  if (/project_not_active|project.*(?:revok|switch|active)/.test(message)) return "project_not_active";
  if (/captcha|human verification|not a robot/.test(message)) return "human_verification";
  if (/user_controlled|human takeover/.test(message)) return "human_takeover";
  if (/stale|mismatch|state.?version|expected.?role|expected.?name|target.*(?:changed|missing|not found)|element.*(?:changed|missing|not found)/.test(message)) return "stale_snapshot";
  if (/lease|required|seat|agent.?control/.test(message)) return "lease_lost";
  if (/invalid_host_response/.test(message)) return "invalid_host_response";
  return "host_unavailable";
}

/** One ACP-session-scoped tool. Wiii retains every native identifier and provisioning secret. */
export class WiiiComputerTool implements ComputerToolPort {
  private readonly operationPrefix: string;
  private readonly cleanupOperationId: string;
  private operationSequence = 0;
  private snapshot: SafeSnapshot | null = null;
  private leaseHeld = false;
  private releasePending = false;
  private releaseOperationId = "";
  private pendingAcquireOperationId = "";
  private unknownAct: { fingerprint: string; operationId: string } | null = null;
  private closed = false;

  constructor(
    private readonly client: ComputerClient,
    private readonly capability: WiiiComputerCapability,
    sessionId: string,
  ) {
    const sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
    this.operationPrefix = `neko-${sessionKey}-${randomUUID()}`;
    this.cleanupOperationId = `${this.operationPrefix}-cleanup`;
  }

  schema(): any {
    return {
      type: "function",
      function: {
        name: "computer",
        description: "Use the Wiii-owned semantic Computer. Follow status -> observe -> acquire -> focus/invoke/set_text -> release. Act only on a ref from the latest observation with the exact role and name. Never guess coordinates, handle CAPTCHA, or enter secrets; stop for human takeover.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["status", "observe", "acquire", "focus", "invoke", "set_text", "release"],
            },
            max_nodes: { type: "integer", minimum: 1, maximum: 400, description: "Observation cap (default 400)." },
            target_ref: { type: "string", description: "Exact semantic ref from the latest observe result." },
            expected_role: { type: "string", description: "Exact role from that same observed node." },
            expected_name: { type: "string", description: "Exact name from that same observed node." },
            text: { type: "string", description: "Non-secret text for set_text only. Hand protected fields to the user." },
          },
          required: ["action"],
        },
      },
    };
  }

  permission(args: any): "safe" | "gated" {
    return SAFE_ACTIONS.has(String(args?.action ?? "")) ? "safe" : "gated";
  }

  async call(args: any, signal?: AbortSignal): Promise<string> {
    if (this.closed) return blocked("computer_session_closed");
    if (!isJsonObject(args)) return blocked("invalid_arguments");
    const action = args.action;
    try {
      if (action === "status") return await this.status(signal);
      if (action === "observe") return await this.observe(args, signal);
      if (action === "acquire") return await this.acquire(signal);
      if (isSemanticAction(action)) return await this.act(action, args, signal);
      if (action === "release") return await this.releaseTool(signal);
      return blocked("invalid_action");
    } catch (error) {
      return errorCode(error) === "interrupted" ? "(interrupted)" : blocked(errorCode(error));
    }
  }

  async release(): Promise<void> {
    await this.releaseControl(undefined, true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.releaseControl(undefined, true);
    this.closed = true;
  }

  private operationId(kind: string): string {
    this.operationSequence++;
    return `${this.operationPrefix}-${this.operationSequence}-${kind}`;
  }

  private request(method: WiiiComputerMethod, params: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
    if (!this.capability.methods.has(method)) throw new Error("unsupported_host_method");
    return this.client.request<JsonValue, JsonValue>(method, params, { cancellationSignal: signal });
  }

  private async readStatus(signal?: AbortSignal): Promise<SafeStatus> {
    const current = parseStatus(await this.request(WIII_COMPUTER_METHODS.status, {}, signal));
    if (current.agentHasControl) {
      this.leaseHeld = true;
      this.releasePending = true;
      this.pendingAcquireOperationId = "";
    } else if (this.leaseHeld) {
      this.leaseHeld = false;
      this.snapshot = null;
    }
    if (!current.available || current.seatState === "user_controlled") {
      this.leaseHeld = false;
      this.snapshot = null;
    }
    return current;
  }

  private statusBlock(current: SafeStatus, controlRequired = false): string | null {
    if (!current.available) return current.code;
    if (current.seatState === "user_controlled") return "human_takeover";
    if (current.seatState === "agent_controlled" && !current.agentHasControl) return "seat_unavailable";
    if (controlRequired && !current.agentHasControl) return "lease_lost";
    return null;
  }

  private async status(signal?: AbortSignal): Promise<string> {
    const current = await this.readStatus(signal);
    const code = this.statusBlock(current);
    if (code && this.releasePending) await this.releaseControl(undefined, true);
    return json({
      outcome: code ? "blocked" : "ready",
      code: code ?? "ready",
      state: current.state,
      seat_state: current.seatState,
      agent_has_control: current.agentHasControl,
    });
  }

  private async observe(args: JsonObject, signal?: AbortSignal): Promise<string> {
    const current = await this.readStatus(signal);
    const code = this.statusBlock(current);
    if (code) {
      if (this.releasePending) await this.releaseControl(undefined, true);
      return blocked(code);
    }
    const maxNodes = args.max_nodes === undefined ? 400 : Number(args.max_nodes);
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 400) return blocked("invalid_arguments");
    const snapshot = parseSnapshot(await this.request(WIII_COMPUTER_METHODS.observe, { maxNodes }, signal));
    const challenge = snapshot.nodes.some((node) => HUMAN_CHECK.test(`${node.role} ${node.name}`));
    if (challenge) {
      this.snapshot = null;
      await this.releaseControl(undefined, true);
      return blocked("human_verification", { snapshot, next: "hand_over_to_human" });
    }
    this.snapshot = snapshot;
    return json({ outcome: "observed", snapshot });
  }

  private async acquire(signal?: AbortSignal): Promise<string> {
    if (!this.snapshot) return blocked("observe_required");
    const current = await this.readStatus(signal);
    const code = this.statusBlock(current);
    if (code) return blocked(code);
    if (current.agentHasControl) return json({ outcome: "acquired", recovered: true });
    const operationId = this.pendingAcquireOperationId || this.operationId("acquire");
    this.pendingAcquireOperationId = operationId;
    try {
      const result = record(await this.request(WIII_COMPUTER_METHODS.acquire, { operationId }, signal));
      if (result?.acquired !== true || result.seatState !== "agent_controlled") throw new Error("invalid_host_response");
      this.pendingAcquireOperationId = "";
      this.leaseHeld = true;
      this.releasePending = true;
      return json({ outcome: "acquired" });
    } catch (error) {
      const code = errorCode(error);
      if (code === "interrupted") return "(interrupted)";
      if (code === "human_takeover" || code === "human_verification" || code === "lease_lost" || code === "project_not_active") {
        this.pendingAcquireOperationId = "";
        return blocked(code);
      }
      return blocked("acquire_outcome_unknown");
    }
  }

  private target(args: JsonObject): { ref: string; role: string; name: string } | null {
    const ref = boundedText(args.target_ref, 500);
    const role = boundedText(args.expected_role, 200);
    const name = boundedText(args.expected_name, 2_000);
    return ref && role && name ? { ref, role, name } : null;
  }

  private async refreshAfterStale(signal?: AbortSignal): Promise<string> {
    try {
      const current = await this.readStatus(signal);
      const code = this.statusBlock(current, true);
      if (code) return blocked(code);
      const snapshot = parseSnapshot(await this.request(WIII_COMPUTER_METHODS.observe, { maxNodes: 400 }, signal));
      if (snapshot.nodes.some((node) => HUMAN_CHECK.test(`${node.role} ${node.name}`))) {
        this.snapshot = null;
        await this.releaseControl(undefined, true);
        return blocked("human_verification", { snapshot, next: "hand_over_to_human" });
      }
      this.snapshot = snapshot;
      return blocked("stale_snapshot", { next: "re_evaluate_target", snapshot });
    } catch (error) {
      this.snapshot = null;
      return errorCode(error) === "interrupted" ? "(interrupted)" : blocked(errorCode(error));
    }
  }

  private async act(action: SemanticAction, args: JsonObject, signal?: AbortSignal): Promise<string> {
    if (!this.leaseHeld || !this.snapshot) return blocked(this.leaseHeld ? "observe_required" : "computer_lease_required");
    const target = this.target(args);
    if (!target) return blocked("invalid_arguments");
    const current = await this.readStatus(signal);
    const statusCode = this.statusBlock(current, true);
    if (statusCode) {
      if (this.releasePending) await this.releaseControl(undefined, true);
      return blocked(statusCode);
    }
    const snapshot = this.snapshot;
    const node = snapshot.nodes.find((item) => item.ref === target.ref);
    if (!node || node.role !== target.role || node.name !== target.name || !node.actions.includes(action)) {
      return this.refreshAfterStale(signal);
    }
    if (node.name === "[protected]" || PROTECTED_TARGET.test(`${node.role} ${node.name} ${node.states.join(" ")}`)) {
      await this.releaseControl(undefined, true);
      return blocked("protected_input", { next: "hand_over_to_human" });
    }
    const wire: JsonObject = {
      stateVersion: snapshot.stateVersion,
      targetRef: target.ref,
      expectedRole: target.role,
      expectedName: target.name,
      action,
    };
    if (action === "set_text") {
      const text = args.text;
      if (!isText(text) || text.length > 100_000) return blocked("invalid_arguments");
      wire.text = text;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(wire)).digest("hex");
    const operationId = this.unknownAct?.fingerprint === fingerprint
      ? this.unknownAct.operationId
      : this.operationId(action);
    try {
      const result = record(await this.request(WIII_COMPUTER_METHODS.act, { operationId, ...wire }, signal));
      const afterStateVersion = boundedOpaque(result?.afterStateVersion, 500);
      if (!result || result.action !== action || result.targetRef !== target.ref
        || result.beforeStateVersion !== snapshot.stateVersion || !afterStateVersion
        || (result.outcome !== "completed" && result.outcome !== "rejected")) {
        throw new Error("invalid_host_response");
      }
      this.unknownAct = null;
      if (result.outcome === "rejected" || result.verified !== true) {
        const code = errorCode(new Error(String(result.code ?? "rejected")));
        if (code === "stale_snapshot") return this.refreshAfterStale(signal);
        this.snapshot = null;
        return blocked(code === "host_unavailable" ? "action_rejected" : code);
      }
      this.snapshot = null;
      return json({
        outcome: "completed",
        action,
        target_ref: target.ref,
        verified: true,
        before_state_version: snapshot.stateVersion,
        after_state_version: afterStateVersion,
      });
    } catch (error) {
      const code = errorCode(error);
      if (code === "stale_snapshot") {
        this.unknownAct = null;
        return this.refreshAfterStale(signal);
      }
      if (code === "human_takeover" || code === "human_verification" || code === "lease_lost" || code === "project_not_active") {
        this.unknownAct = null;
        this.snapshot = null;
        this.leaseHeld = false;
        await this.releaseControl(undefined, true);
        return blocked(code);
      }
      if (code === "interrupted") return "(interrupted)";
      this.unknownAct = { fingerprint, operationId };
      this.snapshot = null;
      return blocked("action_outcome_unknown", { next: "observe_before_deciding_whether_to_retry" });
    }
  }

  private async releaseTool(signal?: AbortSignal): Promise<string> {
    const released = await this.releaseControl(signal, false);
    return released ? json({ outcome: "released" }) : blocked("release_unconfirmed");
  }

  private async releaseControl(signal?: AbortSignal, bestEffort = false): Promise<boolean> {
    this.leaseHeld = false;
    this.snapshot = null;
    this.pendingAcquireOperationId = "";
    this.unknownAct = null;
    if (!this.releasePending) return true;
    const operationId = this.releaseOperationId || (bestEffort ? this.cleanupOperationId : this.operationId("release"));
    this.releaseOperationId = operationId;
    try {
      const request = this.request(WIII_COMPUTER_METHODS.release, { operationId }, signal);
      const result = record(await (bestEffort ? within(request, 1_500) : request));
      if (result?.released !== true) throw new Error("invalid_host_response");
      this.releasePending = false;
      this.releaseOperationId = "";
      return true;
    } catch {
      return false;
    }
  }
}
