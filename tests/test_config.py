import json
import os

import pytest

from neko_core import config
from neko_core.config import load_config


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for key in list(os.environ):
        if key.startswith("NEKO_") or key in {"OPENAI_API_KEY", "NVIDIA_API_KEY"}:
            monkeypatch.delenv(key, raising=False)


def _write(path, data):
    path.write_text(json.dumps(data), encoding="utf-8")


def test_defaults_when_no_overlay(tmp_path):
    cfg = load_config(path=tmp_path / "missing.json")
    assert cfg.provider == "openai_compat"
    assert cfg.max_steps == 20
    assert cfg.profile is None


def test_explicit_profile_arg(tmp_path):
    path = tmp_path / "c.json"
    _write(path, {})
    cfg = load_config(path=path, profile="openai")
    assert cfg.profile == "openai"
    assert cfg.base_url == "https://api.openai.com/v1"
    assert cfg.model == "gpt-4o-mini"


def test_active_profile_from_file(tmp_path):
    path = tmp_path / "c.json"
    _write(path, {"active_profile": "openai"})
    assert load_config(path=path).profile == "openai"


def test_env_profile_overrides_file(tmp_path, monkeypatch):
    path = tmp_path / "c.json"
    _write(path, {"active_profile": "openai"})
    monkeypatch.setenv("NEKO_PROFILE", "local-server")
    assert load_config(path=path).profile == "local-server"


def test_unknown_profile_raises(tmp_path):
    path = tmp_path / "c.json"
    _write(path, {})
    with pytest.raises(ValueError):
        load_config(path=path, profile="nope")


def test_env_overrides_value(tmp_path, monkeypatch):
    path = tmp_path / "c.json"
    _write(path, {"model": "file-model"})
    monkeypatch.setenv("NEKO_MODEL", "env-model")
    monkeypatch.setenv("NEKO_MAX_STEPS", "7")
    cfg = load_config(path=path)
    assert cfg.model == "env-model"
    assert cfg.max_steps == 7


def test_api_key_from_file_never_in_data(tmp_path):
    path = tmp_path / "c.json"
    _write(path, {"api_key": "sk-file"})
    cfg = load_config(path=path)
    assert cfg.api_key == "sk-file"
    assert "api_key" not in cfg.data  # must never be printable


def test_env_key_wins_and_stays_secret(tmp_path, monkeypatch):
    path = tmp_path / "c.json"
    _write(path, {"api_key": "sk-file"})
    monkeypatch.setenv("NEKO_API_KEY", "sk-env")
    cfg = load_config(path=path)
    assert cfg.api_key == "sk-env"
    assert "api_key" not in cfg.data


def test_layered_project_wins_over_user(tmp_path, monkeypatch):
    home = tmp_path / "home"
    proj = tmp_path / "proj"
    (home / ".neko-core").mkdir(parents=True)
    (proj / ".neko-core").mkdir(parents=True)
    _write(home / ".neko-core" / "config.json", {"model": "home", "max_tokens": 111})
    _write(proj / ".neko-core" / "config.json", {"model": "proj"})
    monkeypatch.setattr(config.Path, "home", lambda: home)
    monkeypatch.chdir(proj)
    cfg = load_config()
    assert cfg.model == "proj"          # project overlay wins
    assert cfg.data["max_tokens"] == 111  # user value preserved


def test_invalid_json_overlay_raises(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError):
        load_config(path=path)
