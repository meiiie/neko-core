"""Executable coding-agent tools + the approval gate.

The four contracts from ``tools.py``, bound to a project root and a permission gate:
  - read_file, search : safe  -> run immediately
  - write_file, bash  : gated -> require approval unless approval=auto (--yolo)

Each tool returns a STRING observation (errors and denials included) so a failed or
denied tool never crashes the agent loop — the model observes the outcome and adapts.
Path-taking tools refuse to escape the project root (defense against `..`/absolute paths).
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .tools import GATED, resolve_tool

# An approval gate: given (tool_name, human-readable action) -> approve?
ApprovalGate = Callable[[str, str], bool]

MAX_READ_CHARS = 100_000
MAX_SEARCH_MATCHES = 200
MAX_OUTPUT_CHARS = 20_000
BASH_TIMEOUT_SECONDS = 60
_IGNORE_DIRS = {
    ".git", "__pycache__", "node_modules", ".venv", "venv",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", "dist", "build",
}


def auto_approve(tool_name: str, action: str) -> bool:
    return True


def prompt_approve(tool_name: str, action: str) -> bool:
    print(f"\n[approval] {tool_name}: {action}")
    try:
        answer = input("Approve? [y/N] ").strip().lower()
    except EOFError:
        return False
    return answer in {"y", "yes"}


def gate_for(approval: str) -> ApprovalGate:
    """Map a config approval mode to a gate (auto = --yolo, else interactive prompt)."""
    return auto_approve if approval == "auto" else prompt_approve


@dataclass
class ToolRegistry:
    root: Path
    approve: ApprovalGate = auto_approve

    def execute(self, name: str, arguments: dict) -> str:
        try:
            spec = resolve_tool(name)
        except ValueError as error:
            return f"Error: {error}"
        if not isinstance(arguments, dict):
            return f"Error: arguments for {name} must be an object"
        if spec.permission == GATED:
            action = _describe(name, arguments)
            if not self.approve(name, action):
                return f"Denied by user: {name} ({action})"
        try:
            return _DISPATCH[name](self.root, arguments)
        except Exception as error:  # noqa: BLE001 - surface to the model, never crash the loop
            return f"Error: {error}"


def _tool_read_file(root: Path, args: dict) -> str:
    raw = _require(args, "path")
    path = _resolve_in_root(root, raw)
    if not path.exists():
        return f"Error: no such file: {raw}"
    if path.is_dir():
        return f"Error: is a directory: {raw}"
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return f"Error: not a UTF-8 text file: {raw}"
    if len(text) > MAX_READ_CHARS:
        text = text[:MAX_READ_CHARS] + f"\n... (truncated at {MAX_READ_CHARS} chars)"
    return text


def _tool_search(root: Path, args: dict) -> str:
    import re

    pattern = _require(args, "pattern")
    try:
        regex = re.compile(pattern)
    except re.error as error:
        return f"Error: invalid regex: {error}"
    base = _resolve_in_root(root, args.get("path") or ".")
    matches: list[str] = []
    for file in _walk_files(base):
        try:
            text = file.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if regex.search(line):
                rel = file.relative_to(root.resolve())
                matches.append(f"{rel}:{lineno}: {line.strip()[:200]}")
                if len(matches) >= MAX_SEARCH_MATCHES:
                    matches.append(f"... (truncated at {MAX_SEARCH_MATCHES} matches)")
                    return "\n".join(matches)
    return "\n".join(matches) if matches else "(no matches)"


def _tool_write_file(root: Path, args: dict) -> str:
    raw = _require(args, "path")
    content = args.get("content")
    if content is None:
        raise ValueError("missing required argument: content")
    path = _resolve_in_root(root, raw)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return f"Wrote {len(content)} chars to {raw}"


def _tool_bash(root: Path, args: dict) -> str:
    command = _require(args, "command")
    result = subprocess.run(
        command,
        shell=True,
        cwd=str(root),
        capture_output=True,
        text=True,
        timeout=BASH_TIMEOUT_SECONDS,
    )
    output = (result.stdout or "") + (result.stderr or "")
    if len(output) > MAX_OUTPUT_CHARS:
        output = output[:MAX_OUTPUT_CHARS] + f"\n... (truncated at {MAX_OUTPUT_CHARS} chars)"
    return f"(exit {result.returncode})\n{output}".rstrip()


def _require(args: dict, key: str) -> str:
    value = args.get(key)
    if value is None or value == "":
        raise ValueError(f"missing required argument: {key}")
    return str(value)


def _resolve_in_root(root: Path, path: str) -> Path:
    candidate = (root / path).resolve()
    if not candidate.is_relative_to(root.resolve()):
        raise ValueError(f"path escapes project root: {path}")
    return candidate


def _walk_files(base: Path):
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in _IGNORE_DIRS]
        for filename in filenames:
            yield Path(dirpath) / filename


def _describe(name: str, args: dict) -> str:
    if name == "write_file":
        return f"write {args.get('path', '?')}"
    if name == "bash":
        return f"run: {args.get('command', '?')}"
    return name


_DISPATCH: dict[str, Callable[[Path, dict], str]] = {
    "read_file": _tool_read_file,
    "search": _tool_search,
    "write_file": _tool_write_file,
    "bash": _tool_bash,
}
