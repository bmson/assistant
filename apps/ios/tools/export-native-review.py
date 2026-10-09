#!/usr/bin/env python3
"""Export original XCTest captures and provenance from their actual xcresult.

Usage: python3 apps/ios/tools/export-native-review.py RESULT.xcresult OUTPUT_DIR
Export-time source hashes are separate; an older xcresult never acquires them
as tested-source identity. No image is altered.
"""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import uuid


def tree_digest(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('Result bundle contains a symbolic link')
        if path.is_file():
            digest.update(str(path.relative_to(root)).encode())
            digest.update(b'\0')
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def tested_device(summary, attachment):
    entries = summary.get('devicesAndConfigurations', [])
    if isinstance(entries, dict):
        entries = [entries]
    devices = [entry.get('device', {}) for entry in entries if isinstance(entry, dict)]
    device_id = attachment.get('deviceId')
    name = attachment.get('deviceName')
    matches = [device for device in devices if
               (device_id and device.get('deviceId') == device_id) or
               (not device_id and name and device.get('deviceName') == name)]
    distinct = {json.dumps(device, sort_keys=True): device for device in matches}
    return next(iter(distinct.values())) if len(distinct) == 1 else None


def capture_provenance(summary, attachment, test_id, result_sha):
    device = tested_device(summary, attachment)
    return {'mode': 'native-xctest-fixture', 'resultBundleSha256': result_sha,
            'testIdentifier': test_id, 'runStartTime': summary.get('startTime'),
            'runFinishTime': summary.get('finishTime'),
            'testedDevice': device, 'runtimeStatus': 'known' if device else 'unknown',
            'testedSource': {'status': 'unknown', 'reason': 'No source receipt bound into this tested build'},
            'testedBuild': {'status': 'unknown', 'reason': 'xcresult identity is retained; executable digest was not captured'}}


def build_manifest(result, result_sha, summary, captures, export_hashes):
    return {'id': str(uuid.uuid4()), 'exportedAt': datetime.now(timezone.utc).isoformat(),
            'resultBundle': str(result), 'resultBundleSha256': result_sha,
            'testedRun': {'source': 'xcresulttool test-results summary',
                          'startTime': summary.get('startTime'), 'finishTime': summary.get('finishTime'),
                          'environmentDescription': summary.get('environmentDescription'),
                          'devicesAndConfigurations': summary.get('devicesAndConfigurations'),
                          'result': summary.get('result')},
            'exportTimeSource': {'status': 'export-time-only', 'sha256': export_hashes},
            'captures': captures, 'pageCount': len({capture['page'] for capture in captures}),
            'captureCount': len(captures),
            'currentSourceCoverage': False,
            'provenanceLimit': 'Tested source/build is unknown without a receipt captured by the actual tested executable.'}


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    result = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    if not result.is_dir():
        raise SystemExit('Result bundle does not exist')
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'manifest.json').exists():
        raise SystemExit('Refusing to replace an existing export manifest')
    result_sha = tree_digest(result)
    summary_read = subprocess.run(['xcrun', 'xcresulttool', 'get', 'test-results', 'summary',
                                   '--path', str(result)], text=True, capture_output=True)
    summary = json.loads(summary_read.stdout) if summary_read.returncode == 0 else {}
    with tempfile.TemporaryDirectory(prefix='assistant-native-captures-') as staging:
        subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(result),
                        '--output-path', staging], check=True, stdout=subprocess.DEVNULL)
        details = json.loads((Path(staging) / 'manifest.json').read_text())
        captures = []
        for test in details:
            if 'NativeVisualReviewTests' not in test['testIdentifier']:
                continue
            for item in test['attachments']:
                source = Path(staging) / item['exportedFileName']
                if source.resolve().parent != Path(staging).resolve():
                    raise ValueError('Attachment escaped the export directory')
                label = item['suggestedHumanReadableName']
                if source.suffix.lower() != '.png' or '-phone-' not in label:
                    continue
                stem = re.sub(r'_\d+_[0-9A-Fa-f-]{36}\.png$', '', label)
                stem = re.sub(r'\.png$', '', stem)
                filename = re.sub(r'[^a-zA-Z0-9._-]', '-', stem) + '.png'
                destination = output / filename
                if destination.exists():
                    raise SystemExit(f'Refusing to replace an existing capture: {destination}')
                shutil.copyfile(source, destination)
                match = re.match(r'(.+)-phone-(light|dark)-(\d+)(-accessible)?-(top|scroll-\d+)', stem)
                captures.append({'file': filename, 'page': match[1] if match else stem,
                                 'appearance': match[2] if match else None,
                                 'widthPoints': int(match[3]) if match else None,
                                 'largeText': bool(match and match[4]), 'position': match[5] if match else None,
                                 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                                 'device': item.get('deviceName'), 'deviceId': item.get('deviceId'),
                                 'associatedWithFailure': item.get('isAssociatedWithFailure', False),
                                 'provenance': capture_provenance(summary, item, test['testIdentifier'], result_sha)})
        if tree_digest(result) != result_sha:
            raise SystemExit('Result bundle changed during export; exported evidence is not accepted')
        (output / 'export-manifest.json').write_text(json.dumps(details, indent=2) + '\n')
        (output / 'tested-run-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        source_root = Path(__file__).resolve().parents[1] / 'Assistant'
        hashes = {str(path.relative_to(source_root)): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in sorted(source_root.rglob('*.swift'))}
        manifest = build_manifest(result, result_sha, summary, captures, hashes)
        if summary_read.returncode:
            manifest['summaryReadError'] = summary_read.stderr[-1000:]
        (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        print(f"Exported {manifest['captureCount']} original captures across {manifest['pageCount']} pages to {output}")


if __name__ == '__main__':
    main()
