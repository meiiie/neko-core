/**
 * Ports: the interfaces the core domain depends on. Adapters (LLM HTTP, MCP) implement them,
 * so the agent loop never knows which backend it is talking to. See docs/process/ARCHITECTURE.md.
 */
import type { Usage } from "./cost.ts";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ProviderResponse {
  content: string | null;
  tool_calls: ToolCall[];
  usage?: Usage;
  reasoning?: string; // the model's thinking (reasoning_content field or <think> tags in content)
}

/** onDelta streams chunks as they arrive (SSE). kind="reasoning" is the model's live thinking;
 * kind="tool" is streamed tool-call argument text (used only for a live token estimate, not shown). */
export type DeltaHook = (text: string, kind?: "content" | "reasoning" | "tool") => void;

/** Per-call options. `responseSchema` (a JSON Schema) asks for schema-constrained structured output
 * (native `response_format` where the endpoint supports it) so an extraction reliably fills a shape -
 * e.g. enumerating every product variant instead of collapsing to one value. */
export interface CompleteOptions {
  responseSchema?: Record<string, any>;
}

/** The LLM port. One method; `OpenAICompatProvider` is the adapter. */
export interface Provider {
  complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse>;
}

/** Port for an external tool source (MCP servers). `McpHub` satisfies it structurally. */
export interface McpTools {
  toolSchemas(): any[];
  has(name: string): boolean;
  call(name: string, args: Record<string, any>): Promise<string>;
  /** MCP prompts (optional): list templates and render one to text. */
  promptList?(): { server: string; name: string }[];
  getPrompt?(server: string, name: string, args: Record<string, any>): Promise<string>;
}
