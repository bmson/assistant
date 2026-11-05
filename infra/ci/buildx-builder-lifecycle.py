#!/usr/bin/env python3
"""Own and close one workflow-local docker-container Buildx builder."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

OWNER_LABEL = "org.assistant.memory-witness.owner"
SOURCE_LABEL = "org.assistant.memory-witness.source-sha"
RUN_LABEL = "org.assistant.memory-witness.run-id"
ATTEMPT_LABEL = "org.assistant.memory-witness.run-attempt"
BUILDER_LABEL = "org.assistant.memory-witness.builder"
OWNER_ENV = "ASSISTANT_MEMORY_WITNESS_OWNER"
BUILDKIT_IMAGE = "moby/buildkit:buildx-stable-1"
CPU_QUOTA = 200000
CPU_PERIOD = 100000
MEMORY = 4 * 1024**3
BUILDKIT_STATE_DIR = "/var/lib/buildkit"


class LifecycleError(RuntimeError):
    pass


class Result:
    def __init__(
        self,
        args: list[str],
        code: int,
        stdout: str = "",
        stderr: str = "",
        timed_out: bool = False,
        drained: bool = True,
    ) -> None:
        self.args = args
        self.code = code
        self.stdout = stdout
        self.stderr = stderr
        self.timed_out = timed_out
        self.drained = drained


class DockerRunner:
    """Run one Docker CLI process group with TERM then bounded KILL cleanup."""

    def __init__(self, executable: str = "docker") -> None:
        self.executable = executable

    def run(self, args: list[str], timeout: float) -> Result:
        process = subprocess.Popen(
            [self.executable, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=timeout)
            drained = self._ensure_group_gone(process.pid)
            return Result(args, process.returncode, stdout, stderr, drained=drained)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            kill_sent = False
            try:
                stdout, stderr = process.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                    kill_sent = True
                except ProcessLookupError:
                    pass
                try:
                    stdout, stderr = process.communicate(timeout=1)
                except subprocess.TimeoutExpired:
                    process.stdout.close()
                    process.stderr.close()
                    stdout = ""
                    stderr = "Docker process group did not drain after SIGKILL"
            drained = self._ensure_group_gone(process.pid, term_sent=True, kill_sent=kill_sent)
            if not drained:
                process.stdout.close()
                process.stderr.close()
                stderr = (stderr + "\nDocker process group still exists after bounded kill observation").strip()
            return Result(args, 124, stdout, stderr, timed_out=True, drained=drained)

    @staticmethod
    def _group_exists(pgid: int) -> bool:
        try:
            os.killpg(pgid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    @classmethod
    def _wait_group_gone(cls, pgid: int, seconds: float) -> bool:
        deadline = time.monotonic() + seconds
        while True:
            if not cls._group_exists(pgid):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)

    @classmethod
    def _ensure_group_gone(
        cls, pgid: int, term_sent: bool = False, kill_sent: bool = False
    ) -> bool:
        if cls._wait_group_gone(pgid, 0):
            return True
        if not term_sent:
            try:
                os.killpg(pgid, signal.SIGTERM)
            except ProcessLookupError:
                return True
        if cls._wait_group_gone(pgid, 2):
            return True
        if not kill_sent:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                return True
        return cls._wait_group_gone(pgid, 2)


def _write_json_durable(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    dir_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _write_text(path: Path, value: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())


def _load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise LifecycleError(f"{path.name} must contain a JSON object")
    return value


def _volume_name(container_name: str) -> str:
    return container_name + "_state"


def assert_preflight_clear(
    container_rows: list[tuple[str, str]], volume_rows: list[str], builders: set[str], builder: str
) -> None:
    if container_rows or volume_rows or builder in builders:
        raise LifecycleError("preflight found a preexisting exact builder resource")


def _new_lease(builder: str, source_sha: str, run_id: str, attempt: str) -> dict[str, Any]:
    if not builder or any(char.isspace() for char in builder):
        raise LifecycleError("builder name is invalid")
    owner = secrets.token_hex(32)
    container_name = f"buildx_buildkit_{builder}0"
    labels = {
        OWNER_LABEL: owner,
        SOURCE_LABEL: source_sha,
        RUN_LABEL: run_id,
        ATTEMPT_LABEL: attempt,
        BUILDER_LABEL: builder,
    }
    return {
        "format": 1,
        # Docker's volume CreatedAt is commonly second-resolution. Keep the
        # lease at the same precision so same-second creation is not rejected.
        "createdAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "sourceSha": source_sha,
        "runId": run_id,
        "runAttempt": attempt,
        "builder": builder,
        "containerName": container_name,
        "stateVolume": _volume_name(container_name),
        "ownerToken": owner,
        "volumeLabels": labels,
        "preflightPassed": False,
        "volumeCreateAttempted": False,
        "builderCreateAttempted": False,
    }


def _append_event(proof: Path, event: dict[str, Any], lock: threading.Lock) -> None:
    path = proof / "builder-lifecycle-events.jsonl"
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    data = json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n"
    with lock:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, data.encode())
            os.fsync(fd)
        finally:
            os.close(fd)


class Lifecycle:
    def __init__(
        self, proof: Path, runner: Any | None = None, budget_seconds: float | None = None
    ) -> None:
        self.proof = proof
        self.runner = runner or DockerRunner()
        self.lock = threading.Lock()
        self.events: list[dict[str, Any]] = []
        self.first_failure: dict[str, Any] | None = None
        self.deadline = time.monotonic() + budget_seconds if budget_seconds is not None else None

    def call(self, stage: str, args: list[str], timeout: float) -> Result:
        if self.deadline is not None:
            remaining = self.deadline - time.monotonic()
            # Reserve TERM/KILL grace plus terminal receipt time before starting
            # another daemon request. Cleanup never consumes the full step cap.
            effective_timeout = min(timeout, remaining - 24)
            if effective_timeout <= 0:
                raise LifecycleError("cleanup time budget reserve reached before Docker request")
            timeout = effective_timeout
        started = time.monotonic()
        result = self.runner.run(args, timeout)
        event = {
            "stage": stage,
            "command": ["docker", *args],
            "timeoutSeconds": timeout,
            "elapsedSeconds": round(time.monotonic() - started, 3),
            "exitCode": result.code,
            "timedOut": result.timed_out,
            "processGroupDrained": result.drained,
            "stdout": result.stdout[-8192:],
            "stderr": result.stderr[-8192:],
        }
        self.events.append(event)
        _append_event(self.proof, event, self.lock)
        if result.code != 0 and self.first_failure is None:
            self.first_failure = {
                "stage": stage,
                "command": ["docker", *args],
                "exitCode": result.code,
                "timedOut": result.timed_out,
                "processGroupDrained": result.drained,
                "stdout": result.stdout[-8192:],
                "stderr": result.stderr[-8192:],
            }
        if not result.drained:
            raise LifecycleError(f"{stage} process group did not drain after SIGKILL")
        return result

    def record_local(self, stage: str, fields: dict[str, Any]) -> None:
        event = {"stage": stage, **fields}
        self.events.append(event)
        _append_event(self.proof, event, self.lock)

    def list_containers(self, stage: str, filter_args: list[str]) -> list[tuple[str, str]]:
        result = self.call(
            stage,
            ["container", "ls", "--all", "--no-trunc", *filter_args,
             "--format", "{{.ID}} {{.Names}}"],
            2,
        )
        if result.code != 0:
            raise LifecycleError(f"{stage} failed: {result.stderr[-1000:]}")
        rows: list[tuple[str, str]] = []
        for line in result.stdout.splitlines():
            parts = line.split(maxsplit=1)
            if len(parts) != 2:
                raise LifecycleError(f"{stage} returned a malformed container row")
            rows.append((parts[0], parts[1]))
        return rows

    def list_all_containers(self, stage: str) -> list[tuple[str, str]]:
        result = self.call(
            stage,
            ["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}} {{.Names}}"],
            2,
        )
        if result.code != 0:
            raise LifecycleError(f"{stage} failed: {result.stderr[-1000:]}")
        rows: list[tuple[str, str]] = []
        for line in result.stdout.splitlines():
            parts = line.split(maxsplit=1)
            if len(parts) != 2:
                raise LifecycleError(f"{stage} returned a malformed container row")
            rows.append((parts[0], parts[1]))
        return rows

    def list_volumes(self, stage: str, name: str) -> list[str]:
        result = self.call(
            stage,
            ["volume", "ls", "--filter", f"name=^{name}$", "--format", "{{.Name}}"],
            2,
        )
        if result.code != 0:
            raise LifecycleError(f"{stage} failed: {result.stderr[-1000:]}")
        return [line for line in result.stdout.splitlines() if line]

    def list_builders(self, stage: str) -> set[str]:
        result = self.call(
            stage,
            ["buildx", "ls", "--timeout", "2s", "--format", "{{.Name}}"],
            3,
        )
        if result.code != 0:
            raise LifecycleError(f"{stage} failed: {result.stderr[-1000:]}")
        return {line.strip() for line in result.stdout.splitlines() if line.strip()}

    def inspect_container(self, stage: str, container_id: str) -> dict[str, Any]:
        result = self.call(stage, ["container", "inspect", container_id], 3)
        if result.code != 0:
            raise LifecycleError(f"{stage} failed: {result.stderr[-1000:]}")
        value = json.loads(result.stdout)
        if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
            raise LifecycleError(f"{stage} returned malformed inspect data")
        return value[0]

    def inspect_volume(self, stage: str, name: str) -> dict[str, Any]:
        result = self.call(stage, ["volume", "inspect", name], 3)
        if result.code != 0:
            raise LifecycleError(f"{stage} failed: {result.stderr[-1000:]}")
        value = json.loads(result.stdout)
        if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
            raise LifecycleError(f"{stage} returned malformed inspect data")
        return value[0]


def _validate_volume(
    volume: dict[str, Any], lease: dict[str, Any], expected: dict[str, Any] | None = None
) -> str | None:
    if volume.get("Name") != lease["stateVolume"]:
        return "volume name differs from durable lease"
    if volume.get("Driver") != "local" or volume.get("Scope") != "local":
        return "state volume driver or scope differs"
    if volume.get("Labels") != lease["volumeLabels"]:
        return "state volume owner labels differ"
    try:
        created = dt.datetime.fromisoformat(volume["CreatedAt"].replace("Z", "+00:00"))
        leased = dt.datetime.fromisoformat(lease["createdAt"])
    except (KeyError, TypeError, ValueError):
        return "state volume creation time is missing or malformed"
    if created < leased:
        return "state volume predates the durable owner lease"
    if expected and any(
        volume.get(key) != expected.get(key)
        for key in ("Name", "CreatedAt", "Driver", "Scope", "Labels", "Mountpoint")
    ):
        return "state volume differs from captured prebuild volume identity"
    return None


def _validate_container(
    container: dict[str, Any], lease: dict[str, Any], expected: dict[str, Any] | None
) -> str | None:
    container_id = container.get("Id")
    if not isinstance(container_id, str) or len(container_id) != 64:
        return "container full ID is missing or malformed"
    if container.get("Name") != f"/{lease['containerName']}":
        return "container name differs from durable lease"
    config = container.get("Config") or {}
    if config.get("Image") != BUILDKIT_IMAGE:
        return "container configured image differs from approved BuildKit image"
    env = config.get("Env") or []
    if f"{OWNER_ENV}={lease['ownerToken']}" not in env:
        return "container owner token does not match durable lease"
    image_id = container.get("Image", "")
    if not image_id.startswith("sha256:") or len(image_id) != 71:
        return "container image ID is missing or malformed"
    if expected and (
        container.get("Id") != expected.get("containerId")
        or image_id != expected.get("imageId")
        or config.get("Image") != expected.get("configuredImage")
        or container.get("Name") != expected.get("name")
    ):
        return "container differs from captured prebuild identity"
    host = container.get("HostConfig") or {}
    restart = host.get("RestartPolicy") or {}
    if (
        host.get("Memory") != MEMORY
        or host.get("MemorySwap") != MEMORY
        or host.get("CpuQuota") != CPU_QUOTA
        or host.get("CpuPeriod") != CPU_PERIOD
        or restart.get("Name") != "no"
    ):
        return "container resource limits or restart policy differ from lease"
    mounts = container.get("Mounts") or []
    if len(mounts) != 1:
        return "container has unexpected mounts"
    mount = mounts[0]
    if (
        mount.get("Type") != "volume"
        or mount.get("Name") != lease["stateVolume"]
        or mount.get("Destination") != BUILDKIT_STATE_DIR
    ):
        return "container state mount differs from owned state volume"
    if expected and "mounts" in expected and mounts != expected["mounts"]:
        return "container mount differs from captured prebuild identity"
    return None


def _builder_rows_include(rows: set[str], builder: str) -> bool:
    return builder in rows


def _terminal_receipt(
    proof: Path,
    lease: dict[str, Any] | None,
    events: list[dict[str, Any]],
    status: str,
    reason: str | None,
    first_error: dict[str, Any] | None,
    identity: dict[str, Any] | None,
) -> None:
    receipt = {
        "format": 1,
        "status": status,
        "reason": reason,
        "sourceSha": lease.get("sourceSha") if lease else None,
        "runId": lease.get("runId") if lease else None,
        "runAttempt": lease.get("runAttempt") if lease else None,
        "builder": lease.get("builder") if lease else None,
        "leasePresent": lease is not None,
        "identity": identity,
        "firstCleanupError": first_error,
        "observationsAndActions": events,
        "finishedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    _write_json_durable(proof / "builder-cleanup-receipt.json", receipt)


def create_builder(proof: Path, builder: str, source_sha: str, run_id: str, attempt: str) -> int:
    lifecycle = Lifecycle(proof, budget_seconds=100)
    lease = _new_lease(builder, source_sha, run_id, attempt)
    _write_json_durable(proof / "builder-owner-lease.json", lease)
    try:
        container_rows = lifecycle.list_containers(
            "preflight-container-absence",
            ["--filter", f"name=^/{lease['containerName']}$"],
        )
        volume_rows = lifecycle.list_volumes("preflight-volume-absence", lease["stateVolume"])
        builders = lifecycle.list_builders("preflight-builder-absence")
        assert_preflight_clear(container_rows, volume_rows, builders, builder)
        lease["preflightPassed"] = True
        _write_json_durable(proof / "builder-owner-lease.json", lease)

        lease["volumeCreateAttempted"] = True
        _write_json_durable(proof / "builder-owner-lease.json", lease)
        create_args = ["volume", "create", "--driver", "local"]
        for key, value in lease["volumeLabels"].items():
            create_args.extend(["--label", f"{key}={value}"])
        create_args.append(lease["stateVolume"])
        created = lifecycle.call("create-owned-state-volume", create_args, 10)
        if created.code != 0 or created.stdout.strip() != lease["stateVolume"]:
            raise LifecycleError("owned state volume creation failed or returned unexpected name")
        volume = lifecycle.inspect_volume("inspect-created-state-volume", lease["stateVolume"])
        problem = _validate_volume(volume, lease)
        if problem:
            raise LifecycleError(problem)
        _write_json_durable(proof / "builder-volume-identity.json", volume)

        lease["builderCreateAttempted"] = True
        _write_json_durable(proof / "builder-owner-lease.json", lease)
        owner_env = f"{OWNER_ENV}={lease['ownerToken']}"
        args = [
            "buildx", "create", "--name", builder, "--driver", "docker-container",
            "--driver-opt", f"image={BUILDKIT_IMAGE}",
            "--driver-opt", "memory=4g", "--driver-opt", "memory-swap=4g",
            "--driver-opt", f"cpu-quota={CPU_QUOTA}", "--driver-opt", f"cpu-period={CPU_PERIOD}",
            "--driver-opt", "restart-policy=no", "--driver-opt", f"env.{OWNER_ENV}={lease['ownerToken']}",
            "--bootstrap",
        ]
        result = lifecycle.call("create-buildx-builder", args, 60)
        _write_text(proof / "builder-create.log", result.stdout + result.stderr)

        rows = lifecycle.list_containers(
            "capture-prebuild-container-name",
            ["--filter", f"name=^/{lease['containerName']}$"],
        )
        if len(rows) != 1 or rows[0][1] != lease["containerName"]:
            raise LifecycleError("builder creation did not produce exactly the leased container")
        container = lifecycle.inspect_container("capture-prebuild-container-identity", rows[0][0])
        problem = _validate_container(container, lease, None)
        if problem:
            raise LifecycleError(problem)
        volume = lifecycle.inspect_volume("capture-prebuild-volume-identity", lease["stateVolume"])
        problem = _validate_volume(volume, lease)
        if problem:
            raise LifecycleError(problem)
        identity = {
            "containerId": container["Id"],
            "name": container["Name"],
            "imageId": container["Image"],
            "configuredImage": container["Config"]["Image"],
            "stateVolume": lease["stateVolume"],
            "mounts": container["Mounts"],
            "volumeIdentity": {
                key: volume.get(key)
                for key in ("Name", "CreatedAt", "Driver", "Scope", "Labels", "Mountpoint")
            },
            "volumeCreatedAt": volume["CreatedAt"],
            "volumeLabels": volume["Labels"],
            "sourceSha": source_sha,
            "builder": builder,
        }
        _write_json_durable(proof / "builder-identity.json", identity)
        _write_json_durable(proof / "builder-inspect.json", container)
        _write_json_durable(proof / "builder-volume-identity.json", volume)
        lifecycle.record_local("builder-identity-captured", identity)
        if result.code != 0:
            raise LifecycleError(f"buildx create failed with status {result.code}")
        return 0
    except Exception as error:
        _terminal_receipt(
            proof, lease, lifecycle.events, "setup-failed", str(error), None, None
        )
        print(f"builder setup failed: {error}", file=sys.stderr)
        return 1


def cleanup_builder(proof: Path, runner: Any | None = None) -> int:
    lifecycle = Lifecycle(proof, runner, budget_seconds=100)
    lease_path = proof / "builder-owner-lease.json"
    if not lease_path.is_file():
        _terminal_receipt(
            proof, None, [], "unknown", "durable owner lease is missing", None, None
        )
        print("builder cleanup refused: durable owner lease is missing", file=sys.stderr)
        return 1
    try:
        lease = _load_json(lease_path)
    except Exception as error:
        _terminal_receipt(proof, None, [], "unknown", str(error), None, None)
        print(f"builder cleanup refused: invalid durable owner lease: {error}", file=sys.stderr)
        return 1

    identity: dict[str, Any] | None = None
    outcome = "unknown"
    reason: str | None = None
    try:
        if not lease.get("preflightPassed"):
            raise LifecycleError("preflight lease was not completed; refusing Docker mutations")

        expected = None
        identity_path = proof / "builder-identity.json"
        if identity_path.is_file():
            expected = _load_json(identity_path)
        if expected is not None:
            if (
                expected.get("sourceSha") != lease["sourceSha"]
                or expected.get("builder") != lease["builder"]
                or expected.get("stateVolume") != lease["stateVolume"]
            ):
                raise LifecycleError("captured builder identity does not match durable lease")
        expected_volume = None
        volume_identity_path = proof / "builder-volume-identity.json"
        if volume_identity_path.is_file():
            expected_volume = _load_json(volume_identity_path)

        # First establish a read-only ownership snapshot. Do not invoke Buildx rm
        # when any same-name resource or shared state-volume user fails identity.
        all_rows = lifecycle.list_all_containers("pre-cleanup-container-inventory")
        name_rows = [row for row in all_rows if row[1] == lease["containerName"]]
        cid_rows = [row for row in all_rows if expected and row[0] == expected["containerId"]]
        volume_rows = lifecycle.list_volumes("pre-cleanup-state-volume", lease["stateVolume"])
        builder_rows = lifecycle.list_builders("pre-cleanup-builder-registration")

        current_container = None
        if len(name_rows) > 1 or len(cid_rows) > 1:
            raise LifecycleError("container listing returned duplicate identity rows")
        if name_rows:
            if name_rows[0][1] != lease["containerName"]:
                raise LifecycleError("same-name container identity is not exact")
            current_container = lifecycle.inspect_container(
                "pre-cleanup-container-inspect", name_rows[0][0]
            )
        elif cid_rows:
            if not expected or cid_rows[0][0] != expected["containerId"]:
                raise LifecycleError("container CID listing does not match captured identity")
            current_container = lifecycle.inspect_container(
                "pre-cleanup-container-inspect", expected["containerId"]
            )
            raise LifecycleError("captured container was renamed; refusing mutation")

        if current_container is not None:
            problem = _validate_container(current_container, lease, expected)
            if problem:
                raise LifecycleError(problem)
            identity = {
                "containerId": current_container["Id"],
                "name": current_container["Name"],
                "imageId": current_container["Image"],
                "configuredImage": current_container["Config"]["Image"],
                "stateVolume": lease["stateVolume"],
                "sourceSha": lease["sourceSha"],
                "builder": lease["builder"],
            }
        elif expected:
            identity = expected.copy()
        if lease["builder"] in builder_rows and not (expected or current_container):
            raise LifecycleError(
                "builder registration has no captured identity or nonce-validated container"
            )

        volume = None
        if len(volume_rows) > 1 or (volume_rows and volume_rows[0] != lease["stateVolume"]):
            raise LifecycleError("state volume listing did not match exact leased name")
        if volume_rows:
            volume = lifecycle.inspect_volume("pre-cleanup-volume-inspect", lease["stateVolume"])
            problem = _validate_volume(volume, lease, expected_volume)
            if problem:
                raise LifecycleError(problem)
        if current_container is not None and volume is None:
            raise LifecycleError("owned container exists without its leased state volume")

        volume_users = lifecycle.list_containers(
            "pre-cleanup-state-volume-users", ["--filter", f"volume={lease['stateVolume']}"]
        )
        allowed_cids = {current_container["Id"]} if current_container else set()
        if any(cid not in allowed_cids for cid, _ in volume_users):
            raise LifecycleError("state volume is attached to an unowned or unknown container")

        # Remove only resources whose current identity was positively tied to
        # this lease. Buildx metadata is deliberately left registered until the
        # Docker container and named state volume are independently absent.
        lifecycle.record_local("owned-resource-cleanup-start", {
            "containerPresent": current_container is not None,
            "stateVolumePresent": volume is not None,
            "builderRegistrationPresent": lease["builder"] in builder_rows,
        })

        # Reobserve exact resources before any recovery removal.
        all_rows = lifecycle.list_all_containers("recovery-container-inventory")
        name_rows = [row for row in all_rows if row[1] == lease["containerName"]]
        cid_rows = []
        known_cid = identity.get("containerId") if identity else None
        if known_cid:
            cid_rows = [row for row in all_rows if row[0] == known_cid]
        if len(name_rows) > 1 or len(cid_rows) > 1:
            raise LifecycleError("recovery listing returned duplicate container rows")
        if name_rows:
            if name_rows[0][1] != lease["containerName"]:
                raise LifecycleError("recovery found a same-name container with a different name")
            container = lifecycle.inspect_container("recovery-container-inspect", name_rows[0][0])
            problem = _validate_container(container, lease, identity)
            if problem:
                raise LifecycleError(problem)
            if cid_rows and cid_rows[0][0] != container["Id"]:
                raise LifecycleError("same-name and captured-CID observations disagree")
            identity = {
                "containerId": container["Id"],
                "name": container["Name"],
                "imageId": container["Image"],
                "configuredImage": container["Config"]["Image"],
                "stateVolume": lease["stateVolume"],
                "sourceSha": lease["sourceSha"],
                "builder": lease["builder"],
            }
            removed = lifecycle.call(
                "remove-exact-owned-container",
                ["container", "rm", "--force", "--volumes", container["Id"]],
                10,
            )
            if removed.code != 0:
                lifecycle.record_local(
                    "container-remove-error-retained",
                    {"exitCode": removed.code, "timedOut": removed.timed_out},
                )
        elif cid_rows:
            raise LifecycleError("captured builder CID remains under an unexpected name")

        # Container -v removes anonymous volumes only. The BuildKit state volume
        # is named and must be separately matched and removed without --force.
        final_name_rows = lifecycle.list_containers(
            "verify-container-name-absence", ["--filter", f"name=^/{lease['containerName']}$"]
        )
        final_cid_rows = []
        if identity and identity.get("containerId"):
            final_cid_rows = lifecycle.list_containers(
                "verify-container-cid-absence", ["--filter", f"id={identity['containerId']}"]
            )
        if final_name_rows or final_cid_rows:
            raise LifecycleError("owned container name or CID is still present")

        volume_rows = lifecycle.list_volumes("recovery-state-volume", lease["stateVolume"])
        if volume_rows:
            if volume_rows != [lease["stateVolume"]]:
                raise LifecycleError("recovery found an unexpected state volume row")
            volume = lifecycle.inspect_volume("recovery-volume-inspect", lease["stateVolume"])
            problem = _validate_volume(volume, lease, expected_volume)
            if problem:
                raise LifecycleError(problem)
            users = lifecycle.list_containers(
                "verify-state-volume-unused", ["--filter", f"volume={lease['stateVolume']}"]
            )
            if users:
                raise LifecycleError("owned state volume is still attached to a container")
            removed = lifecycle.call(
                "remove-exact-owned-state-volume",
                ["volume", "rm", lease["stateVolume"]],
                15,
            )
            if removed.code != 0:
                lifecycle.record_local(
                    "volume-remove-error-retained",
                    {"exitCode": removed.code, "timedOut": removed.timed_out},
                )
                retry_rows = lifecycle.list_volumes(
                    "reobserve-state-volume-after-remove-error", lease["stateVolume"]
                )
                if retry_rows:
                    if retry_rows != [lease["stateVolume"]]:
                        raise LifecycleError("post-error state volume name is not exact")
                    retry_volume = lifecycle.inspect_volume(
                        "reinspect-state-volume-after-remove-error", lease["stateVolume"]
                    )
                    problem = _validate_volume(retry_volume, lease, expected_volume)
                    if problem:
                        raise LifecycleError(problem)
                    retry_users = lifecycle.list_containers(
                        "recheck-state-volume-users-after-remove-error",
                        ["--filter", f"volume={lease['stateVolume']}"],
                    )
                    if retry_users:
                        raise LifecycleError("state volume remains attached after remove error")
                    retry = lifecycle.call(
                        "retry-remove-reobserved-state-volume",
                        ["volume", "rm", lease["stateVolume"]],
                        10,
                    )
                    if retry.code != 0:
                        retry_rows = lifecycle.list_volumes(
                            "terminal-check-state-volume-after-retry", lease["stateVolume"]
                        )
                        if retry_rows:
                            raise LifecycleError("owned state volume remains after bounded retry")

        # Prove both Docker resources absent before closing Buildx's local record.
        premetadata_rows = lifecycle.list_all_containers("pre-metadata-container-inventory")
        if any(name == lease["containerName"] for _, name in premetadata_rows):
            raise LifecycleError("container reappeared before metadata closure")
        if identity and any(cid == identity["containerId"] for cid, _ in premetadata_rows):
            raise LifecycleError("container CID remains before metadata closure")
        if lifecycle.list_volumes("pre-metadata-volume-absence", lease["stateVolume"]):
            raise LifecycleError("state volume remains before metadata closure")

        builders = lifecycle.list_builders("pre-metadata-builder-registration")
        if _builder_rows_include(builders, lease["builder"]):
            if not lease.get("builderCreateAttempted") or not identity:
                raise LifecycleError("refusing to close unproven builder metadata")
            close = lifecycle.call(
                "close-exact-builder-metadata",
                ["buildx", "rm", "--force", "--keep-daemon", "--timeout", "0", lease["builder"]],
                5,
            )
            if close.code != 0:
                lifecycle.record_local(
                    "metadata-close-error-retained",
                    {"exitCode": close.code, "timedOut": close.timed_out},
                )

        # Final independent observations are all required for success.
        terminal_rows = lifecycle.list_all_containers("terminal-container-inventory")
        final_names = [row for row in terminal_rows if row[1] == lease["containerName"]]
        final_ids = [row for row in terminal_rows if identity and row[0] == identity["containerId"]]
        final_volumes = lifecycle.list_volumes("terminal-state-volume-absence", lease["stateVolume"])
        final_builders = lifecycle.list_builders("terminal-builder-metadata-absence")
        if final_names or final_ids or final_volumes or lease["builder"] in final_builders:
            raise LifecycleError("terminal absence proof failed for builder, container, or state volume")

        outcome = "closed"
        return_code = 0
    except Exception as error:
        outcome = "unknown"
        reason = str(error)
        return_code = 1
        print(f"builder cleanup incomplete: {error}", file=sys.stderr)
    finally:
        _terminal_receipt(
            proof, lease, lifecycle.events, outcome, reason,
            lifecycle.first_failure, identity
        )
    return return_code


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--proof", required=True)
    create.add_argument("--builder", required=True)
    create.add_argument("--source-sha", required=True)
    create.add_argument("--run-id", required=True)
    create.add_argument("--run-attempt", required=True)
    cleanup = sub.add_parser("cleanup")
    cleanup.add_argument("--proof", required=True)
    args = parser.parse_args()
    proof = Path(args.proof)
    if args.command == "create":
        return create_builder(proof, args.builder, args.source_sha, args.run_id, args.run_attempt)
    return cleanup_builder(proof)


if __name__ == "__main__":
    raise SystemExit(main())
