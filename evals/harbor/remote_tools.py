"""Credential-free Harbor tool transport for the host-side Neko runner.

The model, provider, and credentials live in the host runner.  This module is the
only bridge into the task environment, and it deliberately speaks to Harbor's
``BaseEnvironment`` rather than exposing a container socket to that runner.
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
import math
import re
import shlex
import struct
import tempfile
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

FRAME_SCHEMA = "neko.harbor.remote-tools.v2"
NATIVE_PROTOCOL = "neko-native-posix-v1"
MAX_FRAME_BYTES = 1024 * 1024
# The host runner caps result frames at 256 KiB. JSON can expand one control
# character to six ASCII bytes, so 40k leaves room for the result envelope.
MAX_OBSERVATION_CHARS = 40_000
MAX_BASH_OUTPUT_CHARS = 20_000
MAX_TRANSFER_FILE_BYTES = 16 * 1024 * 1024
MAX_PATH_BYTES = 4096
MAX_LIST_ENTRIES = 200
MAX_SEARCH_MATCHES = 200
MIN_CALL_TIMEOUT_MS = 100
MAX_CALL_TIMEOUT_MS = 600_000
MAX_SAFE_JSON_INTEGER = (1 << 53) - 1
REMOTE_STATE_ROOT = "/tmp/neko-harbor-remote-tools"
# Harbor's Docker adapter may need up to five seconds to terminate its local
# compose subprocess after the task command times out.  Keep that transport
# settlement outside the command deadline, with a small scheduling margin.
TRANSPORT_SETTLEMENT_RESERVE_SECONDS = 7.0
QUIESCENCE_ATTEMPT_TIMEOUT_MS = 5_000
TOOLS = (
    "read_file",
    "search",
    "glob",
    "ls",
    "write_file",
    "edit",
    "multi_edit",
    "bash",
)
TASK_COMMAND_PROFILE = "gnu-coreutils-findutils-proc-v1"
TASK_COMMAND_PROFILE_MISMATCH = "NEKO_TASK_COMMAND_PROFILE_MISMATCH"
TASK_COMMAND_NAMES = (
    "sh",
    "realpath",
    "stat",
    "chmod",
    "mkdir",
    "rm",
    "mv",
    "setsid",
    "head",
    "cat",
    "mkfifo",
    "find",
    "grep",
    "tr",
    "env",
    "sleep",
)
TASK_UTILITY_DIRS = frozenset(
    {"/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin"}
)

_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_SECRET_ENV_NAMES = (
    "NEKO_API_KEY",
    "OPENAI_API_KEY",
    "NVIDIA_API_KEY",
    "ANTHROPIC_API_KEY",
    "CODEX_HOME",
    "NEKO_CODEX_HOME",
    "NEKO_HARBOR_AUTH_PATH",
)
_DAEMON_SOCKETS = (
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/run/podman/podman.sock",
    "/run/containerd/containerd.sock",
    "/run/buildkit/buildkitd.sock",
)
_CREDENTIAL_PATTERNS = (
    re.compile(r"(^|/)\.ssh(/|$)", re.IGNORECASE),
    re.compile(r"(^|/)id_(rsa|dsa|ecdsa|ed25519)([./]|$)", re.IGNORECASE),
    re.compile(r"(^|/)\.gnupg(/|$)", re.IGNORECASE),
    re.compile(r"(^|/)\.aws(/|$)", re.IGNORECASE),
    re.compile(r"(^|/)\.docker/config\.json$", re.IGNORECASE),
    re.compile(r"(^|/)\.(netrc|git-credentials)$", re.IGNORECASE),
    re.compile(
        r"(^|/)\.neko-core/(config|chatgpt-auth|kimi-auth)\.json([.-][^/]*)?$",
        re.IGNORECASE,
    ),
    re.compile(
        r"(^|/)\.neko-core/(mcp-auth|relay-sessions|browser)(/|$)", re.IGNORECASE
    ),
    re.compile(
        r"(^|/)\.neko-core/(relay|remote|browser-bridge)\.json([.-][^/]*)?$",
        re.IGNORECASE,
    ),
    re.compile(r"(^|/)\.neko-core/codex-home/auth\.json([.-][^/]*)?$", re.IGNORECASE),
    re.compile(
        r"(^|/)\.codex/(auth\.json|secrets|\.sandbox-secrets)([./-]|$)", re.IGNORECASE
    ),
    re.compile(r"(^|/)oauth_creds\.json([.-][^/]*)?$", re.IGNORECASE),
    re.compile(r"(^|/)\.(npmrc|pypirc)([.-][^/]*)?$", re.IGNORECASE),
    re.compile(r"(^|/)\.config/gh/hosts\.ya?ml([.-][^/]*)?$", re.IGNORECASE),
    re.compile(
        r"(^|/)\.config/gcloud/(application_default_credentials\.json|credentials\.db|access_tokens\.db)([.-][^/]*)?$",
        re.IGNORECASE,
    ),
    re.compile(r"(^|/)\.config/gcloud/legacy_credentials(/|$)", re.IGNORECASE),
    re.compile(
        r"(^|/)\.azure/(accessTokens\.json|msal_token_cache\.(bin|json)|service_principal_entries\.json)([.-][^/]*)?$",
        re.IGNORECASE,
    ),
    re.compile(r"(^|/)\.kube/config([.-][^/]*)?$", re.IGNORECASE),
    re.compile(r"(^|/)\.env[^/]*$", re.IGNORECASE),
    re.compile(r"\.(pem|key|p12|pfx|jks|keystore|ppk)$", re.IGNORECASE),
    re.compile(r"(^|/)(Keychains|Login Data|Cookies|Web Data)(/|$)", re.IGNORECASE),
    re.compile(r"(^|/)User Data/", re.IGNORECASE),
)


class EnvironmentLike(Protocol):
    @property
    def default_user(self) -> str | int | None: ...

    @property
    def network_policy(self) -> Any: ...

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> Any: ...

    async def upload_file(self, source_path: Path | str, target_path: str) -> None: ...

    async def download_file(
        self, source_path: str, target_path: Path | str
    ) -> None: ...


class FrameWriter(Protocol):
    def write(self, data: bytes) -> None: ...

    async def drain(self) -> None: ...


class ProtocolError(RuntimeError):
    """A peer violated the framed protocol."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class RemoteToolError(RuntimeError):
    """A tool request was refused or failed closed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class HostPosture:
    network_mode: str
    allowed_hosts: tuple[str, ...]

    def frame(self) -> dict[str, Any]:
        return {
            "execution": "harbor-base-environment",
            "hostCredentialsInTask": False,
            "hostDaemonSocketInTask": False,
            "obviousHostRootMountInTask": False,
            "networkMode": self.network_mode,
            "allowedHosts": list(self.allowed_hosts),
        }


@dataclass(frozen=True)
class TaskUtilityBinding:
    name: str
    lookup: str
    canonical: str
    identity: str


@dataclass(frozen=True)
class TaskCommandProfile:
    path: tuple[str, ...]
    search_name: str
    search_path: str
    utilities: tuple[TaskUtilityBinding, ...]

    def wrap(self, command: str) -> str:
        frozen_path = ":".join(self.path)
        by_name = {binding.name: binding for binding in self.utilities}
        realpath = shlex.quote(by_name["realpath"].canonical)
        stat = shlex.quote(by_name["stat"].canonical)
        refused = "{ printf '" + TASK_COMMAND_PROFILE_MISMATCH + "\\n' >&2; exit 97; }"
        guards = "".join(
            f'test "$({realpath} -e -- {shlex.quote(binding.lookup)})" = '
            f"{shlex.quote(binding.canonical)} || {refused}; "
            f"test \"$({stat} -Lc '%d:%i:%s:%Y:%h' -- {shlex.quote(binding.canonical)})\" = "
            f"{shlex.quote(binding.identity)} || {refused}; "
            for binding in self.utilities
        )
        return (
            f"PATH={shlex.quote(frozen_path)}; export PATH; readonly PATH; {guards}"
            f": neko-command-profile-bound; {command}"
        )


@dataclass(frozen=True)
class PathProbe:
    requested: str
    absolute: str
    canonical: str
    kind: str
    direct: bool
    links: int
    size: int
    identity: str


def _strict_object(
    value: Any, required: set[str], optional: set[str] | None = None
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProtocolError("malformed-frame", "frame must be a JSON object")
    allowed = required | (optional or set())
    keys = set(value)
    if keys - allowed or required - keys:
        raise ProtocolError("malformed-frame", "frame fields do not match the protocol")
    return value


def _strict_args(
    value: Any, required: set[str], optional: set[str] | None = None
) -> dict[str, Any]:
    try:
        return _strict_object(value, required, optional)
    except ProtocolError as error:
        raise RemoteToolError(
            "invalid-arguments", "tool arguments do not match the native schema"
        ) from error


def _json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON object key")
        value[key] = item
    return value


def _reject_json_constant(_value: str) -> Any:
    raise ValueError("non-finite JSON number")


async def read_frame(reader: asyncio.StreamReader) -> dict[str, Any]:
    try:
        header = await reader.readexactly(4)
    except asyncio.IncompleteReadError as error:
        raise EOFError from error
    size = struct.unpack(">I", header)[0]
    if size < 2 or size > MAX_FRAME_BYTES:
        raise ProtocolError("frame-size", "frame length is outside the protocol bound")
    try:
        raw = await reader.readexactly(size)
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_json_object,
            parse_constant=_reject_json_constant,
        )
    except (
        asyncio.IncompleteReadError,
        UnicodeDecodeError,
        ValueError,
    ) as error:
        raise ProtocolError(
            "malformed-json", "frame is not complete UTF-8 JSON"
        ) from error
    if not isinstance(value, dict):
        raise ProtocolError("malformed-frame", "frame must be a JSON object")
    return value


async def write_frame(writer: FrameWriter, value: dict[str, Any]) -> None:
    # Observation caps account for JSON escaping before this 1 MiB transport cap.
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if not raw or len(raw) > MAX_FRAME_BYTES:
        raise ProtocolError("frame-size", "outgoing frame exceeds the protocol bound")
    writer.write(struct.pack(">I", len(raw)) + raw)
    await writer.drain()


def _deadline(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(
            "invalid-deadline", "deadlineAt must be an integer epoch millisecond"
        )
    now = int(time.time() * 1000)
    if value <= now:
        raise RemoteToolError(
            "deadline-expired", "tool deadline expired before dispatch"
        )
    if value - now > MAX_CALL_TIMEOUT_MS:
        raise RemoteToolError(
            "deadline-too-long", "tool deadline exceeds the maximum call duration"
        )
    return value


def _remaining_seconds(deadline_at: int) -> float:
    remaining = (deadline_at - int(time.time() * 1000)) / 1000
    if remaining <= 0:
        raise RemoteToolError("deadline-expired", "tool deadline expired")
    return remaining


def _normalize_path(value: Any, *, allow_dot: bool = False) -> str:
    if not isinstance(value, str) or not value:
        raise RemoteToolError("invalid-path", "path must be a non-empty string")
    if (
        len(value.encode("utf-8")) > MAX_PATH_BYTES
        or _CONTROL_RE.search(value)
        or "\\" in value
    ):
        raise RemoteToolError(
            "invalid-path", "path is not a bounded canonical POSIX spelling"
        )
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        raise RemoteToolError("path-escape", "path escapes the project root")
    normalized = str(path)
    if normalized == "." and not allow_dot:
        raise RemoteToolError(
            "invalid-path", "path must name an entry below the project root"
        )
    return normalized


def _credential_reason(path: str) -> str | None:
    normalized = path.replace("\\", "/")
    for pattern in _CREDENTIAL_PATTERNS:
        if pattern.search(normalized):
            return "credential-shaped path"
    return None


def _require_string(
    args: dict[str, Any], name: str, *, allow_empty: bool = False
) -> str:
    value = args.get(name)
    if not isinstance(value, str) or (not allow_empty and not value):
        raise RemoteToolError("invalid-arguments", f"{name} must be a string")
    return value


def _bounded_observation(value: str, limit: int = MAX_OBSERVATION_CHARS) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + f"\n... (truncated at {limit} chars)"


def _count_occurrences(text: str, needle: str) -> int:
    if not needle:
        return 0
    return text.count(needle)


class RemoteToolDispatcher:
    """Strict translation from native Neko calls to one Harbor environment."""

    def __init__(
        self,
        environment: EnvironmentLike,
        root: str,
        posture: HostPosture,
        *,
        command_profile: TaskCommandProfile,
    ) -> None:
        self.environment = environment
        self.root = root
        self.posture = posture
        self.command_profile = command_profile
        self._tokens: dict[str, tuple[str, ...]] = {}
        self._closed = False
        self._destruction_confirmed = True

    @classmethod
    async def create(cls, environment: EnvironmentLike) -> RemoteToolDispatcher:
        root_result = await environment.exec(
            "pwd -P",
            cwd=None,
            env=None,
            timeout_sec=10,
            user=environment.default_user,
        )
        if root_result.return_code != 0:
            raise RuntimeError("Harbor task root discovery failed")
        lines = (root_result.stdout or "").splitlines()
        if len(lines) != 1:
            raise RuntimeError("Harbor task root was not one canonical POSIX path")
        root = lines[0].strip()
        if (
            not root.startswith("/")
            or root == "/"
            or len(root.encode("utf-8")) > MAX_PATH_BYTES
            or "//" in root
            or _CONTROL_RE.search(root)
            or "\\" in root
            or str(PurePosixPath(root)) != root
        ):
            raise RuntimeError("Harbor task root is unsafe or non-canonical")

        socket_checks = " ".join(shlex.quote(path) for path in _DAEMON_SOCKETS)
        secret_checks = " || ".join(
            f'test "${{{name}+x}}" = x' for name in _SECRET_ENV_NAMES
        )
        required_commands = " ".join(TASK_COMMAND_NAMES)
        preflight = (
            "set -eu; "
            "profile_path=''; "
            f"for command_name in {required_commands}; do "
            'command_path=$(command -v "$command_name") || exit 61; '
            'case "$command_path" in /*) ;; *) exit 68;; esac; '
            'test -f "$command_path" && test -x "$command_path" || exit 68; '
            "command_dir=${command_path%/*}; "
            'case ":$profile_path:" in *":$command_dir:"*) ;; *) '
            'profile_path=${profile_path:+"$profile_path:"}$command_dir;; esac; done; '
            "if command -v rg >/dev/null 2>&1; then search_name=rg; else search_name=grep; fi; "
            'search_path=$(command -v "$search_name") || exit 66; '
            'case "$search_path" in /*) ;; *) exit 68;; esac; '
            'test -f "$search_path" && test -x "$search_path" || exit 68; '
            "search_dir=${search_path%/*}; "
            'case ":$profile_path:" in *":$search_dir:"*) ;; *) '
            'profile_path=${profile_path:+"$profile_path:"}$search_dir;; esac; '
            "PATH=$profile_path; export PATH; readonly PATH; "
            "test -r /proc/self/environ || exit 62; "
            f'for socket_path in {socket_checks}; do test ! -S "$socket_path" || exit 63; done; '
            "grep -Eq ' /(host|hostfs|mnt/host|run/desktop/mnt/host)(/| )' /proc/self/mountinfo && exit 64 || true; "
            f"if {secret_checks}; then exit 65; fi; "
            "task_home=${HOME:-/nonexistent-neko-home}; "
            'for credential_path in "$task_home/.neko-core/chatgpt-auth.json" '
            '"$task_home/.neko-core/kimi-auth.json" "$task_home/.codex/auth.json"; do '
            'test ! -e "$credential_path" || exit 67; done; '
            f"probe_root={shlex.quote(REMOTE_STATE_ROOT + '.preflight')}.$$; "
            "umask 077; trap 'rm -rf -- \"$probe_root\"' EXIT; "
            'mkdir -m 700 -- "$probe_root" || exit 68; printf x > "$probe_root/a"; '
            'test "$(realpath -e -- "$probe_root/a")" = "$probe_root/a" || exit 68; '
            'test "$(realpath -m -- "$probe_root/new/..")" = "$probe_root" || exit 68; '
            'test "$(stat -Lc \'%h:%s\' -- "$probe_root/a")" = "1:1" || exit 68; '
            'chmod 600 -- "$probe_root/a" || exit 68; '
            'printf y > "$probe_root/source"; mv -- "$probe_root/source" "$probe_root/moved" || exit 68; '
            'test "$(head -c 1 "$probe_root/a")" = x || exit 68; '
            'mkfifo "$probe_root/fifo" || exit 68; '
            "find \"$probe_root\" -maxdepth 1 -printf '%p\\t%y\\n' >/dev/null || exit 68; "
            'grep -Fqx x "$probe_root/a" || exit 68; '
            "printf 'x\\000' | tr '\\000' '\\n' | grep -Fqx x || exit 68; "
            "setsid sh -c 'exit 0' || exit 68; kill -0 \"$$\" || exit 68; "
            'rm -rf -- "$probe_root"; trap - EXIT; '
            'printf \'OK\\n%s\\n%s\\n%s\\n\' "$profile_path" "$search_name" "$search_path"; '
            f"manifest_names={shlex.quote(required_commands)}; "
            'test "$search_name" = grep || manifest_names="$manifest_names $search_name"; '
            "for command_name in $manifest_names; do "
            'lookup=$(command -v "$command_name") || exit 68; '
            'canonical=$(realpath -e -- "$lookup") || exit 68; '
            "identity=$(stat -Lc '%d:%i:%s:%Y:%h' -- \"$canonical\") || exit 68; "
            "printf 'BIND\\t%s\\t%s\\t%s\\t%s\\n' "
            '"$command_name" "$lookup" "$canonical" "$identity"; done'
        )
        result = await environment.exec(
            preflight,
            cwd=root,
            env=None,
            timeout_sec=15,
            user=environment.default_user,
        )
        if result.return_code != 0 or (result.stdout or "").splitlines()[:1] != ["OK"]:
            reasons = {
                61: "required POSIX command unavailable",
                62: "process-token verification unavailable",
                63: "host authority socket visible in task",
                64: "obvious host-root mount visible in task",
                65: "host credential environment variable visible in task",
                66: "no bounded search command available",
                67: "provider credential file visible in task",
                68: f"required task command profile unavailable ({TASK_COMMAND_PROFILE})",
            }
            raise RuntimeError(
                f"Harbor remote-tool preflight refused: {reasons.get(result.return_code, 'unknown posture')}"
            )
        output_lines = (result.stdout or "").splitlines()
        if len(output_lines) < 4:
            raise RuntimeError(
                "Harbor remote-tool preflight returned an invalid command profile"
            )
        raw_path, search_name, search_path = output_lines[1:4]
        path = tuple(raw_path.split(":"))
        safe_absolute = re.compile(r"^/[A-Za-z0-9._+@%=-]+(?:/[A-Za-z0-9._+@%=-]+)*$")
        expected_names = TASK_COMMAND_NAMES + (
            (search_name,) if search_name == "rg" else ()
        )
        utilities: list[TaskUtilityBinding] = []
        for line in output_lines[4:]:
            fields = line.split("\t")
            if len(fields) != 5 or fields[0] != "BIND":
                raise RuntimeError(
                    "Harbor remote-tool preflight returned an invalid command profile"
                )
            utilities.append(TaskUtilityBinding(*fields[1:]))
        if (
            not path
            or len(path) > 32
            or len(raw_path.encode("utf-8")) > MAX_PATH_BYTES
            or len(search_path.encode("utf-8")) > MAX_PATH_BYTES
            or len(set(path)) != len(path)
            or any(
                not safe_absolute.fullmatch(item)
                or str(PurePosixPath(item)) != item
                or item not in TASK_UTILITY_DIRS
                or item == root
                or item == REMOTE_STATE_ROOT
                or item.startswith((root + "/", REMOTE_STATE_ROOT + "/"))
                for item in path
            )
            or search_name not in {"rg", "grep"}
            or not safe_absolute.fullmatch(search_path)
            or str(PurePosixPath(search_path)) != search_path
            or PurePosixPath(search_path).name != search_name
            or str(PurePosixPath(search_path).parent) not in path
            or len(utilities) != len(expected_names)
            or tuple(binding.name for binding in utilities) != expected_names
            or any(
                not safe_absolute.fullmatch(binding.lookup)
                or str(PurePosixPath(binding.lookup)) != binding.lookup
                or PurePosixPath(binding.lookup).name != binding.name
                or str(PurePosixPath(binding.lookup).parent) not in path
                or not safe_absolute.fullmatch(binding.canonical)
                or str(PurePosixPath(binding.canonical)) != binding.canonical
                or str(PurePosixPath(binding.canonical).parent) not in TASK_UTILITY_DIRS
                or binding.canonical == root
                or binding.canonical == REMOTE_STATE_ROOT
                or binding.canonical.startswith((root + "/", REMOTE_STATE_ROOT + "/"))
                or not re.fullmatch(
                    r"[0-9]+:[1-9][0-9]*:[0-9]+:-?[0-9]+:[1-9][0-9]*",
                    binding.identity,
                )
                for binding in utilities
            )
            or utilities[expected_names.index(search_name)].lookup != search_path
        ):
            raise RuntimeError(
                "Harbor remote-tool preflight returned an invalid command profile"
            )
        command_profile = TaskCommandProfile(
            path, search_name, search_path, tuple(utilities)
        )

        policy = getattr(environment, "network_policy", None)
        raw_mode = getattr(getattr(policy, "network_mode", None), "value", None)
        network_mode = str(raw_mode or getattr(policy, "network_mode", ""))
        if network_mode not in {"no-network", "allowlist", "public"}:
            raise RuntimeError("Harbor environment has no enforceable network policy")
        allowed_hosts = tuple(
            str(host) for host in getattr(policy, "allowed_hosts", []) or []
        )
        if network_mode != "allowlist" and allowed_hosts:
            raise RuntimeError("Harbor network policy has an inconsistent allowlist")
        if len(allowed_hosts) > 256 or any(
            not host or len(host) > 1024 or _CONTROL_RE.search(host)
            for host in allowed_hosts
        ):
            raise RuntimeError("Harbor network allowlist contains an invalid host")

        state_result = await environment.exec(
            command_profile.wrap(
                "set -eu; "
                f"state_root={shlex.quote(REMOTE_STATE_ROOT)}; "
                'test ! -e "$state_root" && test ! -L "$state_root"; '
                'mkdir -m 700 -- "$state_root"; '
                'test -d "$state_root" && test ! -L "$state_root"; '
                'test "$(realpath -e -- "$state_root")" = "$state_root"; '
                'chmod 700 -- "$state_root"'
            ),
            cwd=root,
            env=None,
            timeout_sec=10,
            user=environment.default_user,
        )
        if state_result.return_code != 0:
            raise RuntimeError("Harbor remote-tool state directory setup failed")
        dispatcher = cls(
            environment,
            root,
            HostPosture(network_mode=network_mode, allowed_hosts=allowed_hosts),
            command_profile=command_profile,
        )
        try:
            await dispatcher._preflight_process_containment()
        except Exception:
            await dispatcher.close()
            raise
        return dispatcher

    def hello(self, instruction: str) -> dict[str, Any]:
        return {
            "schema": FRAME_SCHEMA,
            "type": "hello",
            "instruction": instruction,
            "tools": list(TOOLS),
            "attestation": {
                "protocol": NATIVE_PROTOCOL,
                "canonicalPosixRoot": self.root,
                "pathChecks": "backend-enforced",
                "structuredWriteConfinement": "backend-enforced",
                "exactEditTarget": "backend-enforced",
                "bashSandbox": "backend-enforced",
                "exactValidatorSandbox": "unsupported",
                "boundedObservations": "backend-enforced",
                "deadlineAndCancellation": "backend-enforced-quiescent",
                "checkpointRewind": "unsupported",
            },
            "posture": self.posture.frame(),
        }

    async def close(self) -> None:
        if self._closed:
            if not self._destruction_confirmed:
                stop = getattr(self.environment, "stop", None)
                if not callable(stop):
                    raise RuntimeError("Harbor task destruction could not be confirmed")
                try:
                    await asyncio.wait_for(stop(delete=True), timeout=10.0)
                except Exception as error:
                    raise RuntimeError(
                        "Harbor task destruction could not be confirmed"
                    ) from error
                self._destruction_confirmed = True
            return
        failures: list[str] = []
        for token, baseline in tuple(self._tokens.items()):
            try:
                await self._ensure_quiescent(token, baseline, None)
            except ProtocolError:
                failures.append(token)
        if failures:
            stop = getattr(self.environment, "stop", None)
            if callable(stop):
                try:
                    await stop(delete=True)
                except Exception:  # noqa: BLE001 - destruction is already the terminal fallback
                    failures.append("environment-stop")
            raise RuntimeError(
                "Harbor task was destroyed after process quiescence could not be proven"
            )
        cleanup = await self._exec(
            f"rm -rf -- {shlex.quote(REMOTE_STATE_ROOT)}",
            int(time.time() * 1000) + 10_000,
        )
        if cleanup.return_code != 0:
            raise RuntimeError("Harbor remote-tool state cleanup failed")
        self._closed = True

    async def execute(
        self, tool: str, args: dict[str, Any], context: dict[str, Any]
    ) -> str:
        if self._closed:
            raise RemoteToolError("bridge-closed", "remote tool bridge is closed")
        if tool not in TOOLS or not isinstance(args, dict):
            raise RemoteToolError(
                "unsupported-tool", "tool is not in the remote allowlist"
            )
        deadline_at, strict_edit, exact_target, sandbox = self._validate_context(
            context
        )
        if tool == "bash":
            return await self._bash(args, deadline_at, sandbox)
        if sandbox["readOnlyWorkspace"] and tool in {
            "write_file",
            "edit",
            "multi_edit",
        }:
            raise RemoteToolError(
                "read-only-workspace",
                "structured mutation is unavailable in a read-only workspace",
            )
        dispatch = {
            "read_file": self._read_file,
            "search": self._search,
            "glob": self._glob,
            "ls": self._ls,
            "write_file": self._write_file,
            "edit": self._edit,
            "multi_edit": self._multi_edit,
        }[tool]
        return await dispatch(args, deadline_at, strict_edit, exact_target)

    def _validate_context(
        self, context: Any
    ) -> tuple[int, bool, str | None, dict[str, Any]]:
        root = _strict_object(context, {"deadlineAt", "workspace", "sandbox"})
        deadline_at = _deadline(root["deadlineAt"])
        workspace = _strict_object(
            root["workspace"],
            {"canonicalPosixRoot", "readOutsideRoot", "strictEditMatch"},
            {"exactEditTarget"},
        )
        if (
            workspace["canonicalPosixRoot"] != self.root
            or workspace["readOutsideRoot"] is not False
        ):
            raise RemoteToolError(
                "workspace-mismatch", "remote workspace authority does not match Harbor"
            )
        if not isinstance(workspace["strictEditMatch"], bool):
            raise ProtocolError("malformed-context", "strictEditMatch must be boolean")
        exact_target = workspace.get("exactEditTarget")
        if exact_target is not None and not isinstance(exact_target, str):
            raise ProtocolError("malformed-context", "exactEditTarget must be a string")

        sandbox = _strict_object(
            root["sandbox"],
            {
                "enabled",
                "allowNetwork",
                "domains",
                "denyReadFiles",
                "readOnlyWorkspace",
            },
        )
        if any(
            not isinstance(sandbox[name], bool)
            for name in ("enabled", "allowNetwork", "readOnlyWorkspace")
        ):
            raise ProtocolError(
                "malformed-context", "sandbox boolean fields are invalid"
            )
        if not isinstance(sandbox["domains"], list) or not all(
            isinstance(item, str) for item in sandbox["domains"]
        ):
            raise ProtocolError("malformed-context", "sandbox domains must be strings")
        if not isinstance(sandbox["denyReadFiles"], list) or not all(
            isinstance(item, str) for item in sandbox["denyReadFiles"]
        ):
            raise ProtocolError(
                "malformed-context", "sandbox denyReadFiles must be strings"
            )
        if sandbox["denyReadFiles"]:
            raise RemoteToolError(
                "unsupported-sandbox-policy",
                "remote bash cannot weaken denyReadFiles policy",
            )
        if sandbox["enabled"] is not True:
            raise RemoteToolError(
                "sandbox-policy-mismatch",
                "runner sandbox authority does not match Harbor",
            )
        expected_network = self.posture.network_mode != "no-network"
        if bool(sandbox["allowNetwork"]) != expected_network:
            raise RemoteToolError(
                "network-policy-mismatch",
                "runner network authority does not match Harbor",
            )
        expected_domains = (
            list(self.posture.allowed_hosts)
            if self.posture.network_mode == "allowlist"
            else []
        )
        if sandbox["domains"] != expected_domains:
            raise RemoteToolError(
                "network-policy-mismatch",
                "runner network allowlist does not match Harbor",
            )
        return deadline_at, workspace["strictEditMatch"], exact_target, sandbox

    async def _exec(
        self,
        command: str,
        deadline_at: int,
        *,
        output_limit: int = MAX_OBSERVATION_CHARS + 4096,
    ) -> Any:
        # BaseEnvironment timeouts can stop only the host-side transport.  Wrap
        # every structured task command in the same verified containment used
        # by bash so cancellation cannot strand a grep/find/stat descendant.
        baseline = await self._process_snapshot(deadline_at)
        token = uuid.uuid4().hex
        self._tokens[token] = baseline
        contained = (
            f"env NEKO_REMOTE_CALL_TOKEN={shlex.quote(token)} "
            f"setsid sh -c {shlex.quote(command)}"
        )
        try:
            return await self._raw_exec(
                contained, deadline_at, output_limit=output_limit
            )
        finally:
            await self._complete_quiescence_obligation(token, baseline)

    async def _raw_exec(
        self,
        command: str,
        deadline_at: int,
        *,
        output_limit: int = MAX_OBSERVATION_CHARS + 4096,
    ) -> Any:
        remaining = _remaining_seconds(deadline_at)
        timeout_sec = max(1, math.ceil(remaining))
        try:
            result = await asyncio.wait_for(
                self.environment.exec(
                    self.command_profile.wrap(command),
                    cwd=self.root,
                    env=None,
                    timeout_sec=timeout_sec,
                    user=self.environment.default_user,
                ),
                timeout=remaining + TRANSPORT_SETTLEMENT_RESERVE_SECONDS,
            )
        except asyncio.TimeoutError as error:
            raise RemoteToolError(
                "deadline-expired", "remote operation exceeded its deadline"
            ) from error
        # The reserve is solely for the environment adapter to settle its
        # transport.  A command result arriving in that interval is late and
        # must never become an observation.
        if int(time.time() * 1000) >= deadline_at:
            raise RemoteToolError(
                "deadline-expired", "remote operation exceeded its deadline"
            )
        if (
            result.return_code == 97
            and (result.stderr or "") == TASK_COMMAND_PROFILE_MISMATCH + "\n"
        ):
            await self._abort_task(
                "command-profile-changed",
                "the pinned task command profile changed and the Harbor task was aborted",
            )
        if (
            len(result.stdout or "") > output_limit
            or len(result.stderr or "") > output_limit
        ):
            raise RemoteToolError(
                "output-bound", "Harbor environment returned unbounded tool output"
            )
        return result

    async def _abort_task(
        self, code: str, message: str, cause: BaseException | None = None
    ) -> None:
        self._closed = True
        self._destruction_confirmed = False
        destroyed = False
        stop = getattr(self.environment, "stop", None)
        if callable(stop):
            stopping = asyncio.create_task(
                asyncio.wait_for(stop(delete=True), timeout=10.0)
            )
            while True:
                try:
                    await asyncio.shield(stopping)
                    destroyed = True
                    break
                except asyncio.CancelledError:
                    if not stopping.done():
                        continue
                    try:
                        stopping.result()
                        destroyed = True
                    except BaseException as stop_error:  # noqa: BLE001 - session failure remains authoritative
                        del stop_error
                    break
                except BaseException:  # noqa: BLE001 - session failure remains authoritative
                    break
        self._tokens.clear()
        self._destruction_confirmed = destroyed
        if not destroyed:
            message += "; task destruction could not be confirmed"
        raise ProtocolError(code, message) from cause

    async def _probe(
        self, raw: Any, deadline_at: int, *, allow_dir: bool = False
    ) -> PathProbe:
        requested = _normalize_path(raw, allow_dot=allow_dir)
        absolute = self.root if requested == "." else f"{self.root}/{requested}"
        reason = _credential_reason(requested) or _credential_reason(absolute)
        if reason:
            raise RemoteToolError("credential-path", f"refused {reason}")
        command = (
            "set -eu; "
            f"root={shlex.quote(self.root)}; target={shlex.quote(absolute)}; "
            'canonical=$(realpath -e -- "$target") || exit 71; '
            'case "$canonical" in "$root"|"$root"/*) ;; *) exit 72;; esac; '
            'if test -L "$target"; then direct=link; else direct=direct; fi; '
            'if test -f "$target"; then kind=file; elif test -d "$target"; then kind=dir; else exit 73; fi; '
            "links=$(stat -Lc '%h' -- \"$target\") || exit 74; "
            "size=$(stat -Lc '%s' -- \"$target\") || exit 74; "
            "identity=$(stat -Lc '%d:%i:%s:%Y:%h' -- \"$target\") || exit 74; "
            'printf \'OK\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n\' "$canonical" "$kind" "$direct" "$links" "$size" "$identity"'
        )
        result = await self._exec(command, deadline_at)
        if result.return_code != 0:
            code = "missing-path" if result.return_code == 71 else "unsafe-path"
            raise RemoteToolError(
                code, "path does not resolve to a confined regular entry"
            )
        lines = (result.stdout or "").splitlines()
        if len(lines) != 7 or lines[0] != "OK":
            raise RemoteToolError(
                "invalid-probe", "path verifier returned malformed evidence"
            )
        canonical, kind, direct = lines[1:4]
        if canonical != self.root and not canonical.startswith(self.root + "/"):
            raise RemoteToolError("path-escape", "canonical path escapes project root")
        if _credential_reason(canonical):
            raise RemoteToolError(
                "credential-path", "canonical target is credential-shaped"
            )
        if kind not in {"file", "dir"} or direct not in {"direct", "link"}:
            raise RemoteToolError(
                "invalid-probe", "path verifier returned invalid metadata"
            )
        try:
            links, size = int(lines[4]), int(lines[5])
        except ValueError as error:
            raise RemoteToolError(
                "invalid-probe", "path verifier returned invalid numbers"
            ) from error
        return PathProbe(
            requested,
            absolute,
            canonical,
            kind,
            direct == "direct",
            links,
            size,
            lines[6],
        )

    async def _download_snapshot(self, probe: PathProbe, deadline_at: int) -> str:
        if probe.kind != "file" or probe.size > MAX_TRANSFER_FILE_BYTES:
            raise RemoteToolError(
                "file-bound", "file is not a bounded regular text file"
            )
        with tempfile.TemporaryDirectory(prefix="neko-harbor-read-") as temp_dir:
            target = Path(temp_dir) / "snapshot"
            remaining = _remaining_seconds(deadline_at)
            try:
                await asyncio.wait_for(
                    self.environment.download_file(probe.canonical, target),
                    timeout=remaining,
                )
            except asyncio.TimeoutError as error:
                raise RemoteToolError(
                    "deadline-expired", "file download exceeded its deadline"
                ) from error
            if not target.is_file() or target.stat().st_size > MAX_TRANSFER_FILE_BYTES:
                raise RemoteToolError(
                    "file-bound", "downloaded file exceeded the transfer bound"
                )
            data = target.read_bytes()
        after = await self._probe(probe.requested, deadline_at)
        if after.identity != probe.identity or after.canonical != probe.canonical:
            raise RemoteToolError("path-race", "file identity changed during the read")
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise RemoteToolError(
                "binary-file", "read_file supports UTF-8 text in the remote backend"
            ) from error

    async def _read_file(
        self, args: dict[str, Any], deadline_at: int, _strict: bool, _exact: str | None
    ) -> str:
        _strict_args(args, {"path"}, {"offset", "column", "limit"})
        probe = await self._probe(args["path"], deadline_at)
        text = await self._download_snapshot(probe, deadline_at)
        offset = args.get("offset", 1)
        column = args.get("column", 1)
        limit = args.get("limit", 2000)
        for name, value in (("offset", offset), ("column", column), ("limit", limit)):
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or int(value) != value
                or value < 1
            ):
                raise RemoteToolError(
                    "invalid-arguments", f"{name} must be a positive integer"
                )
        lines = text.split("\n")
        selected = lines[int(offset) - 1 : int(offset) - 1 + int(limit)]
        if selected and int(column) > 1:
            selected[0] = selected[0][int(column) - 1 :]
        body = "\n".join(
            f"{index:>6}\t{line}"
            for index, line in enumerate(selected, start=int(offset))
        )
        if not body:
            body = "(empty)"
        return _bounded_observation(body)

    async def _search(
        self, args: dict[str, Any], deadline_at: int, _strict: bool, _exact: str | None
    ) -> str:
        _strict_args(args, {"pattern"}, {"path", "glob", "case_insensitive", "context"})
        pattern = _require_string(args, "pattern")
        base = await self._probe(args.get("path", "."), deadline_at, allow_dir=True)
        if base.kind != "dir":
            raise RemoteToolError("invalid-path", "search path must be a directory")
        glob = args.get("glob")
        if glob is not None and (not isinstance(glob, str) or _CONTROL_RE.search(glob)):
            raise RemoteToolError("invalid-arguments", "glob must be a bounded string")
        insensitive = args.get("case_insensitive", False)
        context = args.get("context", 0)
        if (
            not isinstance(insensitive, bool)
            or isinstance(context, bool)
            or not isinstance(context, int)
            or not 0 <= context <= 5
        ):
            raise RemoteToolError("invalid-arguments", "search flags are invalid")
        cap = MAX_OBSERVATION_CHARS + 1
        if self.command_profile.search_name == "rg":
            command_parts = [
                self.command_profile.search_path,
                "--line-number",
                "--no-heading",
                "--color",
                "never",
                "--max-count",
                str(MAX_SEARCH_MATCHES),
            ]
            if insensitive:
                command_parts.append("--ignore-case")
            if context:
                command_parts += ["--context", str(context)]
            if glob:
                command_parts += ["--glob", glob]
            for excluded in (
                "**/.ssh/**",
                "**/.aws/**",
                "**/.gnupg/**",
                "**/.codex/**",
                "**/.neko-core/**",
                "**/.docker/**",
                "**/.azure/**",
                "**/.kube/**",
                "**/.config/gh/**",
                "**/.config/gcloud/**",
                "**/User Data/**",
                "**/Keychains/**",
                "**/.env*",
                "**/.npmrc*",
                "**/.pypirc*",
                "**/.netrc",
                "**/.git-credentials",
                "**/oauth_creds.json*",
                "**/id_rsa*",
                "**/id_dsa*",
                "**/id_ecdsa*",
                "**/id_ed25519*",
                "**/*.pem",
                "**/*.key",
                "**/*.p12",
                "**/*.pfx",
                "**/*.jks",
                "**/*.keystore",
                "**/*.ppk",
            ):
                command_parts += ["--glob", f"!{excluded}"]
            command_parts += ["--", pattern, base.canonical]
        else:
            command_parts = [
                self.command_profile.search_path,
                "-r",
                "-n",
                "-E",
                "--binary-files=without-match",
            ]
            if insensitive:
                command_parts.append("-i")
            if context:
                command_parts += [f"-C{context}"]
            if glob:
                command_parts += ["--include", glob]
            for directory in (
                ".ssh",
                ".aws",
                ".gnupg",
                ".codex",
                ".neko-core",
                ".docker",
                ".azure",
                ".kube",
                "gh",
                "gcloud",
                "User Data",
                "Keychains",
            ):
                command_parts += ["--exclude-dir", directory]
            for excluded in (
                ".env*",
                ".npmrc*",
                ".pypirc*",
                ".netrc",
                ".git-credentials",
                "oauth_creds.json*",
                "id_rsa*",
                "id_dsa*",
                "id_ecdsa*",
                "id_ed25519*",
                "*.pem",
                "*.key",
                "*.p12",
                "*.pfx",
                "*.jks",
                "*.keystore",
                "*.ppk",
            ):
                command_parts += ["--exclude", excluded]
            command_parts += ["--", pattern, base.canonical]
        quoted = " ".join(shlex.quote(part) for part in command_parts)
        command = f"set +e; {quoted} 2>/dev/null | head -c {cap}; status=${{PIPESTATUS:-0}}; exit 0"
        result = await self._exec(command, deadline_at, output_limit=cap + 4096)
        if result.return_code != 0:
            raise RemoteToolError("search-failed", "remote search failed")
        output = result.stdout or ""
        if len(output) > MAX_OBSERVATION_CHARS:
            output = (
                output[:MAX_OBSERVATION_CHARS]
                + f"\n... (truncated at {MAX_OBSERVATION_CHARS} chars)"
            )
        return output.rstrip() or "(no matches)"

    async def _find_paths(
        self, base: PathProbe, deadline_at: int, *, entries_only: bool
    ) -> list[tuple[str, str]]:
        depth = "-mindepth 1 -maxdepth 1" if entries_only else "-type f"
        command = (
            f"find {shlex.quote(base.canonical)} {depth} -printf '%p\\t%y\\n' 2>/dev/null "
            f"| head -c {MAX_FRAME_BYTES}"
        )
        result = await self._exec(
            command, deadline_at, output_limit=MAX_FRAME_BYTES + 4096
        )
        if result.return_code != 0:
            raise RemoteToolError("list-failed", "remote file listing failed")
        rows: list[tuple[str, str]] = []
        for line in (result.stdout or "").splitlines():
            if "\t" not in line:
                continue
            absolute, kind = line.rsplit("\t", 1)
            if absolute == self.root:
                relative = "."
            elif absolute.startswith(self.root + "/"):
                relative = absolute[len(self.root) + 1 :]
            else:
                continue
            if _credential_reason(relative) or kind == "l":
                continue
            rows.append((relative, kind))
        return rows

    async def _glob(
        self, args: dict[str, Any], deadline_at: int, _strict: bool, _exact: str | None
    ) -> str:
        _strict_args(args, {"pattern"}, {"path"})
        pattern = _require_string(args, "pattern")
        if _CONTROL_RE.search(pattern) or len(pattern) > MAX_PATH_BYTES:
            raise RemoteToolError("invalid-arguments", "glob pattern is invalid")
        base = await self._probe(args.get("path", "."), deadline_at, allow_dir=True)
        if base.kind != "dir":
            raise RemoteToolError("invalid-path", "glob path must be a directory")
        rows = await self._find_paths(base, deadline_at, entries_only=False)
        prefix = "" if base.requested == "." else base.requested.rstrip("/") + "/"
        matches = sorted(
            relative
            for relative, kind in rows
            if kind == "f"
            and fnmatch.fnmatchcase(relative.removeprefix(prefix), pattern)
        )
        output = "\n".join(matches[:MAX_LIST_ENTRIES]) or "(no matches)"
        if len(matches) > MAX_LIST_ENTRIES:
            output += f"\n... ({len(matches) - MAX_LIST_ENTRIES} more)"
        return _bounded_observation(output)

    async def _ls(
        self, args: dict[str, Any], deadline_at: int, _strict: bool, _exact: str | None
    ) -> str:
        _strict_args(args, set(), {"path"})
        base = await self._probe(args.get("path", "."), deadline_at, allow_dir=True)
        if base.kind != "dir":
            raise RemoteToolError("invalid-path", "ls path must be a directory")
        rows = await self._find_paths(base, deadline_at, entries_only=True)
        names = sorted(
            (relative.rsplit("/", 1)[-1] + ("/" if kind == "d" else ""))
            for relative, kind in rows
        )
        output = "\n".join(names[:MAX_LIST_ENTRIES]) or "(empty)"
        if len(names) > MAX_LIST_ENTRIES:
            output += f"\n... ({len(names) - MAX_LIST_ENTRIES} more)"
        return _bounded_observation(output)

    async def _prepare_write_path(
        self, raw: Any, deadline_at: int
    ) -> tuple[str, PathProbe | None]:
        requested = _normalize_path(raw)
        absolute = f"{self.root}/{requested}"
        if _credential_reason(requested) or _credential_reason(absolute):
            raise RemoteToolError(
                "credential-path", "refused credential-shaped write path"
            )
        parent = str(PurePosixPath(absolute).parent)
        command = (
            "set -eu; "
            f"root={shlex.quote(self.root)}; target={shlex.quote(absolute)}; parent={shlex.quote(parent)}; "
            'prospective=$(realpath -m -- "$parent") || exit 71; '
            'case "$prospective" in "$root"|"$root"/*) ;; *) exit 72;; esac; '
            'mkdir -p -- "$parent"; canonical_parent=$(realpath -e -- "$parent") || exit 73; '
            'case "$canonical_parent" in "$root"|"$root"/*) ;; *) exit 72;; esac; '
            'test ! -L "$target" || exit 74; '
            'if test -e "$target"; then test -f "$target" || exit 75; '
            "test \"$(stat -Lc '%h' -- \"$target\")\" = 1 || exit 76; fi; printf 'OK\\n'"
        )
        result = await self._exec(command, deadline_at)
        if result.return_code != 0 or (result.stdout or "") != "OK\n":
            raise RemoteToolError(
                "unsafe-write-path",
                "structured write target is not a confined single-link file",
            )
        try:
            return requested, await self._probe(requested, deadline_at)
        except RemoteToolError as error:
            if error.code == "missing-path":
                return requested, None
            raise

    async def _atomic_write(
        self,
        requested: str,
        content: str,
        deadline_at: int,
        expected: PathProbe | None,
    ) -> None:
        data = content.encode("utf-8")
        if len(data) > MAX_TRANSFER_FILE_BYTES:
            raise RemoteToolError(
                "file-bound", "structured write exceeds the transfer bound"
            )
        absolute = f"{self.root}/{requested}"
        parent = str(PurePosixPath(absolute).parent)
        name = PurePosixPath(absolute).name
        token = uuid.uuid4().hex
        remote_staging = f"{REMOTE_STATE_ROOT}/write-{token}"
        with tempfile.TemporaryDirectory(prefix="neko-harbor-write-") as temp_dir:
            local = Path(temp_dir) / "payload"
            local.write_bytes(data)
            remaining = _remaining_seconds(deadline_at)
            try:
                await asyncio.wait_for(
                    self.environment.upload_file(local, remote_staging),
                    timeout=remaining,
                )
            except asyncio.TimeoutError as error:
                raise RemoteToolError(
                    "deadline-expired", "file upload exceeded its deadline"
                ) from error
        expected_test = (
            'test ! -e "$target" && test ! -L "$target"'
            if expected is None
            else f'test ! -L "$target" && test "$(stat -Lc \'%d:%i:%s:%Y:%h\' -- "$target")" = {shlex.quote(expected.identity)}'
        )
        command = (
            "set -eu; "
            f"root={shlex.quote(self.root)}; parent={shlex.quote(parent)}; "
            f"name={shlex.quote(name)}; staging={shlex.quote(remote_staging)}; "
            'temp=; trap \'rm -f -- "$staging"; test -z "$temp" || rm -f -- "$temp"\' EXIT; '
            'test -f "$staging" && test ! -L "$staging" && '
            'test "$(stat -Lc \'%h\' -- "$staging")" = 1 || exit 73; '
            'canonical_parent=$(realpath -e -- "$parent") || exit 71; '
            'case "$canonical_parent" in "$root"|"$root"/*) ;; *) exit 72;; esac; '
            'target="$canonical_parent/$name"; temp="$canonical_parent/.neko-remote-'
            f"{token}" + '"; test ! -e "$temp" && test ! -L "$temp" || exit 73; '
            'mv -- "$staging" "$temp"; test -f "$temp" && test ! -L "$temp" && '
            'test "$(stat -Lc \'%h\' -- "$temp")" = 1 || exit 73; '
            f"{expected_test} || exit 74; "
            'if test -e "$target"; then mode=$(stat -Lc \'%a\' -- "$target"); chmod "$mode" -- "$temp"; fi; '
            'mv -f -- "$temp" "$target"; test -f "$target" && test ! -L "$target" && '
            "test \"$(stat -Lc '%h' -- \"$target\")\" = 1 || exit 75; printf 'OK\\n'"
        )
        result = await self._exec(command, deadline_at)
        if result.return_code != 0 or (result.stdout or "") != "OK\n":
            cleanup_deadline = int(time.time() * 1000) + 5000
            try:
                await self._exec(
                    f"rm -f -- {shlex.quote(remote_staging)}", cleanup_deadline
                )
            except RemoteToolError:
                result = None
            raise RemoteToolError(
                "write-race", "structured write target changed or escaped before commit"
            )

    async def _write_file(
        self, args: dict[str, Any], deadline_at: int, _strict: bool, _exact: str | None
    ) -> str:
        _strict_args(args, {"path", "content"})
        content = _require_string(args, "content", allow_empty=True)
        requested, before = await self._prepare_write_path(args["path"], deadline_at)
        await self._atomic_write(requested, content, deadline_at, before)
        lines = content.split("\n")
        preview = [
            f"Wrote {requested}  ({'overwrote, ' if before else ''}+{len(lines)})"
        ]
        preview += [
            f"{index:>4} + {line}" for index, line in enumerate(lines[:16], start=1)
        ]
        return _bounded_observation("\n".join(preview))

    async def _edit(
        self,
        args: dict[str, Any],
        deadline_at: int,
        strict: bool,
        exact_target: str | None,
    ) -> str:
        _strict_args(args, {"path", "old_string", "new_string"})
        requested = _normalize_path(args["path"])
        old = _require_string(args, "old_string")
        new = _require_string(args, "new_string", allow_empty=True)
        probe = await self._probe(requested, deadline_at)
        if not probe.direct or probe.kind != "file" or probe.links != 1:
            raise RemoteToolError(
                "unsafe-write-path",
                "edit target is not a direct single-link regular file",
            )
        if exact_target is not None:
            exact = await self._probe(_normalize_path(exact_target), deadline_at)
            if (
                exact.canonical != probe.canonical
                or not exact.direct
                or exact.links != 1
            ):
                raise RemoteToolError(
                    "exact-target-mismatch",
                    "edit target does not match the exact-file lease",
                )
        text = await self._download_snapshot(probe, deadline_at)
        occurrences = _count_occurrences(text, old)
        if occurrences != 1:
            if strict:
                return f"Error: exact-file edit requires old_string to match current bytes exactly once in {requested} (found {occurrences}). No change written."
            return f"Error: old_string {'not found' if occurrences == 0 else f'occurs {occurrences} times'} in {requested}"
        start = text.index(old)
        updated = text[:start] + new + text[start + len(old) :]
        await self._atomic_write(requested, updated, deadline_at, probe)
        removed = old.split("\n")
        added = new.split("\n")
        return f"Edited {requested}  (+{len(added)} -{len(removed)})"

    async def _multi_edit(
        self, args: dict[str, Any], deadline_at: int, _strict: bool, _exact: str | None
    ) -> str:
        _strict_args(args, {"path", "edits"})
        edits = args["edits"]
        if not isinstance(edits, list) or not edits or len(edits) > 100:
            raise RemoteToolError(
                "invalid-arguments", "multi_edit needs 1 to 100 edits"
            )
        requested = _normalize_path(args["path"])
        probe = await self._probe(requested, deadline_at)
        if not probe.direct or probe.kind != "file" or probe.links != 1:
            raise RemoteToolError(
                "unsafe-write-path",
                "multi_edit target is not a direct single-link regular file",
            )
        text = await self._download_snapshot(probe, deadline_at)
        added = 0
        removed = 0
        for index, edit in enumerate(edits, start=1):
            try:
                item = _strict_args(edit, {"old_string", "new_string"})
            except RemoteToolError as error:
                raise RemoteToolError(
                    "invalid-arguments", f"edit {index} has invalid fields"
                ) from error
            old = _require_string(item, "old_string")
            new = _require_string(item, "new_string", allow_empty=True)
            occurrences = _count_occurrences(text, old)
            if occurrences != 1:
                reason = (
                    "not found"
                    if occurrences == 0
                    else f"occurs {occurrences} times, not unique"
                )
                return f"Error: edit {index}: old_string {reason} (no change written)"
            text = text.replace(old, new, 1)
            removed += len(old.split("\n"))
            added += len(new.split("\n"))
        await self._atomic_write(requested, text, deadline_at, probe)
        return f"Edited {requested}  ({len(edits)} edits, +{added} -{removed})"

    @staticmethod
    def _snapshot_shell() -> str:
        # Only shell builtins run while /proc is enumerated.  That matters: a
        # helper process created by `ps`, `awk`, or `sort` would otherwise look
        # exactly like a new task descendant and make verification ambiguous.
        return (
            "read -r self_line < /proc/self/stat || exit 91; self_pid=${self_line%% *}; "
            'protected=" $self_pid "; probe=$self_pid; depth=0; '
            'while test "$probe" -gt 1 && test "$depth" -lt 64; do '
            'read -r probe_line < "/proc/$probe/stat" || break; probe_rest=${probe_line##*) }; '
            'set -- $probe_rest; probe=$2; protected="$protected$probe "; depth=$((depth+1)); done; '
            "printf 'SNAP\\n'; count=0; "
            'for stat_file in /proc/[0-9]*/stat; do count=$((count+1)); test "$count" -le 8192 || exit 92; '
            'read -r stat_line < "$stat_file" 2>/dev/null || continue; pid=${stat_line%% *}; '
            'case "$protected" in *" $pid "*) continue;; esac; stat_rest=${stat_line##*) }; '
            'set -- $stat_rest; start=${20}; case "$pid:$start" in *[!0-9:]*) exit 93;; esac; '
            'printf \'%s:%s\\n\' "$pid" "$start"; done'
        )

    async def _process_snapshot(self, deadline_at: int) -> tuple[str, ...]:
        result = await self._raw_exec(
            self._snapshot_shell(), deadline_at, output_limit=256 * 1024
        )
        lines = (result.stdout or "").splitlines()
        if (
            result.return_code != 0
            or not lines
            or lines[0] != "SNAP"
            or len(lines) > 8193
        ):
            raise RemoteToolError(
                "pid-containment", "bounded PID-namespace snapshot is unavailable"
            )
        identities = lines[1:]
        if any(
            not re.fullmatch(r"[1-9][0-9]*:[1-9][0-9]*", item) for item in identities
        ):
            raise RemoteToolError(
                "pid-containment",
                "PID-namespace snapshot returned invalid identity evidence",
            )
        if len(set(identities)) != len(identities):
            raise RemoteToolError(
                "pid-containment",
                "PID-namespace snapshot returned duplicate identities",
            )
        return tuple(sorted(identities))

    async def _preflight_process_containment(self) -> None:
        deadline = int(time.time() * 1000) + 10_000
        baseline = await self._process_snapshot(deadline)
        await asyncio.sleep(0.05)
        if await self._process_snapshot(deadline) != baseline:
            raise RuntimeError(
                "Harbor task PID namespace is not quiescent enough for bounded bash cleanup"
            )

        # Prove the fallback catches the exact escape that PGID + environment
        # token alone misses: a detached child starts a new session and removes
        # the inherited token before sleeping.
        token = uuid.uuid4().hex
        detached = (
            f"env NEKO_REMOTE_CALL_TOKEN={shlex.quote(token)} setsid sh -c "
            + shlex.quote(
                "setsid env -u NEKO_REMOTE_CALL_TOKEN sh -c 'sleep 30' "
                ">/dev/null 2>&1 &"
            )
        )
        self._tokens[token] = baseline
        try:
            launched = await self._raw_exec(detached, deadline)
            if launched.return_code != 0:
                raise RuntimeError(
                    "Harbor task cannot launch the process-containment canary"
                )
            await asyncio.sleep(0.05)
        finally:
            await self._complete_quiescence_obligation(token, baseline)
        if await self._process_snapshot(deadline) != baseline:
            self._tokens[token] = baseline
            raise RuntimeError("Harbor task failed detached-child cleanup verification")

    @staticmethod
    def _new_pid_scan_shell(baseline: tuple[str, ...]) -> str:
        baseline_words = " " + " ".join(baseline) + " "
        return (
            "read -r self_line < /proc/self/stat || exit 91; self_pid=${self_line%% *}; "
            'protected=" $self_pid "; probe=$self_pid; depth=0; '
            'while test "$probe" -gt 1 && test "$depth" -lt 64; do '
            'read -r probe_line < "/proc/$probe/stat" || break; probe_rest=${probe_line##*) }; '
            'set -- $probe_rest; probe=$2; protected="$protected$probe "; depth=$((depth+1)); done; '
            f"baseline={shlex.quote(baseline_words)}; found=''; count=0; "
            'for stat_file in /proc/[0-9]*/stat; do count=$((count+1)); test "$count" -le 8192 || exit 92; '
            'read -r stat_line < "$stat_file" 2>/dev/null || continue; pid=${stat_line%% *}; '
            'case "$protected" in *" $pid "*) continue;; esac; stat_rest=${stat_line##*) }; '
            "set -- $stat_rest; start=${20}; identity=$pid:$start; "
            'case "$baseline" in *" $identity "*) continue;; esac; found="$found $pid"; done; '
            "printf '%s\\n' \"$found\""
        )

    async def _bash(
        self, args: dict[str, Any], deadline_at: int, sandbox: dict[str, Any]
    ) -> str:
        _strict_args(args, {"command"}, {"timeout", "run_in_background"})
        command_text = _require_string(args, "command")
        if args.get("run_in_background") is True:
            raise RemoteToolError(
                "background-refused",
                "background bash is unavailable in Harbor remote tools",
            )
        if args.get("run_in_background") not in {None, False}:
            raise RemoteToolError(
                "invalid-arguments", "run_in_background must be boolean"
            )
        if sandbox["readOnlyWorkspace"]:
            raise RemoteToolError(
                "exact-validator-unsupported",
                "read-only exact-validator bash is unsupported",
            )
        requested_timeout = args.get("timeout")
        if requested_timeout is not None:
            if (
                isinstance(requested_timeout, bool)
                or not isinstance(requested_timeout, (int, float))
                or not math.isfinite(requested_timeout)
            ):
                raise RemoteToolError(
                    "invalid-arguments", "bash timeout must be numeric"
                )
            deadline_at = min(
                deadline_at,
                int(time.time() * 1000)
                + max(1000, min(int(requested_timeout), MAX_CALL_TIMEOUT_MS)),
            )
        started_at = int(time.time() * 1000)
        timeout_ms = max(MIN_CALL_TIMEOUT_MS, deadline_at - started_at)
        baseline = await self._process_snapshot(deadline_at)
        token = uuid.uuid4().hex
        self._tokens[token] = baseline
        state = f"{REMOTE_STATE_ROOT}/{token}"
        remote_command = f"{state}/command.sh"
        remote_fifo = f"{state}/output.fifo"
        remote_output = f"{state}/output"
        remote_status = f"{state}/status"
        remote_pid = f"{state}/pid"
        try:
            with tempfile.TemporaryDirectory(prefix="neko-harbor-bash-") as temp_dir:
                local = Path(temp_dir) / "command.sh"
                local.write_text(command_text, encoding="utf-8")
                setup = await self._raw_exec(
                    f"mkdir -m 700 -- {shlex.quote(state)} && mkfifo {shlex.quote(remote_fifo)}",
                    deadline_at,
                )
                if setup.return_code != 0:
                    raise RemoteToolError(
                        "bash-setup", "bash process state setup failed"
                    )
                try:
                    await asyncio.wait_for(
                        self.environment.upload_file(local, remote_command),
                        timeout=_remaining_seconds(deadline_at),
                    )
                except asyncio.TimeoutError as error:
                    raise RemoteToolError(
                        "deadline-expired",
                        "bash command upload exceeded its deadline",
                    ) from error

            wrapper = (
                "set -eu; "
                f"state={shlex.quote(state)}; fifo={shlex.quote(remote_fifo)}; output={shlex.quote(remote_output)}; "
                f"status={shlex.quote(remote_status)}; command_file={shlex.quote(remote_command)}; "
                "{ head -c "
                + str(MAX_BASH_OUTPUT_CHARS + 1)
                + '; cat >/dev/null; } < "$fifo" > "$output" & collector=$!; '
                'set +e; sh "$command_file" > "$fifo" 2>&1; code=$?; set -e; '
                'wait "$collector" || true; printf \'%s\\n\' "$code" > "$status.tmp"; mv "$status.tmp" "$status"'
            )
            launch = (
                "set -eu; "
                f"env NEKO_REMOTE_CALL_TOKEN={shlex.quote(token)} setsid sh -c {shlex.quote(wrapper)} >/dev/null 2>&1 & leader=$!; "
                f"printf '%s\\n' \"$leader\" > {shlex.quote(remote_pid)}; "
                'attempt=0; while test "$attempt" -lt 20; do '
                f"if kill -0 -- -\"$leader\" 2>/dev/null || test -s {shlex.quote(remote_status)}; then printf 'OK\\n'; exit 0; fi; "
                "sleep 0.01; attempt=$((attempt+1)); done; exit 71"
            )
            try:
                result = await self._raw_exec(launch, deadline_at)
                if result.return_code != 0 or (result.stdout or "") != "OK\n":
                    raise RemoteToolError(
                        "bash-launch", "bash process group did not start"
                    )
                while True:
                    remaining = _remaining_seconds(deadline_at)
                    poll = await self._raw_exec(
                        f"if test -s {shlex.quote(remote_status)}; then cat {shlex.quote(remote_status)}; else printf 'RUNNING\\n'; fi",
                        min(deadline_at, int(time.time() * 1000) + 2000),
                    )
                    value = (poll.stdout or "").strip()
                    if value != "RUNNING":
                        if not re.fullmatch(r"[0-9]{1,3}", value):
                            raise RemoteToolError(
                                "bash-status", "bash returned an invalid exit status"
                            )
                        code = int(value)
                        output = await self._raw_exec(
                            f"cat {shlex.quote(remote_output)} 2>/dev/null || true",
                            deadline_at,
                            output_limit=MAX_BASH_OUTPUT_CHARS + 4096,
                        )
                        body = output.stdout or ""
                        if len(body) > MAX_BASH_OUTPUT_CHARS:
                            body = (
                                body[:MAX_BASH_OUTPUT_CHARS]
                                + f"\n... (truncated at {MAX_BASH_OUTPUT_CHARS} chars)"
                            )
                        tag = (
                            "(exit 0)"
                            if code == 0
                            else f"(exit {code} -- command FAILED)"
                        )
                        return f"{tag}\n{body}".rstrip()
                    await asyncio.sleep(min(0.1, remaining))
            except RemoteToolError as error:
                if error.code == "deadline-expired":
                    return f"(timed out after {timeout_ms}ms)"
                raise
        finally:
            await self._complete_quiescence_obligation(token, baseline)

    def _token_scan_shell(self, token: str) -> str:
        return (
            "count=0; found=''; "
            'for env_file in /proc/[0-9]*/environ; do count=$((count+1)); test "$count" -le 8192 || exit 81; '
            'test -r "$env_file" || continue; '
            f"if tr '\\000' '\\n' < \"$env_file\" 2>/dev/null | grep -Fqx {shlex.quote('NEKO_REMOTE_CALL_TOKEN=' + token)}; then "
            'pid=${env_file#/proc/}; pid=${pid%/environ}; found="$found $pid"; fi; done; printf \'%s\\n\' "$found"'
        )

    async def _complete_quiescence_obligation(
        self, token: str, baseline: tuple[str, ...]
    ) -> None:
        """Do not let cancellation outrun proof that the task is quiescent."""

        cleanup = asyncio.create_task(self._ensure_quiescent(token, baseline, None))
        interrupted = False
        while True:
            try:
                await asyncio.shield(cleanup)
                break
            except asyncio.CancelledError:
                interrupted = True
                continue
        if interrupted:
            raise asyncio.CancelledError()

    async def _ensure_quiescent(
        self,
        token: str,
        baseline: tuple[str, ...],
        deadline_at: int | None,
    ) -> None:
        last_error: BaseException | None = None
        for _attempt in range(3):
            try:
                await self._quiesce_token(token, baseline, deadline_at)
                return
            except ProtocolError:
                raise
            except BaseException as error:  # noqa: BLE001 - retry transport and containment failures alike
                last_error = error
                await asyncio.sleep(0.05)

        # Returning any observation while a command-owned process may still run
        # would make the quiescence attestation false.  Harbor owns this exact
        # task container, so destroy it and force the trial to error instead of
        # allowing a verifier to observe a racing survivor.
        await self._abort_task(
            "containment-failure",
            "remote process containment failed and the Harbor task was aborted",
            last_error,
        )

    async def _quiesce_token(
        self,
        token: str,
        baseline: tuple[str, ...],
        deadline_at: int | None,
    ) -> None:
        if not re.fullmatch(r"[0-9a-f]{32}", token):
            raise RuntimeError("invalid internal process token")
        state = f"{REMOTE_STATE_ROOT}/{token}"
        pid_file = f"{state}/pid"
        scan = self._token_scan_shell(token)
        scan_new = self._new_pid_scan_shell(baseline)
        cleanup = (
            "set -eu; "
            f"state={shlex.quote(state)}; pid_file={shlex.quote(pid_file)}; "
            'leader=\'\'; test ! -s "$pid_file" || leader=$(cat "$pid_file"); '
            f'pids=$({scan}); new_pids=$({scan_new}); pids="$pids $new_pids"; '
            'if test -n "$leader"; then kill -TERM -- -"$leader" 2>/dev/null || true; fi; '
            'for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done; '
            "step=0; while test \"$step\" -lt 10; do alive=''; "
            f'alive=$({scan}); new_alive=$({scan_new}); alive="$alive $new_alive"; '
            'test -z "$alive" && break; sleep 0.05; step=$((step+1)); done; '
            'if test -n "$leader"; then kill -KILL -- -"$leader" 2>/dev/null || true; fi; '
            'for pid in $alive; do kill -KILL "$pid" 2>/dev/null || true; done; sleep 0.05; '
            f"remaining=$({scan}); new_remaining=$({scan_new}); "
            'test -z "$remaining$new_remaining" || exit 82; '
            'if test -n "$leader"; then kill -0 -- -"$leader" 2>/dev/null && exit 83 || true; fi; '
            "rm -rf -- \"$state\"; printf 'QUIESCENT\\n'"
        )
        cleanup_deadline = (
            int(time.time() * 1000) + QUIESCENCE_ATTEMPT_TIMEOUT_MS
        )
        if deadline_at is not None:
            cleanup_deadline = max(cleanup_deadline, deadline_at)
        result = await self._raw_exec(cleanup, cleanup_deadline, output_limit=8192)
        if result.return_code != 0 or (result.stdout or "") != "QUIESCENT\n":
            raise RemoteToolError(
                "quiescence-failed",
                "remote process tree could not be verified quiescent",
            )
        self._tokens.pop(token, None)


def _validate_peer_frame(frame: dict[str, Any]) -> str:
    if frame.get("schema") != FRAME_SCHEMA or not isinstance(frame.get("type"), str):
        raise ProtocolError("schema-mismatch", "peer frame has the wrong schema")
    return frame["type"]


def _metric_count(value: Any) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > MAX_SAFE_JSON_INTEGER
    ):
        raise ProtocolError("invalid-final", "final metrics contain an invalid count")
    return value


def _validate_metrics_checkpoint(
    frame: dict[str, Any],
    previous: dict[str, Any] | None,
    *,
    minimum_requested: int = 0,
    minimum_completed: int = 0,
) -> dict[str, Any]:
    value = _strict_object(frame, {"schema", "type", "metrics"})
    if value["schema"] != FRAME_SCHEMA or value["type"] != "metrics_checkpoint":
        raise ProtocolError("invalid-checkpoint", "metrics checkpoint frame is invalid")
    metrics = _strict_object(
        value["metrics"],
        {
            "providerCompleteCalls",
            "providerUsageObservedCalls",
            "providerReportedModelCalls",
            "inputTokens",
            "outputTokens",
            "cachedTokens",
            "totalTokens",
            "wallTimeMs",
            "hitMaxSteps",
            "toolCalls",
        },
    )
    try:
        provider_complete_calls = _metric_count(metrics["providerCompleteCalls"])
        provider_usage_observed_calls = _metric_count(
            metrics["providerUsageObservedCalls"]
        )
        provider_reported_model_calls = _metric_count(
            metrics["providerReportedModelCalls"]
        )
        input_tokens = _metric_count(metrics["inputTokens"])
        output_tokens = _metric_count(metrics["outputTokens"])
        cached_tokens = _metric_count(metrics["cachedTokens"])
        total_tokens = _metric_count(metrics["totalTokens"])
        wall_time_ms = _metric_count(metrics["wallTimeMs"])
        tool_calls = _strict_object(
            metrics["toolCalls"],
            {"requested", "completed", "productive", "empty", "failed"},
        )
        requested = _metric_count(tool_calls["requested"])
        completed = _metric_count(tool_calls["completed"])
        productive = _metric_count(tool_calls["productive"])
        empty = _metric_count(tool_calls["empty"])
        failed = _metric_count(tool_calls["failed"])
    except ProtocolError as error:
        raise ProtocolError(
            "invalid-checkpoint", "metrics checkpoint contains an invalid count"
        ) from error
    if not isinstance(metrics["hitMaxSteps"], bool):
        raise ProtocolError(
            "invalid-checkpoint", "metrics checkpoint max-step status is invalid"
        )
    if (
        provider_usage_observed_calls > provider_complete_calls
        or (
            provider_usage_observed_calls == 0
            and any(
                count != 0
                for count in (
                    provider_reported_model_calls,
                    input_tokens,
                    output_tokens,
                    cached_tokens,
                    total_tokens,
                )
            )
        )
        or (
            provider_usage_observed_calls > 0
            and provider_reported_model_calls < provider_usage_observed_calls
        )
        or cached_tokens > input_tokens
        or total_tokens < input_tokens + output_tokens
        or completed > requested
        or completed != productive + empty + failed
        or requested < minimum_requested
        or completed < minimum_completed
    ):
        raise ProtocolError(
            "invalid-checkpoint", "metrics checkpoint values are inconsistent"
        )
    checkpoint = {
        "providerCompleteCalls": provider_complete_calls,
        "providerUsageObservedCalls": provider_usage_observed_calls,
        "providerReportedModelCalls": provider_reported_model_calls,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cachedTokens": cached_tokens,
        "totalTokens": total_tokens,
        "wallTimeMs": wall_time_ms,
        "hitMaxSteps": metrics["hitMaxSteps"],
        "toolCalls": {
            "requested": requested,
            "completed": completed,
            "productive": productive,
            "empty": empty,
            "failed": failed,
        },
    }
    if previous is not None:
        current_counts = (
            provider_complete_calls,
            provider_usage_observed_calls,
            provider_reported_model_calls,
            input_tokens,
            output_tokens,
            cached_tokens,
            total_tokens,
            wall_time_ms,
            requested,
            completed,
            productive,
            empty,
            failed,
        )
        previous_counts = (
            previous["providerCompleteCalls"],
            previous["providerUsageObservedCalls"],
            previous["providerReportedModelCalls"],
            previous["inputTokens"],
            previous["outputTokens"],
            previous["cachedTokens"],
            previous["totalTokens"],
            previous["wallTimeMs"],
            previous["toolCalls"]["requested"],
            previous["toolCalls"]["completed"],
            previous["toolCalls"]["productive"],
            previous["toolCalls"]["empty"],
            previous["toolCalls"]["failed"],
        )
        if any(current < prior for current, prior in zip(current_counts, previous_counts)):
            raise ProtocolError(
                "invalid-checkpoint", "metrics checkpoint counters regressed"
            )
        if previous["hitMaxSteps"] and not checkpoint["hitMaxSteps"]:
            raise ProtocolError(
                "invalid-checkpoint", "metrics checkpoint max-step status regressed"
            )
    return checkpoint


def _validate_final(frame: dict[str, Any]) -> dict[str, Any]:
    value = _strict_object(frame, {"schema", "type", "metrics"})
    if value["schema"] != FRAME_SCHEMA or value["type"] != "final":
        raise ProtocolError("invalid-final", "final frame is invalid")
    metrics = _strict_object(
        value["metrics"],
        {
            "completionStatus",
            "usageComplete",
            "providerCompleteCalls",
            "providerReportedModelCalls",
            "inputTokens",
            "outputTokens",
            "cachedTokens",
            "totalTokens",
            "wallTimeMs",
            "hitMaxSteps",
            "toolCalls",
        },
    )
    status = metrics["completionStatus"]
    if not isinstance(status, str) or status not in {
        "ok",
        "validation_failed",
        "validation_missing",
    }:
        raise ProtocolError("invalid-final", "final completion status is invalid")
    if not isinstance(metrics["usageComplete"], bool):
        raise ProtocolError("invalid-final", "final usage completeness is invalid")
    provider_complete_calls = _metric_count(metrics["providerCompleteCalls"])
    reported_values = (
        metrics["providerReportedModelCalls"],
        metrics["inputTokens"],
        metrics["outputTokens"],
        metrics["cachedTokens"],
        metrics["totalTokens"],
    )
    if metrics["usageComplete"]:
        (
            provider_reported_model_calls,
            input_tokens,
            output_tokens,
            cached_tokens,
            total_tokens,
        ) = tuple(_metric_count(item) for item in reported_values)
        if (
            provider_complete_calls < 1
            or provider_reported_model_calls < provider_complete_calls
            or cached_tokens > input_tokens
            or total_tokens < input_tokens + output_tokens
        ):
            raise ProtocolError("invalid-final", "final usage metrics are inconsistent")
    else:
        if any(item is not None for item in reported_values):
            raise ProtocolError("invalid-final", "incomplete final usage must be null")
        provider_reported_model_calls = None
        input_tokens = None
        output_tokens = None
        cached_tokens = None
        total_tokens = None
    tool_calls = _strict_object(
        metrics["toolCalls"],
        {"requested", "completed", "productive", "empty", "failed"},
    )
    requested = _metric_count(tool_calls["requested"])
    completed = _metric_count(tool_calls["completed"])
    productive = _metric_count(tool_calls["productive"])
    empty = _metric_count(tool_calls["empty"])
    failed = _metric_count(tool_calls["failed"])
    if completed != requested or completed != productive + empty + failed:
        raise ProtocolError("invalid-final", "final tool metrics are inconsistent")
    wall_time_ms = _metric_count(metrics["wallTimeMs"])
    if not isinstance(metrics["hitMaxSteps"], bool):
        raise ProtocolError("invalid-final", "final max-step status is invalid")
    # Reconstruct the allowlisted object so no raw peer mapping reaches host logs.
    return {
        "completionStatus": status,
        "usageComplete": metrics["usageComplete"],
        "providerCompleteCalls": provider_complete_calls,
        "providerReportedModelCalls": provider_reported_model_calls,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cachedTokens": cached_tokens,
        "totalTokens": total_tokens,
        "wallTimeMs": wall_time_ms,
        "hitMaxSteps": metrics["hitMaxSteps"],
        "toolCalls": {
            "requested": requested,
            "completed": completed,
            "productive": productive,
            "empty": empty,
            "failed": failed,
        },
    }


def _reconcile_final(
    final: dict[str, Any],
    checkpoint: dict[str, Any] | None,
    *,
    minimum_requested: int = 0,
    minimum_completed: int = 0,
) -> None:
    if checkpoint is None:
        raise ProtocolError(
            "invalid-final", "final frame requires a terminal metrics checkpoint"
        )
    if (
        final["providerCompleteCalls"] != checkpoint["providerCompleteCalls"]
        or final["hitMaxSteps"] != checkpoint["hitMaxSteps"]
        or final["toolCalls"] != checkpoint["toolCalls"]
        or final["wallTimeMs"] < checkpoint["wallTimeMs"]
        or final["toolCalls"]["requested"] < minimum_requested
        or final["toolCalls"]["completed"] < minimum_completed
    ):
        raise ProtocolError("invalid-final", "final metrics do not match checkpoint")
    checkpoint_usage_complete = (
        checkpoint["providerUsageObservedCalls"]
        == checkpoint["providerCompleteCalls"]
    )
    if checkpoint_usage_complete and not final["usageComplete"]:
        raise ProtocolError("invalid-final", "final usage regressed from checkpoint")
    if final["usageComplete"]:
        if checkpoint["providerUsageObservedCalls"] != final["providerCompleteCalls"]:
            raise ProtocolError("invalid-final", "final usage is not checkpoint-complete")
        for name in (
            "providerReportedModelCalls",
            "inputTokens",
            "outputTokens",
            "cachedTokens",
            "totalTokens",
        ):
            if final[name] != checkpoint[name]:
                raise ProtocolError(
                    "invalid-final", "final usage does not match checkpoint"
                )


def _validate_request(
    frame: dict[str, Any], seen_ids: set[str]
) -> tuple[str, str, dict[str, Any], dict[str, Any]]:
    value = _strict_object(frame, {"schema", "type", "id", "tool", "args", "context"})
    request_id = value["id"]
    if (
        not isinstance(request_id, str)
        or not _ID_RE.fullmatch(request_id)
        or request_id in seen_ids
    ):
        raise ProtocolError("invalid-request-id", "request id is invalid or reused")
    if value["type"] != "request" or value["schema"] != FRAME_SCHEMA:
        raise ProtocolError("malformed-request", "request frame is invalid")
    if (
        value["tool"] not in TOOLS
        or not isinstance(value["args"], dict)
        or not isinstance(value["context"], dict)
    ):
        raise ProtocolError(
            "malformed-request", "request tool, args, or context is invalid"
        )
    seen_ids.add(request_id)
    return request_id, value["tool"], value["args"], value["context"]


async def _cancel_active_tool(task: asyncio.Task[str]) -> BaseException | str:
    task.cancel()
    settlement = asyncio.gather(task, return_exceptions=True)
    while True:
        try:
            return (await asyncio.shield(settlement))[0]
        except asyncio.CancelledError:
            continue


async def serve_protocol(
    reader: asyncio.StreamReader,
    writer: FrameWriter,
    dispatcher: RemoteToolDispatcher,
    instruction: str,
    on_metrics_checkpoint: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Serve one runner session and return only reconstructed final metrics.

    One active request permits deterministic cancellation; final remains idle-only.
    """

    await write_frame(writer, dispatcher.hello(instruction))
    seen_ids: set[str] = set()
    active: asyncio.Task[str] | None = None
    active_id: str | None = None
    read_task: asyncio.Task[dict[str, Any]] | None = None
    latest_checkpoint: dict[str, Any] | None = None
    served_requests = 0
    settled_requests = 0
    try:
        while True:
            if read_task is None:
                read_task = asyncio.create_task(read_frame(reader))
            if active is None:
                try:
                    frame = await read_task
                except EOFError as error:
                    raise ProtocolError(
                        "unexpected-eof", "runner closed before final"
                    ) from error
                read_task = None
                frame_type = _validate_peer_frame(frame)
                if frame_type == "metrics_checkpoint":
                    latest_checkpoint = _validate_metrics_checkpoint(
                        frame,
                        latest_checkpoint,
                        minimum_requested=served_requests,
                        minimum_completed=settled_requests,
                    )
                    if on_metrics_checkpoint is not None:
                        on_metrics_checkpoint(latest_checkpoint)
                    continue
                if frame_type == "final":
                    final = _validate_final(frame)
                    _reconcile_final(
                        final,
                        latest_checkpoint,
                        minimum_requested=served_requests,
                        minimum_completed=settled_requests,
                    )
                    return final
                if frame_type != "request":
                    raise ProtocolError(
                        "invalid-order",
                        "runner may only request a tool or finish while idle",
                    )
                active_id, tool, args, context = _validate_request(frame, seen_ids)
                served_requests += 1
                active = asyncio.create_task(dispatcher.execute(tool, args, context))
                continue

            done, _ = await asyncio.wait(
                {active, read_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if active in done:
                request_id = active_id
                assert request_id is not None
                settled_requests += 1
                try:
                    result = active.result()
                    await write_frame(
                        writer,
                        {
                            "schema": FRAME_SCHEMA,
                            "type": "result",
                            "id": request_id,
                            "result": result,
                        },
                    )
                except asyncio.CancelledError:
                    await write_frame(
                        writer,
                        {
                            "schema": FRAME_SCHEMA,
                            "type": "cancelled",
                            "id": request_id,
                            "result": "(interrupted)",
                        },
                    )
                except RemoteToolError as error:
                    await write_frame(
                        writer,
                        {
                            "schema": FRAME_SCHEMA,
                            "type": "error",
                            "id": request_id,
                            "code": error.code,
                            "message": str(error),
                        },
                    )
                except ProtocolError:
                    raise
                except Exception:  # noqa: BLE001 - peer sees only the fixed fail-closed message
                    await write_frame(
                        writer,
                        {
                            "schema": FRAME_SCHEMA,
                            "type": "error",
                            "id": request_id,
                            "code": "remote-failure",
                            "message": "remote tool failed closed",
                        },
                    )
                active = None
                active_id = None
                continue

            try:
                frame = read_task.result()
            except EOFError as error:
                raise ProtocolError(
                    "unexpected-eof", "runner closed with an active tool"
                ) from error
            read_task = None
            frame_type = _validate_peer_frame(frame)
            if frame_type == "metrics_checkpoint":
                latest_checkpoint = _validate_metrics_checkpoint(
                    frame,
                    latest_checkpoint,
                    minimum_requested=served_requests,
                    minimum_completed=settled_requests,
                )
                if on_metrics_checkpoint is not None:
                    on_metrics_checkpoint(latest_checkpoint)
                continue
            cancel = _strict_object(frame, {"schema", "type", "id"})
            if cancel["type"] != "cancel" or cancel["id"] != active_id:
                raise ProtocolError(
                    "invalid-order",
                    "only cancellation of the active request is allowed",
                )
            settled = await _cancel_active_tool(active)
            if isinstance(settled, ProtocolError):
                raise settled
            if isinstance(settled, Exception) and not isinstance(
                settled, asyncio.CancelledError
            ):
                raise ProtocolError(
                    "cancel-failed",
                    "remote tool did not settle safely after cancellation",
                ) from settled
            settled_requests += 1
            await write_frame(
                writer,
                {
                    "schema": FRAME_SCHEMA,
                    "type": "cancelled",
                    "id": active_id,
                    "result": "(interrupted)",
                },
            )
            active = None
            active_id = None
    except BaseException as error:
        containment_error: ProtocolError | None = None
        if active is not None:
            settled = await _cancel_active_tool(active)
            active = None
            active_id = None
            if isinstance(settled, ProtocolError):
                containment_error = settled
        terminal_error = (
            containment_error if containment_error is not None else error
        )
        if isinstance(terminal_error, ProtocolError):
            try:
                await write_frame(
                    writer,
                    {
                        "schema": FRAME_SCHEMA,
                        "type": "error",
                        "id": None,
                        "code": terminal_error.code,
                        "message": str(terminal_error),
                    },
                )
            except Exception as transport_error:  # noqa: BLE001 - transport may already be closed
                del transport_error
        if containment_error is not None and containment_error is not error:
            raise containment_error from error
        raise
    finally:
        if read_task is not None:
            read_task.cancel()
            await asyncio.gather(read_task, return_exceptions=True)
