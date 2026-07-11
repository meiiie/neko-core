/**
 * Stateless agent configuration: the system prompt, compaction/observation constants, token
 * estimation, tool-classification policy sets, and loop-guard caps. Pure data + functions, no
 * `Agent` state — separated from agent.ts so the agentic-loop class reads as just the loop.
 *
 * Naming note: "constants" (not "config") to avoid confusion with adapters/config.ts (user/runtime
 * config overlay). Everything here is fixed agent behavior policy.
 */
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
  "- Multi-step -> todo_write to plan + track (exactly one item in_progress while work remains; none when all are completed). Mark an item completed only after checking the real result; before finishing, update the full plan so every finished item is completed or state the blocker.\n" +
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
  "- BATCH independent reads: when you need several lookups that don't depend on each other " +
  "(read_file/search/glob/ls/web_search/web_fetch), emit them TOGETHER in one turn — they run in " +
  "parallel, so 4 reads cost one round-trip instead of four. Serialize only when a read depends on a " +
  "prior read's result.\n" +
  "- VERIFY every command: after bash/tests/builds, READ the exit code and output. If it FAILED (non-zero exit) or shows an error, diagnose the cause, fix it, and re-run to confirm it passes -- never assume success or move on with a broken result.\n\n" +
  "## Accuracy\n" +
  "Time-sensitive or factual questions (today/current/latest/best/a price/who holds an office) -> your training has a CUTOFF; do NOT answer from memory. web_search, then VERIFY before answering: cross-check each key fact across >=2 independent sources; prefer primary/official/known-leaderboard sources over SEO/aggregator/content-farm pages; sanity-check recency (a 'latest/2026' source that lists clearly-old items is stale -- discard it, don't repeat it). If sources conflict or are thin, SAY SO and cite (URL + date) rather than presenting a guess as fact. For a deeper multi-angle dive, load the `deep-research` skill.\n\n" +
  "## Output\n" +
  "Your reply renders as GitHub-flavored markdown in a MONOSPACE TERMINAL. Format for it: `##` headings, " +
  "**bold**, `inline code`, `- ` bullets, `1.` numbered lists, and pipe tables for structured data. Do NOT use " +
  "emojis — decorative ones (checkmarks, keycaps like a digit-in-a-box, arrows) misalign the columns and read as " +
  "clutter on a terminal; use a markdown heading / bold / a numbered list for emphasis instead. Only use emojis " +
  "if the user explicitly asks. Don't hand-draw ASCII rules (`-----`) or box art; let headings and blank lines " +
  "separate sections.\n" +
  "- Math: prefer plain Unicode (x², aₙ, a/b, √, ×, ÷, ≤, ≥, ≠, θ, Σ, →) since a terminal can't render LaTeX/" +
  "MathML. Simple LaTeX (`$...$`, `$$...$$`, \\frac, ^, _, greek) is converted to Unicode, but keep formulas " +
  "short and readable rather than dense multi-line LaTeX.\n\n" +
  "Be concise — no filler, no 'I will now...' preamble or 'let me know if...' postamble; sound like a focused senior engineer pair-programming, not a script. When done: a short summary, then stop.";

// Tools safe to run concurrently in one turn: read-only inspection + sub-agent tasks (the
// "fleet"). Mutating tools (write_file/edit/bash) are excluded so they stay ordered + gated.
export const CONCURRENCY_SAFE = new Set(["read_file", "search", "glob", "ls", "web_search", "web_fetch", "task"]);
// Tools that may start executing WHILE the response is still streaming (stream-eager execution).
// Read-only only; `task` is excluded - eagerly spawning a sub-agent on a half-streamed turn is too
// aggressive a bet (its own model calls) for a speculative start.
export const EAGER_SAFE = new Set([...CONCURRENCY_SAFE].filter((n) => n !== "task"));

// File-mutating tools. The broad doom-loop guard counts repeated edits to the SAME path even
// when the args differ (the common "chase a build error across N edits" loop the exact-repeat
// guard misses). Normalized path = the `path` arg (write_file/edit) or that of multi_edit's file.
export const EDIT_TOOLS = new Set(["write_file", "edit", "multi_edit"]);
export const MUTATING_TOOLS = new Set(["bash", ...EDIT_TOOLS]); // tools whose FAILURE warrants a recovery directive (read misses are benign exploration)
// Thresholds for the BROAD doom-loop guard (distinct from the exact-repeat guard above).
export const EDIT_PER_PATH_CAP = 6;   // edits to ONE path in a run before a ONE-TIME soft nudge (warns, does NOT
                                      // block -- legitimate coding edits a file several times: write, test, fix, fix)
export const UNPRODUCTIVE_CAP = 3;    // >= N consecutive EMPTY-or-failed tool results (any tool) -> nudge to change approach

// A single tool result (a giant browser snapshot, a huge file/page read) must not push the prompt past
// the model's context window -- the server then computes a NEGATIVE max_tokens (window - prompt) and
// rejects the whole turn with HTTP 400. Cap each observation (head + tail, with a marker) so one result
// can't overflow the window. Multimodal array results (image parts) pass through untouched.
export const MAX_OBS_CHARS = 48000;
/** On compaction, also clip a kept-tail tool result once it exceeds this many CHARS — catches dense
 * few-line output (minified JSON, base64, packed log lines) that the line-count guard misses. */
export const LEAN_TAIL_CHARS = 8000;
/** Auto-compaction thresholds, as a FRACTION of the model's context window. Two on purpose:
 *  - COMPACT_AT (primary): checked BETWEEN turns against the last request's ACTUAL input-token count
 *    (cost.lastPrompt) - the accurate signal, so this is where the user normally sees a compaction.
 *  - COMPACT_SAFETY_AT (safety net): checked INSIDE one long turn against the rough char-based estimate,
 *    which can undercount, so it fires a little earlier to keep headroom before a request would 400 on a
 *    negative max_tokens. A single huge turn (many browser snapshots) is the case this exists for. */
export const COMPACT_AT = 0.85;
export const COMPACT_SAFETY_AT = 0.80;
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
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
    // Count tool_calls too: a tool-heavy turn carries each call's name + arguments as JSON on the
    // assistant message, which the content-only sum above ignores. For write_file the ENTIRE file
    // text lives in arguments -- a turn writing several big files would otherwise be undercounted
    // and the overflow guard would fire too late. Results are usually larger, but not always.
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    if (m.provider_data) chars += JSON.stringify(m.provider_data).length;
  }
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
  /** Opt-in pre-completion gate: the FIRST tool-less final answer of a run is intercepted once and
   * the model is told to re-inspect the ACTUAL state against the goal before finishing - catching
   * the "declared done without re-running the check" failure mode. (Config: `verify_before_exit`.) */
  verifyBeforeExit?: boolean;
}
