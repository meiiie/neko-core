/** One explicit bounded model request. No Agent, tool registry, scheduler, or hidden repair calls. */
import type { Provider } from "../core/ports.ts";
import { estimateRequestTokens } from "../core/agent-constants.ts";
import type { Usage } from "../core/cost.ts";
import { assertTaskScope } from "../core/task-scope.ts";
import { memoryEnabled } from "../core/memory.ts";
import { DREAM_PROMPT, parseDreamProposal, type DreamInput } from "../core/dream.ts";
import type { TaskRuntimeInput } from "./task-session.ts";
import { buildDreamInput } from "./dream-input.ts";
import { DreamStore, type DreamCandidate } from "./dream-store.ts";

export interface PrepareDreamOptions {
  home: string;
  task: TaskRuntimeInput;
  provider: Provider;
  providerName: string;
  model: string;
  secrets?: readonly string[];
  /** Host budget after response/policy reserves, checked before any paid request. */
  maxInputTokens?: number;
  signal?: AbortSignal;
  /** Account received usage even when validation rejects the response. */
  onUsage?: (usage: Usage | undefined) => void;
}
export class DreamPreparationError extends Error {
  constructor(readonly reason: "input_budget" | "invalid_response", message: string) { super(message); this.name = "DreamPreparationError"; }
}
export interface DreamPreparation { input: DreamInput; candidate: DreamCandidate | null; usage?: Usage }
export async function prepareDream(options: PrepareDreamOptions): Promise<DreamPreparation> {
  options.signal?.throwIfAborted();
  const input = await buildDreamInput(options.home, options.task, options.secrets);
  if (!input.sources.length) throw new Error("No original evidence fits this task's dream window");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  signal.throwIfAborted();
  const messages = [
    { role: "system", content: `${DREAM_PROMPT}\nAllowed memory filenames for corrects and related: ${JSON.stringify(input.memories.map(memory => memory.name))}. If this list is empty, both fields must be [].` },
    { role: "user", content: JSON.stringify(input) },
  ];
  const estimated = estimateRequestTokens(messages);
  if (options.maxInputTokens !== undefined && (!Number.isSafeInteger(options.maxInputTokens)
    || options.maxInputTokens <= 0 || estimated > options.maxInputTokens)) throw new DreamPreparationError("input_budget", "Dream input exceeds the configured model context budget; no request sent");
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(signal.reason); });
  signal.addEventListener("abort", rejectAbort, { once: true });
  let response;
  try {
    signal.throwIfAborted();
    const request = options.provider.complete(messages, [], undefined, signal).then(value => {
      // A provider may return after cancellation. Count received usage exactly once.
      options.onUsage?.(value.usage);
      return value;
    });
    response = await Promise.race([request, aborted]);
  } finally { signal.removeEventListener("abort", rejectAbort); }
  signal.throwIfAborted();
  assertTaskScope(options.task.scope);
  if (!memoryEnabled(options.home)) throw new Error("Memory is off");
  if (response.truncated || response.tool_calls.length || !response.content) throw new DreamPreparationError("invalid_response", "Dream response was incomplete or attempted tools; no candidate saved");
  let proposal;
  try { proposal = parseDreamProposal(response.content, input, options.secrets); }
  catch { throw new DreamPreparationError("invalid_response", "Dream response failed validation; no candidate saved"); }
  if (!proposal.claims.length) return { input, candidate: null, usage: response.usage };
  const current = await buildDreamInput(options.home, options.task, options.secrets);
  if (current.evidenceDigest !== input.evidenceDigest) throw new Error("Dream source snapshot changed while preparing");
  signal.throwIfAborted();
  const candidate = new DreamStore(options.home, options.task.scope).prepare(input, proposal, { provider: options.providerName, model: options.model });
  return { input, candidate, usage: response.usage };
}
