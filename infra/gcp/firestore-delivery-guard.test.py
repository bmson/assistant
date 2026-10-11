#!/usr/bin/env python3
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("firestore-delivery-guard.py")
spec = importlib.util.spec_from_file_location("delivery_guard", SCRIPT)
guard_module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(guard_module)


PROJECT = "test-project"
LOCATION = "us-west1"
QUEUE = f"projects/{PROJECT}/locations/{LOCATION}/queues/agent-steps"
SCHEDULERS = [
    f"projects/{PROJECT}/locations/{LOCATION}/jobs/{name}"
    for name in ("assistant-sweep", "assistant-gmail-sync", "assistant-gmail-watch")
]
SUBSCRIPTION = f"projects/{PROJECT}/subscriptions/gmail-events-push"
AGENT_URL = "https://assistant-agent-test-abcdef-uw.a.run.app"
PUSH = {"pushEndpoint": f"{AGENT_URL}{guard_module.PUSH_PATH}", "oidcToken": {"audience": "test"}}


class FakeApi:
    def __init__(self):
        self.queue_state = "RUNNING"
        self.scheduler_states = {name: "ENABLED" for name in SCHEDULERS}
        self.push_config = json.loads(json.dumps(PUSH))
        self.calls = []
        self.permissions = None
        self.fail_pause_scheduler = None
        self.active_tasks = []
        self.executions = {}
        self.missing_jobs = set()
        self.external_change_before_restore = None

    def request(self, method, url, payload=None):
        self.calls.append((method, url, payload))
        if url.endswith(":testIamPermissions"):
            if self.permissions is not None:
                return {"permissions": self.permissions}
            return {"permissions": payload["permissions"]}
        if url == f"https://cloudtasks.googleapis.com/v2/{QUEUE}":
            return {"state": self.queue_state}
        if url.startswith(f"https://cloudtasks.googleapis.com/v2/{QUEUE}/tasks?"):
            return {"tasks": list(self.active_tasks)}
        if url.startswith("https://run.googleapis.com/v2/") and "/executions?" in url:
            job_name = url.removeprefix("https://run.googleapis.com/v2/").split("/executions?", 1)[0]
            return {"executions": list(self.executions.get(job_name, []))}
        if url.startswith("https://run.googleapis.com/v2/") and ":testIamPermissions" not in url:
            name = url.removeprefix("https://run.googleapis.com/v2/")
            if name in self.missing_jobs:
                raise guard_module.GoogleApiError(404, "not found")
            return {"name": name}
        if url == f"https://pubsub.googleapis.com/v1/{SUBSCRIPTION}":
            return {"pushConfig": json.loads(json.dumps(self.push_config))}
        if url == f"https://cloudtasks.googleapis.com/v2/{QUEUE}:pause":
            self.queue_state = "PAUSED"
            return {"state": self.queue_state}
        if url == f"https://cloudtasks.googleapis.com/v2/{QUEUE}:resume":
            self.queue_state = "RUNNING"
            return {"state": self.queue_state}
        if url.startswith("https://cloudscheduler.googleapis.com/v1/") and url.endswith(":pause"):
            name = url.removeprefix("https://cloudscheduler.googleapis.com/v1/").removesuffix(":pause")
            if name == self.fail_pause_scheduler:
                raise guard_module.GuardError("simulated scheduler pause failure")
            self.scheduler_states[name] = "PAUSED"
            return {}
        if url.startswith("https://cloudscheduler.googleapis.com/v1/") and url.endswith(":resume"):
            name = url.removeprefix("https://cloudscheduler.googleapis.com/v1/").removesuffix(":resume")
            self.scheduler_states[name] = "ENABLED"
            return {}
        if url.startswith("https://cloudscheduler.googleapis.com/v1/"):
            name = url.removeprefix("https://cloudscheduler.googleapis.com/v1/").split(":")[0]
            return {"state": self.scheduler_states[name]}
        if url == f"https://pubsub.googleapis.com/v1/{SUBSCRIPTION}:modifyPushConfig":
            self.push_config = json.loads(json.dumps(payload["pushConfig"]))
            return {}
        raise AssertionError(f"unexpected request: {method} {url} {payload}")


class DeliveryGuardTests(unittest.TestCase):
    def make_guard(self, api, directory, workers=None):
        return guard_module.DeliveryGuard(
            api,
            PROJECT,
            LOCATION,
            Path(directory) / "guard.json",
            AGENT_URL,
            drain_timeout=1,
            workers=workers,
        )

    def test_missing_permission_fails_before_any_hold_or_receipt(self):
        api = FakeApi()
        api.permissions = ["cloudtasks.queues.get"]
        with tempfile.TemporaryDirectory() as directory:
            guard = self.make_guard(api, directory)
            with self.assertRaisesRegex(guard_module.GuardError, "cloudtasks.queues.pause"):
                guard.acquire()
            self.assertEqual(api.queue_state, "RUNNING")
            self.assertEqual(api.scheduler_states, {name: "ENABLED" for name in SCHEDULERS})
            self.assertEqual(api.push_config, PUSH)
            self.assertFalse(guard.receipt_path.exists())
            self.assertFalse(any(":pause" in call[1] or ":modifyPushConfig" in call[1] for call in api.calls))

    def test_preserves_controls_that_were_already_held(self):
        api = FakeApi()
        api.queue_state = "PAUSED"
        api.scheduler_states[SCHEDULERS[0]] = "PAUSED"
        with tempfile.TemporaryDirectory() as directory:
            guard = self.make_guard(api, directory)
            guard.acquire()
            self.assertEqual(api.queue_state, "PAUSED")
            self.assertEqual(api.scheduler_states[SCHEDULERS[0]], "PAUSED")
            self.assertEqual(api.scheduler_states[SCHEDULERS[1]], "PAUSED")
            guard.restore()
            self.assertEqual(api.queue_state, "PAUSED")
            self.assertEqual(api.scheduler_states[SCHEDULERS[0]], "PAUSED")
            self.assertEqual(api.scheduler_states[SCHEDULERS[1]], "ENABLED")
            self.assertEqual(api.scheduler_states[SCHEDULERS[2]], "ENABLED")
            self.assertEqual(api.push_config, PUSH)

    def test_partial_acquisition_failure_restores_only_owned_holds(self):
        api = FakeApi()
        api.fail_pause_scheduler = SCHEDULERS[1]
        with tempfile.TemporaryDirectory() as directory:
            guard = self.make_guard(api, directory)
            with self.assertRaisesRegex(guard_module.GuardError, "simulated scheduler pause failure"):
                guard.execute(["true"])
            self.assertEqual(api.queue_state, "RUNNING")
            self.assertEqual(api.scheduler_states, {name: "ENABLED" for name in SCHEDULERS})
            self.assertEqual(api.push_config, PUSH)
            self.assertFalse(guard.receipt_path.exists())
            self.assertTrue((Path(directory) / "guard.restored.json").exists())

    def test_release_failure_still_restores_all_holds_and_returns_failure(self):
        api = FakeApi()

        class FailedChild:
            pid = 12345

            def __init__(self, *_args, **_kwargs):
                pass

            def wait(self):
                return 23

        with tempfile.TemporaryDirectory() as directory:
            guard = self.make_guard(api, directory)
            with (
                patch.object(guard_module.subprocess, "Popen", FailedChild),
                patch.object(guard_module.DeliveryGuard, "_stop_process_group"),
            ):
                result = guard.execute(["release-command"])
            self.assertEqual(result, 23)
            self.assertEqual(api.queue_state, "RUNNING")
            self.assertEqual(api.scheduler_states, {name: "ENABLED" for name in SCHEDULERS})
            self.assertEqual(api.push_config, PUSH)
            archived = Path(directory) / "guard.restored.json"
            self.assertTrue(archived.exists())
            self.assertEqual(archived.stat().st_mode & 0o777, 0o600)

    def test_external_state_change_fails_closed_and_keeps_recovery_receipt(self):
        api = FakeApi()
        with tempfile.TemporaryDirectory() as directory:
            guard = self.make_guard(api, directory)
            guard.acquire()
            api.scheduler_states[SCHEDULERS[0]] = "DISABLED"
            with self.assertRaisesRegex(guard_module.GuardError, "receipt retained"):
                guard.restore()
            receipt = json.loads(guard.receipt_path.read_text())
            self.assertIn(
                {"kind": "scheduler", "name": SCHEDULERS[0], "priorState": "ENABLED"},
                receipt["owned"],
            )
            self.assertEqual(api.queue_state, "RUNNING")
            self.assertEqual(api.scheduler_states[SCHEDULERS[0]], "DISABLED")

    def test_tampered_receipt_cannot_target_a_foreign_resource(self):
        api = FakeApi()
        with tempfile.TemporaryDirectory() as directory:
            guard = self.make_guard(api, directory)
            guard.acquire()
            receipt = json.loads(guard.receipt_path.read_text())
            receipt["owned"][0]["name"] = "projects/other/locations/elsewhere/queues/other"
            guard.receipt_path.write_text(json.dumps(receipt))
            mutations_before = [call for call in api.calls if ":resume" in call[1] or ":modifyPushConfig" in call[1]]
            with self.assertRaisesRegex(guard_module.GuardError, "invalid or duplicate Cloud Tasks"):
                guard.restore()
            mutations_after = [call for call in api.calls if ":resume" in call[1] or ":modifyPushConfig" in call[1]]
            self.assertEqual(mutations_after, mutations_before)
            self.assertTrue(guard.receipt_path.exists())

    def test_process_group_stop_kills_release_descendants(self):
        child = subprocess.Popen(["bash", "-c", "sleep 30 & wait"], start_new_session=True)
        process_group = child.pid
        guard_module.DeliveryGuard._stop_process_group(child)
        self.assertFalse(guard_module.DeliveryGuard._process_group_exists(process_group))

    def test_parser_accepts_the_workflow_run_command_shape(self):
        args = guard_module.parse_arguments(
            [
                "run",
                "--project",
                PROJECT,
                "--location",
                LOCATION,
                "--agent-url",
                AGENT_URL,
                "--receipt",
                "/tmp/private-receipt.json",
                "--",
                "bash",
                "infra/gcp/release.sh",
            ]
        )
        self.assertEqual(args.mode, "run")
        self.assertEqual(args.command, ["bash", "infra/gcp/release.sh"])
        self.assertEqual(args.agent_url, AGENT_URL)

    def test_parser_passes_worker_selection_exactly(self):
        args = guard_module.parse_arguments(
            ["run", "--project", PROJECT, "--location", LOCATION, "--receipt", "/tmp/x",
             "--agent-url", AGENT_URL, "--worker-browser", "true", "--worker-code", "false",
             "--worker-processor", "true", "--", "bash", "infra/gcp/release.sh"]
        )
        self.assertEqual((args.worker_browser, args.worker_code, args.worker_processor),
                         ("true", "false", "true"))

    def test_actual_cli_parses_workflow_flags_before_stopping_for_missing_command(self):
        result = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                "run",
                "--project",
                PROJECT,
                "--location",
                LOCATION,
                "--agent-url",
                AGENT_URL,
                "--worker-browser",
                "true",
                "--worker-code",
                "false",
                "--worker-processor",
                "false",
                "--receipt",
                "/tmp/guard-parser-test.json",
                "--",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("run mode requires -- followed by the release command", result.stderr)

    def test_restore_cli_without_receipt_does_not_request_cloud_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "restore",
                    "--project",
                    PROJECT,
                    "--location",
                    LOCATION,
                    "--receipt",
                    str(Path(directory) / "absent.json"),
                ],
                capture_output=True,
                text=True,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("No delivery guard receipt", result.stdout)

    def test_workflow_guards_only_live_firestore_pairs_and_restores_before_cleanup(self):
        workflow = (SCRIPT.parents[2] / ".github/workflows/deploy.yml").read_text()
        resolve = workflow.index("- name: Resolve live release path")
        guarded = workflow.index("- name: Release Firestore pair with delivery guard")
        restore = workflow.index("- name: Restore Firestore delivery guard")
        archive = workflow.index("- name: Archive Firestore delivery guard receipt")
        cleanup = workflow.index("- name: Keep only the current deployment")
        self.assertLess(resolve, guarded)
        self.assertLess(guarded, restore)
        self.assertLess(restore, archive)
        self.assertLess(archive, cleanup)
        self.assertIn("steps.release_path.outputs.firestore_pair == 'true'", workflow)
        self.assertIn("if: always() && steps.release_path.outputs.firestore_pair == 'true'", workflow)
        self.assertIn("-- bash infra/gcp/release.sh", workflow)

    def test_active_task_must_drain_and_timeout_restores_owned_holds(self):
        api = FakeApi()
        api.active_tasks = [
            {"dispatchCount": 1, "responseCount": 0, "lastAttempt": {"dispatchTime": "now"}}
        ]
        with tempfile.TemporaryDirectory() as directory:
            guard = self.make_guard(api, directory)
            with self.assertRaisesRegex(guard_module.GuardError, "in-flight Cloud Tasks execution"):
                guard.execute(["release-command"])
            self.assertEqual(api.queue_state, "RUNNING")
            self.assertEqual(api.scheduler_states, {name: "ENABLED" for name in SCHEDULERS})
            self.assertEqual(api.push_config, PUSH)

    def test_active_selected_worker_execution_times_out_and_restores_holds(self):
        api = FakeApi()
        job = f"projects/{PROJECT}/locations/{LOCATION}/jobs/assistant-browser"
        api.executions[job] = [{"name": f"{job}/executions/active", "startTime": "now"}]
        with tempfile.TemporaryDirectory() as directory:
            guard = self.make_guard(api, directory, workers={"browser": True})
            with self.assertRaisesRegex(guard_module.GuardError, "Cloud Run job execution"):
                guard.execute(["release-command"])
            self.assertEqual(api.queue_state, "RUNNING")
            self.assertEqual(api.scheduler_states, {name: "ENABLED" for name in SCHEDULERS})
            self.assertEqual(api.push_config, PUSH)

    def test_unknown_worker_execution_status_fails_closed_after_holds(self):
        api = FakeApi()
        job = f"projects/{PROJECT}/locations/{LOCATION}/jobs/assistant-code"
        api.executions[job] = [{"name": f"{job}/executions/unknown"}]
        with tempfile.TemporaryDirectory() as directory:
            guard = self.make_guard(api, directory, workers={"code": True})
            with self.assertRaisesRegex(guard_module.GuardError, "unknown status metadata"):
                guard.execute(["release-command"])
            self.assertEqual(api.queue_state, "RUNNING")
            self.assertEqual(api.scheduler_states, {name: "ENABLED" for name in SCHEDULERS})
            self.assertEqual(api.push_config, PUSH)

    def test_paused_pubsub_is_preserved_without_a_mutation(self):
        api = FakeApi()
        api.push_config = {}
        with tempfile.TemporaryDirectory() as directory:
            guard = self.make_guard(api, directory)
            guard.acquire()
            guard.restore()
            self.assertEqual(api.push_config, {})
            self.assertFalse(any(":modifyPushConfig" in call[1] for call in api.calls))


if __name__ == "__main__":
    unittest.main()
