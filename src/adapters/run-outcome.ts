import type { AgentCompletionStatus } from "../core/agent.ts";

export interface HeadlessRunOutcome {
  exitCode: 0 | 1;
  warning?: string;
}

/** Shell automation needs a machine-readable failure even when the model honestly returns a useful
 * partial result. Interactive users keep the conversational result; non-interactive callers get 1
 * only for an explicit denied action or controller-proven validation debt. */
export function headlessRunOutcome(
  headless: boolean,
  status: AgentCompletionStatus,
  denials = 0,
): HeadlessRunOutcome {
  if (!headless || (status.ok && denials === 0)) return { exitCode: 0 };
  const reasons: string[] = [];
  if (denials > 0) {
    reasons.push(`${denials} gated tool call${denials === 1 ? " was" : "s were"} auto-denied because explicit approval was unavailable; re-run interactively to review it`);
  }
  if (!status.ok) {
    const validation = status.reason === "validation_failed"
      ? "the recognized validator failed after the latest mutation"
      : "the latest mutation was not followed by a successful recognized validator";
    reasons.push(validation + (status.command ? ` (command: ${JSON.stringify(status.command)})` : ""));
  }
  return {
    exitCode: 1,
    warning: `[neko] run incomplete: ${reasons.join("; ")}.`,
  };
}
