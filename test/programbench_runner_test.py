from __future__ import annotations

import os
import json
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from evals.programbench.runner import (
    CommandResult,
    EXECUTION_IDENTITY,
    RemoteToolDispatcher,
    _runner_environment,
    docker_capacity,
    docker_run_arguments,
    heartbeat_line,
    file_sha256,
    main_async,
    official_image,
    official_instruction,
    validate_instance_id,
    validate_audit_trajectory,
)


class ProgramBenchRunnerTests(unittest.TestCase):
    def test_official_image_mapping_is_exact_and_bounded(self) -> None:
        task = validate_instance_id("abishekvashok__cmatrix.5c082c6")
        self.assertEqual(
            official_image(task),
            "programbench/abishekvashok_1776_cmatrix.5c082c6:task_cleanroom_v6",
        )
        with self.assertRaisesRegex(ValueError, "task id is invalid"):
            validate_instance_id("../../host")

    def test_docker_posture_matches_the_official_cleanroom(self) -> None:
        docker = str((Path(tempfile.gettempdir()) / "docker.exe").resolve())
        args = docker_run_arguments(
            docker,
            official_image("abishekvashok__cmatrix.5c082c6"),
            "neko-programbench-012345abcdef",
            run_id="f" * 32,
        )
        self.assertEqual(args[0], docker)
        self.assertIn("--network", args)
        self.assertEqual(args[args.index("--network") + 1], "none")
        self.assertEqual(args[args.index("--user") + 1], "agent")
        self.assertEqual(args[args.index("--cap-drop") + 1], "SYS_PTRACE")
        self.assertEqual(
            args[args.index("--label") + 1],
            f"dev.neko.programbench.run={'f' * 32}",
        )
        self.assertEqual(EXECUTION_IDENTITY, "programbench-docker-environment")

    def test_capacity_is_explicitly_bounded_to_the_local_engine(self) -> None:
        with mock.patch("subprocess.run") as run:
            run.return_value = mock.Mock(
                returncode=0,
                stdout=f"4 {8 * 1024**3}\n",
                stderr="",
            )
            self.assertEqual(docker_capacity("C:/Docker/docker.exe"), (4, "7g"))

    def test_capacity_retries_a_transient_docker_info_timeout(self) -> None:
        recovered = mock.Mock(
            returncode=0,
            stdout=f"4 {8 * 1024**3}\n",
            stderr="",
        )
        with (
            mock.patch(
                "subprocess.run",
                side_effect=[subprocess.TimeoutExpired(["docker", "info"], 60), recovered],
            ) as run,
            mock.patch("time.sleep") as sleep,
        ):
            self.assertEqual(docker_capacity("C:/Docker/docker.exe"), (4, "7g"))
            self.assertEqual(run.call_count, 2)
            sleep.assert_called_once_with(1)

    def test_heartbeat_reports_progress_without_task_content(self) -> None:
        self.assertEqual(
            heartbeat_line(60, None),
            "programbench heartbeat: elapsed=60s remaining=1680s phase=starting",
        )
        checkpoint = {
            "providerCompleteCalls": 7,
            "toolCalls": {"requested": 11, "completed": 10},
        }
        self.assertEqual(
            heartbeat_line(125, checkpoint),
            "programbench heartbeat: elapsed=125s remaining=1615s provider_calls=7 tools=10/11",
        )
        checkpoint["progress"] = {
            "phase": "implementation",
            "lastToolCategory": "edit",
            "toolState": "settled",
            "artifactCheckpoints": 3,
            "mutationEpoch": 4,
            "validationState": "pending",
        }
        line = heartbeat_line(130, checkpoint)
        self.assertEqual(
            line,
            "programbench heartbeat: elapsed=130s remaining=1610s provider_calls=7 "
            "tools=10/11 phase=implementation tool=edit/settled artifacts=3 "
            "epoch=4 validation=pending",
        )
        self.assertNotIn("path", line)
        self.assertNotIn("command", line)

    def test_instruction_requires_behavioral_reimplementation(self) -> None:
        instruction = official_instruction()
        for phrase in (
            "new original codebase",
            "Do not use the internet",
            "Do not wrap",
            "Do not decompile",
            "./compile.sh",
            "commit the source changes",
        ):
            self.assertIn(phrase, instruction)

    def test_host_environment_does_not_inherit_unlisted_secrets(self) -> None:
        with tempfile.TemporaryDirectory(prefix="neko-programbench-home-") as raw_home:
            home = Path(raw_home).resolve()
            old = os.environ.get("NEKO_PROGRAMBENCH_TEST_SECRET")
            os.environ["NEKO_PROGRAMBENCH_TEST_SECRET"] = "must-not-cross"
            try:
                env = _runner_environment(
                    home,
                    1_900_000_000_000,
                    160,
                    12,
                    "max",
                    "contract",
                    24,
                    home / "audit.json",
                )
            finally:
                if old is None:
                    os.environ.pop("NEKO_PROGRAMBENCH_TEST_SECRET", None)
                else:
                    os.environ["NEKO_PROGRAMBENCH_TEST_SECRET"] = old
            self.assertNotIn("NEKO_PROGRAMBENCH_TEST_SECRET", env)
            self.assertNotIn("must-not-cross", repr(env))
            self.assertEqual(env["HOME"], str(home))
            self.assertEqual(env["NEKO_MAX_STEPS"], "160")
            self.assertEqual(env["NEKO_HARBOR_IMPLEMENTATION_ROUND_STEPS"], "12")
            self.assertEqual(env["NEKO_HARBOR_LOOP"], "1")
            self.assertEqual(env["NEKO_HARBOR_COMPLETION_MODE"], "contract")
            self.assertEqual(env["NEKO_HARBOR_PROVIDER_CALL_BUDGET"], "24")
            self.assertEqual(env["NEKO_HARBOR_TRAJECTORY_PATH"], str(home / "audit.json"))

    def test_artifact_digest_is_exact(self) -> None:
        with tempfile.TemporaryDirectory(prefix="neko-programbench-digest-") as raw:
            path = Path(raw) / "submission.tar.gz"
            path.write_bytes(b"programbench-artifact")
            self.assertEqual(
                file_sha256(path),
                "a7305be4d2995919bc83a12b57fe40c77cde1cb3abb76560ae9fe28b17550489",
            )

    def test_audit_trajectory_requires_exact_sanitized_shape(self) -> None:
        metrics = {"completionStatus": "ok"}
        value = {
            "schemaVersion": "neko.harbor.audit-trajectory.v1",
            "profile": "zai",
            "provider": "anthropic",
            "model": "glm-5.3",
            "reasoningEffort": "max",
            "metrics": metrics,
            "messages": [{"role": "user", "content": "task"}],
        }
        self.assertEqual(validate_audit_trajectory(value, metrics), value)
        with self.assertRaisesRegex(ValueError, "invalid"):
            validate_audit_trajectory({**value, "apiKey": "secret"}, metrics)


class ProgramBenchRunnerLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_teardown_failure_still_persists_the_terminal_trajectory(self) -> None:
        task = "antonmedv__fx.86d0d34"
        fake_loader = types.ModuleType("programbench.utils.load_data")
        fake_loader.load_all_instances = lambda include_tests=False: [
            {
                "instance_id": task,
                "image_name": "programbench/antonmedv_1776_fx.86d0d34",
            }
        ]
        fake_utils = types.ModuleType("programbench.utils")
        fake_package = types.ModuleType("programbench")

        class FakeEnvironment:
            def __init__(self, *_args, **_kwargs) -> None:
                self.stopped = False

            def start(self) -> None:
                return None

            async def exec(self, *_args, **_kwargs) -> CommandResult:
                return CommandResult(return_code=0, stdout="", stderr="")

            async def stop(self, delete: bool = True) -> None:
                self.stopped = delete

        class FailingDispatcher:
            async def close(self) -> None:
                raise RuntimeError("fixture teardown failed")

        with tempfile.TemporaryDirectory(prefix="neko-programbench-lifecycle-") as raw:
            root = Path(raw)
            runner = root / "runner.exe"
            runner.write_bytes(b"fixture")
            home = root / "home"
            (home / ".neko-core").mkdir(parents=True)
            (home / ".neko-core" / "config.json").write_text("{}", encoding="utf-8")
            output = root / "output"
            args = SimpleNamespace(
                runner=str(runner),
                task=task,
                output=str(output),
                max_steps=1,
                round_steps=1,
                effort="max",
                completion_mode="single",
                call_budget=1,
                source_revision="a" * 40,
                source_dirty=True,
                profile="zai",
                model="glm-5.3",
                host_runner_sha256="b" * 64,
                launcher_sha256="c" * 64,
                environment_runner_sha256="d" * 64,
                remote_tools_sha256="e" * 64,
                run_id="f" * 32,
            )
            modules = {
                "programbench": fake_package,
                "programbench.utils": fake_utils,
                "programbench.utils.load_data": fake_loader,
            }
            with (
                mock.patch.dict(sys.modules, modules),
                mock.patch.dict(os.environ, {"NEKO_HARBOR_RUNNER_HOME": str(home)}),
                mock.patch("evals.programbench.runner.shutil.which", return_value=str(runner)),
                mock.patch("evals.programbench.runner.docker_capacity", return_value=(1, "1g")),
                mock.patch("evals.programbench.runner.DockerEnvironment", FakeEnvironment),
                mock.patch.object(
                    RemoteToolDispatcher,
                    "create",
                    new=mock.AsyncMock(return_value=FailingDispatcher()),
                ),
                mock.patch(
                    "evals.programbench.runner.run_host",
                    new=mock.AsyncMock(side_effect=RuntimeError("fixture host failed")),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "fixture teardown failed"):
                    await main_async(args)

            trajectory = output / task / f"{task}.traj.json"
            self.assertTrue(trajectory.is_file())
            payload = json.loads(trajectory.read_text(encoding="utf-8"))
            self.assertEqual(payload["exitStatus"], "infrastructure_error")
            self.assertIsNone(payload["metrics"])
            self.assertIsNone(payload["artifact"])


if __name__ == "__main__":
    unittest.main()
