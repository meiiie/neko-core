import pytest

from neko_core.config import NekoConfig
from neko_core.providers import (
    LocalLlamaProvider,
    OpenAICompatProvider,
    _parse_openai_message,
    get_provider,
)


def _cfg(provider):
    return NekoConfig(data={"provider": provider}, profile=None, profiles={})


def test_factory_openai_compat():
    assert isinstance(get_provider(_cfg("openai_compat")), OpenAICompatProvider)


def test_factory_local():
    assert isinstance(get_provider(_cfg("local_llamacpp")), LocalLlamaProvider)


def test_factory_unknown():
    with pytest.raises(ValueError):
        get_provider(_cfg("nope"))


def test_parse_content_only():
    out = _parse_openai_message({"choices": [{"message": {"content": "hello"}}]})
    assert out["content"] == "hello"
    assert out["tool_calls"] == []


def test_parse_tool_calls():
    data = {
        "choices": [
            {
                "message": {
                    "content": None,
                    "tool_calls": [
                        {"id": "c1", "function": {"name": "read_file", "arguments": '{"path": "a.txt"}'}}
                    ],
                }
            }
        ]
    }
    out = _parse_openai_message(data)
    assert out["tool_calls"][0] == {"id": "c1", "name": "read_file", "arguments": {"path": "a.txt"}}


def test_parse_error_object_raises_clear_runtimeerror():
    data = {"error": {"message": "model not found"}}
    with pytest.raises(RuntimeError, match="model not found"):
        _parse_openai_message(data)


def test_parse_missing_choices_raises_runtimeerror():
    with pytest.raises(RuntimeError):
        _parse_openai_message({"object": "error"})


def test_parse_bad_arguments_kept_raw():
    data = {
        "choices": [
            {"message": {"tool_calls": [{"id": "c1", "function": {"name": "x", "arguments": "{not json"}}]}}
        ]
    }
    out = _parse_openai_message(data)
    assert out["tool_calls"][0]["arguments"]["_raw"] == "{not json"
