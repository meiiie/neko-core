from neko_core import registry
from neko_core.config import NekoConfig
from neko_core.registry import AgentSpec, READ_ONLY, evaluate_policy


def _cfg(approval="prompt"):
    return NekoConfig(data={"approval": approval}, profile=None, profiles={})


def test_policy_pass_by_default():
    assert evaluate_policy(_cfg()).verdict == "pass"


def test_policy_warns_on_auto_approval():
    report = evaluate_policy(_cfg("auto"))
    assert report.verdict == "warn"
    assert any(f.code == "bounded_autonomy_on" for f in report.findings)


def test_policy_fails_when_read_only_agent_holds_gated_tool(monkeypatch):
    bad = AgentSpec(
        name="x", access=READ_ONLY, summary="", tools=("write_file",),
        reads=(), writes=(), handoff="",
    )
    monkeypatch.setattr(registry, "list_agents", lambda: (bad,))
    report = evaluate_policy(_cfg())
    assert report.verdict == "fail"
    assert any(f.code == "read_only_agent_gated_tool" for f in report.findings)


def test_policy_fails_on_unknown_tool_reference(monkeypatch):
    bad = AgentSpec(
        name="x", access=READ_ONLY, summary="", tools=("ghost_tool",),
        reads=(), writes=(), handoff="",
    )
    monkeypatch.setattr(registry, "list_agents", lambda: (bad,))
    report = evaluate_policy(_cfg())
    assert report.verdict == "fail"
    assert any(f.code == "agent_unknown_tool" for f in report.findings)
