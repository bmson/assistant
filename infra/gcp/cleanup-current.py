#!/usr/bin/env python3
"""Keep deployed images; retain secret history; preview unless --apply.

Uses gcloud's existing identity. Never reads secret payloads. Run under the same
production-deploy concurrency group as deployment so builds cannot race cleanup.
"""
import argparse
import concurrent.futures
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


class CloudError(RuntimeError):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


class Cloud:
    def __init__(self):
        self.token = None
        self.token_time = 0
        self.token_lock = threading.Lock()
        self.run_write_lock = threading.Lock()
        self.next_run_write = 0

    def request(self, host, resource, method="GET", data=None, params=None):
        with self.token_lock:
            if time.monotonic() - self.token_time > 120 or not self.token:
                result = subprocess.run(
                    ["gcloud", "auth", "print-access-token", "--quiet"],
                    capture_output=True, text=True, check=True,
                )
                self.token = result.stdout.strip()
                self.token_time = time.monotonic()
        url = f"https://{host}/{resource}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        body = json.dumps(data).encode() if data is not None else None
        request = urllib.request.Request(url, data=body, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": ", ".join(("application/json", "application/vnd.oci.image.index.v1+json",
                "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json")),
        })
        for attempt in range(8):
            if host == "run.googleapis.com" and method != "GET":
                # Cloud Run allows 60 writes/minute/region. Space requests,
                # including retries, rather than bursting deletion workers.
                with self.run_write_lock:
                    delay = max(0, self.next_run_write - time.monotonic())
                    time.sleep(delay)
                    self.next_run_write = time.monotonic() + 1.1
            try:
                with urllib.request.urlopen(request, timeout=90) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                if error.code in (429, 500, 502, 503, 504) and attempt < 7:
                    time.sleep(min(30, 2 ** attempt))
                    continue
                # urllib errors never print request headers or credentials.
                try:
                    detail = json.loads(error.read()).get("error", {}).get("message", "")
                except (ValueError, AttributeError):
                    detail = ""
                raise CloudError(f"{method} {host}/{resource}: HTTP {error.code}: {detail}", error.code) from None
        raise RuntimeError("Cloud request retry limit exceeded")

    def listing(self, host, resource, key, params=None):
        params = {"pageSize": 1000, **(params or {})}
        items = []
        while True:
            response = self.request(host, resource, params=params)
            items.extend(response.get(key, []))
            token = response.get("nextPageToken")
            if not token:
                return items
            params["pageToken"] = token

    def operation(self, host, response):
        if not response.get("name"):
            raise RuntimeError("Cloud did not return an operation")
        deadline = time.monotonic() + 600
        while not response.get("done"):
            if time.monotonic() > deadline:
                raise RuntimeError(f"Operation did not finish: {response['name']}")
            time.sleep(2)
            response = self.request(host, f"{'v2' if host == 'run.googleapis.com' else 'v1'}/{response['name']}")
        if response.get("error"):
            if response["error"].get("code") == 5:
                raise CloudError("Deletion target was already removed", 404)
            raise RuntimeError(f"Operation failed: {response['error']}")
        return response


RUN = "run.googleapis.com"
ARTIFACTS = "artifactregistry.googleapis.com"
CONTAINER_FIELDS = "containers(image,env(valueSource)),volumes(secret)"
RECOVERY_ALLOWLIST = Path(__file__).with_name("recovery-retention.json")
RECOVERY_PROJECT = "bmson-assistant"
RECOVERY_REGION = "us-west1"
RECOVERY_REPOSITORY = "assistant"
RECOVERY_COMPONENTS = {"agent", "web", "browser", "code", "processor"}


def _strict_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise RuntimeError(f"Recovery retention configuration has duplicate key: {key}")
        result[key] = value
    return result


def load_recovery_allowlist(path, args, now=None):
    """Read the optional, fixed recovery retention file; never accept patterns."""
    if path.is_symlink():
        raise RuntimeError("Recovery retention configuration must not be a symlink")
    if not path.exists():
        return None
    if not path.is_file() or path.stat().st_size > 65536:
        raise RuntimeError("Recovery retention configuration must be a bounded regular file")
    try:
        config = json.loads(path.read_text(), object_pairs_hook=_strict_json_object)
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Recovery retention configuration is invalid: {error}") from None
    if not isinstance(config, dict) or set(config) != {
        "schemaVersion", "project", "region", "repository", "expiresAt",
        "sourceSHA", "configProof", "procedureReference", "images", "revisions",
    }:
        raise RuntimeError("Recovery retention configuration has unknown or missing fields")
    if (type(config["schemaVersion"]) is not int or config["schemaVersion"] != 1 or
            config["project"] != RECOVERY_PROJECT or
            config["region"] != RECOVERY_REGION or config["repository"] != RECOVERY_REPOSITORY or
            args.project != RECOVERY_PROJECT or args.region != RECOVERY_REGION or
            args.repository != RECOVERY_REPOSITORY):
        raise RuntimeError("Recovery retention is pinned to bmson-assistant/us-west1/assistant")
    if not isinstance(config["sourceSHA"], str) or not re.fullmatch(r"[0-9a-f]{40}", config["sourceSHA"]):
        raise RuntimeError("Recovery retention sourceSHA must be a full lowercase git SHA")
    if not isinstance(config["configProof"], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", config["configProof"]):
        raise RuntimeError("Recovery retention configProof must be a sha256 digest")
    if (not isinstance(config["procedureReference"], str) or not config["procedureReference"].strip() or
            len(config["procedureReference"]) > 500):
        raise RuntimeError("Recovery retention requires a bounded procedureReference")
    try:
        expiry_text = config["expiresAt"]
        expiry = datetime.fromisoformat(expiry_text.replace("Z", "+00:00"))
        if expiry.tzinfo is None:
            raise ValueError("timezone required")
        expiry = expiry.astimezone(timezone.utc)
    except (AttributeError, TypeError, ValueError):
        raise RuntimeError("Recovery retention expiresAt must be an RFC3339 timestamp with timezone") from None
    now = now or datetime.now(timezone.utc)
    if expiry <= now or expiry > now + timedelta(days=7):
        raise RuntimeError("Recovery retention expiry must be in the future and no more than seven days away")
    images = config["images"]
    if not isinstance(images, dict) or set(images) - RECOVERY_COMPONENTS:
        raise RuntimeError("Recovery retention images must name only agent, web, browser, code, or processor")
    normalized_images = []
    normalized_by_component = {}
    for component, refs in images.items():
        if not isinstance(refs, list) or not refs:
            raise RuntimeError(f"Recovery retention {component} images must be a nonempty list")
        for ref in refs:
            expected = (rf"{re.escape(RECOVERY_REGION)}-docker\.pkg\.dev/{RECOVERY_PROJECT}/"
                        rf"{RECOVERY_REPOSITORY}/{component}@sha256:[0-9a-f]{{64}}")
            if not isinstance(ref, str) or not re.fullmatch(expected, ref):
                raise RuntimeError(f"Recovery retention has a non-exact {component} image reference")
            normalized_images.append(ref)
            normalized_by_component.setdefault(component, []).append(ref)
    if len(normalized_images) != len(set(normalized_images)):
        raise RuntimeError("Recovery retention contains duplicate image references")
    revisions = config["revisions"]
    if not isinstance(revisions, list):
        raise RuntimeError("Recovery retention revisions must be a list")
    for revision in revisions:
        if not isinstance(revision, str) or not re.fullmatch(
            rf"projects/{RECOVERY_PROJECT}/locations/{RECOVERY_REGION}/services/assistant-(?:agent|web)/revisions/[a-z0-9-]+",
            revision,
        ):
            raise RuntimeError("Recovery retention has a non-exact or unsupported revision name")
    if len(revisions) != len(set(revisions)):
        raise RuntimeError("Recovery retention contains duplicate revision names")
    revision_components = [name.split("/services/assistant-", 1)[1].split("/", 1)[0]
                           for name in revisions]
    if (not normalized_by_component.get("agent") or not normalized_by_component.get("web") or
            len(normalized_by_component["agent"]) != 1 or len(normalized_by_component["web"]) != 1 or
            revision_components.count("agent") != 1 or revision_components.count("web") != 1 or
            len(revision_components) != 2):
        raise RuntimeError("Recovery retention requires one exact agent and web image and revision")
    return {**config, "imageRefs": normalized_images, "imageRefsByComponent": normalized_by_component,
            "revisionNames": revisions}


def execution_is_active(execution):
    completed = any(condition.get("type") == "Completed" and condition.get("state") in (
        "CONDITION_SUCCEEDED", "CONDITION_FAILED",
    ) for condition in execution.get("conditions", []))
    return bool(execution.get("runningCount")) or not (execution.get("completionTime") or completed)


def runtime_inventory(cloud, project, region, recovery=None):
    root = f"projects/{project}/locations/{region}"
    services = cloud.listing(RUN, f"v2/{root}/services", "services", {
        "fields": "services(name,latestReadyRevision,latestCreatedRevision,trafficStatuses),nextPageToken",
    })
    jobs = cloud.listing(RUN, f"v2/{root}/jobs", "jobs", {
        "fields": f"jobs(name,template(template({CONTAINER_FIELDS}))),nextPageToken",
    })
    specs, retired_revisions, all_revisions = [], [], set()
    for service in services:
        current = service.get("latestReadyRevision")
        if not current or current != service.get("latestCreatedRevision"):
            raise RuntimeError(f"Deployment is unsettled: {service['name']}")
        traffic = service.get("trafficStatuses", [])
        if sum(t.get("percent", 0) for t in traffic) != 100 or any(
            t.get("revision") != current.rsplit("/", 1)[-1] for t in traffic
        ):
            raise RuntimeError(f"Traffic is split or a historical revision has a URL: {service['name']}")
        spec = cloud.request(RUN, f"v2/{current}", params={"fields": f"name,{CONTAINER_FIELDS}"})
        specs.append(spec)
        revisions = cloud.listing(RUN, f"v2/{service['name']}/revisions", "revisions", {
            "fields": "revisions(name),nextPageToken",
        })
        all_revisions.update(r["name"] for r in revisions)
        # Only remove this app's history, never another service's revisions.
        if service["name"].rsplit("/", 1)[-1] in ("assistant-agent", "assistant-web"):
            retired_revisions.extend(r["name"] for r in revisions if r["name"] != current)
    if recovery:
        for name in recovery["revisionNames"]:
            if name not in all_revisions and name not in {s.get("latestReadyRevision") for s in services}:
                raise RuntimeError(f"Allowlisted recovery revision is missing: {name}")
            revision = cloud.request(RUN, f"v2/{name}", params={"fields": f"name,{CONTAINER_FIELDS}"})
            if revision.get("name") != name:
                raise RuntimeError(f"Allowlisted recovery revision did not match exactly: {name}")
            component = name.split("/services/assistant-", 1)[1].split("/", 1)[0]
            expected_prefix = f"{RECOVERY_REGION}-docker.pkg.dev/{RECOVERY_PROJECT}/{RECOVERY_REPOSITORY}/"
            containers = revision.get("containers")
            if not isinstance(containers, list) or len(containers) != 1 or not isinstance(containers[0], dict):
                raise RuntimeError(f"Allowlisted recovery revision has ambiguous containers: {name}")
            revision_images = [containers[0].get("image", "")]
            if not all(isinstance(ref, str) and ref.startswith(expected_prefix) for ref in revision_images):
                raise RuntimeError(f"Allowlisted recovery revision has a foreign image: {name}")
            if not revision_images or any("@sha256:" not in ref for ref in revision_images):
                raise RuntimeError(f"Allowlisted recovery revision has no exact immutable image: {name}")
            if any(ref.rsplit("/", 1)[-1].split("@", 1)[0] != component for ref in revision_images):
                raise RuntimeError(f"Allowlisted recovery revision image does not match its service: {name}")
            if not any(ref in recovery["imageRefsByComponent"].get(component, []) for ref in revision_images):
                raise RuntimeError(f"Allowlisted recovery revision image is not in its exact component allowlist: {name}")
            specs.append(revision)
            # A listed current revision is retained by definition; old exact
            # recovery revisions are removed from the deletion candidate set.
            if name not in retired_revisions and name not in {s.get("latestReadyRevision") for s in services}:
                raise RuntimeError(f"Allowlisted recovery revision is ambiguous: {name}")
    for job in jobs:
        executions = cloud.listing(RUN, f"v2/{job['name']}/executions", "executions", {
            "fields": "executions(name,completionTime,runningCount,conditions(type,state)),nextPageToken",
        })
        if any(execution_is_active(execution) for execution in executions):
            raise RuntimeError(f"A job execution is still active: {job['name']}")
        specs.append(job["template"]["template"])
    fingerprint = json.dumps([services, jobs], sort_keys=True)
    return specs, retired_revisions, fingerprint


def image_version(image):
    prefix, suffix = image["name"].split("/dockerImages/", 1)
    package, digest = urllib.parse.unquote(suffix).rsplit("@", 1)
    return f"{prefix}/packages/{urllib.parse.quote(package, safe='')}/versions/{digest}"


def validate_allowlisted_images(images, refs):
    """Require every configured recovery digest to resolve to one matching AR object."""
    for ref in refs:
        matches = [image for image in images if image.get("uri") == ref]
        if len(matches) != 1:
            state = "missing" if not matches else "ambiguous"
            raise RuntimeError(f"Allowlisted recovery image is {state}: {ref}")
        package = ref.rsplit("/", 1)[-1].split("@", 1)[0]
        digest = ref.rsplit("@", 1)[-1]
        expected_suffix = f"/packages/{urllib.parse.quote(package, safe='')}/versions/{digest}"
        if not image_version(matches[0]).endswith(expected_suffix):
            raise RuntimeError(f"Allowlisted recovery image did not match its registry digest: {ref}")


def plan_images(images, tags, runtime_images, related=None):
    by_uri = {image["uri"]: image for image in images}
    by_version = {image_version(image): image for image in images}
    by_tag = {tag["name"]: tag["version"] for tag in tags}
    retained = set()
    for ref in runtime_images:
        if "@sha256:" in ref:
            image = by_uri.get(ref)
        else:
            package_uri, tag_name = ref.rsplit(":", 1)
            candidates = [image for image in images if image["uri"].rsplit("@", 1)[0] == package_uri]
            if not candidates:
                raise RuntimeError(f"Deployed image package is missing: {ref}")
            parent = image_version(candidates[0]).split("/versions/", 1)[0]
            image = by_version.get(by_tag.get(f"{parent}/tags/{tag_name}"))
        if not image:
            raise RuntimeError(f"Deployed image is missing: {ref}")
        # A multi-architecture index needs its child manifests retained too.
        # Stop rather than accidentally deleting a child; current builds are
        # single-architecture Docker manifests.
        if image.get("mediaType") in (
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
        ):
            raise RuntimeError(f"Multi-architecture cleanup is not supported: {ref}")
        version = image_version(image)
        retained.add(version)
        package, digest = version.split("/versions/")
        digest_tag = digest.replace(":", "-")
        for suffix in ("sig", "att", "sbom"):
            attached = by_tag.get(f"{package}/tags/{digest_tag}.{suffix}")
            if attached:
                retained.add(attached)
    # New Cosign versions store signatures/attestations as OCI referrers with
    # no tag. Preserve the current image's complete metadata graph too.
    pending = list(retained)
    while pending:
        version = pending.pop()
        for dependency in (related or {}).get(version, []):
            if dependency not in by_version:
                raise RuntimeError(f"Current image metadata is missing: {dependency}")
            if dependency not in retained:
                retained.add(dependency)
                pending.append(dependency)
    return sorted(retained), sorted(set(by_version) - retained)


def image_referrers(cloud, images, retained):
    by_version = {image_version(image): image for image in images}
    pending, related = list(retained), {}
    while pending:
        version = pending.pop()
        if version in related:
            continue
        image = by_version.get(version)
        if not image:
            raise RuntimeError(f"Current image metadata is missing: {version}")
        host, image_name = image["uri"].split("/", 1)
        repository, digest = image_name.rsplit("@", 1)
        index = cloud.request(host, f"v2/{repository}/referrers/{digest}")
        package = version.split("/versions/", 1)[0]
        related[version] = [f"{package}/versions/{manifest['digest']}" for manifest in (index.get("manifests") or [])]
        pending.extend(related[version])
    return related


def referenced_secrets(specs):
    refs = {}
    for spec in specs:
        for container in spec.get("containers", []):
            for env in container.get("env", []):
                ref = env.get("valueSource", {}).get("secretKeyRef")
                if ref:
                    refs.setdefault(ref["secret"].rsplit("/", 1)[-1], set()).add(ref["version"])
        for volume in spec.get("volumes", []):
            ref = volume.get("secret")
            if ref:
                refs.setdefault(ref["secret"].rsplit("/", 1)[-1], set()).update(
                    item["version"] for item in ref.get("items", [])
                )
    return refs


def plan_secrets(secret, versions, references):
    # A regional Cloud Run inventory cannot prove that an old credential is
    # unused by another region, an offline decryptor, or a non-Cloud-Run
    # consumer. Keep all extant history until that dependency set is complete.
    by_number = {v["name"].rsplit("/", 1)[-1]: v for v in versions}
    latest = max(by_number, key=int) if by_number else None
    aliases = {key: str(value) for key, value in secret.get("versionAliases", {}).items()}
    for reference in references:
        number = latest if reference == "latest" else aliases.get(reference, reference)
        if number not in by_number or by_number[number]["state"] != "ENABLED":
            raise RuntimeError(f"Current secret reference is unavailable: {secret['name']}:{reference}")
    return [v["name"] for v in versions if v["state"] != "DESTROYED"], []


def delete_image(cloud, name):
    try:
        result = cloud.request(ARTIFACTS, f"v1/{name}", method="DELETE", params={"force": "true"})
        cloud.operation(ARTIFACTS, result)
    except CloudError as error:
        # Removing an old manifest may also remove its old OCI referrers.
        # Treat their subsequent 404 as success; final inventory verifies all.
        if error.status != 404:
            raise


def inventory(cloud, args, recovery_path=RECOVERY_ALLOWLIST):
    recovery = load_recovery_allowlist(recovery_path, args)
    specs, revisions, fingerprint = runtime_inventory(cloud, args.project, args.region, recovery)
    root = f"projects/{args.project}/locations/{args.region}/repositories/{args.repository}"
    repository = cloud.request(ARTIFACTS, f"v1/{root}")
    if repository.get("dockerConfig", {}).get("immutableTags"):
        raise RuntimeError("Cleanup requires a repository with mutable tags")
    images = cloud.listing(ARTIFACTS, f"v1/{root}/dockerImages", "dockerImages")
    if recovery:
        validate_allowlisted_images(images, recovery["imageRefs"])
    packages = sorted({image_version(image).split("/versions/", 1)[0] for image in images})
    tags = []
    for package in packages:
        tags.extend(cloud.listing(ARTIFACTS, f"v1/{package}/tags", "tags"))
    image_root = f"{args.region}-docker.pkg.dev/{args.project}/{args.repository}/"
    runtime_images = sorted({container["image"] for spec in specs
                             for container in spec.get("containers", [])
                             if container["image"].startswith(image_root)})
    if not runtime_images:
        raise RuntimeError("No current images found in this repository; refusing to empty it")
    retained_refs = runtime_images + (recovery["imageRefs"] if recovery else [])
    kept_images, _ = plan_images(images, tags, retained_refs)
    related = image_referrers(cloud, images, kept_images)
    kept_images, delete_images = plan_images(images, tags, retained_refs, related)
    if recovery:
        revisions = [name for name in revisions if name not in recovery["revisionNames"]]
    return {
        "repository": root, "repositoryBytes": int(repository.get("sizeBytes", 0)),
        "runtimeImages": runtime_images, "keepImages": kept_images, "deleteImages": delete_images,
        # Deliberately do not enumerate or destroy project-wide Secret Manager
        # history: this region's Cloud Run inventory cannot prove ownership.
        "keepSecrets": [], "deleteSecrets": [], "deleteRevisions": revisions,
        "fingerprint": fingerprint, "secretFingerprint": [],
        "recoveryRetention": ({key: recovery[key] for key in (
            "expiresAt", "sourceSHA", "configProof", "procedureReference", "imageRefs", "revisionNames",
        )} if recovery else None),
    }


def apply(cloud, args, plan):
    # Re-read everything before the first mutation. No partially assembled plan
    # or changed live deployment is allowed to trigger deletion.
    fresh = inventory(cloud, args)
    for key in ("fingerprint", "secretFingerprint", "keepImages", "deleteImages",
                "deleteRevisions", "recoveryRetention"):
        if plan[key] != fresh[key]:
            raise RuntimeError("Inventory changed during planning; rerun cleanup after deployment settles")

    def remove_revision(name):
        result = cloud.request(RUN, f"v2/{name}", method="DELETE")
        cloud.operation(RUN, result)

    def remove_images():
        # Individual force deletion works for both tagged Docker images and
        # OCI signature artifacts, unlike the public bulk deletion endpoint.
        with concurrent.futures.ThreadPoolExecutor(max_workers=64) as pool:
            for count, _ in enumerate(pool.map(lambda name: delete_image(cloud, name), plan["deleteImages"]), 1):
                if count % 100 == 0 or count == len(plan["deleteImages"]):
                    print(f"Removed {count}/{len(plan['deleteImages'])} old image/metadata versions", flush=True)

    def remove_revisions():
        # These revisions have no traffic or tagged URL. Descriptor deletion
        # runs alongside storage cleanup, paced to Cloud Run's write quota.
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            for count, _ in enumerate(pool.map(remove_revision, plan["deleteRevisions"]), 1):
                if count % 50 == 0 or count == len(plan["deleteRevisions"]):
                    print(f"Removed {count}/{len(plan['deleteRevisions'])} retired revisions", flush=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(remove_images), pool.submit(remove_revisions)]
        for future in futures:
            future.result()
    after = inventory(cloud, args)
    if after["deleteImages"] or after["deleteSecrets"] or after["deleteRevisions"]:
        raise RuntimeError("Cleanup verification found remaining obsolete versions; rerun to finish")
    print("Verified image cleanup; Secret Manager versions were retained", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", default="us-west1")
    parser.add_argument("--repository", default="assistant")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    cloud = Cloud()
    plan = inventory(cloud, args)
    print(json.dumps({key: value for key, value in plan.items()
                      if key not in ("fingerprint", "secretFingerprint", "deleteImages", "deleteSecrets", "deleteRevisions")}
                     | {"deleteImageCount": len(plan["deleteImages"]),
                        "deleteSecretCount": len(plan["deleteSecrets"]),
                        "deleteRevisionCount": len(plan["deleteRevisions"])}, indent=2), flush=True)
    if args.apply:
        apply(cloud, args, plan)
    else:
        print("Preview only; use --apply to delete the listed obsolete versions")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not dump auth subprocesses, request objects, or credential headers.
        raise SystemExit(f"Cleanup stopped: {error}") from None
