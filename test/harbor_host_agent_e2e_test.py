from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import threading
import unittest
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, ClassVar

from evals.harbor.neko_host_agent import NekoHostAgent


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class Result:
    return_code: int = 0
    stdout: str | None = ""
    stderr: str | None = ""


class PublicMode:
    value = "public"


class PublicPolicy:
    network_mode = PublicMode()
    allowed_hosts: ClassVar[list[str]] = []


class DockerEnvironment:
    default_user: str | int | None = None
    network_policy = PublicPolicy()

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
            raise AssertionError("host environment data crossed into the task adapter")
        argv = ["docker", "exec"]
        if cwd:
            argv += ["--workdir", cwd]
        argv += [self.name, "sh", "-c", command]
        completed = await asyncio.to_thread(
            subprocess.run,
            argv,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
        return Result(
            completed.returncode,
            str(completed.stdout or ""),
            str(completed.stderr or ""),
        )

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

    async def stop(self, delete: bool) -> None:
        if delete:
            await asyncio.to_thread(
                subprocess.run,
                ["docker", "rm", "--force", self.name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )


class ProviderState:
    def __init__(self, secret: str) -> None:
        self.secret = secret
        self.lock = threading.Lock()
        self.calls = 0
        self.auth_headers: list[str] = []
        self.bodies: list[str] = []

    def response(self, authorization: str, body: str) -> bytes:
        with self.lock:
            self.calls += 1
            call = self.calls
            self.auth_headers.append(authorization)
            self.bodies.append(body)
        tools = {
            1: (
                "write",
                "write_file",
                {"path": "proof.txt", "content": "safe fixture\n"},
            ),
            2: ("read", "read_file", {"path": "proof.txt"}),
            3: ("bash", "bash", {"command": "printf verified"}),
        }
        tool = tools.get(call)
        if tool is None:
            payload = {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "done"},
                    }
                ]
            }
        else:
            call_id, name, arguments = tool
            payload = {
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": call_id,
                                    "type": "function",
                                    "function": {
                                        "name": name,
                                        "arguments": json.dumps(arguments),
                                    },
                                }
                            ],
                        },
                    }
                ]
            }
        payload["usage"] = {
            "prompt_tokens": 13,
            "completion_tokens": 2,
            "total_tokens": 15,
            "cached_tokens": 4,
        }
        return json.dumps(payload).encode("utf-8")


def handler_for(state: ProviderState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("content-length", "0"))
            body = self.rfile.read(length).decode("utf-8")
            response = state.response(self.headers.get("authorization", ""), body)
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, format: str, *args: Any) -> None:
            del format, args

    return Handler


@unittest.skipUnless(
    os.environ.get("NEKO_HARBOR_E2E_TEST") == "1",
    "set NEKO_HARBOR_E2E_TEST=1 for the local fake-provider Harbor canary",
)
class HostAdapterEndToEndTests(unittest.IsolatedAsyncioTestCase):
    async def test_compiled_runner_keeps_host_secret_out_of_real_task(self) -> None:
        bun = shutil.which("bun")
        docker = shutil.which("docker")
        self.assertIsNotNone(bun, "Bun is required for the host-runner canary")
        self.assertIsNotNone(docker, "Docker is required for the Harbor canary")
        root = Path(__file__).resolve().parents[1]
        secret = f"host-provider-secret-{uuid.uuid4().hex}"
        state = ProviderState(secret)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(state))
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        container = f"neko-harbor-e2e-{uuid.uuid4().hex}"
        old_env = {
            name: os.environ.get(name)
            for name in (
                "NEKO_PROFILE",
                "NEKO_PROVIDER",
                "NEKO_BASE_URL",
                "NEKO_API_KEY",
                "NEKO_MAX_RETRIES",
                "NEKO_OFFLINE_RETRY_SECONDS",
                "NEKO_TIMEOUT_SECONDS",
                "NEKO_HARBOR_RUNNER_HOME",
                "PYTHONPATH",
            )
        }
        try:
            os.environ.update(
                {
                    "NEKO_PROFILE": "",
                    "NEKO_PROVIDER": "openai_compat",
                    "NEKO_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
                    "NEKO_API_KEY": secret,
                    "NEKO_MAX_RETRIES": "0",
                    "NEKO_OFFLINE_RETRY_SECONDS": "0",
                    "NEKO_TIMEOUT_SECONDS": "5",
                }
            )
            with TemporaryDirectory(prefix="neko-harbor-e2e-build-") as directory:
                temp = Path(directory)
                artifact = temp / (
                    "neko-harbor-host.exe" if os.name == "nt" else "neko-harbor-host"
                )
                built = await asyncio.to_thread(
                    subprocess.run,
                    [
                        str(bun),
                        "build",
                        str(root / "evals" / "harbor" / "host_runner.ts"),
                        "--compile",
                        "--outfile",
                        str(artifact),
                    ],
                    cwd=root,
                    capture_output=True,
                    text=True,
                    timeout=120,
                    check=False,
                )
                self.assertEqual(built.returncode, 0, built.stderr)
                started = await asyncio.to_thread(
                    subprocess.run,
                    [
                        "docker",
                        "run",
                        "--detach",
                        "--name",
                        container,
                        "--workdir",
                        "/workspace",
                        "python:3.13-slim",
                        "sh",
                        "-c",
                        "mkdir -p /workspace && sleep infinity",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=60,
                    check=False,
                )
                self.assertEqual(started.returncode, 0, started.stderr)
                environment = DockerEnvironment(container)
                controls = {
                    "runner_source_sha256": root
                    / "evals"
                    / "harbor"
                    / "host_runner.ts",
                    "launcher_source_sha256": root / "scripts" / "harbor-eval.ts",
                    "host_agent_sha256": root
                    / "evals"
                    / "harbor"
                    / "neko_host_agent.py",
                    "remote_tools_sha256": root
                    / "evals"
                    / "harbor"
                    / "remote_tools.py",
                }
                logs = temp / "logs"
                runner_home = temp / "runner-home"
                runner_home.mkdir()
                os.environ["NEKO_HARBOR_RUNNER_HOME"] = str(runner_home.resolve())
                with self.assertRaisesRegex(
                    ValueError, "supports only chatgpt OAuth"
                ):
                    NekoHostAgent(
                        logs_dir=logs,
                        model_name="openai_compat/fake-harbor-model",
                        runner_path=str(artifact.resolve()),
                        runner_sha256=sha256(artifact),
                        profile="openai",
                        reasoning_effort="low",
                        max_steps=8,
                        adaptive_effort=False,
                        loop=False,
                        source_revision="fake-provider-canary",
                        source_dirty=True,
                        build_bun_version="canary",
                        dataset_request="local/fake-provider-canary",
                        **{name: sha256(path) for name, path in controls.items()},
                    )
                quoted_secret = shlex.quote(secret)
                task_probe = await environment.exec(
                    "set -eu; "
                    f"! env | grep -F -- {quoted_secret}; "
                    "found=0; for item in /proc/[0-9]*/environ; do "
                    f"tr '\\000' '\\n' < \"$item\" 2>/dev/null | grep -Fq -- {quoted_secret} && found=1 || true; "
                    'done; test "$found" = 0; '
                    f"! grep -R -F -- {quoted_secret} /workspace /tmp 2>/dev/null",
                    cwd="/workspace",
                    env=None,
                    timeout_sec=20,
                    user=None,
                )
                self.assertEqual(task_probe.return_code, 0, task_probe.stdout)
                self.assertEqual(state.calls, 0)
                self.assertEqual(state.auth_headers, [])
                self.assertNotIn(secret, "\n".join(state.bodies))
                host_logs = "\n".join(
                    path.read_text(encoding="utf-8") for path in logs.glob("*.json")
                )
                self.assertNotIn(secret, host_logs)
                self.assertFalse((logs / "neko-host-run.json").exists())
        finally:
            await asyncio.to_thread(
                subprocess.run,
                ["docker", "rm", "--force", container],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=2)
            for name, value in old_env.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value


if __name__ == "__main__":
    unittest.main()
