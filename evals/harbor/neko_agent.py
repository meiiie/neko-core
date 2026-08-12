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
_REMOTE_CODEX = "/usr/local/bin/codex-app-server"
_REMOTE_HOME = "/tmp/neko-home"
_REMOTE_AUTH = "/tmp/neko-auth.json"
_REMOTE_PID = "/tmp/neko-agent.pid"
_AUTH_FILENAMES = {
    "chatgpt": "chatgpt-auth.json",
    "kimi": "kimi-auth.json",
}


def _bool_kwarg(value: bool | str, name: str) -> bool:
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


def _positive_int_kwarg(value: int | str, name: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be a positive integer") from error
    if parsed < 1:
        raise ValueError(f"{name} must be a positive integer")
    return parsed


def _sha256_kwarg(value: str | None, name: str) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if len(normalized) != 64 or any(char not in "0123456789abcdef" for char in normalized):
        raise ValueError(f"{name} must be a 64-character SHA-256 digest")
    return normalized


class NekoAgent(BaseAgent):
    """Harbor adapter that evaluates the same one-shot CLI users run."""

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        binary_path: str | None = None,
        profile: str | None = None,
        reasoning_effort: str = "max",
        max_steps: int | str = 40,
        adaptive_effort: bool | str = False,
        loop: bool | str = True,
        binary_sha256: str | None = None,
        source_revision: str = "unknown",
        source_dirty: bool | str = True,
        build_bun_version: str = "unknown",
        harbor_version: str = "unknown",
        dataset_request: str = "unknown",
        codex_path: str | None = None,
        codex_sha256: str | None = None,
        **kwargs,
    ) -> None:
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        project_root = Path(__file__).resolve().parents[2]
        self.logs_dir_path = Path(logs_dir)
        self.binary_path = Path(
            binary_path or project_root / "tmp" / "harbor-eval" / "neko-linux-x64"
        ).resolve()
        self.binary_sha256 = _sha256_kwarg(binary_sha256, "binary_sha256")
        self.codex_path = Path(codex_path).resolve() if codex_path else None
        self.codex_sha256 = _sha256_kwarg(codex_sha256, "codex_sha256")
        if self.codex_path and not self.codex_sha256:
            raise ValueError("codex_sha256 is required when codex_path is staged")
        self.profile = profile
        local_auth_path = os.environ.get("NEKO_HARBOR_AUTH_PATH")
        self.auth_path = Path(local_auth_path).resolve() if local_auth_path else None
        effort = str(reasoning_effort).strip()
        if not effort or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for char in effort):
            raise ValueError("reasoning_effort must be one provider effort tier name")
        self.reasoning_effort = effort
        self.max_steps = _positive_int_kwarg(max_steps, "max_steps")
        self.adaptive_effort = _bool_kwarg(adaptive_effort, "adaptive_effort")
        self.loop = _bool_kwarg(loop, "loop")
        self.source_revision = str(source_revision).strip() or "unknown"
        self.source_dirty = _bool_kwarg(source_dirty, "source_dirty")
        self.build_bun_version = str(build_bun_version).strip() or "unknown"
        self.harbor_version = str(harbor_version).strip() or "unknown"
        self.dataset_request = str(dataset_request).strip() or "unknown"
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
        binary_check = ""
        if self.binary_sha256:
            binary_check = f"echo {shlex.quote(f'{self.binary_sha256}  /tmp/neko-working-tree')} | sha256sum -c - && "
        await self._checked_exec(
            environment,
            f"{binary_check}install -m 0755 /tmp/neko-working-tree {_REMOTE_BINARY} && "
            f"rm -f /tmp/neko-working-tree && {_REMOTE_BINARY} --version",
            user="root",
        )

        if self.codex_path:
            if not self.codex_path.is_file():
                raise FileNotFoundError(f"Linux Codex App Server not found: {self.codex_path}")
            await environment.upload_file(self.codex_path, "/tmp/neko-codex-app-server")
            await self._checked_exec(
                environment,
                f"echo {shlex.quote(f'{self.codex_sha256}  /tmp/neko-codex-app-server')} | sha256sum -c - && "
                f"install -m 0755 /tmp/neko-codex-app-server {_REMOTE_CODEX} && "
                f"rm -f /tmp/neko-codex-app-server && {_REMOTE_CODEX} --version",
                user="root",
            )

        await self._checked_exec(
            environment,
            f"mkdir -p {_REMOTE_HOME}/.neko-core && chmod 700 {_REMOTE_HOME}/.neko-core",
            env={"HOME": _REMOTE_HOME},
        )

        self.logs_dir_path.mkdir(parents=True, exist_ok=True)
        identity = {
            "schema": "neko.harbor-eval-identity.v1",
            "agent": {"name": self.name(), "version": self.version()},
            "profile": self.profile,
            "model": self.model_name,
            "dataset_request": self.dataset_request,
            "harbor_version": self.harbor_version,
            "source_revision": self.source_revision,
            "source_dirty": self.source_dirty,
            "build_bun_version": self.build_bun_version,
            "binary_sha256": self.binary_sha256,
            "codex_app_server_sha256": self.codex_sha256,
            "settings": {
                "reasoning_effort": self.reasoning_effort,
                "max_steps": self.max_steps,
                "adaptive_effort": self.adaptive_effort,
                "loop": self.loop,
            },
            "oauth_inside_task_container": self.auth_path is not None,
        }
        (self.logs_dir_path / "neko-eval-identity.json").write_text(
            json.dumps(identity, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
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
            "NEKO_REASONING_EFFORT": self.reasoning_effort,
            "NEKO_MAX_STEPS": str(self.max_steps),
            "NEKO_ADAPTIVE_EFFORT": "1" if self.adaptive_effort else "0",
            "NEKO_BASH_TIMEOUT_CAP_MS": "180000",
            "NEKO_HARBOR_INSTRUCTION": instruction,
        }
        if self.profile:
            env["NEKO_PROFILE"] = self.profile
        if self.model_name:
            env["NEKO_MODEL"] = self.model_name.split("/", 1)[-1]
        if self.codex_path:
            env["NEKO_CODEX_PATH"] = _REMOTE_CODEX

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
