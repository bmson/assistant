"""Fixed recovery proof collection. No default auth, refresh, retries or crypto claim."""
import base64
import datetime
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HOST = 'us-west1-docker.pkg.dev'
ROOT = 'bmson-assistant/assistant'
SUBJECTS = {
    'agent': 'sha256:1e87cc4b87922f6f9b59216afff045af49be8aac40601cb2d07a1723d7fc7c87',
    'web': 'sha256:9e51884069d0c1a2c74115b98a0b9818a8b8d6d4cc726b444a86439b6b3ebac7',
}
SERVICE_ACCOUNT = 'assistant-github-deploy@bmson-assistant.iam.gserviceaccount.com'
WORKFLOW = 'bmson/assistant/.github/workflows/owner-editor-release-inventory.yml@refs/heads/main'
# Closed runner profile. Other legitimate GitHub hosts are unsupported, not aliases.
OIDC_HOST = 'pipelines.actions.githubusercontent.com'
class Stop(RuntimeError):
    """Only closed error codes cross the boundary; never include remote text."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Collector:
    MAX_REQUESTS = 24
    MAX_BYTES = 16 * 1024 * 1024
    MAX_SECONDS = 120

    def __init__(self, token, *, _open=None, _clock=time.monotonic):
        if not isinstance(token, str) or not token or '\r' in token or '\n' in token:
            raise Stop('credential_missing_or_invalid')
        self._token = token
        self._clock = _clock
        self._start = _clock()
        self._open = _open or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open
        self._requests = 0
        self._bytes = 0
        self._stopped = False
        self._allowed = set()
        self._observed_signature_manifests = set()
        self._descriptor_sizes = {}
        for component, digest in SUBJECTS.items():
            prefix = f'/v2/{ROOT}/{component}/manifests/'
            self._allowed.add(prefix + digest)
            for suffix in ['sig', 'att']:
                self._allowed.add(prefix + digest.replace(':', '-') + '.' + suffix)

    def receipt(self):
        return {'requests': self._requests, 'bytes': self._bytes,
                'stopped': self._stopped}

    def _stop(self, code):
        self._stopped = True
        raise Stop(code) from None

    def read(self, path):
        if self._stopped:
            raise Stop('already_stopped')
        if path not in self._allowed:
            self._stop('object_not_allowlisted')
        elapsed = self._clock() - self._start
        if self._requests >= self.MAX_REQUESTS or elapsed >= self.MAX_SECONDS:
            self._stop('request_or_time_budget')
        if self._bytes >= self.MAX_BYTES:
            self._stop('byte_budget')
        self._requests += 1
        request = urllib.request.Request('https://' + HOST + path, method='GET', headers={
            'Authorization': 'Bearer ' + self._token,
            'Accept': 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/octet-stream',
        })
        try:
            with self._open(request, timeout=min(10, self.MAX_SECONDS - elapsed)) as response:
                if response.status != 200:
                    self._stop('http_status')
                data = bytearray()
                while True:
                    if self._clock() - self._start >= self.MAX_SECONDS:
                        self._stop('time_budget')
                    if self._bytes >= self.MAX_BYTES:
                        self._stop('byte_budget')
                    block = response.read(min(65536, self.MAX_BYTES - self._bytes))
                    self._bytes += len(block)
                    if self._bytes > self.MAX_BYTES:
                        self._stop('byte_budget')
                    if not block:
                        break
                    data.extend(block)
            body = bytes(data)
            if path in self._descriptor_sizes and len(body) != self._descriptor_sizes[path]:
                self._stop('descriptor_size_mismatch')
            expected = path.rsplit('/', 1)[-1]
            if expected.startswith('sha256:') and hashlib.sha256(body).hexdigest() != expected[7:]:
                self._stop('content_digest_mismatch')
            if expected.endswith(('.sig', '.att')):
                self._observed_signature_manifests.add((path, hashlib.sha256(body).hexdigest()))
            return body
        except Stop:
            raise
        except Exception:
            self._stop('transport_failed')

    def enroll_signature_layers(self, component, kind, manifest):
        if component not in SUBJECTS or kind not in ['sig', 'att']:
            self._stop('invalid_signature_scope')
        source_path = f'/v2/{ROOT}/{component}/manifests/{SUBJECTS[component].replace(":", "-")}.{kind}'
        if (source_path, hashlib.sha256(manifest).hexdigest()) not in self._observed_signature_manifests:
            self._stop('signature_manifest_not_observed')
        try:
            value = json.loads(manifest)
            layers = value['layers']
            if value.get('schemaVersion') != 2 or not isinstance(layers, list) or not 1 <= len(layers) <= 4:
                self._stop('unsupported_signature_manifest')
            accepted = {'application/vnd.dev.cosign.simplesigning.v1+json',
                        'application/vnd.dsse.envelope.v1+json',
                        'application/vnd.dev.sigstore.bundle.v0.3+json'}
            paths = []
            for layer in layers:
                digest = layer['digest']
                size = layer['size']
                if (layer.get('mediaType') not in accepted or not isinstance(size, int)
                        or isinstance(size, bool) or not 0 < size <= self.MAX_BYTES
                        or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest)):
                    self._stop('unsupported_signature_layer')
                path = f'/v2/{ROOT}/{component}/blobs/{digest}'
                if path in self._descriptor_sizes and self._descriptor_sizes[path] != size:
                    self._stop('descriptor_size_conflict')
                self._descriptor_sizes[path] = size
                paths.append(path)
            self._allowed.update(paths)
            return paths
        except Stop:
            raise
        except Exception:
            self._stop('invalid_signature_manifest')



def _collect_worker(token, output):
    collector = Collector(token)
    folder = Path(output)
    def save(name, data):
        with (folder / name).open('xb') as stream:
            os.chmod(stream.name, 0o600)
            stream.write(data)
    try:
        for component, digest in SUBJECTS.items():
            prefix = f'/v2/{ROOT}/{component}/manifests/'
            save(component + '-subject.json', collector.read(prefix + digest))
            for kind in ['sig', 'att']:
                manifest = collector.read(prefix + digest.replace(':', '-') + '.' + kind)
                save(component + '-' + kind + '-manifest.json', manifest)
                for index, path in enumerate(collector.enroll_signature_layers(component, kind, manifest)):
                    save(f'{component}-{kind}-{index}.json', collector.read(path))
        save('collection-receipt.json', json.dumps(collector.receipt()).encode())
    except Stop as error:
        save('collection-stop.json', json.dumps({'code': str(error), **collector.receipt()}).encode())
        raise SystemExit(1)
    except Exception:
        save('collection-stop.json', b'{"code":"local_collection_failure"}')
        raise SystemExit(1)


def collect_once(token, output):
    """Explicit future entry point. No auth acquisition; caller supplies memory token.

    Directory creation consumes this local attempt; never reuse/retry it. The
    process deadline is independent of HTTP socket behavior. Collection is not
    verification, and no verifier subprocess can access this network transport.
    """
    folder = Path(output)
    if not folder.is_dir() or folder.is_symlink() or not (folder / '.owner.json').is_file():
        raise Stop('owned_folder_required')
    (folder / 'attempt-consumed.json').write_text('{"attempts":1}\n')
    context = multiprocessing.get_context('spawn')
    process = context.Process(target=_collect_worker, args=(token, str(folder)))
    process.start()
    process.join(120)
    if process.is_alive():
        process.kill()
        process.join()
        raise Stop('collection_hard_deadline')
    if process.exitcode != 0:
        raise Stop('collection_stopped')
    return {'collection': 'completed', 'cryptographicVerification': 'not_performed'}


def validate_context(env, now=None, head=None):
    """No IO except an explicit local checkout SHA check; never read credentials."""
    now = time.time() if now is None else now
    expected = env.get('RECOVERY_SOURCE_SHA', '')
    if (env.get('RECOVERY_MODE') != 'recovery-pair'
            or env.get('GITHUB_REPOSITORY') != 'bmson/assistant'
            or env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or env.get('GITHUB_REF') != 'refs/heads/main'
            or env.get('GITHUB_RUN_ATTEMPT') != '1'
            or env.get('GITHUB_WORKFLOW_REF') != WORKFLOW
            or not re.fullmatch(r'[0-9a-f]{40}', expected)
            or env.get('GITHUB_SHA') != expected
            or env.get('GITHUB_WORKFLOW_SHA') != expected
            or not re.fullmatch(r'[0-9]+', env.get('GITHUB_RUN_ID', ''))
            or env.get('GCP_PROJECT') != 'bmson-assistant'
            or env.get('GCP_DEPLOY_SERVICE_ACCOUNT') != SERVICE_ACCOUNT):
        raise Stop('source_or_identity_context')
    provider = env.get('GCP_WORKLOAD_IDENTITY_PROVIDER', '')
    if not re.fullmatch(r'projects/[0-9]+/locations/global/workloadIdentityPools/[a-zA-Z0-9_-]+/providers/[a-zA-Z0-9_-]+', provider):
        raise Stop('provider_context')
    try:
        expiry = datetime.datetime.fromisoformat(
            env.get('RECOVERY_APPROVAL_EXPIRES_AT', '').replace('Z', '+00:00'))
        if expiry.utcoffset() != datetime.timedelta(0):
            raise ValueError()
        remaining = expiry.timestamp() - now
    except (ValueError, TypeError, OverflowError):
        raise Stop('approval_window') from None
    if not 0 < remaining <= 1800:
        raise Stop('approval_window')
    if head is None:
        result = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True,
                                timeout=5, check=False)
        head = result.stdout.decode().strip() if result.returncode == 0 else ''
    if head != expected:
        raise Stop('checkout_mismatch')
    return provider


def issue_token(env, *, opener=None, clock=time.monotonic, wall=time.time):
    """Exactly one OIDC GET, one STS POST, one impersonation POST. No SDK retries."""
    provider = validate_context(env, now=wall())
    oidc_url = urllib.parse.urlsplit(env.get('ACTIONS_ID_TOKEN_REQUEST_URL', ''))
    if (oidc_url.scheme != 'https' or oidc_url.netloc != OIDC_HOST
            or oidc_url.port is not None or oidc_url.username
            or oidc_url.password or oidc_url.fragment):
        raise Stop('oidc_endpoint')
    query = urllib.parse.parse_qsl(oidc_url.query, keep_blank_values=True)
    if any(key == 'audience' for key, _ in query):
        raise Stop('oidc_endpoint')
    request_token = env.get('ACTIONS_ID_TOKEN_REQUEST_TOKEN', '')
    if not request_token or '\r' in request_token or '\n' in request_token:
        raise Stop('oidc_request_token')
    audience = 'https://iam.googleapis.com/' + provider
    url = urllib.parse.urlunsplit(oidc_url._replace(
        query=urllib.parse.urlencode(query + [('audience', audience)])))
    open_request = opener or urllib.request.build_opener(
        urllib.request.ProxyHandler({}), NoRedirect).open
    started = clock()
    requests = 0

    def read_json(endpoint, bearer, data=None):
        nonlocal requests
        if requests >= 3 or clock() - started >= 30:
            raise Stop('auth_budget')
        requests += 1
        headers = {'Authorization': 'Bearer ' + bearer} if bearer else {}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(endpoint, data=data, headers=headers,
                                         method='GET' if data is None else 'POST')
        try:
            with open_request(request, timeout=min(8, 30 - (clock() - started))) as response:
                if response.status != 200:
                    raise Stop('auth_denied')
                body = response.read(65537)
                if len(body) > 65536:
                    raise Stop('auth_response_size')
                value = json.loads(body)
                if not isinstance(value, dict):
                    raise Stop('auth_response')
                return value
        except Stop:
            raise
        except Exception:
            raise Stop('auth_request_failed') from None

    def token(value, key):
        result = value.get(key)
        if (not isinstance(result, str) or not 1 <= len(result) <= 16384
                or not re.fullmatch(r'[\x21-\x7e]+', result)):
            raise Stop('auth_token_response')
        return result

    oidc = token(read_json(url, request_token), 'value')
    # STS verifies the signature; these local claims prevent wrong-context use.
    try:
        part = oidc.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
        expected = {'aud': audience, 'repository': 'bmson/assistant',
                    'ref': 'refs/heads/main', 'sha': env['RECOVERY_SOURCE_SHA'],
                    'workflow_ref': WORKFLOW, 'run_id': env['GITHUB_RUN_ID'],
                    'run_attempt': '1'}
        if any(str(claims.get(key)) != value for key, value in expected.items()):
            raise ValueError()
    except Exception:
        raise Stop('oidc_claim_context') from None
    sts_body = {'audience': '//iam.googleapis.com/' + provider,
                'grantType': 'urn:ietf:params:oauth:grant-type:token-exchange',
                'requestedTokenType': 'urn:ietf:params:oauth:token-type:access_token',
                'scope': 'https://www.googleapis.com/auth/cloud-platform',
                'subjectTokenType': 'urn:ietf:params:oauth:token-type:jwt',
                'subjectToken': oidc}
    federated = token(read_json('https://sts.googleapis.com/v1/token', '',
                               json.dumps(sts_body).encode()), 'access_token')
    endpoint = ('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/'
                + SERVICE_ACCOUNT + ':generateAccessToken')
    access = read_json(endpoint, federated, json.dumps({
        'scope': ['https://www.googleapis.com/auth/cloud-platform'],
        'lifetime': '600s'}).encode())
    try:
        expires = datetime.datetime.fromisoformat(access['expireTime'].replace('Z', '+00:00'))
        if not 30 < expires.timestamp() - wall() <= 600:
            raise ValueError()
    except (KeyError, ValueError, TypeError):
        raise Stop('auth_token_expiry') from None
    return token(access, 'accessToken')


def _auth_worker(pipe, env):
    try:
        pipe.send(('ok', issue_token(env)))
    except BaseException:
        # Never serialize an exception, HTTP body, endpoint or credential.
        pipe.send(('stopped', None))
    finally:
        pipe.close()


def authenticate_once(env):
    context = multiprocessing.get_context('spawn')
    reader, writer = context.Pipe(duplex=False)
    process = context.Process(target=_auth_worker, args=(writer, dict(env)))
    process.start()
    writer.close()
    try:
        if not reader.poll(30):
            raise Stop('auth_hard_deadline')
        kind, token = reader.recv()
        if kind != 'ok':
            raise Stop('auth_stopped')
        return token
    except (EOFError, OSError):
        raise Stop('auth_stopped') from None
    finally:
        reader.close()
        if process.is_alive():
            process.kill()
        process.join()


def private_folder(env):
    run = env.get('GITHUB_RUN_ID', '')
    parent = Path(env.get('RUNNER_TEMP', ''))
    if not re.fullmatch(r'[0-9]+', run) or not parent.is_absolute() or not parent.is_dir():
        raise Stop('private_folder_context')
    return parent.resolve() / ('owner-editor-recovery-pair-' + run)


def proven_ownership(env):
    """Snapshot authority before deletion; never infer ownership from path names."""
    folder = private_folder(env)
    state_path = Path(env['GITHUB_WORKSPACE']) / '.owner-editor-recovery-pair-owned.json'
    if not state_path.exists():
        return None
    if state_path.is_symlink() or folder.is_symlink() or state_path.stat().st_size > 4096:
        raise Stop('cleanup_ownership')
    state = json.loads(state_path.read_text())
    marker = folder / '.owner.json'
    if (state.get('runId') != env['GITHUB_RUN_ID']
            or state.get('source') != env.get('RECOVERY_SOURCE_SHA')
            or not re.fullmatch(r'[0-9a-f]{40}', state.get('source', ''))
            or not re.fullmatch(r'[0-9a-f]{64}', state.get('nonce', ''))
            or not marker.is_file() or marker.is_symlink()
            or marker.stat().st_size > 4096 or json.loads(marker.read_text()) != state):
        raise Stop('cleanup_ownership')
    return state


def cleanup(env):
    if proven_ownership(env) is None:
        return  # No ownership was established; preserve pre-existing paths.
    folder = private_folder(env)
    state_path = Path(env['GITHUB_WORKSPACE']) / '.owner-editor-recovery-pair-owned.json'
    shutil.rmtree(folder)
    state_path.unlink()


def finalize_cleanup(env):
    """Persist a closed cleanup disposition before a cleanup failure escapes."""
    path = Path(env['GITHUB_WORKSPACE']) / 'owner-editor-recovery-pair-receipt.json'
    if not path.exists():
        # Cancellation may occur after ownership creation but before run_collection's
        # receipt exists. Preserve the proven source/run before cleanup erases it.
        receipt = {'source': None, 'runId': None, 'cryptographicVerification': 'not_performed',
                   'authRequests': None, 'registryCollection': None,
                   'status': 'no_owned_attempt', 'cleanup': 'not_attempted'}
        failed = False
        try:
            owned = proven_ownership(env)
            if owned is not None:
                receipt.update(source=owned['source'], runId=owned['runId'],
                               status='interrupted_unknown')
                try:
                    cleanup(env)
                    receipt['cleanup'] = 'completed'
                except BaseException:
                    receipt['cleanup'] = 'failed_unknown'
                    failed = True
        except BaseException:
            receipt.update(status='ownership_unknown', cleanup='failed_unknown')
            failed = True
        with path.open('x') as stream:
            os.chmod(path, 0o600)
            json.dump(receipt, stream, indent=2)
        if failed:
            raise Stop('cleanup_failed_unknown') from None
        return
    if path.is_symlink() or path.stat().st_size > 8192:
        raise Stop('cleanup_receipt_unavailable')
    receipt = json.loads(path.read_text())
    if receipt.get('status') == 'no_owned_attempt':
        return  # No deletion or zero-remote-work claim; counters remain unknown.
    if (receipt.get('source') != env.get('RECOVERY_SOURCE_SHA')
            or receipt.get('runId') != env.get('GITHUB_RUN_ID')):
        raise Stop('cleanup_receipt_context')
    if receipt.get('cleanup') == 'failed_unknown':
        raise Stop('cleanup_failed_unknown')  # No second cleanup attempt.
    failed = False
    try:
        cleanup(env)
        receipt['cleanup'] = 'completed'
    except BaseException:
        receipt['status'] = 'cleanup_failed_unknown'
        receipt['cleanup'] = 'failed_unknown'
        failed = True
    with path.open('w') as stream:
        json.dump(receipt, stream, indent=2)
    if failed:
        raise Stop('cleanup_failed_unknown') from None


def run_collection(env, auth=authenticate_once, collect=collect_once):
    validate_context(env)
    folder = private_folder(env)
    if folder.exists() or folder.is_symlink():
        raise Stop('attempt_already_exists')
    ownership = {'runId': env['GITHUB_RUN_ID'], 'source': env['RECOVERY_SOURCE_SHA'],
                 'nonce': os.urandom(32).hex()}
    state_path = Path(env['GITHUB_WORKSPACE']) / '.owner-editor-recovery-pair-owned.json'
    with state_path.open('x') as stream:
        os.chmod(state_path, 0o600)
        json.dump(ownership, stream)
    folder.mkdir(mode=0o700)
    with (folder / '.owner.json').open('x') as stream:
        os.chmod(stream.name, 0o600)
        json.dump(ownership, stream)
    receipt = {'source': env['RECOVERY_SOURCE_SHA'], 'runId': env['GITHUB_RUN_ID'],
               'registry': HOST, 'subjects': SUBJECTS,
               'cryptographicVerification': 'not_performed', 'status': 'stopped',
               'authRequests': None, 'registryCollection': None, 'cleanup': 'pending'}
    token = None
    succeeded = False
    try:
        token = auth(env)
        receipt['authRequests'] = 3
        collect(token, folder)
        receipt['registryCollection'] = json.loads((folder / 'collection-receipt.json').read_text())
        receipt['status'] = 'collected_not_verified'
        succeeded = True
    except BaseException:
        # Closed status only, including malformed/denied/timeout responses.
        raise Stop('recovery_collection_stopped') from None
    finally:
        token = None
        cleanup_failed = False
        if not succeeded:
            stopped = folder / 'collection-stop.json'
            try:
                if stopped.is_file() and not stopped.is_symlink() and stopped.stat().st_size <= 4096:
                    counters = json.loads(stopped.read_text())
                    requests, size = counters.get('requests'), counters.get('bytes')
                    if (type(requests) is int and 0 <= requests <= 24
                            and type(size) is int and 0 <= size <= 16 * 1024 * 1024):
                        receipt['registryCollection'] = {'requests': requests, 'bytes': size, 'stopped': True}
            except (ValueError, OSError):
                pass  # Unknown counters, never a reason to suppress the outcome.
            try:
                cleanup(env)
                receipt['cleanup'] = 'completed'
            except BaseException:
                receipt['status'] = 'cleanup_failed_unknown'
                receipt['cleanup'] = 'failed_unknown'
                cleanup_failed = True
        path = Path(env['GITHUB_WORKSPACE']) / 'owner-editor-recovery-pair-receipt.json'
        with path.open('x') as stream:
            os.chmod(path, 0o600)
            json.dump(receipt, stream, indent=2)
        if cleanup_failed:
            raise Stop('cleanup_failed_unknown') from None


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--verify-source']:
            validate_context(os.environ)
        elif sys.argv[1:] == ['--collect']:
            run_collection(os.environ)
        elif sys.argv[1:] == ['--cleanup']:
            finalize_cleanup(os.environ)
        else:
            raise Stop('unsupported_action')
    except BaseException:
        print('Recovery proof action stopped; no cryptographic qualification.', file=sys.stderr)
        sys.exit(1)
