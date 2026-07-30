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

/** Flatten a message's content (string or vision-array) to display text. */
export function contentToText(c: any): string {
  if (typeof c === "string") return c;
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

const short = (value: unknown, cap = 80) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > cap ? `${text.slice(0, Math.max(0, cap - 3))}...` : text;
};

/** One compact, past-tense outcome for every successful activity; full call + output stays under Ctrl+O. */
export function resultSummary(
  name: string | undefined,
  obs: string,
  args: Record<string, any> = {},
): string | undefined {
  if (!name || isToolFailure(obs) || name === "todo_write" || name === "update_plan" || name === "memory") return undefined;
  const background = obs.match(/^Running in background \[([^\]]+)\]:\s*(.+)$/m);
  const n = obs.trim() === "(no matches)" ? 0 : obs.split("\n").filter((line) => line.trim()).length;
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
    case "shell_command": return target ? `Ran shell command: ${target}` : "Ran shell command";
    case "write_file": return target ? `Wrote ${target}` : "Wrote file";
    case "edit":
    case "multi_edit":
    case "apply_patch": return target ? `Edited ${target}` : "Applied file changes";
    case "web_search": return target ? `Searched web for ${target}` : "Searched the web";
    case "web_fetch": return target ? `Fetched ${target}` : "Fetched web page";
    case "skill": return target ? `Loaded ${target} skill` : "Loaded skill";
    default: return `Completed ${describeToolCall(name, args)}`;
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
  const toolById = new Map<string, { name: string; args: Record<string, any>; line: Line }>();
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
        let args: Record<string, any> = {};
        try { args = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.function?.arguments ?? {}); } catch { /* keep {} */ }
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

/** Recover the todo list from saved messages: the last todo_write tool_call carries the plan in its
 * arguments. The registry (rebuilt on resume) starts with empty todos, so without this a resumed
 * session loses its task tracker - the "handoff state" that lets you (and the agent) pick up the
 * interrupted work (Handoff Debt, arXiv 2606.02875). Returns [] if the session had no todos. */
export function recoverTodos(messages: any[]): { content: string; status: string }[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const tc of messages[i]?.tool_calls ?? []) {
      if (tc.function?.name !== "todo_write") continue;
      try {
        const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        if (Array.isArray(args?.todos)) return args.todos.map((t: any) => ({ content: String(t?.content ?? ""), status: String(t?.status ?? "pending") }));
      } catch { /* keep scanning */ }
    }
  }
  return [];
}

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
