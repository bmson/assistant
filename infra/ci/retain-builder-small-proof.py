#!/usr/bin/env python3
"""Retain existing builder evidence without Docker calls or image archives."""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import stat
from pathlib import Path

FILES = (
    "builder-owner-lease.json",
    "builder-identity.json",
    "builder-volume-identity.json",
    "builder-lifecycle-events.jsonl",
    "builder-cleanup-receipt.json",
)
FILE_CAP = 256 * 1024
BINDING_CAP = 8 * 1024
TOTAL_CAP = 1024 * 1024
SOURCE_FILES = (
    "infra/ci/buildx-builder-lifecycle.py",
    "infra/ci/retain-builder-small-proof.py",
    ".github/workflows/memory-witness-schema-135-qualification.yml",
)


def stamp(value: os.stat_result) -> tuple:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def read_file(directory: int, name: str) -> tuple[bytes | None, dict]:
    """Open by directory FD, reject links, and detect replacement or modification."""
    fd = None
    try:
        # NONBLOCK prevents an unexpected FIFO from hanging before fstat.
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            return None, {"status": "not_regular"}
        if before.st_size > FILE_CAP:
            return None, {"status": "oversize", "bytes": before.st_size}
        chunks = []
        count = 0
        while count <= FILE_CAP:
            chunk = os.read(fd, min(65536, FILE_CAP + 1 - count))
            if not chunk:
                break
            chunks.append(chunk)
            count += len(chunk)
        data = b"".join(chunks)
        after = os.fstat(fd)
        named = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if stamp(before) != stamp(after) or stamp(after) != stamp(named):
            return None, {"status": "unstable"}
        if count > FILE_CAP or count != after.st_size:
            return None, {"status": "unstable"}
        return data, {"status": "copied", "bytes": count, "sha256": hashlib.sha256(data).hexdigest()}
    except OSError as error:
        status = {
            errno.ENOENT: "missing",
            errno.ELOOP: "symlink",
        }.get(error.errno, "read_error")
        return None, {"status": status}
    finally:
        if fd is not None:
            os.close(fd)


def write_exclusive(directory: int, name: str, data: bytes) -> None:
    fd = os.open(
        name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory
    )
    try:
        os.fchmod(fd, 0o600)
        remaining = memoryview(data)
        while remaining:
            written = os.write(fd, remaining)
            if written <= 0:
                raise OSError("short evidence write")
            remaining = remaining[written:]
        os.fsync(fd)
    except OSError:
        os.unlink(name, dir_fd=directory)
        raise
    finally:
        os.close(fd)


def stage(proof: Path, output: Path, source_root: Path, binding: dict) -> bool:
    # A new private directory is required; never merge or overwrite an earlier packet.
    output.mkdir(mode=0o700)
    destination = os.open(output, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    origin = None
    try:
        os.fchmod(destination, 0o700)
        try:
            origin = os.open(proof, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError:
            pass
        entries = {}
        used = 0
        for name in FILES:
            data, entry = (
                read_file(origin, name) if origin is not None else (None, {"status": "source_unavailable"})
            )
            if data is not None and used + len(data) > TOTAL_CAP - BINDING_CAP:
                data = None
                entry = {"status": "total_cap", "bytes": entry["bytes"]}
            if data is not None:
                try:
                    write_exclusive(destination, name, data)
                    used += len(data)
                except OSError:
                    # An incomplete copy is never included as valid evidence.
                    entry = {"status": "write_error"}
            entries[name] = entry
        pins = {}
        for name in SOURCE_FILES:
            # Read these fixed repository paths with the same regular-file/race checks.
            parent = None
            try:
                parent = os.open(source_root / Path(name).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                _, pin = read_file(parent, Path(name).name)
                pins[name] = {**pin, "status": "observed" if pin["status"] == "copied" else pin["status"]}
            except OSError:
                pins[name] = {"status": "read_error"}
            finally:
                if parent is not None:
                    os.close(parent)
        complete = all(entry["status"] == "copied" for entry in entries.values()) and all(
            pin["status"] == "observed" for pin in pins.values()
        )
        receipt = {
            "format": 1,
            **binding,
            "status": "complete" if complete else "incomplete",
            "scope": "retention_only_not_cleanup_qualification",
            "checkedOutSourceFiles": pins,
            "files": entries,
            "limits": {"fileBytes": FILE_CAP, "bindingBytes": BINDING_CAP, "totalBytes": TOTAL_CAP},
            "snapshot": "per_file_stability_checks_not_atomic_multi_file_snapshot",
        }
        encoded = (json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n").encode()
        if len(encoded) > BINDING_CAP or used + len(encoded) > TOTAL_CAP:
            raise ValueError("binding exceeds fixed evidence budget")
        write_exclusive(destination, "binding.json", encoded)
        os.fsync(destination)
        return complete
    finally:
        if origin is not None:
            os.close(origin)
        os.close(destination)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proof", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)
    parser.add_argument("--job-key", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_sha):
        parser.error("source SHA must be forty lowercase hex characters")
    if not all(re.fullmatch(r"[0-9]{1,20}", x) for x in (args.run_id, args.run_attempt)):
        parser.error("run ID and attempt must be bounded decimal values")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.job_key):
        parser.error("job key must be a bounded identifier")
    try:
        complete = stage(args.proof, args.output, Path(__file__).resolve().parents[2], {
            "sourceSha": args.source_sha,
            "runId": args.run_id,
            "runAttempt": args.run_attempt,
            "jobKey": args.job_key,
        })
        print("Builder small-proof retention: " + ("complete" if complete else "incomplete"))
        return 0 if complete else 1
    except (OSError, ValueError):
        print("Builder small-proof retention: unavailable")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

