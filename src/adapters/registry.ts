/**
 * The Claude-Code-style introspection surfaces — the project's identity.
 * agents / commands / capabilities registries + a policy audit of the safe/gated boundary.
 */
import type { NekoConfig } from "./config.ts";
import { detectSandbox, sandboxActive, type SandboxKind } from "../core/sandbox.ts";
import { GATED, listTools, SAFE } from "../core/tools.ts";

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
    tools: ["read_file", "search", "glob", "ls", "write_file", "edit", "bash"],
    reads: ["project files"],
    writes: ["project files", "shell side effects"],
    handoff: "Applies changes behind the approval gate; reports what it changed.",
  },
  {
    name: "explorer",
    access: READ_ONLY,
    summary: "Read-only mapper: locates code and summarizes structure for the coder.",
    tools: ["read_file", "search", "glob", "ls"],
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
  { name: "resume", group: "agent", summary: "Resume the latest or an exact saved session.", example: "neko resume <session-id>" },
  { name: "run", group: "agent", summary: "One-shot: run a single instruction.", example: "neko run 'add a test for X'" },
  { name: "acp", group: "agent", summary: "Serve stable ACP v1 over stdio for editor clients.", example: "neko acp" },
  { name: "oracle", group: "agent", summary: "Ask a configured stronger model for a second opinion.", example: "neko oracle -p 'review this design'" },
  { name: "bench", group: "agent", summary: "Run the configured model through Neko's benchmark tiers.", example: "neko bench hard" },
  { name: "config", group: "config", summary: "Show the resolved config-first settings.", example: "neko config" },
  { name: "doctor", group: "config", summary: "Read-only diagnostics (provider/model/key).", example: "neko doctor" },
  { name: "profiles", group: "config", summary: "List the named runtime profiles.", example: "neko profiles" },
  { name: "init-user", group: "config", summary: "Scaffold user config, Neko Core identity, and bounded local memory.", example: "neko init-user" },
  { name: "init", group: "config", summary: "Scaffold ./.neko-core/config.json.", example: "neko init" },
  { name: "login", group: "config", summary: "Sign in or save a provider API key.", example: "neko login" },
  { name: "logout", group: "config", summary: "Sign out the active provider route.", example: "neko logout" },
  { name: "update", group: "config", summary: "Install the latest or an exact Neko release.", example: "neko update" },
  { name: "tools", group: "registry", summary: "List tool contracts (safe/gated).", example: "neko tools write_file" },
  { name: "agents", group: "registry", summary: "List agent roles and boundaries.", example: "neko agents coder" },
  { name: "commands", group: "registry", summary: "List the CLI command surface.", example: "neko commands" },
  { name: "capabilities", group: "registry", summary: "List runtime/CLI capabilities.", example: "neko capabilities" },
  { name: "policy", group: "registry", summary: "Audit the safe/gated permission boundary.", example: "neko policy" },
  { name: "trust", group: "config", summary: "Manage exact project control-surface trust.", example: "neko trust status" },
  { name: "handoff", group: "config", summary: "Send or inspect immutable summary-only session handoffs.", example: "neko handoff inbox <session-id>" },
  { name: "context", group: "registry", summary: "Show global identity and project context files.", example: "neko context" },
  { name: "sessions", group: "config", summary: "List saved chat sessions.", example: "neko sessions" },
  { name: "skills", group: "registry", summary: "List available skills (~/.neko-core/skills).", example: "neko skills" },
  { name: "procurement", group: "local", summary: "Run deterministic sourcing helpers bundled in the standalone binary.", example: "neko procurement source-plan 83KY001VVN --category laptop" },
  { name: "recipes", group: "registry", summary: "List runnable recipes (~/.neko-core/recipes).", example: "neko recipes" },
  { name: "mcp", group: "registry", summary: "List configured MCP servers and their tools.", example: "neko mcp" },
  { name: "support", group: "config", summary: "Inspect or manage optional local support packs.", example: "neko support meeting status" },
  { name: "browser", group: "local", summary: "Set up or inspect explicit-tab browser control.", example: "neko browser status" },
  { name: "meeting", group: "local", summary: "Consented local meeting capture, transcription, evidence, and evaluation.", example: "neko meeting status" },
  { name: "setup", group: "config", summary: "Web stack + browser identity (persistent, existing-Chrome attach, or isolated).", example: "neko setup browser persistent" },
  { name: "version", group: "registry", summary: "Print the Neko Core version.", example: "neko version" },
  { name: "help", group: "registry", summary: "Show CLI usage and options.", example: "neko help" },
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
  const auto = config.mode === "auto";
  return [
    { name: "agent_loop", klass: "agent", status: "enabled", detail: `complete -> tool-calls -> observe, capped at max_steps=${config.maxSteps}` },
    { name: "model_completion", klass: "agent", status: "enabled", detail: `${config.provider}: ${config.model || "(model unset)"}` },
    { name: "file_read", klass: "tool", status: "enabled", detail: "read_file + search + glob + ls (safe, no approval)" },
    { name: "file_write", klass: "tool", status: "enabled", detail: "write_file + edit (gated: needs approval)" },
    {
      name: "shell",
      klass: "tool",
      status: "enabled",
      // "Gated-but-sandboxed" is a NAMED state like mode=auto: the gate stays in the contract,
      // the prompt is skipped only while confinement is LIVE (primitive + provisioning).
      detail: config.sandbox && config.sandboxAutoApprove && sandboxActive()
        ? `bash (gated; explicitly auto-approved while OS-sandboxed: writes confined to workspace/temp, host reads remain available; sandbox_auto_approve=false to prompt)`
        : "bash (gated: needs approval)",
    },
    { name: "permission_modes", klass: "agent", status: "enabled", detail: "default / accept-edits / plan / auto (Shift+Tab to cycle in chat)" },
    { name: "approval_gate", klass: "agent", status: "enabled", detail: `mode=${config.mode}` },
    { name: "bounded_autopilot", klass: "agent", status: auto ? "enabled" : "disabled", detail: "mode=auto (--yolo): bounded gated tools run without prompting; host computer control still requires explicit consent" },
    { name: "introspection", klass: "cli", status: "enabled", detail: "tools/agents/commands/capabilities/policy registries" },
    { name: "meeting_companion", klass: "tool", status: "enabled", detail: "explicit-consent local capture; optional local transcription; timestamped evidence" },
  ];
}

export function renderCapabilities(caps: Capability[]): string {
  return ["Neko Core capabilities", ...caps.map((c) => `[${c.klass}] ${c.name}: ${c.status} - ${c.detail}`)].join("\n");
}

// --------------------------------------------------------------- policy
export interface PolicyFinding {
  /** `info` states a deliberate posture rather than a problem; it never moves the verdict. */
  severity: "fail" | "warn" | "info";
  code: string;
  subject: string;
  message: string;
}

export interface PolicyReport {
  verdict: "pass" | "warn" | "fail";
  findings: PolicyFinding[];
}

export interface SandboxRuntimeStatus {
  readonly kind: SandboxKind;
  readonly live: boolean;
  readonly provisioned?: boolean;
  readonly detail?: string;
}

const MUST_BE_GATED = new Set(["write_file", "edit", "multi_edit", "bash", "computer", "task"]);
const MUST_BE_SAFE = new Set(["read_file", "search", "glob", "ls", "web_search", "web_fetch", "skill"]);
const MUST_GATE_ACTIONS: Record<string, string[]> = {
  memory: ["write", "append", "delete"],
  workflow: ["write", "delete"],
  playbook: ["add", "revise", "remove"],
};

export function evaluatePolicy(config: NekoConfig, sandboxRuntime?: SandboxRuntimeStatus): PolicyReport {
  const tools = listTools();
  const agents = listAgents();
  const commands = listCommands();
  const findings: PolicyFinding[] = [];
  const sandboxKind = sandboxRuntime?.kind ?? detectSandbox();
  const sandboxLive = config.mode === "auto" && config.sandbox && sandboxKind !== "none" &&
    (sandboxRuntime?.live ?? sandboxActive());

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
  for (const [name, actions] of Object.entries(MUST_GATE_ACTIONS)) {
    const spec = toolsByName.get(name);
    if (!spec) continue;
    const missing = actions.filter((action) => !spec.gatedActions?.includes(action));
    if (missing.length) {
      findings.push({
        severity: "fail",
        code: "mutating_action_not_gated",
        subject: name,
        message: `Mutating actions must be gated: ${missing.join(", ")}.`,
      });
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

  if (config.mode === "auto") {
    findings.push({ severity: "warn", code: "bounded_autonomy_on", subject: "mode", message: "mode=auto (--yolo): gated tools run without prompting. Named state, not hidden." });
    if (!config.sandbox || sandboxKind === "none") {
      findings.push({
        severity: "warn",
        code: "auto_without_live_sandbox",
        subject: "mode+sandbox",
        message: "UNCONFINED AUTO: bash runs without approval and no live OS sandbox contains it. The catastrophic-command seatbelt remains, but it is not confinement.",
      });
    } else if (!sandboxLive) {
      findings.push({
        severity: "warn",
        code: "auto_with_unusable_sandbox",
        subject: "bash+sandbox",
        message: `BASH FAILS CLOSED: the configured ${sandboxKind} sandbox is present but unusable, so Neko refuses bash execution instead of falling back to the host. Other gated tools remain in auto mode.`,
      });
    }
  }

  if (config.projectTrust.state === "untrusted" || config.projectTrust.state === "changed" || config.projectTrust.state === "error") {
    findings.push({
      severity: "warn",
      code: config.projectTrust.state === "error" ? "project_trust_error" : "project_config_untrusted",
      subject: "project_trust",
      message: `Project control surfaces are quarantined (${config.projectTrust.state}) and were not loaded. Run 'neko trust status' before trusting this checkout.`,
    });
  }

  // Reads reaching outside the project is a deliberate default, not a leak: writes stay confined and
  // credential paths are refused either way. It is reported so the boundary stays something you can
  // read off a command rather than something you have to trust.
  if (config.readOutsideRoot) {
    findings.push({
      severity: "info",
      code: "reads_outside_root",
      subject: "read_outside_root",
      message: "Reads may resolve outside the project directory. Structured writes and edits stay project-confined; bash confinement requires a live OS sandbox. Credential paths (SSH, .env, key material, browser stores) stay refused. Set read_outside_root:false for a hard read wall.",
    });
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
  // An informational line states a posture, not a problem — it must not swallow the reassurance that
  // the boundary itself audited clean.
  if (!report.findings.some((f) => f.severity !== "info")) {
    lines.push("- PASS the safe/gated boundary is consistent.");
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
