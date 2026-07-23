/** Shared ToolRegistry composition for CLI, TUI, and depth-one subagents. */
import type { ToolRegistry } from "../core/tool-runtime.ts";
import type { NekoConfig } from "./config.ts";
import { withBrowserBridge } from "./browser-bridge.ts";
import { withOfficeTools } from "./office-tools.ts";
import { withMeetingTools } from "./meeting-tools.ts";
import { loadSkill } from "./skills.ts";
import { webPort } from "./web.ts";

/** Apply config-backed capabilities once at a host composition root. */
export function configureToolRegistry(registry: ToolRegistry, cfg: NekoConfig, options: { noTools?: boolean } = {}): ToolRegistry {
  registry.mcp = withBrowserBridge(registry.mcp);
  registry.mcp = withOfficeTools(registry.root, registry.mcp);
  registry.mcp = withMeetingTools(registry.mcp);
  registry.hooks = cfg.hooks;
  registry.allowDangerousBash = cfg.allowDangerousBash;
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
    const skill = loadSkill(name);
    return skill ? { body: skill.body, dir: skill.dir } : null;
  };
  return registry;
}

/** Copy every runtime boundary/capability a child must inherit, deliberately excluding subagent recursion. */
export function inheritToolRegistrySettings(target: ToolRegistry, source: ToolRegistry): ToolRegistry {
  target.disabled = new Set(source.disabled);
  target.mcp = source.mcp;
  target.hooks = source.hooks;
  target.summarize = source.summarize;
  target.web = source.web;
  target.checkAction = source.checkAction;
  target.loadSkill = source.loadSkill;
  target.allowDangerousBash = source.allowDangerousBash;
  target.bashTimeoutCapMs = source.bashTimeoutCapMs;
  target.sandboxBash = source.sandboxBash;
  target.sandboxAllowNetwork = source.sandboxAllowNetwork;
  target.sandboxDomains = source.sandboxDomains;
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
