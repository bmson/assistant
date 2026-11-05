#!/usr/bin/env python3
"""Database-free negative and recovery controls for Buildx resource teardown."""

from __future__ import annotations

import importlib.util
import json
import time
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("buildx-builder-lifecycle.py")
SPEC = importlib.util.spec_from_file_location("buildx_builder_lifecycle", MODULE_PATH)
assert SPEC and SPEC.loader
LIFECYCLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LIFECYCLE)


def lease_fixture(proof: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    lease = LIFECYCLE._new_lease("memory-witness-135-test-1-1", "a" * 40, "1", "1")
    lease.update(preflightPassed=True, volumeCreateAttempted=True, builderCreateAttempted=True)
    LIFECYCLE._write_json_durable(proof / "builder-owner-lease.json", lease)
    volume = {
        "Name": lease["stateVolume"],
        "Driver": "local",
        "Scope": "local",
        "Labels": lease["volumeLabels"],
        "CreatedAt": lease["createdAt"],
        "Mountpoint": "/var/lib/docker/volumes/test/_data",
    }
    container = {
        "Id": "c" * 64,
        "Name": f"/{lease['containerName']}",
        "Image": "sha256:" + "d" * 64,
        "Config": {
            "Image": LIFECYCLE.BUILDKIT_IMAGE,
            "Env": [f"{LIFECYCLE.OWNER_ENV}={lease['ownerToken']}"],
        },
        "HostConfig": {
            "Memory": LIFECYCLE.MEMORY,
            "MemorySwap": LIFECYCLE.MEMORY,
            "CpuQuota": LIFECYCLE.CPU_QUOTA,
            "CpuPeriod": LIFECYCLE.CPU_PERIOD,
            "RestartPolicy": {"Name": "no"},
        },
        "Mounts": [{
            "Type": "volume",
            "Name": lease["stateVolume"],
            "Destination": LIFECYCLE.BUILDKIT_STATE_DIR,
        }],
    }
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
        "sourceSha": lease["sourceSha"],
        "builder": lease["builder"],
    }
    LIFECYCLE._write_json_durable(proof / "builder-identity.json", identity)
    LIFECYCLE._write_json_durable(proof / "builder-volume-identity.json", volume)
    return lease, volume, container


class FakeDocker:
    def __init__(self, lease, volume=None, container=None, registered=True):
        self.lease = lease
        self.volume = volume
        self.container = container
        self.registered = registered
        self.commands: list[list[str]] = []
        self.volume_rm_behavior = "success"
        self.volume_rm_calls = 0
        self.volume_ls_after_rm: list[str] = []
        self.volume_ls_after_rm_calls = 0
        self.fail_volume_listing_after_rm = False
        self.volume_ls_failures_remaining = 0
        self.replace_volume_after_rm: dict[str, Any] | None = None
        self.volume_rm_delay = 0.0
        self.fail_container_listing = False
        self.foreign_volume_user = False

    def run(self, args, timeout):
        self.commands.append(args)
        if args[:2] == ["container", "ls"]:
            if self.fail_container_listing:
                return LIFECYCLE.Result(args, 1, stderr="daemon unavailable")
            filters = [args[i + 1] for i, value in enumerate(args[:-1]) if value == "--filter"]
            if any(value.startswith("name=") for value in filters):
                expected = self.lease["containerName"]
                rows = [(self.container["Id"], expected)] if self.container else []
            elif any(value.startswith("id=") for value in filters):
                cid = next(value[3:] for value in filters if value.startswith("id="))
                rows = [(self.container["Id"], self.container["Name"].lstrip("/"))] if self.container and self.container["Id"] == cid else []
            elif any(value.startswith("volume=") for value in filters):
                rows = []
                if self.container and self.lease["stateVolume"] in [m["Name"] for m in self.container["Mounts"]]:
                    rows.append((self.container["Id"], self.container["Name"].lstrip("/")))
                if self.foreign_volume_user:
                    rows.append(("f" * 64, "foreign-container"))
            elif not filters:
                rows = [(self.container["Id"], self.container["Name"].lstrip("/"))] if self.container else []
            else:
                return LIFECYCLE.Result(args, 2, stderr="unexpected container filter")
            stdout = "".join(f"{cid} {name}\n" for cid, name in rows)
            return LIFECYCLE.Result(args, 0, stdout=stdout)

        if args[:2] == ["container", "inspect"]:
            cid = args[-1]
            if self.container and cid in (self.container["Id"], self.lease["containerName"]):
                return LIFECYCLE.Result(args, 0, json.dumps([self.container]))
            return LIFECYCLE.Result(args, 1, stderr=f"Error: No such object: {cid}")

        if args[:2] == ["volume", "ls"]:
            if self.volume_rm_calls and self.fail_volume_listing_after_rm:
                return LIFECYCLE.Result(args, 1, stderr="daemon unavailable after remove")
            if self.volume_rm_calls and self.volume_ls_failures_remaining:
                self.volume_ls_failures_remaining -= 1
                return LIFECYCLE.Result(args, 124, stderr="volume listing timed out", timed_out=True)
            if self.volume_rm_calls and self.volume_ls_after_rm:
                index = min(self.volume_ls_after_rm_calls, len(self.volume_ls_after_rm) - 1)
                observed = self.volume_ls_after_rm[index]
                self.volume_ls_after_rm_calls += 1
                if observed == "absent":
                    self.volume = None
                elif observed == "replacement" and self.replace_volume_after_rm:
                    self.volume = dict(self.replace_volume_after_rm)
                return LIFECYCLE.Result(
                    args, 0, stdout=f"{self.lease['stateVolume']}\n" if self.volume else ""
                )
            name = self.lease["stateVolume"]
            return LIFECYCLE.Result(args, 0, stdout=f"{name}\n" if self.volume else "")

        if args[:2] == ["volume", "inspect"]:
            if self.volume and args[-1] == self.volume["Name"]:
                return LIFECYCLE.Result(args, 0, json.dumps([self.volume]))
            return LIFECYCLE.Result(args, 1, stderr="no such volume")

        if args[:2] == ["buildx", "ls"]:
            rows = ["default"]
            if self.registered:
                rows.extend([self.lease["builder"], self.lease["containerName"].removeprefix("buildx_buildkit_")])
            return LIFECYCLE.Result(args, 0, stdout="\n".join(rows) + "\n")

        if args[:2] == ["buildx", "rm"]:
            if "--keep-daemon" in args:
                self.registered = False
                return LIFECYCLE.Result(args, 0)
            return LIFECYCLE.Result(args, 2, stderr="resource removal must use exact ownership")

        if args[:2] == ["container", "rm"]:
            if "--volumes" not in args or "--force" not in args:
                return LIFECYCLE.Result(args, 2, stderr="missing exact remove controls")
            if not self.container or args[-1] != self.container["Id"]:
                return LIFECYCLE.Result(args, 1, stderr="wrong container ID")
            self.container = None
            return LIFECYCLE.Result(args, 0)

        if args[:2] == ["volume", "rm"]:
            if "--force" in args:
                return LIFECYCLE.Result(args, 2, stderr="force volume delete is forbidden")
            if self.foreign_volume_user or self.container:
                return LIFECYCLE.Result(args, 1, stderr="volume is in use")
            self.volume_rm_calls += 1
            if self.volume_rm_delay:
                time.sleep(self.volume_rm_delay)
            if self.volume_rm_behavior == "timeout-nochange" and self.volume_rm_calls == 1:
                return LIFECYCLE.Result(args, 124, stderr="volume rm timed out", timed_out=True)
            if self.volume_rm_behavior in ("timeout-removed", "error-removed") and self.volume_rm_calls == 1:
                self.volume = None
                if self.volume_rm_behavior == "error-removed":
                    return LIFECYCLE.Result(args, 1, stderr="daemon error after volume removal")
                return LIFECYCLE.Result(args, 124, stderr="volume rm timed out", timed_out=True)
            if self.volume_rm_behavior == "success-busy" and self.volume_rm_calls == 1:
                return LIFECYCLE.Result(args, 0)
            self.volume = None
            return LIFECYCLE.Result(args, 0)

        return LIFECYCLE.Result(args, 2, stderr=f"unexpected command: {args}")


class BuilderLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.proof = Path(self.temp.name)
        self.lease, self.volume, self.container = lease_fixture(self.proof)
        self.runner = FakeDocker(self.lease, dict(self.volume), dict(self.container))

    def tearDown(self):
        self.temp.cleanup()

    def receipt(self):
        return json.loads((self.proof / "builder-cleanup-receipt.json").read_text())

    def test_timeout_then_exact_recovery_closes_and_retains_first_failure(self):
        self.runner.volume_rm_behavior = "timeout-nochange"
        self.runner.volume_ls_after_rm = ["present", "absent"]
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        receipt = self.receipt()
        self.assertEqual(receipt["status"], "closed_with_error")
        self.assertFalse(receipt["qualificationPassed"])
        self.assertEqual(receipt["firstCleanupError"]["exitCode"], 124)
        self.assertEqual(receipt["firstMutationError"]["exitCode"], 124)
        self.assertTrue(receipt["firstCleanupError"]["timedOut"])
        self.assertEqual(self.runner.volume_rm_calls, 1)
        self.assertIsNone(self.runner.container)
        self.assertIsNone(self.runner.volume)
        self.assertFalse(self.runner.registered)

    def test_timed_out_delete_already_absent_still_gets_independent_final_proof(self):
        self.runner.volume_rm_behavior = "timeout-removed"
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["firstCleanupError"]["exitCode"], 124)
        self.assertEqual(self.receipt()["status"], "closed_with_error")
        self.assertEqual(self.runner.volume_rm_calls, 1)
        stages = [event.get("stage") for event in self.receipt()["observationsAndActions"]]
        self.assertIn("terminal-container-inventory", stages)
        self.assertIn("terminal-state-volume-absence", stages)

    def test_nonzero_volume_remove_with_resource_absent_retains_error(self):
        self.runner.volume_rm_behavior = "error-removed"
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["firstCleanupError"]["exitCode"], 1)
        self.assertEqual(self.receipt()["firstMutationError"]["exitCode"], 1)
        self.assertEqual(self.receipt()["status"], "closed_with_error")
        self.assertFalse(self.runner.registered)

    def test_unknown_observation_fails_before_any_mutation(self):
        self.runner.fail_container_listing = True
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["status"], "unknown")
        self.assertFalse(any(command[:2] in (["buildx", "rm"], ["container", "rm"], ["volume", "rm"]) for command in self.runner.commands))

    def test_same_name_but_mismatched_cid_fails_closed(self):
        self.runner.container["Id"] = "e" * 64
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["status"], "unknown")
        self.assertIsNotNone(self.runner.container)
        self.assertFalse(any(command[:2] == ["buildx", "rm"] for command in self.runner.commands))

    def test_same_name_and_cid_but_mismatched_image_fails_closed(self):
        self.runner.container["Image"] = "sha256:" + "e" * 64
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["status"], "unknown")
        self.assertIsNotNone(self.runner.container)
        self.assertFalse(any(command[:2] == ["buildx", "rm"] for command in self.runner.commands))

    def test_wrong_volume_owner_labels_fail_before_mutation(self):
        self.runner.volume["Labels"][LIFECYCLE.OWNER_LABEL] = "foreign"
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["status"], "unknown")
        self.assertIsNotNone(self.runner.volume)
        self.assertFalse(any(command[:2] == ["buildx", "rm"] for command in self.runner.commands))

    def test_same_name_replacement_volume_fails_captured_created_at_identity(self):
        self.runner.volume["CreatedAt"] = "2999-01-01T00:00:00+00:00"
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["status"], "unknown")
        self.assertIsNotNone(self.runner.volume)
        self.assertFalse(any(command[:2] == ["volume", "rm"] for command in self.runner.commands))

    def test_shared_state_volume_fails_before_mutation(self):
        self.runner.foreign_volume_user = True
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["status"], "unknown")
        self.assertIsNotNone(self.runner.container)
        self.assertIsNotNone(self.runner.volume)
        self.assertFalse(any(command[:2] == ["buildx", "rm"] for command in self.runner.commands))

    def test_slow_volume_delete_over_15_seconds_can_complete_within_50_second_bound(self):
        self.runner.volume_rm_delay = 15.1
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 0)
        event = next(
            item for item in self.receipt()["observationsAndActions"]
            if item.get("stage") == "remove-exact-owned-state-volume"
        )
        self.assertGreaterEqual(event["timeoutSeconds"], 50)
        self.assertGreater(event["elapsedSeconds"], 15)
        self.assertEqual(self.runner.volume_rm_calls, 1)

    def test_timed_out_delete_busy_then_absent_closes_but_fails_qualification(self):
        self.runner.volume_rm_behavior = "timeout-nochange"
        self.runner.volume_ls_after_rm = ["present", "absent"]
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        receipt = self.receipt()
        stages = [event.get("stage") for event in receipt["observationsAndActions"]]
        self.assertIn("state-volume-still-present-observed", stages)
        self.assertIn("state-volume-absence-observed", stages)
        self.assertEqual(self.runner.volume_rm_calls, 1)
        self.assertEqual(receipt["status"], "closed_with_error")

    def test_successful_delete_with_transient_busy_read_then_absence_passes(self):
        self.runner.volume_rm_behavior = "success-busy"
        self.runner.volume_ls_after_rm = ["present", "absent"]
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 0)
        receipt = self.receipt()
        self.assertEqual(receipt["status"], "closed")
        self.assertTrue(receipt["qualificationPassed"])
        self.assertIsNone(receipt["firstMutationError"])
        self.assertEqual(self.runner.volume_rm_calls, 1)
        self.assertFalse(self.runner.registered)

    def test_transient_timed_out_volume_list_retries_to_known_absence(self):
        self.runner.volume_rm_behavior = "success-busy"
        self.runner.volume_ls_failures_remaining = 1
        self.runner.volume_ls_after_rm = ["absent"]
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 0)
        receipt = self.receipt()
        self.assertEqual(receipt["status"], "closed")
        self.assertTrue(receipt["qualificationPassed"])
        self.assertIsNone(receipt["firstMutationError"])
        self.assertEqual(receipt["firstCleanupError"]["exitCode"], 124)
        stages = [event.get("stage") for event in receipt["observationsAndActions"]]
        self.assertIn("state-volume-list-observation-unavailable", stages)
        self.assertIn("state-volume-absence-observed", stages)
        self.assertEqual(self.runner.volume_rm_calls, 1)

    def test_unknown_volume_observation_after_mutation_fails_without_metadata_close(self):
        self.runner.volume_rm_behavior = "timeout-nochange"
        self.runner.fail_volume_listing_after_rm = True
        with patch.object(LIFECYCLE, "POST_REMOVE_OBSERVATION_SECONDS", 0.03), patch.object(
            LIFECYCLE, "POST_REMOVE_POLL_SECONDS", 0.002
        ), patch.object(LIFECYCLE, "POST_REMOVE_READ_DRAIN_RESERVE_SECONDS", 0.001):
            self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["status"], "unknown")
        self.assertEqual(self.receipt()["firstMutationError"]["exitCode"], 124)
        self.assertTrue(self.runner.registered)
        self.assertFalse(any(command[:2] == ["buildx", "rm"] for command in self.runner.commands))

    def test_persistently_present_owned_volume_fails_deadline_without_second_delete(self):
        self.runner.volume_rm_behavior = "timeout-nochange"
        with patch.object(LIFECYCLE, "POST_REMOVE_OBSERVATION_SECONDS", 0.03), patch.object(
            LIFECYCLE, "POST_REMOVE_POLL_SECONDS", 0.002
        ), patch.object(LIFECYCLE, "POST_REMOVE_READ_DRAIN_RESERVE_SECONDS", 0.001):
            self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["status"], "unknown")
        self.assertEqual(self.runner.volume_rm_calls, 1)
        self.assertTrue(self.runner.registered)
        self.assertFalse(any(command[:2] == ["buildx", "rm"] for command in self.runner.commands))

    def test_same_name_replacement_after_remove_fails_without_metadata_close(self):
        self.runner.volume_rm_behavior = "timeout-nochange"
        self.runner.volume_ls_after_rm = ["replacement"]
        self.runner.replace_volume_after_rm = dict(self.volume)
        self.runner.replace_volume_after_rm["Mountpoint"] = "/foreign/replacement"
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["status"], "unknown")
        self.assertEqual(self.runner.volume_rm_calls, 1)
        self.assertTrue(self.runner.registered)
        self.assertFalse(any(command[:2] == ["buildx", "rm"] for command in self.runner.commands))

    def test_missing_lease_fails_without_docker_commands(self):
        (self.proof / "builder-owner-lease.json").unlink()
        self.runner.commands.clear()
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["status"], "unknown")
        self.assertEqual(self.runner.commands, [])

    def test_partial_create_same_name_replacement_without_owner_nonce_fails(self):
        (self.proof / "builder-identity.json").unlink()
        self.runner.container["Config"]["Env"] = [f"{LIFECYCLE.OWNER_ENV}=public-run-metadata"]
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["status"], "unknown")
        self.assertIsNotNone(self.runner.container)
        self.assertFalse(any(command[:2] == ["container", "rm"] for command in self.runner.commands))

    def test_builder_registration_without_identity_is_not_removed(self):
        (self.proof / "builder-identity.json").unlink()
        self.runner.container = None
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 1)
        self.assertEqual(self.receipt()["status"], "unknown")
        self.assertTrue(self.runner.registered)
        self.assertFalse(any(command[:2] == ["buildx", "rm"] for command in self.runner.commands))

    def test_owner_nonce_is_not_derived_from_public_run_metadata(self):
        one = LIFECYCLE._new_lease("builder", "a" * 40, "1", "1")
        two = LIFECYCLE._new_lease("builder", "a" * 40, "1", "1")
        self.assertNotEqual(one["ownerToken"], two["ownerToken"])

    def test_preflight_rejects_existing_builder_container_or_state_volume(self):
        cases = [
            ([("c" * 64, self.lease["containerName"])], [], set()),
            ([], [self.lease["stateVolume"]], set()),
            ([], [], {self.lease["builder"]}),
        ]
        for container_rows, volume_rows, builders in cases:
            with self.subTest(container_rows=container_rows, volume_rows=volume_rows, builders=builders):
                with self.assertRaises(LIFECYCLE.LifecycleError):
                    LIFECYCLE.assert_preflight_clear(
                        container_rows, volume_rows, builders, self.lease["builder"]
                    )
        LIFECYCLE.assert_preflight_clear([], [], {"default"}, self.lease["builder"])

    def test_docker_second_precision_timestamp_equal_to_lease_is_accepted(self):
        rounded = dict(self.volume)
        rounded["CreatedAt"] = self.lease["createdAt"].replace("+00:00", "Z")
        rounded_lease = dict(self.lease)
        rounded_lease["createdAt"] = self.lease["createdAt"]
        self.assertIsNone(LIFECYCLE._validate_volume(rounded, rounded_lease))

    def test_preflight_deadline_refuses_request_before_remaining_budget_is_exhausted(self):
        lifecycle = LIFECYCLE.Lifecycle(self.proof, runner=self.runner, budget_seconds=0.001)
        with self.assertRaises(LIFECYCLE.LifecycleError):
            lifecycle.call("deadline-control", ["container", "ls"], 2)
        self.assertEqual(self.runner.commands, [])

    def test_successful_owned_teardown_proves_terminal_absence(self):
        self.assertEqual(LIFECYCLE.cleanup_builder(self.proof, self.runner), 0)
        self.assertEqual(self.receipt()["status"], "closed")
        self.assertIsNone(self.runner.container)
        self.assertIsNone(self.runner.volume)
        self.assertFalse(self.runner.registered)


class DockerRunnerTests(unittest.TestCase):
    def test_term_then_exit_is_reported_drained_and_bounded(self):
        process = unittest.mock.Mock()
        process.pid = 123
        process.returncode = -15
        process.communicate.side_effect = [
            subprocess.TimeoutExpired(["docker", "volume", "rm"], 1),
            ("", "terminated"),
        ]
        process.stdout = unittest.mock.Mock()
        process.stderr = unittest.mock.Mock()
        with patch("subprocess.Popen", return_value=process), patch(
            "os.killpg", side_effect=ProcessLookupError
        ) as killpg:
            result = LIFECYCLE.DockerRunner().run(["volume", "rm", "owned"], 1)
        self.assertEqual(result.code, 124)
        self.assertTrue(result.timed_out)
        self.assertTrue(result.drained)
        killpg.assert_any_call(123, LIFECYCLE.signal.SIGTERM)
        killpg.assert_any_call(123, 0)

    def test_forced_kill_path_requires_group_absence(self):
        process = unittest.mock.Mock()
        process.pid = 234
        process.returncode = -9
        process.communicate.side_effect = [
            subprocess.TimeoutExpired(["docker"], 1),
            subprocess.TimeoutExpired(["docker"], 2),
            ("", ""),
        ]
        process.stdout = unittest.mock.Mock()
        process.stderr = unittest.mock.Mock()
        with patch("subprocess.Popen", return_value=process), patch("os.killpg") as killpg, patch.object(
            LIFECYCLE.DockerRunner,
            "_wait_group_gone",
            side_effect=[False, False, True],
        ):
            result = LIFECYCLE.DockerRunner().run(["volume", "rm", "owned"], 1)
        self.assertTrue(result.timed_out)
        self.assertTrue(result.drained)
        killpg.assert_any_call(234, LIFECYCLE.signal.SIGTERM)
        killpg.assert_any_call(234, LIFECYCLE.signal.SIGKILL)

    def test_normal_parent_exit_kills_child_that_closed_inherited_pipes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "fake-docker"
            pid_file = root / "child.pid"
            marker = root / "child.term"
            ready_file = root / "child.ready"
            child = (
                "import signal,sys,time\n"
                "marker=sys.argv[1]\n"
                "ready=sys.argv[2]\n"
                "def stop(*_):\n open(marker,'w').write('term'); raise SystemExit(0)\n"
                "signal.signal(signal.SIGTERM,stop)\n"
                "open(ready,'w').write('ready')\n"
                "time.sleep(30)\n"
            )
            script.write_text(
                "#!/usr/bin/env python3\n"
                "import subprocess,sys,time\n"
                f"child=subprocess.Popen([sys.executable,'-c',{child!r},sys.argv[2],sys.argv[3]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n"
                "open(sys.argv[1],'w').write(str(child.pid))\n"
                "deadline=time.monotonic()+3\n"
                "while time.monotonic()<deadline and not __import__('os').path.exists(sys.argv[3]): time.sleep(.01)\n"
                "assert __import__('os').path.exists(sys.argv[3])\n"
            )
            script.chmod(0o700)
            result = LIFECYCLE.DockerRunner(str(script)).run(
                [str(pid_file), str(marker), str(ready_file)], 3
            )
            self.assertEqual(result.code, 0)
            self.assertTrue(result.drained)
            self.assertTrue(marker.exists())

if __name__ == "__main__":
    unittest.main(verbosity=2)
