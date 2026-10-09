#!/usr/bin/env python3
"""Run CF-05 browser and Firestore adapter acceptance against prestarted loopback services only."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from typing import Any

LOOPBACK = {"localhost", "127.0.0.1", "::1"}
CREDENTIAL_KEYS = {
    "OPENAI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY",
    "GEMINI_API_KEY", "AZURE_OPENAI_API_KEY", "COHERE_API_KEY", "MISTRAL_API_KEY",
    "GROQ_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "GCLOUD_PROJECT",
}


class CheckError(RuntimeError):
    pass


def fail_if(condition: bool, message: str) -> None:
    if condition:
        raise CheckError(message)


def parse_loopback_url(value: str) -> tuple[str, int]:
    try:
        url = urlsplit(value)
        port = url.port
    except ValueError:
        raise CheckError("Malformed loopback URL") from None
    if url.scheme != "http" or url.hostname not in LOOPBACK or not port or url.path not in {"", "/"} or url.username or url.password or url.query or url.fragment:
        raise CheckError("App URL must be a plain HTTP loopback origin")
    return url.hostname, port


def check_manifest(data: dict[str, Any], *, expected_sha: str, expected_branch: str, source_root: pathlib.Path, app_url: str, now: dt.datetime | None = None) -> None:
    required = {
        "baseUrl", "appSha", "persistenceDriver", "firestoreEmulatorHost", "firestoreProjectId",
        "firestoreDatabaseId", "installationId", "ownerId", "queueDriver", "sourceRoot",
        "sourceBranch", "sourceCommit", "sourceTreeClean", "serverPid", "serverCommandSha256",
        "serverWorkingDirectory", "firestoreEmulatorPid", "isolatedDatabaseConfirmed",
        "installationOwnerCount", "noWorkerAttached", "providerCallsDisabled",
        "verificationStatus", "verifiedAt",
    }
    missing = sorted(required - data.keys())
    fail_if(bool(missing), "Root verification manifest lacks required fields: " + ", ".join(missing))
    root = source_root.resolve(strict=True)
    manifest_root = pathlib.Path(data["sourceRoot"]).resolve(strict=True)
    fail_if(manifest_root != root, "Manifest source root does not match selected worktree")
    fail_if("/.codex/worktrees/" not in str(root), "Selected source must be a managed isolated worktree")
    fail_if(str(root).endswith("/Code/Personal/assistant"), "Primary checkout is forbidden for CF-05 runtime acceptance")
    fail_if(data["sourceCommit"] != expected_sha or data["appSha"] != expected_sha, "Source SHA does not match the explicitly pinned SHA")
    fail_if(data["sourceBranch"] != expected_branch, "Source branch does not match explicit selection")
    fail_if(data["sourceTreeClean"] is not True, "Selected source worktree is not clean")
    fail_if(data["serverWorkingDirectory"] != str(root), "App working directory does not match selected worktree")
    fail_if(data["persistenceDriver"] != "firestore", "CF-05 runtime acceptance requires Firestore")
    fail_if(data["queueDriver"] != "local", "CF-05 browser acceptance requires the inert local queue")
    fail_if(data["noWorkerAttached"] is not True, "A worker is attached to the local queue")
    fail_if(data["providerCallsDisabled"] is not True, "Provider calls are not disabled for the deterministic action fixture")
    fail_if(data["isolatedDatabaseConfirmed"] is not True, "Firestore database isolation is not attested")
    fail_if(data["installationOwnerCount"] != 1, "The isolated installation must contain exactly one owner")
    fail_if(not re.fullmatch(r"cf05-[A-Za-z0-9_-]{8,128}", str(data["installationId"])), "Installation ID is not a dedicated CF-05 identity")
    fail_if(not re.fullmatch(r"[0-9a-f-]{36}", str(data["ownerId"]), re.I), "Owner ID is malformed")
    fail_if(data["verificationStatus"] != "root-verified", "Root verification status is not trusted")
    verified = dt.datetime.fromisoformat(str(data["verifiedAt"]).replace("Z", "+00:00"))
    observed = now or dt.datetime.now(dt.timezone.utc)
    fail_if(abs((observed - verified).total_seconds()) > 300, "Root verification manifest is stale")
    app_host, app_port = parse_loopback_url(app_url)
    manifest_host, manifest_port = parse_loopback_url(data["baseUrl"])
    fail_if((app_host, app_port) != (manifest_host, manifest_port), "Manifest app URL differs from selected loopback origin")
    firestore_host = str(data["firestoreEmulatorHost"])
    if firestore_host.startswith("["):
        match = re.fullmatch(r"\[::1\]:(\d+)", firestore_host)
        fail_if(not match, "Firestore emulator must be a loopback host and port")
    else:
        match = re.fullmatch(r"(localhost|127\.0\.0\.1):(\d+)", firestore_host, re.I)
        fail_if(not match, "Firestore emulator must be a loopback host and port")
    firestore_port = int(match.group(match.lastindex or 1))
    if firestore_host.startswith("["):
        firestore_port = int(match.group(1))
    fail_if(not (1 <= firestore_port <= 65535), "Firestore emulator port is invalid")
    fail_if(not str(data["firestoreProjectId"]).startswith("demo-"), "Use a dedicated non-production Firestore emulator project")
    fail_if(not str(data["firestoreDatabaseId"]), "Firestore database ID must be explicit")
    for name in ("serverPid", "firestoreEmulatorPid"):
        fail_if(not isinstance(data[name], int) or data[name] < 2, f"{name} is invalid")
    fail_if(not re.fullmatch(r"[0-9a-f]{64}", str(data["serverCommandSha256"])), "Server command digest attestation is missing")


def run_checked(command: list[str], *, cwd: pathlib.Path, env: dict[str, str], timeout: int) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout, check=True)
    except subprocess.TimeoutExpired:
        raise CheckError("A local CF-05 check timed out") from None
    except subprocess.CalledProcessError as exc:
        raise CheckError(f"A local CF-05 check failed (exit {exc.returncode})") from None
    except OSError as exc:
        raise CheckError(f"Could not run a local CF-05 check ({type(exc).__name__})") from None


def pid_command(pid: int) -> str:
    result = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, timeout=5)
    if result.returncode != 0:
        raise CheckError("An attested local process is not running")
    return result.stdout.strip()


def process_cwd(pid: int) -> pathlib.Path:
    result = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True, timeout=5)
    if result.returncode != 0:
        raise CheckError("Could not verify an attested process working directory")
    values = [line[1:] for line in result.stdout.splitlines() if line.startswith("n")]
    if len(values) != 1:
        raise CheckError("Could not uniquely verify an attested process working directory")
    return pathlib.Path(values[0]).resolve(strict=True)


def listener_pids(port: int) -> set[int]:
    result = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"], capture_output=True, text=True, timeout=5)
    if result.returncode not in {0, 1}:
        raise CheckError("Could not inspect loopback listener ownership")
    try:
        return {int(line) for line in result.stdout.splitlines() if line.strip()}
    except ValueError:
        raise CheckError("Loopback listener returned malformed process identity") from None


def verify_live(data: dict[str, Any], source_root: pathlib.Path, app_url: str) -> None:
    if not shutil.which("lsof"):
        raise CheckError("lsof is required to verify loopback process ownership")
    app_pid = data["serverPid"]
    app_cmd = pid_command(app_pid)
    import hashlib
    fail_if(hashlib.sha256(app_cmd.encode()).hexdigest() != data["serverCommandSha256"], "Live app command differs from root attestation")
    fail_if(process_cwd(app_pid) != source_root.resolve(strict=True), "Live app process cwd differs from selected worktree")
    app_port = parse_loopback_url(app_url)[1]
    fail_if(app_pid not in listener_pids(app_port), "Attested app process does not own the selected loopback listener")
    emulator_pid = data["firestoreEmulatorPid"]
    emulator_host = str(data["firestoreEmulatorHost"])
    emulator_port = int(emulator_host.rsplit(":", 1)[1])
    fail_if(emulator_pid not in listener_pids(emulator_port), "Attested emulator process does not own the loopback emulator listener")
    # Pin the live checkout, clean tree, and branch again immediately before the run.
    for command, expected in ((["git", "rev-parse", "HEAD"], data["sourceCommit"]), (["git", "branch", "--show-current"], data["sourceBranch"])):
        result = subprocess.run(command, cwd=source_root, capture_output=True, text=True, timeout=5)
        if result.returncode != 0 or result.stdout.strip() != expected:
            raise CheckError("Selected source revision changed after attestation")
    status = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=source_root, capture_output=True, text=True, timeout=5)
    fail_if(status.returncode != 0 or bool(status.stdout.strip()), "Selected source worktree changed after attestation")
    # Disable proxies for this one health request; the supplied origin is checked loopback only.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(app_url.rstrip("/") + "/api/health", timeout=5) as response:
            fail_if(response.status != 200, "Local app health check failed")
            payload = json.loads(response.read())
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        raise CheckError("Could not verify the local app health SHA") from None
    fail_if(payload.get("sha") != data["appSha"], "Live app health SHA differs from the pinned source")


def child_environment(data: dict[str, Any], *, app_url: str, expected_sha: str, manifest_path: pathlib.Path, receipt_path: pathlib.Path, report_path: pathlib.Path) -> dict[str, str]:
    env = dict(os.environ)
    for key in CREDENTIAL_KEYS:
        env.pop(key, None)
    env.update({
        "ASSISTANT_CHAT_BASE_URL": app_url,
        "ASSISTANT_CHAT_EXPECTED_SHA": expected_sha,
        "ASSISTANT_CHAT_EXPECTED_BRANCH": str(data["sourceBranch"]),
        "ASSISTANT_CHAT_ROOT_VERIFIED_MANIFEST": str(manifest_path),
        "ASSISTANT_CHAT_RUN_RECEIPT_PATH": str(receipt_path),
        "CF05_ADAPTER_REPORT_PATH": str(report_path),
        "FIRESTORE_EMULATOR_HOST": str(data["firestoreEmulatorHost"]),
        "GCLOUD_PROJECT": str(data["firestoreProjectId"]),
        "GOOGLE_CLOUD_PROJECT": str(data["firestoreProjectId"]),
        "HTTP_PROXY": "http://127.0.0.1:9",
        "HTTPS_PROXY": "http://127.0.0.1:9",
        "ALL_PROXY": "http://127.0.0.1:9",
        "NO_PROXY": "127.0.0.1,localhost,::1",
        "npm_config_offline": "true",
    })
    return env


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--expected-branch", required=True)
    parser.add_argument("--app-url", required=True)
    parser.add_argument("--root-manifest", required=True)
    parser.add_argument("--browser-fixture", default="scripts/cf05-mounted-chat-admission.browser.ts")
    parser.add_argument("--adapter-fixture", default="scripts/cf05-firestore-admission-and-late-completion.ts")
    args = parser.parse_args()
    try:
        root = pathlib.Path(args.source_root).resolve(strict=True)
        manifest_path = pathlib.Path(args.root_manifest).resolve(strict=True)
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        fail_if(not re.fullmatch(r"[0-9a-f]{40}", args.expected_sha), "Expected SHA must be a full git commit")
        check_manifest(data, expected_sha=args.expected_sha, expected_branch=args.expected_branch, source_root=root, app_url=args.app_url)
        verify_live(data, root, args.app_url)
        for rel in (args.browser_fixture, args.adapter_fixture):
            fixture = (root / rel).resolve(strict=True)
            fail_if(not fixture.is_relative_to(root), "Fixture path escapes selected source root")
            fail_if(not fixture.is_file(), "Fixture file is missing from selected source")
        artifact_dir = pathlib.Path(tempfile.mkdtemp(prefix="cf05-mounted-replay-"))
        os.chmod(artifact_dir, 0o700)
        receipt = artifact_dir / "mounted-browser-receipt.json"
        report = artifact_dir / "firestore-adapter-report.json"
        env = child_environment(data, app_url=args.app_url, expected_sha=args.expected_sha, manifest_path=manifest_path, receipt_path=receipt, report_path=report)
        print(json.dumps({"status": "preflight-passed", "sourceSha": args.expected_sha, "appOrigin": args.app_url, "artifacts": str(artifact_dir)}))
        run_checked(["pnpm", "exec", "tsx", args.browser_fixture], cwd=root, env=env, timeout=300)
        if not receipt.is_file():
            raise CheckError("Mounted browser fixture produced no durable receipt file")
        run_checked(["pnpm", "exec", "tsx", args.adapter_fixture], cwd=root, env=env, timeout=300)
        if not report.is_file():
            raise CheckError("Firestore adapter fixture produced no report")
        result = json.loads(report.read_text(encoding="utf-8"))
        if result.get("sourceSha") != args.expected_sha or result.get("workerProcessesStarted") != 0 or result.get("providerCalls") != 0:
            raise CheckError("Adapter report did not match the isolated acceptance contract")
        print(json.dumps({"status": "cf05-mounted-and-adapter-subset-exercised", "sourceSha": args.expected_sha, "artifactDir": str(artifact_dir), "browserReceiptSha256": __import__("hashlib").sha256(receipt.read_bytes()).hexdigest(), "adapterReport": result}))
        return 0
    except Exception as exc:
        message = str(exc) if isinstance(exc, CheckError) else f"Unexpected harness failure ({type(exc).__name__})"
        print(json.dumps({"status": "not-exercised", "error": message[:300]}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
