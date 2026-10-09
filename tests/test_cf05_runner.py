import datetime as dt
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "cf05-run-mounted-loopback.py"
spec = importlib.util.spec_from_file_location("cf05_runner", SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
ROOT = pathlib.Path("/Users/baldvinsmarason/.codex/worktrees/assistant-playbook-release/assistant")
SHA = "a" * 40
BRANCH = "codex/cf05-mounted-acceptance"


def profile():
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    return {
        "baseUrl": "http://127.0.0.1:3000",
        "appSha": SHA,
        "persistenceDriver": "firestore",
        "firestoreEmulatorHost": "127.0.0.1:8789",
        "firestoreProjectId": "demo-cf05-acceptance",
        "firestoreDatabaseId": "(default)",
        "installationId": "cf05-fixture-12345678",
        "ownerId": "12345678-1234-4234-8234-123456789abc",
        "queueDriver": "local",
        "sourceRoot": str(ROOT),
        "sourceBranch": BRANCH,
        "sourceCommit": SHA,
        "sourceTreeClean": True,
        "serverPid": 12345,
        "serverCommandSha256": "c" * 64,
        "serverWorkingDirectory": str(ROOT),
        "firestoreEmulatorPid": 23456,
        "isolatedDatabaseConfirmed": True,
        "installationOwnerCount": 1,
        "noWorkerAttached": True,
        "providerCallsDisabled": True,
        "verificationStatus": "root-verified",
        "verifiedAt": now,
    }


class RunnerProfileTests(unittest.TestCase):
    def check(self, data):
        runner.check_manifest(data, expected_sha=SHA, expected_branch=BRANCH,
                              source_root=ROOT, app_url="http://127.0.0.1:3000")

    def test_accepts_exact_isolated_loopback_profile(self):
        self.check(profile())

    def test_accepts_exact_web_app_working_directory(self):
        data = profile()
        data["serverWorkingDirectory"] = str(ROOT / "apps" / "web")
        self.check(data)

    def test_rejects_other_working_directories(self):
        for value in (str(ROOT / "apps"), str(ROOT / "packages"), "/tmp"):
            data = profile(); data["serverWorkingDirectory"] = value
            with self.subTest(value=value), self.assertRaises(runner.CheckError): self.check(data)

    def test_rejects_hosted_app_or_firestore_targets(self):
        for key, value in (("baseUrl", "https://example.com"),
                           ("firestoreEmulatorHost", "firestore.googleapis.com:443")):
            data = profile(); data[key] = value
            with self.subTest(key=key), self.assertRaises(runner.CheckError): self.check(data)

    def test_rejects_wrong_source_or_dirty_worktree(self):
        for key, value in (("sourceCommit", "b" * 40), ("sourceBranch", "main"),
                           ("sourceTreeClean", False), ("serverWorkingDirectory", "/tmp")):
            data = profile(); data[key] = value
            with self.subTest(key=key), self.assertRaises(runner.CheckError): self.check(data)

    def test_rejects_non_emulator_storage_and_nonlocal_queue(self):
        for key, value in (("firestoreProjectId", "production-project"),
                           ("persistenceDriver", "postgres"), ("queueDriver", "cloudtasks"),
                           ("isolatedDatabaseConfirmed", False)):
            data = profile(); data[key] = value
            with self.subTest(key=key), self.assertRaises(runner.CheckError): self.check(data)

    def test_rejects_worker_or_provider_capability(self):
        for key, value in (("noWorkerAttached", False), ("providerCallsDisabled", False)):
            data = profile(); data[key] = value
            with self.subTest(key=key), self.assertRaises(runner.CheckError): self.check(data)

    def test_rejects_stale_or_shared_owner_profiles(self):
        data = profile(); data["verifiedAt"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=6)).isoformat()
        with self.assertRaises(runner.CheckError): self.check(data)
        data = profile(); data["installationOwnerCount"] = 2
        with self.assertRaises(runner.CheckError): self.check(data)
        data = profile(); data["installationId"] = "production"
        with self.assertRaises(runner.CheckError): self.check(data)

    def test_expired_manifest_after_browser_latency_blocks_adapter_launch(self):
        data = profile()
        verified = dt.datetime.fromisoformat(data["verifiedAt"])
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = pathlib.Path(directory) / "root-manifest.json"
            manifest_path.write_text(json.dumps(data), encoding="utf-8")
            launched = []
            with patch.object(runner, "verify_live"):
                runner.verify_fixture_preflight(
                    manifest_path,
                    expected_sha=SHA,
                    expected_branch=BRANCH,
                    source_root=ROOT,
                    app_url="http://127.0.0.1:3000",
                    now=verified + dt.timedelta(seconds=1),
                )
                launched.append("browser")
                with self.assertRaises(runner.CheckError):
                    runner.verify_fixture_preflight(
                        manifest_path,
                        expected_sha=SHA,
                        expected_branch=BRANCH,
                        source_root=ROOT,
                        app_url="http://127.0.0.1:3000",
                        now=verified + dt.timedelta(seconds=301),
                    )
                self.assertEqual(launched, ["browser"])

    def test_accepts_only_plain_loopback_origin(self):
        for value in ("https://127.0.0.1:3000", "http://example.com:3000", "http://127.0.0.1:3000/path", "http://user@127.0.0.1:3000"):
            with self.subTest(value=value), self.assertRaises(runner.CheckError): runner.parse_loopback_url(value)


if __name__ == "__main__":
    unittest.main()
