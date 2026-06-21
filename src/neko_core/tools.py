"""Tool registry (skeleton). Tools are how the agent acts on the world.

Planned core tools (in the spirit of Claude Code / Codex CLI):
  - bash        run a shell command (behind an approval gate)
  - read_file   read a file
  - write_file  write / patch a file
  - search      grep / find across the project

Each tool exposes a JSON-schema spec (for the model) and a Python callable. Keep
destructive tools (bash, write_file) behind an approval gate by default.

TODO (next session): define specs + implement callables + the approval policy.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass
class Tool:
    name: str
    spec: dict          # JSON schema shown to the model
    run: Callable       # the Python implementation


@dataclass
class ToolRegistry:
    tools: dict = field(default_factory=dict)

    def register(self, tool: Tool) -> None:
        self.tools[tool.name] = tool

    def specs(self) -> list:
        return [t.spec for t in self.tools.values()]
