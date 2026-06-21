"""``neko`` command-line entry point.

Subcommands:
  neko chat        interactive agentic session (REPL)            [scaffold — Step 5]
  neko run ...     one-shot: run a single instruction            [scaffold — Step 4]
  neko config      show the resolved config-first settings
  neko doctor      read-only diagnostics (provider/model/key)
  neko profiles    list the named runtime profiles
  neko init-user   scaffold ~/.neko-core/config.json (key + profile)
  neko init        scaffold ./.neko-core/config.json (project-local)

Config-first, offline-capable, by The Wiii Lab. See docs/ARCHITECTURE.md.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .agent import Agent
from .config import load_config
from .doctor import collect_checks, render
from .project import init_project, init_user
from .registry import (
    collect_capabilities,
    evaluate_policy,
    list_agents,
    list_commands,
    render_agent_detail,
    render_agents,
    render_capabilities,
    render_commands,
    render_policy_report,
    resolve_agent,
)
from .providers import get_provider
from .tool_runtime import ToolRegistry, gate_for
from .tools import list_tools, render_tool_detail, render_tools, resolve_tool


def _load(args):
    return load_config(profile=getattr(args, "profile", None))


def _print_event(kind: str, data) -> None:
    """Compact, human-readable trace of the agent loop for the CLI."""
    if kind == "tool_call":
        args = data.get("arguments") or {}
        summary = args.get("command") or args.get("path") or args.get("pattern") or ""
        print(f"  -> {data['name']}({summary})")
    elif kind == "tool_result":
        observation = str(data["observation"]).replace("\n", " ")
        if len(observation) > 200:
            observation = observation[:200] + "..."
        print(f"     {observation}")
    elif kind == "max_steps":
        print(f"  [stopped: reached max_steps={data}]")


def _run_instruction(cfg, instruction: str, *, yolo: bool) -> int:
    provider = get_provider(cfg)
    approval = "auto" if yolo else cfg.approval
    registry = ToolRegistry(root=Path.cwd(), approve=gate_for(approval))
    agent = Agent(provider=provider, tools=registry, max_steps=cfg.max_steps, on_event=_print_event)
    answer = agent.run(instruction)
    print()
    print(answer)
    return 0


def _cmd_config(args) -> int:
    cfg = _load(args)
    print("Resolved Neko Core config:")
    print(f"  profile = {cfg.profile or '(none)'}")
    for key, value in sorted(cfg.data.items()):
        print(f"  {key} = {value}")
    # The API key is a secret — only ever report presence, never the value.
    print(f"  api_key = {'set' if cfg.api_key else 'missing'}")
    return 0


def _cmd_doctor(args) -> int:
    print(render(collect_checks(_load(args))))
    return 0


def _cmd_profiles(args) -> int:
    cfg = _load(args)
    print("Profiles (select with --profile NAME, NEKO_PROFILE, or active_profile):")
    for name in sorted(cfg.profiles):
        profile = cfg.profiles[name]
        marker = "*" if name == cfg.profile else " "
        print(
            f" {marker} {name}: provider={profile.get('provider', '?')} "
            f"base_url={profile.get('base_url', '-')} model={profile.get('model', '-') or '-'}"
        )
    return 0


def _cmd_init_user(args) -> int:
    print(init_user(force=args.force).message)
    return 0


def _cmd_init(args) -> int:
    print(init_project(force=args.force).message)
    return 0


def _cmd_tools(args) -> int:
    if args.name:
        print(render_tool_detail(resolve_tool(args.name)))
    else:
        print(render_tools(list_tools()))
    return 0


def _cmd_agents(args) -> int:
    if args.name:
        print(render_agent_detail(resolve_agent(args.name)))
    else:
        print(render_agents(list_agents()))
    return 0


def _cmd_commands(args) -> int:
    print(render_commands(list_commands()))
    return 0


def _cmd_capabilities(args) -> int:
    print(render_capabilities(collect_capabilities(_load(args))))
    return 0


def _cmd_policy(args) -> int:
    report = evaluate_policy(_load(args))
    print(render_policy_report(report))
    return 1 if report.verdict == "fail" else 0


def _cmd_chat(args) -> int:
    cfg = _load(args)
    print("neko chat — interactive agentic session")
    print(f"  provider={cfg.provider} model={cfg.model or '(unset)'} profile={cfg.profile or 'none'}")
    print("  [scaffold] the agent loop is not wired yet. See agent.py / docs/ARCHITECTURE.md.")
    return 0


def _cmd_run(args) -> int:
    cfg = _load(args)
    return _run_instruction(cfg, args.instruction, yolo=args.yolo)


def build_parser() -> argparse.ArgumentParser:
    # Shared --profile across config-loading subcommands (config-first DNA).
    profile_parent = argparse.ArgumentParser(add_help=False)
    profile_parent.add_argument(
        "--profile", default=None, help="named runtime profile (see `neko profiles`)"
    )

    parser = argparse.ArgumentParser(prog="neko", description="Neko Core — local-first agentic CLI.")
    parser.add_argument("--version", action="version", version=f"neko-core {__version__}")
    sub = parser.add_subparsers(dest="command")

    chat = sub.add_parser("chat", parents=[profile_parent], help="interactive agentic session (REPL)")
    chat.set_defaults(func=_cmd_chat)

    run = sub.add_parser("run", parents=[profile_parent], help="one-shot: run a single instruction")
    run.add_argument("instruction", help="the instruction to run")
    run.add_argument("--yolo", action="store_true", help="auto-approve gated tools (bounded autonomy)")
    run.set_defaults(func=_cmd_run)

    config = sub.add_parser("config", parents=[profile_parent], help="show the resolved config")
    config.set_defaults(func=_cmd_config)

    doctor = sub.add_parser("doctor", parents=[profile_parent], help="read-only diagnostics")
    doctor.set_defaults(func=_cmd_doctor)

    profiles = sub.add_parser("profiles", parents=[profile_parent], help="list named runtime profiles")
    profiles.set_defaults(func=_cmd_profiles)

    init_user_cmd = sub.add_parser("init-user", help="scaffold ~/.neko-core/config.json")
    init_user_cmd.add_argument("--force", action="store_true", help="overwrite an existing file")
    init_user_cmd.set_defaults(func=_cmd_init_user)

    init_cmd = sub.add_parser("init", help="scaffold ./.neko-core/config.json (project-local)")
    init_cmd.add_argument("--force", action="store_true", help="overwrite an existing file")
    init_cmd.set_defaults(func=_cmd_init)

    tools = sub.add_parser("tools", help="list tool contracts (safe/gated)")
    tools.add_argument("name", nargs="?", help="show one tool's full contract")
    tools.set_defaults(func=_cmd_tools)

    agents = sub.add_parser("agents", help="list agent roles and boundaries")
    agents.add_argument("name", nargs="?", help="show one agent's full spec")
    agents.set_defaults(func=_cmd_agents)

    commands = sub.add_parser("commands", help="list the CLI command surface")
    commands.set_defaults(func=_cmd_commands)

    capabilities = sub.add_parser(
        "capabilities", parents=[profile_parent], help="list runtime/CLI capabilities"
    )
    capabilities.set_defaults(func=_cmd_capabilities)

    policy = sub.add_parser(
        "policy", parents=[profile_parent], help="audit the safe/gated permission boundary"
    )
    policy.set_defaults(func=_cmd_policy)

    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 0
    try:
        return args.func(args)
    except (ValueError, RuntimeError) as error:
        print(f"neko: error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
