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

/** A 1-line collapse summary for read-type tool results (Claude-style); full stays under Ctrl+O. */
export function resultSummary(name: string | undefined, obs: string): string | undefined {
  if (/^(Error|Blocked|Denied)/.test(obs)) return undefined; // show errors in full
  const n = obs.split("\n").filter((l) => l.trim()).length;
  switch (name) {
    case "read_file": return `Read ${n} line${n === 1 ? "" : "s"}`;
    case "search": return `Found ${n} match${n === 1 ? "" : "es"}`;
    case "glob": return `${n} file${n === 1 ? "" : "s"}`;
    case "ls": return `${n} item${n === 1 ? "" : "s"}`;
    default: return undefined; // edit/write diffs, bash output, web_* shown as-is
  }
}

/** Rebuild the FULL transcript from saved messages - including tool CALLS and RESULTS, not just user +
 * assistant text. An interrupted coding turn is almost all tool_calls + tool results with no final
 * assistant text, so skipping them made a resumed session look empty ("the work is gone") even though
 * the agent context was intact. This reconstructs it exactly as it looked live. */
export const REPLAY_MAX_LINES = 80; // display cap on a resumed thread - the agent keeps ALL messages in context
export const RESUME_SUMMARY_AT = 0.6; // offer resume-from-summary once a session would fill >60% of the window
/** Reconstruct the FULL transcript (every message -> a Line) with NO display bound. Used both by the
 * bounded resume replay below and by the /transcript viewer, which shows the whole thread on demand. */
export function buildReplayLines(messages: any[], nextId: () => number): Line[] {
  const out: Line[] = [];
  const toolById = new Map<string, string>(); // tool_call_id -> tool name (to summarize its result)
  for (const m of messages) {
    if (m.role === "user") {
      const t = contentToText(m.content);
      if (t.trim()) out.push({ id: nextId(), kind: "user", text: t });
    } else if (m.role === "assistant") {
      const t = contentToText(m.content);
      if (t.trim()) out.push({ id: nextId(), kind: "assistant", text: t });
      for (const tc of m.tool_calls ?? []) {
        let args: Record<string, any> = {};
        try { args = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.function?.arguments ?? {}); } catch { /* keep {} */ }
        const name = tc.function?.name ?? "";
        if (tc.id) toolById.set(tc.id, name);
        out.push({ id: nextId(), kind: "tool_call", text: describeToolCall(name, args) });
      }
    } else if (m.role === "tool") {
      const name = toolById.get(m.tool_call_id);
      const obs = contentToText(m.content).split("\n").slice(0, 400).join("\n");
      out.push({ id: nextId(), kind: "tool_result", text: obs, summary: resultSummary(name, obs) });
    }
  }
  return out;
}

export function replaySessionLines(messages: any[], nextId: () => number): Line[] {
  const out = buildReplayLines(messages, nextId);
  // Bound the DISPLAY to the most recent lines: rendering a very long thread's hundreds of <Static>
  // items at once is what lagged the picker after selecting. The whole conversation is still in the
  // agent's context (this only trims what's re-printed on screen); /transcript shows all of it, and a
  // terminal's own scrollback holds whatever WAS printed. (Native scrollback can't be prepended into -
  // an inline <Static> app never receives scroll events - so "load more above on scroll up" isn't
  // possible here the way a GUI chat app does it; the viewer is the terminal-native answer.)
  if (out.length > REPLAY_MAX_LINES) {
    const hidden = out.length - REPLAY_MAX_LINES;
    return [{ id: nextId(), kind: "info", text: `... ${hidden} earlier line${hidden > 1 ? "s" : ""} in context (not re-printed) - /transcript to view the full thread ...` }, ...out.slice(-REPLAY_MAX_LINES)];
  }
  return out;
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
