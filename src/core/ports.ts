/**
 * Ports: the interfaces the core domain depends on. Adapters (LLM HTTP, MCP) implement them,
 * so the agent loop never knows which backend it is talking to. See docs/process/ARCHITECTURE.md.
 */
import type { Usage } from "./cost.ts";

export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
}

export interface ProviderResponse {
  content: string | null;
  tool_calls: ToolCall[];
  usage?: Usage;
  reasoning?: string; // the model's thinking (reasoning_content field or <think> tags in content)
  /** Opaque provider continuation items that must be replayed with the assistant turn (for example,
   * encrypted Responses reasoning items between tool rounds). The core stores but never interprets it. */
  continuation?: any[];
}

/** onDelta streams chunks as they arrive (SSE). kind="reasoning" is the model's live thinking;
 * kind="tool" is streamed tool-call argument text (used only for a live token estimate, not shown). */
export type DeltaHook = (text: string, kind?: "content" | "reasoning" | "tool") => void;

/** Stable, payload-free lifecycle metadata for one provider request attempt. Hosts can persist and
 * render this without retaining prompts, credentials, response bodies, or model-authored text. */
export interface ProviderAttemptEvent {
  type: "attempt_started" | "retry_scheduled";
  attempt: number;
  reason?: ProviderFailureCode;
  delayMs?: number;
  maxRetries?: number;
}

export type ProviderFailureCode =
  | "transport_unavailable"
  | "rate_limited"
  | "server_error"
  | "stream_interrupted"
  | "stream_overloaded"
  | "stream_timeout";

/**
 * A transient provider attempt failed. `recovery` is the semantic commit barrier:
 * - `replay`: no model-authored content/tool call escaped, so the identical request may be retried.
 * - `continue`: output crossed the boundary; never replay invisibly. Continue from the durable Agent
 *   trajectory with a new turn, so partial text is preserved and unknown mutations are inspected.
 * - `none`: the failure is classified but automatic recovery is unsafe.
 */
export class ProviderAttemptError extends Error {
  readonly name = "ProviderAttemptError";
  readonly retryable: boolean;
  readonly recovery: "replay" | "continue" | "none";
  readonly semanticActivity: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    readonly code: ProviderFailureCode,
    options: {
      retryable?: boolean;
      recovery?: "replay" | "continue" | "none";
      semanticActivity?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.retryable = options.retryable ?? true;
    this.recovery = options.recovery ?? "none";
    this.semanticActivity = options.semanticActivity ?? this.recovery === "continue";
    if (Number.isFinite(options.retryAfterMs) && Number(options.retryAfterMs) >= 0) {
      this.retryAfterMs = Number(options.retryAfterMs);
    }
  }
}

/** Per-call options. `responseSchema` (a JSON Schema) asks for schema-constrained structured output
 * (native `response_format` where the endpoint supports it) so an extraction reliably fills a shape -
 * e.g. enumerating every product variant instead of collapsing to one value. */
export interface CompleteOptions {
  responseSchema?: any;
  /** Optional per-call compute tier selected by the host. Adapters keep the saved user effort as an
   * upper bound, so an adaptive controller can spend less on mechanical steps but never more. */
  reasoningEffort?: string;
  /** Fired the moment a STREAMED tool call is fully parsed - long before the whole response finishes.
   * Lets the agent overlap read-only tool execution with the rest of the generation ("Executing as
   * You Generate", arXiv 2604.00491). Best-effort: non-streaming responses may never fire it. */
  onToolCallReady?: (call: ToolCall) => void;
  /** Authoritative usage snapshot for the current complete() call, emitted before completion whenever
   * the provider protocol exposes it. The Agent books ProviderResponse.usage on success, or the final
   * live snapshot once if the provider rejects after already consuming billable tokens. */
  onUsage?: (usage: Usage) => void;
  /** Bidirectional providers (for example Codex App Server dynamic tools) can pause an in-flight
   * turn and ask the host to execute a tool. The Agent supplies its existing safeExecute boundary,
   * so approvals and path/sandbox rules stay authoritative in Neko rather than the sidecar. */
  executeTool?: (call: ToolCall) => Promise<string | any[]>;
  /** Attempt lifecycle only; never contains prompts, output, URLs, headers, or credentials. Awaiting
   * this hook lets the host persist its retry state before the adapter starts cancellable backoff. */
  onAttempt?: (event: ProviderAttemptEvent) => void | Promise<void>;
}

/** The LLM port. One method; `OpenAICompatProvider` is the adapter. */
export interface Provider {
  complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse>;
  dispose?(): void | Promise<void>;
}

/** Port for an external tool source (MCP servers). `McpHub` satisfies it structurally. */
export interface McpTools {
  toolSchemas(): any[];
  has(name: string): boolean;
  call(name: string, args: any, signal?: AbortSignal): Promise<string>;
  /** External adapters may explicitly mark read-only calls safe. Unknown tools stay gated. */
  permission?(name: string): "safe" | "gated";
  /** True when an equal call observes a new time interval rather than repeating the same operation. */
  temporal?(name: string): boolean;
  /** MCP prompts (optional): list templates and render one to text. */
  promptList?(): { server: string; name: string }[];
  getPrompt?(server: string, name: string, args: any): Promise<string>;
  /** Lazy tool loading (optional): pull tool schemas on demand instead of all upfront. */
  loadTools?(names: string[]): string;
  indexBlock?(): string;
}

/** Web content acquisition (implemented by an adapter, injected by the host). */
export interface WebPort {
  search(query: string, opts: { searxngUrl: string; backend: string; keepaliveMin?: number; tavilyKey?: string }): Promise<string>;
  fetch(
    root: string,
    args: any,
    backend: string,
    summarize?: (instruction: string, content: string, schema?: any) => Promise<string>,
  ): Promise<string>;
}
