/** Shared ToolRegistry composition for CLI, TUI, and depth-one subagents. */
import type { ToolRegistry } from "../core/tool-runtime.ts";
import type { NekoConfig } from "./config.ts";
import { loadSkill } from "./skills.ts";
import { webPort } from "./web.ts";

/** Apply config-backed capabilities once at a host composition root. */
export function configureToolRegistry(registry: ToolRegistry, cfg: NekoConfig, options: { noTools?: boolean } = {}): ToolRegistry {
  registry.hooks = cfg.hooks;
  registry.allowDangerousBash = cfg.allowDangerousBash;
  registry.sandboxBash = cfg.sandbox;
  registry.sandboxAllowNetwork = cfg.sandboxNetwork;
  registry.searxngUrl = cfg.searxngUrl;
  registry.searchBackend = cfg.searchBackend;
  registry.scrapeBackend = cfg.scrapeBackend;
  registry.vision = cfg.vision;
  registry.noTools = options.noTools ?? false;
  registry.presence = cfg.computerUseOverlay;
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
  target.hooks = source.hooks;
  target.summarize = source.summarize;
  target.web = source.web;
  target.checkAction = source.checkAction;
  target.loadSkill = source.loadSkill;
  target.allowDangerousBash = source.allowDangerousBash;
  target.sandboxBash = source.sandboxBash;
  target.sandboxAllowNetwork = source.sandboxAllowNetwork;
  target.vision = source.vision;
  target.noTools = source.noTools;
  target.presence = source.presence;
  target.inputBackend = source.inputBackend;
  target.searxngUrl = source.searxngUrl;
  target.searchBackend = source.searchBackend;
  target.scrapeBackend = source.scrapeBackend;
  return target;
}
