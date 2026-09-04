from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, ClassVar

from evals.harbor.remote_tools import RemoteToolDispatcher, serve_protocol


PROGRAMBENCH_VERSION = "1.2.4"
IMAGE_TAG = "task_cleanroom_v6"
EXECUTION_IDENTITY = "programbench-docker-environment"
WORKSPACE = "/workspace"
HOST_SESSION_SECONDS = 29 * 60
OUTER_SESSION_SECONDS = 30 * 60
HEARTBEAT_SECONDS = 30
_INSTANCE_ID = re.compile(
    r"^[a-z0-9][a-z0-9._-]{0,127}__[a-z0-9][a-z0-9._-]{0,127}\.[a-f0-9]{7}$"
)
_CONTAINER_ID = re.compile(r"^[a-f0-9]{64}$")
_RUN_ID = re.compile(r"^[a-f0-9]{32}$")


@dataclass(frozen=True)
class CommandResult:
    return_code: int
    stdout: str
    stderr: str


class _NetworkMode:
    value = "no-network"


class _NetworkPolicy:
    network_mode = _NetworkMode()
    allowed_hosts: ClassVar[list[str]] = []


def official_instruction() -> str:
    return """This is a ProgramBench reverse-engineering task. Rebuild the documented program as a new original codebase.

The reference program is ./executable. Learn its behavior only by invoking its normal CLI or interactive interface and by reading documentation already present in the workspace.

Rules:
- Do not use the internet, package registries, external source, mirrors, cached source, or an installed copy of the project.
- Do not wrap, copy, call, ship, or otherwise depend on the reference executable in the submitted implementation.
- Do not decompile or inspect the reference binary with disassemblers, tracing, instrumentation, object-analysis, or similar binary-analysis tools. You may analyze binaries that you compile yourself.
- Probe the reference extensively with representative, boundary, invalid, and interactive inputs, then compare those observations with your own implementation.

Create all source needed for a clean rebuild. Add an executable ./compile.sh that uses only dependencies available in the cleanroom and produces ./executable in the workspace root. Keep generated executables and other build artifacts out of git through .gitignore. Run compile.sh and behavioral checks before finishing, and commit the source changes."""


def validate_instance_id(value: str) -> str:
    normalized = value.strip().lower()
    if not _INSTANCE_ID.fullmatch(normalized):
        raise ValueError("ProgramBench task id is invalid")
    return normalized


def official_image(instance_id: str) -> str:
    task = validate_instance_id(instance_id)
    return f"programbench/{task.replace('__', '_1776_')}:{IMAGE_TAG}"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def docker_run_arguments(
    docker: str,
    image: str,
    name: str,
    *,
    run_id: str,
    cpus: int = 20,
    memory: str = "60g",
) -> list[str]:
    if not Path(docker).is_absolute() or not re.fullmatch(r"neko-programbench-[a-f0-9]{12}", name):
        raise ValueError("ProgramBench Docker launch identity is invalid")
    if not re.fullmatch(r"programbench/[a-z0-9._-]+:task_cleanroom_v6", image):
        raise ValueError("ProgramBench Docker image is invalid")
    if not _RUN_ID.fullmatch(run_id):
        raise ValueError("ProgramBench Docker run id is invalid")
    if cpus < 1 or cpus > 256 or not re.fullmatch(r"[1-9][0-9]*[gG]", memory):
        raise ValueError("ProgramBench Docker resource bound is invalid")
    return [
        docker,
        "run",
        "-d",
        "--rm",
        "--init",
        "--name",
        name,
        "--label",
        f"dev.neko.programbench.run={run_id}",
        "--workdir",
        WORKSPACE,
        "--network",
        "none",
        "--cpus",
        str(cpus),
        "--memory",
        memory.lower(),
        "--memory-swap",
        memory.lower(),
        "--user",
        "agent",
        "--cap-drop",
        "SYS_PTRACE",
        "--env",
        "PAGER=cat",
        "--env",
        "MANPAGER=cat",
        "--env",
        "LESS=-R",
        "--env",
        "PIP_PROGRESS_BAR=off",
        "--env",
        "TQDM_DISABLE=1",
        image,
        "sleep",
        "7h",
    ]


def docker_capacity(docker: str) -> tuple[int, str]:
    result = None
    timeout_error = None
    for attempt in range(2):
        try:
            result = subprocess.run(
                [docker, "info", "--format", "{{.NCPU}} {{.MemTotal}}"],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            match = re.fullmatch(r"\s*([1-9][0-9]*)\s+([1-9][0-9]*)\s*", result.stdout)
            if result.returncode == 0 and match is not None:
                break
        except subprocess.TimeoutExpired as error:
            timeout_error = error
        if attempt == 0:
            time.sleep(1)
    else:
        detail = "timed out" if timeout_error is not None else "returned invalid output"
        raise RuntimeError(f"Docker capacity could not be measured: {detail}")
    available_cpus = int(match.group(1))
    available_bytes = int(match.group(2))
    cpus = min(20, available_cpus)
    memory_gib = max(1, min(60, int((available_bytes * 0.9) // (1024**3))))
    return cpus, f"{memory_gib}g"


class DockerEnvironment:
    execution_identity = EXECUTION_IDENTITY
    default_user: str | int | None = "agent"
    network_policy = _NetworkPolicy()

    def __init__(
        self,
        docker: str,
        image: str,
        *,
        cpus: int,
        memory: str,
        run_id: str,
    ) -> None:
        self.docker = str(Path(docker).resolve())
        self.image = image
        self.cpus = cpus
        self.memory = memory
        self.run_id = run_id
        self.name = f"neko-programbench-{uuid.uuid4().hex[:12]}"
        self.container_id = ""
        self.destroyed = False

    def start(self) -> None:
        result = subprocess.run(
            docker_run_arguments(
                self.docker,
                self.image,
                self.name,
                run_id=self.run_id,
                cpus=self.cpus,
                memory=self.memory,
            ),
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
        container_id = result.stdout.strip().lower()
        if result.returncode != 0 or not _CONTAINER_ID.fullmatch(container_id):
            detail = (result.stderr or result.stdout).strip().replace("\x00", "")[:500]
            raise RuntimeError(
                f"ProgramBench cleanroom failed to start{': ' + detail if detail else ''}"
            )
        self.container_id = container_id

    def _container(self) -> str:
        if self.destroyed or not _CONTAINER_ID.fullmatch(self.container_id):
            raise RuntimeError("ProgramBench cleanroom is unavailable")
        return self.container_id

    async def _run(
        self,
        args: list[str],
        *,
        timeout_sec: int,
    ) -> CommandResult:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=float(timeout_sec)
            )
        except BaseException:
            if process.returncode is None:
                process.kill()
                await process.communicate()
            raise
        return CommandResult(
            return_code=int(process.returncode or 0),
            stdout=stdout.decode("utf-8", errors="replace"),
            stderr=stderr.decode("utf-8", errors="replace"),
        )

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> CommandResult:
        if not isinstance(command, str) or not command or "\x00" in command:
            raise ValueError("ProgramBench command is invalid")
        workdir = cwd or WORKSPACE
        if (
            not workdir.startswith("/")
            or str(PurePosixPath(workdir)) != workdir
            or "\x00" in workdir
        ):
            raise ValueError("ProgramBench workdir is invalid")
        if env:
            raise ValueError("ProgramBench task commands cannot receive host environment values")
        if user not in (None, "agent", 1000):
            raise ValueError("ProgramBench task command user is invalid")
        deadline = 180 if timeout_sec is None else int(timeout_sec)
        if deadline < 1 or deadline > 600:
            raise ValueError("ProgramBench command timeout is invalid")
        return await self._run(
            [
                self.docker,
                "exec",
                "--user",
                "agent",
                "--workdir",
                workdir,
                self._container(),
                "/bin/sh",
                "-lc",
                command,
            ],
            timeout_sec=deadline,
        )

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        source = Path(source_path).resolve(strict=True)
        if not source.is_file() or not target_path.startswith("/") or "\x00" in target_path:
            raise ValueError("ProgramBench upload is invalid")
        result = await self._run(
            [self.docker, "cp", str(source), f"{self._container()}:{target_path}"],
            timeout_sec=300,
        )
        if result.return_code != 0:
            raise RuntimeError("ProgramBench upload failed")

    async def download_file(self, source_path: str, target_path: Path | str) -> None:
        target = Path(target_path).resolve()
        if not source_path.startswith("/") or "\x00" in source_path or target.exists():
            raise ValueError("ProgramBench download is invalid")
        target.parent.mkdir(parents=True, exist_ok=True)
        result = await self._run(
            [self.docker, "cp", f"{self._container()}:{source_path}", str(target)],
            timeout_sec=300,
        )
        if result.return_code != 0:
            raise RuntimeError("ProgramBench download failed")

    async def stop(self, delete: bool = True) -> None:
        if self.destroyed:
            return
        container = self.container_id
        self.destroyed = True
        self.container_id = ""
        if not _CONTAINER_ID.fullmatch(container):
            return
        action = [self.docker, "rm", "-f", container] if delete else [self.docker, "stop", container]
        try:
            await self._run(action, timeout_sec=30)
        except Exception:
            return


def _runner_environment(
    home: Path,
    deadline_at_ms: int,
    max_steps: int,
    implementation_round_steps: int,
    effort: str,
    completion_mode: str,
    call_budget: int,
    trajectory_path: Path,
) -> dict[str, str]:
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
    env.update(
        {
            "HOME": str(home),
            "USERPROFILE": str(home),
            "APPDATA": str(home / "AppData" / "Roaming"),
            "LOCALAPPDATA": str(home / "AppData" / "Local"),
            "TEMP": str(home / "tmp"),
            "TMP": str(home / "tmp"),
            "NEKO_HARBOR_HOST_MODE": "1",
            "NEKO_HARBOR_SESSION_DEADLINE_AT_MS": str(deadline_at_ms),
            "NEKO_AUTO_UPDATE": "0",
            "NEKO_AUTO_UPDATE_CHECK": "0",
            "NEKO_REASONING_EFFORT": effort,
            "NEKO_MAX_STEPS": str(max_steps),
            "NEKO_HARBOR_IMPLEMENTATION_ROUND_STEPS": str(implementation_round_steps),
            "NEKO_ADAPTIVE_EFFORT": "0",
            "NEKO_HARBOR_LOOP": "0" if completion_mode == "single" else "1",
            "NEKO_HARBOR_COMPLETION_MODE": completion_mode,
            "NEKO_HARBOR_PROVIDER_CALL_BUDGET": str(call_budget),
            "NEKO_HARBOR_TRAJECTORY_PATH": str(trajectory_path),
        }
    )
    return env


async def _discard_stderr(stream: asyncio.StreamReader) -> int:
    count = 0
    while True:
        chunk = await stream.read(64 * 1024)
        if not chunk:
            return count
        count += len(chunk)


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    else:
        process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except asyncio.TimeoutError:
        if process.returncode is None:
            process.kill()
        await process.wait()


def heartbeat_line(elapsed_seconds: int, checkpoint: dict[str, Any] | None) -> str:
    remaining = max(0, HOST_SESSION_SECONDS - elapsed_seconds)
    if checkpoint is None:
        return (
            f"programbench heartbeat: elapsed={elapsed_seconds}s remaining={remaining}s "
            "phase=starting"
        )
    tools = checkpoint["toolCalls"]
    line = (
        f"programbench heartbeat: elapsed={elapsed_seconds}s "
        f"remaining={remaining}s "
        f"provider_calls={checkpoint['providerCompleteCalls']} "
        f"tools={tools['completed']}/{tools['requested']}"
    )
    progress = checkpoint.get("progress")
    if progress is None:
        return line
    return (
        f"{line} phase={progress['phase']} "
        f"tool={progress['lastToolCategory']}/{progress['toolState']} "
        f"artifacts={progress['artifactCheckpoints']} "
        f"epoch={progress['mutationEpoch']} "
        f"validation={progress['validationState']}"
    )


async def run_host(
    runner: Path,
    home: Path,
    dispatcher: RemoteToolDispatcher,
    *,
    max_steps: int,
    implementation_round_steps: int,
    effort: str,
    completion_mode: str,
    call_budget: int,
) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any]]:
    deadline = int(time.time() * 1000) + HOST_SESSION_SECONDS * 1000
    trajectory_path = home / "programbench-agent-trajectory.json"
    if trajectory_path.exists():
        raise RuntimeError("ProgramBench audit trajectory already exists")
    process = await asyncio.create_subprocess_exec(
        str(runner),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(home),
        env=_runner_environment(
            home,
            deadline,
            max_steps,
            implementation_round_steps,
            effort,
            completion_mode,
            call_budget,
            trajectory_path,
        ),
        start_new_session=os.name == "posix",
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )
    if process.stdin is None or process.stdout is None or process.stderr is None:
        await _stop_process(process)
        raise RuntimeError("ProgramBench host runner has no protocol pipes")
    stderr_task = asyncio.create_task(_discard_stderr(process.stderr))
    latest_checkpoint: dict[str, Any] | None = None
    heartbeat_started = time.monotonic()

    async def heartbeat() -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            elapsed = max(0, int(time.monotonic() - heartbeat_started))
            print(heartbeat_line(elapsed, latest_checkpoint), flush=True)

    heartbeat_task = asyncio.create_task(heartbeat())

    def remember(value: dict[str, Any]) -> None:
        nonlocal latest_checkpoint
        latest_checkpoint = value

    try:
        metrics = await asyncio.wait_for(
            serve_protocol(
                process.stdout,
                process.stdin,
                dispatcher,
                official_instruction(),
                remember,
            ),
            timeout=OUTER_SESSION_SECONDS,
        )
        process.stdin.close()
        await process.stdin.wait_closed()
        code = await asyncio.wait_for(process.wait(), timeout=10)
        if code != 0:
            raise RuntimeError("ProgramBench host runner exited unsuccessfully")
        if not trajectory_path.is_file() or trajectory_path.stat().st_size > 128 * 1024 * 1024:
            raise RuntimeError("ProgramBench audit trajectory is missing or oversized")
        trajectory = validate_audit_trajectory(
            json.loads(trajectory_path.read_text(encoding="utf-8")),
            metrics,
        )
        return metrics, latest_checkpoint, trajectory
    finally:
        if not process.stdin.is_closing():
            process.stdin.close()
        await _stop_process(process)
        heartbeat_task.cancel()
        await asyncio.gather(stderr_task, heartbeat_task, return_exceptions=True)
        trajectory_path.unlink(missing_ok=True)


def validate_audit_trajectory(value: Any, metrics: dict[str, Any]) -> dict[str, Any]:
    expected = {
        "schemaVersion",
        "profile",
        "provider",
        "model",
        "reasoningEffort",
        "metrics",
        "messages",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError("ProgramBench audit trajectory is invalid")
    if value.get("schemaVersion") != "neko.harbor.audit-trajectory.v1" or value.get("metrics") != metrics:
        raise ValueError("ProgramBench audit trajectory is invalid")
    for key in ("profile", "provider", "model", "reasoningEffort"):
        if not isinstance(value.get(key), str) or not value[key] or len(value[key]) > 256:
            raise ValueError("ProgramBench audit trajectory is invalid")
    if not isinstance(value.get("messages"), list) or len(value["messages"]) > 10000:
        raise ValueError("ProgramBench audit trajectory is invalid")
    return value


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runner", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-steps", required=True, type=int)
    parser.add_argument("--round-steps", required=True, type=int)
    parser.add_argument("--effort", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--loop", dest="completion_mode", action="store_const", const="self-review")
    mode.add_argument("--no-loop", dest="completion_mode", action="store_const", const="single")
    mode.add_argument("--contract", dest="completion_mode", action="store_const", const="contract")
    parser.add_argument("--call-budget", required=True, type=int)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-dirty", action="store_true")
    parser.add_argument("--profile", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--host-runner-sha256", required=True)
    parser.add_argument("--launcher-sha256", required=True)
    parser.add_argument("--environment-runner-sha256", required=True)
    parser.add_argument("--remote-tools-sha256", required=True)
    parser.add_argument("--run-id", required=True)
    return parser.parse_args(argv)


async def main_async(args: argparse.Namespace) -> int:
    from programbench.utils.load_data import load_all_instances

    task = validate_instance_id(args.task)
    if args.max_steps < 1 or args.max_steps > 1000:
        raise ValueError("ProgramBench max steps must be from 1 to 1000")
    if args.round_steps < 1 or args.round_steps > args.max_steps:
        raise ValueError("ProgramBench implementation round steps must be from 1 to max steps")
    if args.call_budget < 1 or args.call_budget > 10000:
        raise ValueError("ProgramBench call budget must be from 1 to 10000")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", args.effort):
        raise ValueError("ProgramBench effort is invalid")
    if not re.fullmatch(r"[a-fA-F0-9]{40,64}", args.source_revision):
        raise ValueError("ProgramBench source revision is invalid")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", args.profile):
        raise ValueError("ProgramBench profile is invalid")
    if not isinstance(args.model, str) or not args.model.strip() or len(args.model) > 256 or any(
        ord(char) < 32 or ord(char) == 127 for char in args.model
    ):
        raise ValueError("ProgramBench model is invalid")
    provenance_hashes = {
        "hostRunnerSha256": args.host_runner_sha256,
        "launcherSha256": args.launcher_sha256,
        "environmentRunnerSha256": args.environment_runner_sha256,
        "remoteToolsSha256": args.remote_tools_sha256,
    }
    if any(not re.fullmatch(r"[a-fA-F0-9]{64}", value) for value in provenance_hashes.values()):
        raise ValueError("ProgramBench implementation SHA-256 is invalid")
    if not _RUN_ID.fullmatch(args.run_id):
        raise ValueError("ProgramBench run id is invalid")
    runner = Path(args.runner).resolve(strict=True)
    if not runner.is_file():
        raise ValueError("ProgramBench host runner is invalid")
    runner_home_raw = os.environ.get("NEKO_HARBOR_RUNNER_HOME", "")
    if not runner_home_raw:
        raise ValueError("ProgramBench runner home is missing")
    runner_home = Path(runner_home_raw).resolve(strict=True)
    if not runner_home.is_dir() or not (runner_home / ".neko-core" / "config.json").is_file():
        raise ValueError("ProgramBench runner home is invalid")
    instances = {entry["instance_id"]: entry for entry in load_all_instances(include_tests=False)}
    instance = instances.get(task)
    if instance is None:
        raise ValueError("ProgramBench task is not in the pinned dataset")
    image = f"{instance['image_name']}:{IMAGE_TAG}"
    if image != official_image(task):
        raise ValueError("ProgramBench image mapping does not match the pinned dataset")
    docker_name = "docker.exe" if os.name == "nt" else "docker"
    docker = shutil.which(docker_name)
    if not docker:
        raise RuntimeError("Docker is unavailable")
    output = Path(args.output).resolve()
    instance_dir = output / task
    if instance_dir.exists():
        raise FileExistsError("ProgramBench output for this task already exists")
    instance_dir.mkdir(parents=True)
    trajectory_path = instance_dir / f"{task}.traj.json"
    submission_path = instance_dir / "submission.tar.gz"
    cpus, memory = docker_capacity(docker)
    environment = DockerEnvironment(
        docker,
        image,
        cpus=cpus,
        memory=memory,
        run_id=args.run_id,
    )
    dispatcher: RemoteToolDispatcher | None = None
    started_at = int(time.time() * 1000)
    metrics: dict[str, Any] | None = None
    checkpoint: dict[str, Any] | None = None
    agent_trajectory: dict[str, Any] | None = None
    artifact: dict[str, Any] | None = None
    exit_status = "infrastructure_error"
    try:
        print(f"cleanroom resources: cpus={cpus}, memory={memory}, network=none")
        environment.start()
        git_identity = await environment.exec(
            'git config user.name "Neko Core" && git config user.email "programbench@neko.local"',
            timeout_sec=30,
            user="agent",
        )
        if git_identity.return_code != 0:
            raise RuntimeError("ProgramBench git identity setup failed")
        dispatcher = await RemoteToolDispatcher.create(environment)
        metrics, checkpoint, agent_trajectory = await run_host(
            runner,
            runner_home,
            dispatcher,
            max_steps=args.max_steps,
            implementation_round_steps=args.round_steps,
            effort=args.effort,
            completion_mode=args.completion_mode,
            call_budget=args.call_budget,
        )
        archive_remote = f"/tmp/neko-programbench-submission-{uuid.uuid4().hex}.tar.gz"
        archived = await environment.exec(
            f"tar -czf {archive_remote} -C {WORKSPACE} .",
            cwd=WORKSPACE,
            timeout_sec=300,
            user="agent",
        )
        if archived.return_code != 0:
            exit_status = "artifact_missing"
            return 2
        await environment.download_file(archive_remote, submission_path)
        artifact = {
            "path": "submission.tar.gz",
            "bytes": submission_path.stat().st_size,
            "sha256": file_sha256(submission_path),
        }
        exit_status = "completed"
        return 0
    finally:
        teardown_error: BaseException | None = None
        if dispatcher is not None:
            try:
                await dispatcher.close()
            except BaseException as error:
                teardown_error = error
        try:
            await environment.stop(delete=True)
        except BaseException as error:
            if teardown_error is None:
                teardown_error = error
        trajectory = {
            "schemaVersion": "neko.programbench.trajectory.v2",
            "programbenchVersion": PROGRAMBENCH_VERSION,
            "instanceId": task,
            "image": image,
            "imageTag": IMAGE_TAG,
            "execution": EXECUTION_IDENTITY,
            "networkMode": "no-network",
            "resources": {"cpus": cpus, "memory": memory},
            "sourceRevision": args.source_revision.lower(),
            "sourceDirty": bool(args.source_dirty),
            "profile": args.profile,
            "model": args.model,
            "implementation": {
                name: value.lower() for name, value in provenance_hashes.items()
            },
            "maxSteps": args.max_steps,
            "implementationRoundSteps": args.round_steps,
            "completionMode": args.completion_mode,
            "providerCallBudget": args.call_budget,
            "providerCallBudgetExhausted": metrics is not None
            and metrics.get("completionStatus") == "call_budget_exhausted",
            "timeBudgetExhausted": metrics is not None
            and metrics.get("completionStatus") == "time_budget_exhausted",
            "startedAt": started_at,
            "finishedAt": int(time.time() * 1000),
            "exitStatus": exit_status,
            "metrics": metrics,
            "lastCheckpoint": checkpoint,
            "agentTrajectory": agent_trajectory,
            "artifact": artifact,
            "leaderboardTrajectoryComplete": agent_trajectory is not None,
        }
        trajectory_path.write_text(
            json.dumps(trajectory, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        if teardown_error is not None:
            raise teardown_error


def main() -> int:
    return asyncio.run(main_async(parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
