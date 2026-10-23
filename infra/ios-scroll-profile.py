#!/usr/bin/env python3
"""Run one barrier-controlled, app-only quiet-scroll profile capture."""

from __future__ import annotations

import argparse
import ctypes
import json
import math
import os
import plistlib
import re
import select
import signal
import subprocess
import sys
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

BUNDLE_ID = "com.baldvinsmarason.assistant"
PROFILE_METHOD = "testFullChatView500RowQuietScrollProfile"
PHASES = ("down-1", "up-2", "down-3")
UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")
    os.replace(temporary, path)


def kill_xcode(process: subprocess.Popen, log, reason: str) -> None:
    if process.poll() is not None:
        return
    log.write(f"\n{reason}; terminating xcodebuild process group.\n".encode())
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            log.write(b"xcodebuild process group did not reap after SIGKILL.\n")


def stop_trace(
    process: subprocess.Popen | None,
    log,
    recording_started_at: float | None = None,
) -> int | None:
    if process is None:
        return None
    if process.poll() is not None:
        return process.returncode
    if recording_started_at is None:
        # Startup failed before the trace-start notification. Cleanup has its
        # own 30-second absolute bound and never waits for a recording period.
        cleanup_started_at = time.monotonic()
        deadline = cleanup_started_at + 30
        signal_points = (
            (signal.SIGINT, cleanup_started_at + 10),
            (signal.SIGTERM, cleanup_started_at + 20),
            (signal.SIGKILL, cleanup_started_at + 27),
        )
    else:
        # Keep capture and save time under one deadline: 8 seconds of recording
        # plus at most 30 seconds to finalize, including signal escalation.
        deadline = recording_started_at + 38
        signal_points = (
            (signal.SIGINT, recording_started_at + 18),
            (signal.SIGTERM, recording_started_at + 28),
            (signal.SIGKILL, recording_started_at + 35),
        )
    for sig, signal_at in signal_points:
        delay = max(0.0, min(signal_at, deadline) - time.monotonic())
        try:
            return process.wait(timeout=delay)
        except subprocess.TimeoutExpired:
            pass
        log.write(f"Escalating xctrace child with {sig.name}; absolute deadline={deadline:.3f}.\n".encode())
        try:
            process.send_signal(sig)
        except ProcessLookupError:
            pass
    remaining = max(0.0, deadline - time.monotonic())
    try:
        return process.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        return process.poll()


def bounded_export(command: list[str], output: Path, log_path: Path) -> int:
    with log_path.open("wb") as log:
        proc = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        operation_deadline = time.monotonic() + 10
        total_deadline = operation_deadline + 5
        try:
            return proc.wait(timeout=max(0.0, operation_deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            log.write(b"Export exceeded its 10s operation bound; terminating within the 15s total bound.\n")
            try:
                proc.send_signal(signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                return proc.wait(timeout=min(3, max(0.0, total_deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                try:
                    proc.send_signal(signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    return proc.wait(timeout=max(0.0, total_deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    return 124


def run_bounded(command: list[str], timeout: float, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(command, timeout=timeout, **kwargs)


def process_executable_path(pid: int) -> str:
    proc = ctypes.CDLL("/usr/lib/libproc.dylib")
    proc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    proc.proc_pidpath.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer(4096)
    length = proc.proc_pidpath(pid, buffer, len(buffer))
    if length <= 0:
        raise RuntimeError(f"Could not resolve executable path for app PID {pid}")
    return os.fsdecode(buffer.raw[:length])


def flatten_uuid_values(value, names=()):
    found = []
    if isinstance(value, dict):
        for key, child in value.items():
            next_names = (*names, str(key))
            found.extend(flatten_uuid_values(child, next_names))
    elif isinstance(value, list):
        for child in value:
            found.extend(flatten_uuid_values(child, names))
    elif isinstance(value, str) and any("uuid" in name.lower() for name in names):
        if UUID_RE.fullmatch(value.strip()):
            found.append(value.strip().lower())
    return found


def write_trace_inventory(trace: Path, output_dir: Path, expected_pid: int, profile_id: str, dsym_root: Path) -> dict:
    report = {
        "profileId": profile_id,
        "expectedTargetPID": expected_pid,
        "requestedInstruments": ["Time Profiler", "Points of Interest"],
        "tracePath": str(trace),
        "tocExportStatus": None,
        "tableSchemas": [],
        "tableExports": [],
        "instrumentRunUUIDs": [],
        "traceMetadataUUIDs": [],
        "binaryUUIDs": [],
        "targetPIDObservedInTimeProfilerExport": False,
        "namedProfilePhasesObservedInPointsOfInterestExport": [],
        "phaseSampleOverlap": "unproven",
        "profileAccepted": False,
        "acceptanceError": "Trace tables must be schema-aware checked for same-run target samples overlapping the named signpost intervals.",
    }
    toc = output_dir / f"{profile_id}-trace-toc.xml"
    status = bounded_export(
        ["xcrun", "xctrace", "export", "--input", str(trace), "--toc", "--output", str(toc)],
        toc,
        output_dir / f"{profile_id}-toc-export.log",
    )
    report["tocExportStatus"] = status
    if status != 0 or not toc.exists():
        report["acceptanceError"] = "TOC export failed; raw trace and logs are preserved."
        return report

    try:
        root = ET.parse(toc).getroot()
    except ET.ParseError as error:
        report["acceptanceError"] = f"TOC XML could not be parsed: {error}"
        return report

    run_nodes = [element for element in root.iter() if element.tag.split("}")[-1] == "run"]
    schemas = sorted({element.attrib["schema"] for element in root.iter() if "schema" in element.attrib})
    report["tableSchemas"] = schemas
    run_number = run_nodes[0].attrib.get("number") if len(run_nodes) == 1 else None
    report["instrumentRunUUIDs"] = sorted({
        value.lower()
        for element in run_nodes
        for key, value in element.attrib.items()
        if "uuid" in key.lower() and UUID_RE.fullmatch(value)
    })
    info = trace / "Info.plist"
    if info.is_file():
        try:
            with info.open("rb") as source:
                report["traceMetadataUUIDs"] = sorted(set(flatten_uuid_values(plistlib.load(source))))
        except Exception as error:
            report["traceMetadataError"] = str(error)

    for dwarf in dsym_root.glob("*.dSYM/Contents/Resources/DWARF/*"):
        if not dwarf.is_file():
            continue
        try:
            result = run_bounded(["xcrun", "dwarfdump", "--uuid", str(dwarf)], 5, capture_output=True, text=True)
        except subprocess.TimeoutExpired:
            continue
        if result.returncode == 0:
            report["binaryUUIDs"].extend(re.findall(r"UUID: ([0-9A-Fa-f-]{36})", result.stdout))
    report["binaryUUIDs"] = sorted(set(value.lower() for value in report["binaryUUIDs"]))

    # Use schema names and run numbers discovered in this trace's TOC; never
    # assume a table schema or row layout from another Xcode release.
    cpu_schemas = [schema for schema in schemas
                   if any(term in schema.lower() for term in ("time-profile", "cpu", "sample"))]
    poi_schemas = [schema for schema in schemas
                   if any(term in schema.lower() for term in ("signpost", "points-of-interest"))]
    relevant = sorted(set(cpu_schemas[:2] + poi_schemas[:2]))
    if not relevant:
        # Unknown TOC schemas are still useful QA evidence. Export a small
        # bounded sample of discovered tables without treating their content
        # as recognized profiler data.
        relevant = schemas[:4]
    for index, schema in enumerate(relevant):
        if not run_number:
            break
        table_path = output_dir / f"{profile_id}-table-{index:02d}.xml"
        xpath = f'/trace-toc/run[@number="{run_number}"]/data/table[@schema="{schema}"]'
        export_status = bounded_export(
            ["xcrun", "xctrace", "export", "--input", str(trace), "--xpath", xpath, "--output", str(table_path)],
            table_path,
            output_dir / f"{profile_id}-table-{index:02d}.log",
        )
        table_record = {"schema": schema, "path": str(table_path), "exitStatus": export_status}
        report["tableExports"].append(table_record)
        if export_status == 0 and table_path.exists():
            content = table_path.read_text(errors="replace")
            if schema in poi_schemas:
                report["namedProfilePhasesObservedInPointsOfInterestExport"] = [
                    phase for phase in PHASES
                    if phase in content and profile_id in content
                ]
            if schema in cpu_schemas:
                report["targetPIDObservedInTimeProfilerExport"] = bool(
                    re.search(rf"(?<!\d){expected_pid}(?!\d)", content)
                )
                report["timeProfilerExportContainsAssistantName"] = "Assistant" in content

    if len(run_nodes) != 1:
        report["acceptanceError"] = f"Expected one trace run in TOC; found {len(run_nodes)}."
    elif not report["instrumentRunUUIDs"] and not report["traceMetadataUUIDs"]:
        report["acceptanceError"] = "No trace/run UUID was exposed in TOC or trace metadata."
    elif not report["binaryUUIDs"]:
        report["acceptanceError"] = "No matching build dSYM UUID was found beside the raw trace."
    elif not cpu_schemas or not poi_schemas:
        report["acceptanceError"] = "TOC schema descriptors do not identify both Time Profiler and Points of Interest data; raw TOC is preserved for review."
    elif not report["targetPIDObservedInTimeProfilerExport"]:
        report["acceptanceError"] = "Time Profiler export did not visibly identify the attached Assistant PID."
    elif not {"down-1", "up-2"}.issubset(report["namedProfilePhasesObservedInPointsOfInterestExport"]):
        report["acceptanceError"] = "Points of Interest export did not contain both complete-window candidate phase names; the third phase may extend beyond the 8s trace."
    else:
        report["acceptanceError"] = "Target CPU and all profile signposts are present; same-clock sample/signpost overlap still requires schema-aware timestamp correlation."
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--udid", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--compact", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--trace", type=Path, required=True)
    parser.add_argument("--dsym-root", type=Path, required=True)
    parser.add_argument("--xcode-version", required=True)
    parser.add_argument("--simulator-runtime", required=True)
    parser.add_argument("xcodebuild_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    args.compact.mkdir(parents=True, exist_ok=True)
    if args.xcodebuild_args and args.xcodebuild_args[0] == "--":
        args.xcodebuild_args = args.xcodebuild_args[1:]
    if not args.xcodebuild_args:
        print("xcodebuild arguments are required after --", file=sys.stderr)
        return 2

    report_path = args.compact / "quiet-scroll-profile.json"
    report = {
        "mode": "single-app-only-quiet-scroll-profile",
        "profileMethod": PROFILE_METHOD,
        "xcodeVersion": args.xcode_version,
        "developerDir": os.environ.get("DEVELOPER_DIR"),
        "simulatorRuntime": args.simulator_runtime,
        "simulatorUDID": args.udid,
        "requestedInstruments": ["Time Profiler", "Points of Interest"],
        "recordingLimitSeconds": 8,
        "profileAccepted": False,
        "status": "starting",
    }
    atomic_json(report_path, report)

    # The receiver must be subscribed before xctrace launches; Popen alone is
    # not proof that notifyd registered this unique Darwin notification.
    notify = ctypes.CDLL("/usr/lib/system/libsystem_notify.dylib")
    notify.notify_register_file_descriptor.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_int), ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
    notify.notify_register_file_descriptor.restype = ctypes.c_uint32
    notify.notify_cancel.argtypes = [ctypes.c_int]
    notify.notify_cancel.restype = ctypes.c_uint32
    xcode = None
    trace_proc = None
    trace_log_file = None
    listener_fd = None
    listener_token = ctypes.c_int(0)
    ready = None
    release_sent = False
    trace_started_at = None
    log_file = args.log.open("wb", buffering=0)
    xcode_started = time.monotonic()
    xcode_started_wall = time.time()

    def abort_ready(reason: str) -> None:
        if not ready or release_sent:
            return
        try:
            profile_id = str(uuid.UUID(ready.get("profileId", "")))
        except (ValueError, TypeError, AttributeError):
            return
        abort_path = Path(ready.get("abortPath", ""))
        if app_container is None:
            return
        cache_path = app_container / "Library" / "Caches"
        if abort_path != cache_path / f"scroll-profile-{profile_id}.abort.json":
            return
        if Path(ready.get("readyPath", "")) != cache_path / f"scroll-profile-{profile_id}.ready.json":
            return
        atomic_json(abort_path, {"schemaVersion": 1, "profileId": profile_id, "reason": reason, "aborted": True})

    try:
        xcode = subprocess.Popen(["xcodebuild", *args.xcodebuild_args], stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True)
        app_container = None
        container_deadline = xcode_started + 180
        while time.monotonic() < container_deadline:
            if xcode.poll() is not None:
                raise RuntimeError(f"xcodebuild exited before app container was ready (status {xcode.returncode})")
            try:
                result = run_bounded(["xcrun", "simctl", "get_app_container", args.udid, BUNDLE_ID, "data"], 4, capture_output=True, text=True)
            except subprocess.TimeoutExpired:
                time.sleep(0.25)
                continue
            if result.returncode == 0:
                app_container = Path(result.stdout.strip())
                cache = app_container / "Library" / "Caches"
                if cache.is_dir():
                    break
            time.sleep(0.25)
        if app_container is None or not cache.is_dir():
            raise RuntimeError("Assistant app data container did not become available within 180s")

        readiness_deadline = time.monotonic() + 180
        ready_path = None
        while time.monotonic() < readiness_deadline:
            if xcode.poll() is not None:
                raise RuntimeError(f"xcodebuild exited before publishing readiness (status {xcode.returncode})")
            candidates = sorted(cache.glob("scroll-profile-*.ready.json"), key=lambda p: p.stat().st_mtime, reverse=True)
            for candidate in candidates:
                try:
                    if candidate.stat().st_mtime < xcode_started_wall - 1:
                        continue
                    value = json.loads(candidate.read_text())
                except Exception:
                    continue
                ready_uptime = value.get("monotonicReadyUptime")
                if (value.get("schemaVersion") == 1 and value.get("readyPath") == str(candidate)
                        and isinstance(ready_uptime, (int, float)) and math.isfinite(ready_uptime)
                        and ready_uptime >= xcode_started):
                    ready_path, ready = candidate, value
                    break
            if ready_path:
                break
            time.sleep(0.1)
        if not ready_path or not ready:
            raise RuntimeError("Profile fixture readiness did not arrive within 180s")

        profile_id = ready.get("profileId", "")
        uuid.UUID(profile_id)
        expected_ready = cache / f"scroll-profile-{profile_id}.ready.json"
        release_path = cache / f"scroll-profile-{profile_id}.release.json"
        abort_path = cache / f"scroll-profile-{profile_id}.abort.json"
        if ready_path != expected_ready or Path(ready.get("releasePath", "")) != release_path or Path(ready.get("abortPath", "")) != abort_path:
            raise RuntimeError("Readiness paths do not match the UUID-scoped app-cache protocol")
        if ready.get("bundleId") != BUNDLE_ID or not isinstance(ready.get("pid"), int) or ready["pid"] <= 0:
            raise RuntimeError("Readiness did not identify the hosted Assistant app process")
        ready_executable = ready.get("executablePath")
        if not isinstance(ready_executable, str) or not ready_executable:
            raise RuntimeError("Readiness did not include the hosted Assistant executable path")
        executable_path = process_executable_path(ready["pid"])
        executable = Path(executable_path)
        if executable.name != "Assistant" or executable.parent.name != "Assistant.app":
            raise RuntimeError(f"Ready PID is not the hosted Assistant executable: {executable_path}")
        try:
            if executable.resolve(strict=True) != Path(ready_executable).resolve(strict=True):
                raise RuntimeError(
                    "Readiness executablePath does not match the live PID executable "
                    f"({ready_executable!r} != {executable_path!r})"
                )
        except OSError as error:
            raise RuntimeError(f"Could not resolve readiness/PID executable paths: {error}") from error
        if ready.get("messageCount") != 500 or not re.fullmatch(r"[0-9a-fA-F]{64}", ready.get("fixtureSHA256", "")):
            raise RuntimeError("Readiness fixture identity is invalid")
        if not isinstance(ready.get("monotonicReadyUptime"), (int, float)) or not math.isfinite(ready["monotonicReadyUptime"]):
            raise RuntimeError("Readiness monotonic uptime is invalid")
        notify_key = ready.get("notifyKey")
        if not isinstance(notify_key, str) or not notify_key.startswith("com.baldvinsmarason.assistant.scroll-profile."):
            raise RuntimeError("Readiness notification key is not task-scoped")

        signal_key = notify_key.encode()
        fd = ctypes.c_int(-1)
        registration = notify.notify_register_file_descriptor(signal_key, ctypes.byref(fd), 0, ctypes.byref(listener_token))
        if registration != 0 or fd.value < 0:
            raise RuntimeError(f"Could not register Darwin listener before xctrace (notify status={registration})")
        listener_fd = fd.value

        trace_path = args.trace.with_name(f"{profile_id}-{args.trace.name}")
        trace_log_path = trace_path.with_suffix(".log")
        trace_log_file = trace_log_path.open("wb", buffering=0)
        trace_proc = subprocess.Popen(
            ["xcrun", "xctrace", "record", "--template", "Time Profiler",
             "--instrument", "Points of Interest", "--device", args.udid,
             "--attach", str(ready["pid"]), "--time-limit", "8s",
             "--notify-tracing-started", signal_key.decode(), "--output", str(trace_path)],
            stdout=trace_log_file, stderr=subprocess.STDOUT, start_new_session=True,
        )
        start_deadline = time.monotonic() + 30
        while time.monotonic() < start_deadline:
            if trace_proc.poll() is not None:
                raise RuntimeError(f"xctrace exited before its tracing-started notification (status {trace_proc.returncode})")
            ready_fds, _, _ = select.select([listener_fd], [], [], 0.1)
            if ready_fds:
                os.read(listener_fd, 4)
                trace_started_at = time.monotonic()
                break
        else:
            raise TimeoutError("xctrace did not send tracing-started within 30s")

        # Only xctrace emits this notification. The file-based GO carries the
        # observed key; the controller never manufactures a tracing-started signal.
        release = {
            "schemaVersion": 1,
            "profileId": profile_id,
            "recordingStartedNotifyKey": notify_key,
            "recordingStarted": True,
            "recordingStartedObserved": True,
            "recordingStartedUptime": time.monotonic(),
        }
        if not math.isfinite(release["recordingStartedUptime"]):
            raise RuntimeError("Controller monotonic release uptime is invalid")
        atomic_json(release_path, release)
        release_sent = True
        report.update({
            "profileId": profile_id,
            "fixtureSHA256": ready["fixtureSHA256"],
            "messageCount": ready["messageCount"],
            "targetPID": ready["pid"],
            "readyExecutablePath": ready_executable,
            "targetExecutablePath": executable_path,
            "tracePath": str(trace_path),
            "xctraceStartedNotifyKey": signal_key.decode(),
            "recordingStartedUptime": release["recordingStartedUptime"],
            "status": "recording",
        })
        atomic_json(report_path, report)

        trace_status = stop_trace(trace_proc, trace_log_file, trace_started_at)
        trace_log_file.close()
        trace_log_file = None
        trace_proc = None
        report["xctraceExitStatus"] = trace_status
        report["traceLog"] = str(trace_log_path)
        report["status"] = "trace-finished"
        atomic_json(report_path, report)

        remaining = max(0.0, 180 - (time.monotonic() - xcode_started))
        try:
            xcode_status = xcode.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            kill_xcode(xcode, log_file, "quiet-scroll XCTest exceeded its 180s bound")
            xcode_status = xcode.poll() if xcode.poll() is not None else 124
        report["xcodebuildExitStatus"] = xcode_status
        log_file.flush()
        log_file.close()

        raw_records = []
        text = args.log.read_text(errors="replace")
        marker = "FULL_CHAT_VIEW_PHASE_DIAGNOSTIC"
        decoder = json.JSONDecoder()
        cursor = 0
        while True:
            at = text.find(marker, cursor)
            if at < 0:
                break
            start = at + len(marker)
            while start < len(text) and text[start].isspace():
                start += 1
            try:
                record, end = decoder.raw_decode(text, start)
            except json.JSONDecodeError:
                cursor = start + 1
                continue
            cursor = end
            if isinstance(record, dict) and record.get("mode") == "quiet-500-row-scroll-profile":
                raw_records.append(record)
        phase_sidecar = args.compact / f"{profile_id}-phase-reports.jsonl"
        phase_sidecar.write_text("".join(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n" for record in raw_records))
        phase_names = [record.get("phase") for record in raw_records]
        phases_valid = len(raw_records) == 3 and set(phase_names) == set(PHASES)
        previous_end = None
        for record in raw_records:
            phases_valid = phases_valid and record.get("profileId") == profile_id and record.get("fixtureSHA256") == ready["fixtureSHA256"] and record.get("messageCount") == 500
            phase_start, phase_end = record.get("phaseStartUptime"), record.get("phaseEndUptime")
            phases_valid = phases_valid and isinstance(phase_start, (int, float)) and math.isfinite(phase_start)
            phases_valid = phases_valid and isinstance(phase_end, (int, float)) and math.isfinite(phase_end)
            if isinstance(phase_start, (int, float)) and isinstance(phase_end, (int, float)):
                phases_valid = phases_valid and phase_end > phase_start
                if previous_end is not None:
                    phases_valid = phases_valid and phase_start >= previous_end
                previous_end = phase_end
        test_passed = re.findall(
            r"Test Case '-\[AssistantTests\.ConversationScrollPerformanceTests testFullChatView500RowQuietScrollProfile\]' (passed|failed|skipped)",
            text,
        ) == ["passed"]
        report["phaseReportPath"] = str(phase_sidecar)
        report["phaseNames"] = phase_names
        report["phaseReportsValid"] = bool(phases_valid)
        report["xctestMethodPassedExactlyOnce"] = test_passed
        report["traceInventory"] = write_trace_inventory(trace_path, args.compact, ready["pid"], profile_id, args.dsym_root) if trace_path.exists() else {"profileAccepted": False, "acceptanceError": "No trace bundle was produced."}
        inventory_path = args.compact / f"{profile_id}-trace-inventory.json"
        atomic_json(inventory_path, report["traceInventory"])
        report["traceInventoryPath"] = str(inventory_path)
        report["profileAccepted"] = False
        report["status"] = "captured-requires-manual-profile-review"
        report["acceptanceError"] = "Capture and phase receipts are retained, but no profile is accepted until QA verifies the actual TOC schema, target CPU samples, and same-trace sample/signpost overlap."
        if xcode_status != 0:
            report["acceptanceError"] += f" XCTest exited with status {xcode_status}."
        if trace_status != 0:
            report["acceptanceError"] += f" xctrace exited with status {trace_status}."
        if not phases_valid:
            report["acceptanceError"] += " The three profile phase receipts are incomplete or inconsistent."
        atomic_json(report_path, report)
        # Workflow success means the single capture and fixture completed; it
        # does not accept CPU conclusions. That requires human review of the
        # actual schemas and same-trace time correlation in the preserved files.
        return 0 if xcode_status == 0 and trace_status == 0 and phases_valid and test_passed else 1
    except Exception as error:
        report["status"] = "failed"
        report["error"] = f"{type(error).__name__}: {error}"
        if ready and not release_sent:
            try:
                abort_ready(str(error))
            except Exception as abort_error:
                report["abortWriteError"] = str(abort_error)
        if trace_proc is not None:
            report["xctraceExitStatus"] = stop_trace(trace_proc, trace_log_file or log_file, trace_started_at if release_sent else None)
            trace_proc = None
        if trace_log_file is not None and not trace_log_file.closed:
            trace_log_file.close()
        if xcode is not None and xcode.poll() is None:
            kill_xcode(xcode, log_file, "profile controller failed")
        if not log_file.closed:
            log_file.close()
        atomic_json(report_path, report)
        return 1
    finally:
        if listener_fd is not None:
            try:
                os.close(listener_fd)
                notify.notify_cancel(listener_token.value)
            except Exception:
                pass
        if trace_proc is not None and trace_proc.poll() is None:
            stop_trace(trace_proc, trace_log_file or log_file, trace_started_at if release_sent else None)
        if trace_log_file is not None and not trace_log_file.closed:
            trace_log_file.close()
        if xcode is not None and xcode.poll() is None:
            kill_xcode(xcode, log_file, "profile controller cleanup")


if __name__ == "__main__":
    raise SystemExit(main())
