/** ACP v1 adapter: exposes the production Neko Agent over newline-delimited JSON-RPC stdio. */
import * as acp from "@agentclientprotocol/sdk";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import { classifyToolObservation } from "../core/agent.ts";
import type { ToolCall } from "../core/ports.ts";
import type { PermissionMode } from "../core/permissions.ts";
import { describeToolCall } from "../core/tools.ts";
import { VERSION } from "../shared/version.ts";
import { buildAgentRuntime, type AgentRuntime } from "./agent-runtime.ts";
import { loadConfig, type NekoConfig } from "./config.ts";
import { getProvider } from "./providers.ts";
import {
  acquireSessionLease,
  AsyncSessionWriter,
  listSessionMetas,
  loadSession,
  newSessionId,
  recoverSessionTodos,
  sessionTitle,
  type Session,
  type SessionLease,
  type SessionTurnState,
} from "./session.ts";
import { applySkillPolicyForTurn } from "./skills.ts";
import { planTurnCapabilities } from "./turn-capabilities.ts";
import { matchedTurnContext } from "./turn-context.ts";

const MODES: acp.SessionMode[] = [
  { id: "default", name: "Default", description: "Prompt before gated writes and commands." },
  { id: "accept-edits", name: "Accept edits", description: "Approve Neko file edits; other gated actions still prompt." },
  { id: "plan", name: "Plan", description: "Read-only; all gated actions are denied." },
  { id: "auto", name: "Auto", description: "Approve bounded Neko coding tools; seatbelts and host-computer consent remain active." },
];
const MODE_IDS = new Set(MODES.map((mode) => mode.id));
const ALLOW_ONCE = "allow_once";
const ALLOW_ALWAYS = "allow_always";
const REJECT_ONCE = "reject_once";
const REJECT_ALWAYS = "reject_always";
const CHATGPT_TERMINAL_AUTH = "neko-chatgpt-login";

interface AcpSession {
  sessionId: string;
  root: string;
  record: Session;
  lease: SessionLease;
  runtime: AgentRuntime;
  pending?: AbortController;
  pendingSettled?: Promise<void>;
  settlePending?: () => void;
  permissionClient?: acp.AgentContext;
  toolCalls: Map<string, acp.ToolCallUpdate>;
  alwaysAllow: Set<string>;
  alwaysReject: Set<string>;
  maxStepsHit: boolean;
  streamedContentSinceTool: string;
  liveAgentMessageId: string;
  activeToolCallIds: Set<string>;
  writer: AsyncSessionWriter;
  persistenceFailure?: unknown;
  persistenceFailed: boolean;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface AcpRuntimeFactoryOptions {
  config?: NekoConfig;
  configForRoot?: (root: string, profile?: string | null) => NekoConfig;
  buildRuntime?: typeof buildAgentRuntime;
  /** Internal lifecycle seam: production stdio awaits every connection-owned cleanup task. */
  trackCleanup?: (task: Promise<void>) => void;
}

function modeState(mode: PermissionMode): acp.SessionModeState {
  return { currentModeId: mode, availableModes: MODES };
}

function toolKind(name: string): acp.ToolKind {
  if (["read_file", "ls", "glob"].includes(name)) return "read";
  if (["search"].includes(name)) return "search";
  if (["write_file", "edit", "multi_edit"].includes(name)) return "edit";
  if (name === "bash") return "execute";
  if (name.startsWith("web_")) return "fetch";
  return "other";
}

function toolLocations(root: string, args: Record<string, any>): acp.ToolCallLocation[] | undefined {
  const raw = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
  if (!raw) return undefined;
  return [{ path: isAbsolute(raw) ? resolve(raw) : resolve(root, raw) }];
}

function toolUpdate(root: string, call: ToolCall, status: acp.ToolCallStatus = "pending"): acp.ToolCallUpdate {
  return {
    toolCallId: call.id,
    title: describeToolCall(call.name, call.arguments),
    name: call.name,
    kind: toolKind(call.name),
    status,
    locations: toolLocations(root, call.arguments),
    rawInput: call.arguments,
  };
}

function observationText(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function promptText(blocks: acp.ContentBlock[]): { text: string; images: string[] } {
  const text: string[] = [];
  const images: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "resource_link") text.push(`[Attached resource: ${block.uri}${block.name ? ` (${block.name})` : ""}]`);
    else if (block.type === "resource" && "text" in block.resource) {
      text.push(`[Embedded resource: ${block.resource.uri}]\n${block.resource.text}`);
    } else if (block.type === "image") {
      images.push(`data:${block.mimeType};base64,${block.data}`);
      text.push(`[Image #${images.length}]`);
    }
  }
  return { text: text.join("\n\n").trim(), images };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", abort));
  });
}

function sessionRoot(cwd: string): string {
  if (!isAbsolute(cwd)) throw new acp.RequestError(-32602, "ACP session cwd must be an absolute path.");
  const root = resolve(cwd);
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    return realpathSync.native(root);
  } catch {
    throw new acp.RequestError(-32602, "ACP session cwd must be an existing directory.");
  }
}

function sameRoot(a: string, b: string): boolean {
  const left = process.platform === "win32" ? a.toLowerCase() : a;
  const right = process.platform === "win32" ? b.toLowerCase() : b;
  return left === right;
}

function comparableRoot(path: string): string {
  try { return realpathSync.native(resolve(path)); }
  catch { return resolve(path); }
}

const ACP_COMMANDS: acp.AvailableCommand[] = [
  { name: "help", description: "Show ACP commands implemented by Neko Core." },
  { name: "cost", description: "Show cumulative provider token usage for this session." },
  { name: "sessions", description: "List durable Neko sessions for this workspace." },
  { name: "tools", description: "List tools available in this ACP session." },
];

function configOptions(cfg: NekoConfig): acp.SessionConfigOption[] {
  const profiles = Object.entries(cfg.profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, profile]) => ({ value, name: profile.label || value, description: profile.provider || "profile" }));
  const providers = [...new Set([cfg.provider, ...Object.values(cfg.profiles).map((profile) => profile.provider).filter(Boolean)])]
    .sort().map((value) => ({ value: String(value), name: String(value) }));
  const activeProfile = cfg.profile ? cfg.profiles[cfg.profile] : undefined;
  const models = [...new Set([cfg.model, ...(activeProfile?.models ?? [])].filter(Boolean))]
    .map((value) => ({ value, name: value }));
  const efforts = [...new Set(["default", "none", "low", "medium", "high", "xhigh", "max", cfg.effort || "default"])]
    .map((value) => ({ value, name: value }));
  return [
    { type: "select", id: "provider", name: "Provider", category: "model_config", currentValue: cfg.provider, options: providers },
    { type: "select", id: "profile", name: "Provider profile", category: "model_config", currentValue: cfg.profile ?? "__custom__", options: [
      ...(cfg.profile ? [] : [{ value: "__custom__", name: "Custom config" }]), ...profiles,
    ] },
    { type: "select", id: "model", name: "Model", category: "model", currentValue: cfg.model, options: models },
    { type: "select", id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", currentValue: cfg.effort || "default", options: efforts },
  ];
}

function stableMessageId(sessionId: string, index: number, role: string): string {
  return `msg_${createHash("sha256").update(`${sessionId}\0${index}\0${role}`).digest("hex").slice(0, 24)}`;
}

function messageId(sessionId: string, message: any, index: number): string {
  return typeof message?._neko_acp_message_id === "string" && message._neko_acp_message_id
    ? message._neko_acp_message_id
    : stableMessageId(sessionId, index, String(message?.role ?? "message"));
}

function normalizeCoreToolCall(value: any): ToolCall | null {
  const name = typeof value?.name === "string" ? value.name : value?.function?.name;
  if (typeof name !== "string" || !name) return null;
  let args = value.arguments ?? value?.function?.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
  return { id: String(value.id ?? name), name, arguments: args };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : observationText(content);
  return content.map((part: any) => {
    if (part?.type === "text") return String(part.text ?? "");
    if (part?.type === "image_url") return "[Image]";
    return "";
  }).filter(Boolean).join("\n");
}

function encodeCursor(offset: number): string {
  return Buffer.from(`neko-acp-v1:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^neko-acp-v1:(\d+)$/.exec(decoded);
    const offset = match ? Number(match[1]) : -1;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid");
    return offset;
  } catch {
    throw new acp.RequestError(-32602, "Invalid ACP session cursor.");
  }
}

function supportsTerminalAuth(capabilities?: acp.ClientCapabilities): boolean {
  return capabilities?.auth?.terminal === true
    || (capabilities?.terminal === true && capabilities._meta?.["terminal-auth"] === true);
}

/** Create a testable ACP AgentApp. Production callers use {@link runAcpServer}. */
export function createNekoAcpAgent(options: AcpRuntimeFactoryOptions = {}): acp.AgentApp {
  const sessions = new Map<string, AcpSession>();
  const buildRuntime = options.buildRuntime ?? buildAgentRuntime;
  const baseConfig = options.config;

  const app = acp.agent({ name: "neko-core" });

  app.onRequest("initialize", ({ params }) => {
    const authMethods: acp.AuthMethod[] = supportsTerminalAuth(params.clientCapabilities)
      ? [{
      id: CHATGPT_TERMINAL_AUTH,
      name: "Sign in to ChatGPT with Neko",
      description: "Run Neko's browser-based subscription OAuth flow in a separate terminal.",
      type: "terminal",
      args: ["login", "openai", "chatgpt"],
      env: {},
    }] : [];
    return {
      protocolVersion: params.protocolVersion === acp.PROTOCOL_VERSION ? params.protocolVersion : acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      authMethods,
      agentInfo: { name: "neko-core", version: VERSION },
    };
  });

  const refuseAuthorityExpansion = (params: { additionalDirectories?: string[]; mcpServers?: unknown[] }) => {
    if (params.additionalDirectories?.length) {
      throw new acp.RequestError(-32602, "Neko ACP does not yet support additionalDirectories.");
    }
    if (params.mcpServers?.length) {
      throw new acp.RequestError(
        -32602,
        "Client-supplied ACP MCP servers are disabled; configure trusted MCP servers in Neko instead.",
      );
    }
  };

  const configForSession = (root: string, record?: Session): NekoConfig => {
    let cfg: NekoConfig;
    if (options.configForRoot) cfg = options.configForRoot(root, record?.profile);
    else if (baseConfig) cfg = baseConfig;
    else cfg = loadConfig({ cwd: root, ...(record?.profile ? { profile: record.profile } : {}) });
    // Never let one ACP session mutate a caller-owned/base config object shared with another session.
    cfg = cfg.withModel(cfg.model).withEffort(cfg.effort);
    if (record?.profile && cfg.profile !== record.profile) {
      throw new acp.RequestError(-32002, `ACP session profile '${record.profile}' is unavailable.`);
    }
    if (record?.provider && cfg.provider !== record.provider) {
      throw new acp.RequestError(-32002, `ACP session provider '${record.provider}' no longer matches its saved profile.`);
    }
    if (record?.model) cfg = cfg.withModel(record.model);
    if (record?.reasoningEffort !== undefined) cfg = cfg.withEffort(record.reasoningEffort);
    return cfg;
  };

  const usageSnapshot = (session: AcpSession) => {
    const cost = session.runtime.agent.cost;
    return {
      promptTokens: cost.promptTokens,
      completionTokens: cost.completionTokens,
      totalTokens: cost.totalTokens,
      cachedTokens: cost.cachedTokens,
      cacheWriteTokens: cost.cacheWriteTokens,
      calls: cost.calls,
      lastPrompt: cost.lastPrompt,
      lastCompletion: cost.lastCompletion,
      lastCached: cost.lastCached,
      lastCacheWrite: cost.lastCacheWrite,
    };
  };

  const restoreUsage = (session: AcpSession) => {
    if (!session.record.usage) return;
    Object.assign(session.runtime.agent.cost, session.record.usage);
  };

  const storedMessages = async (session: AcpSession): Promise<any[]> => {
    const secret = session.runtime.config.apiKey;
    if (secret.length < 8) return [...session.runtime.agent.messages];
    const messages: any[] = [];
    let lastYield = performance.now();
    for (const message of session.runtime.agent.messages) {
      const serialized = JSON.stringify(message, (_key, value) =>
        typeof value === "string" ? value.split(secret).join("[redacted credential]") : value);
      messages.push(JSON.parse(serialized));
      if (performance.now() - lastYield >= 8) {
        await new Promise<void>((resolveYield) => setTimeout(resolveYield, 0));
        lastYield = performance.now();
      }
    }
    return messages;
  };

  const persist = (session: AcpSession, turnState = session.record.turnState): Promise<void> => {
    return session.writer.saveLazy(async () => {
      session.record = {
        ...session.record,
        schemaVersion: 2,
        cwd: session.root,
        provider: session.runtime.config.provider,
        model: session.runtime.config.model,
        profile: session.runtime.config.profile,
        mode: session.runtime.registry.mode,
        reasoningEffort: session.runtime.config.effort,
        revision: (session.record.revision ?? 0) + 1,
        messages: await storedMessages(session),
        usage: usageSnapshot(session),
        turnState,
        contextFingerprint: createHash("sha256").update(JSON.stringify({
          provider: session.runtime.config.provider,
          model: session.runtime.config.model,
          profile: session.runtime.config.profile,
          effort: session.runtime.config.effort,
          system: session.runtime.agent.messages.filter((message: any) => message?.role === "system"),
        })).digest("hex"),
      };
      return session.record;
    });
  };

  const queuePersist = (session: AcpSession, turnState = session.record.turnState): void => {
    void persist(session, turnState).catch((error) => {
      session.persistenceFailure ??= error;
      session.persistenceFailed = true;
      session.pending?.abort();
    });
  };

  const infoMeta = (session: AcpSession) => ({
    model: session.runtime.config.model,
    provider: session.runtime.config.provider,
    profile: session.runtime.config.profile,
    messageCount: session.record.messages.length,
    continuityLevel: session.record.turnState?.status === "interrupted" ? "recovered" : "durable",
    revision: session.record.revision ?? 0,
  });

  const syncSessionState = async (session: AcpSession, client: acp.AgentContext): Promise<void> => {
    await client.notify(acp.methods.client.session.update, {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: sessionTitle(session.record),
        updatedAt: session.record.updatedAt,
        _meta: infoMeta(session),
      },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: session.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: session.runtime.registry.mode },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: session.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: configOptions(session.runtime.config) },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: session.sessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands: ACP_COMMANDS },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: session.runtime.agent.cost.lastPrompt,
        size: session.runtime.config.contextWindow,
      },
    });
  };

  const replaySession = async (session: AcpSession, client: acp.AgentContext): Promise<void> => {
    session.toolCalls.clear();
    for (let index = 0; index < session.runtime.agent.messages.length; index++) {
      const message = session.runtime.agent.messages[index];
      if (!message || message.role === "system" || message._neko_internal === true) continue;
      const id = messageId(session.sessionId, message, index);
      if (message.role === "user") {
        const text = textContent(message.content);
        if (text) await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: { sessionUpdate: "user_message_chunk", messageId: id, content: { type: "text", text } },
        });
        continue;
      }
      if (message.role === "assistant") {
        const text = textContent(message.content);
        if (text) await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: { sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text } },
        });
        for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
          const call = normalizeCoreToolCall(raw);
          if (!call) continue;
          const update = toolUpdate(session.root, call);
          session.toolCalls.set(update.toolCallId, update);
          await client.notify(acp.methods.client.session.update, {
            sessionId: session.sessionId,
            update: { sessionUpdate: "tool_call", ...update },
          });
        }
        continue;
      }
      if (message.role === "tool") {
        const text = textContent(message.content);
        const toolCallId = String(message.tool_call_id ?? "tool");
        const update: acp.ToolCallUpdate = {
          toolCallId,
          status: classifyToolObservation(text) === "failed" || /outcome unknown|interrupted/i.test(text)
            ? "failed"
            : "completed",
          content: [{ type: "content", content: { type: "text", text } }],
          rawOutput: text,
        };
        session.toolCalls.set(toolCallId, { ...(session.toolCalls.get(toolCallId) ?? {
          toolCallId, title: toolCallId, kind: "other", status: "pending",
        }), ...update });
        await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: { sessionUpdate: "tool_call_update", ...update },
        });
      }
    }
  };

  const activate = async (
    record: Session,
    root: string,
    cfg: NekoConfig,
    client: acp.AgentContext,
    restored: boolean,
  ): Promise<AcpSession> => {
    if (sessions.has(record.id)) throw new acp.RequestError(-32000, "ACP session already has an active writer.");
    let lease: SessionLease;
    try { lease = acquireSessionLease(record.id); }
    catch (error) { throw new acp.RequestError(-32000, error instanceof Error ? error.message : String(error)); }

    const toolCalls = new Map<string, acp.ToolCallUpdate>();
    const alwaysAllow = new Set<string>();
    const alwaysReject = new Set<string>();
    let session!: AcpSession;
    let sendChain = Promise.resolve();
    const enqueue = (update: acp.SessionUpdate) => {
      sendChain = sendChain.then(() => client.notify(acp.methods.client.session.update, { sessionId: record.id, update }));
      void sendChain.catch(() => session.pending?.abort());
    };
    const approval = async (name: string, args: Record<string, any>): Promise<boolean> => {
      if (alwaysReject.has(name)) return false;
      if (alwaysAllow.has(name)) return true;
      const permissionClient = session.permissionClient;
      if (!permissionClient) return false;
      await session.flush();
      const call = [...toolCalls.values()].reverse().find((value) => value.name === name)
        ?? { toolCallId: randomUUID(), title: describeToolCall(name, args), name, kind: toolKind(name), status: "pending" as const, rawInput: args };
      const response = await abortable(permissionClient.request(acp.methods.client.session.requestPermission, {
        sessionId: record.id,
        toolCall: call,
        options: [
          { optionId: ALLOW_ONCE, name: "Allow once", kind: "allow_once" },
          { optionId: ALLOW_ALWAYS, name: `Always allow ${name} in this session`, kind: "allow_always" },
          { optionId: REJECT_ONCE, name: "Reject once", kind: "reject_once" },
          { optionId: REJECT_ALWAYS, name: `Always reject ${name} in this session`, kind: "reject_always" },
        ],
      }, { cancellationSignal: session.pending?.signal }), session.pending?.signal);
      if (response.outcome.outcome !== "selected") return false;
      if (response.outcome.optionId === ALLOW_ALWAYS) alwaysAllow.add(name);
      if (response.outcome.optionId === REJECT_ALWAYS) alwaysReject.add(name);
      return response.outcome.optionId === ALLOW_ONCE || response.outcome.optionId === ALLOW_ALWAYS;
    };

    let runtime: AgentRuntime | undefined;
    try {
      runtime = await buildRuntime(cfg, {
        root,
        mode: record.mode ?? cfg.mode,
        approval,
        onCheckpoint: async () => {
          if (session.persistenceFailed) throw session.persistenceFailure;
          await persist(session, {
            ...(session.record.turnState ?? { status: "running" }),
            status: "running",
            activeToolCallIds: [...session.activeToolCallIds],
          });
        },
        onDelta: (text, kind) => {
          if (!text || kind === "tool") return;
          if (kind !== "reasoning") session.streamedContentSinceTool += text;
          if (kind !== "reasoning" && !session.liveAgentMessageId) session.liveAgentMessageId = `msg_${randomUUID()}`;
          const last = runtime!.agent.messages.at(-1);
          if (kind !== "reasoning" && last?.role === "assistant" && !last._neko_acp_message_id) {
            last._neko_acp_message_id = session.liveAgentMessageId;
          }
          enqueue({
            sessionUpdate: kind === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
            ...(kind === "reasoning" ? {} : { messageId: session.liveAgentMessageId }),
            content: { type: "text", text },
          } as acp.SessionUpdate);
        },
        onEvent: (kind, data) => {
          if (kind === "tool_call") {
            const update = toolUpdate(root, data as ToolCall);
            toolCalls.set(update.toolCallId, update);
            session.activeToolCallIds.add(update.toolCallId);
            enqueue({ sessionUpdate: "tool_call", ...update } as acp.SessionUpdate);
          } else if (kind === "tool_result") {
            const call = data.call as ToolCall;
            const text = observationText(data.observation);
            const status = classifyToolObservation(data.observation) === "failed" ? "failed" : "completed";
            const update: acp.ToolCallUpdate = {
              toolCallId: call.id,
              status,
              content: [{ type: "content", content: { type: "text", text } }],
              rawOutput: text,
            };
            toolCalls.set(call.id, { ...(toolCalls.get(call.id) ?? toolUpdate(root, call)), ...update });
            session.activeToolCallIds.delete(call.id);
            enqueue({ sessionUpdate: "tool_call_update", ...update });
            session.streamedContentSinceTool = "";
            session.liveAgentMessageId = "";
          } else if (kind === "recovery") {
            queuePersist(session, {
              ...(session.record.turnState ?? { status: "running" }),
              status: "running",
              activeToolCallIds: [...session.activeToolCallIds],
            });
          } else if (kind === "max_steps") {
            session.maxStepsHit = true;
          } else if (kind === "final") {
            const final = typeof data === "string" ? data : "";
            const last = runtime!.agent.messages.at(-1);
            if (last?.role === "assistant" && !last._neko_acp_message_id) {
              last._neko_acp_message_id = session.liveAgentMessageId || `msg_${randomUUID()}`;
            }
            if (final && !session.streamedContentSinceTool.endsWith(final)) {
              enqueue({
                sessionUpdate: "agent_message_chunk",
                messageId: last?._neko_acp_message_id,
                content: { type: "text", text: final },
              });
            }
            queuePersist(session, session.record.turnState);
          }
        },
      });

      let closed = false;
      session = {
        sessionId: record.id,
        root,
        record,
        lease,
        runtime,
        permissionClient: client,
        toolCalls,
        alwaysAllow,
        alwaysReject,
        maxStepsHit: false,
        streamedContentSinceTool: "",
        liveAgentMessageId: "",
        activeToolCallIds: new Set(),
        writer: new AsyncSessionWriter(),
        persistenceFailed: false,
        flush: async () => {
          await sendChain;
          await session.writer.flush();
          if (session.persistenceFailed) throw session.persistenceFailure;
        },
        close: async () => {
          if (closed) return;
          closed = true;
          session.pending?.abort();
          await session.pendingSettled?.catch(() => {});
          await sendChain.catch(() => {});
          let failure: unknown;
          try {
            const interrupted = session.record.turnState?.status === "running";
            await persist(session, interrupted ? {
              ...session.record.turnState,
              status: "interrupted",
              lastStopReason: "connection_closed",
              activeToolCallIds: [...session.activeToolCallIds],
            } : session.record.turnState);
          } catch (error) { failure = error; }
          try { await session.runtime.close(); } catch (error) { failure ??= error; }
          lease.release();
          if (failure) throw failure;
        },
      };

      if (restored) {
        runtime.agent.messages = structuredClone(record.messages);
        runtime.agent.messages.forEach((message: any, index: number) => {
          if ((message?.role === "user" || message?.role === "assistant") && !message._neko_acp_message_id) {
            message._neko_acp_message_id = stableMessageId(record.id, index, message.role);
          }
        });
        restoreUsage(session);
        const wasRunning = record.turnState?.status === "running";
        const beforeSeal = JSON.stringify(runtime.agent.messages);
        runtime.agent.sealDanglingToolCalls();
        const sealedUnknownOutcome = JSON.stringify(runtime.agent.messages) !== beforeSeal;
        runtime.agent.refreshSystemPrompt();
        runtime.registry.todos = recoverSessionTodos(runtime.agent.messages);
        session.activeToolCallIds.clear();
        await persist(session, wasRunning || sealedUnknownOutcome ? {
          status: "interrupted",
          startedAt: record.turnState?.startedAt,
          recoveredAt: new Date().toISOString(),
          lastStopReason: "process_interrupted",
          activeToolCallIds: [],
        } : { ...(record.turnState ?? { status: "idle" }), activeToolCallIds: [] });
      } else {
        await persist(session, { status: "idle", activeToolCallIds: [] });
      }
      sessions.set(record.id, session);
      return session;
    } catch (error) {
      try { await runtime?.close(); } catch { /* preserve the activation failure */ }
      lease.release();
      throw error;
    }
  };

  app.onRequest("session/new", async ({ params, client }) => {
    refuseAuthorityExpansion(params);
    const root = sessionRoot(params.cwd);
    const cfg = configForSession(root);
    const now = new Date().toISOString();
    const record: Session = {
      schemaVersion: 2,
      id: newSessionId(),
      createdAt: now,
      updatedAt: now,
      cwd: root,
      provider: cfg.provider,
      model: cfg.model,
      profile: cfg.profile,
      mode: cfg.mode,
      reasoningEffort: cfg.effort,
      revision: 0,
      messages: [],
      turnState: { status: "idle", activeToolCallIds: [] },
    };
    const session = await activate(record, root, cfg, client, false);
    try {
      await syncSessionState(session, client);
      return { sessionId: record.id, modes: modeState(session.runtime.registry.mode), configOptions: configOptions(cfg) };
    } catch (error) {
      sessions.delete(record.id);
      await session.close().catch(() => {});
      throw error;
    }
  });

  app.onRequest("session/list", ({ params }) => {
    const filter = params.cwd ? sessionRoot(params.cwd) : null;
    const offset = decodeCursor(params.cursor);
    const pageSize = 50;
    const all = listSessionMetas().filter((meta) => !filter || sameRoot(comparableRoot(meta.cwd), filter));
    const page = all.slice(offset, offset + pageSize);
    return {
      sessions: page.map((meta) => ({
        sessionId: meta.id,
        cwd: resolve(meta.cwd),
        title: sessionTitle(meta),
        updatedAt: meta.updatedAt,
        _meta: {
          model: meta.model,
          provider: meta.provider ?? "",
          profile: meta.profile ?? null,
          mode: meta.mode ?? "default",
          messageCount: meta.msgCount,
          continuityLevel: meta.turnState?.status === "interrupted" ? "recovered" : "durable",
          revision: meta.revision ?? 0,
        },
      })),
      ...(offset + pageSize < all.length ? { nextCursor: encodeCursor(offset + pageSize) } : {}),
    };
  });

  const restore = async (
    params: acp.LoadSessionRequest | acp.ResumeSessionRequest,
    client: acp.AgentContext,
    replay: boolean,
  ) => {
    refuseAuthorityExpansion(params);
    if (sessions.has(params.sessionId)) throw new acp.RequestError(-32000, "ACP session already has an active writer.");
    const root = sessionRoot(params.cwd);
    const record = loadSession(params.sessionId);
    if (!record) throw new acp.RequestError(-32002, "ACP session not found or its checkpoints are corrupt.");
    let storedRoot: string;
    try { storedRoot = sessionRoot(record.cwd); }
    catch { throw new acp.RequestError(-32002, "ACP session workspace is no longer available."); }
    if (!sameRoot(storedRoot, root)) throw new acp.RequestError(-32602, "ACP session cwd does not match the saved workspace.");
    const cfg = configForSession(root, record);
    const session = await activate(record, root, cfg, client, true);
    try {
      if (replay) await replaySession(session, client);
      await syncSessionState(session, client);
      return { modes: modeState(session.runtime.registry.mode), configOptions: configOptions(session.runtime.config) };
    } catch (error) {
      sessions.delete(record.id);
      await session.close().catch(() => {});
      throw error;
    }
  };

  app.onRequest("session/load", ({ params, client }) => restore(params, client, true));
  app.onRequest("session/resume", ({ params, client }) => restore(params, client, false));

  app.onRequest("session/set_mode", async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new acp.RequestError(-32002, "ACP session not found.");
    if (!MODE_IDS.has(params.modeId)) throw new acp.RequestError(-32602, "Unknown Neko permission mode.");
    session.runtime.registry.mode = params.modeId as PermissionMode;
    await persist(session, session.record.turnState);
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
    });
    return {};
  });

  app.onRequest("session/set_config_option", async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new acp.RequestError(-32002, "ACP session not found.");
    if (session.pending) throw new acp.RequestError(-32000, "Session configuration cannot change during an active prompt.");
    if (typeof params.value !== "string") throw new acp.RequestError(-32602, "Neko ACP configuration options are selectors.");
    const current = session.runtime.config;
    let next: NekoConfig;
    if (params.configId === "model") {
      const allowed = configOptions(current).find((option) => option.id === "model");
      const values = allowed?.type === "select" ? allowed.options.flatMap((item: any) => item.options ?? [item]).map((item: any) => item.value) : [];
      if (!values.includes(params.value)) throw new acp.RequestError(-32602, "Unknown model option.");
      next = current.withModel(params.value);
    } else if (params.configId === "reasoning_effort") {
      const value = params.value === "default" ? "" : params.value;
      if (!new Set(["", "none", "low", "medium", "high", "xhigh", "max"]).has(value)) {
        throw new acp.RequestError(-32602, "Unknown reasoning effort.");
      }
      next = current.withEffort(value);
    } else if (params.configId === "profile") {
      if (params.value === "__custom__" || !current.profiles[params.value]) throw new acp.RequestError(-32602, "Unknown provider profile.");
      next = loadConfig({ cwd: session.root, home: current.resolvedHome, profile: params.value });
    } else if (params.configId === "provider") {
      const candidates = Object.entries(current.profiles).filter(([, profile]) => profile.provider === params.value);
      if (current.provider === params.value) next = current.withModel(current.model);
      else if (candidates.length) next = loadConfig({ cwd: session.root, home: current.resolvedHome, profile: candidates[0][0] });
      else throw new acp.RequestError(-32602, "Unknown provider option.");
    } else {
      throw new acp.RequestError(-32602, "Unknown Neko ACP configuration option.");
    }
    const hasOpaqueContinuation = session.runtime.agent.messages.some((message: any) => Array.isArray(message?.provider_data) && message.provider_data.length);
    if (hasOpaqueContinuation && (next.provider !== current.provider || next.baseUrl !== current.baseUrl)) {
      throw new acp.RequestError(-32000, "This session has provider-specific continuation state; fork it before changing provider or endpoint.");
    }
    const provider = getProvider(next);
    current.adopt(next);
    session.runtime.agent.setProvider(provider);
    session.runtime.agent.setMaxContextTokens(current.contextWindow);
    session.runtime.agent.refreshSystemPrompt();
    await persist(session, session.record.turnState);
    const updated = configOptions(current);
    await client.notify(acp.methods.client.session.update, {
      sessionId: session.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: updated },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: session.sessionId,
      update: { sessionUpdate: "session_info_update", updatedAt: session.record.updatedAt, _meta: infoMeta(session) },
    });
    return { configOptions: updated };
  });

  app.onRequest("session/prompt", async ({ params, client, signal }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new acp.RequestError(-32002, "ACP session not found.");
    if (session.pending) throw new acp.RequestError(-32000, "An ACP prompt is already active for this session.");
    const input = promptText(params.prompt);
    if (params.prompt.some((block) => block.type === "image" || block.type === "audio")) {
      throw new acp.RequestError(-32602, "Neko ACP v1 does not advertise image or audio prompt support.");
    }
    if (!input.text) throw new acp.RequestError(-32602, "ACP prompt must contain text or supported context.");
    const pending = new AbortController();
    session.pending = pending;
    session.pendingSettled = new Promise<void>((resolvePending) => { session.settlePending = resolvePending; });
    const abort = () => pending.abort();
    signal.addEventListener("abort", abort, { once: true });
    session.permissionClient = client;
    const runtime = session.runtime;
    session.maxStepsHit = false;
    session.streamedContentSinceTool = "";
    session.liveAgentMessageId = "";
    let lease: { close(): void } | undefined;
    try {
      const slash = /^\/(help|cost|sessions|tools)(?:\s|$)/.exec(input.text);
      if (slash) {
        const command = slash[1];
        const text = command === "help"
          ? ACP_COMMANDS.map((item) => `/${item.name} - ${item.description}`).join("\n")
          : command === "cost"
            ? runtime.agent.cost.summary()
            : command === "sessions"
              ? listSessionMetas().filter((meta) => sameRoot(comparableRoot(meta.cwd), session.root)).slice(0, 20)
                .map((meta) => `${meta.id}  ${sessionTitle(meta)}`).join("\n") || "No durable sessions in this workspace."
              : runtime.registry.schemas().map((schema: any) => schema.function?.name ?? schema.name).filter(Boolean).sort().join("\n");
        await client.notify(acp.methods.client.session.update, {
          sessionId: session.sessionId,
          update: { sessionUpdate: "agent_message_chunk", messageId: `msg_${randomUUID()}`, content: { type: "text", text } },
        });
        return { stopReason: "end_turn" };
      }
      const plan = planTurnCapabilities({
        rawUserText: input.text,
        source: "user",
        imageCount: input.images.length,
        attachmentCount: params.prompt.filter((block) => block.type !== "text" && block.type !== "image").length,
        root: runtime.registry.root,
        home: runtime.config.resolvedHome,
      });
      lease = runtime.registry.enterTurn({
        name: plan.profile,
        allowedTools: plan.allowedTools,
        allowBackgroundBash: plan.allowBackgroundBash,
        editTarget: plan.editTarget,
        bashPolicy: plan.bashPolicy,
        reason: plan.reason,
      });
      applySkillPolicyForTurn(runtime.registry, input.text, runtime.registry.root, runtime.config.resolvedHome);
      runtime.agent.setTurnSystemContext(matchedTurnContext(
        input.text,
        runtime.registry,
        runtime.config.resolvedHome,
      ).text);
      session.record.turnState = {
        status: "running",
        startedAt: new Date().toISOString(),
        activeToolCallIds: [],
      };
      const answerPromise = runtime.agent.run(input.text, pending.signal, input.images.length ? input.images : undefined);
      const lastUser = [...runtime.agent.messages].reverse().find((message: any) => message?.role === "user" && message._neko_internal !== true);
      if (lastUser && !lastUser._neko_acp_message_id) lastUser._neko_acp_message_id = `msg_${randomUUID()}`;
      await persist(session, session.record.turnState);
      const answer = await answerPromise;
      await session.flush();
      const stopReason = !pending.signal.aborted && answer === "[interrupted]"
        ? "cancelled"
        : pending.signal.aborted
          ? "cancelled"
          : session.maxStepsHit
            ? "max_turn_requests"
            : "end_turn";
      const interruptedMutation = stopReason === "cancelled" && session.activeToolCallIds.size > 0;
      session.record.turnState = interruptedMutation
        ? { status: "interrupted", lastStopReason: stopReason, activeToolCallIds: [...session.activeToolCallIds] }
        : { status: "idle", lastStopReason: stopReason, activeToolCallIds: [] };
      await persist(session, session.record.turnState);
      await syncSessionState(session, client);
      return { stopReason };
    } catch (error) {
      pending.abort();
      session.record.turnState = {
        ...(session.record.turnState ?? { status: "interrupted" }),
        status: "interrupted",
        lastStopReason: pending.signal.aborted ? "cancelled" : "error",
        activeToolCallIds: [...session.activeToolCallIds],
      };
      await persist(session, session.record.turnState);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      runtime.registry.setSkillPolicyForTurn(undefined);
      lease?.close();
      try {
        runtime.agent.clearTurnSystemContext();
      } finally {
        if (session.pending === pending) {
          session.pending = undefined;
          session.settlePending?.();
          session.settlePending = undefined;
          session.pendingSettled = undefined;
        }
      }
    }
  });

  app.onNotification("session/cancel", async ({ params }) => {
    sessions.get(params.sessionId)?.pending?.abort();
  });

  app.onRequest("session/close", async ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (!session) return {};
    sessions.delete(params.sessionId);
    await session.close();
    return {};
  });

  app.onConnect((connection) => {
    const cleanup = connection.closed.finally(async () => {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map((session) => session.close()));
    });
    options.trackCleanup?.(cleanup);
  });

  return app;
}

/** Serve ACP v1 over stdio. Stdout is protocol-only; diagnostics belong on stderr. */
export async function runAcpServer(options: AcpRuntimeFactoryOptions = {}): Promise<void> {
  const stderrLog = console.error.bind(console);
  const previousLog = console.log;
  const previousWarn = console.warn;
  console.log = (...values: unknown[]) => stderrLog(...values);
  console.warn = (...values: unknown[]) => stderrLog(...values);
  try {
    const output = Writable.toWeb(process.stdout);
    const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
    const cleanupTasks: Promise<void>[] = [];
    const connection = createNekoAcpAgent({
      ...options,
      trackCleanup: (task) => {
        cleanupTasks.push(task);
        options.trackCleanup?.(task);
      },
    }).connect(acp.ndJsonStream(output, input));
    await connection.closed;
    await Promise.all(cleanupTasks);
  } finally {
    console.log = previousLog;
    console.warn = previousWarn;
  }
}
