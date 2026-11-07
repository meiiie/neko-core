import { isJsonObject, type JsonObject, type JsonValue } from "../shared/wire.ts";

export interface DomainHistoryTurn {
  role: "user" | "assistant";
  text?: string;
  tool_calls?: { name: string; arguments: JsonObject }[];
  tool_results?: JsonValue[];
}

export interface DomainHistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

/** Only host-supplied historical observations enter native tool history. Never parse
 * assistant prose into results, and never execute historical calls again. */
export function nativeDomainHistory(turns: readonly DomainHistoryTurn[], namespace: string): DomainHistoryMessage[] {
  if (!/^[a-z][a-z0-9_]*$/.test(namespace)) throw new Error("Invalid domain namespace");
  const messages: DomainHistoryMessage[] = [];
  turns.forEach((turn, index) => {
    const calls = turn.tool_calls ?? [];
    const results = turn.tool_results ?? [];
    if (!["user", "assistant"].includes(turn.role) || (calls.length && turn.role !== "assistant")
        || calls.length !== results.length) throw new Error("Incomplete or invalid domain history");
    if (!calls.length) {
      messages.push({ role: turn.role, content: turn.text ?? "" });
      return;
    }
    const native = calls.map((call, ordinal) => {
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(call.name)
          || !isJsonObject(call.arguments)) {
        throw new Error("Invalid historical call");
      }
      return { id: `history_${index}_${ordinal}`, type: "function" as const,
        function: { name: `mcp__${namespace}__${call.name}`, arguments: JSON.stringify(call.arguments) } };
    });
    messages.push({ role: "assistant", content: turn.text || null, tool_calls: native });
    results.forEach((result, ordinal) => messages.push({
      role: "tool", tool_call_id: native[ordinal].id, content: JSON.stringify(result),
    }));
  });
  return messages;
}
