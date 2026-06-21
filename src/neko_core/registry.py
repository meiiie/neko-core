"""The Claude-Code-style introspection surfaces — the project's identity.

Four read-only registries make every capability explicit and auditable, the
discipline borrowed from Claude Code / Codex:

  - agents       : named roles (coder, explorer, reviewer) + their tool/access boundaries
  - commands     : the CLI surface map
  - capabilities : runtime vs CLI capabilities in one list
  - policy       : audits the safe/gated boundary + least-privilege of read-only agents

``neko agents/commands/capabilities/tools/policy`` render these. ``policy`` is also
the permission gate's audit: it fails CI if a mutating tool is mis-classified as safe
or a read-only agent is handed a gated tool.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Iterable

from .config import NekoConfig
from .tools import GATED, SAFE, ToolSpec, list_tools

READ_ONLY = "read-only"
READ_WRITE = "read-write"


# --------------------------------------------------------------------------- agents
@dataclass(frozen=True)
class AgentSpec:
    name: str
    access: str          # READ_ONLY | READ_WRITE
    summary: str
    tools: tuple[str, ...]
    reads: tuple[str, ...]
    writes: tuple[str, ...]
    handoff: str


AGENTS: tuple[AgentSpec, ...] = (
    AgentSpec(
        name="coder",
        access=READ_WRITE,
        summary="Drives the agent loop: reads, searches, edits, and runs to complete a task.",
        tools=("read_file", "search", "write_file", "bash"),
        reads=("project files",),
        writes=("project files", "shell side effects"),
        handoff="Applies changes behind the approval gate; reports what it changed.",
    ),
    AgentSpec(
        name="explorer",
        access=READ_ONLY,
        summary="Read-only mapper: locates code and summarizes structure for the coder.",
        tools=("read_file", "search"),
        reads=("project files",),
        writes=(),
        handoff="Returns a map/excerpts; never mutates the workspace.",
    ),
    AgentSpec(
        name="reviewer",
        access=READ_ONLY,
        summary="Read-only critic: reviews files or a diff for correctness and simplicity.",
        tools=("read_file", "search"),
        reads=("project files", "diffs"),
        writes=(),
        handoff="Returns findings; changes are left to the coder behind approval.",
    ),
)


def list_agents() -> tuple[AgentSpec, ...]:
    return AGENTS


def resolve_agent(name: str) -> AgentSpec:
    for agent in AGENTS:
        if agent.name == name:
            return agent
    available = ", ".join(agent.name for agent in AGENTS) or "none"
    raise ValueError(f"Unknown agent '{name}'. Available agents: {available}")


def render_agents(agents: tuple[AgentSpec, ...]) -> str:
    lines = ["Neko Core agents"]
    for agent in agents:
        lines.append(f"[{agent.access}] {agent.name}: {agent.summary}")
    return "\n".join(lines)


def render_agent_detail(agent: AgentSpec) -> str:
    lines = [
        "Neko Core Agent",
        f"Name: {agent.name}",
        f"Access: {agent.access}",
        f"Summary: {agent.summary}",
        "",
        "Tools:",
    ]
    lines.extend(f"- {tool}" for tool in agent.tools)
    lines.extend(["", "Reads:"])
    lines.extend(f"- {item}" for item in agent.reads)
    lines.extend(["", "Writes:"])
    if agent.writes:
        lines.extend(f"- {item}" for item in agent.writes)
    else:
        lines.append("- none")
    lines.extend(["", "Handoff:", f"- {agent.handoff}"])
    return "\n".join(lines)


# ------------------------------------------------------------------------- commands
@dataclass(frozen=True)
class CommandSpec:
    name: str
    group: str
    summary: str
    example: str


COMMANDS: tuple[CommandSpec, ...] = (
    CommandSpec("chat", "agent", "Interactive agentic session (REPL).", "neko chat"),
    CommandSpec("run", "agent", "One-shot: run a single instruction.", "neko run 'add a test for X'"),
    CommandSpec("config", "config", "Show the resolved config-first settings.", "neko config"),
    CommandSpec("doctor", "config", "Read-only diagnostics (provider/model/key).", "neko doctor"),
    CommandSpec("profiles", "config", "List the named runtime profiles.", "neko profiles"),
    CommandSpec("init-user", "config", "Scaffold ~/.neko-core/config.json.", "neko init-user"),
    CommandSpec("init", "config", "Scaffold ./.neko-core/config.json (project-local).", "neko init"),
    CommandSpec("tools", "registry", "List tool contracts (safe/gated).", "neko tools write_file"),
    CommandSpec("agents", "registry", "List agent roles and boundaries.", "neko agents coder"),
    CommandSpec("commands", "registry", "List the CLI command surface.", "neko commands"),
    CommandSpec("capabilities", "registry", "List runtime/CLI capabilities.", "neko capabilities"),
    CommandSpec("policy", "registry", "Audit the safe/gated permission boundary.", "neko policy"),
)


def list_commands() -> tuple[CommandSpec, ...]:
    return COMMANDS


def render_commands(commands: tuple[CommandSpec, ...]) -> str:
    lines = ["Neko Core commands"]
    for command in commands:
        lines.append(f"[{command.group}] {command.name}: {command.summary}")
        lines.append(f"    e.g. {command.example}")
    return "\n".join(lines)


# --------------------------------------------------------------------- capabilities
@dataclass(frozen=True)
class Capability:
    name: str
    klass: str           # "agent" | "tool" | "cli"
    status: str
    detail: str


def collect_capabilities(config: NekoConfig) -> tuple[Capability, ...]:
    auto = config.approval == "auto"
    return (
        Capability("agent_loop", "agent", "enabled", f"complete -> tool-calls -> observe, capped at max_steps={config.max_steps}"),
        Capability("model_completion", "agent", "enabled", f"{config.provider}: {config.model or '(model unset)'}"),
        Capability("file_read", "tool", "enabled", "read_file + search (safe, no approval)"),
        Capability("file_write", "tool", "enabled", "write_file (gated: needs approval)"),
        Capability("shell", "tool", "enabled", "bash (gated: needs approval)"),
        Capability("approval_gate", "agent", "enabled", f"mode={config.approval}"),
        Capability("bounded_autopilot", "agent", "enabled" if auto else "disabled",
                   "approval=auto (--yolo): gated tools run without prompting; a named state, not hidden"),
        Capability("introspection", "cli", "enabled", "tools/agents/commands/capabilities/policy registries"),
    )


def render_capabilities(capabilities: tuple[Capability, ...]) -> str:
    lines = ["Neko Core capabilities"]
    for capability in capabilities:
        lines.append(f"[{capability.klass}] {capability.name}: {capability.status} - {capability.detail}")
    return "\n".join(lines)


# -------------------------------------------------------------------------- policy
@dataclass(frozen=True)
class PolicyFinding:
    severity: str        # "fail" | "warn"
    code: str
    subject: str
    message: str


@dataclass(frozen=True)
class PolicyReport:
    verdict: str         # "pass" | "warn" | "fail"
    findings: tuple[PolicyFinding, ...]


# Tools that touch the world MUST be gated; pure readers MUST be safe.
_MUST_BE_GATED = {"write_file", "bash"}
_MUST_BE_SAFE = {"read_file", "search"}


def evaluate_policy(config: NekoConfig) -> PolicyReport:
    tools = list_tools()
    agents = list_agents()
    commands = list_commands()
    findings: list[PolicyFinding] = []

    _check_unique("tool", (tool.name for tool in tools), findings)
    _check_unique("agent", (agent.name for agent in agents), findings)
    _check_unique("command", (command.name for command in commands), findings)

    tools_by_name = {tool.name: tool for tool in tools}
    for tool in tools:
        if tool.name in _MUST_BE_GATED and tool.permission != GATED:
            findings.append(PolicyFinding(
                "fail", "mutating_tool_not_gated", tool.name,
                "A tool that writes files or runs commands must be permission=gated."))
        if tool.name in _MUST_BE_SAFE and tool.permission != SAFE:
            findings.append(PolicyFinding(
                "warn", "reader_over_restricted", tool.name,
                "A read-only tool is marked gated; it could run without approval."))

    # Least privilege: read-only agents must not hold gated tools, and every tool an
    # agent references must exist.
    for agent in agents:
        for tool_name in agent.tools:
            spec = tools_by_name.get(tool_name)
            if spec is None:
                findings.append(PolicyFinding(
                    "fail", "agent_unknown_tool", f"{agent.name}:{tool_name}",
                    "Agent references a tool that is not in the registry."))
            elif agent.access == READ_ONLY and spec.permission == GATED:
                findings.append(PolicyFinding(
                    "fail", "read_only_agent_gated_tool", f"{agent.name}:{tool_name}",
                    "A read-only agent must not hold a gated (mutating) tool."))

    if config.approval == "auto":
        findings.append(PolicyFinding(
            "warn", "bounded_autonomy_on", "approval",
            "approval=auto (--yolo): gated tools run without prompting. Named state, not hidden."))

    if any(finding.severity == "fail" for finding in findings):
        verdict = "fail"
    elif any(finding.severity == "warn" for finding in findings):
        verdict = "warn"
    else:
        verdict = "pass"
    return PolicyReport(verdict=verdict, findings=tuple(findings))


def render_policy_report(report: PolicyReport) -> str:
    lines = ["Neko Core policy", f"Verdict: {report.verdict.upper()}", "", "Findings:"]
    if not report.findings:
        lines.append("- PASS the safe/gated boundary is consistent.")
        return "\n".join(lines)
    for finding in report.findings:
        lines.append(f"- {finding.severity.upper()} {finding.code} [{finding.subject}]: {finding.message}")
    return "\n".join(lines)


def _check_unique(kind: str, names: Iterable[str], findings: list[PolicyFinding]) -> None:
    counts = Counter(str(name) for name in names)
    for name, count in sorted(counts.items()):
        if count > 1:
            findings.append(PolicyFinding(
                "fail", f"duplicate_{kind}", name, f"{kind.capitalize()} names must be unique."))
