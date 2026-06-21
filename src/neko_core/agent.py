"""The agentic loop (skeleton).

Intended shape (see docs/ARCHITECTURE.md), in the spirit of Claude Code / Codex CLI:

    while not done and steps < max_steps:
        response = provider.complete(messages, tools=registry.specs())
        if response.tool_calls:
            for call in response.tool_calls:
                result = registry.run(call)      # bash / edit / read / search ...
                messages.append(tool_result(call, result))
        else:
            done = True                          # model produced a final answer

TODO (next session): wire provider + tool registry, streaming, approval gates,
context management. Keep the max_steps cap — an agent without one can burn money.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Agent:
    provider: object = None     # neko_core.providers.Provider
    tools: object = None        # neko_core.tools.ToolRegistry
    max_steps: int = 20
    messages: list = field(default_factory=list)

    def run(self, instruction: str) -> str:
        """Run the agent loop until the model is done or max_steps is hit."""
        raise NotImplementedError("agent loop not wired yet — see docs/ARCHITECTURE.md")
