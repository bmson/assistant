#!/usr/bin/env python3
"""One opt-in Debug Time Profiler capability attempt; never called implicitly.
Inputs are an already-built xctestrun and already-booted CI simulator. Build
inputs are inventoried, not copied or excluded from the declared receipt.
All *new* output, including the full profile xcresult, is under one capped root.
"""
import ctypes
import hashlib
import json
import os
import multiprocessing
import re
from pathlib import Path
import plistlib
import signal
import stat
import subprocess
import sys
import time
import uuid
import xml.etree.ElementTree as ET

MIB = 1024 * 1024
CAP = 1024 * MIB
TRACE_CAP = 100 * MIB
WALL = 300
BUNDLE = 'com.baldvinsmarason.assistant'
METHOD = 'AssistantTests/ConversationScrollPerformanceTests/testOwnedTranscriptProfilingCapability'


def owned_size(path):
    """Count only regular owned bytes. Never follow a link outside the root."""
    try:
        root = path.lstat()
    except FileNotFoundError:
        return 0
    if stat.S_ISLNK(root.st_mode):
        raise RuntimeError('UNEXPECTED_SYMLINK:' + str(path))
    if stat.S_ISREG(root.st_mode):
        return root.st_size
    if not stat.S_ISDIR(root.st_mode):
        raise RuntimeError('UNEXPECTED_OUTPUT_TYPE:' + str(path))
    total = 0
    def traversal_error(error):
        raise error
    for current, dirs, files in os.walk(path, followlinks=False, onerror=traversal_error):
        for name in dirs + files:
            entry = Path(current) / name
            try:
                details = entry.lstat()
            except FileNotFoundError:
                continue  # Concurrent atomic rename; next watchdog sample recounts.
            if stat.S_ISLNK(details.st_mode):
                raise RuntimeError('UNEXPECTED_SYMLINK:' + str(entry))
            if stat.S_ISREG(details.st_mode):
                total += details.st_size
            elif not stat.S_ISDIR(details.st_mode):
                raise RuntimeError('UNEXPECTED_OUTPUT_TYPE:' + str(entry))
    return total


def watchdog(output, registry, finished, parent_pid, parent_identity, deadline):
    """Inspection failures stop work; no failed inspection authorizes a kill."""
    def identity(pid):
        result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart=', '-o', 'comm='],
                                capture_output=True, text=True, timeout=2)
        if result.returncode not in (0, 1):
            raise RuntimeError('WATCHDOG_PS_INSPECTION_FAILED')
        return result.stdout.strip() if result.returncode == 0 else None
    retained = {}
    reason = None
    total = trace = None
    try:
        while not finished.wait(0.2):
            if registry.is_symlink():
                raise RuntimeError('REGISTRY_SYMLINK')
            state = json.loads(registry.read_text()) if registry.exists() else {'processes': {}}
            retained.update({int(pid): value for pid, value in state.get('processes', {}).items()})
            for pid, value in list(retained.items()):
                if identity(pid) != value:
                    continue
                descendants = subprocess.run(['pgrep', '-P', str(pid)], capture_output=True, text=True, timeout=2)
                if descendants.returncode not in (0, 1):
                    raise RuntimeError('WATCHDOG_PGREP_INSPECTION_FAILED')
                for child in descendants.stdout.split():
                    child_identity = identity(int(child))
                    if child_identity:
                        retained.setdefault(int(child), child_identity)
            channel = Path(state['channel']) if state.get('channel') else None
            total = owned_size(output) + (owned_size(channel) if channel else 0)
            trace = owned_size(output / 'capture.trace')
            reason = ('WALL_CAP' if time.monotonic() >= deadline else
                      'AGGREGATE_CAP_INCLUDING_XCRESULT' if total > CAP - MIB else
                      'TRACE_CAP' if trace > TRACE_CAP else None)
            if identity(parent_pid) != parent_identity:
                reason = reason or 'CONTROLLER_EXIT_WITHOUT_CLEANUP'
            if reason:
                break
        if finished.is_set():
            return
    except BaseException as error:
        reason = 'WATCHDOG_INSPECTION_FAILED:' + type(error).__name__ + ':' + str(error)[:1024]
    stop = {'reason': reason, 'aggregateBytes': total, 'traceBytes': trace,
            'cleanupUnknown': [], 'survivorState': 'unknown until verified'}
    try:
        # No links were created by us at this reserved filename.
        if (output / 'watchdog-stop.json').is_symlink():
            raise RuntimeError('STOP_RECEIPT_SYMLINK')
        (output / 'watchdog-stop.json').write_text(json.dumps(stop))
    except BaseException as error:
        print('WATCHDOG_STOP_RECEIPT_FAILED:' + type(error).__name__, file=sys.stderr)
    try:
        if identity(parent_pid) == parent_identity:
            os.kill(parent_pid, signal.SIGTERM)
    except BaseException as error:
        stop['cleanupUnknown'].append('parent:' + type(error).__name__)
    if finished.wait(3):
        return
    for pid, value in retained.items():
        try:
            if identity(pid) == value:
                os.kill(pid, signal.SIGKILL)
        except BaseException as error:
            stop['cleanupUnknown'].append(str(pid) + ':' + type(error).__name__)
    try:
        if identity(parent_pid) == parent_identity:
            os.kill(parent_pid, signal.SIGKILL)
    except BaseException as error:
        stop['cleanupUnknown'].append('parent-fallback:' + type(error).__name__)
    try:
        if not (output / 'watchdog-stop.json').is_symlink():
            (output / 'watchdog-stop.json').write_text(json.dumps(stop))
    except BaseException:
        print('WATCHDOG_FINAL_RECEIPT_UNAVAILABLE', file=sys.stderr)


def main():
    # Only the existing CI-owned parent is authority to create an output root.
    # Before that succeeds, no subprocess/app/owned resources have been started.
    try:
        raw_parent = Path(os.environ['PROFILE_OUTPUT_PARENT'])
        runner_temp = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
        parent = raw_parent.resolve(strict=True)
        if raw_parent.is_symlink() or parent != runner_temp / 'Assistant-profile':
            raise RuntimeError('OUTPUT_PARENT_NOT_EXPECTED_CI_OWNED_DIRECTORY')
        output = parent / ('native-profile-' + str(uuid.uuid4()))
        output.mkdir(mode=0o700)
    except BaseException as error:
        print('PREFLIGHT_NO_OWNED_RESOURCES:' + type(error).__name__ + ':' + str(error)[:1024], file=sys.stderr)
        return 1
    udid = os.environ.get('DESTINATION_UDID')
    original = None
    start = time.monotonic()
    receipt = {'version': 1, 'mode': 'Debug-testability-Time-Profiler-capability',
               'status': 'STOP', 'output': str(output), 'udid': udid,
               'caps': {'wallSeconds': WALL, 'traceBytes': TRACE_CAP, 'aggregateBytes': CAP,
                        'captureSeconds': 8, 'workloadSeconds': 5, 'attempts': 1},
               'presentedFrames': 'UNAVAILABLE', 'hitches': 'UNAVAILABLE',
               'cpuAttribution': 'UNAVAILABLE until actual exported samples reviewed',
               'commands': [], 'ownedProcesses': [], 'cleanup': [],
               'input': {'xctestrun': os.environ.get('PROFILE_XCTESTRUN'),
                         'note': 'Preexisting normal-CI build input, not profile output; no build performed by this script.'}}
    owned = {}
    children = []
    channel = None
    app_executable = None
    app_launch_started = False
    registry = output / 'owned-processes.json'
    finished = multiprocessing.Event()
    sentinel = None
    # No global process-name matching; identities are exact PID + birth + comm.
    def identity(pid):
        result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart=', '-o', 'comm='],
                                capture_output=True, text=True, timeout=2)
        if result.returncode not in (0, 1):
            raise RuntimeError('PS_INSPECTION_FAILED')
        value = result.stdout.strip()
        return value if result.returncode == 0 and value else None

    def retain(pid):
        value = identity(pid)
        if value:
            owned.setdefault(pid, value)
            snapshot = {'processes': owned, 'channel': str(channel) if channel else None}
            temporary = registry.with_suffix('.tmp')
            temporary.write_text(json.dumps(snapshot))
            temporary.replace(registry)

    def exact_app_pids():
        if not app_executable:
            return []
        result = subprocess.run(['pgrep', '-f', '^' + re.escape(app_executable) + r'( |$)'],
                                capture_output=True, text=True, timeout=2)
        if result.returncode not in (0, 1):
            raise RuntimeError('APP_PGREP_INSPECTION_FAILED')
        return [int(p) for p in result.stdout.split()]

    def discover():
        if app_launch_started:
            for pid in exact_app_pids():
                retain(pid)
        for pid in list(owned):
            if identity(pid) != owned[pid]:
                continue
            result = subprocess.run(['pgrep', '-P', str(pid)], capture_output=True, text=True, timeout=2)
            if result.returncode not in (0, 1):
                raise RuntimeError('DESCENDANT_PGREP_INSPECTION_FAILED')
            for value in result.stdout.split():
                retain(int(value))

    def sizes(path):
        return owned_size(path)

    def guard():
        if (output / 'watchdog-stop.json').exists():
            raise RuntimeError('WATCHDOG_REPORTED_STOP')
        if sentinel is None or not sentinel.is_alive():
            raise RuntimeError('WATCHDOG_NOT_ALIVE')
        discover()
        if time.monotonic() - start > WALL:
            raise RuntimeError('WALL_CAP')
        total = sizes(output) + (sizes(channel) if channel else 0)
        receipt['peakAggregateBytes'] = max(receipt.get('peakAggregateBytes', 0), total)
        if total > CAP - MIB:  # Reserve one MiB for STOP/cleanup receipts.
            raise RuntimeError('AGGREGATE_CAP_INCLUDING_XCRESULT')
        if sizes(output / 'capture.trace') > TRACE_CAP:
            raise RuntimeError('TRACE_CAP')
        for proc in children:
            if proc.poll() is not None and proc.returncode != 0:
                raise RuntimeError('OWNED_COMMAND_FAILED:' + str(proc.returncode))

    def wait_for(predicate, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            guard()
            value = predicate()
            if value:
                return value
            time.sleep(0.1)
        raise RuntimeError('PHASE_DEADLINE')

    def command(args, seconds=10):
        receipt['commands'].append(args)
        # Metadata only, output bounded by the same aggregate directory.
        result = subprocess.run(args, capture_output=True, timeout=seconds)
        guard()
        if result.returncode:
            raise RuntimeError('METADATA_COMMAND_FAILED:' + str(result.returncode))
        if len(result.stdout) > 8 * MIB or len(result.stderr) > MIB:
            raise RuntimeError('METADATA_OUTPUT_CAP')
        return result.stdout

    def launch(args, name, env=None):
        receipt['commands'].append(args)
        stream = open(output / (name + '.log'), 'wb')
        proc = subprocess.Popen(args, stdout=stream, stderr=subprocess.STDOUT,
                                env=env, start_new_session=True)
        stream.close()
        children.append(proc)
        retain(proc.pid)
        return proc

    def checked_signal(pid, sig):
        if identity(pid) == owned.get(pid):
            os.kill(pid, sig)
            return True
        return False

    def interrupted(_signal, _frame):
        raise RuntimeError('EXTERNAL_WATCHDOG_OR_TERMINATION')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        if os.environ.get('ASSISTANT_PROFILE_CAPABILITY') != '1':
            raise RuntimeError('EXPLICIT_OPT_IN_REQUIRED')
        if not udid or str(uuid.UUID(udid)).lower() != udid.lower():
            raise RuntimeError('EXACT_DESTINATION_UUID_REQUIRED')
        original = Path(os.environ['PROFILE_XCTESTRUN']).resolve(strict=True)
        receipt['input']['sha256'] = hashlib.sha256(original.read_bytes()).hexdigest()
        sentinel = multiprocessing.Process(target=watchdog, args=(output, registry, finished,
            os.getpid(), identity(os.getpid()), start + WALL))
        sentinel.start()
        token = str(uuid.uuid4())
        # The selected device must already be booted by normal CI; never boot/setup here.
        devices = json.loads(command(['xcrun', 'simctl', 'list', 'devices', 'booted', '--json']))
        if not any(d['udid'] == udid and d['state'] == 'Booted'
                   for values in devices['devices'].values() for d in values):
            raise RuntimeError('SELECTED_SIMULATOR_NOT_ALREADY_BOOTED')
        bundle_path = Path(command(['xcrun', 'simctl', 'get_app_container', udid, BUNDLE, 'app']).decode().strip()).resolve(strict=True)
        info = plistlib.loads((bundle_path / 'Info.plist').read_bytes())
        executable = str(bundle_path / info['CFBundleExecutable'])
        app_executable = executable
        if exact_app_pids():
            raise RuntimeError('PREEXISTING_TARGET_APP_PROCESS')
        if info.get('CFBundleIdentifier') != BUNDLE:
            raise RuntimeError('BUNDLE_IDENTITY_MISMATCH')
        container = Path(command(['xcrun', 'simctl', 'get_app_container', udid, BUNDLE, 'data']).decode().strip()).resolve(strict=True)
        preferences = container / 'Library' / 'Preferences' / (BUNDLE + '.plist')
        if preferences.exists() and plistlib.loads(preferences.read_bytes()).get('assistant.connection-configured', False):
            raise RuntimeError('SAVED_CONNECTION_NOT_ALLOWED')
        receipt['input']['savedConnectionConfigured'] = False
        channel = container / 'Documents' / ('profiling-capability-' + token)
        if channel.exists():
            raise RuntimeError('CHANNEL_ALREADY_EXISTS')
        data = plistlib.loads(original.read_bytes())
        configs = data.get('TestConfigurations', [])
        targets = [t for config in configs for t in config.get('TestTargets', [])]
        if not targets:  # Legacy xctestrun schema.
            targets = [v for k, v in data.items() if not k.startswith('__') and isinstance(v, dict)]
        targets = [t for t in targets if t.get('BlueprintName') == 'AssistantTests']
        if len(targets) != 1:
            raise RuntimeError('EXACT_TEST_TARGET_UNAVAILABLE')
        target = targets[0]
        if 'Debug-iphonesimulator' not in target.get('TestHostPath', ''):
            raise RuntimeError('DEBUG_TEST_HOST_REQUIRED')
        target.setdefault('EnvironmentVariables', {})['ASSISTANT_PROFILE_TOKEN'] = token
        target.setdefault('CommandLineArguments', []).extend(['-assistant.connection-configured', 'NO'])
        receipt['input']['launchDefaultOverride'] = 'assistant.connection-configured=NO (ephemeral argument domain; no saved preference edit)'
        target['OnlyTestIdentifiers'] = [METHOD.split('/', 1)[1]]
        patched = output / 'capability.xctestrun'
        patched.write_bytes(plistlib.dumps(data))
        # Resolve relative __TESTROOT__ against the original build products,
        # rather than silently changing meaning by moving the plist.
        root = str(original.parent)
        def resolve(value):
            if isinstance(value, str):
                return value.replace('__TESTROOT__', root)
            if isinstance(value, list):
                return [resolve(v) for v in value]
            if isinstance(value, dict):
                return {k: resolve(v) for k, v in value.items()}
            return value
        patched.write_bytes(plistlib.dumps(resolve(data)))
        receipt['input']['buildProductsBytes'] = sizes(original.parent)
        receipt['input']['installedExecutable'] = executable
        # Register BEFORE starting capture. No --no-prompt/setup bypass.
        notify = ctypes.CDLL('/usr/lib/system/libsystem_notify.dylib')
        notify.notify_register_check.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_int)]
        notify.notify_check.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        notify.notify_cancel.argtypes = [ctypes.c_int]
        notification = ('com.assistant.profile.' + token).encode()
        notify_token = ctypes.c_int()
        if notify.notify_register_check(notification, ctypes.byref(notify_token)) != 0:
            raise RuntimeError('NOTIFY_REGISTRATION_FAILED')
        # Clear initial registration state before xctrace can emit start.
        initial = ctypes.c_int()
        if notify.notify_check(notify_token, ctypes.byref(initial)) != 0:
            raise RuntimeError('NOTIFY_CHECK_FAILED')
        app_launch_started = True
        test = launch(['xcodebuild', 'test-without-building', '-xctestrun', str(patched),
                       '-destination', 'id=' + udid, '-only-testing:' + METHOD,
                       '-parallel-testing-enabled', 'NO', '-maximum-test-execution-time-allowance', '100',
                       '-resultBundlePath', str(output / 'capability.xcresult')], 'test')
        ready_file = channel / 'ready.json'
        wait_for(lambda: ready_file.exists(), 80)
        ready = json.loads(ready_file.read_bytes())
        if ready.get('token') != token or ready.get('configuration') != 'Debug-testability' or ready.get('messageCount') != 100:
            raise RuntimeError('READINESS_IDENTITY_FAILED')
        app_pid = ready['pid']
        controller_pids = {os.getpid(), sentinel.pid, *(proc.pid for proc in children)}
        if type(app_pid) is not int or app_pid <= 0 or app_pid in controller_pids:
            raise RuntimeError('APP_PID_INVALID')
        app_identity = identity(app_pid)
        if not app_identity or not app_identity.endswith(' ' + executable):
            raise RuntimeError('APP_EXECUTABLE_IDENTITY_FAILED')
        if app_pid in owned and owned[app_pid] != app_identity:
            raise RuntimeError('APP_RETAINED_IDENTITY_CHANGED')
        # Fixture token is unguessable and appeared only in this targeted test;
        # retain this exact app identity even if it is reparented to launchd.
        retain(app_pid)
        receipt['ready'] = ready
        (output / 'ready.json').write_bytes(ready_file.read_bytes())
        trace = launch(['xcrun', 'xctrace', 'record', '--template', 'Time Profiler',
                        '--device', udid, '--attach', str(app_pid), '--time-limit', '8s',
                        '--notify-tracing-started', notification.decode(),
                        '--output', str(output / 'capture.trace')], 'capture')
        def tracing_started():
            state = ctypes.c_int()
            if notify.notify_check(notify_token, ctypes.byref(state)) != 0:
                raise RuntimeError('NOTIFY_CHECK_FAILED')
            return state.value == 1
        wait_for(tracing_started, 20)
        (channel / 'start').write_text(token)
        done_file = channel / 'done.json'
        wait_for(lambda: done_file.exists(), 10)
        receipt['workload'] = json.loads(done_file.read_bytes())
        (output / 'done.json').write_bytes(done_file.read_bytes())
        wait_for(lambda: trace.poll() is not None, 15)
        (channel / 'release').write_text(token)
        wait_for(lambda: test.poll() is not None, 30)
        if receipt['workload']['timedOut'] or receipt['workload']['elapsed'] < 5:
            raise RuntimeError('WORKLOAD_INCOMPLETE')
        # One actual export, bounded and preserved; discover actual table schemas
        # instead of fabricating a fixed metrics schema before any trace exists.
        export = launch(['xcrun', 'xctrace', 'export', '--input', str(output / 'capture.trace'),
                         '--toc', '--output', str(output / 'toc.xml')], 'export')
        wait_for(lambda: export.poll() is not None, 30)
        toc = ET.parse(output / 'toc.xml')
        receipt['actualExportSchemas'] = sorted({node.attrib['schema'] for node in toc.iter() if 'schema' in node.attrib})
        receipt['status'] = 'CAPABILITY_EXPORT_COMPLETE_METRICS_NOT_YET_INTERPRETED'
        notify.notify_cancel(notify_token)
    except BaseException as error:
        receipt['failure'] = type(error).__name__ + ':' + str(error)
    finally:
        # Inspection errors cannot skip the receipt or authorize an unchecked kill.
        cleanup_errors = []
        def attempt(label, operation):
            try:
                return operation()
            except BaseException as error:
                cleanup_errors.append(label + ':' + type(error).__name__ + ':' + str(error)[:512])
                return None
        if sentinel and ((output / 'watchdog-stop.json').exists() or not sentinel.is_alive()):
            cleanup_errors.append('watchdog-unhealthy-at-cleanup')
        # Do not interrupt cleanup again; independent watchdog retains verified fallback.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if channel and channel.exists():
            attempt('release', lambda: (channel / 'release').write_text('cleanup'))
        attempt('final-descendant-inspection', discover)
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for pid in reversed(list(owned)):
                sent = attempt('signal-' + str(pid), lambda pid=pid, sig=sig: checked_signal(pid, sig))
                if sent:
                    receipt['cleanup'].append({'pid': pid, 'signal': int(sig)})
            time.sleep(0.2)
        receipt['ownedProcesses'] = [{'pid': pid, 'identity': value} for pid, value in owned.items()]
        survivors = []
        for pid, value in owned.items():
            observed = attempt('survivor-inspection-' + str(pid), lambda pid=pid: identity(pid))
            if observed == value:
                survivors.append(pid)
        receipt['survivingOwnedPIDs'] = survivors
        receipt['elapsedSeconds'] = time.monotonic() - start
        receipt['aggregateBytesBeforeReceipt'] = attempt('output-size', lambda: sizes(output))
        receipt['traceBytes'] = attempt('trace-size', lambda: sizes(output / 'capture.trace'))
        receipt['ownedChannelBytes'] = attempt('channel-size', lambda: sizes(channel)) if channel else 0
        receipt['cleanupInspectionErrors'] = cleanup_errors
        receipt['survivorState'] = 'unknown' if cleanup_errors else 'verified-present' if survivors else 'verified-none'
        if survivors or cleanup_errors:
            receipt['status'] = 'STOP'
            receipt['failure'] = 'OWNED_CLEANUP_INCOMPLETE_OR_UNKNOWN'
        try:
            receipt_path = output / 'receipt.json'
            if receipt_path.is_symlink():
                raise RuntimeError('RECEIPT_SYMLINK')
            receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
            print(str(receipt_path))
        except BaseException as error:
            receipt['status'] = 'STOP'
            print('OWNED_RECEIPT_WRITE_FAILED:' + type(error).__name__, file=sys.stderr)
        finally:
            finished.set()
            if sentinel and sentinel.pid:
                sentinel.join(timeout=2)
                if sentinel.is_alive():
                    # Exact multiprocessing child only, not arbitrary/global PID.
                    sentinel.terminate()
                    sentinel.join(timeout=2)
    return_value = 0 if receipt['status'].startswith('CAPABILITY_EXPORT_COMPLETE') else 1
    return return_value



if __name__ == '__main__':
    multiprocessing.set_start_method('fork')
    sys.exit(main())
