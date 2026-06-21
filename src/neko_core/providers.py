"""LLM providers behind one `complete()` contract (provider-agnostic core).

A provider turns a message list (+ optional tool specs) into a response. The core
never imports a vendor SDK directly — providers are swappable (config-first).

Planned providers:
  - local_llamacpp : offline, llama.cpp / GGUF (the default; offline-first)
  - openai_compat  : any OpenAI-compatible endpoint (incl. Anthropic-compat shims)

TODO (next session): implement the two providers + streaming + tool-call parsing.
"""
from __future__ import annotations

from typing import Protocol


class Provider(Protocol):
    def complete(self, messages: list, tools: list | None = None) -> dict:
        """Return {'content': str, 'tool_calls': [...]}. Implemented per provider."""
        ...


def get_provider(name: str) -> Provider:
    raise NotImplementedError(
        f"provider {name!r} not implemented yet — see docs/ARCHITECTURE.md"
    )
