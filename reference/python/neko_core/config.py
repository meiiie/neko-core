"""Config-first runtime for Neko Core.

Behaviour is data, not code: the model, provider, endpoint, and policy live in
config you can edit, not in source you have to patch. Config resolves by overlaying,
lowest precedence first:

  1. built-in defaults (``DEFAULTS``, below)
  2. ~/.neko-core/config.json        (user-global — the claude.json-style home file)
  3. ./.neko-core/config.json        (project-local, wins over user)
  4. the active profile's keys        (profiles live in config; pick with --profile / NEKO_PROFILE)
  5. NEKO_* environment variables     (win last)

Secrets never live in tracked config: the API key is read on demand from the
environment (NEKO_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY) or from the gitignored
``~/.neko-core/config.json`` "api_key" field — never from ``DEFAULTS`` and never
stored in the printable config dict. This config-first DNA carries over from the
Neko Core inference harness (heritage: hackaithon_c.config).
"""
from __future__ import annotations

import copy
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

LOCAL_CONFIG_DIR = ".neko-core"
LOCAL_CONFIG_NAME = "config.json"

DEFAULTS: dict[str, Any] = {
    "provider": "openai_compat",        # openai_compat | local_llamacpp
    "model": "",                        # set via profile/config/env — no wrong default shipped
    "base_url": "https://integrate.api.nvidia.com/v1",
    "max_steps": 20,                    # agent-loop cap (never run away / burn money)
    "temperature": 0.0,
    "max_tokens": 2048,
    "timeout_seconds": 120,
    "max_retries": 4,
    "retry_base_delay_seconds": 1.5,
    "retry_max_delay_seconds": 30.0,
    "approval": "prompt",               # prompt | auto  (--yolo flips destructive tools to auto)
    "local_model_path": "",
    "local_n_ctx": 8192,
    "local_n_gpu_layers": -1,
    "active_profile": None,
    "profiles": {
        # Named runtime presets. Switch with `--profile NAME`, `NEKO_PROFILE`, or
        # "active_profile" in a config file. Add an endpoint = a data edit, not a code change.
        "nvidia": {
            "provider": "openai_compat",
            "base_url": "https://integrate.api.nvidia.com/v1",
            "model": "",
        },
        "openai": {
            "provider": "openai_compat",
            "base_url": "https://api.openai.com/v1",
            "model": "gpt-4o-mini",
        },
        "local-server": {
            "provider": "openai_compat",
            "base_url": "http://127.0.0.1:8080/v1",
            "model": "local-model",
        },
        "local-gguf": {
            "provider": "local_llamacpp",
            "model": "local-gguf",
            "local_model_path": "",
        },
    },
}

# NEKO_* env suffixes that are handled specially and never merged into the
# printable config dict: the secret key, and the profile selector.
_ENV_SECRET_SUFFIXES = {"API_KEY"}
_ENV_PROFILE_SUFFIX = "PROFILE"


@dataclass(frozen=True)
class NekoConfig:
    """The effective, profile-merged, env-overridden config. ``data`` holds the
    printable settings (no secrets); ``api_key`` is read on demand."""

    data: dict[str, Any]
    profile: str | None
    profiles: dict[str, Any]
    api_key_from_file: str = ""

    @property
    def provider(self) -> str:
        return str(self.data.get("provider", "openai_compat"))

    @property
    def model(self) -> str:
        return str(self.data.get("model", "")).strip()

    @property
    def base_url(self) -> str:
        return str(self.data.get("base_url", "")).rstrip("/")

    @property
    def max_steps(self) -> int:
        return max(1, int(self.data.get("max_steps", 20)))

    @property
    def temperature(self) -> float:
        return float(self.data.get("temperature", 0.0))

    @property
    def max_tokens(self) -> int:
        return int(self.data.get("max_tokens", 2048))

    @property
    def timeout_seconds(self) -> int:
        return int(self.data.get("timeout_seconds", 120))

    @property
    def max_retries(self) -> int:
        return max(0, int(self.data.get("max_retries", 4)))

    @property
    def retry_base_delay_seconds(self) -> float:
        return float(self.data.get("retry_base_delay_seconds", 1.5))

    @property
    def retry_max_delay_seconds(self) -> float:
        return float(self.data.get("retry_max_delay_seconds", 30.0))

    @property
    def approval(self) -> str:
        value = str(self.data.get("approval", "prompt")).strip().lower()
        return value if value in {"prompt", "auto"} else "prompt"

    @property
    def local_model_path(self) -> str:
        return str(self.data.get("local_model_path", "")).strip()

    @property
    def local_n_ctx(self) -> int:
        return int(self.data.get("local_n_ctx", 8192))

    @property
    def local_n_gpu_layers(self) -> int:
        return int(self.data.get("local_n_gpu_layers", -1))

    @property
    def api_key(self) -> str:
        """Read on demand and NEVER stored in ``data`` (so it can't leak via
        ``neko config``). Env wins, then the gitignored config file's "api_key"."""
        return (
            os.environ.get("NEKO_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or os.environ.get("NVIDIA_API_KEY")
            or self.api_key_from_file
        ).strip()


def load_config(path: str | Path | None = None, *, profile: str | None = None) -> NekoConfig:
    """Resolve the effective config. With ``path``, that one file overlays the
    built-in defaults (layering of the user/project files is skipped)."""
    merged = copy.deepcopy(DEFAULTS)
    if path is not None:
        merged = _merge(merged, _read_overlay(Path(path)))
    else:
        merged = _merge(merged, _read_overlay(Path.home() / LOCAL_CONFIG_DIR / LOCAL_CONFIG_NAME))
        merged = _merge(merged, _read_overlay(Path.cwd() / LOCAL_CONFIG_DIR / LOCAL_CONFIG_NAME))

    profiles = copy.deepcopy(merged.get("profiles", {})) if isinstance(merged.get("profiles"), dict) else {}

    # Profile selection precedence: explicit arg > NEKO_PROFILE > config active_profile.
    selected = (
        (profile or os.environ.get("NEKO_PROFILE", "").strip() or (merged.get("active_profile") or "")).strip()
        or None
    )
    if selected:
        if selected not in profiles:
            available = ", ".join(sorted(profiles)) or "none"
            raise ValueError(f"Unknown profile {selected!r}. Available: {available}")
        merged = _merge(merged, profiles[selected])

    # Pull the file-provided key out before building the printable dict (never printed).
    api_key_from_file = str(merged.pop("api_key", "") or "")
    merged.pop("profiles", None)
    merged.pop("active_profile", None)

    # NEKO_* env overrides win last (except the secret/profile suffixes handled above).
    for env_key, value in os.environ.items():
        if not env_key.startswith("NEKO_"):
            continue
        suffix = env_key[len("NEKO_"):]
        if suffix in _ENV_SECRET_SUFFIXES or suffix == _ENV_PROFILE_SUFFIX:
            continue
        merged[suffix.lower()] = value

    return NekoConfig(
        data=merged,
        profile=selected,
        profiles=profiles,
        api_key_from_file=api_key_from_file,
    )


def _read_overlay(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid JSON in config {path}: {error}") from error
    if not isinstance(loaded, dict):
        raise ValueError(f"Config {path} must be a JSON object")
    return loaded


def _merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Deep-merge ``overlay`` onto ``base`` (overlays may be partial)."""
    merged = dict(base)
    for key, value in overlay.items():
        current = merged.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            merged[key] = _merge(current, value)
        else:
            merged[key] = value
    return merged
