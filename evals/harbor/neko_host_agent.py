"""Harbor agent that keeps Neko, the provider, and OAuth on the host.

This is intentionally a separate cutover target from ``neko_agent.py``.  The
legacy adapter installs Neko in the task container; this adapter never does.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import stat
import subprocess
import tempfile
import time
from importlib.metadata import version as distribution_version
from pathlib import Path
from typing import Any, override

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from .remote_tools import (
    TASK_COMMAND_PROFILE,
    ProtocolError,
    RemoteToolDispatcher,
    serve_protocol,
)

_STDERR_DRAIN_TIMEOUT_SECONDS = 1.0
_HARBOR_OUTER_AGENT_TIMEOUT_SECONDS = 30 * 60
_HOST_RUNNER_CLEANUP_RESERVE_SECONDS = 60
_HOST_RUNNER_DEADLINE_SECONDS = (
    _HARBOR_OUTER_AGENT_TIMEOUT_SECONDS - _HOST_RUNNER_CLEANUP_RESERVE_SECONDS
)
_LEASE_MARGIN_SECONDS = 5 * 60
_RUNNER_HOME_ENV = "NEKO_HARBOR_RUNNER_HOME"
_claimed_runner_home: Path | None = None


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def _claim_runner_home() -> Path:
    """Consume the one transient locator before Harbor can construct a task environment."""
    global _claimed_runner_home
    raw = os.environ.pop(_RUNNER_HOME_ENV, None)
    # Python has already materialized sys.path before the custom agent is constructed. Remove the
    # private bridge locator too, so Docker Compose and task env templates cannot resolve it later.
    os.environ.pop("PYTHONPATH", None)
    if raw is not None:
        if not raw or "\x00" in raw or not os.path.isabs(raw):
            raise ValueError("Harbor runner home locator is invalid")
        requested = Path(raw)
        try:
            canonical = requested.resolve(strict=True)
        except OSError as exc:
            raise ValueError("Harbor runner home locator is unavailable") from exc
        if not _same_path(requested, canonical) or not canonical.is_dir():
            raise ValueError("Harbor runner home must be one canonical directory")
        if (
            _claimed_runner_home is not None
            and not _same_path(_claimed_runner_home, canonical)
            and _claimed_runner_home.exists()
        ):
            raise ValueError("Harbor runner home locator changed in one process")
        _claimed_runner_home = canonical
    if _claimed_runner_home is None or not _claimed_runner_home.is_dir():
        raise ValueError("Harbor runner home locator is required")
    return _claimed_runner_home


class _WindowsKillJob:
    """Kill-on-close Job Object assigned before the runner receives its hello."""

    def __init__(self, handle: int) -> None:
        self.handle = handle

    @classmethod
    def assign(cls, pid: int) -> _WindowsKillJob:
        if os.name != "nt":
            raise RuntimeError("Windows Job Objects are unavailable on this platform")
        import ctypes
        from ctypes import wintypes

        class IoCounters(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class BasicLimitInformation(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class ExtendedLimitInformation(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BasicLimitInformation),
                ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.OpenProcess.argtypes = [
            wintypes.DWORD,
            wintypes.BOOL,
            wintypes.DWORD,
        ]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.AssignProcessToJobObject.argtypes = [
            wintypes.HANDLE,
            wintypes.HANDLE,
        ]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        process_handle = None
        try:
            info = ExtendedLimitInformation()
            info.BasicLimitInformation.LimitFlags = (
                0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            )
            if not kernel32.SetInformationJobObject(
                job, 9, ctypes.byref(info), ctypes.sizeof(info)
            ):
                raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")
            process_handle = kernel32.OpenProcess(
                0x0001 | 0x0100 | 0x1000, False, pid
            )  # TERMINATE | SET_QUOTA | QUERY_LIMITED_INFORMATION
            if not process_handle:
                raise OSError(ctypes.get_last_error(), "OpenProcess failed")
            if not kernel32.AssignProcessToJobObject(job, process_handle):
                raise OSError(
                    ctypes.get_last_error(), "AssignProcessToJobObject failed"
                )
            return cls(int(job))
        except Exception:
            kernel32.CloseHandle(job)
            raise
        finally:
            if process_handle:
                kernel32.CloseHandle(process_handle)

    async def terminate(self, process: asyncio.subprocess.Process) -> None:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel32.TerminateJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        try:
            if not kernel32.TerminateJobObject(self.handle, 1):
                error = ctypes.get_last_error()
                raise OSError(error, "TerminateJobObject failed")
            try:
                await asyncio.wait_for(process.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                process.kill()
                await asyncio.wait_for(process.wait(), timeout=2.0)
        finally:
            kernel32.CloseHandle(self.handle)
            self.handle = 0


class NekoHostAgent(BaseAgent):
    """Run a digest-pinned Neko runner on the host and relay only native tools."""

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        runner_path: str | None = None,
        runner_sha256: str | None = None,
        runner_source_sha256: str | None = None,
        launcher_source_sha256: str | None = None,
        host_agent_sha256: str | None = None,
        remote_tools_sha256: str | None = None,
        profile: str | None = None,
        reasoning_effort: str = "max",
        max_steps: int | str = 40,
        adaptive_effort: bool | str = False,
        loop: bool | str = True,
        source_revision: str = "unknown",
        source_dirty: bool | str = True,
        build_bun_version: str = "unknown",
        harbor_version: str = "0.20.0",
        dataset_request: str = "unknown",
        codex_sha256: str | None = None,
        **kwargs,
    ) -> None:
        runner_home = _claim_runner_home()
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        if self.extra_env:
            raise ValueError(
                "NekoHostAgent refuses Harbor agent env injection; provider credentials "
                "must remain in the host runner environment"
            )
        self.runner_path, self.runner_sha256 = self._verified_host_file(
            runner_path, runner_sha256, "runner"
        )
        if self.runner_path.name not in {"neko-harbor-host", "neko-harbor-host.exe"}:
            raise ValueError(
                "compiled host runner must use the fixed neko-harbor-host artifact basename"
            )
        project_root = Path(__file__).resolve().parents[2]
        self._control_files = {
            "runner_source_sha256": (
                project_root / "evals" / "harbor" / "host_runner.ts",
                self._digest_kwarg(runner_source_sha256, "runner_source_sha256"),
            ),
            "launcher_source_sha256": (
                project_root / "scripts" / "harbor-eval.ts",
                self._digest_kwarg(launcher_source_sha256, "launcher_source_sha256"),
            ),
            "host_agent_sha256": (
                Path(__file__).resolve(),
                self._digest_kwarg(host_agent_sha256, "host_agent_sha256"),
            ),
            "remote_tools_sha256": (
                Path(__file__).resolve().with_name("remote_tools.py"),
                self._digest_kwarg(remote_tools_sha256, "remote_tools_sha256"),
            ),
        }
        self._control_identities = {
            name: self._verified_source_file(path, digest, name)
            for name, (path, digest) in self._control_files.items()
        }
        self.runner_source_sha256 = self._control_files["runner_source_sha256"][1]
        self.launcher_source_sha256 = self._control_files["launcher_source_sha256"][1]
        self.host_agent_sha256 = self._control_files["host_agent_sha256"][1]
        self.remote_tools_sha256 = self._control_files["remote_tools_sha256"][1]
        self._runner_identity = self._file_identity(self.runner_path)
        self.profile = str(profile).strip() if profile else None
        self.reasoning_effort = self._effort(reasoning_effort)
        self.max_steps = self._positive_int(max_steps, "max_steps")
        self.adaptive_effort = self._boolean(adaptive_effort, "adaptive_effort")
        self.loop = self._boolean(loop, "loop")
        self.source_revision = self._bounded_identity(
            source_revision, "source_revision"
        )
        if self.source_revision.lower() == "unknown":
            raise ValueError("source_revision must identify the evaluated source")
        self.source_dirty = self._boolean(source_dirty, "source_dirty")
        self.build_bun_version = self._bounded_identity(
            build_bun_version, "build_bun_version"
        )
        if self.build_bun_version.lower() == "unknown":
            raise ValueError("build_bun_version must identify the compiler")
        self.harbor_version = self._bounded_identity(harbor_version, "harbor_version")
        if self.harbor_version != "0.20.0":
            raise ValueError("NekoHostAgent requires Harbor 0.20.0")
        if distribution_version("harbor") != self.harbor_version:
            raise RuntimeError("running Harbor package does not match harbor_version")
        self.dataset_request = self._bounded_identity(
            dataset_request, "dataset_request", max_length=1024
        )
        if self.dataset_request.lower() == "unknown":
            raise ValueError("dataset_request must identify the benchmark lock")
        self.codex_sha256 = (
            self._digest_kwarg(codex_sha256, "codex_sha256")
            if codex_sha256 is not None
            else None
        )
        if self.profile == "chatgpt" and self.codex_sha256 is None:
            raise ValueError("codex_sha256 is required for the chatgpt profile")
        if self.profile != "chatgpt":
            raise ValueError("credential-safe Harbor currently supports only chatgpt OAuth")
        self.runner_home = runner_home
        (
            self.codex_path,
            self.lease_expires_at,
        ) = self._load_runner_grant(runner_home, self.codex_sha256)
        self.logs_dir_path = Path(logs_dir)
        self._dispatcher: RemoteToolDispatcher | None = None
        self._version = self._working_tree_version()

    @staticmethod
    def _load_runner_grant(
        runner_home: Path, expected_codex_sha256: str
    ) -> tuple[Path, int]:
        manifest_path = runner_home / ".neko-harbor-host-grant.json"
        auth_dir = runner_home / ".neko-core"
        auth_path = auth_dir / "chatgpt-auth.json"
        if (auth_dir / "config.json").exists():
            raise ValueError("Harbor runner home must not contain user configuration")
        for candidate, label in (
            (manifest_path, "grant manifest"),
            (auth_path, "ChatGPT access lease"),
        ):
            try:
                metadata = candidate.lstat()
            except OSError as exc:
                raise ValueError(f"Harbor {label} is unavailable") from exc
            if (
                candidate.is_symlink()
                or not stat.S_ISREG(metadata.st_mode)
                or metadata.st_nlink != 1
            ):
                raise ValueError(f"Harbor {label} must be one regular single-link file")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            credentials = json.loads(auth_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError("Harbor runner grant is invalid") from exc
        if not isinstance(manifest, dict) or set(manifest) != {
            "schema",
            "profile",
            "codexPath",
            "codexSha256",
            "expiresAt",
        }:
            raise ValueError("Harbor runner grant has an invalid schema")
        if not isinstance(credentials, dict) or set(credentials) != {
            "accessToken",
            "refreshToken",
            "expiresAt",
            "accountId",
        }:
            raise ValueError("Harbor ChatGPT access lease has an invalid schema")
        expires_at = manifest.get("expiresAt")
        if (
            manifest.get("schema") != "neko.harbor-host-grant.v1"
            or manifest.get("profile") != "chatgpt"
            or manifest.get("codexSha256") != expected_codex_sha256
            or not isinstance(expires_at, int)
            or isinstance(expires_at, bool)
            or expires_at != credentials.get("expiresAt")
            or not isinstance(credentials.get("accessToken"), str)
            or not credentials["accessToken"]
            or credentials.get("refreshToken") != ""
            or not isinstance(credentials.get("accountId"), str)
            or not credentials["accountId"]
        ):
            raise ValueError("Harbor runner grant does not match the bounded ChatGPT lease")
        raw_codex_path = manifest.get("codexPath")
        if not isinstance(raw_codex_path, str) or not raw_codex_path or "\x00" in raw_codex_path:
            raise ValueError("Harbor Codex locator is invalid")
        requested_codex = Path(raw_codex_path)
        try:
            canonical_codex = requested_codex.resolve(strict=True)
            codex_stat = requested_codex.lstat()
        except OSError as exc:
            raise ValueError("Harbor Codex executable is unavailable") from exc
        if (
            not requested_codex.is_absolute()
            or not _same_path(requested_codex, canonical_codex)
            or requested_codex.is_symlink()
            or not stat.S_ISREG(codex_stat.st_mode)
        ):
            raise ValueError("Harbor Codex executable must be one canonical regular file")
        return canonical_codex, expires_at

    @staticmethod
    def _digest_kwarg(raw_digest: str | None, name: str) -> str:
        digest = str(raw_digest or "").strip().lower()
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError(f"{name} must be a 64-character SHA-256 digest")
        return digest

    @staticmethod
    def _bounded_identity(
        value: str,
        name: str,
        *,
        max_length: int = 256,
    ) -> str:
        normalized = str(value).strip()
        if (
            not normalized
            or len(normalized) > max_length
            or any(ord(char) < 32 or ord(char) == 127 for char in normalized)
        ):
            raise ValueError(f"{name} must be one bounded printable value")
        return normalized

    @staticmethod
    def _file_sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _file_identity(path: Path) -> tuple[int, int, int, int, int]:
        metadata = path.lstat()
        return (
            int(metadata.st_dev),
            int(metadata.st_ino),
            int(metadata.st_size),
            int(metadata.st_mtime_ns),
            int(metadata.st_nlink),
        )

    @staticmethod
    def _verified_source_file(
        path: Path,
        digest: str,
        label: str,
    ) -> tuple[int, int, int, int, int]:
        try:
            metadata = path.lstat()
        except OSError as error:
            raise FileNotFoundError(
                f"Evaluation source unavailable: {label}"
            ) from error
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or path.resolve(strict=True) != path
        ):
            raise ValueError(
                f"Evaluation source must be direct and single-link: {label}"
            )
        if NekoHostAgent._file_sha256(path) != digest:
            raise ValueError(f"Evaluation source digest mismatch: {label}")
        return NekoHostAgent._file_identity(path)

    def _assert_provenance_unchanged(self) -> None:
        if (
            self._file_identity(self.runner_path) != self._runner_identity
            or self._file_sha256(self.runner_path) != self.runner_sha256
        ):
            raise RuntimeError("compiled host runner changed after validation")
        for name, (path, digest) in self._control_files.items():
            if (
                self._file_identity(path) != self._control_identities[name]
                or self._file_sha256(path) != digest
            ):
                raise RuntimeError(f"evaluation control source changed: {name}")

    @staticmethod
    def _verified_host_file(
        raw_path: str | None,
        raw_digest: str | None,
        label: str,
    ) -> tuple[Path, str]:
        if not raw_path:
            raise ValueError(
                f"{label}_path is required for the credential-safe host adapter"
            )
        requested = Path(raw_path).expanduser().absolute()
        try:
            metadata = requested.lstat()
        except OSError as error:
            raise FileNotFoundError(f"Host {label} not found: {requested}") from error
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
        ):
            raise ValueError(f"Host {label} must be a direct single-link regular file")
        canonical = requested.resolve(strict=True)
        if canonical != requested:
            raise ValueError(f"Host {label} path is not canonical")
        digest = str(raw_digest or "").strip().lower()
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError(f"{label}_sha256 must be a 64-character SHA-256 digest")
        if NekoHostAgent._file_sha256(canonical) != digest:
            raise ValueError(f"host {label} digest does not match {label}_sha256")
        return canonical, digest

    @staticmethod
    @override
    def name() -> str:
        return "neko"

    @override
    def version(self) -> str:
        return self._version

    @staticmethod
    def _working_tree_version() -> str:
        try:
            project_root = Path(__file__).resolve().parents[2]
            data = json.loads(
                (project_root / "package.json").read_text(encoding="utf-8")
            )
            return str(data.get("version") or "working-tree")
        except (OSError, ValueError, TypeError):
            return "working-tree"

    @staticmethod
    def _positive_int(value: int | str, name: str) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError) as error:
            raise ValueError(f"{name} must be a positive integer") from error
        if parsed < 1:
            raise ValueError(f"{name} must be a positive integer")
        return parsed

    @staticmethod
    def _boolean(value: bool | str, name: str) -> bool:
        if isinstance(value, bool):
            return value
        normalized = str(value).strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        raise ValueError(f"{name} must be true or false")

    @staticmethod
    def _effort(value: str) -> str:
        effort = str(value).strip()
        if not effort or any(not (char.isalnum() or char in "._-") for char in effort):
            raise ValueError("reasoning_effort must be one provider effort tier name")
        return effort

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        if self._dispatcher is not None:
            raise RuntimeError("NekoHostAgent setup may run only once")
        self._assert_provenance_unchanged()
        # This preflight is the only setup inside the task.  It uploads no executable,
        # provider configuration, auth file, host path, or environment variable.
        self._dispatcher = await RemoteToolDispatcher.create(environment)
        try:
            self.logs_dir_path.mkdir(parents=True, exist_ok=True)
            identity = {
                "schema": "neko.harbor-host-eval-identity.v1",
                "agent": {"name": self.name(), "version": self.version()},
                "model": self.model_name,
                "profile": self.profile,
                "runner_artifact": self.runner_path.name,
                "runner_sha256": self.runner_sha256,
                "runner_source_sha256": self.runner_source_sha256,
                "launcher_source_sha256": self.launcher_source_sha256,
                "host_agent_sha256": self.host_agent_sha256,
                "remote_tools_sha256": self.remote_tools_sha256,
                "source_revision": self.source_revision,
                "source_dirty": self.source_dirty,
                "build_bun_version": self.build_bun_version,
                "harbor_version": self.harbor_version,
                "dataset_request": self.dataset_request,
                "codex_sha256": self.codex_sha256,
                "task_command_profile": TASK_COMMAND_PROFILE,
                "settings": {
                    "reasoning_effort": self.reasoning_effort,
                    "max_steps": self.max_steps,
                    "adaptive_effort": self.adaptive_effort,
                    "loop": self.loop,
                },
                "posture": self._dispatcher.posture.frame(),
                "oauth_inside_task_container": False,
            }
            (self.logs_dir_path / "neko-host-eval-identity.json").write_text(
                json.dumps(identity, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        except Exception:
            await self._close_dispatcher()
            raise

    async def _close_dispatcher(self) -> None:
        dispatcher = self._dispatcher
        self._dispatcher = None
        if dispatcher is not None:
            await dispatcher.close()

    def _runner_env(self, session_deadline_at_ms: int) -> dict[str, str]:
        # Build from a fixed bootstrap rather than inheriting Harbor's environment. The only
        # credential-bearing input is the access-token-only file under runner_home.
        env: dict[str, str] = {}
        ambient = {key.upper(): value for key, value in os.environ.items()}
        for output, source in (
            ("SystemRoot", "SYSTEMROOT"),
            ("WINDIR", "WINDIR"),
            ("ComSpec", "COMSPEC"),
            ("PATHEXT", "PATHEXT"),
            ("PATH", "PATH"),
            ("LANG", "LANG"),
            ("LC_ALL", "LC_ALL"),
            ("TZ", "TZ"),
        ):
            if source in ambient:
                env[output] = ambient[source]
        runner_home = str(self.runner_home)
        env.update(
            {
                "HOME": runner_home,
                "USERPROFILE": runner_home,
                "APPDATA": str(self.runner_home / "AppData" / "Roaming"),
                "LOCALAPPDATA": str(self.runner_home / "AppData" / "Local"),
                "TEMP": str(self.runner_home / "tmp"),
                "TMP": str(self.runner_home / "tmp"),
                "NEKO_HARBOR_HOST_MODE": "1",
                "NEKO_HARBOR_ACCESS_LEASE": "1",
                "NEKO_HARBOR_SESSION_DEADLINE_AT_MS": str(
                    session_deadline_at_ms
                ),
                "NEKO_AUTO_UPDATE": "0",
                "NEKO_AUTO_UPDATE_CHECK": "0",
                "NEKO_REASONING_EFFORT": self.reasoning_effort,
                "NEKO_MAX_STEPS": str(self.max_steps),
                "NEKO_ADAPTIVE_EFFORT": "1" if self.adaptive_effort else "0",
                "NEKO_HARBOR_LOOP": "1" if self.loop else "0",
                "NEKO_CODEX_PATH": str(self.codex_path),
            }
        )
        if self.profile:
            env["NEKO_PROFILE"] = self.profile
        if self.model_name:
            env["NEKO_MODEL"] = self.model_name.split("/", 1)[-1]
        if self.codex_sha256:
            env["NEKO_EXPECTED_CODEX_SHA256"] = self.codex_sha256
        return env

    @staticmethod
    async def _discard_stderr(stream: asyncio.StreamReader) -> int:
        count = 0
        while True:
            chunk = await stream.read(64 * 1024)
            if not chunk:
                return count
            count += len(chunk)

    @staticmethod
    def _posix_process_group_exists(pgid: int) -> bool:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return False
        except PermissionError as error:
            raise RuntimeError(
                "POSIX process-group quiescence could not be verified"
            ) from error
        return True

    @staticmethod
    async def _wait_for_posix_process_group_exit(pgid: int, timeout: float) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while NekoHostAgent._posix_process_group_exists(pgid):
            remaining = deadline - loop.time()
            if remaining <= 0:
                return False
            await asyncio.sleep(min(0.05, remaining))
        return True

    @staticmethod
    async def _stop_host_process(
        process: asyncio.subprocess.Process,
        windows_job: _WindowsKillJob | None = None,
    ) -> None:
        if windows_job is not None:
            await windows_job.terminate(process)
            return
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except PermissionError as error:
                raise RuntimeError("POSIX process-group termination failed closed") from error
            if not await NekoHostAgent._wait_for_posix_process_group_exit(
                process.pid, 1.0
            ):
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except PermissionError as error:
                    raise RuntimeError(
                        "POSIX process-group termination failed closed"
                    ) from error
                if not await NekoHostAgent._wait_for_posix_process_group_exit(
                    process.pid, 2.0
                ):
                    raise RuntimeError(
                        "POSIX process group remained live after forced termination"
                    )
            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
            except asyncio.TimeoutError as error:
                raise RuntimeError("POSIX host runner could not be reaped") from error
            if NekoHostAgent._posix_process_group_exists(process.pid):
                raise RuntimeError("POSIX process group was not quiescent after reap")
            return

        # This branch is only the fail-closed path when Job Object assignment
        # itself failed.  Request tree termination unconditionally; waiting for
        # the direct runner first creates a descendant-escape race.
        system_root = Path(os.environ.get("SystemRoot", ""))
        taskkill = system_root / "System32" / "taskkill.exe"
        if not system_root.is_absolute() or not taskkill.is_file():
            process.kill()
            await asyncio.wait_for(process.wait(), timeout=2.0)
            raise RuntimeError("canonical Windows tree terminator is unavailable")
        killer = await asyncio.create_subprocess_exec(
            str(taskkill),
            "/PID",
            str(process.pid),
            "/T",
            "/F",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        killer_code = await asyncio.wait_for(killer.wait(), timeout=3.0)
        failed_while_running = killer_code != 0 and process.returncode is None
        if process.returncode is None:
            process.kill()
        await asyncio.wait_for(process.wait(), timeout=2.0)
        if failed_while_running:
            raise RuntimeError("Windows process-tree termination failed closed")

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del environment, context
        if self._dispatcher is None:
            raise RuntimeError("NekoHostAgent.setup must complete before run")
        try:
            self._assert_provenance_unchanged()
            if self.lease_expires_at < int(
                (time.time() + _HOST_RUNNER_DEADLINE_SECONDS + _LEASE_MARGIN_SECONDS)
                * 1000
            ):
                raise RuntimeError("ChatGPT access lease cannot cover the bounded host run")
        except Exception:
            await self._close_dispatcher()
            raise

        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        with tempfile.TemporaryDirectory(
            prefix="neko-harbor-host-cwd-"
        ) as isolated_cwd:
            try:
                session_deadline_at_ms = int(time.time() * 1000) + int(
                    _HOST_RUNNER_DEADLINE_SECONDS * 1000
                )
                process = await asyncio.create_subprocess_exec(
                    str(self.runner_path),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=isolated_cwd,
                    env=self._runner_env(session_deadline_at_ms),
                    start_new_session=os.name == "posix",
                    creationflags=creationflags,
                )
            except Exception:
                await self._close_dispatcher()
                raise
            windows_job: _WindowsKillJob | None = None
            if os.name == "nt":
                try:
                    windows_job = _WindowsKillJob.assign(process.pid)
                except Exception:
                    try:
                        await self._stop_host_process(process)
                    finally:
                        await self._close_dispatcher()
                    raise
            if (
                process.stdin is None
                or process.stdout is None
                or process.stderr is None
            ):
                try:
                    await self._stop_host_process(process, windows_job)
                finally:
                    await self._close_dispatcher()
                raise RuntimeError(
                    "host runner did not expose the required stdio pipes"
                )
            stderr_task = asyncio.create_task(self._discard_stderr(process.stderr))
            runner_succeeded = False
            exit_code: int | None = None
            received_metrics: dict[str, Any] | None = None
            received_partial_metrics: dict[str, Any] | None = None

            def remember_metrics_checkpoint(metrics: dict[str, Any]) -> None:
                nonlocal received_partial_metrics
                received_partial_metrics = metrics

            try:
                received_metrics = await asyncio.wait_for(
                    serve_protocol(
                        process.stdout,
                        process.stdin,
                        self._dispatcher,
                        instruction,
                        remember_metrics_checkpoint,
                    ),
                    timeout=_HOST_RUNNER_DEADLINE_SECONDS,
                )
                process.stdin.close()
                await process.stdin.wait_closed()
                exit_code = await asyncio.wait_for(process.wait(), timeout=10.0)
                if exit_code != 0:
                    raise RuntimeError("host runner exited unsuccessfully after final")
                runner_succeeded = True
            except asyncio.TimeoutError as error:
                raise RuntimeError("host runner exceeded the fixed evaluation deadline") from error
            except ProtocolError as error:
                raise RuntimeError(
                    f"host runner protocol failed closed ({error.code})"
                ) from error
            finally:
                if not process.stdin.is_closing():
                    process.stdin.close()
                process_cleanup_succeeded = False
                dispatcher_cleanup_succeeded = False
                try:
                    await self._stop_host_process(process, windows_job)
                    process_cleanup_succeeded = True
                finally:
                    try:
                        await self._close_dispatcher()
                        dispatcher_cleanup_succeeded = True
                    finally:
                        try:
                            stderr_results = await asyncio.wait_for(
                                asyncio.gather(
                                    stderr_task, return_exceptions=True
                                ),
                                timeout=_STDERR_DRAIN_TIMEOUT_SECONDS,
                            )
                        except asyncio.TimeoutError:
                            stderr_task.cancel()
                            stderr_results = await asyncio.gather(
                                stderr_task, return_exceptions=True
                            )
                        stderr_cleanup_succeeded = bool(
                            stderr_results
                            and isinstance(stderr_results[0], int)
                        )
                        completed = (
                            runner_succeeded
                            and process_cleanup_succeeded
                            and dispatcher_cleanup_succeeded
                            and stderr_cleanup_succeeded
                        )
                        audit = {
                            "schema": "neko.harbor-host-run.v3",
                            "completed": completed,
                            "exit_code": exit_code,
                            "stderr_bytes_discarded": stderr_results[0]
                            if stderr_results
                            and isinstance(stderr_results[0], int)
                            else None,
                            "metrics": received_metrics if completed else None,
                            "partial_metrics": (
                                received_partial_metrics if not completed else None
                            ),
                        }
                        (self.logs_dir_path / "neko-host-run.json").write_text(
                            json.dumps(audit, indent=2, sort_keys=True) + "\n",
                            encoding="utf-8",
                        )
                        if (
                            runner_succeeded
                            and process_cleanup_succeeded
                            and dispatcher_cleanup_succeeded
                            and not stderr_cleanup_succeeded
                        ):
                            raise RuntimeError("host runner stderr drain failed closed")
