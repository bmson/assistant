// The manifest verifier alone is mocked in this wiring suite: no genuine archive was downloaded.
// Identity signatures and every request/response boundary are exercised offline.
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { qualifyNativeWebReadOnly } from './owner-web-release-qualification.js';
import {
  QUALIFICATION_MANIFEST as PIN,
  verifyQualificationManifest,
} from './owner-web-release-qualification-manifest.js';
import { HISTORICAL_WEB_TAGS, WEB_SERVICE } from './owner-web-tag-retirement.js';

vi.mock('./owner-web-release-qualification-manifest.js', async (original) => ({
  ...(await original<typeof import('./owner-web-release-qualification-manifest.js')>()),
  verifyQualificationManifest: vi.fn(() => ({ fixtureOnly: true })),
}));
const source = 'a'.repeat(40),
  now = Date.parse('2026-11-01T23:00:00Z');
function envFixture(): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'bmson/assistant',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: source,
    GITHUB_SHA: source,
    OWNER_NATIVE_WEB_QUALIFICATION: 'read_only',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    RUNNER_TEMP: '/home/runner/work/_temp',
    GCP_PROJECT: 'bmson-assistant',
    GCP_REGION: 'us-west1',
    ARTIFACT_REPOSITORY: 'assistant',
    GITHUB_RUN_ID: '700001',
    GCP_WORKLOAD_IDENTITY_PROVIDER:
      'projects/123/locations/global/workloadIdentityPools/fixed/providers/fixed',
    GCP_DEPLOY_SERVICE_ACCOUNT: 'deploy@bmson-assistant.iam.gserviceaccount.com',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixed.actions.githubusercontent.com/token?api-version=2',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'PRIVATEISSUERTOKEN',
    GH_TOKEN: 'PRIVATE_GITHUB_TOKEN',
  };
}
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pub = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'offline',
  alg: 'RS256',
  use: 'sig',
};
function jwt(claims: Record<string, unknown> = {}) {
  const data = [
    { alg: 'RS256', kid: 'offline' },
    {
      iss: 'https://token.actions.githubusercontent.com',
      aud: 'assistant-web-journal-v1',
      iat: now / 1000 - 1,
      nbf: now / 1000 - 1,
      exp: now / 1000 + 300,
      ...claims,
    },
  ]
    .map((x) => Buffer.from(JSON.stringify(x)).toString('base64url'))
    .join('.');
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), keys.privateKey).toString('base64url')}`;
}

const secret = 'PRIVATE_NATIVE_ENV';
function nativeFixture() {
  const old = HISTORICAL_WEB_TAGS[0],
    current = HISTORICAL_WEB_TAGS[1];
  if (!old || !current) throw new Error('Missing reviewed pins');
  const nativeRevision = (p: typeof old) => ({
    name: `${WEB_SERVICE}/revisions/${p.revision}`,
    uid: `uid-${p.revision}`,
    serviceAccount: 'runtime@bmson-assistant.iam.gserviceaccount.com',
    timeout: '300s',
    containers: [
      {
        image: p.image,
        env: [
          { name: 'ASSISTANT_RELEASE_WRITES_PAUSED', value: 'false' },
          { name: 'PRIVATE', value: secret },
        ],
      },
    ],
  });
  const native = {
    [old.revision]: nativeRevision(old),
    [current.revision]: nativeRevision(current),
  };
  const row = (p: typeof old, percent?: number) => ({
    type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
    revision: p.revision,
    tag: p.tag,
    ...(percent === undefined ? {} : { percent }),
  });
  const uri = (p: typeof old) => `https://${p.tag}---assistant-web-3gimfiaifa-uw.a.run.app`;
  const before = {
    name: WEB_SERVICE,
    uid: 'same-service-uid',
    etag: 'before-etag',
    generation: '7',
    observedGeneration: '7',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    uri: 'https://assistant-web-3gimfiaifa-uw.a.run.app',
    urls: ['https://assistant-web-3gimfiaifa-uw.a.run.app'],
    template: {
      serviceAccount: native[current.revision]?.serviceAccount,
      containers: [{ image: current.image, env: [{ name: 'PRIVATE', value: secret }] }],
    },
    labels: { scope: 'unchanged' },
    latestReadyRevision: current.revision,
    latestCreatedRevision: current.revision,
    traffic: [
      { type: row(current).type, revision: current.revision, percent: 100 },
      row(current),
      row(old),
    ],
    trafficStatuses: [
      { ...row(current, 100), uri: uri(current) },
      { ...row(old), uri: uri(old) },
    ],
  };

  return { native, before };
}
function fixture(
  options: {
    partial?: boolean;
    path?: string;
    foreignRedirect?: boolean;
    otherJob?: boolean;
    head?: boolean;
    throwAt?: number;
  } = {},
) {
  const env = envFixture(),
    c = { source, runId: '700001', checkRunId: '8001', jobId: '9001' };
  const claims = {
    repository: 'bmson/assistant',
    repository_id: '1304152266',
    repository_owner_id: '890821',
    ref: 'refs/heads/main',
    environment: 'production',
    workflow_ref: env.GITHUB_WORKFLOW_REF,
    workflow_sha: source,
    sha: source,
    run_id: c.runId,
    run_attempt: '1',
    check_run_id: c.checkRunId,
    event_name: 'workflow_dispatch',
  };
  const run = {
    id: Number(c.runId),
    run_attempt: 1,
    head_sha: source,
    path: '.github/workflows/deploy.yml',
    status: 'in_progress',
    repository: { id: 1304152266 },
    head_repository: { id: 1304152266 },
  };
  const job = {
    id: Number(c.jobId),
    run_id: Number(c.runId),
    head_sha: source,
    status: 'in_progress',
    url: `https://api.github.com/repos/bmson/assistant/actions/jobs/${c.jobId}`,
    check_run_url: `https://api.github.com/repos/bmson/assistant/check-runs/${c.checkRunId}`,
  };
  const native = nativeFixture();
  if (options.head)
    Object.assign(native.before, {
      annotations: { 'assistant.release/journal-v1': 'PRIVATE_JOURNAL' },
    });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const json = (v: unknown) =>
    new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  const request: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (calls.length === options.throwAt) throw new Error('PRIVATE_WIRE_ERROR');
    const u = new URL(url);
    if (u.hostname === 'fixed.actions.githubusercontent.com')
      return json({ value: jwt({ ...claims, aud: u.searchParams.get('audience') }) });
    if (u.pathname.endsWith('openid-configuration'))
      return json({
        issuer: 'https://token.actions.githubusercontent.com',
        jwks_uri: 'https://token.actions.githubusercontent.com/.well-known/jwks',
      });
    if (u.pathname.endsWith('/jwks')) return json({ keys: [pub] });
    if (u.hostname === 'api.github.com') {
      if (u.pathname.endsWith(`/runs/${c.runId}`)) return json(run);
      if (u.pathname.endsWith('/jobs'))
        return json({
          total_count: options.otherJob ? 2 : 1,
          jobs: options.otherJob ? [job, { id: 999, status: 'in_progress' }] : [job],
        });
      if (u.pathname.endsWith(`/runs/${PIN.runId}/attempts/1`))
        return json({ ...run, id: PIN.runId, head_sha: PIN.source, status: 'completed' });
      if (u.pathname.endsWith(`/artifacts/${PIN.id}`))
        return json({
          id: PIN.id,
          name: PIN.name,
          expired: false,
          size_in_bytes: PIN.bytes,
          digest: `sha256:${PIN.archiveSha256}`,
          workflow_run: { id: PIN.runId, head_sha: PIN.source },
        });
      if (u.pathname.endsWith('/zip'))
        return new Response(null, {
          status: 302,
          headers: {
            location: options.foreignRedirect
              ? 'https://evil.invalid/PRIVATE'
              : 'https://productionresultssa0.blob.core.windows.net/offline?sig=PRIVATE',
          },
        });
      if (u.pathname.endsWith('/runs'))
        return json({
          total_count: options.partial ? 101 : options.path ? 1 : 0,
          workflow_runs: options.path
            ? [
                {
                  id: 700002,
                  path: options.path,
                  head_sha: source,
                  status: u.searchParams.get('status'),
                },
              ]
            : [],
        });
    }
    if (u.hostname.endsWith('.blob.core.windows.net'))
      return new Response('synthetic archive; mocked verifier');
    if (u.hostname === 'sts.googleapis.com')
      return json({
        access_token: 'PRIVATEFEDERATED',
        token_type: 'Bearer',
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        expires_in: 600,
      });
    if (u.hostname === 'iamcredentials.googleapis.com')
      return json({
        accessToken: 'PRIVATENATIVE',
        expireTime: new Date(now + 600000).toISOString(),
      });
    if (u.hostname === 'run.googleapis.com')
      return json(
        u.pathname === `/v2/${WEB_SERVICE}`
          ? native.before
          : native.native[u.pathname.split('/').at(-1) as keyof typeof native.native],
      );
    throw new Error('Unexpected private request');
  };
  return {
    calls,
    run: () =>
      qualifyNativeWebReadOnly(env, {
        request,
        head: () => source,
        now: () => now,
        monotonic: () => 0,
      }),
  };
}
describe('offline complete probe wiring with only manifest verification mocked', () => {
  it('uses exactly twenty shared requests, three native GETs, and always holds runtime', async () => {
    const f = fixture(),
      report = await f.run();
    expect(report).toMatchObject({
      status: 'HOLD',
      reason: 'quiescence',
      mutationAuthorized: false,
      runtimeEligible: false,
      coldContinuationAuthorized: false,
      budget: { requests: 20, nativeGets: 3 },
      checks: {
        native: { knownMismatch: true, desiredRows: 3, observedRows: 2 },
        manifestAccess: { fixtureOnly: true },
      },
    });
    expect(verifyQualificationManifest).toHaveBeenCalled();
    expect(f.calls).toHaveLength(20);
    for (const call of f.calls) {
      const u = new URL(call.url);
      if (call.init.method === 'POST')
        expect(['sts.googleapis.com', 'iamcredentials.googleapis.com']).toContain(u.hostname);
      else expect(call.init.method).toBe('GET');
      expect(call.init.redirect).toBe(u.pathname.endsWith('/zip') ? 'manual' : 'error');
      const auth = new Headers(call.init.headers).get('authorization');
      if (
        u.hostname.endsWith('.blob.core.windows.net') ||
        u.hostname === 'token.actions.githubusercontent.com'
      )
        expect(auth).toBeNull();
      if (u.hostname === 'api.github.com') expect(auth).toBe('Bearer PRIVATE_GITHUB_TOKEN');
      if (u.hostname === 'run.googleapis.com') expect(auth).toBe('Bearer PRIVATENATIVE');
    }
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
    expect(JSON.stringify(report)).not.toContain('cloud-platform');
  });
  it.each([
    { partial: true },
    { path: '.github/workflows/deploy.yml' },
    { path: '.github/workflows/unknown.yml' },
    { foreignRedirect: true },
    { otherJob: true },
  ])(
    'stops unknown, partial or competing observations before cloud tokens: %j',
    async (options) => {
      const f = fixture(options),
        report = await f.run();
      expect(report.status).toBe('HOLD');
      expect(report.checks.stopped).toBe(true);
      expect(f.calls.some((c) => new URL(c.url).hostname === 'sts.googleapis.com')).toBe(false);
      expect(report.budget?.nativeGets).toBe(0);
      expect(JSON.stringify(report)).not.toContain('PRIVATE');
    },
  );
  it('refuses an existing journal head before reading revisions', async () => {
    const f = fixture({ head: true }),
      report = await f.run();
    expect(report.reason).toBe('native');
    expect(report.checks.stopped).toBe(true);
    expect(report.budget?.nativeGets).toBe(1);
  });
  it.each(Array.from({ length: 20 }, (_, i) => i + 1))(
    'stops at request %i with no retry, fallback, or write',
    async (throwAt) => {
      const f = fixture({ throwAt }),
        report = await f.run();
      expect(f.calls).toHaveLength(throwAt);
      expect(report).toMatchObject({
        status: 'HOLD',
        mutationAuthorized: false,
        runtimeEligible: false,
      });
      expect(report.checks.stopped).toBe(true);
      expect(JSON.stringify(report)).not.toContain('PRIVATE');
    },
  );
});
