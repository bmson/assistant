import contextlib
import datetime
import io
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
import release_status as m

MAIN, OTHER = 'a' * 40, 'b' * 40
NOW = datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc)


def ci(source=MAIN):
    return {'headSha': source, 'event': 'push', 'headBranch': 'main',
            'databaseId': 123, 'status': 'completed', 'conclusion': 'success',
            'jobs': [{'name': name, 'status': 'completed', 'conclusion': 'success'}
                     for name in m.REQUIRED_JOBS]}


class ReleaseStatusTests(unittest.TestCase):
    def test_green_pr_does_not_qualify_main_or_delivery(self):
        snapshot = {**ci(), 'event': 'pull_request', 'headBranch': 'feature'}
        result = m.summarize(MAIN, NOW, main_ci=snapshot)
        self.assertEqual(result['mainCi']['status'], 'not_qualified_as_main_run')
        self.assertEqual(result['deployed']['current'], 'unknown')
        self.assertEqual(result['installed']['current'], 'unknown')

    def test_main_moves_old_green_snapshot_and_packet_are_stale(self):
        result = m.summarize(MAIN, NOW, main_ci=ci(OTHER), authority={
            'source': OTHER, 'approvalNotAfterUtc': '2030-01-01T00:10:00Z'})
        self.assertEqual(result['mainCi']['status'], 'stale_or_unbound_snapshot')
        self.assertEqual(result['authority']['sourceBinding'], 'stale')
        self.assertEqual(result['authority']['expiry'], 'window_open')
        self.assertEqual(result['authority']['approval'], 'not_evaluated')

    def test_pending_and_missing_required_main_jobs_are_not_green(self):
        snapshot = ci()
        snapshot['status'] = 'in_progress'
        snapshot['jobs'][-1].update(status='in_progress', conclusion='')
        self.assertEqual(m.ci_status(snapshot, MAIN)['status'], 'pending')
        snapshot = ci()
        snapshot['jobs'].pop()
        result = m.ci_status(snapshot, MAIN)
        self.assertEqual(result['status'], 'unknown_missing_jobs')
        self.assertEqual(result['missingJobs'], ['build-smoke'])

    def test_failed_or_cancelled_main_is_retained_without_waiver(self):
        for value, expected in [('failure', 'failed'), ('cancelled', 'not_passed'), ('timed_out', 'not_passed')]:
            snapshot = ci()
            snapshot['jobs'][0]['conclusion'] = value
            snapshot['conclusion'] = value
            self.assertEqual(m.ci_status(snapshot, MAIN)['status'], expected)

    def test_successful_main_is_ci_only(self):
        result = m.summarize(MAIN, NOW, main_ci=ci())
        self.assertEqual(result['mainCi']['status'], 'passed')
        self.assertEqual(result['deployed']['current'], 'unknown')
        self.assertEqual(result['authority']['expiry'], 'unknown')
        self.assertNotIn('releaseGo', result)

    def test_native_skip_is_not_execution_and_other_source_execution_stays_separate(self):
        snapshot = ci()
        snapshot['jobs'] = [{'name': 'Build and test the iOS app', 'status': 'completed', 'conclusion': 'skipped'}]
        proof = {'source': OTHER, 'run': 456, 'conclusion': 'success', 'logSha256': '0' * 64,
                 'actualEvidence': ["Test Suite 'All tests' passed", 'Executed 698 tests, with 3 tests skipped and 0 failures']}
        result = m.summarize(MAIN, NOW, native_ci=snapshot, execution=proof)
        self.assertEqual(result['nativeCi']['status'], 'skipped_not_execution')
        self.assertEqual(result['nativeExecution']['status'], 'prior_source_execution')
        self.assertEqual(result['nativeExecution']['source'], OTHER)
        self.assertEqual(result['nativeExecution']['testCount'], 698)

    def test_native_summary_requires_real_non_skipped_count_and_matching_receipt_scope(self):
        proof = {'source': MAIN, 'conclusion': 'success', 'logSha256': '0' * 64,
                 'actualEvidence': ["Test Suite 'All tests' passed", 'Executed 12 tests, with 0 tests skipped and 0 failures']}
        self.assertEqual(m.native_execution(proof, MAIN)['status'], 'recorded_execution')
        proof['actualEvidence'][-1] = 'Executed 12 tests, with 12 tests skipped and 0 failures'
        self.assertEqual(m.native_execution(proof, MAIN)['status'], 'unqualified_receipt')
        proof['actualEvidence'][-1] = 'TEST BUILD SUCCEEDED'
        self.assertEqual(m.native_execution(proof, MAIN)['status'], 'unqualified_receipt')

    def test_root_merge_receipts_are_immutable_records_not_stale_pending_queue(self):
        merged = {'pr': 837, 'head': OTHER, 'merged': True, 'mergeCommit': MAIN,
                  'parents': [OTHER], 'deployed': False, 'installed': False}
        result = m.summarize(MAIN, NOW, merges=[merged])
        self.assertEqual(result['merged'][0]['status'], 'recorded_merged')
        self.assertEqual(result['merged'][0]['includedInSelectedMain'], 'receipt_graph')
        self.assertEqual(result['deployed']['current'], 'unknown')
        result = m.summarize('c' * 40, NOW, merges=[merged])
        self.assertEqual(result['merged'][0]['status'], 'recorded_merged')
        self.assertEqual(result['merged'][0]['includedInSelectedMain'], 'unknown')

    def test_available_receipt_parent_chain_proves_inclusion_only_with_no_gap(self):
        rows = [{'pr': 838, 'mergeCommit': MAIN, 'parents': [OTHER], 'mergedAt': '2029-12-31T23:00:00Z'},
                {'pr': 837, 'mergeCommit': OTHER, 'parents': ['c' * 40], 'merged': True}]
        result = m.merge_status(rows, MAIN)
        self.assertTrue(all(row['includedInSelectedMain'] == 'receipt_graph' for row in result))
        self.assertEqual(m.merge_status(rows[1:], MAIN)[0]['includedInSelectedMain'], 'unknown')

    def root_851(self):
        # Exact shape and public identifiers from retained ROOT-MERGE-851.json.
        return {'pr': 851, 'head': '2be3499c3e5f98687dabf7a3f5bcf64f95a72a91',
                'priorMain': '6e6c2faaff988b7ffe2f87bdef22d80c86b4d26a',
                'merge': 'a9b07c7419754f6292a877b180a1da3c20595f1c',
                'tree': '5b8553809138a16be92aff5485fa02824bbeb7bf',
                'ci': 41778861760, 'passed': 12210, 'skipped': 1616,
                'deployed': False, 'installed': False}

    def test_current_root_merge_shape_is_recorded_with_unknown_timestamp(self):
        result = m.merge_status([self.root_851()], MAIN)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['pr'], 851)
        self.assertEqual(result[0]['receiptFormat'], 'root_merge_claim')
        self.assertEqual(result[0]['status'], 'recorded_merged')
        self.assertIsNone(result[0]['mergedAt'])
        self.assertEqual(result[0]['includedInSelectedMain'], 'unknown')

    def test_mixed_old_and_new_receipts_do_not_turn_prior_main_into_git_parents(self):
        current = self.root_851()
        old = {'pr': 837, 'merged': True, 'mergeCommit': current['priorMain'],
               'mergedAt': '2029-12-31T23:00:00Z'}
        result = m.merge_status([old, current], current['merge'])
        self.assertEqual([record['pr'] for record in result], [837, 851])
        self.assertEqual(result[0]['includedInSelectedMain'], 'unknown')
        self.assertIsNone(result[1]['mergedAt'])
        summary = m.summarize(current['merge'], NOW, merges=[old, current])
        self.assertEqual(summary['deployed']['current'], 'unknown')
        self.assertEqual(summary['installed']['current'], 'unknown')

    def test_incomplete_or_proposal_root_metadata_does_not_assert_merge(self):
        for key in ['head', 'priorMain', 'tree', 'ci', 'merge']:
            receipt = self.root_851()
            del receipt[key]
            self.assertEqual(m.merge_status([receipt], MAIN), [], key)
        for changes in [{'ci': True}, {'tree': 'short'}, {'head': None},
                        {'merged': False}, {'merged': None}, {'mergedAt': 'invalid'},
                        {'state': 'PROPOSED'}, {'status': 'awaiting_approval'},
                        {'proposal': True}, {'proposedMerge': OTHER}]:
            receipt = {**self.root_851(), **changes}
            self.assertEqual(m.merge_status([receipt], MAIN), [], changes)

    def test_expired_condition_does_not_prove_grant_application_or_renewal(self):
        authority = {'condition': {'expression': 'resource.name == "fixed" && request.time < timestamp("2029-12-31T23:59:59Z")'}}
        result = m.authority_status(authority, MAIN, NOW)
        self.assertEqual(result['expiry'], 'expired')
        self.assertEqual(result['grantApplied'], 'unknown')
        self.assertEqual(result['approval'], 'not_evaluated')
        self.assertEqual(result['sourceBinding'], 'unbound')

    def test_unbound_or_malformed_expiry_is_unknown(self):
        for authority in [{'expiryUtc': None}, {'expiryUtc': 'invalid'}, {'expiryUtc': '2030-01-01T00:10:00'}]:
            self.assertEqual(m.authority_status(authority, MAIN, NOW)['expiry'], 'unknown_or_unbound')

    def test_historical_deployed_and_installed_claims_are_not_current_state(self):
        handoff = {'source': {'main': OTHER}, 'release': {'deployed': False, 'installed': True,
                   'lastServingObservation': {'observedAt': '2029-12-31T12:00:00Z', 'imageSourceAssociation': OTHER}},
                   'lastQualifiedInstalledSource': OTHER}
        result = m.summarize(MAIN, NOW, handoff=handoff)
        self.assertEqual(result['deployed']['lastReported'], False)
        self.assertEqual(result['installed']['lastReported'], True)
        self.assertEqual(result['installed']['lastQualifiedSource'], OTHER)
        self.assertEqual(result['deployed']['current'], 'unknown')
        self.assertEqual(result['installed']['current'], 'unknown')

    def test_cli_reads_only_explicit_local_metadata_and_omits_unrelated_payload(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'snapshot.json'
            snapshot = ci()
            snapshot['unrelated'] = {'token': 'PRIVATE-SHOULD-NOT-APPEAR', 'owner': 'private@example.test'}
            snapshot['databaseId'] = {'secret': 'PRIVATE-SHOULD-NOT-APPEAR'}
            path.write_text(json.dumps(snapshot))
            output = io.StringIO()
            with patch.object(socket, 'socket', side_effect=AssertionError('offline only')), \
                 patch.object(m.sys, 'argv', ['release_status.py', '--main', MAIN, '--as-of', NOW.isoformat(), '--main-ci', str(path)]), \
                 contextlib.redirect_stdout(output):
                m.main()
            text = output.getvalue()
            self.assertNotIn('PRIVATE', text)
            self.assertNotIn('private@example.test', text)
            self.assertNotIn(folder, text)
            parsed = json.loads(text)
            self.assertIsNone(parsed['mainCi']['run'])
            self.assertEqual(len(parsed['inputs']), 1)
            self.assertEqual(len(parsed['inputs'][0]['sha256']), 64)

    def test_bad_source_or_as_of_rejected(self):
        for source, date in [('short', NOW), (MAIN, None), (MAIN, datetime.datetime(2030, 1, 1))]:
            with self.assertRaises(ValueError):
                m.summarize(source, date)


if __name__ == '__main__':
    unittest.main()
