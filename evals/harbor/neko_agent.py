"""Run the real Neko working-tree binary as a Harbor agent."""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


_REMOTE_BINARY = "/usr/local/bin/neko"
_REMOTE_HOME = "/tmp/neko-home"
_REMOTE_AUTH = "/tmp/neko-auth.json"
_REMOTE_PID = "/tmp/neko-agent.pid"
_AUTH_FILENAMES = {
    "chatgpt": "chatgpt-auth.json",
    "kimi": "kimi-auth.json",
}


class NekoAgent(BaseAgent):
    """Harbor adapter that evaluates the same one-shot CLI users run."""

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        binary_path: str | None = None,
        profile: str | None = None,
        loop: bool = True,
        **kwargs,
    ) -> None:
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        project_root = Path(__file__).resolve().parents[2]
        self.binary_path = Path(
            binary_path or project_root / "tmp" / "harbor-eval" / "neko-linux-x64"
        ).resolve()
        self.profile = profile
        local_auth_path = os.environ.get("NEKO_HARBOR_AUTH_PATH")
        self.auth_path = Path(local_auth_path).resolve() if local_auth_path else None
        self.loop = loop
        self._version = self._read_working_tree_version(project_root)

    @staticmethod
    @override
    def name() -> str:
        return "neko"

    @override
    def version(self) -> str:
        return self._version

    @staticmethod
    def _read_working_tree_version(project_root: Path) -> str:
        try:
            value = json.loads((project_root / "package.json").read_text(encoding="utf-8"))
            version = str(value.get("version", "")).strip()
            return version or "working-tree"
        except (OSError, ValueError, TypeError):
            return "working-tree"

    async def _checked_exec(
        self,
        environment: BaseEnvironment,
        command: str,
        *,
        user: str | int | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        result = await environment.exec(command=command, user=user, env=env)
        if result.return_code == 0:
            return
        stdout = (result.stdout or "")[-2000:]
        stderr = (result.stderr or "")[-2000:]
        raise RuntimeError(
            f"Neko command failed (exit {result.return_code}).\n"
            f"stdout: {stdout}\nstderr: {stderr}"
        )

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        if not self.binary_path.is_file():
            raise FileNotFoundError(
                f"Neko Linux binary not found: {self.binary_path}. "
                "Run `bun run eval:terminal` without --no-build first."
            )

        await environment.upload_file(self.binary_path, "/tmp/neko-working-tree")
        await self._checked_exec(
            environment,
            f"install -m 0755 /tmp/neko-working-tree {_REMOTE_BINARY} && "
            f"rm -f /tmp/neko-working-tree && {_REMOTE_BINARY} --version",
            user="root",
        )

        await self._checked_exec(
            environment,
            f"mkdir -p {_REMOTE_HOME}/.neko-core && chmod 700 {_REMOTE_HOME}/.neko-core",
            env={"HOME": _REMOTE_HOME},
        )

        if not self.auth_path:
            return
        if not self.auth_path.is_file():
            raise FileNotFoundError(f"Neko auth file not found: {self.auth_path}")
        auth_filename = _AUTH_FILENAMES.get(self.profile or "")
        if not auth_filename:
            raise ValueError(
                f"Profile {self.profile!r} has no supported OAuth credential mapping. "
                "Use Harbor --agent-env for API-key profiles."
            )

        destination = f"{_REMOTE_HOME}/.neko-core/{auth_filename}"
        await environment.upload_file(self.auth_path, _REMOTE_AUTH)
        if environment.default_user is not None:
            owner = shlex.quote(str(environment.default_user))
            await self._checked_exec(
                environment,
                f"chown {owner} {_REMOTE_AUTH}",
                user="root",
            )
        await self._checked_exec(
            environment,
            f"cp {_REMOTE_AUTH} {shlex.quote(destination)} && "
            f"chmod 600 {shlex.quote(destination)} && rm -f {_REMOTE_AUTH}",
            env={"HOME": _REMOTE_HOME},
        )

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context  # Neko writes its full transcript to /logs/agent/neko.txt.
        env = {
            "HOME": _REMOTE_HOME,
            "NEKO_AUTO_UPDATE": "0",
            "NEKO_AUTO_UPDATE_CHECK": "0",
            "NEKO_BASH_TIMEOUT_CAP_MS": "180000",
            "NEKO_HARBOR_INSTRUCTION": instruction,
        }
        if self.profile:
            env["NEKO_PROFILE"] = self.profile
        if self.model_name:
            env["NEKO_MODEL"] = self.model_name.split("/", 1)[-1]

        loop_flag = "--loop " if self.loop else ""
        auth_filename = _AUTH_FILENAMES.get(self.profile or "")
        try:
            await self._checked_exec(
                environment,
                command=(
                    'neko_instruction="$NEKO_HARBOR_INSTRUCTION"; '
                    "unset NEKO_HARBOR_INSTRUCTION; "
                    f"mkdir -p /logs/agent; rm -f {_REMOTE_PID}; "
                    f"setsid {_REMOTE_BINARY} run --yolo {loop_flag}"
                    '"$neko_instruction" > /logs/agent/neko.txt 2>&1 & '
                    f"neko_pid=$!; printf '%s\\n' \"$neko_pid\" > {_REMOTE_PID}; "
                    'wait "$neko_pid"; status=$?; '
                    f"rm -f {_REMOTE_PID}; "
                    "cat /logs/agent/neko.txt; exit $status"
                ),
                env=env,
            )
        finally:
            # Harbor cancels run() at the task deadline. The remote exec transport does not
            # necessarily reap descendants, so stop Neko's dedicated process group before the
            # verifier observes the task, then remove the ephemeral credential out-of-band.
            cleanup = (
                f"if test -s {_REMOTE_PID}; then "
                f"pid=$(cat {_REMOTE_PID}); kill -TERM -- -\"$pid\" 2>/dev/null || true; "
                "sleep 1; kill -KILL -- -\"$pid\" 2>/dev/null || true; fi; "
                f"rm -f {_REMOTE_PID}"
            )
            if auth_filename:
                cleanup += f" {shlex.quote(f'{_REMOTE_HOME}/.neko-core/{auth_filename}')}"
            try:
                await environment.exec(command=cleanup)
            except Exception:
                self.logger.exception("Failed to stop Neko or remove ephemeral credentials")
