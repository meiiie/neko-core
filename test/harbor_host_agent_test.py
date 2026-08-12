from __future__ import annotations

import asyncio
import ctypes
import hashlib
import inspect
import json
import logging
import os
import shutil
import sys
import tempfile
import time
import unittest
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar, cast
from unittest.mock import patch

from harbor.environments.base import BaseEnvironment
from harbor.environments.docker.compose_env import merge_compose_env
from harbor.models.agent.context import AgentContext
from harbor.trial.trial import Trial
from harbor.utils.env import resolve_env_vars

from evals.harbor.neko_host_agent import (
    _HARBOR_OUTER_AGENT_TIMEOUT_SECONDS,
    _HOST_RUNNER_CLEANUP_RESERVE_SECONDS,
    _HOST_RUNNER_DEADLINE_SECONDS,
    NekoHostAgent,
    _WindowsKillJob,
)
from evals.harbor.remote_tools import (
    TASK_COMMAND_NAMES,
    ProtocolError,
    RemoteToolDispatcher,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def command_profile_output() -> str:
    names = TASK_COMMAND_NAMES + ("rg",)
    bindings = "".join(
        f"BIND\t{name}\t/usr/bin/{name}\t/usr/bin/{name}\t1:1:1:1:1\n" for name in names
    )
    return f"OK\n/usr/bin:/bin\nrg\n/usr/bin/rg\n{bindings}"


FINAL_METRICS: dict[str, Any] = {
    "completionStatus": "ok",
    "usageComplete": True,
    "providerCompleteCalls": 2,
    "providerReportedModelCalls": 2,
    "inputTokens": 100,
    "outputTokens": 20,
    "cachedTokens": 40,
    "totalTokens": 120,
    "wallTimeMs": 250,
    "hitMaxSteps": False,
    "toolCalls": {
        "requested": 1,
        "completed": 1,
        "productive": 1,
        "empty": 0,
        "failed": 0,
    },
}

PARTIAL_METRICS: dict[str, Any] = {
    "providerCompleteCalls": 2,
    "providerUsageObservedCalls": 2,
    "providerReportedModelCalls": 2,
    "inputTokens": 100,
    "outputTokens": 20,
    "cachedTokens": 40,
    "totalTokens": 120,
    "wallTimeMs": 249,
    "hitMaxSteps": False,
    "toolCalls": {
        "requested": 1,
        "completed": 1,
        "productive": 1,
        "empty": 0,
        "failed": 0,
    },
}


class FakeDispatcher:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


@dataclass
class EnvironmentResult:
    return_code: int = 0
    stdout: str | None = ""
    stderr: str | None = ""


class PublicMode:
    value = "public"


class PublicPolicy:
    network_mode = PublicMode()
    allowed_hosts: ClassVar[list[str]] = []


class SetupEnvironment:
    default_user: str | int | None = "agent"
    network_policy = PublicPolicy()

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> EnvironmentResult:
        self.calls.append(
            {
                "command": command,
                "cwd": cwd,
                "env": env,
                "timeout_sec": timeout_sec,
                "user": user,
            }
        )
        body = (
            command.split(": neko-command-profile-bound; ", 1)[-1]
            if command.startswith("PATH=")
            else command
        )
        if body == "pwd -P":
            return EnvironmentResult(stdout="/workspace\n")
        if "for command_name in sh realpath" in body:
            return EnvironmentResult(stdout=command_profile_output())
        if body.startswith("read -r self_line < /proc/self/stat"):
            return EnvironmentResult(stdout="SNAP\n")
        if "remaining=$(count=0" in body and "QUIESCENT" in body:
            return EnvironmentResult(stdout="QUIESCENT\n")
        return EnvironmentResult()

    async def upload_file(self, _source: Path | str, _target: str) -> None:
        return None

    async def download_file(self, _source: str, _target: Path | str) -> None:
        return None


class FakeReader:
    async def read(self, _size: int) -> bytes:
        return b""


class NeverEndingReader:
    def __init__(self) -> None:
        self.cancelled = False

    async def read(self, _size: int) -> bytes:
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return b""


class ExplodingReader:
    async def read(self, _size: int) -> bytes:
        raise RuntimeError("fixture stderr read failed")


class FakeWriter:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True

    def is_closing(self) -> bool:
        return self.closed

    async def wait_closed(self) -> None:
        return None


class FakeProcess:
    def __init__(self, exit_code: int = 0) -> None:
        self.pid = 4242
        self.stdin = FakeWriter()
        self.stdout = FakeReader()
        self.stderr = FakeReader()
        self.returncode: int | None = None
        self.exit_code = exit_code

    async def wait(self) -> int:
        self.returncode = self.exit_code
        return self.exit_code

    def kill(self) -> None:
        self.returncode = -1


class FakeWindowsJob:
    async def terminate(self, process: FakeProcess) -> None:
        await process.wait()


class HostRunnerLaunchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.previous_runner_home = os.environ.get("NEKO_HARBOR_RUNNER_HOME")
        self.previous_pythonpath = os.environ.get("PYTHONPATH")
        self.temp = tempfile.TemporaryDirectory(prefix="neko-host-agent-test-")
        self.temp_path = Path(self.temp.name)
        source_root = Path(__file__).resolve().parents[1]
        self.control_files = {
            "runner_source_sha256": source_root / "evals" / "harbor" / "host_runner.ts",
            "launcher_source_sha256": source_root / "scripts" / "harbor-eval.ts",
            "host_agent_sha256": source_root
            / "evals"
            / "harbor"
            / "neko_host_agent.py",
            "remote_tools_sha256": source_root / "evals" / "harbor" / "remote_tools.py",
        }
        source_executable = (
            Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"
            if os.name == "nt"
            else Path("/bin/sh")
        )
        suffix = ".exe" if os.name == "nt" else ""
        self.runner = self.temp_path / f"neko-harbor-host{suffix}"
        shutil.copy2(source_executable, self.runner)
        self.codex = self.temp_path / f"codex-app-server{suffix}"
        shutil.copy2(source_executable, self.codex)
        self.codex_sha256 = sha256(self.codex)
        self.lease_expires_at = int((time.time() + 2 * 60 * 60) * 1000)
        self.runner_home = self.temp_path / "runner-home"
        auth_dir = self.runner_home / ".neko-core"
        auth_dir.mkdir(parents=True)
        (self.runner_home / "tmp").mkdir()
        (self.runner_home / "AppData" / "Roaming").mkdir(parents=True)
        (self.runner_home / "AppData" / "Local").mkdir(parents=True)
        (auth_dir / "chatgpt-auth.json").write_text(
            json.dumps(
                {
                    "accessToken": "fixture-access-token",
                    "refreshToken": "",
                    "expiresAt": self.lease_expires_at,
                    "accountId": "fixture-account",
                }
            ),
            encoding="utf-8",
        )
        (self.runner_home / ".neko-harbor-host-grant.json").write_text(
            json.dumps(
                {
                    "schema": "neko.harbor-host-grant.v1",
                    "profile": "chatgpt",
                    "codexPath": str(self.codex.resolve()),
                    "codexSha256": self.codex_sha256,
                    "expiresAt": self.lease_expires_at,
                }
            ),
            encoding="utf-8",
        )
        os.environ["NEKO_HARBOR_RUNNER_HOME"] = str(self.runner_home.resolve())
        self.logs = self.temp_path / "logs"

    def tearDown(self) -> None:
        self.temp.cleanup()
        if self.previous_runner_home is None:
            os.environ.pop("NEKO_HARBOR_RUNNER_HOME", None)
        else:
            os.environ["NEKO_HARBOR_RUNNER_HOME"] = self.previous_runner_home
        if self.previous_pythonpath is None:
            os.environ.pop("PYTHONPATH", None)
        else:
            os.environ["PYTHONPATH"] = self.previous_pythonpath

    def make_agent(self, **overrides: Any) -> NekoHostAgent:
        kwargs: dict[str, Any] = {
            "logs_dir": self.logs,
            "model_name": "openai/fixture-model",
            "runner_path": str(self.runner.resolve()),
            "runner_sha256": sha256(self.runner),
            "profile": "chatgpt",
            "codex_sha256": self.codex_sha256,
            "source_revision": "fixture-revision",
            "source_dirty": False,
            "build_bun_version": "fixture-bun",
            "dataset_request": "fixture@sha256:abc",
            **{name: sha256(path) for name, path in self.control_files.items()},
        }
        kwargs.update(overrides)
        return NekoHostAgent(**kwargs)

    def test_digest_mismatch_is_rejected_before_launch(self) -> None:
        with self.assertRaisesRegex(ValueError, "digest does not match"):
            NekoHostAgent._verified_host_file(
                str(self.runner.resolve()), "0" * 64, "runner"
            )

    def test_host_runner_deadline_reserves_outer_cleanup_window(self) -> None:
        self.assertEqual(_HARBOR_OUTER_AGENT_TIMEOUT_SECONDS, 1800)
        self.assertEqual(_HOST_RUNNER_CLEANUP_RESERVE_SECONDS, 60)
        self.assertEqual(_HOST_RUNNER_DEADLINE_SECONDS, 1740)
        self.assertEqual(
            _HOST_RUNNER_DEADLINE_SECONDS
            + _HOST_RUNNER_CLEANUP_RESERVE_SECONDS,
            _HARBOR_OUTER_AGENT_TIMEOUT_SECONDS,
        )

    def test_harbor_agent_environment_injection_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "refuses Harbor agent env injection"):
            NekoHostAgent(
                logs_dir=self.logs,
                extra_env={"NEKO_API_KEY": "must-not-cross"},
            )

    def test_claims_private_locator_before_harbor_environment_resolution(self) -> None:
        os.environ["PYTHONPATH"] = str(self.temp_path / "private-bridge")
        self.assertIn("NEKO_HARBOR_RUNNER_HOME", os.environ)
        self.make_agent()
        self.assertNotIn("NEKO_HARBOR_RUNNER_HOME", os.environ)
        self.assertNotIn("PYTHONPATH", os.environ)
        compose_env = merge_compose_env(
            base_env=os.environ,
            user_env={},
            infra_env={},
            logger=logging.getLogger("harbor-pop-order-test"),
        )
        self.assertNotIn("NEKO_HARBOR_RUNNER_HOME", compose_env)
        self.assertNotIn("PYTHONPATH", compose_env)
        self.assertEqual(
            resolve_env_vars({"probe": "${NEKO_HARBOR_RUNNER_HOME:-absent}"})["probe"],
            "absent",
        )
        trial_init = inspect.getsource(Trial.__init__)
        self.assertLess(
            trial_init.index("self._init_agent()"),
            trial_init.index("self._init_agent_environment()"),
        )
        # A Harbor worker may construct several trials after the one-shot env value is gone.
        self.assertEqual(self.make_agent().runner_home, self.runner_home.resolve())

    def test_runner_grant_rejects_extra_fields_refresh_capability_and_config(self) -> None:
        manifest_path = self.runner_home / ".neko-harbor-host-grant.json"
        auth_path = self.runner_home / ".neko-core" / "chatgpt-auth.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        credentials = json.loads(auth_path.read_text(encoding="utf-8"))

        manifest_path.write_text(
            json.dumps({**manifest, "unexpected": "authority"}), encoding="utf-8"
        )
        with self.assertRaisesRegex(ValueError, "invalid schema"):
            self.make_agent()
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        auth_path.write_text(
            json.dumps({**credentials, "refreshToken": "must-not-cross"}),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "bounded ChatGPT lease"):
            self.make_agent()
        auth_path.write_text(json.dumps(credentials), encoding="utf-8")

        config_path = self.runner_home / ".neko-core" / "config.json"
        config_path.write_text('{"api_key":"must-not-load"}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "must not contain user configuration"):
            self.make_agent()
        config_path.unlink()

    async def test_stale_lease_fails_before_host_runner_spawn(self) -> None:
        manifest_path = self.runner_home / ".neko-harbor-host-grant.json"
        auth_path = self.runner_home / ".neko-core" / "chatgpt-auth.json"
        expires_at = int((time.time() + 34 * 60) * 1000)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        credentials = json.loads(auth_path.read_text(encoding="utf-8"))
        manifest["expiresAt"] = expires_at
        credentials["expiresAt"] = expires_at
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        auth_path.write_text(json.dumps(credentials), encoding="utf-8")
        agent = self.make_agent()
        dispatcher = FakeDispatcher()
        agent._dispatcher = cast(RemoteToolDispatcher, dispatcher)
        with self.assertRaisesRegex(RuntimeError, "cannot cover"):
            await agent.run(
                "must not spawn",
                cast(BaseEnvironment, object()),
                cast(AgentContext, object()),
            )
        self.assertTrue(dispatcher.closed)

    def test_unknown_claim_identity_is_rejected(self) -> None:
        for field in ("source_revision", "build_bun_version", "dataset_request"):
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(ValueError, "must identify"),
            ):
                self.make_agent(**{field: "unknown"})

    async def test_setup_records_bounded_identity_without_host_secrets(self) -> None:
        secret = "host-only-sentinel-773a"
        os.environ["NEKO_TEST_HOST_SENTINEL"] = secret
        agent = self.make_agent()
        environment = SetupEnvironment()
        try:
            await agent.setup(cast(BaseEnvironment, environment))
            identity_path = self.logs / "neko-host-eval-identity.json"
            serialized = identity_path.read_text(encoding="utf-8")
            identity = json.loads(serialized)
            self.assertEqual(identity["runner_artifact"], self.runner.name)
            self.assertEqual(identity["harbor_version"], "0.20.0")
            self.assertEqual(identity["source_revision"], "fixture-revision")
            self.assertEqual(identity["dataset_request"], "fixture@sha256:abc")
            self.assertEqual(
                identity["task_command_profile"],
                "gnu-coreutils-findutils-proc-v1",
            )
            self.assertFalse(identity["oauth_inside_task_container"])
            self.assertNotIn(secret, serialized)
            self.assertNotIn(str(self.runner.parent), serialized)
            self.assertNotIn(str(self.runner_home), serialized)
            self.assertNotIn(str(self.codex), serialized)
            self.assertTrue(all(call["env"] is None for call in environment.calls))
        finally:
            await agent._close_dispatcher()
            os.environ.pop("NEKO_TEST_HOST_SENTINEL", None)

    async def test_launch_is_direct_isolated_and_exports_only_host_expectations(
        self,
    ) -> None:
        instruction_secret = "instruction-must-not-enter-audit-41f9"
        agent = self.make_agent()
        dispatcher = FakeDispatcher()
        agent._dispatcher = cast(RemoteToolDispatcher, dispatcher)
        self.logs.mkdir(parents=True)
        captured: dict[str, Any] = {}
        process = FakeProcess()
        spawn_epoch_seconds = time.time()

        async def fake_create(*argv: str, **kwargs: object) -> FakeProcess:
            captured["argv"] = argv
            captured["kwargs"] = kwargs
            return process

        async def fake_protocol(*_args: object) -> dict[str, Any]:
            cast(Any, _args[4])(dict(PARTIAL_METRICS))
            return FINAL_METRICS

        patches = [
            patch(
                "evals.harbor.neko_host_agent.asyncio.create_subprocess_exec",
                fake_create,
            ),
            patch("evals.harbor.neko_host_agent.serve_protocol", fake_protocol),
            patch(
                "evals.harbor.neko_host_agent.time.time",
                return_value=spawn_epoch_seconds,
            ),
        ]
        if os.name == "nt":
            patches.append(
                patch(
                    "evals.harbor.neko_host_agent._WindowsKillJob.assign",
                    return_value=FakeWindowsJob(),
                )
            )
        for active_patch in patches:
            active_patch.start()
            self.addCleanup(active_patch.stop)

        await agent.run(
            instruction_secret,
            cast(BaseEnvironment, object()),
            cast(AgentContext, object()),
        )

        self.assertEqual(captured["argv"], (str(self.runner.resolve()),))
        kwargs = captured["kwargs"]
        self.assertIsInstance(kwargs, dict)
        launch = kwargs
        self.assertNotIn("shell", launch)
        self.assertNotEqual(Path(str(launch["cwd"])), Path.cwd())
        self.assertIn("neko-harbor-host-cwd-", str(launch["cwd"]))
        runner_env = launch["env"]
        self.assertIsInstance(runner_env, dict)
        self.assertEqual(runner_env["NEKO_EXPECTED_CODEX_SHA256"], self.codex_sha256)
        self.assertEqual(runner_env["NEKO_CODEX_PATH"], str(self.codex.resolve()))
        self.assertEqual(runner_env["HOME"], str(self.runner_home.resolve()))
        self.assertEqual(runner_env["USERPROFILE"], str(self.runner_home.resolve()))
        self.assertEqual(runner_env["NEKO_HARBOR_ACCESS_LEASE"], "1")
        session_deadline = runner_env["NEKO_HARBOR_SESSION_DEADLINE_AT_MS"]
        self.assertRegex(session_deadline, r"^[0-9]+$")
        self.assertEqual(
            session_deadline,
            str(
                int(spawn_epoch_seconds * 1000)
                + _HOST_RUNNER_DEADLINE_SECONDS * 1000
            ),
        )
        self.assertNotIn(instruction_secret, session_deadline)
        self.assertNotIn("NEKO_HARBOR_SESSION_DEADLINE_AT_MS", os.environ)
        self.assertNotIn("NEKO_HARBOR_RUNNER_HOME", runner_env)
        self.assertNotIn("NEKO_TEST_HOST_SENTINEL", runner_env)
        self.assertNotIn("NEKO_API_KEY", runner_env)
        self.assertNotIn("OPENAI_API_KEY", runner_env)
        self.assertNotIn("PYTHONPATH", runner_env)
        self.assertTrue(dispatcher.closed)
        serialized_audit = (self.logs / "neko-host-run.json").read_text()
        self.assertNotIn(instruction_secret, serialized_audit)
        audit = json.loads(serialized_audit)
        self.assertEqual(audit["schema"], "neko.harbor-host-run.v3")
        self.assertTrue(audit["completed"])
        self.assertEqual(audit["exit_code"], 0)
        self.assertEqual(audit["metrics"], FINAL_METRICS)
        self.assertIsNone(audit["partial_metrics"])

    async def test_protocol_failure_retains_only_validated_partial_metrics(self) -> None:
        agent = self.make_agent()
        dispatcher = FakeDispatcher()
        agent._dispatcher = cast(RemoteToolDispatcher, dispatcher)
        self.logs.mkdir(parents=True)
        process = FakeProcess()

        async def fake_create(*_argv: str, **_kwargs: object) -> FakeProcess:
            return process

        async def fake_protocol(*_args: object) -> dict[str, Any]:
            cast(Any, _args[4])(dict(PARTIAL_METRICS))
            raise ProtocolError("fixture-failure", "private protocol detail")

        patches = [
            patch(
                "evals.harbor.neko_host_agent.asyncio.create_subprocess_exec",
                fake_create,
            ),
            patch("evals.harbor.neko_host_agent.serve_protocol", fake_protocol),
        ]
        if os.name == "nt":
            patches.append(
                patch(
                    "evals.harbor.neko_host_agent._WindowsKillJob.assign",
                    return_value=FakeWindowsJob(),
                )
            )
        for active_patch in patches:
            active_patch.start()
            self.addCleanup(active_patch.stop)

        with self.assertRaisesRegex(RuntimeError, "fixture-failure"):
            await agent.run(
                "secret instruction",
                cast(BaseEnvironment, object()),
                cast(AgentContext, object()),
            )

        serialized = (self.logs / "neko-host-run.json").read_text()
        audit = json.loads(serialized)
        self.assertFalse(audit["completed"])
        self.assertIsNone(audit["metrics"])
        self.assertEqual(audit["partial_metrics"], PARTIAL_METRICS)
        self.assertNotIn("secret instruction", serialized)
        self.assertNotIn("private protocol detail", serialized)

    async def test_internal_deadline_cleans_up_and_writes_partial_audit(self) -> None:
        agent = self.make_agent()
        dispatcher = FakeDispatcher()
        agent._dispatcher = cast(RemoteToolDispatcher, dispatcher)
        self.logs.mkdir(parents=True)
        process = FakeProcess()
        protocol_cancelled = asyncio.Event()

        async def fake_create(*_argv: str, **_kwargs: object) -> FakeProcess:
            return process

        async def fake_protocol(*_args: object) -> dict[str, Any]:
            cast(Any, _args[4])(dict(PARTIAL_METRICS))
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                protocol_cancelled.set()
                raise
            raise AssertionError("unreachable")

        patches = [
            patch(
                "evals.harbor.neko_host_agent.asyncio.create_subprocess_exec",
                fake_create,
            ),
            patch("evals.harbor.neko_host_agent.serve_protocol", fake_protocol),
            patch(
                "evals.harbor.neko_host_agent._HOST_RUNNER_DEADLINE_SECONDS",
                0.01,
            ),
        ]
        if os.name == "nt":
            patches.append(
                patch(
                    "evals.harbor.neko_host_agent._WindowsKillJob.assign",
                    return_value=FakeWindowsJob(),
                )
            )
        for active_patch in patches:
            active_patch.start()
            self.addCleanup(active_patch.stop)

        with self.assertRaisesRegex(RuntimeError, "fixed evaluation deadline"):
            await asyncio.wait_for(
                agent.run(
                    "secret instruction",
                    cast(BaseEnvironment, object()),
                    cast(AgentContext, object()),
                ),
                timeout=1.0,
            )

        self.assertTrue(protocol_cancelled.is_set())
        self.assertTrue(dispatcher.closed)
        audit = json.loads((self.logs / "neko-host-run.json").read_text())
        self.assertFalse(audit["completed"])
        self.assertIsNone(audit["exit_code"])
        self.assertIsNone(audit["metrics"])
        self.assertEqual(audit["partial_metrics"], PARTIAL_METRICS)

    async def test_nonzero_exit_never_promotes_received_metrics(self) -> None:
        agent = self.make_agent()
        dispatcher = FakeDispatcher()
        agent._dispatcher = cast(RemoteToolDispatcher, dispatcher)
        self.logs.mkdir(parents=True)
        process = FakeProcess(exit_code=7)

        async def fake_create(*_argv: str, **_kwargs: object) -> FakeProcess:
            return process

        async def fake_protocol(*_args: object) -> dict[str, Any]:
            cast(Any, _args[4])(dict(PARTIAL_METRICS))
            return FINAL_METRICS

        patches = [
            patch(
                "evals.harbor.neko_host_agent.asyncio.create_subprocess_exec",
                fake_create,
            ),
            patch("evals.harbor.neko_host_agent.serve_protocol", fake_protocol),
        ]
        if os.name == "nt":
            patches.append(
                patch(
                    "evals.harbor.neko_host_agent._WindowsKillJob.assign",
                    return_value=FakeWindowsJob(),
                )
            )
        for active_patch in patches:
            active_patch.start()
            self.addCleanup(active_patch.stop)

        with self.assertRaisesRegex(RuntimeError, "exited unsuccessfully"):
            await agent.run(
                "fixture instruction",
                cast(BaseEnvironment, object()),
                cast(AgentContext, object()),
            )

        self.assertTrue(dispatcher.closed)
        audit = json.loads((self.logs / "neko-host-run.json").read_text())
        self.assertFalse(audit["completed"])
        self.assertEqual(audit["exit_code"], 7)
        self.assertIsNone(audit["metrics"])
        self.assertEqual(audit["partial_metrics"], PARTIAL_METRICS)

    async def test_cleanup_failure_cancels_stderr_and_discards_metrics(self) -> None:
        agent = self.make_agent()
        dispatcher = FakeDispatcher()
        agent._dispatcher = cast(RemoteToolDispatcher, dispatcher)
        self.logs.mkdir(parents=True)
        process = FakeProcess()
        stderr = NeverEndingReader()
        process.stderr = cast(FakeReader, stderr)

        async def fake_create(*_argv: str, **_kwargs: object) -> FakeProcess:
            return process

        async def fake_protocol(*_args: object) -> dict[str, Any]:
            cast(Any, _args[4])(dict(PARTIAL_METRICS))
            return FINAL_METRICS

        async def fail_process_cleanup(*_args: object) -> None:
            raise RuntimeError("process cleanup failed")

        patches = [
            patch(
                "evals.harbor.neko_host_agent.asyncio.create_subprocess_exec",
                fake_create,
            ),
            patch("evals.harbor.neko_host_agent.serve_protocol", fake_protocol),
            patch.object(agent, "_stop_host_process", fail_process_cleanup),
            patch(
                "evals.harbor.neko_host_agent._STDERR_DRAIN_TIMEOUT_SECONDS",
                0.01,
            ),
        ]
        if os.name == "nt":
            patches.append(
                patch(
                    "evals.harbor.neko_host_agent._WindowsKillJob.assign",
                    return_value=FakeWindowsJob(),
                )
            )
        for active_patch in patches:
            active_patch.start()
            self.addCleanup(active_patch.stop)

        with self.assertRaisesRegex(RuntimeError, "process cleanup failed"):
            await asyncio.wait_for(
                agent.run(
                    "fixture instruction",
                    cast(BaseEnvironment, object()),
                    cast(AgentContext, object()),
                ),
                timeout=1.0,
            )

        self.assertTrue(dispatcher.closed)
        self.assertTrue(stderr.cancelled)
        audit = json.loads((self.logs / "neko-host-run.json").read_text())
        self.assertFalse(audit["completed"])
        self.assertEqual(audit["exit_code"], 0)
        self.assertIsNone(audit["stderr_bytes_discarded"])
        self.assertIsNone(audit["metrics"])
        self.assertEqual(audit["partial_metrics"], PARTIAL_METRICS)

    async def test_stderr_drain_failure_prevents_metric_promotion(self) -> None:
        agent = self.make_agent()
        dispatcher = FakeDispatcher()
        agent._dispatcher = cast(RemoteToolDispatcher, dispatcher)
        self.logs.mkdir(parents=True)
        process = FakeProcess()
        process.stderr = cast(FakeReader, ExplodingReader())

        async def fake_create(*_argv: str, **_kwargs: object) -> FakeProcess:
            return process

        async def fake_protocol(*_args: object) -> dict[str, Any]:
            cast(Any, _args[4])(dict(PARTIAL_METRICS))
            return FINAL_METRICS

        patches = [
            patch(
                "evals.harbor.neko_host_agent.asyncio.create_subprocess_exec",
                fake_create,
            ),
            patch("evals.harbor.neko_host_agent.serve_protocol", fake_protocol),
        ]
        if os.name == "nt":
            patches.append(
                patch(
                    "evals.harbor.neko_host_agent._WindowsKillJob.assign",
                    return_value=FakeWindowsJob(),
                )
            )
        for active_patch in patches:
            active_patch.start()
            self.addCleanup(active_patch.stop)

        with self.assertRaisesRegex(RuntimeError, "stderr drain failed closed"):
            await agent.run(
                "fixture instruction",
                cast(BaseEnvironment, object()),
                cast(AgentContext, object()),
            )

        self.assertTrue(dispatcher.closed)
        audit = json.loads((self.logs / "neko-host-run.json").read_text())
        self.assertFalse(audit["completed"])
        self.assertEqual(audit["exit_code"], 0)
        self.assertIsNone(audit["stderr_bytes_discarded"])
        self.assertIsNone(audit["metrics"])
        self.assertEqual(audit["partial_metrics"], PARTIAL_METRICS)


@unittest.skipUnless(os.name == "posix", "POSIX process-group containment probe")
class PosixProcessGroupContainmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_reaped_leader_does_not_hide_live_descendant(self) -> None:
        with tempfile.TemporaryDirectory(prefix="neko-posix-group-test-") as directory:
            child_pid_file = Path(directory) / "child.pid"
            script = (
                "import os,pathlib,time; "
                "pid=os.fork(); "
                f"path=pathlib.Path({str(child_pid_file)!r}); "
                "(time.sleep(60),os._exit(0)) if pid == 0 else "
                "(path.write_text(str(pid),encoding='ascii'),os._exit(0))"
            )
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-c",
                script,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
            child_pid: int | None = None
            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
                for _ in range(200):
                    if child_pid_file.exists() and child_pid_file.stat().st_size:
                        child_pid = int(
                            child_pid_file.read_text(encoding="ascii").strip()
                        )
                        break
                    await asyncio.sleep(0.01)
                self.assertIsNotNone(child_pid, "descendant pid was not recorded")
                self.assertTrue(
                    NekoHostAgent._posix_process_group_exists(process.pid),
                    "reaped leader unexpectedly had no live process group",
                )

                await NekoHostAgent._stop_host_process(process)

                self.assertFalse(
                    NekoHostAgent._posix_process_group_exists(process.pid),
                    "descendant survived process-group cleanup",
                )
            finally:
                if child_pid is not None:
                    try:
                        os.kill(child_pid, 9)
                    except ProcessLookupError:
                        pass


@unittest.skipUnless(os.name == "nt", "Windows Job Object containment probe")
class WindowsJobContainmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_job_termination_kills_a_spawned_descendant(self) -> None:
        powershell = (
            Path(os.environ["SystemRoot"])
            / "System32"
            / "WindowsPowerShell"
            / "v1.0"
            / "powershell.exe"
        )
        with tempfile.TemporaryDirectory(prefix="neko-job-test-") as directory:
            root = Path(directory)
            release = root / "release"
            child_pid_file = root / "child.pid"
            script = (
                f"while (-not (Test-Path -LiteralPath '{release}')) "
                "{ Start-Sleep -Milliseconds 10 }; "
                "$child = Start-Process -PassThru "
                f"-FilePath '{powershell}' -ArgumentList "
                "'-NoProfile','-Command','Start-Sleep -Seconds 60'; "
                f"Set-Content -LiteralPath '{child_pid_file}' -Value $child.Id; "
                "Start-Sleep -Seconds 60"
            )
            process = await asyncio.create_subprocess_exec(
                str(powershell),
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=0x00000200,  # CREATE_NEW_PROCESS_GROUP
            )
            job = _WindowsKillJob.assign(process.pid)
            release.write_text("go", encoding="ascii")
            for _ in range(300):
                if child_pid_file.exists() and child_pid_file.stat().st_size:
                    break
                await asyncio.sleep(0.01)
            else:
                await job.terminate(process)
                self.fail("job descendant did not start")

            child_pid = int(child_pid_file.read_text(encoding="ascii").strip())
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = [
                wintypes.DWORD,
                wintypes.BOOL,
                wintypes.DWORD,
            ]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel32.WaitForSingleObject.restype = wintypes.DWORD
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            child_handle = kernel32.OpenProcess(0x00100000, False, child_pid)
            self.assertTrue(child_handle, "could not open spawned descendant")
            try:
                await job.terminate(process)
                self.assertEqual(
                    kernel32.WaitForSingleObject(child_handle, 2000),
                    0,
                    "descendant survived Job Object termination",
                )
            finally:
                kernel32.CloseHandle(child_handle)


if __name__ == "__main__":
    unittest.main()
