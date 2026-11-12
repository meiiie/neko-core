/** Host-owned bounded consolidation. Interactive hosts schedule; one-shot CLI drains explicitly. */
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
import { DreamPreparationError, prepareDream } from "./dream.ts";
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
  /** Internal immutable admitted snapshot; live taskInput remains the activation guard. */
  snapshot?: TaskRuntimeInput;
  /** Host generation guard, checked immediately before publishing. */
  isCurrent?: () => boolean;
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

/** Clone data, preserving only the host-issued scope capability by reference. */
function snapshotTask(value: TaskRuntimeInput): TaskRuntimeInput {
  const { scope, ...data } = value;
  return { ...structuredClone(data), scope };
}

function readTask(options: AutomaticDreamOptions): TaskRuntimeInput {
  const scope = options.registry.dreamScope ?? bindAutomaticDream(options);
  if (!scope) throw new Error("Dream scope unavailable");
  const value = options.taskInput?.() ?? { sessionId: options.sessionId, taskId: scope.id,
    label: "Automatic session Dream", root: scope.canonicalRoot, scope,
    messages: options.agent.messages,
    sourceEvents: options.registry.taskScope ? options.agent.compactionSourceEvents() : [] };
  if (value.scope !== scope || value.taskId !== scope.id || value.root !== scope.canonicalRoot)
    throw new Error("Dream task changed");
  return value;
}

interface DreamWorker {
  generation: number;
  controller?: AbortController;
  pending?: { options: AutomaticDreamOptions; generation: number };
  running?: Promise<void>;
}
const workers = new WeakMap<ToolRegistry, DreamWorker>();

/** Cancel publication synchronously; remote providers may still bill an in-flight request. */
export function cancelAutomaticDream(registry: ToolRegistry): void {
  const worker = workers.get(registry);
  if (!worker) return;
  worker.generation++;
  worker.pending = undefined;
  worker.controller?.abort();
}

/** No daemon: hosts cancel on close. At most one active and one latest queued snapshot. */
export function scheduleAutomaticDream(options: AutomaticDreamOptions): void {
  if (options.restricted || dreamMode(options.cfg) !== "auto" || !options.agent.completionStatus.ok) return;
  let snapshot: TaskRuntimeInput;
  try { snapshot = snapshotTask(readTask(options)); } catch { return; }
  let worker = workers.get(options.registry);
  if (!worker) { worker = { generation: 0 }; workers.set(options.registry, worker); }
  const current = worker;
  const generation = ++current.generation;
  current.controller?.abort();
  const identity = JSON.stringify([options.cfg.provider, options.cfg.model, options.cfg.baseUrl, options.cfg.resolvedHome]);
  const providerConfig = options.cfg.withModel(options.cfg.model);
  Object.assign(providerConfig.data, structuredClone(providerConfig.data));
  providerConfig.data.max_tokens = providerConfig.maxTokens > 0 ? Math.min(providerConfig.maxTokens, 4096) : 4096;
  providerConfig.data.max_retries = 0;
  providerConfig.data.offline_retry_seconds = 0;
  current.pending = { generation, options: { ...options, snapshot,
    providerFactory: () => (options.providerFactory ?? getProvider)(providerConfig),
    isCurrent: () => current.generation === generation && identity === JSON.stringify([
      options.cfg.provider, options.cfg.model, options.cfg.baseUrl, options.cfg.resolvedHome]) && (options.isCurrent?.() ?? true),
    notify: message => { if (current.generation === generation) options.notify?.(message); },
  } };
  startWorker(current);
}

function startWorker(current: DreamWorker): void {
  if (current.running) return;
  // Yield through host finally blocks before starting a paid request.
  current.running = (async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    while (current.pending) {
      const job = current.pending;
      current.pending = undefined;
      if (job.generation !== current.generation) continue;
      const controller = new AbortController();
      current.controller = controller;
      const requests: Promise<unknown>[] = [];
      const factory = job.options.providerFactory!;
      const signal = job.options.signal ? AbortSignal.any([controller.signal, job.options.signal]) : controller.signal;
      try {
        await runAutomaticDream({ ...job.options, signal, providerFactory: cfg => {
          const provider = factory(cfg);
          return { ...provider, complete: (...args) => {
            const request = provider.complete(...args);
            requests.push(request);
            return request;
          }, dispose: provider.dispose?.bind(provider) };
        } });
      } catch { /* Snapshot or transport failure must never escape into the host. */ }
      // A provider ignoring AbortSignal cannot create overlapping paid requests.
      await Promise.allSettled(requests);
      current.controller = undefined;
    }
  })().finally(() => {
    current.running = undefined;
    if (current.pending) startWorker(current);
  });
}

/** Test/shutdown drain, never awaited by interactive prompt admission. */
export async function settleAutomaticDream(registry: ToolRegistry): Promise<void> {
  const worker = workers.get(registry);
  while (worker?.running) await worker.running;
}

/** One bounded job; failure never replaces the foreground answer. CLI explicitly drains it. */
export async function runAutomaticDream(options: AutomaticDreamOptions): Promise<string> {
  const { cfg, registry, agent } = options;
  if (options.restricted || dreamMode(cfg) !== "auto" || registry.mode === "plan"
    || !registry.isToolAvailable("memory") || !memoryEnabled(cfg.resolvedHome)
    || options.signal?.aborted || !agent.completionStatus.ok) return "skipped";
  const notify = (message: string) => { try { options.notify?.(message); } catch { /* UI delivery cannot change memory publication. */ } };
  let provider: Provider | undefined;
  let phase = "input_rejected";
  let releaseLease: (() => void) | undefined;
  let store: DreamStore | undefined;
  const record = (status: string, reason?: string, candidateId?: string) => {
    try { store?.recordAutomaticStatus(status, reason, candidateId); } catch { /* Diagnostics never bypass memory-off/revocation or affect publication. */ }
  };
  const requests: Promise<unknown>[] = [];
  try {
    const configuredHome = cfg.resolvedHome;
    const memoryHome = realpathSync.native(configuredHome);
    if (realpathSync.native(registry.memoryHome) !== memoryHome) throw new Error("Dream memory home mismatch");
    const scope = registry.dreamScope ?? bindAutomaticDream(options);
    if (!scope) return "skipped";
    const task = () => readTask(options);
    const snapshot = options.snapshot ?? snapshotTask(task());
    if (snapshot.scope !== scope || options.isCurrent?.() === false) return "stale";
    const secrets = [cfg.apiKey, ...cfg.childSecretEnvNames.map(name => process.env[name] ?? "")].filter(Boolean);
    store = new DreamStore(memoryHome, scope);
    const revision = store.revision();
    const input = await buildDreamInput(memoryHome, snapshot, secrets);
    if (!input.sources.some(source => source.kind === "user") || cfg.provider === "moa") return "skipped";
    // Deduplicate original recent data, not refreshed system context or the recalled note.
    // Retained citations disappear after rollback and must not re-trigger the same turn.
    const automaticDigest = createHash("sha256").update(JSON.stringify(input.sources
      .slice(input.coverage.retained ?? 0).map(source => [source.kind, source.text]))).digest("hex");
    releaseLease = store.acquireAutomaticLease();
    if (!releaseLease) { notify("Dream: skipped (another automatic request owns this session).\n"); return "busy"; }
    if (!store.claimAutomatic(automaticDigest)) return "unchanged";
    record("running");
    phase = "provider_error";
    notify("Dream: consolidating this session automatically (one additional model request; set dream_mode=manual or off to disable).\n");
    const bounded = cfg.withModel(cfg.model);
    bounded.data.max_tokens = cfg.maxTokens > 0 ? Math.min(cfg.maxTokens, 4096) : 4096;
    bounded.data.max_retries = 0;
    bounded.data.offline_retry_seconds = 0;
    provider = (options.providerFactory ?? getProvider)(bounded);
    const profileIdentity = JSON.stringify([cfg.provider, cfg.model, cfg.baseUrl]);
    const transport = provider;
    const tracked: Provider = { complete: (...args) => {
      const request = transport.complete(...args);
      requests.push(request);
      return request;
    } };
    const result = await prepareDream({ home: memoryHome, task: snapshot, provider: tracked,
      providerName: cfg.provider, model: cfg.model, secrets, signal: options.signal,
      maxInputTokens: bounded.contextWindow - bounded.maxTokens - 2000,
      onUsage: usage => agent.cost.add(usage) });
    phase = "stale_context";
    if (!result.candidate) { record("empty"); notify("Dream: nothing to retain.\n"); return "empty"; }
    options.signal?.throwIfAborted();
    if (options.isCurrent?.() === false) throw new Error("Dream generation changed");
    if (dreamMode(cfg) !== "auto" || String(registry.mode) === "plan" || !registry.isToolAvailable("memory") || registry.dreamScope !== scope
      || cfg.resolvedHome !== configuredHome || realpathSync.native(cfg.resolvedHome) !== memoryHome
      || realpathSync.native(registry.memoryHome) !== memoryHome
      || profileIdentity !== JSON.stringify([cfg.provider, cfg.model, cfg.baseUrl])) throw new Error("Dream scope changed");
    const current = await buildDreamInput(memoryHome, task(), secrets);
    options.signal?.throwIfAborted();
    if (options.isCurrent?.() === false) throw new Error("Dream generation changed");
    const status = store.apply(result.candidate.id, current, automaticDigest, revision);
    record(status, undefined, result.candidate.id);
    notify(`Dream: ${status}; candidate ${result.candidate.id}. Inspect/rollback with neko dream show|rollback ${registry.taskScope ? options.sessionId : `${options.authority === "acp" ? "acp-session" : "session"}:${options.sessionId}`} <candidate-id>.\n`);
    return status;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const reason = options.signal?.aborted ? "cancelled" : name === "TimeoutError" ? "timeout" : error instanceof DreamPreparationError ? error.reason : phase;
    record("failed", reason);
    // Never echo arbitrary exception text, model output, paths, or credentials.
    notify(`Dream: consolidation did not activate (${reason}); previous memory remains unchanged. Inspect the session before retrying.\n`);
    return "failed";
  } finally {
    try { await provider?.dispose?.(); } catch { /* the foreground answer remains available */ }
    if (releaseLease) {
      const release = releaseLease;
      // Do not recycle a paid-request lease merely because our local wait aborted.
      void Promise.allSettled(requests).then(() => { try { release(); } catch { /* fail closed; next authorized acquire can reclaim retired ownership */ } });
    }
  }
}
