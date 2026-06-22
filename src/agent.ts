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
  "You are Neko Code, a hands-on coding agent in a terminal. You ACT by calling tools; you never " +
  "just describe what to do.\n" +
  "You HAVE full access to this machine through the bash tool - it runs any real shell command " +
  "(disk usage, system info, git, builds, tests, reading or searching files anywhere on disk). " +
  "NEVER say you 'cannot access the system', 'have no permission', or 'cannot directly check' - you " +
  "can, via bash.\n" +
  "When the user asks WHETHER you can do something, or to check / find / show / run anything, just " +
  "DO IT: call the tool and report the real result. NEVER print a shell command as text for the " +
  "user to run - run it yourself with bash and show its output. (Example: 'can you check C: free " +
  "space?' -> call bash with a command like `wmic logicaldisk get size,freespace,caption`, then " +
  "report the numbers.)\n" +
  "Tools: read_file, search, glob, ls inspect the project; write_file and edit change files; bash " +
  "runs shell commands.\n" +
  "Prefer `edit` for small changes (exact unique string replace) over rewriting whole files.\n" +
  "read_file output is line-numbered for reference only - never include the line-number prefix in " +
  "edits.\n" +
  "For multi-step tasks, call todo_write to plan and track progress (keep exactly one item " +
  "in_progress); update it as you go.\n" +
  "Inspect before you edit; make the smallest change that works; verify by running tests or bash. " +
  "Be concise - no filler. When the task is done, give a short summary and stop calling tools.";

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

  /** Summarize the conversation and replace it with the summary, freeing context. */
  async compact(): Promise<string> {
    const convo = this.messages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n")
      .slice(0, 16000);
    const res = await this.provider.complete([
      { role: "system", content: "Summarize the conversation below concisely: the task, key decisions, files changed, and the current state. Be brief." },
      { role: "user", content: convo },
    ]);
    this.cost.add(res.usage);
    const summary = res.content ?? "";
    const sys = this.messages.find((m) => m.role === "system");
    this.messages = [...(sys ? [sys] : []), { role: "user", content: `[Summary of earlier conversation]\n${summary}` }];
    return summary;
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
        if (signal?.aborted) return "[interrupted]"; // stop promptly between tools on Esc
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
