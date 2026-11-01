#!/usr/bin/env python3
"""Keep deployed images; retain secret history; preview unless --apply.

Uses gcloud's existing identity. Never reads secret payloads. Run under the same
production-deploy concurrency group as deployment so builds cannot race cleanup.
"""
import argparse
import concurrent.futures
import datetime
import json
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


def execution_is_active(execution):
    if not isinstance(execution, dict):
        raise RuntimeError("Cloud Run execution inventory row is malformed")
    running_count = execution.get("runningCount", 0)
    if type(running_count) is not int or running_count < 0:
        raise RuntimeError("Cloud Run execution running count is unknown")
    completion = execution.get("completionTime")
    if "completionTime" in execution and completion is None:
        raise RuntimeError("Cloud Run execution completion time is malformed")
    if completion is not None:
        pattern = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})"
        if not isinstance(completion, str) or re.fullmatch(pattern, completion) is None:
            raise RuntimeError("Cloud Run execution completion time is malformed")
        try:
            datetime.datetime.fromisoformat(completion.replace("Z", "+00:00"))
        except ValueError:
            raise RuntimeError("Cloud Run execution completion time is malformed") from None
    conditions = execution.get("conditions", [])
    if not isinstance(conditions, list):
        raise RuntimeError("Cloud Run execution conditions are malformed")
    completed_condition = False
    for condition in conditions:
        if not isinstance(condition, dict):
            raise RuntimeError("Cloud Run execution condition is malformed")
        condition_type = condition.get("type")
        state = condition.get("state")
        if condition_type is not None and not isinstance(condition_type, str):
            raise RuntimeError("Cloud Run execution condition type is malformed")
        if state is not None and not isinstance(state, str):
            raise RuntimeError("Cloud Run execution condition state is malformed")
        if condition_type == "Completed" and state in ("CONDITION_SUCCEEDED", "CONDITION_FAILED"):
            completed_condition = True
    if running_count:
        return True
    return not (completion is not None or completed_condition)


def _resource_id(value):
    return (isinstance(value, str) and 1 <= len(value) <= 63 and value.isascii()
            and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", value) is not None)


def _service_resource(value, project, region):
    prefix = f"projects/{project}/locations/{region}/services/"
    if not isinstance(value, str) or not value.startswith(prefix):
        raise RuntimeError("Cloud Run service inventory contains an out-of-scope resource")
    service_id = value[len(prefix):]
    if not _resource_id(service_id):
        raise RuntimeError("Cloud Run service inventory contains a malformed resource name")
    return value


def _job_resource(value, project, region):
    prefix = f"projects/{project}/locations/{region}/jobs/"
    if not isinstance(value, str) or not value.startswith(prefix):
        raise RuntimeError("Cloud Run job inventory contains an out-of-scope resource")
    job_id = value[len(prefix):]
    if not _resource_id(job_id):
        raise RuntimeError("Cloud Run job inventory contains a malformed resource name")
    return value


def _revision_resource(service_name, value, allow_short=True):
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"Cloud Run revision reference is missing for {service_name}")
    prefix = f"{service_name}/revisions/"
    if value.startswith(prefix):
        suffix = value[len(prefix):]
        if not _resource_id(suffix):
            raise RuntimeError(f"Cloud Run revision reference is malformed for {service_name}")
        return value
    if "/" in value:
        raise RuntimeError(f"Cloud Run revision belongs to another service: {value}")
    if not allow_short or not _resource_id(value):
        raise RuntimeError(f"Cloud Run revision reference is malformed for {service_name}")
    return prefix + value


def _execution_resource(job_name, value):
    prefix = f"{job_name}/executions/"
    if not isinstance(value, str) or not value.startswith(prefix):
        raise RuntimeError("Cloud Run execution inventory contains an out-of-scope resource")
    if not _resource_id(value[len(prefix):]):
        raise RuntimeError("Cloud Run execution inventory contains a malformed resource name")
    return value


def _validate_runtime_spec(spec, context, target_prefix):
    if not isinstance(spec, dict) or set(spec) - {"name", "containers", "volumes"}:
        raise RuntimeError(f"Cloud Run immutable runtime spec is malformed: {context}")
    containers = spec.get("containers")
    if not isinstance(containers, list) or not containers:
        raise RuntimeError(f"Cloud Run immutable runtime spec has no containers: {context}")
    for container in containers:
        if (not isinstance(container, dict) or set(container) - {"image", "env"}
                or not isinstance(container.get("image"), str) or not container["image"]):
            raise RuntimeError(f"Cloud Run immutable runtime container is malformed: {context}")
        if "env" in container and not isinstance(container["env"], list):
            raise RuntimeError(f"Cloud Run immutable runtime environment is malformed: {context}")
        for variable in container.get("env", []):
            if not isinstance(variable, dict) or set(variable) - {"name", "value", "valueSource"}:
                raise RuntimeError(f"Cloud Run immutable runtime environment entry is malformed: {context}")
            source = variable.get("valueSource")
            if source is not None and (not isinstance(source, dict) or set(source) != {"secretKeyRef"}
                    or not isinstance(source["secretKeyRef"], dict)):
                raise RuntimeError(f"Cloud Run immutable runtime secret reference is malformed: {context}")
        image_ref = container["image"]
        if image_ref.startswith(target_prefix):
            image_name, separator, digest = image_ref.partition("@sha256:")
            if (not separator or not image_name[len(target_prefix):] or len(digest) != 64
                    or any(character not in "0123456789abcdef" for character in digest)):
                raise RuntimeError(f"Cloud Run immutable runtime image is not digest-pinned: {context}")
    if "volumes" in spec and not isinstance(spec["volumes"], list):
        raise RuntimeError(f"Cloud Run immutable runtime volumes are malformed: {context}")
    for volume in spec.get("volumes", []):
        if not isinstance(volume, dict) or set(volume) - {"name", "secret"}:
            raise RuntimeError(f"Cloud Run immutable runtime volume is malformed: {context}")
        if volume.get("secret") is not None and not isinstance(volume["secret"], dict):
            raise RuntimeError(f"Cloud Run immutable runtime secret volume is malformed: {context}")
    return spec


def _target_percent(row, service_name):
    percent = row.get("percent", 0)
    if type(percent) is not int or percent < 0 or percent > 100:
        raise RuntimeError(f"Cloud Run traffic percent is unknown for {service_name}")
    return percent


def _target_revision(row, service_name, current, status):
    allocation = row.get("type", "TRAFFIC_TARGET_ALLOCATION_TYPE_UNSPECIFIED")
    if allocation not in (
        "TRAFFIC_TARGET_ALLOCATION_TYPE_UNSPECIFIED",
        "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST",
        "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
    ):
        raise RuntimeError(f"Cloud Run traffic allocation type is unknown for {service_name}")
    revision = row.get("revision")
    if allocation == "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST":
        if status and not revision:
            raise RuntimeError(f"Resolved Cloud Run traffic target has no revision for {service_name}")
        resolved = _revision_resource(service_name, revision) if revision else current
        if resolved != current:
            raise RuntimeError(f"Latest Cloud Run traffic target is not the latest revision for {service_name}")
        return current
    if revision:
        return _revision_resource(service_name, revision)
    if not status and allocation == "TRAFFIC_TARGET_ALLOCATION_TYPE_UNSPECIFIED":
        return current
    raise RuntimeError(f"Cloud Run traffic target has no revision for {service_name}")


def _normalize_traffic_rows(service, current):
    service_name = service.get("name")
    if not isinstance(service_name, str) or not service_name:
        raise RuntimeError("Cloud Run service name is missing")
    spec_rows = service.get("traffic", [])
    status_rows = service.get("trafficStatuses")
    if spec_rows is None:
        spec_rows = []
    if not isinstance(spec_rows, list) or not isinstance(status_rows, list) or not status_rows:
        raise RuntimeError(f"Cloud Run traffic inventory is incomplete: {service_name}")
    if not spec_rows:
        spec_rows = [{"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "percent": 100}]

    def normalize(rows, status):
        normalized = []
        seen_tags = {}
        seen_uris = {}
        addressable_targets = {}
        active_total = 0
        for row in rows:
            if not isinstance(row, dict):
                raise RuntimeError(f"Cloud Run traffic row is malformed: {service_name}")
            allowed = {"revision", "percent", "tag", "type"}
            if status:
                allowed.add("uri")
            if set(row) - allowed:
                raise RuntimeError(f"Cloud Run traffic row has unknown fields: {service_name}")
            percent = _target_percent(row, service_name)
            revision = _target_revision(row, service_name, current, status)
            tag = row.get("tag")
            if tag is not None and (not isinstance(tag, str) or not tag):
                raise RuntimeError(f"Cloud Run traffic tag is malformed: {service_name}")
            uri = row.get("uri") if status else None
            if uri is not None and (not isinstance(uri, str) or not uri):
                raise RuntimeError(f"Cloud Run traffic URI is malformed: {service_name}")
            if uri is not None:
                try:
                    parsed_uri = urllib.parse.urlsplit(uri)
                    valid_uri = (parsed_uri.scheme == "https" and bool(parsed_uri.hostname)
                                 and parsed_uri.username is None and parsed_uri.password is None
                                 and parsed_uri.query == "" and parsed_uri.fragment == ""
                                 and (parsed_uri.port is None or 1 <= parsed_uri.port <= 65535))
                except ValueError:
                    valid_uri = False
                if not valid_uri:
                    raise RuntimeError(f"Cloud Run traffic URI is malformed: {service_name}")
            if status and tag:
                if not uri or tag in seen_tags or uri in seen_uris:
                    raise RuntimeError(f"Cloud Run tagged traffic mapping is incomplete or duplicated: {service_name}")
                seen_tags[tag] = revision
                seen_uris[uri] = tag
                addressable_targets[f"tag:{tag}"] = revision
            elif status and uri:
                if uri in seen_uris:
                    raise RuntimeError(f"Cloud Run traffic URI mapping is duplicated or ambiguous: {service_name}")
                seen_uris[uri] = None
            if status and uri:
                addressable_targets[f"uri:{uri}"] = revision
            normalized.append((revision, percent, tag))
            if percent > 0:
                active_total += percent
                if revision != current:
                    raise RuntimeError(f"Positive Cloud Run traffic targets a historical revision: {service_name}")
        if status and active_total != 100:
            raise RuntimeError(f"Positive Cloud Run traffic does not total 100 percent: {service_name}")
        if len(normalized) != len(set(normalized)):
            raise RuntimeError(f"Cloud Run traffic rows are duplicated: {service_name}")
        return sorted(normalized, key=lambda item: (item[0], item[1], item[2] or "")), addressable_targets

    desired, _desired_refs = normalize(spec_rows, False)
    observed, addressable_targets = normalize(status_rows, True)
    if desired != observed:
        raise RuntimeError(f"Cloud Run desired and observed traffic differ: {service_name}")
    return addressable_targets


def _validate_service_settled(service, project, region):
    service_name = service.get("name") if isinstance(service, dict) else None
    service_name = _service_resource(service_name, project, region)
    current = service.get("latestReadyRevision")
    if not current or current != service.get("latestCreatedRevision"):
        raise RuntimeError(f"Deployment is unsettled: {service_name}")
    current = _revision_resource(service_name, current, allow_short=False)
    generation = service.get("generation")
    observed = service.get("observedGeneration")
    def nonnegative_int64(value):
        return (isinstance(value, str) and 1 <= len(value) <= 19 and value.isascii() and value.isdecimal()
                and int(value) <= 9223372036854775807)
    if not (nonnegative_int64(generation) and nonnegative_int64(observed) and generation == observed):
        raise RuntimeError(f"Cloud Run service generation is unsettled: {service_name}")
    if service.get("reconciling", False) is not False:
        raise RuntimeError(f"Cloud Run service is reconciling or has unknown state: {service_name}")
    terminal = service.get("terminalCondition")
    if not isinstance(terminal, dict) or terminal.get("type") != "Ready" or terminal.get("state") != "CONDITION_SUCCEEDED":
        raise RuntimeError(f"Cloud Run service terminal condition is not successful: {service_name}")
    return current


def runtime_inventory(cloud, project, region, repository="assistant"):
    root = f"projects/{project}/locations/{region}"
    services = cloud.listing(RUN, f"v2/{root}/services", "services", {
        "fields": "services(name,generation,observedGeneration,reconciling,terminalCondition,latestReadyRevision,latestCreatedRevision,traffic,trafficStatuses,uri,urls),nextPageToken",
    })
    if not isinstance(services, list):
        raise RuntimeError("Cloud Run service inventory is malformed")
    service_names = [_service_resource(service.get("name") if isinstance(service, dict) else None, project, region)
                     for service in services]
    if len(service_names) != len(set(service_names)):
        raise RuntimeError("Cloud Run service inventory contains duplicate resources")
    expected_apps = {
        f"projects/{project}/locations/{region}/services/assistant-agent",
        f"projects/{project}/locations/{region}/services/assistant-web",
    }
    if any(service_names.count(name) != 1 for name in expected_apps):
        raise RuntimeError("Cloud Run service inventory is missing or duplicates an application service")
    jobs = cloud.listing(RUN, f"v2/{root}/jobs", "jobs", {
        "fields": f"jobs(name,template(template({CONTAINER_FIELDS}))),nextPageToken",
    })
    if not isinstance(jobs, list):
        raise RuntimeError("Cloud Run job inventory is malformed")
    job_names = [_job_resource(job.get("name") if isinstance(job, dict) else None, project, region)
                 for job in jobs]
    if len(job_names) != len(set(job_names)):
        raise RuntimeError("Cloud Run job inventory contains duplicate resources")
    specs, retired_revisions, revision_inventory = [], [], []
    for service, service_name in zip(services, service_names):
        current = _validate_service_settled(service, project, region)
        addressable_targets = _normalize_traffic_rows(service, current)
        revisions = cloud.listing(RUN, f"v2/{service_name}/revisions", "revisions", {
            "fields": "revisions(name),nextPageToken",
        })
        revision_names = []
        for revision in revisions:
            if not isinstance(revision, dict):
                raise RuntimeError(f"Cloud Run revision inventory is malformed: {service['name']}")
            name = revision.get("name")
            full_name = _revision_resource(service_name, name, allow_short=False)
            if full_name in revision_names:
                raise RuntimeError(f"Cloud Run revision inventory is duplicated: {service['name']}")
            revision_names.append(full_name)
        retained_names = sorted({current, *addressable_targets.values()})
        if not set(retained_names).issubset(set(revision_names)):
            raise RuntimeError(f"A current or tagged Cloud Run revision is missing from the revision inventory: {service_name}")
        retained_specs = {}
        for name in retained_names:
            spec = cloud.request(RUN, f"v2/{name}", params={"fields": f"name,{CONTAINER_FIELDS}"})
            if not isinstance(spec, dict) or spec.get("name") != name:
                raise RuntimeError(f"Cloud Run retained revision spec is missing or mismatched: {service_name}")
            target_prefix = f"{region}-docker.pkg.dev/{project}/{repository}/"
            _validate_runtime_spec(spec, service_name, target_prefix)
            retained_specs[name] = spec
            specs.append(spec)
        revision_inventory.append({
            "service": service_name,
            "revisions": sorted(revision_names),
            "addressableTargets": dict(sorted(addressable_targets.items())),
            "retainedSpecs": retained_specs,
        })
        # Only remove this app's history, never another service's revisions.
        if service_name.rsplit("/", 1)[-1] in ("assistant-agent", "assistant-web"):
            retired_revisions.extend(name for name in revision_names if name not in retained_names)
    for job, job_name in zip(jobs, job_names):
        if not isinstance(job, dict) or set(job) - {"name", "template"}:
            raise RuntimeError("Cloud Run job inventory row is malformed")
        executions = cloud.listing(RUN, f"v2/{job_name}/executions", "executions", {
            "fields": "executions(name,completionTime,runningCount,conditions(type,state)),nextPageToken",
        })
        if not isinstance(executions, list):
            raise RuntimeError("Cloud Run execution inventory is malformed")
        active = False
        execution_names = set()
        for execution in executions:
            if not isinstance(execution, dict):
                raise RuntimeError("Cloud Run execution inventory row is malformed")
            execution_name = _execution_resource(job_name, execution.get("name"))
            if execution_name in execution_names:
                raise RuntimeError("Cloud Run execution inventory contains duplicate resources")
            execution_names.add(execution_name)
            active = execution_is_active(execution) or active
        if active:
            raise RuntimeError(f"A job execution is still active: {job_name}")
        template = job.get("template")
        if not isinstance(template, dict) or set(template) != {"template"} or not isinstance(template.get("template"), dict):
            raise RuntimeError("Cloud Run job template inventory is malformed")
        target_prefix = f"{region}-docker.pkg.dev/{project}/{repository}/"
        specs.append(_validate_runtime_spec(template["template"], job_name, target_prefix))
    fingerprint = json.dumps({"services": services, "jobs": jobs, "revisionInventory": revision_inventory}, sort_keys=True)
    return specs, sorted(set(retired_revisions)), fingerprint


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
        if not isinstance(index, dict) or not isinstance(index.get("manifests"), list):
            raise RuntimeError(f"Current image metadata inventory is unknown: {version}")
        manifests = index["manifests"]
        if any(not isinstance(manifest, dict)
               or not isinstance(manifest.get("digest"), str)
               or re.fullmatch(r"sha256:[0-9a-f]{64}", manifest["digest"]) is None
               for manifest in manifests):
            raise RuntimeError(f"Current image metadata descriptor is malformed: {version}")
        package = version.split("/versions/", 1)[0]
        related[version] = [f"{package}/versions/{manifest['digest']}" for manifest in manifests]
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


def inventory(cloud, args):
    specs, revisions, fingerprint = runtime_inventory(cloud, args.project, args.region, args.repository)
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
    return {
        "repository": root, "repositoryBytes": int(repository.get("sizeBytes", 0)),
        "runtimeImages": runtime_images, "keepImages": kept_images, "deleteImages": delete_images,
        # Deliberately do not enumerate or destroy project-wide Secret Manager
        # history: this region's Cloud Run inventory cannot prove ownership.
        "keepSecrets": [], "deleteSecrets": [], "deleteRevisions": revisions,
        "fingerprint": fingerprint, "secretFingerprint": [],
    }


def apply(cloud, args, plan):
    # Re-read everything before the first mutation. No partially assembled plan
    # or changed live deployment is allowed to trigger deletion.
    fresh = inventory(cloud, args)
    for key in ("fingerprint", "secretFingerprint", "keepImages", "deleteImages", "deleteRevisions"):
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
