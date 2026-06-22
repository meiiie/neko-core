#!/usr/bin/env bun
/**
 * `neko` command-line entry point (TypeScript / Bun).
 *
 * Commands: config · doctor · profiles · init-user · init · chat · run
 * (chat/run are wired in later TS steps; config-first, offline-capable.)
 */
import { createInterface } from "node:readline/promises";

import { Agent, DEFAULT_SYSTEM_PROMPT } from "../src/core/agent.ts";
import { loadConfig, type NekoConfig } from "../src/adapters/config.ts";
import { projectContextBlock, renderContext } from "../src/adapters/context.ts";
import { collectChecks, render } from "../src/adapters/doctor.ts";
import { buildMcpHub, renderMcp } from "../src/adapters/mcp.ts";
import { getProvider } from "../src/adapters/providers.ts";
import { initProject, initUser } from "../src/adapters/project.ts";
import { renderSessions } from "../src/adapters/session.ts";
import { renderSkills } from "../src/adapters/skills.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import {
  collectCapabilities,
  evaluatePolicy,
  listAgents,
  listCommands,
  renderAgentDetail,
  renderAgents,
  renderCapabilities,
  renderCommands,
  renderPolicyReport,
  resolveAgent,
} from "../src/adapters/registry.ts";
import { listTools, renderToolDetail, renderTools, resolveTool } from "../src/core/tools.ts";
import { VERSION } from "../src/shared/version.ts";

interface Args {
  command?: string;
  positionals: string[];
  profile?: string;
  force: boolean;
  yolo: boolean;
  resume: boolean;
  version: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const tokens: string[] = [];
  const args: Args = { positionals: [], force: false, yolo: false, resume: false, version: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") args.profile = argv[++i];
    else if (a === "--force") args.force = true;
    else if (a === "--yolo") args.yolo = true;
    else if (a === "--resume") args.resume = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("-")) { /* ignore unknown flags */ }
    else tokens.push(a);
  }
  // The first bare word is the command; the rest are positionals (e.g. the run instruction).
  args.command = tokens[0];
  args.positionals = tokens.slice(1);
  return args;
}

function load(args: Args): NekoConfig {
  return loadConfig({ profile: args.profile });
}

/** Interactive approval gate for the CLI (one-shot readline per gated tool). */
async function promptApprove(toolName: string, args: Record<string, any>): Promise<boolean> {
  const action = args.command ? `run: ${args.command}` : args.path ? `${toolName} ${args.path}` : toolName;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`\n[approval] ${action}\nApprove? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

/** Compact, human-readable trace of the agent loop. */
function printEvent(kind: string, data: any): void {
  if (kind === "tool_call") {
    const a = data.arguments ?? {};
    const summary = a.command ?? a.path ?? a.pattern ?? "";
    console.log(`\n  -> ${data.name}(${summary})`);
  } else if (kind === "tool_result") {
    let obs = String(data.observation).replace(/\n/g, " ");
    if (obs.length > 200) obs = obs.slice(0, 200) + "...";
    console.log(`     ${obs}`);
  } else if (kind === "max_steps") {
    console.log(`  [stopped: reached max_steps=${data}]`);
  }
}

async function buildAgent(
  cfg: NekoConfig,
  yolo: boolean,
  onDelta?: (t: string) => void,
): Promise<{ agent: Agent; close: () => Promise<void> }> {
  const mode = yolo ? "auto" : cfg.mode;
  const hub = await buildMcpHub(cfg.mcpServers);
  const registry = new ToolRegistry(process.cwd(), mode, promptApprove, hub);
  registry.hooks = cfg.hooks;
  const block = projectContextBlock();
  const systemPrompt = block ? `${DEFAULT_SYSTEM_PROMPT}\n\n${block}` : DEFAULT_SYSTEM_PROMPT;
  const agent = new Agent({
    provider: getProvider(cfg),
    tools: registry,
    maxSteps: cfg.maxSteps,
    systemPrompt,
    onEvent: printEvent,
    onDelta,
  });
  return { agent, close: () => hub.close() };
}

const HELP = `Neko Code ${VERSION} - local-first agentic CLI.

Usage: neko [command] [options]
  Run 'neko' with no command (or 'neko code' / 'neko core') to start the session.

Commands:
  config        show the resolved config-first settings
  doctor        read-only diagnostics (provider/model/key)
  profiles      list the named runtime profiles
  init-user     scaffold ~/.neko-core/config.json
  init          scaffold ./.neko-core/config.json (project-local)
  tools         list tool contracts (safe/gated)
  agents        list agent roles and boundaries
  commands      list the CLI command surface
  capabilities  list runtime/CLI capabilities
  policy        audit the safe/gated permission boundary
  context       show the project context files (NEKO.md / CLAUDE.md) loaded
  sessions      list saved chat sessions
  skills        list available skills (~/.neko-core/skills)
  mcp           list configured MCP servers and their tools
  chat          interactive session (default - same as bare 'neko' / 'neko code')
  run <task>    one-shot: run a single instruction

Options:
  --profile <name>   named runtime profile (see 'neko profiles')
  --yolo             auto-approve gated tools (bounded autonomy)
  --resume           (chat) resume the latest session for this directory
  --version          print version`;

function cmdConfig(args: Args): number {
  const cfg = load(args);
  console.log("Resolved Neko Core config:");
  console.log(`  profile = ${cfg.profile ?? "(none)"}`);
  for (const key of Object.keys(cfg.data).sort()) {
    if (key.startsWith("_")) continue; // skip _comment/_hint annotations
    const value = cfg.data[key];
    console.log(`  ${key} = ${value && typeof value === "object" ? JSON.stringify(value) : value}`);
  }
  // The API key is a secret - only ever report presence, never the value.
  console.log(`  api_key = ${cfg.apiKey ? "set" : "missing"}`);
  return 0;
}

function cmdDoctor(args: Args): number {
  console.log(render(collectChecks(load(args))));
  return 0;
}

function cmdProfiles(args: Args): number {
  const cfg = load(args);
  console.log("Profiles (select with --profile NAME, NEKO_PROFILE, or active_profile):");
  for (const name of Object.keys(cfg.profiles).sort()) {
    const p = cfg.profiles[name];
    const mark = name === cfg.profile ? "*" : " ";
    console.log(` ${mark} ${name}: provider=${p.provider ?? "?"} base_url=${p.base_url ?? "-"} model=${p.model || "-"}`);
  }
  return 0;
}

function cmdTools(args: Args): number {
  const name = args.positionals[0];
  console.log(name ? renderToolDetail(resolveTool(name)) : renderTools(listTools()));
  return 0;
}

function cmdAgents(args: Args): number {
  const name = args.positionals[0];
  console.log(name ? renderAgentDetail(resolveAgent(name)) : renderAgents(listAgents()));
  return 0;
}

function cmdCommands(): number {
  console.log(renderCommands(listCommands()));
  return 0;
}

function cmdCapabilities(args: Args): number {
  console.log(renderCapabilities(collectCapabilities(load(args))));
  return 0;
}

function cmdPolicy(args: Args): number {
  const report = evaluatePolicy(load(args));
  console.log(renderPolicyReport(report));
  return report.verdict === "fail" ? 1 : 0;
}

function cmdContext(): number {
  console.log(renderContext());
  return 0;
}

async function cmdChat(args: Args): Promise<number> {
  // Lazy import: keep Ink/React out of the startup path for non-chat commands.
  const { runChat } = await import("../src/ui/chat.tsx");
  await runChat({ profile: args.profile, yolo: args.yolo, resume: args.resume });
  return 0;
}

function cmdSessions(): number {
  console.log(renderSessions());
  return 0;
}

function cmdSkills(): number {
  console.log(renderSkills());
  return 0;
}

async function cmdMcp(args: Args): Promise<number> {
  const cfg = load(args);
  if (!Object.keys(cfg.mcpServers).length) {
    console.log("No MCP servers configured. Add `mcp_servers` to ~/.neko-core/config.json, e.g.:");
    console.log('  "mcp_servers": { "fs": { "command": "bunx", "args": ["@modelcontextprotocol/server-filesystem", "."] } }');
    return 0;
  }
  const hub = await buildMcpHub(cfg.mcpServers);
  console.log(renderMcp(hub));
  await hub.close();
  return 0;
}

async function cmdRun(args: Args): Promise<number> {
  const instruction = args.positionals.join(" ").trim();
  if (!instruction) {
    console.error("neko: error: run needs an instruction, e.g. neko run \"add a test for X\"");
    return 2;
  }
  let streamed = 0;
  const { agent, close } = await buildAgent(load(args), args.yolo, (t) => {
    streamed += t.length;
    process.stdout.write(t);
  });
  try {
    const answer = await agent.run(instruction);
    process.stdout.write("\n");
    if (streamed === 0 && answer.trim()) console.log(answer); // synthetic/non-streamed result
    console.log(`[${agent.cost.summary()}]`);
  } finally {
    await close();
  }
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.command;

  if (args.version || cmd === "version") {
    console.log(`neko-core ${VERSION}`);
    return 0;
  }
  if (args.help || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  // Activation: bare `neko` (or `neko code` / `neko core`) starts the interactive session.
  if (!cmd || cmd === "chat" || cmd === "code" || cmd === "core") {
    try {
      return await cmdChat(args);
    } catch (error) {
      console.error(`neko: error: ${error instanceof Error ? error.message : error}`);
      return 1;
    }
  }

  try {
    switch (cmd) {
      case "config": return cmdConfig(args);
      case "doctor": return cmdDoctor(args);
      case "profiles": return cmdProfiles(args);
      case "init-user": console.log(initUser(args.force)); return 0;
      case "init": console.log(initProject(args.force)); return 0;
      case "tools": return cmdTools(args);
      case "agents": return cmdAgents(args);
      case "commands": return cmdCommands();
      case "capabilities": return cmdCapabilities(args);
      case "policy": return cmdPolicy(args);
      case "context": return cmdContext();
      case "sessions": return cmdSessions();
      case "skills": return cmdSkills();
      case "mcp": return await cmdMcp(args);
      case "run": return await cmdRun(args);
      default:
        console.error(`neko: error: unknown command '${cmd}'. Run 'neko --help'.`);
        return 2;
    }
  } catch (error) {
    console.error(`neko: error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

process.exit(await main());
