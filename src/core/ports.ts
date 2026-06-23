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
  reasoning?: string; // the model's thinking, when the endpoint returns reasoning_content
}

/** onDelta streams chunks as they arrive (SSE). kind="reasoning" is the model's live thinking. */
export type DeltaHook = (text: string, kind?: "content" | "reasoning") => void;

/** The LLM port. One method; `OpenAICompatProvider` is the adapter. */
export interface Provider {
  complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal): Promise<ProviderResponse>;
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
