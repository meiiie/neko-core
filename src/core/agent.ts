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
import type { DeltaHook, Provider, ToolCall } from "./ports.ts";
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
  "runs shell commands; web_search and web_fetch reach the INTERNET. You CAN search the web - use " +
  "web_search (then web_fetch a result) rather than saying you have no internet access.\n" +
  "Prefer `edit` for small changes (exact unique string replace) over rewriting whole files.\n" +
  "read_file output is line-numbered for reference only - never include the line-number prefix in " +
  "edits.\n" +
  "For multi-step tasks, call todo_write to plan and track progress (keep exactly one item " +
  "in_progress); update it as you go.\n" +
  "In 'plan' mode you are read-only: research first, then call exit_plan_mode with a concrete " +
  "plan (markdown) and wait for the user to approve before editing anything.\n" +
  "For a big, self-contained subtask (deep research, a focused investigation), delegate it with " +
  "the task tool — a fresh sub-agent handles it and returns just the result, keeping this " +
  "conversation uncluttered.\n" +
  "Inspect before you edit; make the smallest change that works; verify by running tests or bash. " +
  "Be concise - no filler. When the task is done, give a short summary and stop calling tools.";

// Tools safe to run concurrently in one turn: read-only inspection + sub-agent tasks (the
// "fleet"). Mutating tools (write_file/edit/bash) are excluded so they stay ordered + gated.
const CONCURRENCY_SAFE = new Set(["read_file", "search", "glob", "ls", "web_search", "web_fetch", "task"]);

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
  /** Re-evaluated before every turn (env + project context), so model/cwd/git/NEKO.md stay
   * current even if the user switches model or edits memory mid-session. */
  dynamicContext?: () => string;
}

export class Agent {
  private readonly provider: Provider;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly systemPrompt: string;
  private readonly onEvent?: EventHook;
  private readonly onDelta?: DeltaHook;
  private readonly dynamicContext?: () => string;
  readonly cost = new CostTracker();
  messages: any[] = [];

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.tools = opts.tools;
    this.maxSteps = opts.maxSteps ?? 20;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.onEvent = opts.onEvent;
    this.onDelta = opts.onDelta;
    this.dynamicContext = opts.dynamicContext;
  }

  /** Summarize the conversation and replace it with the summary, freeing context. */
  async compact(): Promise<string> {
    const sys = this.messages.filter((m) => m.role === "system"); // keep system + dynamic context
    const convo = this.messages.filter((m) => m.role !== "system");

    // Keep the most recent turns verbatim; only summarize what's older. Snap the boundary back to
    // a user message so we never orphan a tool result from its assistant tool_call.
    const KEEP_TAIL = 8;
    let cut = Math.max(0, convo.length - KEEP_TAIL);
    while (cut > 0 && convo[cut].role !== "user") cut--;
    const head = convo.slice(0, cut);
    const tail = convo.slice(cut);
    if (!head.length) return ""; // nothing old enough to compact

    const text = head
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n")
      .slice(0, 40000);
    const res = await this.provider.complete([
      { role: "system", content: "Summarize the conversation below concisely: the task, key decisions, files changed, and the current state. Be brief." },
      { role: "user", content: text },
    ]);
    this.cost.add(res.usage);
    const summary = res.content ?? "";
    this.messages = [...sys, { role: "user", content: `[Summary of earlier conversation]\n${summary}` }, ...tail];
    return summary;
  }

  /** Closed-loop runner (agent-looping, "closed" variant): do the goal, then self-review against
   * a high bar and fix gaps, repeating until the model replies DONE or maxIters is hit. Bounded +
   * an eval each pass = autonomous without becoming a slop machine. Honors the abort signal. */
  async runUntilDone(goal: string, opts: { maxIters?: number; signal?: AbortSignal } = {}): Promise<string> {
    const maxIters = Math.max(1, Math.min(opts.maxIters ?? 6, 20));
    let out = await this.run(goal, opts.signal);
    for (let i = 1; i < maxIters; i++) {
      if (opts.signal?.aborted || out === "[interrupted]") return out;
      out = await this.run(
        `CLOSED-LOOP REVIEW (pass ${i + 1}/${maxIters}). Goal: "${goal}".\n` +
          `Critically check the work so far against the goal and a high quality bar. If it is FULLY ` +
          `met, reply with exactly "DONE" and nothing else. Otherwise, fix what's missing now.`,
        opts.signal,
      );
      if (/^\s*done[.!]?\s*$/i.test(out)) break;
    }
    return out;
  }

  /** Keep one live system message (right after the base prompt) holding env + project context,
   * refreshed each turn — so a mid-session model switch or NEKO.md edit is reflected at once. */
  private refreshDynamicContext(): void {
    if (!this.dynamicContext) return;
    const text = this.dynamicContext();
    const existing = this.messages.find((m) => m.role === "system" && m.dynamic);
    if (!text) {
      if (existing) this.messages = this.messages.filter((m) => m !== existing);
      return;
    }
    if (existing) existing.content = text;
    else {
      const baseIdx = this.messages.findIndex((m) => m.role === "system");
      this.messages.splice(baseIdx + 1, 0, { role: "system", content: text, dynamic: true });
    }
  }

  /** Append text to the system prompt (used by /skill). Seeds the base prompt if needed. */
  appendSystem(text: string): void {
    const sys = this.messages.find((m) => m.role === "system");
    if (sys) sys.content += "\n\n" + text;
    else this.messages.unshift({ role: "system", content: this.systemPrompt + "\n\n" + text });
  }

  /** Run the loop until the model is done or maxSteps is hit. Returns the final text.
   * Pass an AbortSignal to support Esc-to-interrupt (stops cleanly between/within steps).
   * `images` (data: URLs) attach as OpenAI vision content — used by paste-image (needs a vision model). */
  async run(instruction: string, signal?: AbortSignal, images?: string[]): Promise<string> {
    if (!this.messages.length) {
      this.messages.push({ role: "system", content: this.systemPrompt });
    }
    this.refreshDynamicContext();
    const content = images && images.length
      ? [{ type: "text", text: instruction }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))]
      : instruction;
    this.messages.push({ role: "user", content });

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
      if (signal?.aborted) return "[interrupted]";

      // Fleet fan-out: if every call in this batch is concurrency-safe (read-only or a sub-agent
      // task), run them in parallel; results are recorded in call order. Anything that mutates
      // the workspace (write/edit/bash) stays sequential to preserve order + approval prompts.
      if (toolCalls.length > 1 && toolCalls.every((c) => CONCURRENCY_SAFE.has(c.name))) {
        toolCalls.forEach((call) => this.emit("tool_call", call));
        const observations = await Promise.all(toolCalls.map((call) => this.tools.execute(call.name, call.arguments)));
        toolCalls.forEach((call, i) => {
          this.emit("tool_result", { call, observation: observations[i] });
          this.messages.push({ role: "tool", tool_call_id: call.id || call.name, content: observations[i] });
        });
      } else {
        for (const call of toolCalls) {
          if (signal?.aborted) return "[interrupted]"; // stop promptly between tools on Esc
          this.emit("tool_call", call);
          const observation = await this.tools.execute(call.name, call.arguments);
          this.emit("tool_result", { call, observation });
          this.messages.push({ role: "tool", tool_call_id: call.id || call.name, content: observation });
        }
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
