/**
 * The Claude-Code-style introspection surfaces — the project's identity.
 * agents / commands / capabilities registries + a policy audit of the safe/gated boundary.
 */
import type { NekoConfig } from "./config.ts";
import { GATED, listTools, SAFE } from "./tools.ts";

export const READ_ONLY = "read-only";
export const READ_WRITE = "read-write";

// ---------------------------------------------------------------- agents
export interface AgentSpec {
  name: string;
  access: typeof READ_ONLY | typeof READ_WRITE;
  summary: string;
  tools: string[];
  reads: string[];
  writes: string[];
  handoff: string;
}

export const AGENTS: AgentSpec[] = [
  {
    name: "coder",
    access: READ_WRITE,
    summary: "Drives the agent loop: reads, searches, edits, and runs to complete a task.",
    tools: ["read_file", "search", "write_file", "bash"],
    reads: ["project files"],
    writes: ["project files", "shell side effects"],
    handoff: "Applies changes behind the approval gate; reports what it changed.",
  },
  {
    name: "explorer",
    access: READ_ONLY,
    summary: "Read-only mapper: locates code and summarizes structure for the coder.",
    tools: ["read_file", "search"],
    reads: ["project files"],
    writes: [],
    handoff: "Returns a map/excerpts; never mutates the workspace.",
  },
  {
    name: "reviewer",
    access: READ_ONLY,
    summary: "Read-only critic: reviews files or a diff for correctness and simplicity.",
    tools: ["read_file", "search"],
    reads: ["project files", "diffs"],
    writes: [],
    handoff: "Returns findings; changes are left to the coder behind approval.",
  },
];

export function listAgents(): AgentSpec[] {
  return AGENTS;
}

export function resolveAgent(name: string): AgentSpec {
  const agent = AGENTS.find((a) => a.name === name);
  if (!agent) {
    const available = AGENTS.map((a) => a.name).join(", ") || "none";
    throw new Error(`Unknown agent '${name}'. Available agents: ${available}`);
  }
  return agent;
}

export function renderAgents(agents: AgentSpec[]): string {
  return ["Neko Core agents", ...agents.map((a) => `[${a.access}] ${a.name}: ${a.summary}`)].join("\n");
}

export function renderAgentDetail(a: AgentSpec): string {
  const lines = [
    "Neko Core Agent", `Name: ${a.name}`, `Access: ${a.access}`, `Summary: ${a.summary}`,
    "", "Tools:", ...a.tools.map((t) => `- ${t}`),
    "", "Reads:", ...a.reads.map((r) => `- ${r}`),
    "", "Writes:", ...(a.writes.length ? a.writes.map((w) => `- ${w}`) : ["- none"]),
    "", "Handoff:", `- ${a.handoff}`,
  ];
  return lines.join("\n");
}

// -------------------------------------------------------------- commands
export interface CommandSpec {
  name: string;
  group: string;
  summary: string;
  example: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: "chat", group: "agent", summary: "Interactive agentic session (REPL).", example: "neko chat" },
  { name: "run", group: "agent", summary: "One-shot: run a single instruction.", example: "neko run 'add a test for X'" },
  { name: "config", group: "config", summary: "Show the resolved config-first settings.", example: "neko config" },
  { name: "doctor", group: "config", summary: "Read-only diagnostics (provider/model/key).", example: "neko doctor" },
  { name: "profiles", group: "config", summary: "List the named runtime profiles.", example: "neko profiles" },
  { name: "init-user", group: "config", summary: "Scaffold ~/.neko-core/config.json.", example: "neko init-user" },
  { name: "init", group: "config", summary: "Scaffold ./.neko-core/config.json.", example: "neko init" },
  { name: "tools", group: "registry", summary: "List tool contracts (safe/gated).", example: "neko tools write_file" },
  { name: "agents", group: "registry", summary: "List agent roles and boundaries.", example: "neko agents coder" },
  { name: "commands", group: "registry", summary: "List the CLI command surface.", example: "neko commands" },
  { name: "capabilities", group: "registry", summary: "List runtime/CLI capabilities.", example: "neko capabilities" },
  { name: "policy", group: "registry", summary: "Audit the safe/gated permission boundary.", example: "neko policy" },
];

export function listCommands(): CommandSpec[] {
  return COMMANDS;
}

export function renderCommands(commands: CommandSpec[]): string {
  const lines = ["Neko Core commands"];
  for (const c of commands) {
    lines.push(`[${c.group}] ${c.name}: ${c.summary}`);
    lines.push(`    e.g. ${c.example}`);
  }
  return lines.join("\n");
}

// ----------------------------------------------------------- capabilities
export interface Capability {
  name: string;
  klass: "agent" | "tool" | "cli";
  status: string;
  detail: string;
}

export function collectCapabilities(config: NekoConfig): Capability[] {
  const auto = config.approval === "auto";
  return [
    { name: "agent_loop", klass: "agent", status: "enabled", detail: `complete -> tool-calls -> observe, capped at max_steps=${config.maxSteps}` },
    { name: "model_completion", klass: "agent", status: "enabled", detail: `${config.provider}: ${config.model || "(model unset)"}` },
    { name: "file_read", klass: "tool", status: "enabled", detail: "read_file + search (safe, no approval)" },
    { name: "file_write", klass: "tool", status: "enabled", detail: "write_file (gated: needs approval)" },
    { name: "shell", klass: "tool", status: "enabled", detail: "bash (gated: needs approval)" },
    { name: "approval_gate", klass: "agent", status: "enabled", detail: `mode=${config.approval}` },
    { name: "bounded_autopilot", klass: "agent", status: auto ? "enabled" : "disabled", detail: "approval=auto (--yolo): gated tools run without prompting; a named state, not hidden" },
    { name: "introspection", klass: "cli", status: "enabled", detail: "tools/agents/commands/capabilities/policy registries" },
  ];
}

export function renderCapabilities(caps: Capability[]): string {
  return ["Neko Core capabilities", ...caps.map((c) => `[${c.klass}] ${c.name}: ${c.status} - ${c.detail}`)].join("\n");
}

// --------------------------------------------------------------- policy
export interface PolicyFinding {
  severity: "fail" | "warn";
  code: string;
  subject: string;
  message: string;
}

export interface PolicyReport {
  verdict: "pass" | "warn" | "fail";
  findings: PolicyFinding[];
}

const MUST_BE_GATED = new Set(["write_file", "bash"]);
const MUST_BE_SAFE = new Set(["read_file", "search"]);

export function evaluatePolicy(config: NekoConfig): PolicyReport {
  const tools = listTools();
  const agents = listAgents();
  const commands = listCommands();
  const findings: PolicyFinding[] = [];

  checkUnique("tool", tools.map((t) => t.name), findings);
  checkUnique("agent", agents.map((a) => a.name), findings);
  checkUnique("command", commands.map((c) => c.name), findings);

  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  for (const tool of tools) {
    if (MUST_BE_GATED.has(tool.name) && tool.permission !== GATED) {
      findings.push({ severity: "fail", code: "mutating_tool_not_gated", subject: tool.name, message: "A tool that writes files or runs commands must be permission=gated." });
    }
    if (MUST_BE_SAFE.has(tool.name) && tool.permission !== SAFE) {
      findings.push({ severity: "warn", code: "reader_over_restricted", subject: tool.name, message: "A read-only tool is marked gated; it could run without approval." });
    }
  }

  for (const agent of agents) {
    for (const toolName of agent.tools) {
      const spec = toolsByName.get(toolName);
      if (!spec) {
        findings.push({ severity: "fail", code: "agent_unknown_tool", subject: `${agent.name}:${toolName}`, message: "Agent references a tool that is not in the registry." });
      } else if (agent.access === READ_ONLY && spec.permission === GATED) {
        findings.push({ severity: "fail", code: "read_only_agent_gated_tool", subject: `${agent.name}:${toolName}`, message: "A read-only agent must not hold a gated (mutating) tool." });
      }
    }
  }

  if (config.approval === "auto") {
    findings.push({ severity: "warn", code: "bounded_autonomy_on", subject: "approval", message: "approval=auto (--yolo): gated tools run without prompting. Named state, not hidden." });
  }

  const verdict = findings.some((f) => f.severity === "fail")
    ? "fail"
    : findings.some((f) => f.severity === "warn")
      ? "warn"
      : "pass";
  return { verdict, findings };
}

export function renderPolicyReport(report: PolicyReport): string {
  const lines = ["Neko Core policy", `Verdict: ${report.verdict.toUpperCase()}`, "", "Findings:"];
  if (!report.findings.length) {
    lines.push("- PASS the safe/gated boundary is consistent.");
    return lines.join("\n");
  }
  for (const f of report.findings) {
    lines.push(`- ${f.severity.toUpperCase()} ${f.code} [${f.subject}]: ${f.message}`);
  }
  return lines.join("\n");
}

function checkUnique(kind: string, names: string[], findings: PolicyFinding[]): void {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  for (const [name, count] of [...counts].sort()) {
    if (count > 1) {
      findings.push({ severity: "fail", code: `duplicate_${kind}`, subject: name, message: `${kind[0].toUpperCase()}${kind.slice(1)} names must be unique.` });
    }
  }
}
