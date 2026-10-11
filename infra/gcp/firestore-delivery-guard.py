#!/usr/bin/env python3
"""Temporarily hold Firestore background delivery while a paired release runs.

Only this file's fixed production resource list is addressable. The private
receipt is written before each state change so an uncertain API response can
still be recovered by the workflow's always() step.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlparse
from pathlib import Path
from typing import Any


SCHEDULERS = ("assistant-sweep", "assistant-gmail-sync", "assistant-gmail-watch")
QUEUE = "agent-steps"
SUBSCRIPTION = "gmail-events-push"
PUSH_PATH = "/webhooks/gmail/pubsub"
WORKER_JOBS = {"browser": "assistant-browser", "code": "assistant-code", "processor": "assistant-processor"}


class GuardError(RuntimeError):
    pass


class GoogleApiError(GuardError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class GoogleApi:
    def __init__(self, project: str):
        self.project = project
        self.token = subprocess.check_output(
            ["gcloud", "auth", "print-access-token", f"--project={project}"], text=True
        ).strip()
        if not self.token:
            raise GuardError("gcloud returned an empty access token")

    def request(self, method: str, url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:1000]
            raise GoogleApiError(error.code, f"Google API {method} {url} failed ({error.code}): {detail}") from error
        except urllib.error.URLError as error:
            raise GuardError(f"Google API {method} {url} failed: {error}") from error
        if not body:
            return {}
        try:
            result = json.loads(body)
        except json.JSONDecodeError as error:
            raise GuardError(f"Google API returned invalid JSON for {url}") from error
        if not isinstance(result, dict):
            raise GuardError(f"Google API returned an unexpected response for {url}")
        return result


class DeliveryGuard:
    def __init__(
        self,
        api: GoogleApi,
        project: str,
        location: str,
        receipt_path: Path,
        agent_url: str | None = None,
        drain_timeout: int = 600,
        workers: dict[str, bool] | None = None,
    ):
        self.api = api
        self.project = project
        self.location = location
        self.receipt_path = receipt_path
        self.agent_url = agent_url
        self.drain_timeout = drain_timeout
        self.workers = workers or {}
        self.worker_job_names: list[str] = []
        self.queue_name = f"projects/{project}/locations/{location}/queues/{QUEUE}"
        self.scheduler_names = [
            f"projects/{project}/locations/{location}/jobs/{name}" for name in SCHEDULERS
        ]
        self.subscription_name = f"projects/{project}/subscriptions/{SUBSCRIPTION}"
        self.receipt: dict[str, Any] = {
            "format": 1,
            "project": project,
            "location": location,
            "owned": [],
            "state": "acquiring",
        }

    def _api(self, service: str, path: str) -> str:
        return f"https://{service}.googleapis.com/{path}"

    def _test_permissions(self, resource: str, permissions: list[str], url: str) -> None:
        result = self.api.request("POST", url, {"permissions": permissions})
        available = set(result.get("permissions", []))
        missing = sorted(set(permissions) - available)
        if missing:
            raise GuardError(
                f"delivery guard requires {', '.join(missing)} on {resource}; "
                "no holds were acquired"
            )

    def _read_queue(self) -> dict[str, Any]:
        return self.api.request("GET", self._api("cloudtasks", f"v2/{self.queue_name}"))

    def _read_scheduler(self, name: str) -> dict[str, Any]:
        return self.api.request("GET", self._api("cloudscheduler", f"v1/{name}"))

    def _read_subscription(self) -> dict[str, Any]:
        return self.api.request("GET", self._api("pubsub", f"v1/{self.subscription_name}"))

    def _expected_push_endpoint(self) -> str:
        parsed = urlparse(self.agent_url or "")
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or not parsed.hostname.startswith("assistant-agent-")
            or not parsed.hostname.endswith(".a.run.app")
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise GuardError("assistant-agent status.url is missing or is not its HTTPS Cloud Run URL")
        return f"{self.agent_url.rstrip('/')}{PUSH_PATH}"

    def _inflight_count(self) -> int:
        count = 0
        page_token = ""
        while True:
            query = {"pageSize": "100", "responseView": "BASIC"}
            if page_token:
                query["pageToken"] = page_token
            result = self.api.request(
                "GET",
                self._api("cloudtasks", f"v2/{self.queue_name}/tasks?{urlencode(query)}"),
            )
            for task in result.get("tasks", []):
                attempt = task.get("lastAttempt", {})
                if (
                    int(task.get("dispatchCount") or 0) > int(task.get("responseCount") or 0)
                    and not attempt.get("dispatchTime")
                ):
                    raise GuardError("Cloud Tasks execution has unknown attempt metadata")
                if (
                    int(task.get("dispatchCount") or 0) > int(task.get("responseCount") or 0)
                    and attempt.get("dispatchTime")
                    and not attempt.get("responseTime")
                ):
                    count += 1
            page_token = result.get("nextPageToken", "")
            if not page_token:
                return count

    def _wait_queue_drained(self) -> None:
        deadline = time.monotonic() + self.drain_timeout
        while True:
            active = self._inflight_count()
            if active == 0:
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise GuardError(
                    f"{self.queue_name} still has {active} in-flight task(s) after "
                    f"{self.drain_timeout}s"
                )
            print(f"Waiting for {active} in-flight Cloud Tasks execution(s) to finish.", flush=True)
            time.sleep(min(5, remaining))

    def _executions(self, job_name: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        page_token = ""
        while True:
            query = {"pageSize": "100"}
            if page_token:
                query["pageToken"] = page_token
            result = self.api.request(
                "GET", self._api("run", f"v2/{job_name}/executions?{urlencode(query)}")
            )
            rows.extend(result.get("executions", []))
            page_token = result.get("nextPageToken", "")
            if not page_token:
                return rows

    @staticmethod
    def _execution_active_or_unknown(execution: dict[str, Any]) -> bool:
        if execution.get("completionTime"):
            return False
        terminal = any(
            condition.get("type") == "Completed"
            and (
                condition.get("state") in {"CONDITION_SUCCEEDED", "CONDITION_FAILED"}
                or condition.get("status") == "True"
            )
            for condition in execution.get("conditions", [])
        )
        if terminal:
            return False
        if execution.get("startTime"):
            return True
        raise GuardError(
            f"Cloud Run execution {execution.get('name', '<unnamed>')} has unknown status metadata"
        )

    def _quiescence(self) -> list[str]:
        active: list[str] = []
        task_count = self._inflight_count()
        if task_count:
            active.append(f"{task_count} in-flight Cloud Tasks execution(s)")
        for job_name in self.worker_job_names:
            for execution in self._executions(job_name):
                if self._execution_active_or_unknown(execution):
                    active.append(f"Cloud Run job execution {execution.get('name', '<unnamed>')}")
        return active

    def _wait_for_quiescence(self) -> None:
        deadline = time.monotonic() + self.drain_timeout
        while True:
            active = self._quiescence()
            if not active:
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise GuardError(
                    f"background work did not become quiescent within {self.drain_timeout}s: "
                    + "; ".join(active)
                )
            print("Waiting for background work to finish: " + "; ".join(active), flush=True)
            time.sleep(min(5, remaining))

    @staticmethod
    def _push_config(subscription: dict[str, Any]) -> dict[str, Any]:
        value = subscription.get("pushConfig") or {}
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _push_service_account(push_config: dict[str, Any]) -> tuple[str, str] | None:
        oidc = push_config.get("oidcToken")
        if not oidc:
            return None
        if not isinstance(oidc, dict):
            raise GuardError("Pub/Sub OIDC token configuration is malformed")
        email = oidc.get("serviceAccountEmail")
        match = re.fullmatch(
            r"([a-z][a-z0-9-]{4,28}[a-z0-9])@"
            r"([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com",
            str(email or ""),
        )
        if not match:
            raise GuardError("Pub/Sub OIDC token has a malformed serviceAccountEmail")
        return email, match.group(2)

    def preflight(self) -> dict[str, Any]:
        """Read states and verify every mutation permission before changing anything."""
        queue = self._read_queue()
        schedulers = {name: self._read_scheduler(name) for name in self.scheduler_names}
        subscription = self._read_subscription()
        enabled_schedulers = [name for name, job in schedulers.items() if job.get("state") == "ENABLED"]
        push_config = self._push_config(subscription)
        expected_endpoint = self._expected_push_endpoint()
        if push_config.get("pushEndpoint") and push_config.get("pushEndpoint") != expected_endpoint:
            raise GuardError(
                f"{self.subscription_name} endpoint does not match the expected Gmail push endpoint; "
                "no holds were acquired"
            )

        queue_permissions = ["cloudtasks.queues.get", "cloudtasks.tasks.list"]
        if queue.get("state") == "RUNNING":
            queue_permissions.extend(["cloudtasks.queues.pause", "cloudtasks.queues.resume"])
        self._test_permissions(
            self.queue_name,
            queue_permissions,
            self._api("cloudtasks", f"v2/{self.queue_name}:testIamPermissions"),
        )
        if enabled_schedulers:
            # Scheduler exposes pause/resume but no resource-level testIamPermissions.
            # Project testIamPermissions is its supported permission probe.
            self._test_permissions(
                f"project {self.project}",
                ["cloudscheduler.jobs.get", "cloudscheduler.jobs.pause", "cloudscheduler.jobs.enable"],
                self._api("cloudresourcemanager", f"v1/projects/{self.project}:testIamPermissions"),
            )
        if push_config.get("pushEndpoint"):
            self._test_permissions(
                self.subscription_name,
                ["pubsub.subscriptions.get", "pubsub.subscriptions.update"],
                self._api("pubsub", f"v1/{self.subscription_name}:testIamPermissions"),
            )
            push_identity = self._push_service_account(push_config)
            if push_identity:
                email, service_account_project = push_identity
                service_account = f"projects/{service_account_project}/serviceAccounts/{email}"
                self._test_permissions(
                    service_account,
                    ["iam.serviceAccounts.actAs"],
                    self._api("iam", f"v1/{service_account}:testIamPermissions"),
                )
        self.worker_job_names = []
        for worker, enabled in self.workers.items():
            if not enabled:
                continue
            name = f"projects/{self.project}/locations/{self.location}/jobs/{WORKER_JOBS[worker]}"
            try:
                self.api.request("GET", self._api("run", f"v2/{name}"))
            except GoogleApiError as error:
                if error.status == 404:
                    continue
                raise
            self._test_permissions(
                name,
                ["run.executions.list"],
                self._api("run", f"v2/{name}:testIamPermissions"),
            )
            self.worker_job_names.append(name)
        return {"queue": queue, "schedulers": schedulers, "subscription": subscription}

    def _save(self) -> None:
        self.receipt["updatedUtc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.receipt_path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=".delivery-guard-", dir=self.receipt_path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(self.receipt, stream, indent=2, sort_keys=True)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, self.receipt_path)
            os.chmod(self.receipt_path, 0o600)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    def acquire(self) -> None:
        if self.receipt_path.exists():
            raise GuardError(f"receipt already exists at {self.receipt_path}; inspect it before retrying")
        before = self.preflight()
        self.receipt["before"] = {
            "agentUrl": self.agent_url,
            "expectedPushEndpoint": self._expected_push_endpoint(),
            "queueState": before["queue"].get("state"),
            "schedulerStates": {
                name: job.get("state") for name, job in before["schedulers"].items()
            },
            "pushConfig": self._push_config(before["subscription"]),
        }
        self._save()

        # Re-read each state immediately before mutation. If another actor changed it,
        # do not claim ownership of that change.
        if before["queue"].get("state") == "RUNNING":
            current = self._read_queue().get("state")
            if current != "RUNNING":
                raise GuardError(f"{self.queue_name} changed from RUNNING before pause; stopping")
            self._own("queue", self.queue_name, {"priorState": "RUNNING"})
            self.api.request("POST", self._api("cloudtasks", f"v2/{self.queue_name}:pause"), {})
            if self._read_queue().get("state") != "PAUSED":
                raise GuardError(f"{self.queue_name} did not reach PAUSED")

        for name, job in before["schedulers"].items():
            if job.get("state") != "ENABLED":
                continue
            current = self._read_scheduler(name).get("state")
            if current != "ENABLED":
                raise GuardError(f"{name} changed from ENABLED before pause; stopping")
            self._own("scheduler", name, {"priorState": "ENABLED"})
            self.api.request("POST", self._api("cloudscheduler", f"v1/{name}:pause"), {})
            if self._read_scheduler(name).get("state") != "PAUSED":
                raise GuardError(f"{name} did not reach PAUSED")

        before_push = self._push_config(before["subscription"])
        if before_push.get("pushEndpoint"):
            current_push = self._push_config(self._read_subscription())
            if current_push != before_push:
                raise GuardError(f"{self.subscription_name} changed before it could be paused; stopping")
            self._own("subscription", self.subscription_name, {"priorPushConfig": before_push})
            self.api.request(
                "POST",
                self._api("pubsub", f"v1/{self.subscription_name}:modifyPushConfig"),
                {"pushConfig": {}},
            )
            if self._push_config(self._read_subscription()):
                raise GuardError(f"{self.subscription_name} push delivery did not pause")
        self.receipt["state"] = "held"
        self._save()
        self._wait_for_quiescence()

    def _own(self, kind: str, name: str, values: dict[str, Any]) -> None:
        self.receipt["owned"].append({"kind": kind, "name": name, **values})
        self._save()

    def restore(self) -> None:
        if not self.receipt_path.exists():
            print("No delivery guard receipt; no holds are owned by this run.")
            return
        try:
            receipt = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise GuardError(f"cannot read delivery guard receipt {self.receipt_path}: {error}") from error
        if (
            receipt.get("format") != 1
            or receipt.get("project") != self.project
            or receipt.get("location") != self.location
        ):
            raise GuardError("delivery guard receipt identity does not match this project")
        owned = list(receipt.get("owned", []))
        self._validate_owned_entries(receipt, owned)
        child_group = receipt.get("childProcessGroup")
        if receipt.get("childActive") and child_group and self._process_group_exists(int(child_group)):
            raise GuardError(
                f"release process group {child_group} is still active; delivery holds remain in place"
            )
        failures: list[str] = []
        for item in reversed(owned):
            kind, name = item.get("kind"), item.get("name")
            try:
                self._restore_one(kind, name, item)
                receipt["owned"].remove(item)
                receipt["state"] = "restoring" if receipt["owned"] else "restored"
                self.receipt = receipt
                self._save()
            except Exception as error:  # retain receipt for safe operator recovery
                failures.append(f"{name}: {error}")
        if failures:
            raise GuardError(
                "could not restore every owned delivery hold; receipt retained at "
                f"{self.receipt_path}: " + "; ".join(failures)
            )
        archive = self.receipt_path.with_name(self.receipt_path.stem + ".restored.json")
        os.replace(self.receipt_path, archive)
        os.chmod(archive, 0o600)
        print(f"Restored all owned delivery holds; receipt archived at {archive}")

    def _validate_owned_entries(self, receipt: dict[str, Any], owned: list[dict[str, Any]]) -> None:
        queue_seen = False
        subscription_seen = False
        scheduler_seen: set[str] = set()
        expected_endpoint = receipt.get("before", {}).get("expectedPushEndpoint")
        for item in owned:
            kind, name = item.get("kind"), item.get("name")
            if kind == "queue":
                if queue_seen or name != self.queue_name or item.get("priorState") != "RUNNING":
                    raise GuardError("receipt contains an invalid or duplicate Cloud Tasks queue entry")
                queue_seen = True
            elif kind == "scheduler":
                if (
                    name not in self.scheduler_names
                    or name in scheduler_seen
                    or item.get("priorState") != "ENABLED"
                ):
                    raise GuardError("receipt contains an invalid or duplicate Scheduler entry")
                scheduler_seen.add(name)
            elif kind == "subscription":
                prior = item.get("priorPushConfig")
                if (
                    subscription_seen
                    or name != self.subscription_name
                    or not isinstance(prior, dict)
                    or prior.get("pushEndpoint") != expected_endpoint
                ):
                    raise GuardError("receipt contains an invalid or duplicate Pub/Sub entry")
                subscription_seen = True
            else:
                raise GuardError(f"receipt contains a foreign resource kind {kind!r}")

    def _restore_one(self, kind: str, name: str, item: dict[str, Any]) -> None:
        if kind == "queue":
            state = self._read_queue().get("state")
            if state == item["priorState"]:
                return
            if state != "PAUSED":
                raise GuardError(f"state is {state!r}, expected PAUSED or prior RUNNING")
            self.api.request("POST", self._api("cloudtasks", f"v2/{name}:resume"), {})
            if self._read_queue().get("state") != item["priorState"]:
                raise GuardError("queue did not return to RUNNING")
            return
        if kind == "scheduler":
            state = self._read_scheduler(name).get("state")
            if state == item["priorState"]:
                return
            if state != "PAUSED":
                raise GuardError(f"state is {state!r}, expected PAUSED or prior ENABLED")
            self.api.request("POST", self._api("cloudscheduler", f"v1/{name}:resume"), {})
            if self._read_scheduler(name).get("state") != item["priorState"]:
                raise GuardError("scheduler did not return to ENABLED")
            return
        if kind == "subscription":
            current = self._push_config(self._read_subscription())
            prior = item["priorPushConfig"]
            if current == prior:
                return
            if current:
                raise GuardError("push config changed externally; expected empty paused config")
            self.api.request(
                "POST",
                self._api("pubsub", f"v1/{name}:modifyPushConfig"),
                {"pushConfig": prior},
            )
            if self._push_config(self._read_subscription()) != prior:
                raise GuardError("push config restore did not match the saved configuration")
            return
        raise GuardError(f"unknown receipt resource kind {kind!r}")

    def execute(self, command: list[str]) -> int:
        try:
            self.acquire()
        except Exception:
            # Acquisition can fail after one or more controls were paused.
            try:
                self.restore()
            except GuardError as error:
                print(f"delivery guard restore failed after acquisition error: {error}", file=sys.stderr)
            raise

        child: subprocess.Popen[bytes] | None = None

        interrupted_signal = signal.SIGTERM

        def interrupt(signum: int, _frame: Any) -> None:
            nonlocal interrupted_signal
            interrupted_signal = signum
            if child is not None:
                self._signal_process_group(child.pid, signum)
            raise KeyboardInterrupt

        signal.signal(signal.SIGINT, interrupt)
        signal.signal(signal.SIGTERM, interrupt)
        result = 1
        try:
            child = subprocess.Popen(command, start_new_session=True)
            self.receipt["childProcessGroup"] = child.pid
            self.receipt["childActive"] = True
            self._save()
            result = child.wait()
        except KeyboardInterrupt:
            if child is not None:
                self._stop_process_group(child)
            result = 128 + interrupted_signal
        finally:
            if child is not None:
                self._stop_process_group(child)
                self.receipt["childActive"] = False
                self.receipt["childProcessGroup"] = None
                self._save()
            self.restore()
        return result if result >= 0 else 128 + abs(result)

    @staticmethod
    def _signal_process_group(process_group: int, signum: int) -> None:
        try:
            os.killpg(process_group, signum)
        except ProcessLookupError:
            pass

    @staticmethod
    def _process_group_exists(process_group: int) -> bool:
        try:
            os.killpg(process_group, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    @classmethod
    def _stop_process_group(cls, child: subprocess.Popen[bytes]) -> None:
        if not cls._process_group_exists(child.pid):
            child.wait()
            return
        cls._signal_process_group(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        deadline = time.monotonic() + 5
        while cls._process_group_exists(child.pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        if cls._process_group_exists(child.pid):
            cls._signal_process_group(child.pid, signal.SIGKILL)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        deadline = time.monotonic() + 5
        while cls._process_group_exists(child.pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        if cls._process_group_exists(child.pid):
            raise GuardError(
                f"release process group {child.pid} is still active; delivery holds remain in place"
            )
        child.wait()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("run", "restore"))
    parser.add_argument("--project", required=True)
    parser.add_argument("--location", required=True)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--agent-url")
    parser.add_argument("--drain-timeout-seconds", type=int, default=600)
    for worker in WORKER_JOBS:
        parser.add_argument(f"--worker-{worker}", choices=("true", "false"), default="false")
    return parser


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    if "--" in argv:
        separator = argv.index("--")
        options, command = argv[:separator], argv[separator + 1 :]
    else:
        options, command = argv, []
    args = build_parser().parse_args(options)
    args.command = command
    return args


def main() -> int:
    parser = build_parser()
    args = parse_arguments(sys.argv[1:])
    if not 1 <= args.drain_timeout_seconds <= 3600:
        parser.error("--drain-timeout-seconds must be between 1 and 3600")
    if args.mode == "run" and not args.command:
        parser.error("run mode requires -- followed by the release command")
    try:
        if args.mode == "restore" and not args.receipt.exists():
            print("No delivery guard receipt; no holds are owned by this run.")
            return 0
        api = GoogleApi(args.project)
        guard = DeliveryGuard(
            api,
            args.project,
            args.location,
            args.receipt,
            args.agent_url,
            args.drain_timeout_seconds,
            {worker: getattr(args, f"worker_{worker}") == "true" for worker in WORKER_JOBS},
        )
        if args.mode == "restore":
            guard.restore()
            return 0
        return guard.execute(args.command)
    except GuardError as error:
        print(f"delivery guard failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
