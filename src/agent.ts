/**
 * The agentic loop.
 *
 *   while not done and steps < maxSteps:
 *     res = await provider.complete(messages, toolSchemas())
 *     if res.tool_calls: for each -> observation = await tools.execute(call); append tool result
 *     else: done (final answer)
 *
 * The maxSteps cap is load-bearing: an agent without one can loop forever and burn money.
 * Tool observations (errors + denials) are fed back so the model adapts rather than crash.
 */
import { CostTracker } from "./cost.ts";
import type { DeltaHook, Provider, ToolCall } from "./providers.ts";
import type { ToolRegistry } from "./tool-runtime.ts";

export const DEFAULT_SYSTEM_PROMPT =
  "You are Neko Code, a local-first coding agent. Complete the user's task by calling tools.\n" +
  "Tools: read_file, search, glob, ls are read-only; write_file, edit, bash change the " +
  "workspace and require approval.\n" +
  "Prefer `edit` for small changes (exact unique string replace) over rewriting whole files.\n" +
  "read_file output is prefixed with line numbers for reference only - never include the " +
  "line-number prefix in edit/write content.\n" +
  "For multi-step tasks, call todo_write to plan and track progress (keep exactly one item " +
  "in_progress); update it as you go.\n" +
  "Find code with search/glob before assuming; verify your change by running tests or bash. " +
  "Be concise - no filler.\n" +
  "Work in small steps: inspect before you edit, make the smallest change that solves the task, " +
  "and verify your work. When the task is done, reply with a short summary and stop calling tools.";

// onEvent(kind, data): kind in {"tool_call", "tool_result", "final", "max_steps"}.
export type EventHook = (kind: string, data: any) => void;

export interface AgentOptions {
  provider: Provider;
  tools: ToolRegistry;
  maxSteps?: number;
  systemPrompt?: string;
  onEvent?: EventHook;
  /** When set, assistant content is streamed chunk-by-chunk as it arrives. */
  onDelta?: DeltaHook;
}

export class Agent {
  private readonly provider: Provider;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly systemPrompt: string;
  private readonly onEvent?: EventHook;
  private readonly onDelta?: DeltaHook;
  readonly cost = new CostTracker();
  messages: any[] = [];

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.tools = opts.tools;
    this.maxSteps = opts.maxSteps ?? 20;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.onEvent = opts.onEvent;
    this.onDelta = opts.onDelta;
  }

  /** Append text to the system prompt (used by /skill). Seeds the base prompt if needed. */
  appendSystem(text: string): void {
    const sys = this.messages.find((m) => m.role === "system");
    if (sys) sys.content += "\n\n" + text;
    else this.messages.unshift({ role: "system", content: this.systemPrompt + "\n\n" + text });
  }

  /** Run the loop until the model is done or maxSteps is hit. Returns the final text.
   * Pass an AbortSignal to support Esc-to-interrupt (stops cleanly between/within steps). */
  async run(instruction: string, signal?: AbortSignal): Promise<string> {
    if (!this.messages.length) {
      this.messages.push({ role: "system", content: this.systemPrompt });
    }
    this.messages.push({ role: "user", content: instruction });

    for (let step = 0; step < this.maxSteps; step++) {
      this.emit("step", step + 1);
      if (signal?.aborted) return "[interrupted]";
      let response;
      try {
        response = await this.provider.complete(this.messages, this.tools.schemas(), this.onDelta, signal);
      } catch (error) {
        if (signal?.aborted) return "[interrupted]";
        throw error;
      }
      this.cost.add(response.usage);
      const toolCalls = response.tool_calls ?? [];

      if (!toolCalls.length) {
        const final = response.content ?? "";
        this.messages.push({ role: "assistant", content: final });
        this.emit("final", final);
        return final;
      }

      this.messages.push(assistantToolMessage(response.content, toolCalls));
      for (const call of toolCalls) {
        this.emit("tool_call", call);
        const observation = await this.tools.execute(call.name, call.arguments);
        this.emit("tool_result", { call, observation });
        this.messages.push({
          role: "tool",
          tool_call_id: call.id || call.name,
          content: observation,
        });
      }
    }

    this.emit("max_steps", this.maxSteps);
    return `[stopped: reached max_steps=${this.maxSteps}]`;
  }

  private emit(kind: string, data: any): void {
    this.onEvent?.(kind, data);
  }
}

/** Rebuild the OpenAI-format assistant turn so the next request carries the tool_calls
 * the model made (ids must match the following tool results). */
function assistantToolMessage(content: string | null, toolCalls: ToolCall[]): any {
  return {
    role: "assistant",
    content: content ?? "",
    tool_calls: toolCalls.map((call) => ({
      id: call.id || call.name,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    })),
  };
}
