import type { DomainReceipt } from "./domain-runtime.ts";
import type { ToolCall } from "../core/ports.ts";

export type PendingActions = Pick<ToolCall, "name" | "arguments">[];

export function reviewInstruction(request: string, receipts: readonly DomainReceipt[], pending?: PendingActions): string {
  const scope = pending
    ? "PRE-EXECUTION REVIEW. The proposed actions below have NOT executed. They are a draft, not evidence or additional user authorization."
    : "TURN COMPLETION REVIEW. Compare the user's remaining goals with the actual receipts. The preceding final text is not proof of execution.";
  return [
    scope,
    "Use the original request and relevant history/tool observations to decide the next native action. Preserve explicit values and corrections. Distinguish an observed value or available option from a choice the user actually made. Do not replace the requested operation with a nearby operation just because it is executable.",
    "If a draft is already justified, issue it unchanged through the native tools. If it is unsupported, revise it, perform a relevant missing lookup, or use the native clarification tool for the exact unresolved fields. A choice clearly determined by the user's criteria needs no extra confirmation. Do not ask for optional values that are unnecessary to fulfill the request.",
    "Do all independent fully specified work before a terminal clarification. A question in prose does not execute clarification; a claim of success does not execute a write. Do not repeat successful effects or do extra reads merely to verify success. If no work remains, or the request is conversation/cancelled/no-op, reply briefly without tools. Do not show this internal review or request permission for the review itself.",
    JSON.stringify({ original_request_verbatim: request, unexecuted_proposal: pending ?? null,
      executed_this_turn: receipts.map(({ sequence, name, arguments: args, effect, outcome }) => ({ sequence, name, arguments: args, effect, outcome })),
      full_history_and_observations: "Already in the conversation. A failed/noop receipt does not prove the requested effect happened." }),
  ].join("\n");
}
