/**
 * Managed SearXNG sidecar - the Ollama pattern applied to search: the heavy backend loads ON DEMAND
 * and unloads after an idle window, so the power-up costs zero RAM while unused and the user never
 * touches Docker after `neko setup web`.
 *
 *   - A searxng search that cannot connect asks ensureUp(): if the Docker daemon is reachable and the
 *     `neko-searxng` container exists but is stopped, it is `docker start`ed and health-polled; the
 *     caller then retries once. First search pays ~2-6s of wake-up; the rest are instant.
 *   - When NEKO started the container, an idle timer (searxng_keepalive minutes, default 15; 0 = keep
 *     running) `docker stop`s it after the last search - like Ollama's keep_alive for models.
 *   - A container Neko did NOT start is NEVER stopped (the user's own `docker run` is their business),
 *     and the Docker Desktop app itself is never launched or killed (30-60s boot, other workloads).
 *   - Daemon down / no container / no docker at all -> fast honest "no" (~100ms), and the search falls
 *     through the normal ladder (Tavily/DuckDuckGo) - a search is never blocked on infrastructure.
 *
 * Deterministic + injectable (exec/probe/timer hooks) so the whole lifecycle is unit-testable.
 */
import { spawnSync } from "node:child_process";

import { debug } from "../shared/debug.ts";

export interface ExecResult { status: number | null; stdout: string; stderr: string; }
export type Exec = (cmd: string, args: string[], timeoutMs: number) => ExecResult;

const realExec: Exec = (cmd, args, timeoutMs) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    if (r.error) return { status: null, stdout: "", stderr: String(r.error.message ?? r.error) };
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (e) {
    return { status: null, stdout: "", stderr: String((e as Error).message ?? e) };
  }
};

export interface SidecarOptions {
  container?: string;                       // container name (default neko-searxng)
  keepaliveMin?: number;                    // idle minutes before auto-stop; 0 = never stop
  exec?: Exec;                              // injectable process runner (tests)
  probe?: (baseUrl: string) => Promise<boolean>; // injectable health probe (tests)
  pollMs?: number;                          // health poll interval (tests shrink it)
  pollTries?: number;                       // health poll attempts
}

async function defaultProbe(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, "") + "/search?format=json&q=neko", { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch { return false; }
}

export class SearxngSidecar {
  private readonly container: string;
  private readonly exec: Exec;
  private readonly probe: (baseUrl: string) => Promise<boolean>;
  private readonly pollMs: number;
  private readonly pollTries: number;
  keepaliveMin: number;
  /** True only when THIS process issued the `docker start` - the only case auto-stop is allowed. */
  private startedByUs = false;
  private startAttempted = false; // one wake attempt per process: a dead daemon must not tax every search
  private exitHooked = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many docker stops we issued (observability + tests). */
  stops = 0;

  constructor(opts: SidecarOptions = {}) {
    this.container = opts.container ?? "neko-searxng";
    this.keepaliveMin = opts.keepaliveMin ?? 15;
    this.exec = opts.exec ?? realExec;
    this.probe = opts.probe ?? defaultProbe;
    this.pollMs = opts.pollMs ?? 1200;
    this.pollTries = opts.pollTries ?? 6;
  }

  /** Container state via the daemon: "running" | "exited" | ... | "" (no daemon / no container). Fast. */
  private state(): string {
    const r = this.exec("docker", ["inspect", "--format", "{{.State.Status}}", this.container], 4000);
    return r.status === 0 ? r.stdout.trim() : "";
  }

  /** A searxng request failed to connect: wake the managed container if that is the actual cause.
   * Returns ok=true when the caller should RETRY (the API answered a health probe). */
  async ensureUp(baseUrl: string): Promise<{ ok: boolean; reason: string }> {
    if (this.startAttempted) return { ok: false, reason: "wake already attempted this session" };
    this.startAttempted = true;
    const st = this.state();
    if (!st) return { ok: false, reason: "docker daemon unreachable or no managed container" };
    if (st === "running") return { ok: false, reason: "container is running but the API did not answer" };
    const start = this.exec("docker", ["start", this.container], 20000);
    if (start.status !== 0) return { ok: false, reason: `docker start failed: ${(start.stderr || start.stdout).trim().slice(0, 120)}` };
    debug("sidecar", () => `started ${this.container}; polling health`);
    for (let i = 0; i < this.pollTries; i++) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      if (await this.probe(baseUrl)) {
        this.startedByUs = true;
        // We woke it, we clean it up: the idle timer dies with the process (unref), so a short-lived
        // `neko run` would otherwise leak a running container forever - the exact RAM tax this
        // lifecycle exists to remove. docker stop is sync-safe inside an exit handler; waking an
        // existing container on the next run costs ~1-3s, honesty ("zero RAM between uses") costs less.
        if (!this.exitHooked && this.keepaliveMin > 0) {
          this.exitHooked = true;
          process.once("exit", () => this.stopNow());
        }
        this.touch();
        return { ok: true, reason: "started" };
      }
    }
    return { ok: false, reason: "container started but the JSON API did not come up in time" };
  }

  /** A successful searxng search: (re)arm the idle auto-stop - only for a container WE started. */
  touch(): void {
    if (!this.startedByUs || this.keepaliveMin <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopNow(), this.keepaliveMin * 60_000);
    // Never hold the process open for a cleanup timer (bun/node support unref on timers).
    (this.idleTimer as any).unref?.();
  }

  /** Idle expiry (or shutdown): stop the container we started. Safe to call repeatedly. */
  stopNow(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (!this.startedByUs) return;
    this.startedByUs = false;
    this.stops++;
    debug("sidecar", () => `idle keepalive expired; stopping ${this.container}`);
    this.exec("docker", ["stop", this.container], 30000);
  }

  /** Doctor line: the managed container's lifecycle state, or "" when there is none. */
  describe(): string {
    const st = this.state();
    if (!st) return "";
    if (st === "running") return `container running${this.startedByUs ? ` (managed, stops after ${this.keepaliveMin}m idle)` : ""}`;
    return "container stopped - starts on demand at the first search";
  }
}

/** Fast one-shot probe: is a Docker daemon reachable at all? (For the one-time setup hint.) */
export function dockerAvailable(exec: Exec = realExec): boolean {
  return exec("docker", ["version", "--format", "{{.Server.Version}}"], 2500).status === 0;
}
