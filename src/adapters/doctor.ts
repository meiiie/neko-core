/**
 * `neko doctor` — read-only diagnostics. Confirms the resolved config-first runtime
 * (provider, model, endpoint, key presence) WITHOUT calling the model.
 */
import type { NekoConfig } from "./config.ts";
import { detectSandbox } from "../core/sandbox.ts";
import { cachedRefreshRate, resolveUiFps } from "./display.ts";
import { SearxngSidecar } from "./sidecar.ts";
import { VERSION } from "../shared/version.ts";

export interface Check {
  status: "ok" | "warn";
  name: string;
  detail: string;
}

/** Name the hosting terminal from the env (best-effort - WT/ConPTY doesn't export TERM_PROGRAM). */
export function terminalName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM;
  if (env.WT_SESSION) return "Windows Terminal";
  if (env.ConEmuANSI) return "ConEmu/Cmder";
  if (env.TERM) return env.TERM;
  return process.platform === "win32" ? "legacy console (conhost)" : "unknown";
}

/** Terminal/input diagnostics - the session-won't-take-keys triage lives HERE, not in guesswork:
 * a session that renders but ignores typing is either (a) keys never reaching the process
 * (`neko doctor keys` shows zero bytes) or (b) keys arriving in a protocol the UI doesn't speak
 * (the probe shows the bytes). These checks surface the facts a bug report needs. */
export function collectTerminalChecks(): Check[] {
  const stdinTty = !!process.stdin.isTTY;
  const rawOk = stdinTty && typeof (process.stdin as any).setRawMode === "function";
  const r = resolveUiFps(null);
  const hz = cachedRefreshRate();
  return [
    { status: "ok", name: "terminal", detail: terminalName() },
    {
      status: stdinTty && !!process.stdout.isTTY ? "ok" : "warn",
      name: "tty",
      detail: `stdin=${stdinTty ? "tty" : "NOT a tty"} stdout=${process.stdout.isTTY ? "tty" : "NOT a tty"}` +
        (stdinTty && !rawOk ? " (raw mode UNAVAILABLE - interactive input cannot work)" : ""),
    },
    {
      status: "ok",
      name: "ui_fps",
      detail: `${r.fps}fps via ${r.source}${hz ? ` (display ~${hz}Hz)` : ""}`,
    },
    { status: "ok", name: "input_probe", detail: "if the session renders but typing does NOTHING, run `neko doctor keys`" },
  ];
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
    {
      status: config.sandbox && detectSandbox() === "none" ? "warn" : "ok",
      name: "bash_sandbox",
      detail: config.sandbox
        ? detectSandbox() === "none"
          ? "requested but unavailable on this OS - seatbelt + gate still apply"
          : `on (${detectSandbox()})`
        : `off (available: ${detectSandbox()})`,
    },
    {
      status: "ok",
      name: "file_search",
      // The `search` tool prefers ripgrep (fast, .gitignore-aware); without it, a built-in JS regex
      // walk (correct, slower). Surfaced so users can tell which path they are on and install rg.
      detail: Bun.which("rg") ? "ripgrep (fast)" : "built-in JS walk (install ripgrep for the fast path: https://github.com/BurntSushi/ripgrep)",
    },
    {
      status: "ok",
      name: "web_search",
      detail: (() => {
        const pick = config.searchBackend || (config.searxngUrl ? "searxng" : process.env.TAVILY_API_KEY ? "tavily" : "duckduckgo (set searxng_url or TAVILY_API_KEY for SOTA)");
        if (!pick.startsWith("searxng") || !config.searxngUrl) return pick;
        // Managed-lifecycle truth: a stopped container is fine - the first search wakes it.
        const state = new SearxngSidecar({ keepaliveMin: config.searxngKeepalive }).describe();
        return state ? `searxng (${state})` : "searxng (no local container found - is it remote, or run `neko setup web`)";
      })(),
    },
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
