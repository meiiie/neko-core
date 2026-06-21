"""LLM providers behind one ``complete()`` contract (provider-agnostic core).

A provider turns a chat message list (+ optional tool specs) into a response:

    {"content": str | None, "tool_calls": [{"id", "name", "arguments"}]}

The core never imports a vendor SDK at module load — providers are swappable
(config-first) and bring their own optional dependency.

Providers:
  - openai_compat  : any OpenAI-compatible ``/chat/completions`` endpoint (NVIDIA NIM,
                     OpenAI, FPT, or a local llama-server). The default; needs only a
                     base_url + model + key (key via env/JSON, never committed).
  - local_llamacpp : in-process llama.cpp / GGUF (offline). Optional ``[local]`` extra.

Retry/backoff + key precedence are ported from the heritage harness's nvidia_client.
"""
from __future__ import annotations

import json
import time
from typing import Any, Protocol

from .config import NekoConfig

_RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class Provider(Protocol):
    def complete(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        """Return ``{"content": str|None, "tool_calls": [{"id","name","arguments"}]}``."""
        ...


def get_provider(config: NekoConfig) -> Provider:
    name = config.provider
    if name == "openai_compat":
        return OpenAICompatProvider(config)
    if name == "local_llamacpp":
        return LocalLlamaProvider(config)
    raise ValueError(f"Unknown provider {name!r}. Use openai_compat or local_llamacpp.")


class OpenAICompatProvider:
    """POSTs ``{base_url}/chat/completions`` against any OpenAI-compatible endpoint."""

    def __init__(self, config: NekoConfig) -> None:
        self._cfg = config

    def complete(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        import requests  # lazy: keep the core import-light

        if not self._cfg.base_url:
            raise RuntimeError(
                "openai_compat needs a base_url (set runtime.base_url or pick a --profile)."
            )
        if not self._cfg.model:
            raise RuntimeError(
                "openai_compat needs a model (set runtime.model or pick a --profile)."
            )
        key = self._cfg.api_key
        if not key:
            raise RuntimeError(
                "No API key. Set NEKO_API_KEY (or OPENAI_API_KEY / NVIDIA_API_KEY), or add "
                '"api_key" to ~/.neko-core/config.json (run `neko init-user`).'
            )

        payload: dict[str, Any] = {
            "model": self._cfg.model,
            "messages": messages,
            "temperature": self._cfg.temperature,
            "max_tokens": self._cfg.max_tokens,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        url = f"{self._cfg.base_url}/chat/completions"

        last_error: Exception | None = None
        for attempt in range(self._cfg.max_retries + 1):
            response = None
            try:
                response = requests.post(
                    url, headers=headers, json=payload, timeout=self._cfg.timeout_seconds
                )
                response.raise_for_status()
                return _parse_openai_message(response.json())
            except requests.HTTPError as error:
                last_error = error
                status = response.status_code if response is not None else None
                if status not in _RETRYABLE_STATUS or attempt >= self._cfg.max_retries:
                    break
                time.sleep(self._retry_delay(attempt))
            except Exception as error:  # noqa: BLE001 - retry boundary
                last_error = error
                if attempt >= self._cfg.max_retries:
                    break
                time.sleep(self._retry_delay(attempt))
        raise RuntimeError(f"openai_compat completion failed: {last_error}") from last_error

    def _retry_delay(self, attempt: int) -> float:
        exponential = self._cfg.retry_base_delay_seconds * (2 ** attempt)
        return min(self._cfg.retry_max_delay_seconds, exponential)


class LocalLlamaProvider:
    """In-process llama.cpp / GGUF (offline). Needs the optional ``[local]`` extra.

    Uses llama-cpp-python's OpenAI-style ``create_chat_completion`` so tool-calls work
    on recent llama-cpp-python with a tool-capable model.
    """

    def __init__(self, config: NekoConfig) -> None:
        self._cfg = config
        self._llm: Any | None = None

    def complete(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        llm = self._load()
        kwargs: dict[str, Any] = {
            "messages": messages,
            "temperature": self._cfg.temperature,
            "max_tokens": self._cfg.max_tokens,
        }
        if tools:
            kwargs["tools"] = tools
        return _parse_openai_message(llm.create_chat_completion(**kwargs))

    def _load(self) -> Any:
        if self._llm is not None:
            return self._llm
        from pathlib import Path

        raw_path = self._cfg.local_model_path
        path = Path(raw_path).expanduser() if raw_path else None
        if path is None or not path.exists():
            raise RuntimeError(
                f"Local model not found: {raw_path or '(unset)'}. "
                "Set runtime.local_model_path to a .gguf file."
            )
        try:
            from llama_cpp import Llama
        except ImportError as error:
            raise RuntimeError(
                "llama-cpp-python is required for provider=local_llamacpp. "
                "Install with: pip install 'neko-core[local]'."
            ) from error
        self._llm = Llama(
            model_path=str(path),
            n_ctx=self._cfg.local_n_ctx,
            n_gpu_layers=self._cfg.local_n_gpu_layers,
            verbose=False,
        )
        return self._llm


def _parse_openai_message(data: dict) -> dict:
    """Normalize an OpenAI-style response into the provider contract."""
    message = data["choices"][0]["message"]
    tool_calls = []
    for call in message.get("tool_calls") or []:
        fn = call.get("function", {})
        raw_args = fn.get("arguments")
        try:
            args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
        except json.JSONDecodeError:
            args = {"_raw": raw_args}
        tool_calls.append(
            {"id": call.get("id", ""), "name": fn.get("name", ""), "arguments": args}
        )
    return {"content": message.get("content"), "tool_calls": tool_calls}
