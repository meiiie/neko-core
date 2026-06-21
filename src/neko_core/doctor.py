"""``neko doctor`` — read-only diagnostics.

Confirms the resolved config-first runtime (provider, model, endpoint, key presence)
WITHOUT calling the model or downloading anything. Mirrors the heritage harness's
``--doctor`` surface: cheap, side-effect-free, run it before anything expensive.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import __version__
from .config import NekoConfig


@dataclass(frozen=True)
class Check:
    status: str  # "ok" | "warn"
    name: str
    detail: str


def collect_checks(config: NekoConfig) -> list[Check]:
    checks = [
        Check("ok", "version", f"neko-core {__version__}"),
        Check("ok", "provider", config.provider),
        Check("ok", "profile", config.profile or "none"),
        Check(
            "ok" if config.model else "warn",
            "model",
            config.model or "(unset - set runtime.model or pick a --profile)",
        ),
        Check("ok", "max_steps", str(config.max_steps)),
        Check("ok", "approval", config.approval),
    ]

    if config.provider == "openai_compat":
        checks.append(
            Check(
                "ok" if config.base_url else "warn",
                "base_url",
                config.base_url or "(unset)",
            )
        )
        checks.append(
            Check(
                "ok" if config.api_key else "warn",
                "api_key",
                "set" if config.api_key else "missing - set NEKO_API_KEY or run `neko init-user`",
            )
        )
    elif config.provider == "local_llamacpp":
        raw_path = config.local_model_path
        exists = bool(raw_path) and Path(raw_path).expanduser().exists()
        checks.append(
            Check(
                "ok" if exists else "warn",
                "local_model",
                f"{raw_path or '(unset)'} ({'found' if exists else 'missing'})",
            )
        )

    return checks


def render(checks: list[Check]) -> str:
    lines = ["Neko Core doctor"]
    for check in checks:
        lines.append(f"[{check.status.upper()}] {check.name}: {check.detail}")
    return "\n".join(lines)
