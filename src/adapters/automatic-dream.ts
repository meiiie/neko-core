/** Host-owned post-turn consolidation. No agent tools, timer, or legacy-session migration. */
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Agent } from "../core/agent.ts";
import { coreMemoryBlock, memoryEnabled } from "../core/memory.ts";
import { createTaskScope, type TaskScope } from "../core/task-scope.ts";
import type { ToolRegistry } from "../core/tool-runtime.ts";
import type { Provider } from "../core/ports.ts";
import type { NekoConfig } from "./config.ts";
import { getProvider } from "./providers.ts";
import type { TaskRuntimeInput } from "./task-session.ts";
import { prepareDream } from "./dream.ts";
import { buildDreamInput } from "./dream-input.ts";
import { DreamStore } from "./dream-store.ts";

export type DreamMode = "auto" | "manual" | "off";
export function dreamMode(cfg: NekoConfig): DreamMode {
  const value = cfg.data.dream_mode ?? "auto";
  if (value !== "auto" && value !== "manual" && value !== "off") throw new Error("dream_mode must be auto, manual, or off");
  return value;
}

/** Session IDs are host metadata, never model-selected scope or shared project identity. */
export function legacyDreamScope(sessionId: string, root: string, authority = "local"): TaskScope {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid Dream session identity");
  const physical = realpathSync.native(root);
  const canonical = process.platform === "win32" ? physical.toLowerCase() : physical;
  const id = `session-${createHash("sha256").update(JSON.stringify([sessionId, canonical, authority])).digest("hex")}`;
  return createTaskScope(id, root);
}

export interface AutomaticDreamOptions {
  cfg: NekoConfig;
  registry: ToolRegistry;
  agent: Agent;
  sessionId: string;
  authority?: string;
  signal?: AbortSignal;
  /** Restricted embedding hosts must opt in through their own authority contract. */
  restricted?: boolean;
  notify?: (message: string) => void;
  providerFactory?: (cfg: NekoConfig) => Provider;
  taskInput?: () => TaskRuntimeInput;
}

export function bindAutomaticDream(options: Pick<AutomaticDreamOptions, "cfg" | "registry" | "sessionId" | "authority" | "restricted">): TaskScope | undefined {
  const { cfg, registry } = options;
  if (options.restricted || dreamMode(cfg) === "off" || !memoryEnabled(cfg.resolvedHome)) {
    registry.bindDreamScope(undefined);
    return undefined;
  }
  const scope = registry.taskScope ?? legacyDreamScope(options.sessionId, registry.root, options.authority);
  registry.bindDreamScope(scope);
  return scope;
}

export function automaticDreamRecall(registry: ToolRegistry): string {
  return !registry.taskScope && registry.dreamScope && registry.isToolAvailable("memory")
    ? coreMemoryBlock(registry.memoryHome, registry.dreamScope) : "";
}

/** Awaited before accepting another turn. Failure is visible but never replaces the user's answer. */
export async function runAutomaticDream(options: AutomaticDreamOptions): Promise<string> {
  const { cfg, registry, agent } = options;
  if (options.restricted || dreamMode(cfg) !== "auto" || registry.mode === "plan"
    || !registry.isToolAvailable("memory") || !memoryEnabled(cfg.resolvedHome)
    || options.signal?.aborted || !agent.completionStatus.ok) return "skipped";
  const notify = (message: string) => { try { options.notify?.(message); } catch { /* UI delivery cannot change memory publication. */ } };
  let provider: Provider | undefined;
  try {
    const configuredHome = cfg.resolvedHome;
    const memoryHome = realpathSync.native(configuredHome);
    if (realpathSync.native(registry.memoryHome) !== memoryHome) throw new Error("Dream memory home mismatch");
    const scope = registry.dreamScope ?? bindAutomaticDream(options);
    if (!scope) return "skipped";
    const task = (): TaskRuntimeInput => {
      const value = options.taskInput?.() ?? { sessionId: options.sessionId, taskId: scope.id,
        label: "Automatic session Dream", root: scope.canonicalRoot, scope,
        messages: agent.messages, sourceEvents: registry.taskScope ? agent.compactionSourceEvents() : [] };
      if (value.scope !== scope || value.taskId !== scope.id || value.root !== scope.canonicalRoot) throw new Error("Dream task changed");
      return value;
    };
    const secrets = [cfg.apiKey, ...cfg.childSecretEnvNames.map(name => process.env[name] ?? "")].filter(Boolean);
    const input = await buildDreamInput(memoryHome, task(), secrets);
    if (!input.sources.some(source => source.kind === "user") || cfg.provider === "moa") return "skipped";
    const store = new DreamStore(memoryHome, scope);
    // Deduplicate original recent data, not refreshed system context or the recalled note.
    // Retained citations disappear after rollback and must not re-trigger the same turn.
    const automaticDigest = createHash("sha256").update(JSON.stringify(input.sources
      .slice(input.coverage.retained ?? 0).map(source => [source.kind, source.text]))).digest("hex");
    if (!store.claimAutomatic(automaticDigest)) return "unchanged";
    notify("Dream: consolidating this session automatically (one additional model request; set dream_mode=manual or off to disable).\n");
    const bounded = cfg.withModel(cfg.model);
    bounded.data.max_tokens = cfg.maxTokens > 0 ? Math.min(cfg.maxTokens, 4096) : 4096;
    bounded.data.max_retries = 0;
    bounded.data.offline_retry_seconds = 0;
    provider = (options.providerFactory ?? getProvider)(bounded);
    const profileIdentity = JSON.stringify([cfg.provider, cfg.model, cfg.baseUrl]);
    const result = await prepareDream({ home: memoryHome, task: task(), provider,
      providerName: cfg.provider, model: cfg.model, secrets, signal: options.signal,
      maxInputTokens: bounded.contextWindow - bounded.maxTokens - 2000,
      onUsage: usage => agent.cost.add(usage) });
    if (!result.candidate) { notify("Dream: nothing to retain.\n"); return "empty"; }
    options.signal?.throwIfAborted();
    if (dreamMode(cfg) !== "auto" || String(registry.mode) === "plan" || !registry.isToolAvailable("memory") || registry.dreamScope !== scope
      || cfg.resolvedHome !== configuredHome || realpathSync.native(cfg.resolvedHome) !== memoryHome
      || realpathSync.native(registry.memoryHome) !== memoryHome
      || profileIdentity !== JSON.stringify([cfg.provider, cfg.model, cfg.baseUrl])) throw new Error("Dream scope changed");
    const current = await buildDreamInput(memoryHome, task(), secrets);
    const status = store.apply(result.candidate.id, current, automaticDigest);
    notify(`Dream: ${status}; candidate ${result.candidate.id}. Inspect/rollback with neko dream show|rollback ${registry.taskScope ? options.sessionId : `${options.authority === "acp" ? "acp-session" : "session"}:${options.sessionId}`} <candidate-id>.\n`);
    return status;
  } catch {
    notify("Dream: consolidation did not activate; previous memory remains unchanged. Inspect the session before retrying.\n");
    return "failed";
  } finally {
    try { await provider?.dispose?.(); } catch { /* the foreground answer remains available */ }
  }
}
