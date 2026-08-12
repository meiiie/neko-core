from __future__ import annotations

import asyncio
import json
import os
import struct
import subprocess
import time
import unittest
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar
from unittest import mock

from evals.harbor import remote_tools
from evals.harbor.remote_tools import (
    FRAME_SCHEMA,
    MAX_FRAME_BYTES,
    MAX_OBSERVATION_CHARS,
    TASK_COMMAND_NAMES,
    TASK_COMMAND_PROFILE_MISMATCH,
    ProtocolError,
    RemoteToolDispatcher,
    RemoteToolError,
    _bounded_observation,
    serve_protocol,
)


def mock_preflight_output() -> str:
    names = TASK_COMMAND_NAMES + ("rg",)
    bindings = "".join(
        f"BIND\t{name}\t/usr/bin/{name}\t/usr/bin/{name}\t1:1:1:1:1\n" for name in names
    )
    return f"OK\n/usr/bin:/bin\nrg\n/usr/bin/rg\n{bindings}"


@dataclass
class Result:
    return_code: int = 0
    stdout: str | None = ""
    stderr: str | None = ""


class Mode:
    value = "public"


class Policy:
    network_mode = Mode()
    allowed_hosts: ClassVar[list[str]] = []


class MockEnvironment:
    default_user: str | int | None = "agent"
    network_policy = Policy()

    def __init__(
        self,
        *,
        preflight_code: int = 0,
        preflight_output: str | None = None,
        root: str = "/workspace",
    ) -> None:
        self.preflight_code = preflight_code
        self.preflight_output = (
            preflight_output
            if preflight_output is not None
            else mock_preflight_output()
        )
        self.root = root
        self.calls: list[dict[str, Any]] = []
        self.uploads: list[tuple[str, bytes]] = []
        self.poll_started = asyncio.Event()
        self.structured_started = asyncio.Event()
        self.upload_started = asyncio.Event()
        self.block_structured = False
        self.block_upload = False
        self.complete_bash = False
        self.quiescent = False
        self.escaped_canary = False
        self.fail_cleanup = False
        self.fail_stop = False
        self.fail_bash_launch = False
        self.fail_upload = False
        self.settle_first_cleanup_after_timeout = False
        self.cleanup_attempts = 0
        self.cleanup_transport_settled = False
        self.profile_replaced = False
        self.destroyed = False
        self.timeline: list[str] = []

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> Result:
        self.calls.append(
            {
                "command": command,
                "cwd": cwd,
                "env": env,
                "timeout_sec": timeout_sec,
                "user": user,
            }
        )
        if self.profile_replaced and command.startswith("PATH="):
            self.timeline.append("profile-mismatch")
            return Result(return_code=97, stderr=TASK_COMMAND_PROFILE_MISMATCH + "\n")
        body = (
            command.split(": neko-command-profile-bound; ", 1)[-1]
            if command.startswith("PATH=")
            else command
        )
        if body == "pwd -P":
            return Result(stdout=self.root + "\n")
        if "for command_name in sh realpath" in body:
            return Result(
                self.preflight_code,
                self.preflight_output if self.preflight_code == 0 else "",
            )
        if body.startswith("mkdir -p /tmp/neko-harbor-remote-tools"):
            return Result()
        if body.startswith("read -r self_line < /proc/self/stat"):
            return Result(stdout="SNAP\n")
        if "env -u NEKO_REMOTE_CALL_TOKEN" in body:
            self.escaped_canary = True
            return Result()
        if body.startswith("mkdir -m 700 --"):
            return Result()
        if body == "neko-test-late-result":
            await asyncio.sleep(0.4)
            self.timeline.append("late-result-ready")
            return Result(stdout="late-result\n")
        if self.fail_bash_launch and "leader=$!" in body:
            self.timeline.append("launch-failed")
            raise RuntimeError("fixture transport failed after bash launch")
        if "NEKO_REMOTE_CALL_TOKEN=" in body and "setsid sh -c" in body:
            if self.block_structured and "realpath -e" in body:
                self.structured_started.set()
                await asyncio.Event().wait()
            return Result(stdout="OK\n")
        if body.startswith("if test -s "):
            self.poll_started.set()
            return Result(stdout="0\n" if self.complete_bash else "RUNNING\n")
        if body.startswith("cat ") and "/output " in body:
            return Result(stdout="fixture-output")
        if "remaining=$(count=0" in body and "QUIESCENT" in body:
            if self.settle_first_cleanup_after_timeout:
                self.cleanup_attempts += 1
            if self.settle_first_cleanup_after_timeout and self.cleanup_attempts == 1:
                try:
                    await asyncio.sleep(float(timeout_sec or 1) + 0.1)
                except asyncio.CancelledError:
                    self.timeline.append("cleanup-transport-cancelled")
                    raise
                self.cleanup_transport_settled = True
                self.timeline.append("cleanup-transport-settled")
                raise asyncio.TimeoutError
            if (
                self.settle_first_cleanup_after_timeout
                and not self.cleanup_transport_settled
            ):
                return Result(return_code=82)
            if self.fail_cleanup:
                return Result(return_code=82)
            self.quiescent = True
            self.timeline.append("quiescent")
            return Result(stdout="QUIESCENT\n")
        if body.startswith("rm -rf -- /tmp/neko-harbor-remote-tools"):
            return Result()
        return Result()

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads.append((target_path, Path(source_path).read_bytes()))
        if self.block_upload:
            self.upload_started.set()
            await asyncio.Event().wait()
        if self.fail_upload:
            raise RuntimeError("fixture upload transport failed")

    async def download_file(self, source_path: str, target_path: Path | str) -> None:
        Path(target_path).write_text("fixture\n", encoding="utf-8")

    async def stop(self, delete: bool) -> None:
        self.timeline.append("destroy-attempt")
        if self.fail_stop:
            raise RuntimeError("fixture destruction failed")
        self.destroyed = delete
        self.timeline.append("destroyed")


class CaptureWriter:
    def __init__(self, timeline: list[str] | None = None) -> None:
        self.data = bytearray()
        self.timeline = timeline

    def write(self, data: bytes) -> None:
        self.data.extend(data)
        if self.timeline is not None and len(data) >= 4:
            size = struct.unpack(">I", data[:4])[0]
            frame = json.loads(data[4 : 4 + size].decode("utf-8"))
            self.timeline.append(f"frame:{frame['type']}:{frame.get('id')}")

    async def drain(self) -> None:
        return None

    def frames(self) -> list[dict[str, Any]]:
        frames = []
        offset = 0
        while offset < len(self.data):
            size = struct.unpack(">I", self.data[offset : offset + 4])[0]
            offset += 4
            frames.append(json.loads(self.data[offset : offset + size].decode("utf-8")))
            offset += size
        return frames


def encoded(frame: dict[str, Any]) -> bytes:
    raw = json.dumps(frame, separators=(",", ":")).encode("utf-8")
    return struct.pack(">I", len(raw)) + raw


def final_frame(**overrides: Any) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "completionStatus": "ok",
        "usageComplete": True,
        "providerCompleteCalls": 2,
        "providerReportedModelCalls": 3,
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
    metrics.update(overrides)
    return {"schema": FRAME_SCHEMA, "type": "final", "metrics": metrics}


def checkpoint_frame(**overrides: Any) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "providerCompleteCalls": 2,
        "providerUsageObservedCalls": 2,
        "providerReportedModelCalls": 3,
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
    metrics.update(overrides)
    return {
        "schema": FRAME_SCHEMA,
        "type": "metrics_checkpoint",
        "metrics": metrics,
    }


def context(*, deadline_ms: int = 10_000) -> dict[str, Any]:
    return {
        "deadlineAt": int(time.time() * 1000) + deadline_ms,
        "workspace": {
            "canonicalPosixRoot": "/workspace",
            "readOutsideRoot": False,
            "strictEditMatch": False,
        },
        "sandbox": {
            "enabled": True,
            "allowNetwork": True,
            "domains": [],
            "denyReadFiles": [],
            "readOnlyWorkspace": False,
        },
    }


class RemoteToolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.secret_name = "NEKO_TEST_SENTINEL"
        self.secret = "sentinel-do-not-cross-94dc21"
        os.environ[self.secret_name] = self.secret
        self.environment = MockEnvironment()
        self.dispatcher = await RemoteToolDispatcher.create(self.environment)
        self.assertTrue(self.environment.escaped_canary)
        self.environment.quiescent = False

    async def asyncTearDown(self) -> None:
        await self.dispatcher.close()
        os.environ.pop(self.secret_name, None)

    async def _wait_for_frames(self, writer: CaptureWriter, count: int) -> None:
        for _ in range(100):
            if len(writer.frames()) >= count:
                return
            await asyncio.sleep(0.01)
        self.fail(f"expected {count} protocol frames")

    async def test_hello_and_task_frames_never_contain_host_secret(self) -> None:
        hello = self.dispatcher.hello("repair the fixture")
        serialized = json.dumps(hello, sort_keys=True)
        self.assertNotIn(self.secret, serialized)
        self.assertEqual(hello["posture"]["networkMode"], "public")
        self.assertFalse(hello["posture"]["hostCredentialsInTask"])
        self.assertEqual(
            hello["attestation"]["deadlineAndCancellation"],
            "backend-enforced-quiescent",
        )
        self.assertEqual(hello["attestation"]["bashSandbox"], "backend-enforced")

        task = asyncio.create_task(
            self.dispatcher.execute("bash", {"command": "sleep 30"}, context())
        )
        await asyncio.wait_for(self.environment.poll_started.wait(), timeout=1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(self.environment.quiescent)

        observed = json.dumps(self.environment.calls, sort_keys=True) + repr(
            self.environment.uploads
        )
        self.assertNotIn(self.secret, observed)
        self.assertTrue(all(call["env"] is None for call in self.environment.calls))
        cleanup = next(
            call["command"]
            for call in self.environment.calls
            if "QUIESCENT" in call["command"]
        )
        self.assertIn("/proc/[0-9]*/environ", cleanup)
        self.assertIn("/proc/[0-9]*/stat", cleanup)
        self.assertIn("identity=$pid:$start", cleanup)
        self.assertIn("kill -TERM", cleanup)
        self.assertIn("kill -KILL", cleanup)

    async def test_preflight_probes_a_detached_child_that_explicitly_unsets_token(
        self,
    ) -> None:
        canary = next(
            call["command"]
            for call in self.environment.calls
            if "env -u NEKO_REMOTE_CALL_TOKEN" in call["command"]
        )
        self.assertIn("setsid env -u NEKO_REMOTE_CALL_TOKEN", canary)
        self.assertIn("sleep 30", canary)
        cleanup = next(
            call["command"]
            for call in self.environment.calls
            if "new_remaining=" in call["command"]
        )
        self.assertIn("baseline=", cleanup)
        self.assertIn("/proc/[0-9]*/stat", cleanup)

    async def test_path_escape_background_and_expired_deadline_fail_before_launch(
        self,
    ) -> None:
        baseline = len(self.environment.calls)
        with self.assertRaisesRegex(RemoteToolError, "escapes"):
            await self.dispatcher.execute("read_file", {"path": "../secret"}, context())
        with self.assertRaisesRegex(RemoteToolError, "background bash"):
            await self.dispatcher.execute(
                "bash",
                {"command": "echo no", "run_in_background": True},
                context(),
            )
        expired = context()
        expired["deadlineAt"] = int(time.time() * 1000) - 1
        with self.assertRaisesRegex(RemoteToolError, "expired"):
            await self.dispatcher.execute("bash", {"command": "echo no"}, expired)
        self.assertEqual(len(self.environment.calls), baseline)

    async def test_malformed_context_and_weaker_network_authority_fail_closed(
        self,
    ) -> None:
        malformed = context()
        malformed["workspace"]["surprise"] = True
        with self.assertRaises(ProtocolError):
            await self.dispatcher.execute("ls", {}, malformed)
        weaker = context()
        weaker["sandbox"]["allowNetwork"] = False
        with self.assertRaisesRegex(RemoteToolError, "network authority"):
            await self.dispatcher.execute("ls", {}, weaker)
        disabled = context()
        disabled["sandbox"]["enabled"] = False
        with self.assertRaisesRegex(RemoteToolError, "sandbox authority"):
            await self.dispatcher.execute("ls", {}, disabled)

    async def test_protocol_cancel_quiesces_before_cancelled_frame(self) -> None:
        reader = asyncio.StreamReader()
        request = {
            "schema": FRAME_SCHEMA,
            "type": "request",
            "id": "call-1",
            "tool": "bash",
            "args": {"command": "sleep 30"},
            "context": context(),
        }
        reader.feed_data(encoded(request))
        reader.feed_data(
            encoded({"schema": FRAME_SCHEMA, "type": "cancel", "id": "call-1"})
        )
        final = final_frame(
            usageComplete=False,
            providerCompleteCalls=1,
            providerReportedModelCalls=None,
            inputTokens=None,
            outputTokens=None,
            cachedTokens=None,
            totalTokens=None,
            toolCalls={
                "requested": 1,
                "completed": 1,
                "productive": 0,
                "empty": 0,
                "failed": 1,
            },
        )
        reader.feed_data(
            encoded(
                checkpoint_frame(
                    providerCompleteCalls=1,
                    providerUsageObservedCalls=0,
                    providerReportedModelCalls=0,
                    inputTokens=0,
                    outputTokens=0,
                    cachedTokens=0,
                    totalTokens=0,
                    toolCalls={
                        "requested": 1,
                        "completed": 1,
                        "productive": 0,
                        "empty": 0,
                        "failed": 1,
                    },
                )
            )
        )
        reader.feed_data(encoded(final))
        reader.feed_eof()
        writer = CaptureWriter()
        metrics = await serve_protocol(reader, writer, self.dispatcher, "fixture")  # type: ignore[arg-type]
        frames = writer.frames()
        self.assertEqual([frame["type"] for frame in frames], ["hello", "cancelled"])
        self.assertEqual(frames[1]["result"], "(interrupted)")
        self.assertTrue(self.environment.quiescent)
        self.assertEqual(metrics, final["metrics"])
        self.assertNotIn(self.secret, json.dumps(frames))

    async def test_post_token_exceptions_always_discharge_quiescence(self) -> None:
        for failure in ("fail_upload", "fail_bash_launch"):
            with self.subTest(failure=failure):
                self.environment.timeline.clear()
                self.environment.quiescent = False
                setattr(self.environment, failure, True)
                with self.assertRaisesRegex(RuntimeError, "fixture"):
                    await self.dispatcher.execute(
                        "bash", {"command": "printf unreachable"}, context()
                    )
                setattr(self.environment, failure, False)
                self.assertTrue(self.environment.quiescent)
                self.assertFalse(self.dispatcher._tokens)
                self.assertEqual(self.environment.timeline[-1], "quiescent")

    async def test_upload_cancellation_cannot_outrun_quiescence(self) -> None:
        self.environment.block_upload = True
        task = asyncio.create_task(
            self.dispatcher.execute("bash", {"command": "printf no"}, context())
        )
        await asyncio.wait_for(self.environment.upload_started.wait(), timeout=1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(self.environment.quiescent)
        self.assertFalse(self.dispatcher._tokens)

    async def test_timeout_reserves_transport_settlement_before_quiescence(
        self,
    ) -> None:
        self.environment.timeline.clear()
        self.environment.settle_first_cleanup_after_timeout = True
        with mock.patch.object(remote_tools, "QUIESCENCE_ATTEMPT_TIMEOUT_MS", 100):
            result = await self.dispatcher.execute(
                "bash", {"command": "sleep 30"}, context(deadline_ms=250)
            )

        self.assertTrue(result.startswith("(timed out after "))
        self.assertTrue(self.environment.cleanup_transport_settled)
        self.assertTrue(self.environment.quiescent)
        self.assertFalse(self.environment.destroyed)
        self.assertFalse(self.dispatcher._tokens)
        self.assertEqual(self.environment.cleanup_attempts, 2)
        self.assertNotIn("cleanup-transport-cancelled", self.environment.timeline)
        self.assertLess(
            self.environment.timeline.index("cleanup-transport-settled"),
            self.environment.timeline.index("quiescent"),
        )

    async def test_transport_reserve_never_promotes_a_late_result(self) -> None:
        deadline_at = int(time.time() * 1000) + 250
        with self.assertRaisesRegex(RemoteToolError, "exceeded its deadline"):
            await self.dispatcher._raw_exec("neko-test-late-result", deadline_at)
        self.assertIn("late-result-ready", self.environment.timeline)

    async def test_result_and_error_frames_wait_for_quiescence(self) -> None:
        request = {
            "schema": FRAME_SCHEMA,
            "type": "request",
            "id": "call-ordered",
            "tool": "bash",
            "args": {"command": "printf fixture"},
            "context": context(),
        }
        for failure, expected_type in ((False, "result"), (True, "error")):
            with self.subTest(frame=expected_type):
                self.environment.timeline.clear()
                self.environment.complete_bash = not failure
                self.environment.fail_bash_launch = failure
                reader = asyncio.StreamReader()
                reader.feed_data(encoded(request | {"id": f"call-{expected_type}"}))
                writer = CaptureWriter(self.environment.timeline)
                serving = asyncio.create_task(
                    serve_protocol(reader, writer, self.dispatcher, "fixture")  # type: ignore[arg-type]
                )
                await self._wait_for_frames(writer, 2)
                reader.feed_data(encoded(checkpoint_frame()))
                reader.feed_data(encoded(final_frame()))
                reader.feed_eof()
                await serving
                frames = writer.frames()
                self.assertEqual(frames[1]["type"], expected_type)
                frame_event = f"frame:{expected_type}:call-{expected_type}"
                self.assertLess(
                    self.environment.timeline.index("quiescent"),
                    self.environment.timeline.index(frame_event),
                )
                self.environment.complete_bash = False
                self.environment.fail_bash_launch = False

    async def test_unproven_quiescence_destroys_before_session_failure(self) -> None:
        self.environment.timeline.clear()
        self.environment.fail_bash_launch = True
        self.environment.fail_cleanup = True
        reader = asyncio.StreamReader()
        reader.feed_data(
            encoded(
                {
                    "schema": FRAME_SCHEMA,
                    "type": "request",
                    "id": "call-contained",
                    "tool": "bash",
                    "args": {"command": "printf unreachable"},
                    "context": context(),
                }
            )
        )
        writer = CaptureWriter(self.environment.timeline)
        with self.assertRaisesRegex(ProtocolError, "task was aborted"):
            await asyncio.wait_for(
                serve_protocol(reader, writer, self.dispatcher, "fixture"),  # type: ignore[arg-type]
                timeout=2,
            )
        frames = writer.frames()
        self.assertEqual([frame["type"] for frame in frames], ["hello", "error"])
        self.assertIsNone(frames[1]["id"])
        self.assertTrue(self.environment.destroyed)
        self.assertLess(
            self.environment.timeline.index("destroyed"),
            self.environment.timeline.index("frame:error:None"),
        )

    async def test_post_preflight_profile_replacement_aborts_the_session(self) -> None:
        self.environment.timeline.clear()
        self.environment.profile_replaced = True
        reader = asyncio.StreamReader()
        reader.feed_data(
            encoded(
                {
                    "schema": FRAME_SCHEMA,
                    "type": "request",
                    "id": "call-profile",
                    "tool": "ls",
                    "args": {},
                    "context": context(),
                }
            )
        )
        writer = CaptureWriter(self.environment.timeline)
        with self.assertRaisesRegex(ProtocolError, "command profile changed"):
            await asyncio.wait_for(
                serve_protocol(reader, writer, self.dispatcher, "fixture"),  # type: ignore[arg-type]
                timeout=2,
            )
        frames = writer.frames()
        self.assertEqual([frame["type"] for frame in frames], ["hello", "error"])
        self.assertIsNone(frames[1]["id"])
        self.assertEqual(frames[1]["code"], "command-profile-changed")
        self.assertTrue(self.environment.destroyed)
        self.assertLess(
            self.environment.timeline.index("profile-mismatch"),
            self.environment.timeline.index("destroyed"),
        )
        self.assertLess(
            self.environment.timeline.index("destroyed"),
            self.environment.timeline.index("frame:error:None"),
        )

    async def test_structured_command_cancellation_is_also_quiescent(self) -> None:
        self.environment.block_structured = True
        task = asyncio.create_task(self.dispatcher.execute("ls", {}, context()))
        await asyncio.wait_for(self.environment.structured_started.wait(), timeout=1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(self.environment.quiescent)
        self.assertFalse(self.dispatcher._tokens)

    async def test_failed_quiescence_destroys_task_and_never_reports_cancelled(
        self,
    ) -> None:
        task = asyncio.create_task(
            self.dispatcher.execute("bash", {"command": "sleep 30"}, context())
        )
        await asyncio.wait_for(self.environment.poll_started.wait(), timeout=1)
        self.environment.fail_cleanup = True
        task.cancel()
        with self.assertRaisesRegex(ProtocolError, "task was aborted"):
            await task
        self.assertTrue(self.environment.destroyed)

    async def test_final_metrics_are_exact_bounded_and_reconstructed(self) -> None:
        valid = final_frame()
        reader = asyncio.StreamReader()
        reader.feed_data(encoded(checkpoint_frame()))
        reader.feed_data(encoded(valid))
        reader.feed_eof()
        metrics = await serve_protocol(
            reader, CaptureWriter(), self.dispatcher, "fixture"
        )  # type: ignore[arg-type]
        self.assertEqual(metrics, valid["metrics"])
        self.assertIsNot(metrics, valid["metrics"])

        outer_extra = final_frame()
        outer_extra["surprise"] = True
        nested_extra = final_frame(surprise=True)
        invalid_frames = {
            "unknown outer field": outer_extra,
            "unknown metrics field": nested_extra,
            "unknown tool field": final_frame(
                toolCalls={
                    "requested": 1,
                    "completed": 1,
                    "productive": 1,
                    "empty": 0,
                    "failed": 0,
                    "surprise": 1,
                }
            ),
            "boolean count": final_frame(providerCompleteCalls=True),
            "negative count": final_frame(wallTimeMs=-1),
            "fractional count": final_frame(wallTimeMs=1.5),
            "unsafe count": final_frame(wallTimeMs=1 << 53),
            "invalid status": final_frame(completionStatus="done"),
            "non-string status": final_frame(completionStatus=[]),
            "partial usage retained": final_frame(
                usageComplete=False,
                providerReportedModelCalls=None,
                inputTokens=0,
                outputTokens=None,
                cachedTokens=None,
                totalTokens=None,
            ),
            "complete checkpoint usage downgraded": final_frame(
                usageComplete=False,
                providerReportedModelCalls=None,
                inputTokens=None,
                outputTokens=None,
                cachedTokens=None,
                totalTokens=None,
            ),
            "reported calls below outer calls": final_frame(
                providerReportedModelCalls=1
            ),
            "cached input exceeds input": final_frame(cachedTokens=101),
            "total is below input plus output": final_frame(totalTokens=119),
            "tool classes do not sum": final_frame(
                toolCalls={
                    "requested": 1,
                    "completed": 1,
                    "productive": 0,
                    "empty": 0,
                    "failed": 0,
                }
            ),
            "completed tools exceed requests": final_frame(
                toolCalls={
                    "requested": 0,
                    "completed": 1,
                    "productive": 1,
                    "empty": 0,
                    "failed": 0,
                }
            ),
            "terminal tools remain unsettled": final_frame(
                toolCalls={
                    "requested": 2,
                    "completed": 1,
                    "productive": 1,
                    "empty": 0,
                    "failed": 0,
                }
            ),
        }
        for label, frame in invalid_frames.items():
            with self.subTest(case=label):
                invalid_reader = asyncio.StreamReader()
                invalid_reader.feed_data(encoded(checkpoint_frame()))
                invalid_reader.feed_data(encoded(frame))
                invalid_reader.feed_eof()
                with self.assertRaises(ProtocolError):
                    await serve_protocol(
                        invalid_reader,
                        CaptureWriter(),
                        self.dispatcher,
                        "fixture",
                    )  # type: ignore[arg-type]

    async def test_metrics_checkpoints_are_accepted_idle_and_active(self) -> None:
        observed: list[dict[str, Any]] = []
        idle = checkpoint_frame(
            providerCompleteCalls=1,
            providerUsageObservedCalls=0,
            providerReportedModelCalls=0,
            inputTokens=0,
            outputTokens=0,
            cachedTokens=0,
            totalTokens=0,
            wallTimeMs=1,
            toolCalls={
                "requested": 0,
                "completed": 0,
                "productive": 0,
                "empty": 0,
                "failed": 0,
            },
        )
        active = checkpoint_frame(
            providerCompleteCalls=1,
            providerUsageObservedCalls=0,
            providerReportedModelCalls=0,
            inputTokens=0,
            outputTokens=0,
            cachedTokens=0,
            totalTokens=0,
            wallTimeMs=2,
            toolCalls={
                "requested": 1,
                "completed": 0,
                "productive": 0,
                "empty": 0,
                "failed": 0,
            },
        )
        terminal = checkpoint_frame(
            providerCompleteCalls=1,
            providerUsageObservedCalls=0,
            providerReportedModelCalls=0,
            inputTokens=0,
            outputTokens=0,
            cachedTokens=0,
            totalTokens=0,
            wallTimeMs=3,
            toolCalls={
                "requested": 1,
                "completed": 1,
                "productive": 0,
                "empty": 0,
                "failed": 1,
            },
        )
        final = final_frame(
            usageComplete=False,
            providerCompleteCalls=1,
            providerReportedModelCalls=None,
            inputTokens=None,
            outputTokens=None,
            cachedTokens=None,
            totalTokens=None,
            wallTimeMs=3,
            toolCalls=terminal["metrics"]["toolCalls"],
        )
        request = {
            "schema": FRAME_SCHEMA,
            "type": "request",
            "id": "active-checkpoint",
            "tool": "bash",
            "args": {"command": "sleep 30"},
            "context": context(),
        }
        reader = asyncio.StreamReader()
        for frame in (
            idle,
            request,
            active,
            {"schema": FRAME_SCHEMA, "type": "cancel", "id": "active-checkpoint"},
            terminal,
            final,
        ):
            reader.feed_data(encoded(frame))
        reader.feed_eof()
        metrics = await serve_protocol(
            reader,
            CaptureWriter(),
            self.dispatcher,
            "fixture",
            observed.append,
        )  # type: ignore[arg-type]
        self.assertEqual(metrics, final["metrics"])
        self.assertEqual(observed, [idle["metrics"], active["metrics"], terminal["metrics"]])
        self.assertTrue(self.environment.quiescent)
        self.assertTrue(all(item is not source["metrics"] for item, source in zip(observed, (idle, active, terminal))))

    async def test_metrics_checkpoint_rejects_malformed_and_regressing_data(self) -> None:
        malformed = checkpoint_frame()
        malformed["metrics"]["rawCommand"] = "must-not-cross"
        boolean_count = checkpoint_frame(providerCompleteCalls=True)
        unobserved_usage = checkpoint_frame(
            providerUsageObservedCalls=0,
            providerReportedModelCalls=1,
        )
        for label, frame in (
            ("extra field", malformed),
            ("boolean count", boolean_count),
            ("unobserved usage", unobserved_usage),
        ):
            with self.subTest(case=label):
                reader = asyncio.StreamReader()
                reader.feed_data(encoded(frame))
                reader.feed_eof()
                with self.assertRaises(ProtocolError):
                    await serve_protocol(
                        reader, CaptureWriter(), self.dispatcher, "fixture"
                    )  # type: ignore[arg-type]

        first = checkpoint_frame(wallTimeMs=10)
        regressed = checkpoint_frame(wallTimeMs=9)
        reader = asyncio.StreamReader()
        reader.feed_data(encoded(first))
        reader.feed_data(encoded(regressed))
        reader.feed_eof()
        with self.assertRaisesRegex(ProtocolError, "regressed"):
            await serve_protocol(
                reader, CaptureWriter(), self.dispatcher, "fixture"
            )  # type: ignore[arg-type]

        self.environment.quiescent = False
        active_reader = asyncio.StreamReader()
        active_reader.feed_data(
            encoded(
                {
                    "schema": FRAME_SCHEMA,
                    "type": "request",
                    "id": "malformed-active-checkpoint",
                    "tool": "bash",
                    "args": {"command": "sleep 30"},
                    "context": context(),
                }
            )
        )
        active_reader.feed_data(encoded(malformed))
        active_reader.feed_eof()
        with self.assertRaises(ProtocolError):
            await serve_protocol(
                active_reader, CaptureWriter(), self.dispatcher, "fixture"
            )  # type: ignore[arg-type]
        self.assertTrue(self.environment.quiescent)

    async def test_malformed_active_checkpoint_waits_for_containment_failure(
        self,
    ) -> None:
        environment = MockEnvironment()
        dispatcher = await RemoteToolDispatcher.create(environment)
        environment.fail_cleanup = True
        environment.fail_stop = True
        malformed = checkpoint_frame()
        malformed["metrics"]["rawCommand"] = "must-not-cross"
        request = {
            "schema": FRAME_SCHEMA,
            "type": "request",
            "id": "malformed-active-contained",
            "tool": "bash",
            "args": {"command": "sleep 30"},
            "context": context(),
        }
        reader = asyncio.StreamReader()
        reader.feed_data(encoded(request))
        writer = CaptureWriter(environment.timeline)
        serving = asyncio.create_task(
            serve_protocol(reader, writer, dispatcher, "fixture")  # type: ignore[arg-type]
        )
        await asyncio.wait_for(environment.poll_started.wait(), timeout=1)
        reader.feed_data(encoded(malformed))
        reader.feed_eof()

        with self.assertRaises(ProtocolError) as caught:
            await asyncio.wait_for(serving, timeout=2)
        self.assertEqual(caught.exception.code, "containment-failure")
        frames = writer.frames()
        self.assertEqual([frame["type"] for frame in frames], ["hello", "error"])
        self.assertEqual(frames[1]["code"], "containment-failure")
        self.assertIsNone(frames[1]["id"])
        self.assertLess(
            environment.timeline.index("destroy-attempt"),
            environment.timeline.index("frame:error:None"),
        )

        with self.assertRaisesRegex(RuntimeError, "destruction could not be confirmed"):
            await dispatcher.close()
        environment.fail_stop = False
        await dispatcher.close()

    async def test_checkpoint_and_final_cannot_undercount_remote_requests(self) -> None:
        request = {
            "schema": FRAME_SCHEMA,
            "type": "request",
            "id": "counted-remotely",
            "tool": "bash",
            "args": {"command": "sleep 30"},
            "context": context(),
        }
        undercounted = checkpoint_frame(
            toolCalls={
                "requested": 0,
                "completed": 0,
                "productive": 0,
                "empty": 0,
                "failed": 0,
            }
        )
        reader = asyncio.StreamReader()
        reader.feed_data(encoded(request))
        writer = CaptureWriter()
        serving = asyncio.create_task(
            serve_protocol(reader, writer, self.dispatcher, "fixture")  # type: ignore[arg-type]
        )
        await asyncio.wait_for(self.environment.poll_started.wait(), timeout=1)
        reader.feed_data(encoded(undercounted))
        reader.feed_eof()
        with self.assertRaisesRegex(ProtocolError, "inconsistent"):
            await serving
        self.assertTrue(self.environment.quiescent)

        settled_reader = asyncio.StreamReader()
        settled_reader.feed_data(
            encoded({**request, "id": "settled-but-undercounted", "tool": "ls", "args": {}})
        )
        settled_writer = CaptureWriter()
        settled_serving = asyncio.create_task(
            serve_protocol(  # type: ignore[arg-type]
                settled_reader, settled_writer, self.dispatcher, "fixture"
            )
        )
        await self._wait_for_frames(settled_writer, 2)
        settled_reader.feed_data(
            encoded(
                checkpoint_frame(
                    toolCalls={
                        "requested": 1,
                        "completed": 0,
                        "productive": 0,
                        "empty": 0,
                        "failed": 0,
                    }
                )
            )
        )
        settled_reader.feed_eof()
        with self.assertRaisesRegex(ProtocolError, "inconsistent"):
            await settled_serving

        idle_checkpoint = checkpoint_frame(
            toolCalls={
                "requested": 0,
                "completed": 0,
                "productive": 0,
                "empty": 0,
                "failed": 0,
            }
        )
        final = final_frame(toolCalls=idle_checkpoint["metrics"]["toolCalls"])
        final_reader = asyncio.StreamReader()
        final_reader.feed_data(encoded(idle_checkpoint))
        final_reader.feed_data(
            encoded(
                {
                    **request,
                    "id": "counted-before-final",
                    "tool": "ls",
                    "args": {},
                }
            )
        )
        final_writer = CaptureWriter()
        final_serving = asyncio.create_task(
            serve_protocol(  # type: ignore[arg-type]
                final_reader, final_writer, self.dispatcher, "fixture"
            )
        )
        await self._wait_for_frames(final_writer, 2)
        final_reader.feed_data(encoded(final))
        final_reader.feed_eof()
        with self.assertRaisesRegex(ProtocolError, "do not match"):
            await final_serving

    async def test_final_must_reconcile_with_terminal_checkpoint(self) -> None:
        mismatches = (
            final_frame(providerCompleteCalls=3),
            final_frame(inputTokens=101, totalTokens=121),
            final_frame(
                toolCalls={
                    "requested": 2,
                    "completed": 1,
                    "productive": 1,
                    "empty": 0,
                    "failed": 0,
                }
            ),
        )
        for final in mismatches:
            reader = asyncio.StreamReader()
            reader.feed_data(encoded(checkpoint_frame()))
            reader.feed_data(encoded(final))
            reader.feed_eof()
            with self.assertRaises(ProtocolError):
                await serve_protocol(
                    reader, CaptureWriter(), self.dispatcher, "fixture"
                )  # type: ignore[arg-type]

        missing = asyncio.StreamReader()
        missing.feed_data(encoded(final_frame()))
        missing.feed_eof()
        with self.assertRaisesRegex(ProtocolError, "terminal metrics checkpoint"):
            await serve_protocol(
                missing, CaptureWriter(), self.dispatcher, "fixture"
            )  # type: ignore[arg-type]

    async def test_protocol_rejects_reused_id_and_oversize_frame(self) -> None:
        reader = asyncio.StreamReader()
        reader.feed_data(struct.pack(">I", MAX_FRAME_BYTES + 1))
        reader.feed_eof()
        from evals.harbor.remote_tools import read_frame

        with self.assertRaisesRegex(ProtocolError, "length"):
            await read_frame(reader)

        for malformed_json in (b'{"value":NaN}', b'{"value":1,"value":2}'):
            malformed_reader = asyncio.StreamReader()
            malformed_reader.feed_data(
                struct.pack(">I", len(malformed_json)) + malformed_json
            )
            malformed_reader.feed_eof()
            with self.assertRaisesRegex(ProtocolError, "UTF-8 JSON"):
                await read_frame(malformed_reader)

        request = {
            "schema": FRAME_SCHEMA,
            "type": "request",
            "id": "same",
            "tool": "bash",
            "args": {"command": "true"},
            "context": context(),
        }
        active_reader = asyncio.StreamReader()
        active_reader.feed_data(encoded(request))
        active_reader.feed_data(encoded(request))
        active_reader.feed_eof()
        writer = CaptureWriter()
        with self.assertRaises(ProtocolError):
            await serve_protocol(active_reader, writer, self.dispatcher, "fixture")  # type: ignore[arg-type]
        self.assertTrue(self.environment.quiescent)

        final_while_active = asyncio.StreamReader()
        final_while_active.feed_data(encoded({**request, "id": "final-active"}))
        final_while_active.feed_data(encoded(final_frame()))
        final_while_active.feed_eof()
        with self.assertRaises(ProtocolError):
            await serve_protocol(
                final_while_active,
                CaptureWriter(),
                self.dispatcher,
                "fixture",
            )  # type: ignore[arg-type]
        self.assertTrue(self.environment.quiescent)

    async def test_worst_case_json_escaping_stays_within_runner_result_cap(
        self,
    ) -> None:
        result = _bounded_observation("\0" * (MAX_OBSERVATION_CHARS + 1))
        frame = {
            "schema": FRAME_SCHEMA,
            "type": "result",
            "id": "bounded",
            "result": result,
        }
        encoded_frame = json.dumps(
            frame, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        self.assertLessEqual(len(encoded_frame), 256 * 1024)


class PreflightTests(unittest.IsolatedAsyncioTestCase):
    async def test_visible_host_daemon_or_mount_posture_refuses_adapter(self) -> None:
        for code in (63, 64, 65, 67, 68):
            with self.subTest(code=code):
                environment = MockEnvironment(preflight_code=code)
                with self.assertRaisesRegex(RuntimeError, "preflight refused"):
                    await RemoteToolDispatcher.create(environment)
                serialized = json.dumps(environment.calls)
                self.assertNotIn("sentinel-do-not-cross", serialized)

    async def test_double_slash_root_is_not_advertised(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "unsafe or non-canonical"):
            await RemoteToolDispatcher.create(MockEnvironment(root="//workspace"))

    async def test_post_preflight_commands_use_the_frozen_utility_profile(
        self,
    ) -> None:
        environment = MockEnvironment()
        dispatcher = await RemoteToolDispatcher.create(environment)
        try:
            preflight_index = next(
                index
                for index, call in enumerate(environment.calls)
                if "for command_name in sh realpath" in call["command"]
            )
            post_preflight = environment.calls[preflight_index + 1 :]
            self.assertTrue(post_preflight)
            self.assertTrue(
                all(
                    call["command"].startswith(
                        "PATH=/usr/bin:/bin; export PATH; readonly PATH; "
                    )
                    for call in post_preflight
                )
            )
            self.assertEqual(dispatcher.command_profile.path, ("/usr/bin", "/bin"))
            self.assertEqual(dispatcher.command_profile.search_path, "/usr/bin/rg")
            bound = post_preflight[0]["command"]
            self.assertIn("/usr/bin/realpath -e -- /usr/bin/sh", bound)
            self.assertIn("/usr/bin/stat -Lc '%d:%i:%s:%Y:%h'", bound)
            self.assertIn(": neko-command-profile-bound;", bound)
        finally:
            await dispatcher.close()

    async def test_workspace_or_relative_utility_profiles_are_refused(self) -> None:
        invalid_profiles = (
            "OK\n/workspace/bin:/usr/bin\nrg\n/workspace/bin/rg\n",
            "OK\nrelative:/usr/bin\nrg\n/usr/bin/rg\n",
            "OK\n/usr/bin\nrg\n/opt/bin/rg\n",
            mock_preflight_output().replace(
                "BIND\tsh\t/usr/bin/sh", "BIND\tsh\t/workspace/bin/sh"
            ),
        )
        for output in invalid_profiles:
            with (
                self.subTest(output=output),
                self.assertRaisesRegex(RuntimeError, "invalid command profile"),
            ):
                await RemoteToolDispatcher.create(
                    MockEnvironment(preflight_output=output)
                )


class DockerEnvironment:
    default_user: str | int | None = None
    network_policy = Policy()

    def __init__(self, name: str) -> None:
        self.name = name

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> Result:
        if env is not None or user is not None:
            raise AssertionError("integration adapter received unexpected env or user")

        def run() -> subprocess.CompletedProcess[str]:
            argv = ["docker", "exec"]
            if cwd:
                argv += ["--workdir", cwd]
            argv += [self.name, "sh", "-c", command]
            return subprocess.run(
                argv,
                capture_output=True,
                text=True,
                timeout=timeout_sec,
                check=False,
            )

        try:
            completed = await asyncio.to_thread(run)
        except subprocess.TimeoutExpired as error:
            raise asyncio.TimeoutError from error
        return Result(completed.returncode, completed.stdout, completed.stderr)

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        completed = await asyncio.to_thread(
            subprocess.run,
            ["docker", "cp", str(source_path), f"{self.name}:{target_path}"],
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError("docker upload failed")

    async def download_file(self, source_path: str, target_path: Path | str) -> None:
        completed = await asyncio.to_thread(
            subprocess.run,
            ["docker", "cp", f"{self.name}:{source_path}", str(target_path)],
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError("docker download failed")


@unittest.skipUnless(
    os.environ.get("NEKO_HARBOR_DOCKER_TEST") == "1",
    "set NEKO_HARBOR_DOCKER_TEST=1 for the no-model process-isolation probe",
)
class DockerProcessContainmentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.name = f"neko-harbor-tools-{uuid.uuid4().hex}"
        started = await asyncio.to_thread(
            subprocess.run,
            [
                "docker",
                "run",
                "--detach",
                "--name",
                self.name,
                "--workdir",
                "/workspace",
                "python:3.13-slim",
                "sh",
                "-c",
                "mkdir -p /workspace && sleep infinity",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(started.returncode, 0, started.stderr)
        self.environment = DockerEnvironment(self.name)
        self.dispatcher = await RemoteToolDispatcher.create(self.environment)

    async def asyncTearDown(self) -> None:
        if hasattr(self, "dispatcher"):
            await self.dispatcher.close()
        await asyncio.to_thread(
            subprocess.run,
            ["docker", "rm", "--force", self.name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )

    async def test_cancel_kills_new_session_child_after_it_unsets_token(self) -> None:
        command = (
            "setsid env -u NEKO_REMOTE_CALL_TOKEN sh -c "
            "'read -r line < /proc/self/stat; pid=${line%% *}; rest=${line##*) }; "
            'set -- $rest; printf "%s:%s\\n" "$pid" "${20}" > /workspace/escaped.pid; '
            "exec sleep 30' >/dev/null 2>&1 & "
            "while test ! -s /workspace/escaped.pid; do sleep 0.01; done; sleep 30"
        )
        task = asyncio.create_task(
            self.dispatcher.execute(
                "bash", {"command": command}, context(deadline_ms=20_000)
            )
        )
        for _ in range(100):
            marker = await self.environment.exec(
                "test -s /workspace/escaped.pid",
                cwd="/workspace",
                env=None,
                timeout_sec=2,
                user=None,
            )
            if marker.return_code == 0:
                break
            await asyncio.sleep(0.02)
        else:
            self.fail("detached child did not start")
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        survived = await self.environment.exec(
            "saved=$(cat /workspace/escaped.pid); pid=${saved%:*}; "
            'test -r "/proc/$pid/stat" || exit 1; read -r line < "/proc/$pid/stat"; '
            'rest=${line##*) }; set -- $rest; test "$pid:${20}" = "$saved"',
            cwd="/workspace",
            env=None,
            timeout_sec=2,
            user=None,
        )
        self.assertNotEqual(
            survived.return_code, 0, "detached token-free child survived cancellation"
        )

    async def test_timeout_kills_long_running_command_before_returning(self) -> None:
        command = (
            "read -r line < /proc/self/stat; pid=${line%% *}; rest=${line##*) }; "
            'set -- $rest; printf "%s:%s\\n" "$pid" "${20}" > /workspace/timeout.pid; '
            "sleep 30"
        )
        with self.assertRaisesRegex(RemoteToolError, "exceeded its deadline"):
            await self.dispatcher._exec(
                command, int(time.time() * 1000) + 5_000
            )

        marker = await self.environment.exec(
            "test -s /workspace/timeout.pid",
            cwd="/workspace",
            env=None,
            timeout_sec=2,
            user=None,
        )
        self.assertEqual(marker.return_code, 0, "long-running command never started")
        self.assertFalse(self.dispatcher._tokens)
        survived = await self.environment.exec(
            "saved=$(cat /workspace/timeout.pid); pid=${saved%:*}; "
            'test -r "/proc/$pid/stat" || exit 1; read -r line < "/proc/$pid/stat"; '
            'rest=${line##*) }; set -- $rest; test "$pid:${20}" = "$saved"',
            cwd="/workspace",
            env=None,
            timeout_sec=2,
            user=None,
        )
        self.assertNotEqual(
            survived.return_code, 0, "long-running command survived its timeout"
        )

    async def test_eight_tool_dispatch_path_runs_inside_the_task_only(self) -> None:
        def ctx() -> dict[str, Any]:
            return context(deadline_ms=20_000)

        wrote = await self.dispatcher.execute(
            "write_file",
            {"path": "sample.txt", "content": "alpha\nbeta\n"},
            ctx(),
        )
        self.assertTrue(wrote.startswith("Wrote sample.txt"))
        read = await self.dispatcher.execute("read_file", {"path": "sample.txt"}, ctx())
        self.assertIn("alpha", read)
        edited = await self.dispatcher.execute(
            "edit",
            {"path": "sample.txt", "old_string": "alpha", "new_string": "gamma"},
            ctx(),
        )
        self.assertTrue(edited.startswith("Edited sample.txt"))
        multi = await self.dispatcher.execute(
            "multi_edit",
            {
                "path": "sample.txt",
                "edits": [{"old_string": "beta", "new_string": "delta"}],
            },
            ctx(),
        )
        self.assertTrue(multi.startswith("Edited sample.txt"))
        searched = await self.dispatcher.execute("search", {"pattern": "gamma"}, ctx())
        self.assertIn("gamma", searched)
        globbed = await self.dispatcher.execute("glob", {"pattern": "*.txt"}, ctx())
        self.assertIn("sample.txt", globbed)
        listed = await self.dispatcher.execute("ls", {}, ctx())
        self.assertIn("sample.txt", listed)
        bash = await self.dispatcher.execute(
            "bash", {"command": "printf task-only"}, ctx()
        )
        self.assertEqual(bash, "(exit 0)\ntask-only")


if __name__ == "__main__":
    unittest.main()
