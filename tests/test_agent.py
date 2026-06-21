from neko_core.agent import Agent
from neko_core.tool_runtime import ToolRegistry, auto_approve


class ScriptedProvider:
    """Returns each scripted response in turn (a stand-in for a real provider)."""

    def __init__(self, script):
        self.script = script
        self.index = 0

    def complete(self, messages, tools=None):
        response = self.script[self.index]
        self.index += 1
        return response


def test_loop_executes_tools_then_finishes(tmp_path):
    (tmp_path / "a.txt").write_text("orig", encoding="utf-8")
    script = [
        {"content": None, "tool_calls": [{"id": "c1", "name": "read_file", "arguments": {"path": "a.txt"}}]},
        {"content": None, "tool_calls": [{"id": "c2", "name": "write_file", "arguments": {"path": "b.txt", "content": "done"}}]},
        {"content": "finished", "tool_calls": []},
    ]
    agent = Agent(
        provider=ScriptedProvider(script),
        tools=ToolRegistry(root=tmp_path, approve=auto_approve),
        max_steps=10,
    )
    assert agent.run("go") == "finished"
    assert (tmp_path / "b.txt").read_text(encoding="utf-8") == "done"
    roles = [m["role"] for m in agent.messages]
    assert roles == ["system", "user", "assistant", "tool", "assistant", "tool", "assistant"]


def test_tool_result_ids_match_calls(tmp_path):
    script = [
        {"content": None, "tool_calls": [{"id": "abc", "name": "read_file", "arguments": {"path": "x"}}]},
        {"content": "ok", "tool_calls": []},
    ]
    agent = Agent(
        provider=ScriptedProvider(script),
        tools=ToolRegistry(root=tmp_path, approve=auto_approve),
        max_steps=5,
    )
    agent.run("go")
    tool_msg = next(m for m in agent.messages if m["role"] == "tool")
    assert tool_msg["tool_call_id"] == "abc"


def test_max_steps_cap(tmp_path):
    forever = {"content": None, "tool_calls": [{"id": "x", "name": "read_file", "arguments": {"path": "missing"}}]}

    class LoopForever:
        def complete(self, messages, tools=None):
            return forever

    agent = Agent(
        provider=LoopForever(),
        tools=ToolRegistry(root=tmp_path, approve=auto_approve),
        max_steps=3,
    )
    assert "max_steps=3" in agent.run("go")
