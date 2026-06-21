"""Coding-agent tool contracts — the registry the model sees and the policy gate audits.

Two permission classes, the coding-agent analog of the heritage harness's
runtime/development boundary:

  - ``safe``  : read-only, never mutates the workspace -> runs without approval.
  - ``gated`` : writes files or runs commands -> approval-gated by default
                (the ``--yolo`` / approval=auto named state auto-approves).

This module is the declarative source of truth: the tool contracts + their JSON
schema for the model. The executable registry + approval gate (Step 3) attach the
Python callables to these specs; ``neko tools`` and ``neko policy`` read them here.
"""
from __future__ import annotations

from dataclasses import dataclass

SAFE = "safe"
GATED = "gated"


@dataclass(frozen=True)
class ToolSpec:
    name: str
    permission: str          # SAFE | GATED
    summary: str
    parameters: dict         # JSON-schema "properties" shown to the model
    required: tuple[str, ...]


TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="read_file",
        permission=SAFE,
        summary="Read a UTF-8 text file from the project.",
        parameters={
            "path": {"type": "string", "description": "File path, relative to the project root."},
        },
        required=("path",),
    ),
    ToolSpec(
        name="search",
        permission=SAFE,
        summary="Search file contents by regular expression across the project.",
        parameters={
            "pattern": {"type": "string", "description": "Regular expression to search for."},
            "path": {"type": "string", "description": "Directory to search (default: project root)."},
        },
        required=("pattern",),
    ),
    ToolSpec(
        name="write_file",
        permission=GATED,
        summary="Create or overwrite a file with new contents (approval-gated).",
        parameters={
            "path": {"type": "string", "description": "File path to write, relative to the project root."},
            "content": {"type": "string", "description": "The full new file contents."},
        },
        required=("path", "content"),
    ),
    ToolSpec(
        name="bash",
        permission=GATED,
        summary="Run a shell command in the project root (approval-gated).",
        parameters={
            "command": {"type": "string", "description": "The shell command to run."},
        },
        required=("command",),
    ),
)


def list_tools() -> tuple[ToolSpec, ...]:
    return TOOL_SPECS


def resolve_tool(name: str) -> ToolSpec:
    for spec in TOOL_SPECS:
        if spec.name == name:
            return spec
    available = ", ".join(spec.name for spec in TOOL_SPECS) or "none"
    raise ValueError(f"Unknown tool '{name}'. Available tools: {available}")


def to_openai_schema(spec: ToolSpec) -> dict:
    """Render a ToolSpec as an OpenAI-style function tool (for the provider call)."""
    return {
        "type": "function",
        "function": {
            "name": spec.name,
            "description": spec.summary,
            "parameters": {
                "type": "object",
                "properties": dict(spec.parameters),
                "required": list(spec.required),
            },
        },
    }


def tool_schemas() -> list[dict]:
    return [to_openai_schema(spec) for spec in TOOL_SPECS]


def render_tools(specs: tuple[ToolSpec, ...]) -> str:
    lines = ["Neko Core tools"]
    for spec in specs:
        lines.append(f"[{spec.permission}] {spec.name}: {spec.summary}")
    return "\n".join(lines)


def render_tool_detail(spec: ToolSpec) -> str:
    lines = [
        "Neko Core Tool",
        f"Name: {spec.name}",
        f"Permission: {spec.permission}",
        f"Summary: {spec.summary}",
        "",
        "Parameters:",
    ]
    for name, definition in spec.parameters.items():
        flag = " (required)" if name in spec.required else ""
        lines.append(f"- {name}: {definition.get('type', '?')}{flag} - {definition.get('description', '')}")
    return "\n".join(lines)
