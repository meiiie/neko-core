"""The agentic loop.

    while not done and steps < max_steps:
        response = provider.complete(messages, tools=tool_schemas())
        if response.tool_calls:
            for call in response.tool_calls:
                observation = tools.execute(call)      # read / search / write / bash
                messages.append(tool_result(call, observation))
        else:
            done = True                                # model produced a final answer

The ``max_steps`` cap is load-bearing: an agent without one can loop forever and burn
money. Tool results (including errors and denials) are fed back as observations so the
model can adapt rather than crash.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

from .tools import tool_schemas

DEFAULT_SYSTEM_PROMPT = (
    "You are Neko Core, a local-first coding agent. Complete the user's task by calling "
    "tools.\n"
    "Tools: read_file and search are read-only; write_file and bash change the workspace "
    "and require approval.\n"
    "Work in small steps: inspect before you edit, make the smallest change that solves "
    "the task, and verify your work. When the task is done, reply with a short summary and "
    "stop calling tools."
)

# on_event(kind, data): kind in {"tool_call", "tool_result", "final", "max_steps"}.
EventHook = Callable[[str, Any], None]


@dataclass
class Agent:
    provider: Any                      # neko_core.providers.Provider
    tools: Any                         # neko_core.tool_runtime.ToolRegistry
    max_steps: int = 20
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    on_event: EventHook | None = None
    messages: list[dict] = field(default_factory=list)

    def run(self, instruction: str) -> str:
        """Run the loop until the model is done or max_steps is hit. Returns the final text."""
        if not self.messages:
            self.messages.append({"role": "system", "content": self.system_prompt})
        self.messages.append({"role": "user", "content": instruction})

        for _ in range(self.max_steps):
            response = self.provider.complete(self.messages, tools=tool_schemas())
            content = response.get("content")
            tool_calls = response.get("tool_calls") or []

            if not tool_calls:
                final = content or ""
                self.messages.append({"role": "assistant", "content": final})
                self._emit("final", final)
                return final

            self.messages.append(_assistant_tool_message(content, tool_calls))
            for call in tool_calls:
                self._emit("tool_call", call)
                observation = self.tools.execute(call["name"], call["arguments"])
                self._emit("tool_result", {"call": call, "observation": observation})
                self.messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id") or call["name"],
                        "content": observation,
                    }
                )

        self._emit("max_steps", self.max_steps)
        return f"[stopped: reached max_steps={self.max_steps}]"

    def _emit(self, kind: str, data: Any) -> None:
        if self.on_event is not None:
            self.on_event(kind, data)


def _assistant_tool_message(content: str | None, tool_calls: list[dict]) -> dict:
    """Rebuild the OpenAI-format assistant turn so the next request carries the
    tool_calls the model made (ids must match the following tool results)."""
    return {
        "role": "assistant",
        "content": content or "",
        "tool_calls": [
            {
                "id": call.get("id") or call["name"],
                "type": "function",
                "function": {
                    "name": call["name"],
                    "arguments": json.dumps(call.get("arguments") or {}),
                },
            }
            for call in tool_calls
        ],
    }
