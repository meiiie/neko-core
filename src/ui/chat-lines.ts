/**
 * UI line helpers for the chat transcript: pure functions that build / summarize / bound transcript
 * lines. Separated from chat.tsx (Martin Fowler "separate view from no-view logic") — none of these
 * are React components or hooks, just message→Line mapping, result summaries, and live-stream
 * bounding. chat.tsx imports them; tests import the exported ones.
 *
 * Splits the view work (the ChatApp component + its state/effects) from the line/summary logic it
 * consumes. UI→core is allowed (describeToolCall is a pure contract helper).
 */
import { describeToolCall } from "../core/tools.ts";
import type { Line } from "./transcript.tsx";

import { honestTruncate } from "../shared/terminal-text.ts";
import { isText } from "../shared/wire.ts";

/** Flatten a message's content (string or vision-array) to display text. */
export function contentToText(c: any): string {
  if (isText(c)) return c;
  if (Array.isArray(c)) return c.map((p) => (p?.text ?? (p?.type === "image_url" ? "[image]" : ""))).join("");
  return String(c ?? "");
}

/** Failure outcomes stay expanded: compacting them would hide the one thing the user must inspect. */
export function isToolFailure(obs: string): boolean {
  const text = obs.trimStart();
  return /^(Error|Blocked|Denied|Refused)/i.test(text)
    || /\(exit \d+ -- command FAILED\)/.test(obs)
    || /^\((?:timed out|interrupted|no skill\b)/i.test(text)
    || /^\[loop guard\]/im.test(text)
    || /^\[interrupted while this tool call was in flight\b/i.test(text)
    || /^\[recovery\].*\bFAILED\b/i.test(text)
    || /^The user did NOT approve the plan\b/i.test(text)
    || /^No matching MCP tools\b/i.test(text)
    || /^Sub-agents are not available\b/i.test(text)
    || /^Sub-agent error:/i.test(text)
    || /^Tool '.+' is disabled\b/i.test(text)
    || /^Unknown computer action\b/i.test(text)
    || /^\[PDF [^\]]+\] - (?:text extraction needs|no extractable text)\b/i.test(text)
    || /^\[[^\]]+\] - to view it, set "vision": true\b/im.test(text)
    || /^\[stopped: reached max_steps=\d+\]/i.test(text)
    || /^\(offset \d+ is beyond end of file\b/i.test(text);
}

const short = (value: any, cap = 80) => honestTruncate(value, cap, "...");

const ALWAYS_EXPANDED_TOOLS = new Set([
  // todo_write intentionally NOT here: lived raise-bar-12 reprinted the full checklist on every
  // update (density). It now folds to summarizeTodoWriteResult; Ctrl+O still reveals the plan.
  "update_plan", "memory", "workflow", "playbook",
  "mcp__neko_meeting__stop",
]);

/** True when a tool_result body is a todo_write checklist (expanded form). */
export function isTodoWriteResultText(text: string): boolean {
  const body = String(text ?? "");
  // Live expanded path paints obs alone ("Todos:\n..."); collapsed/replay stores "Update Todos\nTodos:\n...".
  return /^Todos:\n/m.test(body) || /\nTodos:\n/.test(body);
}

/** Compact one-liner for a todo_write checklist (folded in the transcript; full plan under Ctrl+O). */
export function summarizeTodoWriteResult(text: string, args?: any): string {
  // SAFETY: Array.isArray narrowed args.todos; only optional status strings are read for counts.
  const fromArgs = Array.isArray(args?.todos) ? args.todos as { status?: string }[] : null;
  let done = 0;
  let total = 0;
  let active = 0;
  if (fromArgs && fromArgs.length) {
    total = fromArgs.length;
    for (const t of fromArgs) {
      if (t?.status === "completed") done++;
      else if (t?.status === "in_progress") active++;
    }
  } else {
    for (const line of String(text ?? "").split("\n")) {
      const m = line.match(/^\[(x|~| )\]\s+/);
      if (!m) continue;
      total++;
      if (m[1] === "x") done++;
      else if (m[1] === "~") active++;
    }
  }
  if (total === 0) return "Updated todos";
  if (active) return `Updated todos (${done}/${total} done, ${active} in progress)`;
  return `Updated todos (${done}/${total} done)`;
}

const EMPTY_RESULT_SENTINELS = new Set(["(no matches)", "(no files)", "(empty)"]);

/** Collapsed tool rows store `${toolCall}\n${obs}`. Hint Ctrl+O only when expand reveals more than an
 * empty-result sentinel already covered by the summary (e.g. "Listed empty-dir (0 items)"). */
export function collapsedToolResultExpandable(text: string): boolean {
  const lines = String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const obs = lines.length > 1 ? lines.slice(1).join("\n") : String(text ?? "");
  const trimmed = obs.trim();
  if (!trimmed) return false;
  if (EMPTY_RESULT_SENTINELS.has(trimmed)) return false;
  return true;
}

/** Count user-visible activity once: folded success is one result; expanded failure is one call. */
export function countNewActivities(lines: Line[], from = 0): number {
  return lines.slice(Math.max(0, from)).filter((line) =>
    line.kind === "user"
    || line.kind === "assistant"
    || line.kind === "tool_call"
    || (line.kind === "tool_result" && Boolean(line.summary))
  ).length;
}

/** Rising-edge baseline for the jump-to-bottom "N new messages" pill.
 * Capture lines.length synchronously when reading mode engages so the first painted frame never
 * counts the whole transcript (or activity that landed while sticky-bottom) as "new". A useEffect
 * baseline runs after paint and flashed a phantom count. */
export function scrollAwayBaselineOnEdge(
  scrolled: boolean,
  linesLength: number,
  prev: { armed: boolean; baseline: number },
): { armed: boolean; baseline: number } {
  if (!scrolled) return { armed: false, baseline: prev.baseline };
  if (prev.armed) return prev;
  return { armed: true, baseline: linesLength };
}

/** One compact, past-tense outcome for every successful activity; full call + output stays under Ctrl+O. */
export function resultSummary(
  name: string | undefined,
  obs: string,
  args: any = {},
): string | undefined {
  if (!name || isToolFailure(obs) || ALWAYS_EXPANDED_TOOLS.has(name)) return undefined;
  const background = obs.match(/^Running in background \[([^\]]+)\]:\s*(.+)$/m);
  const n = EMPTY_RESULT_SENTINELS.has(obs.trim()) ? 0 : obs.split("\n").filter((line) => line.trim()).length;
  const target = short(args.path ?? args.command ?? args.query ?? args.url ?? args.pattern ?? args.name);
  if ((name === "bash" || name === "shell_command") && background) {
    return `Started background job [${short(background[1], 24)}]: ${target || short(background[2])}`;
  }
  switch (name) {
    case "read_file": return target ? `Read ${target} (${n} line${n === 1 ? "" : "s"})` : `Read ${n} line${n === 1 ? "" : "s"}`;
    case "search": {
      const needle = short(args.pattern ?? args.query ?? args.path);
      return needle ? `Searched for ${needle} (${n} match${n === 1 ? "" : "es"})` : `Found ${n} match${n === 1 ? "" : "es"}`;
    }
    case "glob": {
      const pattern = short(args.pattern ?? args.path);
      return pattern ? `Found ${n} file${n === 1 ? "" : "s"} for ${pattern}` : `Found ${n} file${n === 1 ? "" : "s"}`;
    }
    case "ls": return target ? `Listed ${target} (${n} item${n === 1 ? "" : "s"})` : `Listed ${n} item${n === 1 ? "" : "s"}`;
    case "bash":
    case "shell_command": {
      // Exclude the leading "(exit N)" tag so a long stdout's collapse matches what Ctrl+O shows
      // (lived raise-bar-9: "Ran shell command: bash src/long.sh" hid that 80 lines were waiting).
      const outLines = obs.split("\n").filter((line) => {
        const t = line.trim();
        return Boolean(t) && !/^\(exit \d+/.test(t);
      }).length;
      const base = target ? `Ran shell command: ${target}` : "Ran shell command";
      return `${base} (${outLines} line${outLines === 1 ? "" : "s"})`;
    }
    case "write_file": {
      // Prefer the tool's "+N" file line count (obs echoes at most 16 rows). Lived: collapse hid size.
      const m = obs.match(/\+(\d+)\)/);
      const fileLines = m ? Number(m[1]) : n;
      const base = target ? `Wrote ${target}` : "Wrote file";
      return `${base} (${fileLines} line${fileLines === 1 ? "" : "s"})`;
    }
    case "edit":
    case "multi_edit":
    case "apply_patch": return target ? `Edited ${target}` : "Applied file changes";
    case "web_search": {
      // Lived: "Searched web for … (ctrl+o to expand)" hid how much body was under the fold.
      const base = target ? `Searched web for ${target}` : "Searched the web";
      return `${base} (${n} line${n === 1 ? "" : "s"})`;
    }
    case "web_fetch": {
      // Lived raise-bar-10: Fetched https://example.com (ctrl+o to expand) with no size.
      const base = target ? `Fetched ${target}` : "Fetched web page";
      return `${base} (${n} line${n === 1 ? "" : "s"})`;
    }
    case "skill": return target ? `Loaded ${target} skill` : "Loaded skill";
    case "todo_write": return summarizeTodoWriteResult(obs, args);
    default: {
      // Generic/MCP tools: same honesty — collapse must name how much is under Ctrl+O.
      const base = `Completed ${describeToolCall(name, args)}`;
      return `${base} (${n} line${n === 1 ? "" : "s"})`;
    }
  }
}

/** Rebuild the transcript from saved messages - including tool CALLS and RESULTS, not just user +
 * assistant text. An interrupted coding turn is almost all tool_calls + tool results with no final
 * assistant text, so skipping them made a resumed session look empty ("the work is gone") even though
 * the agent context was intact. */
export const REPLAY_MAX_LINES = 80; // secondary logical-line guard; wrapped terminal rows are the primary cap
export const REPLAY_MAX_ROWS = 20; // a resume should leave room for the prompt/status, never refill the whole terminal
export const RESUME_MESSAGE_MAX_ROWS = 12; // rich rendering stays proportional to the viewport, never message bytes
export const RESUME_SUMMARY_AT = 0.6; // offer resume-from-summary once a session would fill >60% of the window

export interface BuildReplayOptions {
  /** `full` is the source-faithful /transcript view; `resume` is a bounded screen projection. */
  mode?: "full" | "resume";
  columns?: number;
  maxMessageRows?: number;
}

/** Reconstruct saved messages as display Lines. The canonical messages are never changed: resume mode
 * only changes their screen projection. It omits assistant commentary attached to a tool call (the
 * persisted progress stream that looked like leaked "think" after a crash), and row-bounds oversized
 * user/final-assistant prose. Opaque reasoning/provider_data is deliberately never a display source. */
export function buildReplayLines(messages: any[], nextId: () => number, options: BuildReplayOptions = {}): Line[] {
  const out: Line[] = [];
  const resume = options.mode === "resume";
  const columns = Math.max(20, Math.floor(options.columns ?? 80));
  const maxMessageRows = Math.max(4, Math.floor(options.maxMessageRows ?? RESUME_MESSAGE_MAX_ROWS));
  const toolById = new Map<string, { name: string; args: any; line: Line }>();
  let hiddenProgress = 0;
  const screenText = (text: string) => resume && wrappedRows(text, columns) > maxMessageRows
    ? tailByRows(text, maxMessageRows, columns)
    : text;

  for (const m of messages) {
    if (m.role === "user") {
      const t = contentToText(m.content);
      if (t.trim()) out.push({ id: nextId(), kind: "user", text: screenText(t) });
    } else if (m.role === "assistant") {
      const calls = m.tool_calls ?? [];
      const t = contentToText(m.content);
      if (t.trim()) {
        if (resume && calls.length) hiddenProgress++;
        else out.push({ id: nextId(), kind: "assistant", text: screenText(t) });
      }
      for (const tc of calls) {
        let args: any = {};
        try { args = isText(tc.function?.arguments) ? JSON.parse(tc.function.arguments) : (tc.function?.arguments ?? {}); } catch { /* keep {} */ }
        const name = tc.function?.name ?? "";
        const line: Line = { id: nextId(), kind: "tool_call", text: describeToolCall(name, args) };
        if (tc.id) toolById.set(tc.id, { name, args, line });
        out.push(line);
      }
    } else if (m.role === "tool") {
      const call = toolById.get(m.tool_call_id);
      const obs = contentToText(m.content).split("\n").slice(0, 400).join("\n");
      const summary = resultSummary(call?.name, obs, call?.args);
      if (resume && summary && call) {
        const combined: Line = { id: nextId(), kind: "tool_result", text: `${call.line.text}\n${obs}`, summary };
        const callIndex = out.indexOf(call.line);
        if (callIndex >= 0) out.splice(callIndex, 1, combined);
        else out.push(combined);
      } else {
        // Failures stay expanded under a tool_call header — paint that bullet red so a deny/error
        // is not preceded by a success-green ● (lived raise-bar-10 deny + interrupt).
        if (call && isToolFailure(obs)) call.line.failed = true;
        out.push({ id: nextId(), kind: "tool_result", text: obs });
      }
    }
  }
  if (hiddenProgress) out.push({
    id: nextId(),
    kind: "info",
    text: `... ${hiddenProgress} intermediate progress update${hiddenProgress === 1 ? "" : "s"} hidden on resume - /transcript to view the full thread ...`,
  });
  return out;
}

export interface ReplayOptions {
  columns?: number;
  maxRows?: number;
}

function wrappedRows(text: string, columns: number): number {
  return String(text).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
    .reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].length / columns)), 0);
}

function replayLineRows(line: Line, columns: number): number {
  if (line.kind === "tool_result" && line.summary) return 1;
  // Tool results render at most eight preview lines; assistant/user prose can wrap without a renderer cap.
  if (line.kind === "tool_result") return Math.min(9, wrappedRows(line.text, columns));
  const margin = line.kind === "assistant" || line.kind === "user" || line.kind === "tool_call" ? 2 : 0;
  return margin + wrappedRows(line.text, columns);
}

function tailByRows(text: string, rows: number, columns: number): string {
  if (rows <= 1) return "...";
  const parts = String(text).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const kept: string[] = [];
  let remaining = rows - 1; // reserve one row for the omission marker
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const chars = [...parts[i]];
    const height = Math.max(1, Math.ceil(chars.length / columns));
    if (height <= remaining) {
      kept.unshift(parts[i]);
      remaining -= height;
      continue;
    }
    kept.unshift(chars.slice(-remaining * columns).join(""));
    remaining = 0;
  }
  return `... [earlier content hidden; /transcript shows the full thread]${kept.length ? `\n${kept.join("\n")}` : ""}`;
}

export function replaySessionLines(messages: any[], nextId: () => number, options: ReplayOptions = {}): Line[] {
  const columns = Math.max(20, Math.floor(options.columns ?? 80));
  const maxRows = Math.max(6, Math.floor(options.maxRows ?? REPLAY_MAX_ROWS));
  const out = buildReplayLines(messages, nextId, {
    mode: "resume",
    columns,
    maxMessageRows: Math.min(RESUME_MESSAGE_MAX_ROWS, maxRows),
  });
  const kept: Line[] = [];
  let remaining = maxRows;
  let hidden = false;

  // Bound what is PRINTED by wrapped terminal rows, not message count. A real field session had only
  // 20 messages but one 45k-char assistant message, so the old 80-line cap still dumped hundreds of
  // physical rows. Walk backward to retain the useful tail and clip one oversized final line in place.
  for (let i = out.length - 1; i >= 0 && kept.length < REPLAY_MAX_LINES; i--) {
    const height = replayLineRows(out[i], columns);
    if (height <= remaining) {
      kept.unshift(out[i]);
      remaining -= height;
      continue;
    }
    hidden = true;
    if (!kept.length && remaining > 2) {
      kept.unshift({ ...out[i], text: tailByRows(out[i].text, remaining, columns) });
    }
    break;
  }
  if (kept.length < out.length) hidden = true;
  if (!hidden) return kept;
  const omitted = Math.max(0, out.length - kept.length);
  return [{
    id: nextId(),
    kind: "info",
    text: `... ${omitted || "some"} earlier line${omitted === 1 ? "" : "s"} in context (not re-printed) - /transcript to view the full thread ...`,
  }, ...kept];
}

export { recoverSessionTodos as recoverTodos } from "../adapters/session.ts";

/** Cap live-streamed text to a bounded tail so re-parsing + re-rendering it every frame stays O(1),
 * not O(n): a long reasoning trace or a huge answer must NEVER block the event loop, or Esc/Ctrl+C
 * go dead and the only escape is killing the terminal. The full text is still committed to the
 * transcript verbatim when the stream finishes. */
export function renderTail(s: string, maxChars = 4000): string {
  if (s.length <= maxChars) return s;
  const cut = s.indexOf("\n", s.length - maxChars);
  return "...\n" + (cut >= 0 ? s.slice(cut + 1) : s.slice(s.length - maxChars));
}

/** Clamp streamed text to the last `maxRows` terminal rows (wrap-aware). The live streaming region must
 * never grow TALLER than the viewport: when it does, Ink can't update it in place and redraws from the
 * top every frame — the "scroll jumps back to the top while streaming" bug. The full text still commits
 * to <Static> verbatim when the stream finishes, so nothing shown here is lost. */
export function clampToRows(text: string, maxRows: number, cols: number): string {
  if (maxRows <= 0) return "";
  const w = Math.max(1, cols);
  const lines = text.split("\n");
  let used = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const h = Math.max(1, Math.ceil(([...lines[i]].length || 1) / w)); // rows this line takes once wrapped
    if (used + h > maxRows) { kept.unshift("..."); break; }
    kept.unshift(lines[i]);
    used += h;
  }
  return kept.join("\n");
}
