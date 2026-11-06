import { describe, expect, it } from 'vitest';
import { BASIC_EDITOR_COMMANDS } from './owner-editor-release-inventory.js';
import {
  localGlobalIndexArgs,
  localInventoryEnvironment,
  readLocalTokenIdentity,
  verifyLocalAccount,
  verifyLocalAdmission,
  verifyLocalOperatorSource,
  verifyLocalPacketReview,
  verifyTokenIdentity,
} from './owner-editor-v1-local-operator.js';

const sha = 'a'.repeat(40);
const env = {
  OWNER_EDITOR_LOCAL_OPERATOR: 'bmson@bmson.com',
  OWNER_EDITOR_MAINTENANCE_MODE: 'prepare-initialize',
  OWNER_EDITOR_RELEASE_SHA: sha,
};
const contract = { components: { web: { ownerEditorV1: BASIC_EDITOR_COMMANDS } } };
function check(
  e = env,
  head = sha,
  remote = `${sha}\trefs/heads/main`,
  dirty = '',
  c: unknown = contract,
  runtime = true,
) {
  return verifyLocalOperatorSource(e, head, remote, dirty, c, runtime);
}
describe('explicit existing operator maintenance transport', () => {
  it('accepts exact approved clean public-main source without workflow impersonation', () => {
    expect(() => check()).not.toThrow();
  });
  it('rejects changed source, dirty source, wrong remote and missing capability', () => {
    expect(() => check(env, 'b'.repeat(40))).toThrow();
    expect(() => check(env, sha, `${sha}\trefs/heads/other`)).toThrow();
    expect(() => check(env, sha, `${sha}\trefs/heads/main`, ' M scripts/tool.ts')).toThrow();
    expect(() => check(env, sha, `${sha}\trefs/heads/main`, '', {})).toThrow();
    expect(() => check(env, sha, `${sha}\trefs/heads/main`, '', contract, false)).toThrow();
  });
  it.each([
    'GITHUB_ACTIONS',
    'FIRESTORE_EMULATOR_HOST',
    'GOOGLE_CLOUD_UNIVERSE_DOMAIN',
    'CLOUDSDK_CORE_UNIVERSE_DOMAIN',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_GHA_CREDS_PATH',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'CLOUDSDK_AUTH_ACCESS_TOKEN',
    'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
    'CLOUDSDK_API_ENDPOINT_OVERRIDES_FIRESTORE',
  ])('rejects inherited credential/endpoint context %s', (key) => {
    expect(() => check({ ...env, [key]: 'unexpected' })).toThrow();
  });
  it('requires the explicit reviewed identity and closed mode set', () => {
    expect(() => check({ ...env, OWNER_EDITOR_LOCAL_OPERATOR: 'other@example.com' })).toThrow();
    expect(() => check({ ...env, OWNER_EDITOR_MAINTENANCE_MODE: 'repair' })).toThrow();
    expect(() => check({ ...env, OWNER_EDITOR_RELEASE_SHA: 'b'.repeat(40) })).toThrow();
  });
  it('rejects configured impersonation, ambiguous active accounts and mismatched token identity', () => {
    const active = [{ account: 'bmson@bmson.com', status: 'ACTIVE' }];
    const unsetFromStdout = {
      status: 0,
      signal: null,
      stdout: '(unset)\n',
      stderr: '',
    };
    expect(() => verifyLocalAccount(active, unsetFromStdout)).not.toThrow();
    expect(() =>
      verifyLocalAccount(active, { ...unsetFromStdout, stdout: '(unset)' }),
    ).not.toThrow();
    expect(() =>
      verifyLocalAccount(active, {
        status: 0,
        signal: null,
        stdout: 'service@project.iam.gserviceaccount.com\n',
        stderr: '',
      }),
    ).toThrow();
    expect(() => verifyLocalAccount([...active, ...active], unsetFromStdout)).toThrow();
    expect(() =>
      verifyLocalAccount([{ account: 'other@example.com', status: 'ACTIVE' }], unsetFromStdout),
    ).toThrow();
    expect(() =>
      verifyTokenIdentity({ email: 'bmson@bmson.com', verified_email: true }),
    ).not.toThrow();
    expect(() =>
      verifyTokenIdentity({ email: 'bmson@bmson.com', verified_email: false }),
    ).toThrow();
    expect(() =>
      verifyTokenIdentity({ email: 'other@example.com', verified_email: true }),
    ).toThrow();
    expect(() => verifyTokenIdentity(null)).toThrow();
  });
  it('accepts the captured Cloud SDK 586 unset profile on stderr with successful exit status', () => {
    const active = [{ account: 'bmson@bmson.com', status: 'ACTIVE' }];
    expect(() =>
      verifyLocalAccount(active, {
        status: 0,
        signal: null,
        stdout: '',
        stderr: '(unset)\n',
      }),
    ).not.toThrow();
  });
  it('rejects ambiguous, configured, noisy, or unsuccessful impersonation profiles', () => {
    const active = [{ account: 'bmson@bmson.com', status: 'ACTIVE' }];
    const base = { status: 0, signal: null, stdout: '', stderr: '' };
    for (const profile of [
      base,
      { ...base, stdout: '(unset)\n', stderr: '(unset)\n' },
      { ...base, stdout: 'service@project.iam.gserviceaccount.com\n' },
      { ...base, stderr: 'service@project.iam.gserviceaccount.com\n' },
      { ...base, stdout: '(unset)\n', stderr: 'warning\n' },
      { ...base, stdout: '(unset) \n' },
      { ...base, stderr: '(unset)' },
      { ...base, status: 1, stderr: '(unset)\n' },
      { ...base, status: null, stderr: '(unset)\n' },
      { ...base, status: null, stdout: '(unset)\n' },
      { ...base, signal: 'SIGTERM' as const, stderr: '(unset)\n' },
      { ...base, stderr: '(unset)\n', error: new Error('spawn failed') },
    ])
      expect(() => verifyLocalAccount(active, profile)).toThrow();
  });
  it('isolates verified-token CLI reads from configured endpoint, universe and credential overrides', () => {
    const inherited = {
      PATH: '/reviewed/bin',
      HOME: '/operator',
      CLOUDSDK_CONFIG: '/operator/config-with-endpoint-override',
      CLOUDSDK_CORE_UNIVERSE_DOMAIN: 'alternate.example',
      CLOUDSDK_API_ENDPOINT_OVERRIDES_FIRESTORE: 'https://alternate.example',
      CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: 'other@example.com',
      GOOGLE_APPLICATION_CREDENTIALS: '/other.json',
    };
    const child = localInventoryEnvironment(inherited, 'verified-token', '/private/fresh-config');
    expect(child).toEqual({
      PATH: '/reviewed/bin',
      HOME: '/operator',
      CLOUDSDK_CONFIG: '/private/fresh-config',
      CLOUDSDK_AUTH_ACCESS_TOKEN: 'verified-token',
      CLOUDSDK_CORE_PROJECT: 'bmson-assistant',
      CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
      CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true',
    });
    expect(child.CLOUDSDK_CONFIG).not.toBe(inherited.CLOUDSDK_CONFIG);
    expect(Object.keys(child)).not.toContain('CLOUDSDK_API_ENDPOINT_OVERRIDES_FIRESTORE');
    expect(Object.keys(child)).not.toContain('CLOUDSDK_CORE_UNIVERSE_DOMAIN');
  });
  it('bounds identity responses and rejects denial without fallback', async () => {
    await expect(
      readLocalTokenIdentity(
        new Response(JSON.stringify({ email: 'bmson@bmson.com', verified_email: true })),
      ),
    ).resolves.toBeUndefined();
    await expect(readLocalTokenIdentity(new Response('denied', { status: 403 }))).rejects.toThrow();
    await expect(readLocalTokenIdentity(new Response('x'.repeat(32769)))).rejects.toThrow('bound');
  });
  it('keeps complete global index lists fixed-target, explicit-account, unfiltered and unbounded by CLI limit', () => {
    for (const kind of ['composite', 'fields'] as const) {
      const args = localGlobalIndexArgs(kind);
      expect(args).toEqual([
        'firestore',
        'indexes',
        kind,
        'list',
        '--project=bmson-assistant',
        '--database=assistant-production',
        '--account=bmson@bmson.com',
        '--format=json',
        '--quiet',
      ]);
      expect(args.some((x) => /limit|filter|page-size/.test(x))).toBe(false);
    }
  });
});

it('binds nonempty dry-run/apply packet policy evidence to the same reviewed disabled snapshot', () => {
  const current = {
    kind: 'disabled-bootstrap',
    drainReceiptSha256: 'd'.repeat(64),
    recoveryReceiptSha256: 'e'.repeat(64),
  };
  const evidence = {
    drainSha256: current.drainReceiptSha256,
    recoverySha256: current.recoveryReceiptSha256,
  };
  expect(() => verifyLocalPacketReview(evidence, current, 'apply')).not.toThrow();
  expect(() => verifyLocalPacketReview(undefined, current, 'prepare-initialize')).not.toThrow();
  expect(() => verifyLocalPacketReview(undefined, current, 'dry-run')).not.toThrow();
  expect(() => verifyLocalPacketReview(undefined, current, 'apply')).toThrow();
  for (const mode of ['apply', 'dry-run'])
    for (const drift of [
      { ...evidence, drainSha256: 'f'.repeat(64) },
      { ...evidence, recoverySha256: 'f'.repeat(64) },
    ])
      expect(() => verifyLocalPacketReview(drift, current, mode)).toThrow();
});

it('rechecks service-level admission on final reread even when legacy template/revision hashes are unchanged', () => {
  const before = {
    name: 'projects/bmson-assistant/locations/us-west1/services/assistant-web',
    template: { revision: 'same-revision' },
    trafficStatuses: [{ revision: 'same-revision', percent: 100 }],
    scaling: { scalingMode: 'AUTOMATIC' },
  };
  expect(() => verifyLocalAdmission(before, undefined, 'web')).not.toThrow();
  for (const scaling of [
    { scalingMode: 'MANUAL', manualInstanceCount: 0 },
    { scalingMode: 'MANUAL' },
  ])
    expect(() => verifyLocalAdmission({ ...before, scaling }, undefined, 'web')).toThrow(
      'requires reviewed',
    );
});
