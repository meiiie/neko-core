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

from . import __version__
from .config import load_config
from .doctor import collect_checks, render
from .project import init_project, init_user


def _load(args):
    return load_config(profile=getattr(args, "profile", None))


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


def _cmd_chat(args) -> int:
    cfg = _load(args)
    print("neko chat — interactive agentic session")
    print(f"  provider={cfg.provider} model={cfg.model or '(unset)'} profile={cfg.profile or 'none'}")
    print("  [scaffold] the agent loop is not wired yet. See agent.py / docs/ARCHITECTURE.md.")
    return 0


def _cmd_run(args) -> int:
    cfg = _load(args)
    print(f"neko run — one-shot instruction: {args.instruction!r}")
    print(f"  provider={cfg.provider} model={cfg.model or '(unset)'} profile={cfg.profile or 'none'}")
    print("  [scaffold] not wired yet. See agent.py / docs/ARCHITECTURE.md.")
    return 0


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
