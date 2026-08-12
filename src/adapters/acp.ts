/** ACP v1 adapter: exposes the production Neko Agent over newline-delimited JSON-RPC stdio. */
import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import { classifyToolObservation } from "../core/agent.ts";
import type { ToolCall } from "../core/ports.ts";
import type { PermissionMode } from "../core/permissions.ts";
import { describeToolCall } from "../core/tools.ts";
import { VERSION } from "../shared/version.ts";
import { buildAgentRuntime, type AgentRuntime } from "./agent-runtime.ts";
import { loadConfig, type NekoConfig } from "./config.ts";
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

type Notify = (update: acp.SessionUpdate) => Promise<void>;

interface AcpSession {
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
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface AcpRuntimeFactoryOptions {
  config?: NekoConfig;
  configForRoot?: (root: string) => NekoConfig;
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
  } catch {
    throw new acp.RequestError(-32602, "ACP session cwd must be an existing directory.");
  }
  return root;
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
        loadSession: false,
        promptCapabilities: { embeddedContext: true },
        sessionCapabilities: { close: {} },
      },
      authMethods,
      agentInfo: { name: "neko-core", version: VERSION },
    };
  });

  app.onRequest("session/new", async ({ params, client }) => {
    if (params.additionalDirectories?.length) {
      throw new acp.RequestError(-32602, "Neko ACP does not yet support additionalDirectories.");
    }
    if (params.mcpServers.length) {
      throw new acp.RequestError(
        -32602,
        "Client-supplied ACP MCP servers are disabled; configure trusted MCP servers in Neko instead.",
      );
    }
    const root = sessionRoot(params.cwd);
    const cfg = options.configForRoot?.(root) ?? baseConfig ?? loadConfig({ cwd: root });
    const sessionId = randomUUID();
    const toolCalls = new Map<string, acp.ToolCallUpdate>();
    const alwaysAllow = new Set<string>();
    const alwaysReject = new Set<string>();
    let session!: AcpSession;

    const approval = async (name: string, args: Record<string, any>): Promise<boolean> => {
      if (alwaysReject.has(name)) return false;
      if (alwaysAllow.has(name)) return true;
      const permissionClient = session.permissionClient;
      if (!permissionClient) return false;
      await session.flush();
      const call = [...toolCalls.values()].reverse().find((value) => value.name === name)
        ?? { toolCallId: randomUUID(), title: describeToolCall(name, args), name, kind: toolKind(name), status: "pending" as const, rawInput: args };
      const response = await abortable(permissionClient.request(acp.methods.client.session.requestPermission, {
        sessionId,
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

    const notify: Notify = (update) => client.notify(acp.methods.client.session.update, { sessionId, update });
    let sendChain = Promise.resolve();
    const enqueue = (update: acp.SessionUpdate) => {
      sendChain = sendChain.then(() => notify(update));
      void sendChain.catch(() => session.pending?.abort());
    };
    const runtime = await buildRuntime(cfg, {
      root,
      mode: cfg.mode,
      approval,
      onDelta: (text, kind) => {
        if (!text || kind === "tool") return;
        if (kind !== "reasoning") session.streamedContentSinceTool += text;
        enqueue({
          sessionUpdate: kind === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
          content: { type: "text", text },
        });
      },
      onEvent: (kind, data) => {
        if (kind === "tool_call") {
          const update = toolUpdate(root, data as ToolCall);
          toolCalls.set(update.toolCallId, update);
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
          enqueue({ sessionUpdate: "tool_call_update", ...update });
          session.streamedContentSinceTool = "";
        } else if (kind === "max_steps") {
          session.maxStepsHit = true;
        } else if (kind === "final") {
          const final = typeof data === "string" ? data : "";
          if (final && !session.streamedContentSinceTool.endsWith(final)) {
            enqueue({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: final } });
          }
        }
      },
    });
    session = {
      runtime,
      permissionClient: client,
      toolCalls,
      alwaysAllow,
      alwaysReject,
      maxStepsHit: false,
      streamedContentSinceTool: "",
      flush: () => sendChain,
      close: async () => {
        session.pending?.abort();
        await session.pendingSettled?.catch(() => {});
        await sendChain.catch(() => {});
        await runtime.close();
      },
    };
    sessions.set(sessionId, session);
    return { sessionId, modes: modeState(runtime.registry.mode) };
  });

  app.onRequest("session/set_mode", async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new acp.RequestError(-32002, "ACP session not found.");
    if (!MODE_IDS.has(params.modeId)) throw new acp.RequestError(-32602, "Unknown Neko permission mode.");
    session.runtime.registry.mode = params.modeId as PermissionMode;
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
    });
    return {};
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
    let lease: { close(): void } | undefined;
    try {
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
      const answer = await runtime.agent.run(input.text, pending.signal, input.images.length ? input.images : undefined);
      await session.flush();
      if (!pending.signal.aborted && answer === "[interrupted]") return { stopReason: "cancelled" };
      return {
        stopReason: pending.signal.aborted
          ? "cancelled"
          : session.maxStepsHit
            ? "max_turn_requests"
            : "end_turn",
      };
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
