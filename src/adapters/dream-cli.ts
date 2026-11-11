/** Explicit host command; task-session admission, not model arguments, owns the memory scope. */
import type { NekoConfig } from "./config.ts";
import { getProvider } from "./providers.ts";
import { loadTaskSession, taskSessionConfigId, taskSessionContextMode, type TaskRuntimeInput, type TaskSessionRuntime } from "./task-session.ts";
import { structuredScopeDigest } from "../core/context/state.ts";
import { buildDreamInput } from "./dream-input.ts";
import { DreamStore } from "./dream-store.ts";
import { prepareDream } from "./dream.ts";

export const DREAM_USAGE = "neko dream preview|prepare <task-session-id> | show|apply|rollback <task-session-id> <candidate-id>";
export async function dreamCommand(cfg: NekoConfig, root: string, args: string[], signal?: AbortSignal): Promise<string> {
  const [action, sessionId, candidateId] = args;
  if (!sessionId || !["preview", "prepare", "show", "apply", "rollback"].includes(action)
    || (action === "preview" || action === "prepare" ? args.length !== 2 : args.length !== 3)) throw new Error(DREAM_USAGE);
  let input: TaskRuntimeInput | undefined;
  const session = await loadTaskSession({ home: cfg.resolvedHome, root, sessionId, authorityId: "local",
    configId: taskSessionConfigId(cfg), contextMode: taskSessionContextMode(cfg),
    runtimeFactory: task => {
      input = task;
      const runtime: TaskSessionRuntime = {
        getMessages: () => task.messages,
        getSourceEvents: () => task.sourceEvents,
        getStructuredContextState: task.contextMode ? () => task.contextState ?? { version: 1,
          journal: { version: 1, scope: structuredScopeDigest(task.scope.id, task.scope.canonicalRoot, task.scope.executionAuthorityId), head: null }, capsule: null } : undefined,
        assertQuiescent: () => {}, close: () => {},
      };
      return runtime;
    },
  });
  try {
    if (!input) throw new Error("Task runtime was not loaded");
    const secrets = [cfg.apiKey, ...cfg.childSecretEnvNames.map(name => process.env[name] ?? "")].filter(Boolean);
    const store = new DreamStore(cfg.resolvedHome, input.scope);
    if (action === "show") {
      const candidate = store.read(candidateId);
      return JSON.stringify({ id: candidate.id, status: store.status(candidateId), taskId: candidate.taskId,
        coverage: candidate.input.coverage, provider: candidate.provider, model: candidate.model, before: candidate.before, after: candidate.after });
    }
    if (action === "rollback") { store.rollback(candidateId); return JSON.stringify({ id: candidateId, status: store.status(candidateId) }); }
    if (action === "apply") {
      if (store.status(candidateId) === "applied") return JSON.stringify({ id: candidateId, status: "already_applied" });
      const current = await buildDreamInput(cfg.resolvedHome, input, secrets);
      return JSON.stringify({ id: candidateId, status: store.apply(candidateId, current) });
    }
    if (action === "preview") return JSON.stringify({ mode: "local-only", modelCalls: 0, input: await buildDreamInput(cfg.resolvedHome, input, secrets) });
    // Explicit prepare authorizes one logical request, not a fan-out or an agent loop.
    if (cfg.provider === "moa") throw new Error("Dream prepare needs a single-provider profile, not mixture-of-agents");
    cfg.data.max_tokens = cfg.maxTokens > 0 ? Math.min(cfg.maxTokens, 4096) : 4096;
    cfg.data.max_retries = 0;
    cfg.data.offline_retry_seconds = 0;
    const provider = getProvider(cfg);
    try {
      const result = await prepareDream({ home: cfg.resolvedHome, task: input, provider,
        providerName: cfg.provider, model: cfg.model, secrets, signal, maxInputTokens: cfg.contextWindow - cfg.maxTokens - 2000 });
      return JSON.stringify({ status: result.candidate ? "prepared" : "nothing_to_remember", id: result.candidate?.id ?? null,
        taskId: input.taskId, modelCalls: 1, coverage: result.input.coverage, usage: result.usage,
        note: result.candidate?.after ?? null, notice: "Not activated. Review with dream show, then explicitly dream apply." });
    } finally { await provider.dispose?.(); }
  } finally { await session.close(); }
}
