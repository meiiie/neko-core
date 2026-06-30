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

// Sectioned for the model to follow (Anthropic "right altitude": clear headers, smallest
// high-signal set). Every line earns its place from an observed failure — keep it tight, not bloated.
export const DEFAULT_SYSTEM_PROMPT =
  "You are Neko Code, a hands-on coding agent in a terminal. ACT by calling tools — never just describe.\n\n" +
  "## Acting\n" +
  "- create / code / build / make a file, page, app, or script -> produce the REAL artifact with tools (write_file, edit, or bash for binaries like .xlsx). Never paste full file contents as the reply, and never stop at a 'Step 1: create X' plan — the file must exist on disk. Switch to acting the moment work is asked, even mid-chat.\n" +
  "- You have full machine access via bash (git, builds, tests, system info, reading/searching anywhere). Never say you 'can't access / lack permission'. When asked whether you can do something, or to check/find/show/run it, DO it and report the real result — never print a command for the user to run yourself.\n\n" +
  "## Tools\n" +
  "read_file/search/glob/ls inspect; write_file/edit change files; bash runs shell; web_search + web_fetch reach the internet (use them — you're not offline).\n" +
  "- Prefer edit (exact, unique string replace) over rewriting whole files. read_file lines are numbered for reference only — don't put the number prefix in edits.\n" +
  "- Multi-line code (Python/Node): write it to a FILE and run that (`python build.py`). Don't pack newlines into `python -c`/`bash -c`/heredocs — they break on Windows cmd. Then verify the output file exists.\n\n" +
  "## Working\n" +
  "- Before a tool call/batch, say what you're about to do in one short, natural line in your own words — don't fire tools silently.\n" +
  "- Multi-step -> todo_write to plan + track (exactly one item in_progress).\n" +
  "- Use the `memory` tool for things worth keeping ACROSS sessions (user preferences, project facts, " +
  "hard-won learnings): recall the relevant ones (listed in context) before you work, and write/UPDATE " +
  "them as you learn — search first and edit an existing memory instead of duplicating it. Don't store " +
  "secrets or one-off chatter.\n" +
  "- Use the `workflow` tool for reusable PROCEDURES (vs `memory`'s facts): after a non-trivial task " +
  "whose approach worked, `workflow write` the steps/tools/gotchas; before redoing a similar task, " +
  "recall the matching one (listed in context) and follow it — this is how you get faster over time. " +
  "Before writing, check the list/search: UPDATE an existing close workflow instead of duplicating it.\n" +
  "- After a non-obvious or failed step, REFLECT: `playbook add` a one-line lesson (or `playbook revise` " +
  "an existing bullet to sharpen it) — your playbook is always in context, so it improves how you work.\n" +
  "- Big self-contained subtask -> delegate with task (a sub-agent returns just the result).\n" +
  "- Plan mode = read-only: research, then exit_plan_mode with a markdown plan and wait for approval.\n" +
  "- Inspect before editing; smallest change that works.\n" +
  "- VERIFY every command: after bash/tests/builds, READ the exit code and output. If it FAILED (non-zero exit) or shows an error, diagnose the cause, fix it, and re-run to confirm it passes -- never assume success or move on with a broken result.\n\n" +
  "## Accuracy\n" +
  "Time-sensitive or factual questions (today/current/latest/best/a price/who holds an office) -> your training has a CUTOFF; do NOT answer from memory. web_search, then VERIFY before answering: cross-check each key fact across >=2 independent sources; prefer primary/official/known-leaderboard sources over SEO/aggregator/content-farm pages; sanity-check recency (a 'latest/2026' source that lists clearly-old items is stale -- discard it, don't repeat it). If sources conflict or are thin, SAY SO and cite (URL + date) rather than presenting a guess as fact. For a deeper multi-angle dive, load the `deep-research` skill.\n\n" +
  "Be concise — no filler, no 'I will now...' preamble or 'let me know if...' postamble; sound like a focused senior engineer pair-programming, not a script. When done: a short summary, then stop.";

// Tools safe to run concurrently in one turn: read-only inspection + sub-agent tasks (the
// "fleet"). Mutating tools (write_file/edit/bash) are excluded so they stay ordered + gated.
const CONCURRENCY_SAFE = new Set(["read_file", "search", "glob", "ls", "web_search", "web_fetch", "task"]);

// A single tool result (a giant browser snapshot, a huge file/page read) must not push the prompt past
// the model's context window -- the server then computes a NEGATIVE max_tokens (window - prompt) and
// rejects the whole turn with HTTP 400. Cap each observation (head + tail, with a marker) so one result
// can't overflow the window. Multimodal array results (image parts) pass through untouched.
export const MAX_OBS_CHARS = 48000;
export function clampObservation(obs: string | any[]): string | any[] {
  if (typeof obs !== "string" || obs.length <= MAX_OBS_CHARS) return obs;
  const head = obs.slice(0, MAX_OBS_CHARS - 2000);
  const tail = obs.slice(-2000);
  return `${head}\n... [${obs.length - head.length - 2000} chars truncated to fit the context window] ...\n${tail}`;
}

// Rough token estimate (~4 chars/token) over the whole conversation, used to trigger IN-LOOP compaction
// before a request would overflow the window. Cheap + conservative -- exactness isn't needed for a guard.
export function estimateTokens(messages: any[]): number {
  let chars = 0;
  for (const m of messages) chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  return Math.ceil(chars / 4);
}

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
  /** Model context window (tokens). The loop compacts IN-LOOP before a request would overflow it,
   * so a single long turn (e.g. many huge browser snapshots) can't blow past the window. */
  maxContextTokens?: number;
}

export class Agent {
  private readonly provider: Provider;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly systemPrompt: string;
  private readonly onEvent?: EventHook;
  private readonly onDelta?: DeltaHook;
  private readonly dynamicContext?: () => string;
  private readonly maxContextTokens: number;
  readonly cost = new CostTracker();
  messages: any[] = [];
  /** The single system message is `<base prompt>` + DYN_MARK + `<live session context>`.
   * One system message only: some chat templates (Llama/Mistral on vLLM) suppress tool-calling
   * when a SECOND system message is present, so session context is merged in, never split out. */
  private static readonly DYN_MARK = "\n\n<session-context>\n";

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.tools = opts.tools;
    this.maxSteps = opts.maxSteps ?? 20;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.onEvent = opts.onEvent;
    this.onDelta = opts.onDelta;
    this.dynamicContext = opts.dynamicContext;
    this.maxContextTokens = opts.maxContextTokens ?? 131072;
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
    // Compaction MUST always free context. If the summarizer call fails (a transient model error),
    // fall back to a crude marker rather than leaving the oversized context in place -- otherwise the
    // next call just overflows again and the turn is stuck. The recent tail is kept verbatim regardless.
    let summary: string;
    try {
      const res = await this.provider.complete([
        { role: "system", content: "Summarize the conversation below concisely: the task, key decisions, files changed, and the current state. Be brief." },
        { role: "user", content: text },
      ]);
      this.cost.add(res.usage);
      summary = res.content ?? "";
    } catch {
      summary = "(earlier conversation elided to fit the context window; the summary call failed, but the recent turns below are intact)";
    }
    // Low-hanging context win (Anthropic): big tool outputs kept in the tail are rarely re-read in
    // full — clip them to the head, so post-compaction context stays lean.
    const leanTail = tail.map((m) => {
      if (m.role !== "tool" || typeof m.content !== "string") return m;
      const lines = m.content.split("\n");
      return lines.length > 40 ? { ...m, content: lines.slice(0, 40).join("\n") + `\n... (${lines.length - 40} more lines clipped on compaction)` } : m;
    });
    this.messages = [...sys, { role: "user", content: `[Summary of earlier conversation]\n${summary}` }, ...leanTail];
    return summary;
  }

  /** In-loop context relief for a SINGLE long turn (one user message, many tool rounds) where
   * compact()'s snap-to-user boundary can free nothing. Compress the OLDEST tool observations in
   * place -- head + a marker -- keeping the most recent ones full and never breaking tool_call/result
   * pairing. This is the "observation masking" approach SOTA long-horizon agents use. Returns true if
   * it freed anything (so the caller only falls back to a summary when there's nothing left to clip). */
  private shrinkOldObservations(): boolean {
    const CLIP = 1200, KEEP_RECENT = 3, MARK = "chars elided to fit context";
    const toolIdx = this.messages
      .map((m, i) => (m.role === "tool" && typeof m.content === "string" ? i : -1))
      .filter((i) => i >= 0);
    let shrank = false;
    for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT))) {
      const m = this.messages[i];
      if (m.content.length > CLIP + 80 && !m.content.includes(MARK)) {
        m.content = m.content.slice(0, CLIP) + `\n... [${m.content.length - CLIP} ${MARK}] ...`;
        shrank = true;
      }
    }
    return shrank;
  }

  /** Conversation undo: drop the last user turn (and the assistant response after it) from context.
   * Returns false if there's nothing to rewind. Note: this restores CONTEXT, not files on disk. */
  rewind(): boolean {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "user") {
        this.messages.splice(i);
        return true;
      }
    }
    return false;
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
          `First RE-INSPECT the ACTUAL current state (re-run the check / re-read the file / re-screenshot ` +
          `or re-read the UI) — judge what IS, not your memory of what you intended. Then compare against ` +
          `the goal and a high quality bar. If it is FULLY met, reply with exactly "DONE" and nothing else. ` +
          `Otherwise, keep working: do the next concrete step now (don't stop until the goal is achieved).`,
        opts.signal,
      );
      if (/^\s*done[.!]?\s*$/i.test(out)) break;
    }
    return out;
  }

  /** Refresh the live session context (env + project + memory + todos) held INSIDE the single base
   * system message — so a mid-session model switch or NEKO.md edit is reflected at once, without ever
   * emitting a second system message (which breaks tool-calling on some templates). */
  private refreshDynamicContext(): void {
    if (!this.dynamicContext) return;
    this.messages = this.messages.filter((m) => !m.dynamic); // migrate legacy two-system sessions
    const sys = this.messages.find((m) => m.role === "system");
    if (!sys || typeof sys.content !== "string") return;
    const base = sys.content.split(Agent.DYN_MARK)[0];
    const text = this.dynamicContext();
    sys.content = text ? `${base}${Agent.DYN_MARK}${text}` : base;
  }

  /** Replace the base system message with the current systemPrompt — so prompt improvements apply
   * to a RESUMED session (whose saved messages bake in whatever prompt was current when it ran). */
  refreshSystemPrompt(): void {
    const sys = this.messages.find((m) => m.role === "system");
    if (!sys || typeof sys.content !== "string") return;
    const dyn = sys.content.split(Agent.DYN_MARK)[1]; // preserve any live session-context tail
    sys.content = this.systemPrompt + (dyn !== undefined ? Agent.DYN_MARK + dyn : "");
  }

  /** Append text to the base system prompt (used by /skill). Inserted before the live session-context
   * tail so the next refresh doesn't strip it. Seeds the base prompt if there's no system message. */
  appendSystem(text: string): void {
    const sys = this.messages.find((m) => m.role === "system");
    if (!sys || typeof sys.content !== "string") {
      this.messages.unshift({ role: "system", content: this.systemPrompt + "\n\n" + text });
      return;
    }
    const [base, dyn] = sys.content.split(Agent.DYN_MARK);
    sys.content = `${base}\n\n${text}` + (dyn !== undefined ? Agent.DYN_MARK + dyn : "");
  }

  /** Execute a tool but NEVER throw: a malformed/failed tool call (e.g. a model emitting web_fetch with no
   * `url`, or any executor that throws) becomes an error OBSERVATION the model can recover from, instead of
   * rejecting the whole turn. The loop is built on "feed errors back so the model adapts" — this enforces it
   * for every tool, not just the ones already wrapped inside execute(). */
  private async safeExecute(call: { name: string; arguments: Record<string, any> }, signal?: AbortSignal): Promise<string | any[]> {
    try {
      return await this.tools.execute(call.name, call.arguments, signal);
    } catch (error) {
      return `Error running ${call.name}: ${error instanceof Error ? error.message : String(error)}`;
    }
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

    let lastSig = ""; // loop guard: detect the model repeating the same tool call (a stuck loop)
    let repeats = 0;
    for (let step = 0; step < this.maxSteps; step++) {
      this.emit("step", step + 1);
      if (signal?.aborted) return "[interrupted]";
      // In-loop overflow guard: within ONE turn (e.g. many huge browser snapshots) context can grow
      // past the window with no chance for the between-turn UI compaction to run. Compact here BEFORE a
      // request would overflow -- otherwise the server computes a negative max_tokens and 400s the turn.
      if (estimateTokens(this.messages) > 0.8 * this.maxContextTokens) {
        this.emit("compact", "auto");
        // One long turn has a single user message, so compact()'s snap-to-user boundary frees nothing;
        // clip the oldest observations in place first, and only summarize if that found nothing to clip.
        if (!this.shrinkOldObservations()) await this.compact();
      }
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
        lastSig = ""; // a parallel fan-out breaks any single-call repeat chain
        toolCalls.forEach((call) => this.emit("tool_call", call));
        const observations = await Promise.all(toolCalls.map((call) => this.safeExecute(call, signal)));
        toolCalls.forEach((call, i) => {
          this.emit("tool_result", { call, observation: observations[i] });
          this.messages.push({ role: "tool", tool_call_id: call.id || call.name, content: clampObservation(observations[i]) });
        });
      } else {
        for (const call of toolCalls) {
          if (signal?.aborted) return "[interrupted]"; // stop promptly between tools on Esc
          this.emit("tool_call", call);
          // Loop guard: if the model makes the SAME call 3x in a row, it's stuck — nudge instead of
          // re-running it, so it changes approach or finishes (prevents lag/chaos/spinning).
          const sig = `${call.name}:${JSON.stringify(call.arguments ?? {})}`;
          repeats = sig === lastSig ? repeats + 1 : 0;
          lastSig = sig;
          const observation = repeats >= 2
            ? "[loop guard] You already made this exact tool call 3 times with the same result. Stop repeating it: try a different approach/tool, or give your final answer now."
            : await this.safeExecute(call, signal);
          this.emit("tool_result", { call, observation });
          this.messages.push({ role: "tool", tool_call_id: call.id || call.name, content: clampObservation(observation) });
        }
      }
    }

    // Step limit reached: instead of an abrupt stop, ask for one tool-less wrap-up so the user gets
    // a useful summary of what was done and what remains (don't leave the task half-narrated).
    this.emit("max_steps", this.maxSteps);
    try {
      const wrap = await this.provider.complete(
        [...this.messages, { role: "user", content: `Step limit (${this.maxSteps}) reached. Stop calling tools and concisely summarize what you did and what's left.` }],
        undefined,
        this.onDelta,
        signal,
      );
      this.cost.add(wrap.usage); // the wrap-up call costs tokens too — count it
      const final = wrap.content?.trim() || `[stopped: reached max_steps=${this.maxSteps}]`;
      this.messages.push({ role: "assistant", content: final });
      this.emit("final", final);
      return final;
    } catch {
      return `[stopped: reached max_steps=${this.maxSteps}]`;
    }
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
