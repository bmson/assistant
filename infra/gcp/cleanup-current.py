#!/usr/bin/env python3
"""Keep deployed images and current secret versions; preview unless --apply.

Uses gcloud's existing identity. Never reads secret payloads. Run under the same
production-deploy concurrency group as deployment so builds cannot race cleanup.
"""
import argparse
import concurrent.futures
import json
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


class Cloud:
    def __init__(self):
        self.token = None
        self.token_time = 0
        self.run_write_lock = threading.Lock()
        self.next_run_write = 0

    def request(self, host, resource, method="GET", data=None, params=None):
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
                raise RuntimeError(f"{method} {host}/{resource}: HTTP {error.code}: {detail}") from None
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
            raise RuntimeError(f"Operation failed: {response['error']}")
        return response


RUN = "run.googleapis.com"
ARTIFACTS = "artifactregistry.googleapis.com"
SECRETS = "secretmanager.googleapis.com"
CONTAINER_FIELDS = "containers(image,env(valueSource)),volumes(secret)"


def execution_is_active(execution):
    completed = any(condition.get("type") == "Completed" and condition.get("state") in (
        "CONDITION_SUCCEEDED", "CONDITION_FAILED",
    ) for condition in execution.get("conditions", []))
    return bool(execution.get("runningCount")) or not (execution.get("completionTime") or completed)


def runtime_inventory(cloud, project, region):
    root = f"projects/{project}/locations/{region}"
    services = cloud.listing(RUN, f"v2/{root}/services", "services", {
        "fields": "services(name,latestReadyRevision,latestCreatedRevision,trafficStatuses),nextPageToken",
    })
    jobs = cloud.listing(RUN, f"v2/{root}/jobs", "jobs", {
        "fields": f"jobs(name,template(template({CONTAINER_FIELDS}))),nextPageToken",
    })
    specs, retired_revisions = [], []
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
        # Only remove this app's history, never another service's revisions.
        if service["name"].rsplit("/", 1)[-1] in ("assistant-agent", "assistant-web"):
            retired_revisions.extend(r["name"] for r in revisions if r["name"] != current)
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
    # latest is the greatest version number, including disabled/destroyed
    # versions. Never silently substitute an older version for a broken latest.
    by_number = {v["name"].rsplit("/", 1)[-1]: v for v in versions}
    latest = max(by_number, key=int) if by_number else None
    enabled = [number for number, v in by_number.items() if v["state"] == "ENABLED"]
    retained = {max(enabled, key=int)} if enabled else set()
    aliases = {key: str(value) for key, value in secret.get("versionAliases", {}).items()}
    retained.update(aliases.values())
    for reference in references:
        number = latest if reference == "latest" else aliases.get(reference, reference)
        if number not in by_number or by_number[number]["state"] != "ENABLED":
            raise RuntimeError(f"Current secret reference is unavailable: {secret['name']}:{reference}")
        retained.add(number)
    deletions = [v for number, v in by_number.items()
                 if number not in retained and v["state"] in ("ENABLED", "DISABLED")]
    return [by_number[number]["name"] for number in sorted(retained, key=int)], deletions


def inventory(cloud, args):
    specs, revisions, fingerprint = runtime_inventory(cloud, args.project, args.region)
    root = f"projects/{args.project}/locations/{args.region}/repositories/{args.repository}"
    repository = cloud.request(ARTIFACTS, f"v1/{root}")
    if repository.get("dockerConfig", {}).get("immutableTags"):
        raise RuntimeError("Cleanup requires a repository with mutable tags")
    images = cloud.listing(ARTIFACTS, f"v1/{root}/dockerImages", "dockerImages")
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
    kept_images, _ = plan_images(images, tags, runtime_images)
    related = image_referrers(cloud, images, kept_images)
    kept_images, delete_images = plan_images(images, tags, runtime_images, related)
    secrets = cloud.listing(SECRETS, f"v1/projects/{args.project}/secrets", "secrets")
    refs = referenced_secrets(specs)
    kept_secrets, delete_secrets = [], []
    secret_fingerprint = []
    for secret in secrets:
        versions = cloud.listing(SECRETS, f"v1/{secret['name']}/versions", "versions")
        secret_fingerprint.append([secret["name"], secret.get("versionAliases", {}),
                                   [(v["name"], v["state"], v.get("etag")) for v in versions]])
        kept, deleted = plan_secrets(secret, versions, refs.get(secret["name"].rsplit("/", 1)[-1], set()))
        if deleted and secret.get("versionDestroyTtl"):
            raise RuntimeError(f"Secret has delayed destruction enabled: {secret['name']}")
        kept_secrets.extend(kept)
        delete_secrets.extend(deleted)
    return {
        "repository": root, "repositoryBytes": int(repository.get("sizeBytes", 0)),
        "runtimeImages": runtime_images, "keepImages": kept_images, "deleteImages": delete_images,
        "keepSecrets": kept_secrets, "deleteSecrets": delete_secrets, "deleteRevisions": revisions,
        "fingerprint": fingerprint, "secretFingerprint": secret_fingerprint,
    }


def apply(cloud, args, plan):
    # Re-read everything before the first mutation. No partially assembled plan
    # or changed live deployment is allowed to trigger deletion.
    fresh = inventory(cloud, args)
    for key in ("fingerprint", "secretFingerprint", "keepImages", "deleteImages"):
        if plan[key] != fresh[key]:
            raise RuntimeError("Inventory changed during planning; rerun cleanup after deployment settles")

    def remove_revision(name):
        result = cloud.request(RUN, f"v2/{name}", method="DELETE")
        cloud.operation(RUN, result)

    # The us-west1 service currently accepts at most 75 versions per batch.
    batches = [plan["deleteImages"][offset:offset + 75] for offset in range(0, len(plan["deleteImages"]), 75)]

    def remove_images(names):
        result = cloud.request(ARTIFACTS, f"v1/{plan['repository']}/packages/-/versions:batchDelete",
                               method="POST", data={"names": names})
        cloud.operation(ARTIFACTS, result)
        return len(names)

    removed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for count in pool.map(remove_images, batches):
            removed += count
            print(f"Removed {removed}/{len(plan['deleteImages'])} old image/metadata versions", flush=True)

    def destroy_version(version):
        cloud.request(SECRETS, f"v1/{version['name']}:destroy", method="POST",
                      data={"etag": version["etag"]})

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(destroy_version, plan["deleteSecrets"]))
    print(f"Destroyed {len(plan['deleteSecrets'])} superseded secret versions", flush=True)
    # These revisions have no traffic or tagged URL. Their images and secret
    # versions can be removed while rate-limited descriptor deletion catches up.
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        for count, _ in enumerate(pool.map(remove_revision, plan["deleteRevisions"]), 1):
            if count % 50 == 0:
                print(f"Removed {count}/{len(plan['deleteRevisions'])} retired revisions", flush=True)
    print(f"Removed {len(plan['deleteRevisions'])} retired revisions", flush=True)
    after = inventory(cloud, args)
    if after["deleteImages"] or after["deleteSecrets"] or after["deleteRevisions"]:
        raise RuntimeError("Cleanup verification found remaining obsolete versions; rerun to finish")
    print("Verified: only deployed images, their signatures, and current secret versions remain", flush=True)


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
