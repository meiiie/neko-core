from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
from typing import Any

import programbench.eval.eval as eval_module
import programbench.eval.eval_batch as eval_batch_module
from programbench.container import ContainerEnvironment
from programbench.eval.eval import Evaluator


MODE = "workspace-snapshot"
SCHEMA_VERSION = "neko.programbench.evaluator.v2"
RUN_ID_ENV = "NEKO_PROGRAMBENCH_RUN_ID"
_ORIGINAL_RUN = Evaluator.run
_ORIGINAL_COMMIT = ContainerEnvironment.commit
_ORIGINAL_REMOVE_IMAGE = eval_module.remove_image
_ORIGINAL_EVALUATE_INSTANCE = eval_batch_module._evaluate_instance
_ORIGINAL_DOCKER_RUN_ARGS = list(eval_module.DOCKER_RUN_ARGS)


def _run_command(args: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def _require_success(result: dict[str, Any], operation: str) -> None:
    if result.get("returncode") != 0:
        output = str(result.get("output") or "").strip()
        raise RuntimeError(f"{operation} failed: {output[:500]}")


def _write_metadata(root: Path, payload: dict[str, Any]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    target = root / "_neko-evaluator.json"
    temporary = root / f".{target.name}.{os.getpid()}.tmp"
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, target)


def _run_id() -> str:
    value = os.environ.get(RUN_ID_ENV, "")
    if len(value) != 32 or any(character not in "0123456789abcdef" for character in value):
        raise RuntimeError("ProgramBench evaluator run id is missing or invalid")
    return value


def _workspace_snapshot_run(self: Evaluator):
    state: dict[str, Any] = {
        "syntheticImage": None,
        "snapshot": None,
    }
    original_new_env = self._new_env
    docker_executable = str(eval_module.DOCKER_EXECUTABLE)
    temporary = tempfile.TemporaryDirectory(prefix="neko-programbench-workspace-")
    snapshot = Path(temporary.name) / "workspace.tar.gz"
    snapshot_executable = f"{eval_module.WORKSPACE_DIR}/.neko-programbench-executable"

    def snapshot_commit(environment: ContainerEnvironment, image_ref: str) -> str:
        archive_path = "/tmp/neko-programbench-workspace.tar.gz"
        staged = environment.execute(
            f"cp -p {shlex.quote(str(self._stashed_executable))} {shlex.quote(snapshot_executable)}",
            timeout=300,
        )
        _require_success(staged, "compiled executable snapshot")
        packed = environment.execute(
            f"tar -C {eval_module.WORKSPACE_DIR} -czf {archive_path} .",
            timeout=600,
        )
        _require_success(packed, "workspace snapshot")
        copied = _run_command(
            [docker_executable, "cp", f"{environment.container_id}:{archive_path}", str(snapshot)],
            timeout=600,
        )
        if copied.returncode != 0:
            raise RuntimeError(f"workspace snapshot copy failed: {copied.stderr.strip()[:500]}")
        state["syntheticImage"] = image_ref
        state["snapshot"] = str(snapshot)
        return image_ref

    def snapshot_new_env(image: str, *, serial_pytest: bool = False):
        if image != state.get("syntheticImage"):
            return original_new_env(image, serial_pytest=serial_pytest)
        environment = original_new_env(
            f"{self.image_name}:{self.image_tag}",
            serial_pytest=serial_pytest,
        )
        try:
            cleared = environment.execute(
                f"rm -rf {eval_module.WORKSPACE_DIR}/* {eval_module.WORKSPACE_DIR}/.[!.]*",
                timeout=300,
            )
            _require_success(cleared, "workspace reset")
            environment.copy_in_tar(snapshot, eval_module.WORKSPACE_DIR)
            restored = environment.execute(
                f"mv {shlex.quote(snapshot_executable)} {shlex.quote(str(self._stashed_executable))}",
                timeout=300,
            )
            _require_success(restored, "compiled executable restore")
            if self._has_rerunfailures:
                installed = environment.execute(
                    "pip3 install -q --disable-pip-version-check pytest-rerunfailures",
                    timeout=120,
                )
                _require_success(installed, "pytest-rerunfailures restore")
            return environment
        except BaseException:
            environment.cleanup()
            raise

    def snapshot_remove_image(image_ref: str, *args, **kwargs):
        if image_ref == state.get("syntheticImage"):
            return None
        return _ORIGINAL_REMOVE_IMAGE(image_ref, *args, **kwargs)

    ContainerEnvironment.commit = snapshot_commit
    self._new_env = snapshot_new_env
    eval_module.remove_image = snapshot_remove_image
    try:
        return _ORIGINAL_RUN(self)
    finally:
        eval_module.remove_image = _ORIGINAL_REMOVE_IMAGE
        self._new_env = original_new_env
        ContainerEnvironment.commit = _ORIGINAL_COMMIT
        temporary.cleanup()


Evaluator.run = _workspace_snapshot_run


def _workspace_snapshot_evaluate_instance(*args, **kwargs):
    summary = _ORIGINAL_EVALUATE_INSTANCE(*args, **kwargs)
    if summary is None:
        return None
    branch_error_count = sum(len(errors) for errors in summary.test_branch_errors.values())
    _write_metadata(Path(kwargs["target_dir"]).resolve(), {
        "schemaVersion": SCHEMA_VERSION,
        "mode": MODE,
        "programbenchVersion": "1.2.4",
        "shimSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "snapshotScope": eval_module.WORKSPACE_DIR,
        "runId": _run_id(),
        "instanceId": summary.instance_id,
        "score": summary.score,
        "resolvedTests": summary.n_resolved,
        "scoredTests": summary.n_tests,
        "errorCode": summary.error_code,
        "branchErrorCount": branch_error_count,
        "systemErrorCount": summary.n_system_errors,
        "warningCount": summary.n_warnings,
    })
    return summary


eval_batch_module._evaluate_instance = _workspace_snapshot_evaluate_instance
eval_module.DOCKER_RUN_ARGS = [
    *_ORIGINAL_DOCKER_RUN_ARGS,
    "--label",
    f"dev.neko.programbench.run={_run_id()}",
]


from programbench.cli.main import app


try:
    app()
finally:
    eval_module.DOCKER_RUN_ARGS = _ORIGINAL_DOCKER_RUN_ARGS
    eval_batch_module._evaluate_instance = _ORIGINAL_EVALUATE_INSTANCE
