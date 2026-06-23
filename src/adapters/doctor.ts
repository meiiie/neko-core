/**
 * `neko doctor` — read-only diagnostics. Confirms the resolved config-first runtime
 * (provider, model, endpoint, key presence) WITHOUT calling the model.
 */
import type { NekoConfig } from "./config.ts";
import { VERSION } from "../shared/version.ts";

export interface Check {
  status: "ok" | "warn";
  name: string;
  detail: string;
}

export function collectChecks(config: NekoConfig): Check[] {
  return [
    { status: "ok", name: "version", detail: `neko-core ${VERSION}` },
    { status: "ok", name: "provider", detail: config.provider },
    { status: "ok", name: "profile", detail: config.profile ?? "none" },
    {
      status: config.model ? "ok" : "warn",
      name: "model",
      detail: config.model || "(unset - set model or pick a --profile)",
    },
    { status: "ok", name: "max_steps", detail: String(config.maxSteps) },
    { status: "ok", name: "mode", detail: config.mode },
    { status: config.baseUrl ? "ok" : "warn", name: "base_url", detail: config.baseUrl || "(unset)" },
    {
      status: config.apiKey || config.isLocalEndpoint ? "ok" : "warn",
      name: "api_key",
      detail: config.apiKey ? "set" : config.isLocalEndpoint ? "not needed (local endpoint)" : "missing - set NEKO_API_KEY or run `neko init-user`",
    },
  ];
}

export function render(checks: Check[]): string {
  return ["Neko Core doctor", ...checks.map((c) => `[${c.status.toUpperCase()}] ${c.name}: ${c.detail}`)].join("\n");
}
