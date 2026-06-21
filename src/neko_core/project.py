"""Scaffold the local config files (config-first).

``neko init-user`` writes the claude.json-style ``~/.neko-core/config.json`` (your
API key + chosen profile). ``neko init`` writes a project-local
``./.neko-core/config.json`` that overrides the user file for this repo. Neither is
committed (both are gitignored). Env vars still override these files.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .config import LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME

USER_TEMPLATE = {
    "_comment": (
        "Neko Core user config (like ~/.claude.json). Put your API key + chosen profile "
        "here to use Neko Core on an API provider. NEVER commit this file. Env vars "
        "NEKO_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY override api_key."
    ),
    "active_profile": "nvidia",
    "api_key": "",
    "model": "",
    "_hint": (
        "Paste your key in api_key (or set NEKO_API_KEY). Set model to your endpoint's "
        "model id. List profiles with `neko profiles`, then run `neko doctor`."
    ),
}

PROJECT_TEMPLATE = {
    "_comment": (
        "Neko Core project-local config. Overrides ~/.neko-core for this repo. Gitignored. "
        "Keep secrets out of it — prefer env vars for keys."
    ),
    "active_profile": "nvidia",
}


@dataclass(frozen=True)
class InitResult:
    path: Path
    created: bool
    message: str


def init_user(*, force: bool = False) -> InitResult:
    return _write(Path.home() / LOCAL_CONFIG_DIR / LOCAL_CONFIG_NAME, USER_TEMPLATE, force)


def init_project(root: Path | None = None, *, force: bool = False) -> InitResult:
    base = root or Path.cwd()
    return _write(base / LOCAL_CONFIG_DIR / LOCAL_CONFIG_NAME, PROJECT_TEMPLATE, force)


def _write(target: Path, template: dict, force: bool) -> InitResult:
    if target.exists() and not force:
        return InitResult(target, False, f"Existing config kept: {target} (use --force to overwrite)")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(template, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return InitResult(target, True, f"Config ready: {target}")
