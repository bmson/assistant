import base64
import datetime
import io
import json
import hashlib
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
import owner_editor_recovery_pair as m
from owner_editor_recovery_pair import Collector, Stop, HOST, ROOT, SUBJECTS, NoRedirect

MANIFEST = f'/v2/{ROOT}/web/manifests/{SUBJECTS["web"]}'
SIG = f'/v2/{ROOT}/web/manifests/{SUBJECTS["web"].replace(":", "-")}.sig'


class Response(io.BytesIO):
    status = 200


class BoundTests(unittest.TestCase):
    def test_import_and_entrypoint_have_no_network(self):
        with patch.object(socket, 'socket', side_effect=AssertionError('no socket')):
            c = Collector('private-token', _open=lambda *a, **k: Response(b'{}'))
            self.assertEqual(c.receipt()['requests'], 0)
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test'))

    def test_only_exact_subjects_and_storage_tags(self):
        for path in ['https://evil.test/private', MANIFEST+'?secret=q',
                     '/v2/'+ROOT+'/web/tags/list', '/v2/'+ROOT+'/web/manifests/latest',
                     '/v2/'+ROOT+'/agent/blobs/sha256:'+'0'*64, MANIFEST+'/../x']:
            calls = []
            c = Collector('private-token', _open=lambda *a, **k: calls.append(a))
            with self.assertRaisesRegex(Stop, '^object_not_allowlisted$'):
                c.read(path)
            self.assertEqual(calls, [])
            self.assertNotIn('private', str(c.receipt()))

    def test_closed_failure_and_no_retry_after_transport_error(self):
        calls = []
        def fail(*a, **k):
            calls.append(1)
            raise RuntimeError('private-token https://evil.test/private')
        c = Collector('private-token', _open=fail)
        with self.assertRaisesRegex(Stop, '^transport_failed$'): c.read(SIG)
        with self.assertRaisesRegex(Stop, '^already_stopped$'): c.read(SIG)
        self.assertEqual(len(calls), 1)

    def test_request_byte_time_limits(self):
        c = Collector('token', _open=lambda *a, **k: Response(b'{}'))
        for _ in range(24): self.assertEqual(c.read(SIG), b'{}')
        with self.assertRaisesRegex(Stop, '^request_or_time_budget$'): c.read(SIG)
        c = Collector('token', _open=lambda *a, **k: Response(b'x'*100))
        c.MAX_BYTES = 8
        with self.assertRaisesRegex(Stop, '^byte_budget$'): c.read(SIG)
        self.assertEqual(c.receipt()['bytes'], 8)
        now = [0]
        c = Collector('token', _clock=lambda: now[0])
        now[0] = 120
        with self.assertRaisesRegex(Stop, '^request_or_time_budget$'): c.read(SIG)
        self.assertEqual(c.receipt()['requests'], 0)

    def test_http_redirect_and_digest_fail_closed(self):
        r = Response(b'private'); r.status = 302
        c = Collector('token', _open=lambda *a, **k: r)
        with self.assertRaisesRegex(Stop, '^http_status$'): c.read(SIG)
        c = Collector('token', _open=lambda *a, **k: Response(b'not exact manifest'))
        with self.assertRaisesRegex(Stop, '^content_digest_mismatch$'): c.read(MANIFEST)

    def test_only_observed_signature_layers_enrolled_and_hashed(self):
        blob = b'fixture signed envelope'
        digest = 'sha256:'+hashlib.sha256(blob).hexdigest()
        manifest = json.dumps({'schemaVersion': 2, 'layers': [{'digest': digest, 'size': len(blob),
                       'mediaType': 'application/vnd.dev.sigstore.bundle.v0.3+json'}]}).encode()
        def transport(request, **kwargs):
            self.assertEqual(request.get_method(), 'GET')
            self.assertTrue(request.full_url.startswith('https://'+HOST+'/v2/'+ROOT+'/web/'))
            return Response(manifest if '/manifests/' in request.full_url else blob)
        c = Collector('token', _open=transport)
        c.read(SIG)
        paths = c.enroll_signature_layers('web', 'sig', manifest)
        self.assertEqual(c.read(paths[0]), blob)
        c = Collector('token', _open=transport)
        with self.assertRaisesRegex(Stop, '^signature_manifest_not_observed$'):
            c.enroll_signature_layers('web', 'sig', manifest)

    def test_no_image_layer_or_repository_scope_expansion(self):
        manifest = json.dumps({'schemaVersion': 2, 'layers': [{'digest': 'sha256:'+'1'*64,
            'size': 20, 'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip'}]}).encode()
        c = Collector('token', _open=lambda *a, **k: Response(manifest));c.read(SIG)
        with self.assertRaisesRegex(Stop, '^unsupported_signature_layer$'):
            c.enroll_signature_layers('web', 'sig', manifest)

    def test_descriptor_size_must_match_actual_even_when_digest_matches(self):
        blob = b'fixture';digest = 'sha256:'+hashlib.sha256(blob).hexdigest()
        manifest = json.dumps({'schemaVersion': 2, 'layers': [{'digest': digest,
            'size': len(blob)+1, 'mediaType': 'application/vnd.dev.sigstore.bundle.v0.3+json'}]}).encode()
        c = Collector('token', _open=lambda req, **k: Response(manifest if '/manifests/' in req.full_url else blob))
        c.read(SIG);paths = c.enroll_signature_layers('web', 'sig', manifest)
        with self.assertRaisesRegex(Stop, '^descriptor_size_mismatch$'): c.read(paths[0])


class AuthAndLifecycleTests(unittest.TestCase):
    def env(self, directory):
        return {'RECOVERY_MODE': 'recovery-pair', 'RECOVERY_SOURCE_SHA': 'a' * 40,
                'GITHUB_SHA': 'a' * 40, 'GITHUB_WORKFLOW_SHA': 'a' * 40,
                'GITHUB_REPOSITORY': 'bmson/assistant', 'GITHUB_REF': 'refs/heads/main',
                'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_RUN_ATTEMPT': '1',
                'GITHUB_WORKFLOW_REF': m.WORKFLOW, 'GITHUB_RUN_ID': '1234',
                'GCP_PROJECT': 'bmson-assistant', 'GCP_DEPLOY_SERVICE_ACCOUNT': m.SERVICE_ACCOUNT,
                'GCP_WORKLOAD_IDENTITY_PROVIDER': 'projects/123/locations/global/workloadIdentityPools/github/providers/github-actions',
                'RECOVERY_APPROVAL_EXPIRES_AT': '2030-01-01T00:10:00Z',
                'ACTIONS_ID_TOKEN_REQUEST_URL': 'https://pipelines.actions.githubusercontent.com/fixture/idtoken?api-version=2',
                'ACTIONS_ID_TOKEN_REQUEST_TOKEN': 'private-request-token',
                'RUNNER_TEMP': directory, 'GITHUB_WORKSPACE': directory}

    def now(self):
        return datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc).timestamp()

    def replies(self, env):
        claims = {'aud': 'https://iam.googleapis.com/' + env['GCP_WORKLOAD_IDENTITY_PROVIDER'],
                  'repository': 'bmson/assistant', 'ref': 'refs/heads/main',
                  'sha': env['GITHUB_SHA'], 'workflow_ref': m.WORKFLOW,
                  'run_id': '1234', 'run_attempt': '1'}
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
        return [{'value': 'header.' + payload + '.signature'},
                {'access_token': 'private-federated'},
                {'accessToken': 'private-access', 'expireTime': '2030-01-01T00:10:00Z'}]

    def head_patch(self):
        return patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'a' * 40))

    def test_default_off_and_context_rejections_happen_before_io(self):
        with tempfile.TemporaryDirectory() as directory:
            env = self.env(directory)
            for key, value in [('RECOVERY_MODE', ''), ('GITHUB_REF', 'refs/heads/evil'),
                               ('GITHUB_RUN_ATTEMPT', '2'), ('GITHUB_WORKFLOW_SHA', 'b' * 40),
                               ('GITHUB_REPOSITORY', 'foreign/repo'),
                               ('GCP_DEPLOY_SERVICE_ACCOUNT', 'different@example.test')]:
                with self.subTest(key=key), patch.object(socket, 'socket', side_effect=AssertionError('no socket')):
                    with self.assertRaises(Stop):
                        m.validate_context({**env, key: value}, now=self.now(), head='a' * 40)
            for expiry in ['2030-01-01T00:00:00Z', '2030-01-01T00:31:00Z', '2030-01-01T00:10:00']:
                with self.assertRaises(Stop):
                    m.validate_context({**env, 'RECOVERY_APPROVAL_EXPIRES_AT': expiry}, now=self.now(), head='a' * 40)
            with self.assertRaises(Stop):
                m.validate_context(env, now=self.now(), head='b' * 40)

    def test_three_exact_auth_requests_and_no_token_disk_or_output(self):
        with tempfile.TemporaryDirectory() as directory, self.head_patch():
            env = self.env(directory)
            replies = self.replies(env)
            calls = []
            def transport(request, **kwargs):
                calls.append((request, kwargs))
                return Response(json.dumps(replies[len(calls) - 1]).encode())
            result = m.issue_token(env, opener=transport, wall=self.now)
            self.assertEqual(result, 'private-access')
            self.assertEqual([x[0].get_method() for x in calls], ['GET', 'POST', 'POST'])
            self.assertEqual(len(calls), 3)
            self.assertTrue(calls[0][0].full_url.startswith('https://pipelines.actions.githubusercontent.com/'))
            self.assertEqual(calls[1][0].full_url, 'https://sts.googleapis.com/v1/token')
            self.assertEqual(calls[2][0].full_url, 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + m.SERVICE_ACCOUNT + ':generateAccessToken')
            self.assertEqual(json.loads(calls[2][0].data)['lifetime'], '600s')
            self.assertTrue(all(x[1]['timeout'] <= 8 for x in calls))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_denial_redirect_remote_error_wrong_claim_and_oversize_never_retry(self):
        with tempfile.TemporaryDirectory() as directory, self.head_patch():
            env = self.env(directory)
            for status in [302, 401, 403, 429, 503]:
                calls = []
                def deny(*args, **kwargs):
                    calls.append(1)
                    result = Response(b'private-request-token')
                    result.status = status
                    return result
                with self.assertRaisesRegex(Stop, '^auth_denied$'):
                    m.issue_token(env, opener=deny, wall=self.now)
                self.assertEqual(len(calls), 1)
            def fail(*args, **kwargs):
                raise RuntimeError('private-request-token private-access')
            with self.assertRaisesRegex(Stop, '^auth_request_failed$'):
                m.issue_token(env, opener=fail, wall=self.now)
            for body in [b'x' * 65537, b'{}', json.dumps({'value': 'not-a-jwt'}).encode()]:
                calls = []
                def wrong(*args, **kwargs):
                    calls.append(1)
                    return Response(body)
                with self.assertRaises(Stop) as caught:
                    m.issue_token(env, opener=wrong, wall=self.now)
                self.assertNotIn('private', str(caught.exception))
                self.assertEqual(len(calls), 1)

    def test_auth_endpoint_cannot_send_github_token_elsewhere(self):
        with tempfile.TemporaryDirectory() as directory, self.head_patch():
            env = self.env(directory)
            for url in ['https://evil.test/idtoken', 'http://pipelines.actions.githubusercontent.com/idtoken',
                        'https://other.actions.githubusercontent.com/idtoken',
                        'https://child.pipelines.actions.githubusercontent.com/idtoken',
                        'https://pipelines.actions.githubusercontent.com:443/idtoken',
                        'https://pipelines.actions.githubusercontent.com:8443/idtoken',
                        'https://pipelines.actions.githubusercontent.com.evil.test/idtoken',
                        'https://user@pipelines.actions.githubusercontent.com/idtoken',
                        'https://user:password@pipelines.actions.githubusercontent.com/idtoken',
                        'https://pipelines.actions.githubusercontent.com/idtoken?audience=other']:
                class EndpointOnlyEnv(dict):
                    def get(self, key, default=None):
                        if key == 'ACTIONS_ID_TOKEN_REQUEST_TOKEN':
                            raise AssertionError('unsupported profile must stop before token lookup')
                        return super().get(key, default)
                transport = Mock(side_effect=AssertionError('must not forward token'))
                with self.subTest(url=url), self.assertRaises(Stop), patch.object(socket, 'socket', side_effect=AssertionError('no socket')):
                    m.issue_token(EndpointOnlyEnv({**env, 'ACTIONS_ID_TOKEN_REQUEST_URL': url}), opener=transport, wall=self.now)
                transport.assert_not_called()

    def test_oidc_redirect_is_not_followed_or_retried(self):
        redirect = NoRedirect()
        self.assertIsNone(redirect.redirect_request(None, None, 302, '', {},
                          'https://other.actions.githubusercontent.com/idtoken'))
        with tempfile.TemporaryDirectory() as directory, self.head_patch():
            response = Response(b'private-request-token')
            response.status = 302
            transport = Mock(return_value=response)
            with self.assertRaisesRegex(Stop, '^auth_denied$'):
                m.issue_token(self.env(directory), opener=transport, wall=self.now)
            transport.assert_called_once()

    def test_auth_time_budget_and_wrong_lifetime_stop_before_registry(self):
        with tempfile.TemporaryDirectory() as directory, self.head_patch():
            env = self.env(directory)
            values = iter([0, 31])
            with self.assertRaisesRegex(Stop, '^auth_budget$'):
                m.issue_token(env, opener=lambda *a, **k: self.fail('no request'), clock=lambda: next(values), wall=self.now)
            replies = self.replies(env)
            replies[2]['expireTime'] = '2030-01-01T01:00:00Z'
            with self.assertRaisesRegex(Stop, '^auth_token_expiry$'):
                m.issue_token(env, opener=lambda *a, **k: Response(json.dumps(replies.pop(0)).encode()), wall=self.now)

    def test_auth_parent_deadline_kills_child_and_closes_private_pipe(self):
        context = Mock()
        reader, writer, child = Mock(), Mock(), Mock()
        context.Pipe.return_value = (reader, writer)
        context.Process.return_value = child
        reader.poll.return_value = False
        child.is_alive.return_value = True
        with patch.object(m.multiprocessing, 'get_context', return_value=context):
            with self.assertRaisesRegex(Stop, '^auth_hard_deadline$'):
                m.authenticate_once({})
        reader.poll.assert_called_once_with(30)
        reader.close.assert_called_once()
        writer.close.assert_called_once()
        child.kill.assert_called_once()
        child.join.assert_called_once()

    def test_auth_worker_never_serializes_remote_exception_or_token_on_failure(self):
        pipe = Mock()
        with patch.object(m, 'issue_token', side_effect=RuntimeError('private-access private-request-token')):
            m._auth_worker(pipe, {})
        pipe.send.assert_called_once_with(('stopped', None))
        pipe.close.assert_called_once()

    def test_registry_parent_deadline_does_not_start_a_second_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / 'owned'
            folder.mkdir()
            (folder / '.owner.json').write_text('{}')
            context = Mock()
            child = context.Process.return_value
            child.is_alive.return_value = True
            with patch.object(m.multiprocessing, 'get_context', return_value=context):
                with self.assertRaisesRegex(Stop, '^collection_hard_deadline$'):
                    m.collect_once('private-token', folder)
            child.start.assert_called_once()
            self.assertEqual(child.join.call_args_list[0].args, (120,))
            child.kill.assert_called_once()

    def test_failed_collection_cleans_raw_files_and_redacts_receipt(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(m, 'validate_context'):
            env = self.env(directory)
            def fail(token, folder):
                (folder / 'sensitive').write_text(token)
                raise RuntimeError(token)
            with self.assertRaisesRegex(Stop, '^recovery_collection_stopped$'):
                m.run_collection(env, auth=lambda _: 'private-access', collect=fail)
            self.assertFalse(m.private_folder(env).exists())
            receipt = (Path(directory) / 'owner-editor-recovery-pair-receipt.json').read_text()
            self.assertNotIn('private', receipt)
            self.assertIn('not_performed', receipt)

    def test_failure_cleanup_error_retains_closed_receipt_before_propagation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(m, 'validate_context'):
            env = self.env(directory)
            def fail(token, folder):
                (folder / 'collection-stop.json').write_text('{"requests":2,"bytes":100}')
                raise RuntimeError('private-access /private/path')
            with patch.object(m, 'cleanup', side_effect=OSError('private-access /private/path')) as cleaning:
                with self.assertRaisesRegex(Stop, '^cleanup_failed_unknown$'):
                    m.run_collection(env, auth=lambda _: 'private-access', collect=fail)
                path = Path(directory) / 'owner-editor-recovery-pair-receipt.json'
                text = path.read_text()
                receipt = json.loads(text)
                self.assertEqual(receipt['status'], 'cleanup_failed_unknown')
                self.assertEqual(receipt['cleanup'], 'failed_unknown')
                self.assertEqual(receipt['registryCollection'], {'requests': 2, 'bytes': 100, 'stopped': True})
                self.assertNotIn('private-access', text)
                self.assertNotIn('/private/path', text)
                self.assertEqual(receipt['cryptographicVerification'], 'not_performed')
                with self.assertRaisesRegex(Stop, '^cleanup_failed_unknown$'):
                    m.finalize_cleanup(env)
                cleaning.assert_called_once()  # Unknown cleanup is not blindly repeated.

    def test_success_collection_cleanup_error_removes_success_disposition(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(m, 'validate_context'):
            env = self.env(directory)
            def collect(token, folder):
                (folder / 'collection-receipt.json').write_text('{"requests":10,"bytes":200,"stopped":false}')
            m.run_collection(env, auth=lambda _: 'private-access', collect=collect)
            with patch.object(m, 'cleanup', side_effect=OSError('private-token /private/path')):
                with self.assertRaisesRegex(Stop, '^cleanup_failed_unknown$'):
                    m.finalize_cleanup(env)
            text = (Path(directory) / 'owner-editor-recovery-pair-receipt.json').read_text()
            self.assertEqual(json.loads(text)['status'], 'cleanup_failed_unknown')
            self.assertNotIn('private-token', text)
            self.assertNotIn('/private/path', text)

    def test_success_retains_only_private_proofs_until_explicit_cleanup(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(m, 'validate_context'):
            env = self.env(directory)
            def collect(token, folder):
                self.assertEqual(token, 'private-access')
                (folder / 'collection-receipt.json').write_text('{"requests":10,"bytes":200,"stopped":false}')
            m.run_collection(env, auth=lambda _: 'private-access', collect=collect)
            self.assertEqual(m.private_folder(env).stat().st_mode & 0o777, 0o700)
            receipt = json.loads((Path(directory) / 'owner-editor-recovery-pair-receipt.json').read_text())
            self.assertEqual(receipt['status'], 'collected_not_verified')
            self.assertNotIn('private-access', json.dumps(receipt))
            m.finalize_cleanup(env)
            m.finalize_cleanup(env)
            self.assertFalse(m.private_folder(env).exists())
            receipt = json.loads((Path(directory) / 'owner-editor-recovery-pair-receipt.json').read_text())
            self.assertEqual(receipt['cleanup'], 'completed')

    def test_cleanup_does_not_follow_symlink_or_touch_unrelated_state(self):
        with tempfile.TemporaryDirectory() as directory:
            env = self.env(directory)
            unrelated = Path(directory) / 'unrelated'
            unrelated.mkdir()
            (unrelated / 'keep').write_text('keep')
            m.private_folder(env).symlink_to(unrelated, target_is_directory=True)
            m.cleanup(env)
            self.assertEqual((unrelated / 'keep').read_text(), 'keep')
            with self.assertRaises(Stop):
                m.cleanup({**env, 'GITHUB_RUN_ID': '../unrelated'})

    def test_existing_attempt_is_not_reused_or_deleted(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(m, 'validate_context'):
            env = self.env(directory)
            folder = m.private_folder(env)
            folder.mkdir()
            (folder / 'prior').write_text('retained')
            with self.assertRaisesRegex(Stop, '^attempt_already_exists$'):
                m.run_collection(env, auth=lambda _: self.fail('no auth'))
            self.assertEqual((folder / 'prior').read_text(), 'retained')

    def test_cleanup_requires_matching_fresh_ownership_marker(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(m, 'validate_context'):
            env = self.env(directory)
            def collect(token, folder):
                (folder / 'collection-receipt.json').write_text('{"requests":10,"bytes":200,"stopped":false}')
            m.run_collection(env, auth=lambda _: 'private-access', collect=collect)
            marker = m.private_folder(env) / '.owner.json'
            original = marker.read_text()
            marker.write_text('{"runId":"other","nonce":"other"}')
            with self.assertRaisesRegex(Stop, '^cleanup_ownership$'):
                m.cleanup(env)
            self.assertTrue(m.private_folder(env).exists())
            marker.write_text(original)
            m.cleanup(env)

    def establish_interrupted_owned_attempt(self, env):
        folder = m.private_folder(env)
        folder.mkdir(mode=0o700)
        state = {'source': env['RECOVERY_SOURCE_SHA'], 'runId': env['GITHUB_RUN_ID'],
                 'nonce': '1' * 64}
        (folder / '.owner.json').write_text(json.dumps(state))
        (Path(env['GITHUB_WORKSPACE']) / '.owner-editor-recovery-pair-owned.json').write_text(json.dumps(state))
        return folder

    def test_cancellation_after_ownership_before_receipt_retains_interrupted_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            env = self.env(directory)
            folder = self.establish_interrupted_owned_attempt(env)
            m.finalize_cleanup(env)
            text = (Path(directory) / 'owner-editor-recovery-pair-receipt.json').read_text()
            receipt = json.loads(text)
            self.assertEqual(receipt['status'], 'interrupted_unknown')
            self.assertEqual(receipt['cleanup'], 'completed')
            self.assertEqual(receipt['source'], env['RECOVERY_SOURCE_SHA'])
            self.assertEqual(receipt['runId'], env['GITHUB_RUN_ID'])
            self.assertIsNone(receipt['authRequests'])
            self.assertIsNone(receipt['registryCollection'])
            self.assertEqual(receipt['cryptographicVerification'], 'not_performed')
            self.assertNotIn(directory, text)
            self.assertNotIn('nonce', text)
            self.assertFalse(folder.exists())

    def test_cancellation_window_cleanup_failure_is_retained_and_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            env = self.env(directory)
            folder = self.establish_interrupted_owned_attempt(env)
            with patch.object(m, 'cleanup', side_effect=OSError('private-token /private/path')) as cleaning:
                with self.assertRaisesRegex(Stop, '^cleanup_failed_unknown$'):
                    m.finalize_cleanup(env)
                text = (Path(directory) / 'owner-editor-recovery-pair-receipt.json').read_text()
                receipt = json.loads(text)
                self.assertEqual(receipt['status'], 'interrupted_unknown')
                self.assertEqual(receipt['cleanup'], 'failed_unknown')
                self.assertIsNone(receipt['authRequests'])
                self.assertIsNone(receipt['registryCollection'])
                self.assertNotIn('private-token', text)
                self.assertNotIn('/private/path', text)
                with self.assertRaisesRegex(Stop, '^cleanup_failed_unknown$'):
                    m.finalize_cleanup(env)
                cleaning.assert_called_once()
            self.assertTrue(folder.exists())

    def test_no_ownership_is_distinct_from_interrupted_owned_work(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(m, 'cleanup') as cleaning:
            env = self.env(directory)
            m.finalize_cleanup(env)
            m.finalize_cleanup(env)
            receipt = json.loads((Path(directory) / 'owner-editor-recovery-pair-receipt.json').read_text())
            self.assertEqual(receipt['status'], 'no_owned_attempt')
            self.assertEqual(receipt['cleanup'], 'not_attempted')
            self.assertIsNone(receipt['source'])
            self.assertIsNone(receipt['authRequests'])
            self.assertIsNone(receipt['registryCollection'])
            cleaning.assert_not_called()

    def test_workflow_modes_exclusive_and_no_raw_or_auth_artifact(self):
        text = (Path(__file__).parents[1] / '.github/workflows/owner-editor-release-inventory.yml').read_text()
        self.assertIn('default: prerequisites', text)
        self.assertIn("inputs.observation_mode == 'recovery-pair'", text)
        self.assertIn("inputs.observation_mode == 'prerequisites'", text)
        self.assertIn('group: production-deploy\n  cancel-in-progress: false', text)
        recovery = text.split('\n  recovery-pair:\n')[1]
        self.assertNotIn('google-github-actions/auth@', recovery)
        self.assertNotIn('configure-docker', recovery)
        self.assertNotIn('path: ${{ runner.temp', recovery)
        self.assertIn('path: owner-editor-recovery-pair.encrypted.json', recovery)
        self.assertIn('if: always()\n        run: python3 scripts/owner_editor_recovery_pair.py --cleanup', recovery)
        self.assertLess(recovery.index('--cleanup'), recovery.index('name: Retain closed collection outcome'))
        ci = (Path(__file__).parents[1] / '.github/workflows/ci.yml').read_text()
        self.assertIn('python3 -m unittest discover -s scripts -p test_owner_editor_recovery_pair.py', ci)
        self.assertIn('node --test scripts/owner-editor-recovery-envelope.node-test.mjs', ci)


if __name__ == '__main__':
    unittest.main()
