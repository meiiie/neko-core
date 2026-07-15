/**
 * `neko doctor` — read-only diagnostics. Confirms the resolved config-first runtime
 * (provider, model, endpoint, key presence) WITHOUT calling the model.
 */
import type { NekoConfig } from "./config.ts";
import { detectSandbox } from "../core/sandbox.ts";
import { cachedRefreshRate, resolveUiFps } from "./display.ts";
import { SearxngSidecar } from "./sidecar.ts";
import { VERSION } from "../shared/version.ts";
import { hasChatGptCredentials } from "./chatgpt-auth.ts";
import { discoverCodexSupport, type CodexSupportStatus } from "./codex-app-server.ts";
import { discoverGeminiCli, hasGeminiCredentials, type GeminiCliStatus } from "./gemini-cli.ts";
import { hasKimiCredentials } from "./kimi-auth.ts";
import { browserBridgeStage, readBrowserCapability, readBrowserBridgeStatus } from "./browser-bridge.ts";

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

export function collectChecks(config: NekoConfig, codexSupport?: CodexSupportStatus, geminiSupport?: GeminiCliStatus): Check[] {
  const needsCodexBridge = config.usesChatGptAuth && config.model.startsWith("gpt-5.6-");
  const bridge = needsCodexBridge ? (codexSupport ?? discoverCodexSupport()) : null;
  const bridgeUnavailable = needsCodexBridge && bridge?.state !== "ready";
  const gemini = config.usesGeminiCli ? (geminiSupport ?? discoverGeminiCli()) : null;
  const geminiUnavailable = config.usesGeminiCli && gemini?.state !== "ready";
  const profileNeedsApiKey = Boolean(config.profile && config.profiles[config.profile]?.auth === "api_key");
  const profileKeyEnvs = config.profileKeyEnvs;
  const browserArgs = config.mcpServers.browser?.args ?? [];
  const profileAt = browserArgs.indexOf("--user-data-dir");
  const browserCheck: Check = !config.mcpServers.browser
    ? { status: "warn", name: "browser", detail: "not configured - run `neko setup browser` for a persistent signed-in Chrome" }
    : browserArgs.includes("--extension")
      ? { status: "ok", name: "browser", detail: "attached to existing Chrome via Playwright Extension (reuses logged-in tabs)" }
      : profileAt >= 0 && browserArgs[profileAt + 1]
        ? { status: "ok", name: "browser", detail: `persistent Chrome profile (${browserArgs[profileAt + 1]}); one active owner, use attach for shared Chrome` }
        : browserArgs.includes("--isolated")
          ? { status: "warn", name: "browser", detail: "isolated/ephemeral - logins are discarded on close; run `neko setup browser persistent`" }
          : { status: "warn", name: "browser", detail: "profile persistence is not explicit; run `neko setup browser persistent` or `neko setup browser attach`" };
  const browserBridge = readBrowserCapability();
  const browserBridgeStatus = browserBridge ? readBrowserBridgeStatus() : undefined;
  const browserStage = browserBridgeStage(browserBridge, browserBridgeStatus);
  const browserBridgeCheck: Check | null = browserStage === "not_configured" ? null
    : browserStage === "tab_attached"
      ? { status: "ok", name: "browser_bridge", detail: "online; extension connected; one Chrome tab attached" }
      : browserStage === "extension_connected"
        ? { status: "ok", name: "browser_bridge", detail: "online; extension connected; waiting for an explicit tab attachment" }
        : browserStage === "bridge_online"
          ? { status: "warn", name: "browser_bridge", detail: "online, but the Chrome extension is not connected - run `/browser setup`" }
          : { status: "warn", name: "browser_bridge", detail: "configured but offline - start Neko, then run `/browser status`" };
  return [
    { status: "ok", name: "version", detail: `neko-core ${VERSION}` },
    { status: "ok", name: "provider", detail: config.provider },
    { status: "ok", name: "profile", detail: config.profile ?? "none" },
    {
      status: config.model && !config.modelShadow && !bridgeUnavailable && !geminiUnavailable ? "ok" : "warn",
      name: "model",
      detail: config.modelShadow
        ? `${config.model} - top-level 'model' in ${config.modelShadow.source} OVERRIDES profile '${config.profile}' ` +
          `(preset: ${config.modelShadow.profileModel}) and every other profile; move it under profiles.${config.profile}.model or delete it`
        : needsCodexBridge
          ? bridge?.state === "ready"
            ? `${config.model} via Codex bridge (${bridge.detail})`
            : `${config.model} needs the optional GPT-5.6 Support Pack or Codex CLI >= 0.144.0 (${bridge?.detail ?? "not found"})`
          : config.usesGeminiCli
            ? gemini?.state === "ready"
              ? `${config.model} via Gemini CLI ACP (${gemini.detail})`
              : `${config.model} needs the official Gemini CLI (${gemini?.detail ?? "not found"})`
          : config.model || "(unset - set model or pick a --profile)",
    },
    { status: "ok", name: "max_steps", detail: String(config.maxSteps) },
    { status: "ok", name: "mode", detail: config.mode },
    {
      status: "ok",
      name: "computer_use",
      detail: config.computerUseResident
        ? "resident UIA/input/capture on (warm process; set computer_use_resident=false to use one-shot fallback)"
        : "one-shot PowerShell fallback (resident UIA/input/capture disabled)",
    },
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
        const tavily = process.env.TAVILY_API_KEY || config.tavilyApiKey;
        const pick = config.searchBackend || (config.searxngUrl ? "searxng" : tavily ? "tavily" : "duckduckgo (run `neko setup web` or `neko setup tavily <key>` for SOTA)");
        if (!pick.startsWith("searxng") || !config.searxngUrl) return pick;
        // Managed-lifecycle truth: a stopped container is fine - the first search wakes it.
        const state = new SearxngSidecar({ keepaliveMin: config.searxngKeepalive }).describe();
        return state ? `searxng (${state})` : "searxng (no local container found - is it remote, or run `neko setup web`)";
      })(),
    },
    browserCheck,
    ...(browserBridgeCheck ? [browserBridgeCheck] : []),
    { status: config.usesGeminiCli || config.baseUrl ? "ok" : "warn", name: "base_url", detail: config.usesGeminiCli ? "ACP stdio (no HTTP endpoint in Neko)" : config.baseUrl || "(unset)" },
    config.usesChatGptAuth
      ? {
          status: hasChatGptCredentials() ? "ok" : "warn",
          name: "chatgpt_auth",
          detail: hasChatGptCredentials() ? "signed in (OAuth; API billing is not used)" : "missing - run `neko login openai chatgpt`",
        }
      : config.usesGeminiAuth
        ? {
            status: hasGeminiCredentials() ? "ok" : "warn",
            name: "gemini_auth",
            detail: hasGeminiCredentials() ? "signed in through Gemini CLI (OAuth; API billing is not used)" : "missing - run `neko login google gemini` or use /login",
          }
      : config.usesKimiAuth
        ? {
            status: hasKimiCredentials() ? "ok" : "warn",
            name: "kimi_auth",
            detail: hasKimiCredentials()
              ? "credentials present; Kimi Code access is checked on the first request (official device OAuth; no proxy or API key)"
              : "missing - run `neko login kimi` or use /login",
          }
      : {
          status: config.apiKey || (config.isLocalEndpoint && !profileNeedsApiKey) ? "ok" : "warn",
          name: "api_key",
          detail: config.apiKey
            ? "set"
            : config.isLocalEndpoint && !profileNeedsApiKey
              ? "not needed (local endpoint)"
              : `missing - set ${profileKeyEnvs.length ? `${profileKeyEnvs.join(" or ")} or ` : ""}NEKO_API_KEY, or use /login`,
        },
  ];
}

export function render(checks: Check[]): string {
  return ["Neko Core doctor", ...checks.map((c) => `[${c.status.toUpperCase()}] ${c.name}: ${c.detail}`)].join("\n");
}
