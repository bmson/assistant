"""Offline summary of explicit retained receipts, never an operational approval."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import sys

REQUIRED_JOBS = ('checks', 'verify', 'firestore', 'base-images', 'build-smoke')
CONCLUSIONS = {'success', 'failure', 'cancelled', 'timed_out', 'action_required',
               'skipped', 'neutral', 'stale', 'startup_failure'}


def identifier(value):
    return value if type(value) is int and value > 0 else None


def sha(value):
    return value if isinstance(value, str) and re.fullmatch(r'[0-9a-f]{40}', value) else None


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed if parsed.utcoffset() is not None else None
    except (ValueError, OverflowError):
        return None


def oid(value):
    return sha(value.get('oid', value.get('sha'))) if isinstance(value, dict) else sha(value)


def ci_status(snapshot, main, native=False):
    if snapshot is None:
        return {'status': 'unknown', 'source': None}
    source = sha(snapshot.get('headSha'))
    conclusion = snapshot.get('conclusion')
    result = {'source': source, 'run': identifier(snapshot.get('databaseId')),
              'reportedConclusion': conclusion if isinstance(conclusion, str) and conclusion in CONCLUSIONS else None}
    if source != main:
        return {**result, 'status': 'stale_or_unbound_snapshot'}
    if snapshot.get('event') != 'push' or snapshot.get('headBranch') != 'main':
        return {**result, 'status': 'not_qualified_as_main_run'}
    jobs = snapshot.get('jobs')
    if not isinstance(jobs, list):
        return {**result, 'status': 'unknown'}
    names = ('Build and test the iOS app',) if native else REQUIRED_JOBS
    selected = [j for j in jobs if isinstance(j, dict) and j.get('name') in names]
    missing = sorted(set(names) - {j.get('name') for j in selected})
    conclusions = [str(j.get('conclusion') or '').lower() for j in selected]
    if 'failure' in conclusions:
        state = 'failed'
    elif any(c in ('cancelled', 'timed_out', 'action_required') for c in conclusions):
        state = 'not_passed'
    elif native and conclusions == ['skipped']:
        state = 'skipped_not_execution'
    elif missing:
        state = 'unknown_missing_jobs'
    elif snapshot.get('status') != 'completed' or any(j.get('status') != 'completed' for j in selected):
        state = 'pending'
    elif all(c == 'success' for c in conclusions) and snapshot.get('conclusion') == 'success':
        state = 'passed'
    else:
        state = 'not_passed'
    return {**result, 'status': state, 'missingJobs': missing,
            'scope': 'workflow snapshot only; no deployment/install or test-count inference'}


def native_execution(receipt, main):
    if receipt is None:
        return {'status': 'unknown', 'source': None}
    source = sha(receipt.get('source'))
    lines = receipt.get('actualEvidence', [])
    lines = [line for line in lines if isinstance(line, str)] if isinstance(lines, list) else []
    summaries = [re.search(r'Executed (\d+) tests, with (\d+) tests skipped and (\d+) failures', line)
                 for line in lines]
    counts = {tuple(map(int, match.groups())) for match in summaries if match}
    valid = (source is not None and receipt.get('conclusion') == 'success' and len(counts) == 1
             and any("Test Suite 'All tests' passed" in line for line in lines)
             and bool(re.fullmatch(r'[0-9a-f]{64}', str(receipt.get('logSha256', '')))))
    result = {'source': source, 'run': identifier(receipt.get('run')), 'status': 'unqualified_receipt'}
    if valid:
        total, skipped, failures = next(iter(counts))
        if total > skipped >= 0 and failures == 0:
            result.update(status='recorded_execution' if source == main else 'prior_source_execution',
                          testCount=total, skipped=skipped, failures=failures)
    return result


def merge_status(receipts, main):
    records, parents = [], {}
    for receipt in receipts:
        commit = oid(receipt.get('mergeCommit')) or oid(receipt.get('merge'))
        pr = receipt.get('pr')
        if type(pr) is not int or pr <= 0 or not commit:
            continue
        if receipt.get('merged') is not True and not timestamp(receipt.get('mergedAt')):
            continue
        raw_parents = receipt.get('parents')
        if isinstance(raw_parents, list) and raw_parents and all(sha(p) for p in raw_parents):
            parents[commit] = raw_parents
        records.append({'pr': pr, 'head': sha(receipt.get('head')), 'mergeCommit': commit,
                        'mergedAt': timestamp(receipt.get('mergedAt')).isoformat() if timestamp(receipt.get('mergedAt')) else None,
                        'status': 'recorded_merged'})
    reachable, pending = set(), [main]
    while pending:
        current = pending.pop()
        if current not in reachable:
            reachable.add(current)
            pending.extend(parents.get(current, []))
    for record in records:
        record['includedInSelectedMain'] = 'receipt_graph' if record['mergeCommit'] in reachable else 'unknown'
    return sorted(records, key=lambda r: (r['pr'], r['mergeCommit']))


def authority_status(receipt, main, as_of):
    if receipt is None:
        return {'expiry': 'unknown', 'sourceBinding': 'unknown', 'approval': 'not_evaluated'}
    source = sha(receipt.get('finalSourceSha')) or sha(receipt.get('source'))
    raw_expiry = receipt.get('expiryUtc') or receipt.get('approvalNotAfterUtc')
    condition = receipt.get('condition')
    if not raw_expiry and isinstance(condition, dict):
        match = re.search(r'request[.]time\s*<\s*timestamp\("([^\"]+)"\)', str(condition.get('expression', '')))
        raw_expiry = match.group(1) if match else None
    expiry = timestamp(raw_expiry)
    return {'expiry': ('expired' if expiry <= as_of else 'window_open') if expiry else 'unknown_or_unbound',
            'expiresAt': expiry.isoformat() if expiry else None,
            'source': source, 'sourceBinding': 'same' if source == main else 'stale' if source else 'unbound',
            'approval': 'not_evaluated', 'grantApplied': 'unknown',
            'scope': 'expiry is not IAM/application or execution authority proof'}


def delivery_status(handoff):
    handoff = handoff or {}
    source_data, release = handoff.get('source'), handoff.get('release')
    source_data = source_data if isinstance(source_data, dict) else {}
    release = release if isinstance(release, dict) else {}
    claim_source = sha(source_data.get('main')) or sha(handoff.get('main'))
    result = {}
    for key in ('deployed', 'installed'):
        claim = release.get(key, handoff.get(key))
        result[key] = {'current': 'unknown', 'lastReported': claim if type(claim) is bool else None,
                       'claimSource': claim_source, 'scope': 'retained handoff claim, not current observation'}
    result['installed']['lastQualifiedSource'] = sha(handoff.get('lastQualifiedInstalledSource'))
    observed = release.get('lastServingObservation')
    if isinstance(observed, dict):
        result['deployed']['lastObservation'] = {
            'observedAt': observed.get('observedAt') if timestamp(observed.get('observedAt')) else None,
            'sourceAssociation': sha(observed.get('imageSourceAssociation'))}
    return result


def summarize(main, as_of, *, main_ci=None, native_ci=None, execution=None,
              merges=(), handoff=None, authority=None):
    if not sha(main) or not isinstance(as_of, datetime.datetime) or as_of.utcoffset() is None:
        raise ValueError('main and timezone-aware as-of are required')
    return {'selectedMain': main, 'asOf': as_of.isoformat(),
            'basis': 'provided local receipts/snapshots only; no live freshness or release approval',
            'merged': merge_status(merges, main), 'mainCi': ci_status(main_ci, main),
            'nativeCi': ci_status(native_ci, main, native=True),
            'nativeExecution': native_execution(execution, main),
            **delivery_status(handoff), 'authority': authority_status(authority, main, as_of)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--main', required=True)
    parser.add_argument('--as-of', required=True)
    for key in ('main-ci', 'native-ci', 'native-execution', 'handoff', 'authority'):
        parser.add_argument('--' + key)
    parser.add_argument('--merge-receipt', action='append', default=[])
    args = parser.parse_args()
    evidence, total = [], 0

    def read(path):
        nonlocal total
        if not path:
            return None
        with Path(path).open('rb') as stream:
            raw = stream.read(1024 * 1024 + 1)
        total += len(raw)
        if len(raw) > 1024 * 1024 or total > 8 * 1024 * 1024:
            raise ValueError('input budget')
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError('object required')
        evidence.append({'input': len(evidence) + 1, 'sha256': hashlib.sha256(raw).hexdigest()})
        return value

    if len(args.merge_receipt) > 128:
        raise ValueError('receipt budget')
    result = summarize(args.main, timestamp(args.as_of), main_ci=read(args.main_ci),
                       native_ci=read(args.native_ci), execution=read(args.native_execution),
                       merges=[read(p) for p in args.merge_receipt], handoff=read(args.handoff),
                       authority=read(args.authority))
    result['inputs'] = evidence
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, TypeError, OSError, KeyError):
        print('Release status unavailable: invalid or unreadable retained metadata.', file=sys.stderr)
        sys.exit(1)
