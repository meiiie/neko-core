/** Shared ToolRegistry composition for CLI, TUI, and depth-one subagents. */
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import type { ToolRegistry } from "../core/tool-runtime.ts";
import { subagentToolAllowlist } from "../core/tools.ts";
import { detectSandbox, findWindowsBash, srtHealthSnapshot, transientSrtHealthFailure } from "../core/sandbox.ts";
import type { NekoConfig } from "./config.ts";
import { withBrowserBridge } from "./browser-bridge.ts";
import { withOfficeTools } from "./office-tools.ts";
import { withMeetingTools } from "./meeting-tools.ts";
import { withOracleTools } from "./oracle-tools.ts";
import { withImageTools } from "./imagegen-tools.ts";
import { loadSkill } from "./skills.ts";
import { webPort } from "./web.ts";
import type { SandboxRuntimeStatus } from "./registry.ts";

function modeRuntimeDetail(
  registry: ToolRegistry,
  sandboxedBash: boolean,
  failClosedBash: boolean,
  unconfinedAuto: boolean,
): string {
  switch (registry.mode) {
    case "auto":
      return failClosedBash
        ? "non-bash gated tools run without an approval prompt; bash FAILS CLOSED until its configured OS sandbox is healthy; host computer control still requires explicit consent"
        : unconfinedAuto
          ? "UNCONFINED AUTO: bounded gated tools run without an approval prompt and bash runs on the host; host computer control still requires explicit consent; Neko seatbelts still apply"
          : "bounded gated tools run without an approval prompt; host computer control still requires explicit consent; Neko seatbelts still apply";
    case "plan":
      return "all gated Neko actions are denied; safe inspection tools remain available";
    case "accept-edits":
      return sandboxedBash
        ? "Neko file edits and live-sandboxed bash run without a prompt; other gated actions still prompt"
        : "Neko file edits run without a prompt; bash and other gated actions still prompt";
    default:
      return sandboxedBash
        ? "gated Neko actions prompt, except non-destructive live-sandboxed bash"
        : "gated Neko actions, including bash, require user approval";
  }
}

/** Authoritative model-facing description of the tools Neko actually executes. Provider-native tools
 * belong to the transport process and must never be mistaken for Neko's permission or sandbox state. */
export function dynamicToolRuntimeBlock(registry: ToolRegistry, sandboxRuntime?: SandboxRuntimeStatus): string {
  const turnPolicy = registry.turnPolicyDescriptor();
  const bashCallable = !registry.noTools && registry.isToolAvailable("bash");
  const skillCallable = !registry.noTools && registry.isToolAvailable("skill") && Boolean(registry.loadSkill);
  const detected = bashCallable && registry.sandboxBash
    ? (sandboxRuntime?.kind ?? detectSandbox())
    : "none";
  const cachedSrtHealth = !sandboxRuntime && detected === "srt" ? srtHealthSnapshot() : undefined;
  const healthDeferred = detected === "srt" && (
    (!sandboxRuntime && !cachedSrtHealth)
    || (!sandboxRuntime?.live && /health check deferred/i.test(sandboxRuntime?.detail ?? ""))
  );
  const liveSandbox = registry.sandboxBash && detected !== "none" && (sandboxRuntime?.live
    ?? (detected === "srt" ? cachedSrtHealth?.ok ?? false : true));
  const transientSrt = registry.sandboxBash && detected === "srt" && !liveSandbox
    && transientSrtHealthFailure(sandboxRuntime?.detail ?? cachedSrtHealth?.detail ?? "");
  const exactReadOnlyValidator = turnPolicy?.bashPolicy === "foreground-validator-only";
  const failClosedBash = exactReadOnlyValidator
    ? !liveSandbox
    : registry.sandboxBash && detected !== "none" && !liveSandbox && !transientSrt;
  const unconfinedAuto = registry.mode === "auto" && bashCallable &&
    !exactReadOnlyValidator && (!registry.sandboxBash || detected === "none");
  const sandboxedBash = liveSandbox && registry.sandboxAutoApprove;
  const shell = platform() === "win32"
    ? (findWindowsBash() ? "GIT BASH (POSIX)" : "cmd.exe")
    : (liveSandbox ? "bash (POSIX)" : "/bin/sh (POSIX)");
  const network = !registry.sandboxAllowNetwork
    ? "blocked"
    : detected === "srt"
      ? (registry.sandboxDomains.length ? "allowlisted by sandbox_domains" : "blocked (SRT needs explicit sandbox_domains)")
      : detected === "bwrap" || detected === "sandbox-exec"
        ? "allowed (sandbox_domains are not enforced by this primitive)"
        : "host policy unknown";
  const sandbox = exactReadOnlyValidator && !liveSandbox
    ? "required read-only isolation unavailable (exact-turn bash FAILS CLOSED; no host fallback)"
    : exactReadOnlyValidator
      ? `${detected} live (exact validators: project read-only; writes allowed only in unique temp; host reads remain available; network ${network})`
    : !registry.sandboxBash
    ? "off (host/unconfined)"
    : liveSandbox
      ? `${detected} live (writes confined to workspace/temp plus explicit additional_write_roots; host reads remain available; network ${network})`
      : healthDeferred
        ? "srt health check deferred until the first bash call (the bounded check is asynchronous; no host fallback)"
      : transientSrt
        ? "srt behavioral probe timed out under host load; bash will still attempt the exact SRT boundary once and will never fall back unconfined"
      : detected === "none"
        ? "requested but unavailable (host/unconfined)"
      : `${detected} present but unhealthy in the latest snapshot (bash FAILS CLOSED; no host fallback; a later bash call re-checks SRT health after the bounded failure cache expires)`;

  return [
    "# NEKO DYNAMIC-TOOL RUNTIME",
    "This block is authoritative for Neko dynamic tools in this session.",
    "Provider-native shell, apply_patch/edit, approvals, sandbox, and skills are a separate transport runtime. They do not grant or describe Neko permissions. Do not use provider-native action tools for Neko work; use only the dynamic tool schemas attached to this request.",
    `Effective Neko permission mode: ${registry.mode}${registry.mode === "auto" ? " (yolo)" : ""} - ${modeRuntimeDetail(registry, sandboxedBash, failClosedBash, unconfinedAuto)}.`,
    turnPolicy?.editTarget
      ? `Active exact-file turn: edit target=${JSON.stringify(turnPolicy.editTarget)}; edit requires exactly one byte-for-byte old_string match. ` +
        (turnPolicy.bashPolicy === "foreground-validator-only"
          ? "Bash is foreground validator-only (test/typecheck/lint/check/verify) in an isolated read-only project workspace; project code may write only to a unique temporary directory. Build targets, fix/write/update flags, command substitution, redirection, failure masking, and background execution are unavailable. Do not use bash for pwd, echo, search, file reads, or mutation."
          : "Use only the dynamic tools and constraints shown in this request.")
      : "",
    bashCallable
      ? `Neko bash dynamic tool: callable; shell=${shell}; sandbox=${sandbox}. Docker/podman host-daemon access is refused or contained unless allow_dangerous_bash explicitly grants that capability.`
      : "Neko bash dynamic tool: unavailable in this request.",
    failClosedBash
      ? "Do not create a shell script whose only purpose is to wait for unavailable bash. Prefer an independent safe native tool that directly covers the task; otherwise state the boundary or request explicit computer consent before changing files."
      : "",
    skillCallable
      ? "Neko skill dynamic tool: callable. Only exact names under NEKO SKILL CATALOG are accepted; provider-native skill names are not Neko skills."
      : "Neko skill dynamic tool: unavailable in this request; no Neko skill catalog is callable.",
  ].filter(Boolean).join("\n");
}

/** Apply config-backed capabilities once at a host composition root. */
export function configureToolRegistry(registry: ToolRegistry, cfg: NekoConfig, options: { noTools?: boolean } = {}): ToolRegistry {
  registry.mcp = withBrowserBridge(registry.mcp);
  registry.mcp = withOfficeTools(registry.root, registry.mcp);
  registry.mcp = withMeetingTools(registry.mcp);
  registry.mcp = withOracleTools(registry.mcp, cfg, registry.root);
  registry.mcp = withImageTools(registry.mcp, registry.root);
  registry.hooks = cfg.hooks;
  registry.childSecretEnvNames = cfg.childSecretEnvNames;
  registry.allowDangerousBash = cfg.allowDangerousBash;
  registry.readOutsideRoot = cfg.readOutsideRoot;
  const researchRoot = resolve(cfg.researchWriteRoot);
  registry.additionalWriteRoots = cfg.additionalWriteRoots.map((rawRoot) => {
    const requested = resolve(rawRoot);
    if (!existsSync(requested)) {
      if (requested !== researchRoot) {
        throw new Error(`additional_write_roots directory does not exist: ${rawRoot}`);
      }
      mkdirSync(requested, { recursive: true });
    }
    const stat = lstatSync(requested);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`additional_write_roots must name a canonical directory: ${rawRoot}`);
    }
    // Store and use only the canonical target. macOS exposes system temporary directories through
    // `/var` -> `/private/var`, so requiring the entire lexical ancestor chain to be alias-free would
    // reject every normal test/home rooted there. The granted leaf itself must still be a real
    // directory (checked above), and the pre/post identity check closes a swap between lstat/realpath.
    const canonical = realpathSync.native(requested);
    const canonicalStat = lstatSync(canonical);
    if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()
      || canonicalStat.dev !== stat.dev || canonicalStat.ino !== stat.ino) {
      throw new Error(`additional_write_roots changed while being validated: ${rawRoot}`);
    }
    return canonical;
  });
  registry.bashTimeoutCapMs = cfg.bashTimeoutCapMs;
  registry.sandboxBash = cfg.sandbox;
  registry.sandboxAllowNetwork = cfg.sandboxNetwork;
  registry.sandboxDomains = cfg.sandboxDomains;
  registry.sandboxAutoApprove = cfg.sandboxAutoApprove;
  registry.searxngUrl = cfg.searxngUrl;
  registry.searchBackend = cfg.searchBackend;
  registry.searxngKeepalive = cfg.searxngKeepalive;
  registry.tavilyKey = cfg.tavilyApiKey;
  registry.scrapeBackend = cfg.scrapeBackend;
  registry.vision = cfg.vision;
  registry.noTools = options.noTools ?? false;
  registry.presence = cfg.computerUseOverlay;
  registry.residentUia = cfg.computerUseResident;
  registry.inputBackend = cfg.computerUseInput;
  registry.web = webPort;
  registry.loadSkill = (name) => {
    const skill = loadSkill(name, registry.root, cfg.resolvedHome);
    return skill ? { body: skill.body, dir: skill.dir } : null;
  };
  return registry;
}

/** Copy every runtime boundary/capability a child must inherit, deliberately excluding subagent recursion. */
export function inheritToolRegistrySettings(target: ToolRegistry, source: ToolRegistry): ToolRegistry {
  target.disabled = new Set(source.disabled);
  target.toolAllowlist = source.toolAllowlist ? new Set(source.toolAllowlist) : undefined;
  target.mcp = source.mcp;
  target.hooks = source.hooks;
  target.childSecretEnvNames = [...source.childSecretEnvNames];
  target.allowBackgroundBash = source.allowBackgroundBash;
  target.summarize = source.summarize;
  target.web = source.web;
  target.checkAction = source.checkAction;
  target.denialNote = source.denialNote;
  target.loadSkill = source.loadSkill;
  target.allowDangerousBash = source.allowDangerousBash;
  target.readOutsideRoot = source.readOutsideRoot;
  target.additionalWriteRoots = [...source.additionalWriteRoots];
  target.bashTimeoutCapMs = source.bashTimeoutCapMs;
  target.sandboxBash = source.sandboxBash;
  target.sandboxAllowNetwork = source.sandboxAllowNetwork;
  target.sandboxDomains = source.sandboxDomains;
  target.sandboxDenyReadFiles = source.sandboxDenyReadFiles;
  target.sandboxAutoApprove = source.sandboxAutoApprove;
  target.vision = source.vision;
  target.noTools = source.noTools;
  target.presence = source.presence;
  target.residentUia = source.residentUia;
  target.inputBackend = source.inputBackend;
  target.searxngUrl = source.searxngUrl;
  target.searchBackend = source.searchBackend;
  target.searxngKeepalive = source.searxngKeepalive;
  target.tavilyKey = source.tavilyKey;
  target.scrapeBackend = source.scrapeBackend;
  return target;
}

/** Apply the named subagent's least-authority capability set. Generic/custom workers deliberately
 * keep inherited authority; their `task` call is gated and serialized by core. */
export function restrictToolRegistryForSubagent(registry: ToolRegistry, type?: string): ToolRegistry {
  // Depth-one children have no subagent callback. Do not advertise a dead recursive tool, and do
  // not let detached bash jobs escape into a private registry the parent cannot inspect or stop.
  registry.disabled.add("task");
  registry.allowBackgroundBash = false;
  const allowed = subagentToolAllowlist(type);
  if (allowed) {
    registry.allowOnlyTools(allowed);
    // Hooks are executable shell callbacks. A read-only child must not turn an otherwise SAFE read
    // into a mutation through inherited pre/post hooks. Generic/custom workers keep them inherited.
    registry.hooks = undefined;
  }
  return registry;
}
