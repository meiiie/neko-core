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
import { CostTracker, type Usage } from "./cost.ts";
import type { DeltaHook, Provider, ToolCall } from "./ports.ts";
import { todosContextBlock, type ToolRegistry } from "./tool-runtime.ts";
import { taskDelegatesReadOnly } from "./tools.ts";
import { hasAuthoritativeValidatorExit, isValidationBashCommand } from "./validation-command.ts";
import {
  DEFAULT_SYSTEM_PROMPT,
  COMPACTION_PROMPT,
  CONCURRENCY_SAFE,
  EAGER_SAFE,
  EDIT_TOOLS,
  MUTATING_TOOLS,
  EDIT_PER_PATH_CAP,
  UNPRODUCTIVE_CAP,
  TOOLCHAIN_FAILURE_CAP,
  MAX_OBS_CHARS,
  LEAN_TAIL_CHARS,
  COMPACT_AT,
  COMPACT_SAFETY_AT,
  clampObservation,
  estimateRequestTokens,
  estimateTokens,
  SESSION_CONTEXT_MARK,
  type EventHook,
  type AgentOptions,
} from "./agent-constants.ts";

export {
  DEFAULT_SYSTEM_PROMPT,
  COMPACTION_PROMPT,
  MAX_OBS_CHARS,
  LEAN_TAIL_CHARS,
  COMPACT_AT,
  COMPACT_SAFETY_AT,
  clampObservation,
  estimateRequestTokens,
  estimateTokens,
};
export { isValidationBashCommand } from "./validation-command.ts";
export type { EventHook, AgentOptions };

/** Controller turns saved before `_neko_internal` existed. An explicit marker always wins, so a
 * current user can still begin a real message with one of these strings without being hidden. */
const LEGACY_INTERNAL_USER_PREFIXES = [
  "[Summary of earlier conversation]",
  "CLOSED-LOOP REVIEW (",
  "PLAN NOT COMPLETE:",
  "VALIDATION FAILED:",
  "VALIDATION REQUIRED:",
  "OUTCOME VERIFICATION REQUIRED:",
  "NO VERIFICATION EVIDENCE YET:",
  "VERIFY BEFORE FINISHING:",
  "[budget]",
  "Step limit (",
  "Continue the task from where it was interrupted.",
];

function isInternalUserMessage(message: any): boolean {
  if (message?._neko_internal === true) return true;
  if (message?._neko_internal === false || message?.role !== "user" || typeof message.content !== "string") return false;
  const content = message.content.trimStart();
  return LEGACY_INTERNAL_USER_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/** Neko-local durability metadata belongs in the session file, never an LLM wire payload. */
function cleanProviderMessages(messages: any[]): any[] {
  return messages.map((message) => {
    const clean = { ...message };
    delete clean._neko_internal;
    delete clean._neko_inflight;
    delete clean._neko_acp_message_id;
    return clean;
  });
}

/** Give every old message a fair share of the summarizer input. This prevents one giant early tool
 * result from consuming the fixed budget and erasing later corrections/decisions. Keep both ends
 * because errors and totals often land at the bottom of logs. */
function compactionSource(messages: any[], budget = 40_000): string {
  const perMessage = Math.max(120, Math.floor((budget - 2000) / Math.max(1, messages.length)) - 50);
  const clip = (raw: string, limit: number) => {
    if (raw.length <= limit) return raw;
    const tail = Math.max(120, Math.floor(limit * 0.35));
    const omitted = raw.length - limit;
    return `${raw.slice(0, limit - tail)}\n... [${omitted} chars omitted for compaction] ...\n${raw.slice(-tail)}`;
  };
  const source = messages.map((message) => {
    const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const roleCap = message.role === "tool" ? 1200 : 3000;
    return `${message.role}: ${clip(raw, Math.min(roleCap, perMessage))}`;
  }).join("\n");
  if (source.length <= budget) return source;
  const first = 4000;
  return `${source.slice(0, first)}\n... [middle omitted for compaction budget] ...\n${source.slice(-(budget - first - 60))}`;
}

export interface NumberedImageAttachment { id: number; url: string }
export type ImageAttachment = string | NumberedImageAttachment;

export interface AgentCompletionStatus {
  ok: boolean;
  reason?: "validation_failed" | "validation_missing";
  command?: string;
  detail?: string;
}

export type ToolObservationClass = "productive" | "empty" | "failed";

/** Classify a tool observation without retaining its payload. This is shared by the loop guards and
 * benchmark telemetry so an eval cannot report a failed/empty call as productive. */
export function classifyToolObservation(obs: unknown): ToolObservationClass {
  if (typeof obs !== "string") return "productive";
  if (/\(exit \d+ -- command FAILED\)/.test(obs)
    || /^\(timed out/.test(obs)
    || /^(?:Error(?: running [^:]+)?:|Blocked(?::| by)|Denied by user:|Refused:|The user did NOT approve\b|Tool '[^']+' is (?:disabled|not available)|Sub-agents? (?:are|is) not available\b|Sub-agent error:|\[denied\]|\[capability circuit\]|\[loop guard\]|\(interrupted\))/mi.test(obs)) {
    return "failed";
  }
  const match = obs.match(/###\s*Result\s*\r?\n([\s\S]*?)(?:\r?\n###|$)/i);
  const value = (match ? match[1] : obs).trim();
  return value === "" || value === "[]" || value === "{}" || value === "null"
    || value === "undefined" || value === '""' || value === "0"
    || value === "(no matches)" || value === "(no files)" || value === "(empty)"
    ? "empty"
    : "productive";
}

/** Build one multimodal user turn without losing the semantic position of numbered pasted images.
 * Plain string attachments are CLI `--image` inputs and keep the legacy text-then-images layout. */
export function imageContent(instruction: string, images: ImageAttachment[]): any[] {
  const numbered = new Map<number, NumberedImageAttachment>();
  for (const image of images) if (typeof image !== "string") numbered.set(image.id, image);
  const used = new Set<number>();
  const parts: any[] = [];
  let cursor = 0;
  for (const match of instruction.matchAll(/\[Image #(\d+)\]/g)) {
    const id = Number(match[1]);
    const image = numbered.get(id);
    if (!image || used.has(id) || match.index === undefined) continue;
    const end = match.index + match[0].length;
    parts.push({ type: "text", text: instruction.slice(cursor, end) });
    parts.push({ type: "image_url", image_url: { url: image.url } });
    cursor = end;
    used.add(id);
  }
  const tail = instruction.slice(cursor);
  if (tail || !parts.length) parts.push({ type: "text", text: tail });
  for (const image of images) {
    if (typeof image === "string") parts.push({ type: "image_url", image_url: { url: image } });
    else if (!used.has(image.id)) parts.push({ type: "image_url", image_url: { url: image.url } });
  }
  return parts;
}

export class Agent {
  private provider: Provider; // swappable between turns so the REPL can switch providers live (see setProvider)
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly systemPrompt: string;
  private readonly onEvent?: EventHook;
  private readonly onCheckpoint?: () => void | Promise<void>;
  private checkpointFailure: unknown;
  private hasCheckpointFailure = false;
  private readonly onDelta?: DeltaHook;
  private readonly dynamicContext?: () => string;
  private maxContextTokens: number;
  private readonly verifyBeforeExit: boolean;
  private readonly verifyStateChangesBeforeExit: boolean;
  private readonly adaptiveEffort: boolean;
  /** Host-owned instructions for the active outer turn. They are projected onto provider requests,
   * never written into `messages`, so automatic skill/workflow routing cannot leak into a later turn
   * or a saved session. `runUntilDone` keeps the same projection across its internal review passes. */
  private turnSystemContext = "";
  readonly cost = new CostTracker();
  messages: any[] = [];
  /** The single system message is `<base prompt>` + SESSION_CONTEXT_MARK + `<live session context>`.
   * One system message only: some chat templates (Llama/Mistral on vLLM) suppress tool-calling
   * when a SECOND system message is present, so session context is merged in, never split out. */
    // BROAD doom-loop state (distinct from the per-step exact-repeat `lastSig`/`repeats` guard):
    // (a) edits-per-path: the agent often loops editing ONE file with DIFFERENT args chasing a build
    //     error -- the exact-repeat guard never trips because every sig differs. Track per-path count
    //     and nudge once the cap is hit. (b) consecutive failing bash runs: re-running a failing
    //     command 3x with tiny tweaks is the other classic budget sink.
    private readonly editsPerPath = new Map<string, number>();
  private consecutiveUnproductive = 0;
  /** Validation debt belongs to one OUTER user goal. `runUntilDone` controller reviews use
   * `internal=true`, so they deliberately share this state until a validator passes after the latest
   * successful mutation. Ordinary later user turns reset it. */
  private mutationEpoch = 0;
  private validationExpected = false;
  private validationResult?: { epoch: number; command: string; ok: boolean; authoritative: boolean; detail?: string };

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.tools = opts.tools;
    this.maxSteps = opts.maxSteps ?? 20;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.onEvent = opts.onEvent;
    this.onCheckpoint = opts.onCheckpoint;
    this.onDelta = opts.onDelta;
    this.dynamicContext = opts.dynamicContext;
    this.maxContextTokens = opts.maxContextTokens ?? 131072;
    this.verifyBeforeExit = Boolean(opts.verifyBeforeExit);
    this.verifyStateChangesBeforeExit = Boolean(opts.verifyStateChangesBeforeExit);
    this.adaptiveEffort = Boolean(opts.adaptiveEffort);
  }

  /** Deterministic controller verdict for automation. It says only whether known validation debt is
   * resolved; it never pretends to judge the semantic quality of the model's prose. */
  get completionStatus(): AgentCompletionStatus {
    if (!this.validationExpected || this.mutationEpoch === 0) return { ok: true };
    const current = this.validationResult?.epoch === this.mutationEpoch ? this.validationResult : undefined;
    if (current?.ok) return { ok: true };
    if (current?.authoritative) {
      return {
        ok: false,
        reason: "validation_failed",
        command: current.command,
        ...(current.detail ? { detail: current.detail } : undefined),
      };
    }
    return {
      ok: false,
      reason: "validation_missing",
      ...(this.validationResult?.command ? { command: this.validationResult.command } : undefined),
      ...(this.validationResult?.detail ? { detail: this.validationResult.detail } : undefined),
    };
  }

  /** Swap the LLM provider live (used by the REPL's /provider command to switch endpoint+key between turns,
   * no restart). Safe because commands run between turns, never mid-complete(). */
  /** The live provider. Exposed so a side-channel look (the live camera coach) can reuse the WARM
   * connection instead of standing up a second one per glance. */
  currentProvider(): Provider { return this.provider; }

  setProvider(provider: Provider): void {
    const previous = this.provider;
    this.provider = provider;
    try {
      const disposed = previous.dispose?.();
      if (disposed && typeof (disposed as Promise<void>).catch === "function") void (disposed as Promise<void>).catch(() => {});
    } catch { /* provider cleanup must not block a live account switch */ }
  }

  /** Keep overflow/compaction guards accurate after a live /model or /provider switch. */
  setMaxContextTokens(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.maxContextTokens = tokens;
  }

  /** App-owned model sessions (for example realtime voice) use the exact same tool boundary as a
   * normal Agent turn. Keeping this wrapper here prevents an adapter from bypassing approvals. */
  externalToolSchemas(): any[] {
    return this.tools.schemas();
  }

  async executeExternalTool(
    call: { id?: string; name: string; arguments: Record<string, any> },
    signal?: AbortSignal,
  ): Promise<string | any[]> {
    this.emit("tool_call", call);
    const observation = await this.safeExecute(call, signal);
    this.emit("tool_result", { call, observation });
    return observation;
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

    const text = compactionSource(head);
    // Compaction MUST always free context. If the summarizer call fails (a transient model error),
    // fall back to a crude marker rather than leaving the oversized context in place -- otherwise the
    // next call just overflows again and the turn is stuck. The recent tail is kept verbatim regardless.
    let summary: string;
    try {
      const res = await this.provider.complete(cleanProviderMessages([
        { role: "system", content: COMPACTION_PROMPT },
        { role: "user", content: text, _neko_internal: true },
      ]));
      this.cost.add(res.usage);
      summary = res.content ?? "";
    } catch {
      summary = "(earlier conversation elided to fit the context window; the summary call failed, but the recent turns below are intact)";
    }
      // Low-hanging context win (Anthropic): big tool outputs kept in the tail are rarely re-read in
      // full — clip them to the head, so post-compaction context stays lean. Clip by LINE count for
      // normal structured output, AND by total CHAR count for dense few-line output (minified JSON,
      // base64, packed log lines) which is long in chars yet short in lines and would otherwise slip
      // through unclipped, freeing no context.
      const leanTail = tail.map((m) => {
        if (m.role !== "tool" || typeof m.content !== "string") return m;
        const lines = m.content.split("\n");
        if (lines.length > 40) return { ...m, content: lines.slice(0, 40).join("\n") + `\n... (${lines.length - 40} more lines clipped on compaction)` };
        if (m.content.length > LEAN_TAIL_CHARS) {
          const head = m.content.slice(0, LEAN_TAIL_CHARS);
          return { ...m, content: head + `\n... (${m.content.length - LEAN_TAIL_CHARS} more chars clipped on compaction)` };
        }
        return m;
      });
    // The ORIGINAL instruction must survive every prune VERBATIM - summarizers compress away the one
    // thing the whole run is anchored to (instruction fade-out / Governance Decay, arXiv 2606.22528,
    // 2603.05344). Deterministic code, not a summarizer promise: when the first user turn is in the
    // summarized head, carry its text (clipped) ahead of the model summary.
    const firstUser = head.find((m) => m.role === "user");
    const task = typeof firstUser?.content === "string" ? firstUser.content.slice(0, 600) : "";
    const plan = todosContextBlock(this.tools.todos);
    this.messages = [
      ...sys,
      { role: "user", content: `[Summary of earlier conversation]\n${task ? `ORIGINAL TASK (verbatim): ${task}\n\n` : ""}${plan ? `${plan}\n\n` : ""}${summary}`, _neko_internal: true },
      ...leanTail,
    ];
    return summary;
  }

  /** In-loop context relief for a SINGLE long turn (one user message, many tool rounds) where
   * compact()'s snap-to-user boundary can free nothing. Compress the OLDEST tool observations in
   * place -- head + a marker -- keeping the most recent ones full and never breaking tool_call/result
   * pairing. This is the "observation masking" approach SOTA long-horizon agents use. Returns true if
   * it freed anything (so the caller only falls back to a summary when there's nothing left to clip). */
  private shrinkOldObservations(keepRecent = 3, minSavingsChars = 0): boolean {
    const CLIP = 1200, MARK = "chars elided to fit context";
    // A GUI loop can produce several base64 screenshots inside one user turn. Summarizing cannot help
    // that shape (there is no older user-turn boundary), so keep the two most recent visual states and
    // mask older tool images before clipping text. Two supports before/after comparison while bounding
    // both request size and local session growth.
    const imageIdx = this.messages
      .map((m, i) => (m.role === "tool" && Array.isArray(m.content) && m.content.some((p: any) => p?.type === "image_url") ? i : -1))
      .filter((i) => i >= 0);
    const oldImageIdx = imageIdx.slice(0, Math.max(0, imageIdx.length - 2));
    const lastUser = this.messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
    const oldUserImageIdx = this.messages
      .map((m, i) => (m.role === "user" && i !== lastUser && Array.isArray(m.content) && m.content.some((p: any) => p?.type === "image_url") ? i : -1))
      .filter((i) => i >= 0);
    const toolIdx = this.messages
      .map((m, i) => (m.role === "tool" && typeof m.content === "string" ? i : -1))
      .filter((i) => i >= 0);
    const oldTextIdx = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent))
      .filter((i) => this.messages[i].content.length > CLIP + 80 && !this.messages[i].content.includes(MARK));
    const imageSavings = [...oldImageIdx, ...oldUserImageIdx]
      .reduce((sum, i) => sum + JSON.stringify(this.messages[i].content).length, 0);
    const textSavings = oldTextIdx.reduce((sum, i) => sum + Math.max(0, this.messages[i].content.length - CLIP), 0);
    // Context editing invalidates a cached prefix. Only do the proactive pass when it removes a
    // meaningful chunk; the emergency overflow path passes zero and always frees whatever it can.
    if (imageSavings + textSavings < minSavingsChars) return false;

    let shrank = false;
    for (const i of oldImageIdx) {
      const m = this.messages[i];
      m.content = m.content.map((p: any) => p?.type === "image_url"
        ? { type: "text", text: "[older tool image elided; capture/read it again if the current state is insufficient]" }
        : p);
      shrank = true;
    }
    // USER-attached images from EARLIER turns are maskable too. They used to be untouchable, which
    // created a death spiral: one oversized pasted image overflowed the window, the 400'd request left
    // the image in history, and every later turn re-sent it and 400'd forever - nothing could free it.
    // The CURRENT user turn's attachment is preserved (the model must get one full look at it).
    for (const i of oldUserImageIdx) {
      const m = this.messages[i];
      m.content = m.content.map((p: any) => p?.type === "image_url"
        ? { type: "text", text: "[pasted image from an earlier turn elided to fit the context window - attach it again if still needed]" }
        : p);
      shrank = true;
    }
    for (const i of oldTextIdx) {
      const m = this.messages[i];
      m.content = m.content.slice(0, CLIP) + `\n... [${m.content.length - CLIP} ${MARK}] ...`;
      shrank = true;
    }
    return shrank;
  }

  /** The latest real human turn. Controller prompts are skipped; old sessions use prefix fallback. */
  lastUserMessage(): any | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (message?.role === "user" && !isInternalUserMessage(message)) return message;
    }
    return undefined;
  }

  /** A provider-safe history projection. Local durability/control markers remain in `messages`. */
  providerHistory(): any[] {
    const clean = cleanProviderMessages(this.messages);
    if (!this.turnSystemContext) return clean;
    const system = clean.find((message) => message?.role === "system" && typeof message.content === "string");
    if (system) system.content = `${system.content}\n\n${this.turnSystemContext}`;
    return clean;
  }

  /** Replace the provider-only system tail for one outer host turn. Automatic routing uses this;
   * manual `/skill` continues to call appendSystem() and therefore remains deliberately persistent. */
  setTurnSystemContext(text: string): void {
    this.turnSystemContext = String(text ?? "").trim();
  }

  /** End the outer host turn. Refresh after the host closes its tool lease so the durable system
   * message is recomputed from the ordinary configured surface before the session is persisted. */
  clearTurnSystemContext(): void {
    this.turnSystemContext = "";
    this.refreshDynamicContext();
  }

  /** Conversation undo: drop the last human user turn (and every response/controller turn after it).
   * Returns false if there's nothing to rewind. Note: this restores CONTEXT, not files on disk. */
  rewind(): boolean {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "user" && !isInternalUserMessage(this.messages[i])) {
        this.messages.splice(i);
        return true;
      }
    }
    return false;
  }

  /** Closed-loop runner (agent-looping, "closed" variant): do the goal, then self-review against
   * a high bar and fix gaps, repeating until the model replies DONE or maxIters is hit. A provider
   * inactivity timeout resumes from the durable trajectory with bounded retries; this is not a total
   * wall-clock deadline, and an explicit user abort is never retried. */
  async runUntilDone(
    goal: string,
    opts: { maxIters?: number; signal?: AbortSignal; maxStallRecoveries?: number } = {},
  ): Promise<string> {
    const maxIters = Math.max(1, Math.min(opts.maxIters ?? 6, 20));
    const maxStallRecoveries = Math.max(0, Math.min(opts.maxStallRecoveries ?? 2, 5));
    let stallRecoveries = 0;
    const runResumable = async (instruction: string, internal = false): Promise<string> => {
      let next = instruction;
      let nextInternal = internal;
      while (true) {
        try { return await this.run(next, opts.signal, undefined, nextInternal); }
        catch (error) {
          if (opts.signal?.aborted || !isRecoverableProviderStall(error) || stallRecoveries >= maxStallRecoveries) throw error;
          stallRecoveries++;
          this.emit("recovery", { attempt: stallRecoveries, max: maxStallRecoveries, reason: "provider idle timeout" });
          next = `AUTONOMY RECOVERY (${stallRecoveries}/${maxStallRecoveries}). Goal: "${goal}". ` +
            "The provider stopped making progress and Neko restarted its transport. Resume from the durable " +
            "conversation/tool checkpoint. Inspect actual state before repeating any mutation, continue the " +
            "next concrete step, and verify the final result.";
          nextInternal = true;
        }
      }
    };
    let out = await runResumable(goal);
    for (let i = 1; i < maxIters; i++) {
      if (opts.signal?.aborted || out === "[interrupted]") return out;
      out = await runResumable(
        `CLOSED-LOOP REVIEW (pass ${i + 1}/${maxIters}). Goal: "${goal}".\n` +
          `First RE-INSPECT the ACTUAL current state (re-run the check / re-read the file / re-screenshot ` +
          `or re-read the UI) — judge what IS, not your memory of what you intended. Then compare against ` +
          `the supplied source/docs and observable runtime output or side effects; use independent evidence, ` +
          `not only the same happy-path check you authored. Run available repository tests from a clean state, ` +
          `then remove disposable validation artifacts while preserving intended deliverables. If the deliverable ` +
          `is a program, an output recreated by a clean run is disposable even when the goal names its path. Compare against ` +
          `the goal and a high quality bar. If it is FULLY met, reply with exactly "DONE" and nothing else. ` +
          `Otherwise, keep working: do the next concrete step now (don't stop until the goal is achieved).`,
        true,
      );
      // A model word is not stronger than controller-observed evidence. Validation debt survives
      // these internal reviews, so bare DONE cannot turn a failed/unavailable test into exit success.
      if (/^\s*done[.!]?\s*$/i.test(out) && this.completionStatus.ok) break;
    }
    return out;
  }

  /** Refresh the live session context (env + project + memory) held INSIDE the single base
   * system message — so a mid-session model switch or NEKO.md edit is reflected at once, without ever
   * emitting a second system message (which breaks tool-calling on some templates). */
  private refreshDynamicContext(): void {
    if (!this.dynamicContext) return;
    this.messages = this.messages.filter((m) => !m.dynamic); // migrate legacy two-system sessions
    const sys = this.messages.find((m) => m.role === "system");
    if (!sys || typeof sys.content !== "string") return;
    const base = sys.content.split(SESSION_CONTEXT_MARK)[0];
    const text = this.dynamicContext();
    sys.content = text ? `${base}${SESSION_CONTEXT_MARK}${text}` : base;
  }

  /** Replace the base system message with the current systemPrompt — so prompt improvements apply
   * to a RESUMED session (whose saved messages bake in whatever prompt was current when it ran). */
  refreshSystemPrompt(): void {
    const sys = this.messages.find((m) => m.role === "system");
    if (!sys || typeof sys.content !== "string") return;
    const dyn = sys.content.split(SESSION_CONTEXT_MARK)[1]; // preserve any live session-context tail
    sys.content = this.systemPrompt + (dyn !== undefined ? SESSION_CONTEXT_MARK + dyn : "");
  }

  /** Append text to the base system prompt (used by /skill). Inserted before the live session-context
   * tail so the next refresh doesn't strip it. Seeds the base prompt if there's no system message. */
  appendSystem(text: string): void {
    const sys = this.messages.find((m) => m.role === "system");
    if (!sys || typeof sys.content !== "string") {
      this.messages.unshift({ role: "system", content: this.systemPrompt + "\n\n" + text });
      return;
    }
    const [base, dyn] = sys.content.split(SESSION_CONTEXT_MARK);
    sys.content = `${base}\n\n${text}` + (dyn !== undefined ? SESSION_CONTEXT_MARK + dyn : "");
  }

    /** Execute a tool but NEVER throw: a malformed/failed tool call (e.g. a model emitting web_fetch with no
     * `url`, or any executor that throws) becomes an error OBSERVATION the model can recover from, instead of
     * rejecting the whole turn. The loop is built on "feed errors back so the model adapts" — this enforces it
     * for every tool, not just the ones already wrapped inside execute(). */
    private async safeExecute(call: { name: string; arguments: Record<string, any> }, signal?: AbortSignal): Promise<string | any[]> {
      const args = unwrapToolArgs(call.arguments); // tolerate _raw / JSON-string arg wrappers from some models
      // Pre-flight argument validation (Gecko, arXiv 2602.19218): a call missing a REQUIRED key
      // would execute, throw, and burn the round-trip on a vague error - catch it BEFORE execution
      // and feed back the schema hint so the model self-repairs in one step. Presence-only (null/
      // undefined), never type pedantry: nothing that executes today is rejected, and an unknown
      // schema (e.g. an unloaded MCP tool) fails open to the executor's own checks.
      const spec = this.tools.schemas().find((s: any) => s.function?.name === call.name)?.function?.parameters;
      const missing = (spec?.required ?? []).filter((k: string) => args?.[k] == null);
      if (missing.length) {
        const hint = missing
          .map((k: string) => `'${k}' (${spec.properties?.[k]?.type ?? "value"}${spec.properties?.[k]?.description ? ` - ${String(spec.properties[k].description).slice(0, 80)}` : ""})`)
          .join(", ");
        return `Error: argument validation failed for ${call.name} - missing required ${hint}. Re-emit the call with the missing argument(s) filled in.`;
      }
      try {
        return await this.tools.execute(call.name, args, signal);
      } catch (error) {
        return `Error running ${call.name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    /** The BROAD doom-loop guard (distinct from the exact-repeat `lastSig` guard). Catches the two loops the
     * exact guard structurally cannot: (1) editing the SAME path with DIFFERENT args N times (every sig
     * differs, so the exact guard never trips), and (2) re-running a failing bash command N times with tiny
     * tweaks. Returns a ONE-TIME nudge string when the per-path edit cap is first reached (the caller runs
     * the edit anyway and APPENDS this as a warning — it never blocks a legit edit), else null. */
    private broadLoopNudge(call: { name: string; arguments: Record<string, any> }): string | null {
      if (EDIT_TOOLS.has(call.name)) {
        const p = String(call.arguments?.path ?? "");
        if (p) {
          const n = (this.editsPerPath.get(p) ?? 0) + 1;
          this.editsPerPath.set(p, n);
          if (n === EDIT_PER_PATH_CAP) { // fire ONCE at the cap, not on every later edit
            return `[loop guard] You've edited "${p}" ${n} times this run and it's still not right. ` +
              "Stop micro-editing the same file: step back, re-read the actual current state, reconsider your " +
              "approach (is the root cause elsewhere?), then act — or give your final answer.";
          }
        }
      }
      return null;
    }

    /** A bash/test result "failed" if it carries a non-zero exit tag (see tool-runtime.ts: `(exit N -- command FAILED)`),
     * a timeout, or an explicit error. Used to count CONSECUTIVE failing runs for the broad guard. */
    private static isFailedRunResult(obs: unknown): boolean {
      return classifyToolObservation(obs) === "failed";
    }

    /** A tool result that moved NOTHING forward: a failed run, or an EMPTY value ([], {}, "", null, 0). Empty
     * results back-to-back are the signature of a doom-loop of selector probes on an obfuscated page (e.g. a
     * Facebook feed) - the exact-repeat guard misses it because every selector differs. Handles the MCP
     * "### Result\n[]" wrapper as well as a bare value. */
    private static isUnproductiveResult(obs: unknown): boolean {
      return classifyToolObservation(obs) !== "productive";
    }

    private static isToolchainCommand(call: { name: string; arguments?: Record<string, any> }): boolean {
      if (call.name.toLowerCase() !== "bash") return false;
      return /\b(?:bun|node|npm|npx|pnpm|yarn|deno)(?:\.exe)?\b/i.test(String(call.arguments?.command ?? ""));
    }

    private static isToolchainCapabilityFailure(
      call: { name: string; arguments?: Record<string, any> },
      observation: unknown,
    ): boolean {
      if (!Agent.isToolchainCommand(call) || typeof observation !== "string" || !Agent.isFailedRunResult(observation)) return false;
      return /(command not found|not recognized as|no such file|cannot find|permission denied|access is denied|operation not permitted|network (?:is )?(?:blocked|denied)|\b403\b)/i
        .test(observation);
    }

    private static isStateChangingCall(call: { name: string; arguments?: Record<string, any> }): boolean {
      const name = call.name.toLowerCase();
      if (name === "task") return !taskDelegatesReadOnly(call.arguments);
      if (name === "bash") return !Agent.isClearlyReadOnlyBash(call.arguments);
      if (MUTATING_TOOLS.has(name)) return true;
      // Meeting capture is an adapter-owned state machine. Keep the core free of adapter
      // dependencies, but classify its public contract explicitly so start/stop/transcribe/delete
      // cannot be declared complete from their action response alone. A fresh bounded inspect is
      // the independent evidence. Emergency stop remains permission-safe even though it changes
      // state: reducing access must never be approval-blocked.
      if (/^mcp__neko_meeting__(?:start|stop|transcribe|delete)$/.test(name)) return true;
      if (name === "computer") {
        return !new Set(["list", "read", "get", "watch", "wait", "screenshot", "display"]).has(String(call.arguments?.action ?? "").toLowerCase());
      }
      // MCP browser adapters are outside core's static registry. Their read-only snapshot/content
      // tools deliberately do not match these common state-changing suffixes.
      return /(?:^|__)(?:(?:browser_)?(?:click|type|fill|press_key|select_option|drag|upload_file|navigate|go_back|close|evaluate|run_code)|apply|render)$/.test(name);
    }

    /** Fail-closed shell effect classifier used only by the completion verifier. It does not change
     * approvals or execution. A tiny whitelist avoids charging an extra model round for commands such
     * as `echo ok`; any shell composition, substitution, redirection, backgrounding, or unknown command
     * remains state-changing because it may alter files/processes or user-visible state. */
    private static isClearlyReadOnlyBash(args?: Record<string, any>): boolean {
      if (args?.run_in_background === true) return false;
      const command = String(args?.command ?? "").trim();
      if (!command || /[\r\n;&|<>`()]/.test(command) || /\$\(|@\(/.test(command)) return false;
      const words = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
      const executable = String(words[0] ?? "").toLowerCase();
      if (new Set([
        ":", "echo", "printf", "pwd", "whoami", "hostname", "uname", "date", "true", "false",
        "ls", "dir", "cat", "head", "tail", "wc", "stat", "file", "readlink", "realpath",
        "rg", "grep",
      ]).has(executable)) return true;
      if (executable !== "git") return false;
      const subcommand = String(words[1] ?? "").toLowerCase();
      return new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "grep", "describe"]).has(subcommand);
    }

    private isMechanicalReadCall(call: { name: string; arguments?: Record<string, any> }): boolean {
      const name = call.name.toLowerCase();
      if (name === "bash") return Agent.isClearlyReadOnlyBash(call.arguments);
      if (new Set(["read_file", "search", "glob", "ls", "disk_cleanup_scan", "web_search", "web_fetch", "mcp_load"]).has(name)) return true;
      if (name === "computer") {
        return new Set(["list", "read", "get", "display", "watch", "wait", "screenshot"]).has(String(call.arguments?.action ?? "").toLowerCase());
      }
      return this.tools.mcp?.permission?.(name) === "safe";
    }

    /** Waiting for the next event is intentionally repeatable: equal arguments observe a different time
     * interval. The ordinary exact-call guard still protects every non-temporal tool. */
    private isRepeatableWaitCall(call: { name: string; arguments?: Record<string, any> }): boolean {
      const name = call.name.toLowerCase();
      if (name === "computer") {
        return new Set(["watch", "wait"]).has(String(call.arguments?.action ?? "").toLowerCase());
      }
      return this.tools.mcp?.permission?.(name) === "safe" && this.tools.mcp.temporal?.(name) === true;
    }

    private static isVerificationEvidenceCall(call: { name: string; arguments?: Record<string, any> }, observation: unknown): boolean {
      if ((typeof observation === "string" && Agent.isUnproductiveResult(observation)) || observation == null) return false;
      const name = call.name.toLowerCase();
      if (name === "computer") {
        return new Set(["list", "read", "get", "watch", "screenshot", "display"]).has(String(call.arguments?.action ?? "").toLowerCase());
      }
      if (EDIT_TOOLS.has(name) || Agent.isStateChangingCall(call)) return name === "bash";
      return !new Set(["todo_write", "skill", "memory", "workflow", "playbook"]).has(name);
    }

  /** Seal any tool_call left UNANSWERED by an interrupted turn (Esc/abort can stop the loop right after
   * the model emitted tool_calls, before their results are appended). A resumed session with a dangling
   * tool_call makes the provider reject the very next request ("tool_use with no tool_result"), which
   * looked like a broken/lost session. Add a synthetic result for each missing call so the trajectory
   * stays valid. Only the most-recent assistant tool-call batch can dangle. */
  sealDanglingToolCalls(): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "user") return; // a later user turn means earlier calls were all answered
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const answered = new Set<string>();
        let insertAt = i + 1;
        for (let j = i + 1; j < this.messages.length; j++) {
          if (this.messages[j].role === "tool") { answered.add(this.messages[j].tool_call_id); insertAt = j + 1; }
          else break; // tool results directly follow their assistant message
        }
        const missing = m.tool_calls.filter((tc: any) => !answered.has(tc.id || tc.function?.name));
        if (missing.length) {
          const synthetic = missing.map((tc: any) => ({
            role: "tool",
            tool_call_id: tc.id || tc.function?.name,
            content: "[interrupted while this tool call was in flight; outcome unknown. Inspect actual state before any retry.]",
          }));
          this.messages.splice(insertAt, 0, ...synthetic);
        }
        return;
      }
    }
  }

  /** Run the loop until the model is done or maxSteps is hit. Returns the final text.
   * Pass an AbortSignal to support Esc-to-interrupt (stops cleanly between/within steps).
   * `images` (data: URLs) attach as OpenAI vision content — used by paste-image (needs a vision model). */
  // `internal` is local provenance for controller-generated turns; providerHistory() removes it.
  async run(instruction: string, signal?: AbortSignal, images?: ImageAttachment[], internal = false): Promise<string> {
    // These guards are scoped to one human turn. Carrying them across independent Agent.run calls
    // makes a later task inherit an unrelated failure/edit streak from an earlier conversation turn.
    this.editsPerPath.clear();
    this.consecutiveUnproductive = 0;
    if (!internal) {
      this.mutationEpoch = 0;
      this.validationExpected = false;
      this.validationResult = undefined;
    }
    if (!this.messages.length) {
      this.messages.push({ role: "system", content: this.systemPrompt });
    }
    // A crash can leave the last streamed assistant segment marked as in-flight. The text is valid
    // recovery context, but the marker is Neko-local metadata and must never cross a provider boundary.
    for (const message of this.messages) if (message?._neko_inflight) delete message._neko_inflight;
    this.sealDanglingToolCalls(); // an interrupted/resumed turn can leave tool_calls unanswered
    this.refreshDynamicContext();
    const content = images && images.length
      ? imageContent(instruction, images)
      : instruction;
    this.messages.push({ role: "user", content, _neko_internal: internal });

    let lastSig = ""; // loop guard: detect the model repeating the same tool call (a stuck loop)
    let repeats = 0;
    let mutErrored = false; // tool-error recovery is EDGE-triggered: re-armed by a mutating-tool success
    let verifiedExit = false; // the pre-completion verify gate fires at most once per run
    let planExitChecked = false; // an unfinished todo plan gets one persistence nudge before exit
    let validationExitChecked = false; // unresolved validator debt gets one targeted recovery round
    let changedRealState = false;
    let stateVerificationRequested = false;
    let stateVerificationEvidence = false;
    let completionVerificationEvidence = false;
    let nextReasoningEffort: string | undefined;
    let consecutiveReadSteps = 0; // adaptive effort: only lower reasoning on a SUSTAINED all-read pattern
    let toolchainCapabilityFailures = 0;
    let toolchainCircuitOpen = false;
    const noteTool = (call: { name: string; arguments?: Record<string, any> }, observation: unknown) => {
      const changesState = Agent.isStateChangingCall(call);
      const verifiesState = Agent.isVerificationEvidenceCall(call, observation);
      const failed = observation == null || Agent.isUnproductiveResult(observation);
      const validationCommand = call.name.toLowerCase() === "bash"
        && isValidationBashCommand(String(call.arguments?.command ?? ""));
      if (validationCommand) {
        const syntaxPreservesExit = hasAuthoritativeValidatorExit(String(call.arguments?.command ?? ""), call.arguments);
        const foregroundCompleted = typeof observation === "string" && /^\(exit 0\)(?:\r?\n|$)/.test(observation);
        const authoritative = syntaxPreservesExit && (failed || foregroundCompleted);
        this.validationExpected = true;
        this.validationResult = {
          epoch: this.mutationEpoch,
          command: String(call.arguments?.command ?? "").trim(),
          ok: authoritative && foregroundCompleted && !failed,
          authoritative,
          ...((failed || !authoritative) && typeof observation === "string"
            ? { detail: observation.replace(/\s+/g, " ").trim().slice(0, 500) }
            : undefined),
        };
      }
      // Only a SUCCESSFUL state-changing call advances the epoch. A rejected edit or a sandbox
      // dependency error changed no known state and must not manufacture verification work.
      if (changesState && !failed) {
        // A later bash can be the verifier for an earlier write/bash (tests, exact-byte checks), but the
        // first state-changing call cannot verify itself. Other mutations invalidate older evidence.
        stateVerificationEvidence = changedRealState && call.name.toLowerCase() === "bash" && verifiesState;
        completionVerificationEvidence = stateVerificationEvidence;
        changedRealState = true;
        // Validators may create caches/build output, but they observe the current source epoch rather
        // than defining a new source state that would immediately invalidate their own result.
        if (!validationCommand) this.mutationEpoch++;
      } else if (verifiesState) {
        completionVerificationEvidence = true;
        if (changedRealState) stateVerificationEvidence = true;
      }
    };
    let budgetNudges = 0; // SOTA "completion predicate": remind the model to LAND the deliverable near the budget edge
    for (let step = 0; step < this.maxSteps; step++) {
      this.emit("step", step + 1);
      await this.durableCheckpoint(); // user prompt / prior tool result is durable before provider work
      if (signal?.aborted) return "[interrupted]";
      // In-loop overflow guard: within ONE turn (e.g. many huge browser snapshots) context can grow
      // past the window with no chance for the between-turn UI compaction to run. Compact here BEFORE a
      // request would overflow -- otherwise the server computes a negative max_tokens and 400s the turn.
      const toolSchemas = this.tools.schemas();
      let estimatedTokens = estimateRequestTokens(this.providerHistory(), toolSchemas);
      // Cost guard, before the hard overflow guard: once a tool-heavy turn is substantial, clear old
      // results only when doing so saves >=8k estimated tokens. Keep five recent observations. This
      // mirrors provider context-editing guidance without churning the prompt cache for tiny wins.
      const editAt = Math.min(50_000, 0.5 * this.maxContextTokens);
      if (step > 0 && estimatedTokens > editAt && this.shrinkOldObservations(5, 32_000)) {
        estimatedTokens = estimateRequestTokens(this.providerHistory(), toolSchemas);
      }
      if (estimatedTokens > COMPACT_SAFETY_AT * this.maxContextTokens) {
        // One long turn has a single user message, so compact()'s snap-to-user boundary frees nothing;
        // clip the oldest observations in place first (cheap, synchronous), and only pay for a summarizer
        // call if that found nothing to clip. The compact/compact_done events bracket ONLY that slow path,
        // so the UI's compacting indicator shows for the model call, not the instant in-place clip.
        if (!this.shrinkOldObservations()) {
          this.emit("compact", "auto");
          await this.compact();
          this.emit("compact_done", "auto");
        }
      }
      // Stream-eager execution ("Executing as You Generate", arXiv 2604.00491; AsyncFC 2605.15077):
      // a streamed tool call is fully parsed long before the whole response finishes, so READ-ONLY
      // calls start executing DURING generation - a turn's floor drops from generation+execution
      // toward max(generation, execution). Strictly order-safe: eager-starting STOPS at the first
      // non-read call in emission order (a read after a write must observe the write), gated tools
      // are never eager (approval semantics untouched), everything runs under the same abort signal,
      // and results are consumed by key below - never re-executed.
      const eager = new Map<string, Promise<string | any[]>>();
      const eagerKey = (c: { id?: string; name: string; arguments?: Record<string, any> }) =>
        c.id || `${c.name}:${JSON.stringify(c.arguments ?? {})}`;
      let eagerOk = true;
      const onToolCallReady = (call: { id: string; name: string; arguments: Record<string, any> }) => {
        const adapterSafe = this.tools.mcp?.permission?.(call.name) === "safe";
        if (!EAGER_SAFE.has(call.name) && !adapterSafe) { eagerOk = false; return; }
        if (!eagerOk || signal?.aborted || eager.has(eagerKey(call))) return;
        eager.set(eagerKey(call), this.safeExecute(call, signal));
      };
      // Crash journal for provider-managed loops (Codex App Server, Gemini CLI) and ordinary streaming.
      // Their deltas/tool calls arrive while complete() is still pending; without mirroring them into the
      // canonical message list, every mid-turn save snapshots only the user prompt. Keep one in-flight
      // assistant message per streamed segment, commit it beside each completed dynamic tool result, and
      // emit bounded checkpoints so a network loss + killed terminal loses at most a short delta tail.
      let inflightAssistant: any | null = null;
      let streamedContent = "";
      let managedTrace = false;
      let lastCheckpointAt = 0;
      const checkpoint = (force = false, queueDurable = true) => {
        const now = Date.now();
        if (!force && lastCheckpointAt && now - lastCheckpointAt < 750) return;
        lastCheckpointAt = now;
        this.emit("checkpoint", { reason: "inflight" });
        if (queueDurable) this.queueDurableCheckpoint();
      };
      const ensureInflight = () => {
        if (!inflightAssistant) {
          inflightAssistant = { role: "assistant", content: "", _neko_inflight: true };
          this.messages.push(inflightAssistant);
        }
        return inflightAssistant;
      };
      const streamedDelta: DeltaHook | undefined = this.onDelta
        ? (text, kind) => {
            if ((kind ?? "content") === "content" && text) {
              const first = !inflightAssistant;
              ensureInflight().content += text;
              streamedContent += text;
              checkpoint(first); // first durable byte of every post-tool segment lands immediately
            }
            this.onDelta?.(text, kind);
          }
        : undefined;
      const finalizeInflight = (content: string | null, calls: ToolCall[] = [], continuation?: any[]) => {
        const text = content ?? "";
        const hadInflight = inflightAssistant !== null;
        const message = inflightAssistant ?? ensureInflight();
        // Most streaming adapters return exactly the deltas already journaled. If a provider delivers
        // an unstreamed suffix, append only that suffix; never duplicate the whole streamed answer. A
        // brand-new segment after a tool has no in-flight deltas of its own, so its returned text wins.
        if (!hadInflight || !managedTrace) message.content = text;
        else if (!streamedContent) message.content = text;
        else if (text.startsWith(streamedContent)) message.content += text.slice(streamedContent.length);
        if (calls.length) message.tool_calls = assistantToolMessage(null, calls).tool_calls;
        if (continuation?.length) message.provider_data = continuation;
        delete message._neko_inflight;
        inflightAssistant = null;
        return message;
      };
      let managedToolChain: Promise<void> = Promise.resolve();
      const executeTool = (call: { id: string; name: string; arguments: Record<string, any> }): Promise<string | any[]> => {
        managedTrace = true;
        // Provider callbacks can arrive concurrently. Serialize the canonical trajectory so each
        // assistant(function_call) is followed by its own tool(function_call_output) before the next
        // call begins; otherwise completion order can create invalid role ordering on resume.
        const task = managedToolChain.then(async () => {
          // Provider-managed calls do not come back in response.tool_calls. Materialize and persist the
          // assistant function_call BEFORE execution: a mutating tool can finish its external side effect
          // and then lose the network/terminal before returning. Resume must know that call was attempted;
          // sealDanglingToolCalls() marks its outcome unknown when no result was journaled.
          finalizeInflight(null, [call]);
          checkpoint(true, false);
          this.emit("tool_call", call);
          await this.durableCheckpoint();
          const observation = await this.safeExecute(call, signal);
          noteTool(call, observation);
          this.messages.push({ role: "tool", tool_call_id: call.id || call.name, content: clampObservation(observation) });
          this.emit("tool_result", { call, observation });
          await this.durableCheckpoint(); // completed outcome is durable before the managed provider continues
          return observation;
        });
        managedToolChain = task.then(() => undefined, () => undefined);
        return task;
      };
      let response;
      let latestUsage: Usage | undefined;
      // Before every provider call, publish the already-booked input plus this pending request's
      // context estimate. Providers without live usage still get a monotonic whole-turn meter; when
      // authoritative usage arrives below, it replaces this visibly approximate snapshot.
      this.emit("usage_estimate", {
        prompt_tokens: this.cost.promptTokens + estimateRequestTokens(this.providerHistory(), toolSchemas),
      });
      // Provider live-usage callbacks describe THIS complete() call. Rebase them onto the Agent's
      // already-booked totals so the UI sees one monotonic absolute counter across a multi-step turn.
      const usageBase = {
        prompt: this.cost.promptTokens,
        completion: this.cost.completionTokens,
        total: this.cost.totalTokens,
        cached: this.cost.cachedTokens,
        calls: this.cost.calls,
      };
      const publishUsage = (usage: Usage) => {
        latestUsage = usage;
        this.emit("usage", {
          prompt_tokens: usageBase.prompt + (usage.prompt_tokens ?? 0),
          completion_tokens: usageBase.completion + (usage.completion_tokens ?? 0),
          total_tokens: usageBase.total + (usage.total_tokens ?? 0),
          cached_tokens: usageBase.cached + (usage.cached_tokens ?? 0),
          context_tokens: usage.context_tokens,
          context_cached_tokens: usage.context_cached_tokens,
          model_calls: usageBase.calls + Math.max(1, usage.model_calls ?? 1),
        } satisfies Usage);
      };
      try {
        response = await this.provider.complete(
          this.providerHistory(),
          toolSchemas,
          streamedDelta,
          signal,
          {
            onToolCallReady,
            executeTool,
            onUsage: publishUsage,
            ...(nextReasoningEffort ? { reasoningEffort: nextReasoningEffort } : undefined),
          },
        );
      } catch (error) {
        // A rejected/aborted provider call can still be billed. Its last authoritative live snapshot
        // never reaches ProviderResponse.usage, so book it once here before the turn returns/throws.
        this.cost.add(latestUsage);
        if (signal?.aborted) return "[interrupted]";
        throw error;
      }
      this.cost.add(response.usage);
      const toolCalls = response.tool_calls ?? [];

      if (!toolCalls.length) {
        const final = response.content ?? "";
        // A bridge may stream only pre-tool progress, then return its post-tool final from complete()
        // without an onDelta. When the last durable message is the tool result, append that final as a
        // new assistant segment instead of dropping it because earlier segments happened to stream.
        if (inflightAssistant || !managedTrace || !streamedContent
          || (final && this.messages.at(-1)?.role === "tool")) {
          finalizeInflight(final, [], response.continuation);
        }
        // A todo label is not proof, but an OPEN plan is proof that the controller has unfinished work.
        // Give the model one chance to reconcile it before exit: continue, mark verified items done via
        // todo_write, or report a real blocker. One-shot avoids trapping legitimate clarification turns.
        const openTodos = Array.isArray(this.tools.todos)
          ? this.tools.todos.filter((t) => t.status !== "completed")
          : [];
        if (openTodos.length && !planExitChecked && step < this.maxSteps - 1) {
          planExitChecked = true;
          verifiedExit = true; // this nudge already asks for real-state verification; do not stack gates
          this.messages.push({
            role: "user",
            _neko_internal: true,
            content: `PLAN NOT COMPLETE: ${openTodos.length} todo item(s) are still open. Re-check the actual state, ` +
              "continue the work, and call todo_write with the full updated plan before finishing. Mark items " +
              "completed only when verified. If progress is genuinely blocked, state the blocker clearly instead of claiming completion.",
          });
          continue;
        }
        const validation = this.completionStatus;
        if (!validation.ok && !validationExitChecked && step < this.maxSteps - 1) {
          validationExitChecked = true;
          verifiedExit = true; // this is stronger than the generic inspection-only gate
          const command = validation.command ? ` The validator was: ${JSON.stringify(validation.command)}.` : "";
          this.messages.push({
            role: "user",
            _neko_internal: true,
            content: `${validation.reason === "validation_failed" ? "VALIDATION FAILED" : "VALIDATION REQUIRED"}: ` +
              "the project changed, but no recognized validator has passed after the latest successful mutation." +
              command + " A read/search/diff is useful inspection, but it cannot replace this failed or stale " +
              "test/typecheck/lint/build result. Re-run a recognized validator now. If the capability is " +
              "unavailable, report the blocker plainly; do not claim the task is verified.",
          });
          continue;
        }
        // An action's return value is process evidence, not proof of the user-visible outcome. A
        // DPI-virtualized script can report success while placing an icon at the wrong physical pixel.
        // Production agents therefore require one fresh, successful inspection after the latest mutation.
        // A well-behaved agent that already inspected pays no extra model round; only unverified finishes
        // are intercepted.
        if (this.verifyStateChangesBeforeExit && changedRealState && step < this.maxSteps - 1) {
          if (!stateVerificationEvidence && !stateVerificationRequested) {
            stateVerificationRequested = true;
            verifiedExit = true; // stronger than the generic opt-in gate; do not stack both
            this.messages.push({
              role: "user",
              _neko_internal: true,
              content: "OUTCOME VERIFICATION REQUIRED: you changed real machine/project state. Do not trust " +
                "the action's success message or the coordinates you intended. Use a tool NOW to inspect the " +
                "result independently, then compare the observed end state with every user-visible requirement " +
                "in the original task. For GUI/spatial work, wait for settling and use computer read/list/get/watch/" +
                "screenshot; use computer display for physical monitor geometry and DPI. If evidence disagrees, " +
                "keep working. Do not claim completion from an action log alone.",
            });
            continue;
          }
          if (!stateVerificationEvidence) {
            this.messages.push({
              role: "user",
              _neko_internal: true,
              content: "NO VERIFICATION EVIDENCE YET: your last reply used no fresh successful inspection tool. " +
                "Observe the actual end state now; otherwise report that completion is unverified, not done.",
            });
            continue;
          }
        }
        // Pre-completion gate (opt-in): intercept the FIRST unsupported tool-less final and force a
        // re-inspection of the ACTUAL state - the "declared done without re-running the check"
        // failure mode (LangChain PreCompletionChecklist; ACE reflection-before-exit). Productive
        // inspection/test evidence already gathered in this run satisfies it; a later mutation clears
        // that evidence. Fires at most once, and never on the last step so wrap-up can finish.
        if (this.verifyBeforeExit && !verifiedExit && !completionVerificationEvidence && step < this.maxSteps - 1) {
          verifiedExit = true;
          this.messages.push({
            role: "user",
            _neko_internal: true,
            content: "VERIFY BEFORE FINISHING: re-inspect the ACTUAL current state against the original goal " +
              "(re-run the failing check / re-read the changed file / re-test the command) - judge what IS, " +
              "not your memory of what you intended. If the goal is fully met, restate the final answer. " +
              "If anything is missing, keep working now.",
          });
          continue;
        }
        await this.durableCheckpoint();
        this.emit("final", final);
        return final;
      }

      finalizeInflight(response.content, toolCalls, response.continuation);
      checkpoint(true, false);
      await this.durableCheckpoint(); // the call itself is durable before a slow or state-changing tool starts
      if (signal?.aborted) return "[interrupted]";
      let stepHadUnproductiveResult = false;

      // Fleet fan-out: static read tools and capability-restricted reviewer/explorer tasks may run
      // in parallel. Generic/custom workers can mutate, so one such call serializes the whole batch.
      // Executable hooks are trusted but may have side effects, so their calls remain serialized.
      const hooksMayHaveEffects = Boolean(this.tools.hooks?.preToolUse || this.tools.hooks?.postToolUse);
      const concurrencySafe = (call: ToolCall) => !hooksMayHaveEffects && (CONCURRENCY_SAFE.has(call.name)
        || (call.name === "task" && taskDelegatesReadOnly(call.arguments)));
      if (toolCalls.length > 1 && toolCalls.every(concurrencySafe)) {
        lastSig = ""; // a parallel fan-out breaks any single-call repeat chain
        toolCalls.forEach((call) => this.emit("tool_call", call));
        const observations = await Promise.all(toolCalls.map((call) => eager.get(eagerKey(call)) ?? this.safeExecute(call, signal)));
        toolCalls.forEach((call, i) => {
          noteTool(call, observations[i]);
          if (Agent.isUnproductiveResult(observations[i])) stepHadUnproductiveResult = true;
          this.messages.push({ role: "tool", tool_call_id: call.id || call.name, content: clampObservation(observations[i]) });
          this.emit("tool_result", { call, observation: observations[i] });
        });
        await this.durableCheckpoint();
      } else {
        for (const call of toolCalls) {
          if (signal?.aborted) return "[interrupted]"; // stop promptly between tools on Esc
            this.emit("tool_call", call);
            // Loop guard: if the model makes the SAME call 3x in a row, it's stuck — nudge instead of
            // re-running it, so it changes approach or finishes (prevents lag/chaos/spinning).
            const sig = `${call.name}:${JSON.stringify(call.arguments ?? {})}`;
            const repeatableWait = this.isRepeatableWaitCall(call);
            repeats = !repeatableWait && sig === lastSig ? repeats + 1 : 0;
            lastSig = repeatableWait ? "" : sig;
            // BROAD doom-loop guard: counts repeated edits to ONE path with DIFFERENT args (which the
            // exact-repeat guard above structurally cannot — every sig differs). It only WARNS (appended
            // below after the edit runs), so a legitimate multi-edit is never blocked; only an EXACT
            // 3x-identical repeat is blocked here (that one is unambiguously stuck).
            const broad = this.broadLoopNudge(call);
            const circuitBlocked = toolchainCircuitOpen && Agent.isToolchainCommand(call);
            let observation = circuitBlocked
              ? "[capability circuit] The sandbox/runtime already failed three independent Bun/Node/package-manager attempts. " +
                "Stop trying alternate paths, installers, shells, or host computer control. Use structured file tools for work " +
                "that remains possible, and report test execution as blocked by the unavailable toolchain."
              : repeats >= 2
              ? "[loop guard] You already made this exact tool call 3 times with the same result. Stop repeating it: try a different approach/tool, or give your final answer now."
              : await (eager.get(eagerKey(call)) ?? this.safeExecute(call, signal));
            noteTool(call, observation);
            if (Agent.isToolchainCommand(call) && !circuitBlocked) {
              if (Agent.isToolchainCapabilityFailure(call, observation)) {
                toolchainCapabilityFailures++;
                if (toolchainCapabilityFailures >= TOOLCHAIN_FAILURE_CAP) {
                  toolchainCircuitOpen = true;
                  observation += "\n[capability circuit opened] Further Bun/Node/package-manager commands in this turn will not run. " +
                    "Do not escape through computer control; continue with allowed structured tools and state the verification blocker.";
                }
              } else if (!Agent.isFailedRunResult(observation)) {
                toolchainCapabilityFailures = 0;
              }
            }
            if (Agent.isUnproductiveResult(observation)) stepHadUnproductiveResult = true;
            // Track consecutive UNPRODUCTIVE results (failed OR empty) from ANY tool; a productive result
            // resets the streak. Catches the doom-loop the exact-repeat + edit guards structurally miss:
            // probing a heavy/obfuscated page with a DIFFERENT selector each time, every one returning []
            // (the classic Facebook-feed time sink). The result is still fed back; the loop also signals.
            this.consecutiveUnproductive = Agent.isUnproductiveResult(observation) ? this.consecutiveUnproductive + 1 : 0;
            this.messages.push({ role: "tool", tool_call_id: call.id || call.name, content: clampObservation(observation) });
            this.emit("tool_result", { call, observation });
            await this.durableCheckpoint();
            // Tool-error recovery (Self-Harness pattern, arXiv 2606.09498 - the paper's single biggest win
            // was a recovery directive injected AT the point of a tool error): on the FIRST failure of a
            // MUTATING tool, tell the model HOW to recover - models otherwise flail (blind re-runs, deleting
            // the partial artifact they still need). Edge-triggered so it never nags: a mutating success
            // re-arms it, and PERSISTENT failure is the unproductive-streak guard's job below (fires at N).
            const mutFailed = MUTATING_TOOLS.has(call.name) && typeof observation === "string" &&
              (observation.startsWith(`Error running ${call.name}`) || Agent.isFailedRunResult(observation));
            if (mutFailed && !mutErrored && repeats < 2) {
              this.messages.push({ role: "tool", tool_call_id: call.id || call.name, content:
                `[recovery] That ${call.name} FAILED. Don't blindly re-run it, and don't delete partial ` +
                "work it may still need. Recover deliberately: (1) DIAGNOSE - read the error above and " +
                "inspect the actual state (the file, the directory, the command output); (2) REPAIR - fix " +
                "the root cause or recreate the missing artifact; (3) VALIDATE - re-run the failed check " +
                "and confirm it passes; then continue the task." });
            }
            if (MUTATING_TOOLS.has(call.name)) mutErrored = mutFailed;
            // BROAD edit-loop guard (warn, don't block): the edit RAN above; append a one-time nudge so the
            // model steps back instead of micro-editing one file forever. Skipped when the exact-repeat guard
            // already blocked this step (repeats >= 2) to avoid double-nudging.
            if (broad !== null && repeats < 2) this.messages.push({ role: "tool", tool_call_id: call.id || call.name, content: broad });
            // After enough consecutive empty/failed results, append one nudge so the model changes APPROACH
            // (usually the strategy is wrong, not the arguments) instead of trying a 7th selector variant.
            if (this.consecutiveUnproductive >= UNPRODUCTIVE_CAP) {
              const nudge = "[loop guard] The last " + this.consecutiveUnproductive + " tool results in a row " +
                "were empty or failed. That usually means the APPROACH is wrong, not the arguments - stop " +
                "varying the same call. Step back and try a DIFFERENT tool/strategy (for a web page or feed, " +
                "the accessibility snapshot or a markdown read is far more reliable than DOM selectors), or " +
                "answer with what you already have.";
              this.messages.push({ role: "tool", tool_call_id: call.id || call.name, content: nudge });
              this.consecutiveUnproductive = 0; // reset so it fires once, then re-accumulates
            }
          }
      }
      // Adaptive effort, conservative variant: lower reasoning only on a SUSTAINED all-read pattern
      // (2+ consecutive steps), never after a single read whose result the next step must still
      // synthesize. That "lagged proxy" risk is exactly why this stays off by default pending an eval;
      // this gate makes a future enablement strictly safer — it can only fire less, in narrower cases.
      const allReads = toolCalls.length > 0 && !stepHadUnproductiveResult
        && toolCalls.every((call) => this.isMechanicalReadCall(call));
      consecutiveReadSteps = allReads ? consecutiveReadSteps + 1 : 0;
      nextReasoningEffort = this.adaptiveEffort && consecutiveReadSteps >= 2 ? "low" : undefined;

      // Budget-aware COMPLETION nudge (2026 SOTA: agents fail not from inability but because "nobody told
      // it when the work is over" - a completion signal near the budget edge is what changes behavior).
      // On a long task, glm/GLM-class models over-research and get cut off at max_steps with the artifact
      // never written. This fires at ~2/3 then ~6/7 of the budget, once each: it does NOT stifle earlier
      // exploration (that stays free) - it just stops the model running out with nothing produced.
      if (this.maxSteps >= 10) {
        const frac = (step + 1) / this.maxSteps;
        const threshold = budgetNudges === 0 ? 0.66 : budgetNudges === 1 ? 0.85 : 2;
        if (frac >= threshold) {
          budgetNudges++;
          const left = this.maxSteps - (step + 1);
          this.messages.push({ role: "user", _neko_internal: true, content:
            `[budget] ~${left} of ${this.maxSteps} steps left (${Math.round(frac * 100)}% used). If this task ` +
            "has a concrete deliverable - a file to write, code, a config, a plan - PRODUCE and finish it NOW; " +
            "don't spend the remaining budget exploring. A delivered result with its open risks named honestly " +
            "beats a perfect one you never wrote. If you are already done, give your final answer." });
        }
      }
    }

    // Step limit reached: instead of an abrupt stop, ask for one tool-less wrap-up so the user gets
    // a useful summary of what was done and what remains (don't leave the task half-narrated).
    this.emit("max_steps", this.maxSteps);
    let final: string;
    try {
      const wrap = await this.provider.complete(
        cleanProviderMessages([...this.providerHistory(), { role: "user", content: `Step limit (${this.maxSteps}) reached. Stop calling tools and concisely summarize what you did and what's left.`, _neko_internal: true }]),
        undefined,
        this.onDelta,
        signal,
      );
      this.cost.add(wrap.usage); // the wrap-up call costs tokens too — count it
      final = wrap.content?.trim() || `[stopped: reached max_steps=${this.maxSteps}]`;
    } catch {
      return `[stopped: reached max_steps=${this.maxSteps}]`;
    }
    this.messages.push({ role: "assistant", content: final });
    await this.durableCheckpoint();
    this.emit("final", final);
    return final;
  }

  private emit(kind: string, data: any): void {
    this.onEvent?.(kind, data);
  }

  private queueDurableCheckpoint(): void {
    if (!this.onCheckpoint || this.hasCheckpointFailure) return;
    try {
      void Promise.resolve(this.onCheckpoint()).catch((error) => {
        if (!this.hasCheckpointFailure) this.checkpointFailure = error;
        this.hasCheckpointFailure = true;
      });
    } catch (error) {
      this.checkpointFailure = error;
      this.hasCheckpointFailure = true;
    }
  }

  private async durableCheckpoint(): Promise<void> {
    if (this.hasCheckpointFailure) {
      const error = this.checkpointFailure;
      this.hasCheckpointFailure = false;
      this.checkpointFailure = undefined;
      throw error;
    }
    if (!this.onCheckpoint) return;
    await this.onCheckpoint();
    if (this.hasCheckpointFailure) {
      const error = this.checkpointFailure;
      this.hasCheckpointFailure = false;
      this.checkpointFailure = undefined;
      throw error;
    }
  }
}

/** Only silence/stall failures are safe to resume automatically. Authentication, validation, policy,
 * and ordinary provider errors still surface immediately instead of being hidden behind retries. */
function isRecoverableProviderStall(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "TimeoutError"
    || /\b(?:idle timeout|produced no activity)\b/i.test(error.message)
  );
}

/** Rebuild the OpenAI-format assistant turn so the next request carries the tool_calls
 * the model made (ids must match the following tool results). */
function assistantToolMessage(content: string | null, toolCalls: ToolCall[], continuation?: any[]): any {
  return {
    role: "assistant",
    content: content ?? "",
    tool_calls: toolCalls.map((call) => ({
      id: call.id || call.name,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    })),
    ...(continuation?.length ? { provider_data: continuation } : undefined),
  };
}

/** Tolerate malformed tool-argument shapes some providers emit (observed with GLM over an OpenAI-compat
 * endpoint): a single `_raw`/`arguments`/`input`/`parameters`/`args` wrapper key, or the raw JSON string.
 * Left unfixed these fail required-arg validation and wedge the turn in a re-emit loop. A legitimate call
 * never has exactly one of those wrapper keys, so unwrapping is safe. */
export function unwrapToolArgs(raw: any): Record<string, any> {
  let a: any = raw;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { return {}; } }
  if (!a || typeof a !== "object" || Array.isArray(a)) return {};
  const keys = Object.keys(a);
  if (keys.length === 1 && ["_raw", "arguments", "input", "parameters", "args"].includes(keys[0])) {
    let inner: any = a[keys[0]];
    if (typeof inner === "string") { try { inner = JSON.parse(inner); } catch { /* keep original object */ } }
    if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner;
  }
  return a;
}
