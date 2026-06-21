"""`neko` command-line entry point.

Subcommands (scaffold — implementations land incrementally):
  neko chat     interactive agentic session (REPL)
  neko run ...  one-shot: run a single instruction non-interactively
  neko config   show the resolved config-first settings

This is an early scaffold by The Wiii Lab; the agent loop, providers, and tools
are stubbed with clear interfaces in agent.py / providers.py / tools.py.
"""
from __future__ import annotations

import argparse
import sys

from . import __version__
from .config import load_config


def _cmd_chat(args) -> int:
    print("neko chat — interactive agentic session")
    print("  [scaffold] the agent loop is not wired yet. See agent.py / docs/ARCHITECTURE.md.")
    return 0


def _cmd_run(args) -> int:
    print(f"neko run — one-shot instruction: {args.instruction!r}")
    print("  [scaffold] not wired yet. See agent.py / docs/ARCHITECTURE.md.")
    return 0


def _cmd_config(args) -> int:
    cfg = load_config()
    print("Resolved Neko Core config:")
    for k, v in sorted(cfg.items()):
        print(f"  {k} = {v}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="neko", description="Neko Core — local-first agentic CLI.")
    p.add_argument("--version", action="version", version=f"neko-core {__version__}")
    sub = p.add_subparsers(dest="command")

    pc = sub.add_parser("chat", help="interactive agentic session (REPL)")
    pc.set_defaults(func=_cmd_chat)

    pr = sub.add_parser("run", help="one-shot: run a single instruction")
    pr.add_argument("instruction", help="the instruction to run")
    pr.set_defaults(func=_cmd_run)

    pf = sub.add_parser("config", help="show the resolved config")
    pf.set_defaults(func=_cmd_config)
    return p


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 0
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
