import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("cleanup", Path(__file__).with_name("cleanup-current.py"))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)

ROOT = "projects/test/locations/us-west1/repositories/assistant"
PACKAGE = f"{ROOT}/packages/web"
URI = "us-west1-docker.pkg.dev/test/assistant/web"
SERVICE = "projects/test/locations/us-west1/services/assistant-web"
AGENT_SERVICE = "projects/test/locations/us-west1/services/assistant-agent"


def image(digest, media_type="application/vnd.docker.distribution.manifest.v2+json"):
    return {"name": f"{ROOT}/dockerImages/web@sha256:{digest}",
            "uri": f"{URI}@sha256:{digest}", "mediaType": media_type}


def tag(name, digest):
    return {"name": f"{PACKAGE}/tags/{name}", "version": f"{PACKAGE}/versions/sha256:{digest}"}


def version(number, state="ENABLED"):
    return {"name": f"projects/test/secrets/auth/versions/{number}", "state": state, "etag": str(number)}


class CleanupTests(unittest.TestCase):
    def _runtime_cloud(self, statuses=None, desired=None, revision_names=None, specs=None,
                       service_changes=None, jobs=None, executions=None):
        current = f"{SERVICE}/revisions/web-current"
        old = f"{SERVICE}/revisions/web-old"
        agent_current = f"{AGENT_SERVICE}/revisions/agent-current"
        statuses = statuses if statuses is not None else [{"revision": "web-current", "percent": 100}]
        desired = desired if desired is not None else [{"revision": "web-current", "percent": 100}]
        service = {
            "name": SERVICE, "generation": "7", "observedGeneration": "7", "reconciling": False,
            "terminalCondition": {"type": "Ready", "state": "CONDITION_SUCCEEDED"},
            "latestReadyRevision": current, "latestCreatedRevision": current,
            "traffic": desired, "trafficStatuses": statuses,
            "uri": "https://assistant-web.example", "urls": ["https://assistant-web.example"],
        }
        service.update(service_changes or {})
        agent_service = {
            "name": AGENT_SERVICE, "generation": "3", "observedGeneration": "3", "reconciling": False,
            "terminalCondition": {"type": "Ready", "state": "CONDITION_SUCCEEDED"},
            "latestReadyRevision": agent_current, "latestCreatedRevision": agent_current,
            "traffic": [{"revision": "agent-current", "percent": 100}],
            "trafficStatuses": [{"revision": "agent-current", "percent": 100}],
            "uri": "https://assistant-agent.example", "urls": ["https://assistant-agent.example"],
        }
        revision_names = revision_names if revision_names is not None else [current, old]
        specs = {
            agent_current: {"name": agent_current, "containers": [{"image": f"{URI}@sha256:{'e' * 64}"}], "volumes": []},
            current: {"name": current, "containers": [{"image": f"{URI}@sha256:{'a' * 64}"}], "volumes": []},
            old: {"name": old, "containers": [{"image": f"{URI}@sha256:{'b' * 64}"}], "volumes": []},
            **(specs or {}),
        }

        class InventoryCloud:
            def __init__(self):
                self.service = service
                self.agent_service = agent_service
                self.services = [self.service, self.agent_service]
                self.revision_names = revision_names
                self.agent_revision_names = [agent_current]
                self.specs = specs
                self.jobs = jobs or []
                self.executions = executions or []
                self.gets = []
                self.listed = []

            def listing(self, host, resource, key, params=None):
                self.listed.append(resource)
                if resource.endswith("/services"):
                    return self.services
                if resource.endswith("/jobs"):
                    return self.jobs
                if resource.endswith("/executions"):
                    return self.executions
                if resource.endswith("/revisions"):
                    service_resource = resource.removeprefix("v2/").removesuffix("/revisions")
                    names = self.revision_names if service_resource == SERVICE else self.agent_revision_names
                    return [{"name": name} for name in names]
                raise AssertionError(f"unexpected inventory request: {resource}")

            def request(self, host, resource, params=None):
                self.gets.append(resource)
                name = resource.removeprefix("v2/")
                if name not in self.specs:
                    raise RuntimeError(f"Cloud Run retained revision spec is missing: {name}")
                return self.specs[name]

        return InventoryCloud(), current, old

    def test_single_current_revision_remains_default_cleanup_behavior(self):
        cloud, current, _old = self._runtime_cloud(revision_names=[f"{SERVICE}/revisions/web-current"])
        specs, retired, _fingerprint = cleanup.runtime_inventory(cloud, "test", "us-west1")
        self.assertEqual({spec["name"] for spec in specs}, {current, f"{AGENT_SERVICE}/revisions/agent-current"})
        self.assertEqual(retired, [])

    def test_zero_traffic_tagged_historical_revision_is_retained_but_untagged_is_retired(self):
        current = f"{SERVICE}/revisions/web-current"
        old = f"{SERVICE}/revisions/web-old"
        tagged_uri = "https://candidate---assistant-web.example"
        statuses = [
            {"revision": "web-current", "percent": 100},
            {"revision": "web-old", "percent": 0, "tag": "candidate", "uri": tagged_uri},
        ]
        desired = [
            {"revision": "web-current", "percent": 100},
            {"revision": "web-old", "percent": 0, "tag": "candidate"},
        ]
        cloud, _, _ = self._runtime_cloud(statuses=statuses, desired=desired,
            revision_names=[current, old, f"{SERVICE}/revisions/web-untagged"],
            service_changes={"urls": ["https://assistant-web.example"]})
        specs, retired, fingerprint = cleanup.runtime_inventory(cloud, "test", "us-west1")
        self.assertEqual({spec["name"] for spec in specs}, {
            current, old, f"{AGENT_SERVICE}/revisions/agent-current"})
        self.assertEqual(retired, [f"{SERVICE}/revisions/web-untagged"])
        self.assertIn("candidate", fingerprint)
        self.assertIn(f"v2/{old}", cloud.gets)

    def test_tagged_historical_revision_image_and_transitive_oci_referrers_survive_inventory(self):
        current = f"{SERVICE}/revisions/web-current"
        old = f"{SERVICE}/revisions/web-old"
        uri = "https://candidate---assistant-web.example"
        statuses = [{"revision": "web-current", "percent": 100},
                    {"revision": "web-old", "percent": 0, "tag": "candidate", "uri": uri}]
        desired = [{"revision": "web-current", "percent": 100},
                   {"revision": "web-old", "percent": 0, "tag": "candidate"}]
        runtime, _, _ = self._runtime_cloud(statuses, desired, [current, old])
        retained_digests = {"a" * 64, "b" * 64, "c" * 64, "d" * 64, "e" * 64}
        images = [image(digest) for digest in sorted(retained_digests | {"f" * 64})]
        referrer_chain = {
            "a" * 64: [], "b" * 64: ["c" * 64], "c" * 64: ["d" * 64],
            "d" * 64: [], "e" * 64: [], "f" * 64: [],
        }

        class ComposedCloud:
            def listing(self, host, resource, key, params=None):
                if host == cleanup.RUN:
                    return runtime.listing(host, resource, key, params)
                if resource.endswith("/dockerImages"):
                    return images
                if resource.endswith("/tags"):
                    return []
                raise AssertionError(f"unexpected composed inventory listing: {host}/{resource}")

            def request(self, host, resource, method="GET", data=None, params=None):
                if host == cleanup.RUN:
                    return runtime.request(host, resource, params)
                if host == cleanup.ARTIFACTS and resource == f"v1/{ROOT}":
                    return {"sizeBytes": 100, "dockerConfig": {"immutableTags": False}}
                if host == "us-west1-docker.pkg.dev" and "/referrers/" in resource:
                    digest = resource.rsplit("/", 1)[-1].removeprefix("sha256:")
                    return {"manifests": [{"digest": f"sha256:{value}"}
                        for value in referrer_chain[digest]]}
                raise AssertionError(f"unexpected composed inventory request: {host}/{resource}")

        plan = cleanup.inventory(ComposedCloud(), SimpleNamespace(
            project="test", region="us-west1", repository="assistant"))
        image_versions = {image_version for image_version in plan["keepImages"]}
        expected_metadata = {f"{PACKAGE}/versions/sha256:{digest}" for digest in ("b" * 64, "c" * 64, "d" * 64)}
        self.assertTrue(expected_metadata.issubset(image_versions))
        self.assertTrue(expected_metadata.isdisjoint(plan["deleteImages"]))
        self.assertIn(f"{URI}@sha256:{'b' * 64}", plan["runtimeImages"])

    def test_foreign_tagged_revision_is_retained(self):
        current = f"{SERVICE}/revisions/web-current"
        foreign = f"{SERVICE}/revisions/web-foreign"
        tagged_uri = "https://other---assistant-web.example"
        statuses = [{"revision": "web-current", "percent": 100},
                    {"revision": "web-foreign", "percent": 0, "tag": "other", "uri": tagged_uri}]
        desired = [{"revision": "web-current", "percent": 100},
                   {"revision": "web-foreign", "percent": 0, "tag": "other"}]
        specs = {
            current: {"name": current, "containers": [{"image": f"{URI}@sha256:{'a' * 64}"}]},
            foreign: {"name": foreign, "containers": [{"image": f"{URI}@sha256:{'c' * 64}"}]},
        }
        cloud, _, _ = self._runtime_cloud(statuses, desired, [current, foreign],
            specs=specs, service_changes={"urls": ["https://assistant-web.example", tagged_uri]})
        _specs, retired, _fingerprint = cleanup.runtime_inventory(cloud, "test", "us-west1")
        self.assertEqual(retired, [])
        self.assertIn(f"v2/{foreign}", cloud.gets)

    def test_uri_only_historical_target_is_retained_without_service_url_crosscheck(self):
        current = f"{SERVICE}/revisions/web-current"
        historical = f"{SERVICE}/revisions/web-historical"
        uri = "https://revision-specific.example/path"
        statuses = [{"revision": "web-current", "percent": 100},
                    {"revision": "web-historical", "percent": 0, "uri": uri}]
        desired = [{"revision": "web-current", "percent": 100},
                   {"revision": "web-historical", "percent": 0}]
        specs = {
            current: {"name": current, "containers": [{"image": f"{URI}@sha256:{'a' * 64}"}]},
            historical: {"name": historical, "containers": [{"image": f"{URI}@sha256:{'d' * 64}"}]},
        }
        cloud, _, _ = self._runtime_cloud(statuses, desired, [current, historical], specs=specs)
        _specs, retired, fingerprint = cleanup.runtime_inventory(cloud, "test", "us-west1")
        self.assertEqual(retired, [])
        self.assertIn(uri, fingerprint)
        self.assertIn(f"v2/{historical}", cloud.gets)

    def test_optional_tag_rows_sort_without_comparing_none_to_string(self):
        current = f"{SERVICE}/revisions/web-current"
        old = f"{SERVICE}/revisions/web-old"
        statuses = [
            {"revision": "web-current", "percent": 100},
            {"revision": "web-old", "percent": 0, "uri": "https://uri-only.example"},
            {"revision": "web-old", "percent": 0, "tag": "candidate", "uri": "https://tagged.example"},
        ]
        desired = [
            {"revision": "web-current", "percent": 100},
            {"revision": "web-old", "percent": 0},
            {"revision": "web-old", "percent": 0, "tag": "candidate"},
        ]
        cloud, _, _ = self._runtime_cloud(statuses, desired, [current, old],
            service_changes={"urls": []})
        _specs, retired, _fingerprint = cleanup.runtime_inventory(cloud, "test", "us-west1")
        self.assertEqual(retired, [])

    def test_malformed_or_duplicate_status_uris_fail_closed(self):
        current = f"{SERVICE}/revisions/web-current"
        for uri in ("http://revision.example", "https://user:secret@revision.example",
                    "https://revision.example/path?query=1", "https://revision.example/#fragment"):
            with self.subTest(uri=uri):
                cloud, _, _ = self._runtime_cloud(
                    statuses=[{"revision": "web-current", "percent": 100, "uri": uri}],
                    desired=[{"revision": "web-current", "percent": 100}])
                with self.assertRaisesRegex(RuntimeError, "URI is malformed"):
                    cleanup.runtime_inventory(cloud, "test", "us-west1")
        statuses = [{"revision": "web-current", "percent": 100, "uri": "https://same.example"},
                    {"revision": "web-current", "percent": 0, "uri": "https://same.example"}]
        desired = [{"revision": "web-current", "percent": 100}, {"revision": "web-current", "percent": 0}]
        cloud, _, _ = self._runtime_cloud(statuses, desired)
        with self.assertRaisesRegex(RuntimeError, "duplicated or ambiguous"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")
        statuses = [{"revision": "web-current", "percent": 100, "uri": "https://same.example"},
                    {"revision": "web-old", "percent": 0, "uri": "https://same.example"}]
        desired = [{"revision": "web-current", "percent": 100}, {"revision": "web-old", "percent": 0}]
        cloud, _, _ = self._runtime_cloud(statuses, desired)
        with self.assertRaisesRegex(RuntimeError, "duplicated or ambiguous"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")

    def test_positive_historical_traffic_is_rejected(self):
        current = f"{SERVICE}/revisions/web-current"
        statuses = [{"revision": "web-current", "percent": 80}, {"revision": "web-old", "percent": 20}]
        desired = [{"revision": "web-current", "percent": 80}, {"revision": "web-old", "percent": 20}]
        cloud, _, _ = self._runtime_cloud(statuses, desired, [current, f"{SERVICE}/revisions/web-old"])
        with self.assertRaisesRegex(RuntimeError, "historical revision"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")

    def test_unsettled_service_states_fail_closed(self):
        cases = [
            {"generation": "8"},
            {"generation": "١", "observedGeneration": "١"},
            {"generation": "-1", "observedGeneration": "-1"},
            {"generation": "9223372036854775808", "observedGeneration": "9223372036854775808"},
            {"reconciling": True},
            {"terminalCondition": {"type": "Ready", "state": "CONDITION_FAILED"}},
            {"latestCreatedRevision": f"{SERVICE}/revisions/web-new"},
        ]
        for change in cases:
            with self.subTest(change=change):
                cloud, _, _ = self._runtime_cloud(service_changes=change)
                with self.assertRaises(RuntimeError):
                    cleanup.runtime_inventory(cloud, "test", "us-west1")

    def test_foreign_service_root_and_invalid_revision_ids_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, "out-of-scope"):
            cloud, _, _ = self._runtime_cloud(service_changes={
                "name": "projects/foreign/locations/us-west1/services/assistant-web"})
            cleanup.runtime_inventory(cloud, "test", "us-west1")
        for invalid_id in ("..", "%2e%2e", "parent/child"):
            with self.subTest(invalid_id=invalid_id):
                cloud, _, _ = self._runtime_cloud(
                    statuses=[{"revision": invalid_id, "percent": 100}],
                    desired=[{"revision": invalid_id, "percent": 100}])
                with self.assertRaises(RuntimeError):
                    cleanup.runtime_inventory(cloud, "test", "us-west1")
        current = f"{SERVICE}/revisions/web-current"
        for invalid_name in ("..", "%2e%2e", "projects/foreign/locations/us-west1/services/other/revisions/web-old"):
            with self.subTest(invalid_name=invalid_name):
                cloud, _, _ = self._runtime_cloud(revision_names=[current, invalid_name])
                with self.assertRaises(RuntimeError):
                    cleanup.runtime_inventory(cloud, "test", "us-west1")

    def test_both_application_services_must_appear_exactly_once(self):
        cloud, _, _ = self._runtime_cloud()
        cloud.services = [cloud.service]
        with self.assertRaisesRegex(RuntimeError, "missing or duplicates"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")
        cloud, _, _ = self._runtime_cloud()
        cloud.services = [cloud.agent_service]
        with self.assertRaisesRegex(RuntimeError, "missing or duplicates"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")
        cloud, _, _ = self._runtime_cloud()
        cloud.services = [cloud.service, cloud.agent_service, cloud.service]
        with self.assertRaisesRegex(RuntimeError, "duplicate resources"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")

    def test_latest_ready_revision_must_be_a_full_scoped_resource(self):
        cloud, _, _ = self._runtime_cloud(service_changes={
            "latestReadyRevision": f"{SERVICE}/revisions/..",
            "latestCreatedRevision": f"{SERVICE}/revisions/.."})
        with self.assertRaisesRegex(RuntimeError, "malformed"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")

    def test_job_and_execution_resources_must_stay_in_requested_scope(self):
        foreign_job = {"name": "projects/foreign/locations/us-west1/jobs/cleanup"}
        cloud, _, _ = self._runtime_cloud(jobs=[foreign_job])
        with self.assertRaisesRegex(RuntimeError, "out-of-scope"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")
        self.assertFalse(any(resource.endswith("/executions") for resource in cloud.listed))
        job_name = "projects/test/locations/us-west1/jobs/cleanup"
        valid_job = {"name": job_name, "template": {"template": {
            "containers": [{"image": f"{URI}@sha256:{'f' * 64}"}], "volumes": []}}}
        foreign_execution = {"name": "projects/foreign/locations/us-west1/jobs/cleanup/executions/e1"}
        cloud, _, _ = self._runtime_cloud(jobs=[valid_job], executions=[foreign_execution])
        with self.assertRaisesRegex(RuntimeError, "out-of-scope"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")

    def test_job_template_with_a_digest_pinned_repository_image_is_inventoried(self):
        job_name = "projects/test/locations/us-west1/jobs/cleanup"
        job_image = f"{URI}@sha256:{'f' * 64}"
        job = {"name": job_name, "template": {"template": {
            "containers": [{"image": job_image}], "volumes": []}}}
        cloud, _, _ = self._runtime_cloud(jobs=[job])
        specs, retired, _fingerprint = cleanup.runtime_inventory(cloud, "test", "us-west1")
        self.assertIn({"containers": [{"image": job_image}], "volumes": []}, specs)
        self.assertEqual(retired, [f"{SERVICE}/revisions/web-old"])

    def test_malformed_or_empty_job_template_stops_inventory(self):
        job_name = "projects/test/locations/us-west1/jobs/cleanup"
        for template in (
            {},
            {"containers": []},
            {"containers": [{}]},
            {"containers": [{"image": ""}]},
            {"containers": [{"image": f"{URI}:mutable"}]},
            {"containers": [{"image": f"{URI}@sha256:{'z' * 64}"}]},
            {"containers": [{"image": f"{URI}@sha256:{'a' * 64}"}], "futureField": True},
        ):
            with self.subTest(template=template):
                job = {"name": job_name, "template": {"template": template}}
                cloud, _, _ = self._runtime_cloud(jobs=[job])
                with self.assertRaises(RuntimeError):
                    cleanup.runtime_inventory(cloud, "test", "us-west1")

    def test_zero_service_generation_is_accepted_as_nonnegative_int64(self):
        cloud, _, _ = self._runtime_cloud(service_changes={"generation": "0", "observedGeneration": "0"},
            revision_names=[f"{SERVICE}/revisions/web-current"])
        _specs, retired, _fingerprint = cleanup.runtime_inventory(cloud, "test", "us-west1")
        self.assertEqual(retired, [])

    def test_missing_digest_or_revision_spec_stops_inventory(self):
        current = f"{SERVICE}/revisions/web-current"
        old = f"{SERVICE}/revisions/web-old"
        tagged_uri = "https://candidate---assistant-web.example"
        statuses = [{"revision": "web-current", "percent": 100},
                    {"revision": "web-old", "percent": 0, "tag": "candidate", "uri": tagged_uri}]
        desired = [{"revision": "web-current", "percent": 100}, {"revision": "web-old", "percent": 0, "tag": "candidate"}]
        cloud, _, _ = self._runtime_cloud(statuses, desired, [current, old],
            service_changes={"urls": ["https://assistant-web.example", tagged_uri]})
        cloud.specs[old]["containers"][0]["image"] = f"{URI}:mutable"
        with self.assertRaisesRegex(RuntimeError, "not digest-pinned"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")
        cloud, _, _ = self._runtime_cloud(statuses, desired, [current, old],
            service_changes={"urls": ["https://assistant-web.example", tagged_uri]})
        del cloud.specs[old]
        with self.assertRaisesRegex(RuntimeError, "spec is missing"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")

    def test_foreign_revision_reference_and_unknown_traffic_row_fail_closed(self):
        current = f"{SERVICE}/revisions/web-current"
        foreign = "projects/other/locations/us-west1/services/other/revisions/web-old"
        cloud, _, _ = self._runtime_cloud(statuses=[{"revision": foreign, "percent": 100}],
            desired=[{"revision": foreign, "percent": 100}])
        with self.assertRaisesRegex(RuntimeError, "another service"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")
        cloud, _, _ = self._runtime_cloud(statuses=[{"revision": "web-current", "percent": 100, "future": True}],
            desired=[{"revision": "web-current", "percent": 100}])
        with self.assertRaisesRegex(RuntimeError, "unknown fields"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")

    def test_duplicate_or_moved_tag_mapping_is_rejected(self):
        current = f"{SERVICE}/revisions/web-current"
        uri = "https://candidate---assistant-web.example"
        statuses = [{"revision": "web-current", "percent": 100},
                    {"revision": "web-old", "percent": 0, "tag": "candidate", "uri": uri},
                    {"revision": "web-older", "percent": 0, "tag": "candidate", "uri": uri}]
        desired = [{"revision": "web-current", "percent": 100},
                   {"revision": "web-old", "percent": 0, "tag": "candidate"},
                   {"revision": "web-older", "percent": 0, "tag": "candidate"}]
        cloud, _, _ = self._runtime_cloud(statuses, desired,
            [current, f"{SERVICE}/revisions/web-old", f"{SERVICE}/revisions/web-older"],
            service_changes={"urls": ["https://assistant-web.example", uri]})
        with self.assertRaisesRegex(RuntimeError, "duplicated"):
            cleanup.runtime_inventory(cloud, "test", "us-west1")

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

    def test_registry_empty_referrers_means_no_security_metadata(self):
        cloud = unittest.mock.Mock()
        cloud.request.return_value = {"manifests": []}
        current = f"{PACKAGE}/versions/sha256:current"
        self.assertEqual(cleanup.image_referrers(cloud, [image("current")], [current]), {current: []})

    def test_unknown_or_malformed_referrers_stop_cleanup(self):
        current = f"{PACKAGE}/versions/sha256:current"
        for response in ({}, {"manifests": None}, {"manifests": [None]},
                         {"manifests": [{"digest": "sha1:unknown"}]},
                         {"manifests": [{"digest": "sha256:" + "z" * 64}]}):
            with self.subTest(response=response):
                cloud = unittest.mock.Mock()
                cloud.request.return_value = response
                with self.assertRaisesRegex(RuntimeError, "metadata"):
                    cleanup.image_referrers(cloud, [image("current")], [current])

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
        self.assertFalse(cleanup.execution_is_active({"completionTime": "2026-10-05T00:00:00Z"}))
        self.assertTrue(cleanup.execution_is_active({"conditions": [{"type": "Completed", "state": "CONDITION_PENDING"}]}))
        self.assertTrue(cleanup.execution_is_active({"completionTime": "2026-10-05T00:00:00Z", "runningCount": 1}))

    def test_malformed_execution_status_stops_cleanup(self):
        for execution in (
            {"completionTime": None},
            {"completionTime": True},
            {"completionTime": {"secret": "not-a-time"}},
            {"completionTime": "2026-10-05"},
            {"completionTime": "not a timestamp"},
            {"runningCount": True},
            {"runningCount": -1},
            {"runningCount": "1"},
            {"conditions": {"type": "Completed", "state": "CONDITION_FAILED"}},
        ):
            with self.subTest(execution=execution):
                with self.assertRaises(RuntimeError):
                    cleanup.execution_is_active(execution)

    def test_inventory_change_stops_before_any_mutation(self):
        cloud = unittest.mock.Mock()
        before = {"fingerprint": "before", "secretFingerprint": [], "keepImages": [], "deleteImages": []}
        with patch.object(cleanup, "inventory", return_value={**before, "fingerprint": "after"}):
            with self.assertRaisesRegex(RuntimeError, "Inventory changed"):
                cleanup.apply(cloud, None, before)
        cloud.request.assert_not_called()

    def test_tag_mapping_change_stales_plan_before_any_mutation(self):
        cloud = unittest.mock.Mock()
        current = f"{SERVICE}/revisions/web-current"
        old = f"{SERVICE}/revisions/web-old"
        moved = f"{SERVICE}/revisions/web-moved"
        old_uri = "https://candidate-old.example"
        moved_uri = "https://candidate-moved.example"
        old_statuses = [{"revision": "web-current", "percent": 100},
                        {"revision": "web-old", "percent": 0, "tag": "candidate", "uri": old_uri}]
        old_desired = [{"revision": "web-current", "percent": 100},
                       {"revision": "web-old", "percent": 0, "tag": "candidate"}]
        old_specs = {
            current: {"name": current, "containers": [{"image": f"{URI}@sha256:{'a' * 64}"}]},
            old: {"name": old, "containers": [{"image": f"{URI}@sha256:{'b' * 64}"}]},
            moved: {"name": moved, "containers": [{"image": f"{URI}@sha256:{'c' * 64}"}]},
        }
        old_cloud, _, _ = self._runtime_cloud(old_statuses, old_desired, [current, old, moved],
            specs=old_specs)
        _old_runtime_specs, old_retired, old_fingerprint = cleanup.runtime_inventory(old_cloud, "test", "us-west1")
        plan = {"fingerprint": old_fingerprint, "secretFingerprint": [], "keepImages": [],
                "deleteImages": [], "deleteRevisions": old_retired}
        moved_statuses = [{"revision": "web-current", "percent": 100},
                          {"revision": "web-moved", "percent": 0, "tag": "candidate", "uri": moved_uri}]
        moved_desired = [{"revision": "web-current", "percent": 100},
                         {"revision": "web-moved", "percent": 0, "tag": "candidate"}]
        new_cloud, _, _ = self._runtime_cloud(moved_statuses, moved_desired, [current, old, moved],
            specs=old_specs)
        _new_runtime_specs, new_retired, new_fingerprint = cleanup.runtime_inventory(new_cloud, "test", "us-west1")
        self.assertNotEqual(old_fingerprint, new_fingerprint)
        fresh = {"fingerprint": new_fingerprint, "secretFingerprint": [], "keepImages": [],
                 "deleteImages": [], "deleteRevisions": new_retired}
        with patch.object(cleanup, "inventory", return_value=fresh):
            with self.assertRaisesRegex(RuntimeError, "Inventory changed"):
                cleanup.apply(cloud, None, plan)
        cloud.request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
