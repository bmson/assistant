#!/usr/bin/env python3
"""Audit exported xcresult metrics. Listing inventory never grants acceptance.

After inspecting actual output, pass exact identifiers for the app hitch metric
and a positive-duration scrolling/deceleration metric. Do not guess identifiers.
"""
import argparse
import json
import math
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('metrics_json', type=Path)
parser.add_argument('--hitch-id')
parser.add_argument('--scroll-duration-id')
args = parser.parse_args()
source = json.loads(args.metrics_json.read_text())


def test_entries(value):
    if isinstance(value, dict):
        if 'testIdentifier' in value and 'testRuns' in value:
            yield value
        else:
            for child in value.values():
                yield from test_entries(child)
    elif isinstance(value, list):
        for child in value:
            yield from test_entries(child)


entries = [entry for entry in test_entries(source)
           if 'ConversationTouchScrollTests/testOneDragAndDeceleration' in entry['testIdentifier']]
if len(entries) != 1:
    raise SystemExit('INVALID: expected exactly one touch smoke test entry')
runs = entries[0]['testRuns']
if not runs:
    raise SystemExit('INVALID: no metric-bearing test runs')
for run in runs:
    print(json.dumps({'device': run.get('device'), 'configuration': run.get('testPlanConfiguration'),
                      'metrics': run.get('metrics', [])}, indent=2))
if not args.hitch_id or not args.scroll_duration_id:
    raise SystemExit('NOT ACCEPTED: inventory only; identify exact hitch and scrolling-duration IDs, then rerun')
if args.hitch_id == args.scroll_duration_id:
    raise SystemExit('INVALID: hitch and scrolling interval must be distinct metrics')
for run in runs:
    for identifier, positive in [(args.hitch_id, False), (args.scroll_duration_id, True)]:
        matching = [m for m in run.get('metrics', []) if m.get('identifier') == identifier]
        if len(matching) != 1:
            raise SystemExit(f'INVALID: absent or ambiguous metric {identifier}')
        metric = matching[0]
        values = metric.get('measurements')
        if not values or not all(isinstance(v, (int, float)) and not isinstance(v, bool)
                                 and math.isfinite(v) and v >= 0 for v in values):
            raise SystemExit(f'INVALID: absent/invalid samples for {identifier}; never substitute zero')
        if positive and not all(v > 0 for v in values):
            raise SystemExit(f'INVALID: incomplete/zero scrolling intervals for {identifier}')
print('Metric sample coverage confirmed. Also require passed test, complete gesture receipt, and QA review. No physical 60 fps claim.')
