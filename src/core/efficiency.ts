import { createHash } from "node:crypto";
import type { Provider } from "./ports.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type PrefixPart = "base" | "session" | "turn" | "tools" | "effort";
const PREFIX_PARTS = ["base", "session", "turn", "tools", "effort"] as const;
type RequestPurpose = "work" | "compact" | "wrapup";

export class EfficiencyTracker {
  #previous?: Record<PrefixPart, string>;
  #provider?: Provider;
  #observations = new Map<string, string>();
  #latencies: number[] = [];
  #firstEvents: number[] = [];
  #counts = {
    requests: 0, errors: 0, aborts: 0, retries: 0,
    tools: 0, failedTools: 0, repeatedObservations: 0,
    verificationNudges: 0, unverifiedStops: 0,
  };
  #changes = { base: 0, session: 0, turn: 0, tools: 0, effort: 0, provider: 0 };
  #purposes = { work: 0, compact: 0, wrapup: 0 };

  constructor(private readonly now: () => number = () => performance.now()) {}

  start(provider: Provider, parts: Record<PrefixPart, string>, purpose: RequestPurpose = "work") {
    const hashes = {
      base: digest(parts.base), session: digest(parts.session), turn: digest(parts.turn),
      tools: digest(parts.tools), effort: digest(parts.effort),
    };
    const changed: Array<PrefixPart | "provider"> = [];
    if (this.#provider && this.#provider !== provider) changed.push("provider");
    if (this.#previous) {
      for (const key of PREFIX_PARTS) {
        if (hashes[key] !== this.#previous[key]) changed.push(key);
      }
    }
    this.#provider = provider;
    this.#previous = hashes;
    for (const key of changed) this.#changes[key]++;
    this.#counts.requests++;
    this.#purposes[purpose]++;
    const started = this.now();
    let firstEventMs: number | undefined;
    let finished = false;
    return {
      firstEvent: () => { firstEventMs ??= Math.max(0, this.now() - started); },
      finish: (outcome: "success" | "error" | "aborted") => {
        if (finished) return;
        finished = true;
        const elapsedMs = Math.max(0, this.now() - started);
        if (outcome === "error") this.#counts.errors++;
        if (outcome === "aborted") this.#counts.aborts++;
        this.#latencies.push(elapsedMs);
        if (this.#latencies.length > 64) this.#latencies.shift();
        if (firstEventMs !== undefined) {
          this.#firstEvents.push(firstEventMs);
          if (this.#firstEvents.length > 64) this.#firstEvents.shift();
        }
        return { purpose, outcome, elapsedMs, firstEventMs: firstEventMs ?? null, prefixChanges: changed };
      },
    };
  }

  retry(): void { this.#counts.retries++; }
  verificationNudge(): void { this.#counts.verificationNudges++; }
  unverifiedStop(): void { this.#counts.unverifiedStops++; }
  resetObservations(): void { this.#observations.clear(); }

  observeTool(signature: string, observation: string | null, stateChanging: boolean, failed: boolean, repeatable: boolean): void {
    this.#counts.tools++;
    if (failed) this.#counts.failedTools++;
    if (stateChanging) this.resetObservations();
    if (failed || stateChanging || repeatable || observation === null || observation.length > 48_000) return;
    const key = digest(signature);
    const value = digest(observation);
    if (this.#observations.get(key) === value) this.#counts.repeatedObservations++;
    this.#observations.delete(key);
    this.#observations.set(key, value);
    if (this.#observations.size > 64) this.#observations.delete(this.#observations.keys().next().value!);
  }

  snapshot() {
    const percentile = (values: number[], p: number) => values.length
      ? Math.round([...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1])
      : null;
    return {
      ...this.#counts,
      purposes: { ...this.#purposes },
      prefixChanges: { ...this.#changes },
      latencySamples: this.#latencies.length,
      firstEventSamples: this.#firstEvents.length,
      p50RequestMs: percentile(this.#latencies, 0.5),
      p95RequestMs: percentile(this.#latencies, 0.95),
      p50FirstEventMs: percentile(this.#firstEvents, 0.5),
    };
  }

  summary(): string {
    const s = this.snapshot();
    if (!s.requests) return "";
    const changes = Object.entries(s.prefixChanges).map(([key, count]) => `${key}=${count}`).join(", ");
    return [
      `local efficiency (current runtime): ${s.requests} provider requests, ${s.errors} errors, ${s.aborts} aborts, ${s.retries} scheduled retries`,
      `recent request latency p50/p95: ${s.p50RequestMs ?? "n/a"}/${s.p95RequestMs ?? "n/a"} ms; first streamed event p50: ${s.p50FirstEventMs ?? "n/a"} ms`,
      `observed prefix changes: ${changes} (not proof of a cache miss)`,
      `tools: ${s.tools}, failed: ${s.failedTools}, identical read observations: ${s.repeatedObservations}; verification nudges: ${s.verificationNudges}, unverified stops: ${s.unverifiedStops}`,
      "Latency includes provider retries and managed tools; identical observations are diagnostic, never skipped automatically.",
    ].join("\n");
  }
}
