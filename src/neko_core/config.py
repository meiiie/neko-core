"""Config-first runtime. Neko Core resolves config by overlaying, lowest -> highest:

  1. built-in defaults (this file)
  2. ~/.neko-core/config.json        (user-global)
  3. ./.neko-core/config.json        (project-local, wins over user)
  4. NEKO_* environment variables    (wins last)

This 'config-first' DNA carries over from the Neko Core inference harness: behaviour
is data, not code — swapping a model or provider is an edit, not a patch.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULTS = {
    "provider": "local_llamacpp",   # local_llamacpp | openai_compat
    "model": "qwen3-4b-instruct-2507",
    "max_steps": 20,                # agent-loop cap (never run away / burn money)
    "offline": True,
}


def _load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def load_config() -> dict:
    """Return the merged config dict (built-ins overlaid by user/project/env)."""
    cfg = dict(DEFAULTS)
    cfg.update(_load_json(Path.home() / ".neko-core" / "config.json"))
    cfg.update(_load_json(Path.cwd() / ".neko-core" / "config.json"))
    for key, value in os.environ.items():
        if key.startswith("NEKO_"):
            cfg[key[len("NEKO_"):].lower()] = value
    return cfg
