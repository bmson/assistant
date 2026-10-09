import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("cleanup", Path(__file__).with_name("cleanup-current.py"))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)

ROOT = "projects/test/locations/us-west1/repositories/assistant"
PACKAGE = f"{ROOT}/packages/web"
URI = "us-west1-docker.pkg.dev/test/assistant/web"


def image(digest, media_type="application/vnd.docker.distribution.manifest.v2+json"):
    return {"name": f"{ROOT}/dockerImages/web@sha256:{digest}",
            "uri": f"{URI}@sha256:{digest}", "mediaType": media_type}


def tag(name, digest):
    return {"name": f"{PACKAGE}/tags/{name}", "version": f"{PACKAGE}/versions/sha256:{digest}"}


def version(number, state="ENABLED"):
    return {"name": f"projects/test/secrets/auth/versions/{number}", "state": state, "etag": str(number)}


class CleanupTests(unittest.TestCase):
    def test_keeps_deployed_digest_and_only_its_security_metadata(self):
        images = [image(digest) for digest in ("current", "old", "sig", "att", "oldsig")]
        tags = [tag("sha256-current.sig", "sig"), tag("sha256-current.att", "att"),
                tag("sha256-old.sig", "oldsig"), tag("release", "current")]
        keep, delete = cleanup.plan_images(images, tags, [f"{URI}@sha256:current"])
        self.assertEqual(set(keep), {f"{PACKAGE}/versions/sha256:{d}" for d in ("current", "sig", "att")})
        self.assertEqual(set(delete), {f"{PACKAGE}/versions/sha256:{d}" for d in ("old", "oldsig")})

    def test_resolves_job_release_tag_not_newest_uploaded_version(self):
        keep, delete = cleanup.plan_images([image("current"), image("new")],
                                          [tag("release", "current")], [f"{URI}:release"])
        self.assertEqual(keep, [f"{PACKAGE}/versions/sha256:current"])
        self.assertEqual(delete, [f"{PACKAGE}/versions/sha256:new"])

    def test_untagged_oci_referrers_and_nested_security_metadata_are_retained(self):
        names = {d: f"{PACKAGE}/versions/sha256:{d}" for d in ("current", "sig", "att", "old")}
        keep, delete = cleanup.plan_images([image(d) for d in names], [], [f"{URI}@sha256:current"],
            {names["current"]: [names["sig"]], names["sig"]: [names["att"]]})
        self.assertEqual(set(keep), {names[d] for d in ("current", "sig", "att")})
        self.assertEqual(delete, [names["old"]])

    def test_missing_current_oci_metadata_stops_cleanup(self):
        with self.assertRaisesRegex(RuntimeError, "metadata is missing"):
            cleanup.plan_images([image("current")], [], [f"{URI}@sha256:current"],
                {f"{PACKAGE}/versions/sha256:current": [f"{PACKAGE}/versions/sha256:missing"]})

    def test_registry_null_referrers_means_no_security_metadata(self):
        cloud = unittest.mock.Mock()
        cloud.request.return_value = {"manifests": None}
        current = f"{PACKAGE}/versions/sha256:current"
        self.assertEqual(cleanup.image_referrers(cloud, [image("current")], [current]), {current: []})

    def test_image_deletion_removes_tags_and_is_idempotent_for_deleted_referrers(self):
        cloud = unittest.mock.Mock()
        name = f"{PACKAGE}/versions/sha256:old"
        cleanup.delete_image(cloud, name)
        cloud.request.assert_called_once_with(cleanup.ARTIFACTS, f"v1/{name}", method="DELETE", params={"force": "true"})
        cloud.request.side_effect = cleanup.CloudError("Already deleted", 404)
        cleanup.delete_image(cloud, name)
        cloud.request.side_effect = cleanup.CloudError("Permission denied", 403)
        with self.assertRaisesRegex(cleanup.CloudError, "Permission denied"):
            cleanup.delete_image(cloud, name)

    def test_missing_deployed_digest_or_tag_stops_cleanup(self):
        for reference in (f"{URI}@sha256:missing", f"{URI}:missing"):
            with self.assertRaisesRegex(RuntimeError, "missing"):
                cleanup.plan_images([image("current")], [], [reference])

    def test_multi_architecture_index_stops_cleanup(self):
        with self.assertRaisesRegex(RuntimeError, "Multi-architecture"):
            cleanup.plan_images([image("current", "application/vnd.oci.image.index.v1+json")],
                                [], [f"{URI}@sha256:current"])

    def test_secret_planner_retains_enabled_and_disabled_history(self):
        keep, delete = cleanup.plan_secrets({"name": "auth"},
            [version(1), version(2, "DISABLED"), version(3)], {"latest"})
        self.assertEqual(keep, [version(1)["name"], version(2, "DISABLED")["name"], version(3)["name"]])
        self.assertEqual(delete, [])

    def test_pinned_and_aliased_versions_are_never_destroyed(self):
        keep, delete = cleanup.plan_secrets({"name": "auth", "versionAliases": {"stable": 2}},
            [version(1), version(2), version(3)], {"1", "stable"})
        self.assertEqual(len(keep), 3)
        self.assertEqual(delete, [])

    def test_latest_disabled_or_destroyed_is_not_replaced_with_an_older_secret(self):
        for state in ("DISABLED", "DESTROYED"):
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                cleanup.plan_secrets({"name": "auth"}, [version(1), version(2, state)], {"latest"})

    def test_current_secret_for_other_consumers_is_retained_without_cloud_run_reference(self):
        keep, delete = cleanup.plan_secrets({"name": "auth"}, [version(1), version(2)], set())
        self.assertEqual(keep, [version(1)["name"], version(2)["name"]])
        self.assertEqual(delete, [])

    def test_already_destroyed_versions_are_not_returned_for_retention(self):
        keep, delete = cleanup.plan_secrets({"name": "auth"}, [version(1, "DESTROYED"), version(2)], set())
        self.assertEqual(keep, [version(2)["name"]])
        self.assertEqual(delete, [])

    def test_cleanup_apply_never_requests_secret_history_destruction(self):
        cloud = unittest.mock.Mock()
        plan = {"fingerprint": "same", "secretFingerprint": [], "keepImages": [],
                "deleteImages": [], "deleteSecrets": [], "deleteRevisions": []}
        with patch.object(cleanup, "inventory", side_effect=[plan, plan]):
            cleanup.apply(cloud, None, plan)
        self.assertFalse(any("secret" in str(call).lower() for call in cloud.mock_calls))

    def test_reads_environment_and_volume_secret_references(self):
        refs = cleanup.referenced_secrets([{
            "containers": [{"env": [{"valueSource": {"secretKeyRef": {"secret": "auth", "version": "latest"}}}]}],
            "volumes": [{"secret": {"secret": "projects/test/secrets/auth", "items": [{"version": "2"}]}}],
        }])
        self.assertEqual(refs, {"auth": {"latest", "2"}})

    def test_failed_historical_execution_is_terminal_even_without_completion_time(self):
        self.assertFalse(cleanup.execution_is_active({"conditions": [{"type": "Completed", "state": "CONDITION_FAILED"}]}))
        self.assertFalse(cleanup.execution_is_active({"completionTime": "2026-10-05"}))
        self.assertTrue(cleanup.execution_is_active({"conditions": [{"type": "Completed", "state": "CONDITION_PENDING"}]}))
        self.assertTrue(cleanup.execution_is_active({"completionTime": "2026-10-05", "runningCount": 1}))

    def test_inventory_change_stops_before_any_mutation(self):
        cloud = unittest.mock.Mock()
        before = {"fingerprint": "before", "secretFingerprint": [], "keepImages": [], "deleteImages": []}
        with patch.object(cleanup, "inventory", return_value={**before, "fingerprint": "after"}):
            with self.assertRaisesRegex(RuntimeError, "Inventory changed"):
                cleanup.apply(cloud, None, before)
        cloud.request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
