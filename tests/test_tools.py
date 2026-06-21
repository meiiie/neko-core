import pytest

from neko_core.tools import GATED, SAFE, resolve_tool, to_openai_schema, tool_schemas
from neko_core.tool_runtime import ToolRegistry, auto_approve


# ----- contracts / schema -----
def test_schema_shape():
    schema = to_openai_schema(resolve_tool("read_file"))
    assert schema["type"] == "function"
    assert schema["function"]["name"] == "read_file"
    assert "path" in schema["function"]["parameters"]["properties"]
    assert schema["function"]["parameters"]["required"] == ["path"]


def test_tool_schema_order():
    assert [t["function"]["name"] for t in tool_schemas()] == [
        "read_file", "search", "write_file", "bash",
    ]


def test_resolve_unknown():
    with pytest.raises(ValueError):
        resolve_tool("nope")


def test_permission_classes():
    assert resolve_tool("read_file").permission == SAFE
    assert resolve_tool("search").permission == SAFE
    assert resolve_tool("write_file").permission == GATED
    assert resolve_tool("bash").permission == GATED


# ----- runtime / safety -----
def _reg(root, approve=auto_approve):
    return ToolRegistry(root=root, approve=approve)


def test_write_then_read(tmp_path):
    reg = _reg(tmp_path)
    assert reg.execute("write_file", {"path": "a.txt", "content": "hi"}).startswith("Wrote")
    assert reg.execute("read_file", {"path": "a.txt"}) == "hi"


def test_read_missing(tmp_path):
    assert "no such file" in _reg(tmp_path).execute("read_file", {"path": "x"})


def test_search(tmp_path):
    (tmp_path / "a.txt").write_text("alpha\nbeta\n", encoding="utf-8")
    assert "a.txt:2" in _reg(tmp_path).execute("search", {"pattern": "beta"})


def test_path_escape_refused(tmp_path):
    assert "escapes project root" in _reg(tmp_path).execute("read_file", {"path": "../x"})


def test_bash(tmp_path):
    out = _reg(tmp_path).execute("bash", {"command": "echo hi"})
    assert "hi" in out and "exit 0" in out


def test_denied_gated_tool_does_not_run(tmp_path):
    reg = ToolRegistry(root=tmp_path, approve=lambda name, action: False)
    out = reg.execute("write_file", {"path": "a.txt", "content": "x"})
    assert out.startswith("Denied")
    assert not (tmp_path / "a.txt").exists()


def test_safe_tool_runs_under_deny_gate(tmp_path):
    (tmp_path / "a.txt").write_text("yo", encoding="utf-8")
    reg = ToolRegistry(root=tmp_path, approve=lambda name, action: False)
    assert reg.execute("read_file", {"path": "a.txt"}) == "yo"


def test_missing_required_arg(tmp_path):
    assert "missing required argument" in _reg(tmp_path).execute("read_file", {})


def test_unknown_tool_returns_error(tmp_path):
    assert "Unknown tool" in _reg(tmp_path).execute("frobnicate", {})
