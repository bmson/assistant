import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyNativeQualificationJwt } from '../apps/agent/scripts/verify-native-web-qualification-jwt.js';
import {
  qualificationContext,
  qualifyNativeWebReadOnly,
} from './owner-web-release-qualification.js';

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
describe('offline actual local-key JWT verification', () => {
  it('verifies a synthetic RSA signature without network', async () => {
    expect(
      await verifyNativeQualificationJwt(jwt(), { keys: [pub] }, 'assistant-web-journal-v1', now),
    ).toMatchObject({ aud: 'assistant-web-journal-v1' });
  });
  it.each([
    { aud: 'other' },
    { iss: 'https://evil.invalid' },
    { exp: now / 1000 },
    { nbf: now / 1000 + 1 },
    { iat: now / 1000 + 1 },
    { exp: now / 1000 + 601 },
    { exp: undefined },
  ])('rejects signed invalid claims %j', async (claims) => {
    await expect(
      verifyNativeQualificationJwt(jwt(claims), { keys: [pub] }, 'assistant-web-journal-v1', now),
    ).rejects.toThrow('Qualification identity held');
  });
  it('rejects tampering and private/duplicate/unbounded keys', async () => {
    const token = jwt();
    for (const jwks of [
      { keys: [{ ...pub, d: 'PRIVATE' }] },
      { keys: [pub, pub] },
      { keys: [] },
      { keys: [{ ...pub, kid: 'x'.repeat(129) }] },
    ])
      await expect(
        verifyNativeQualificationJwt(token, jwks, 'assistant-web-journal-v1', now),
      ).rejects.toThrow('Qualification identity held');
    await expect(
      verifyNativeQualificationJwt(
        `${token.slice(0, -8)}AAAAAAAA`,
        { keys: [pub] },
        'assistant-web-journal-v1',
        now,
      ),
    ).rejects.toThrow('Qualification identity held');
  });
});
describe('offline fixed hosted qualification context', () => {
  it('pins source, runner, audiences and project', () => {
    expect(qualificationContext(envFixture(), source)).toMatchObject({ source, runId: '700001' });
  });
  it.each([
    ['GITHUB_REF', 'refs/heads/other'],
    ['GITHUB_RUN_ATTEMPT', '2'],
    ['GITHUB_EVENT_NAME', 'push'],
    ['GITHUB_WORKFLOW_SHA', 'b'.repeat(40)],
    ['OWNER_NATIVE_WEB_QUALIFICATION', 'off'],
    ['RUNNER_ENVIRONMENT', 'self-hosted'],
    ['RUNNER_TEMP', '/tmp'],
    ['GCP_PROJECT', 'other'],
    ['GCP_REGION', 'us-east1'],
    ['QUALIFICATION_REQUESTED_SHA', 'b'.repeat(40)],
    ['QUALIFICATION_BREAK_GLASS', 'true'],
    ['ACTIONS_ID_TOKEN_REQUEST_URL', 'https://evil.invalid/token'],
  ])('refuses %s before token or provider calls', async (key, value) => {
    const request = vi.fn<typeof fetch>();
    const env = { ...envFixture(), [key]: value };
    const report = await qualifyNativeWebReadOnly(env, {
      request,
      head: () => source,
      now: () => now,
      monotonic: () => 0,
    });
    expect(report).toMatchObject({
      status: 'HOLD',
      reason: 'context',
      mutationAuthorized: false,
      runtimeEligible: false,
      coldContinuationAuthorized: false,
    });
    expect(request).not.toHaveBeenCalled();
  });
  it('redacts issuer errors and has no fallback or retry', async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error('PRIVATE_TOKEN https://PRIVATE.invalid');
    });
    const report = await qualifyNativeWebReadOnly(envFixture(), {
      request,
      head: () => source,
      now: () => now,
      monotonic: () => 0,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
    expect(report.status).toBe('HOLD');
  });
});

describe('offline bounded first-failure context diagnostics', () => {
  const mutations: Array<[string, string | undefined, string]> = [
    ['GITHUB_ACTIONS', undefined, 'ctx_actions'],
    ['GITHUB_REPOSITORY', 'other/PRIVATE', 'ctx_repository'],
    ['GITHUB_REF', 'refs/heads/PRIVATE', 'ctx_ref'],
    ['GITHUB_EVENT_NAME', 'push', 'ctx_event'],
    ['GITHUB_RUN_ATTEMPT', '2', 'ctx_attempt'],
    ['GITHUB_WORKFLOW_REF', 'PRIVATE', 'ctx_workflow_ref'],
    ['GITHUB_WORKFLOW_SHA', 'b'.repeat(40), 'ctx_workflow_sha'],
    ['OWNER_NATIVE_WEB_QUALIFICATION', 'PRIVATE', 'ctx_selector'],
    ['RUNNER_ENVIRONMENT', 'self-hosted', 'ctx_runner_environment'],
    ['RUNNER_OS', 'Windows', 'ctx_runner_os'],
    ['RUNNER_ARCH', 'ARM64', 'ctx_runner_arch'],
    ['RUNNER_TEMP', '/tmp/PRIVATE', 'ctx_runner_temp'],
    ['QUALIFICATION_REQUESTED_SHA', 'b'.repeat(40), 'ctx_requested_sha'],
    ['QUALIFICATION_BREAK_GLASS', 'true', 'ctx_break_glass'],
    ['GCP_PROJECT', 'PRIVATE', 'ctx_project'],
    ['GCP_REGION', 'PRIVATE', 'ctx_region'],
    ['ARTIFACT_REPOSITORY', 'PRIVATE', 'ctx_artifact_repository'],
    ['GITHUB_RUN_ID', '0', 'ctx_run_id'],
    ['GCP_WORKLOAD_IDENTITY_PROVIDER', 'PRIVATE', 'ctx_provider'],
    ['GCP_DEPLOY_SERVICE_ACCOUNT', 'PRIVATE@foreign.invalid', 'ctx_principal'],
    ['ACTIONS_ID_TOKEN_REQUEST_URL', undefined, 'ctx_oidc_url_shape'],
    ['ACTIONS_ID_TOKEN_REQUEST_URL', 'http://PRIVATE.invalid/', 'ctx_oidc_url_shape'],
    ['ACTIONS_ID_TOKEN_REQUEST_URL', 'https://%PRIVATE', 'ctx_oidc_url_parse'],
    ['ACTIONS_ID_TOKEN_REQUEST_URL', 'https://PRIVATE.invalid/token', 'ctx_oidc_host'],
    [
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'https://user:PRIVATE@fixed.actions.githubusercontent.com/token',
      'ctx_oidc_userinfo',
    ],
    [
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'https://fixed.actions.githubusercontent.com:444/token?PRIVATE',
      'ctx_oidc_port',
    ],
    [
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'https://fixed.actions.githubusercontent.com/token#PRIVATE',
      'ctx_oidc_fragment',
    ],
    ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'PRIVATE/token', 'ctx_oidc_request_token_shape'],
    ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', undefined, 'ctx_oidc_request_token_shape'],
    ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'x'.repeat(16385), 'ctx_oidc_request_token_shape'],
    ['GH_TOKEN', 'PRIVATE.token', 'ctx_github_token_shape'],
    ['GH_TOKEN', undefined, 'ctx_github_token_shape'],
    ['GH_TOKEN', 'x'.repeat(4097), 'ctx_github_token_shape'],
  ];
  it.each(mutations)('reports only a fixed code for %s', async (key, value, code) => {
    const request = vi.fn<typeof fetch>();
    const report = await qualifyNativeWebReadOnly(
      { ...envFixture(), [key]: value },
      {
        request,
        head: () => source,
        now: () => now,
        monotonic: () => 0,
      },
    );
    expect(report).toEqual({
      format: 1,
      status: 'HOLD',
      mutationAuthorized: false,
      runtimeEligible: false,
      coldContinuationAuthorized: false,
      checks: { stopped: true },
      reason: 'context',
      contextCode: code,
    });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|https?:|githubusercontent|16385|4097/);
    expect(request).not.toHaveBeenCalled();
    expect(report).not.toHaveProperty('budget');
    expect(report).not.toHaveProperty('verifiedOrigin');
  });
  it('distinguishes malformed source from a changed checkout, without source disclosure', async () => {
    const request = vi.fn<typeof fetch>();
    const malformed = { ...envFixture(), GITHUB_SHA: 'PRIVATE', GITHUB_WORKFLOW_SHA: 'PRIVATE' };
    const a = await qualifyNativeWebReadOnly(malformed, {
      request,
      head: () => source,
      now: () => now,
      monotonic: () => 0,
    });
    const b = await qualifyNativeWebReadOnly(envFixture(), {
      request,
      head: () => 'b'.repeat(40),
      now: () => now,
      monotonic: () => 0,
    });
    expect(a.contextCode).toBe('ctx_source_sha');
    expect(b.contextCode).toBe('ctx_checkout_sha');
    expect(JSON.stringify([a, b])).not.toContain('PRIVATE');
    expect(request).not.toHaveBeenCalled();
  });
  it('classifies failed source lookup without echoing exception messages, fields or URLs', async () => {
    const request = vi.fn<typeof fetch>();
    const failure = Object.assign(new Error('PRIVATE https://PRIVATE.invalid'), {
      code: 'PRIVATE',
      reason: 'PRIVATE',
      input: 'PRIVATE',
    });
    const report = await qualifyNativeWebReadOnly(envFixture(), {
      request,
      head: () => {
        throw failure;
      },
      now: () => now,
      monotonic: () => 0,
    });
    expect(report.contextCode).toBe('ctx_source_lookup');
    expect(report.reason).toBe('context');
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|https?:/);
    expect(request).not.toHaveBeenCalled();
  });
  it('redacts an unexpected context failure instead of copying an arbitrary diagnostic field', async () => {
    const request = vi.fn<typeof fetch>();
    const env = envFixture();
    Object.defineProperty(env, 'RUNNER_OS', {
      get() {
        throw Object.assign(new Error('PRIVATE'), { code: 'ctx_oidc_host PRIVATE' });
      },
    });
    const report = await qualifyNativeWebReadOnly(env, {
      request,
      head: () => source,
      now: () => now,
      monotonic: () => 0,
    });
    expect(report.contextCode).toBe('ctx_unclassified');
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects a tampered context exception code without copying it into the audit', async () => {
    let failure: unknown;
    try {
      qualificationContext({}, source);
    } catch (e) {
      failure = e;
    }
    if (!(failure instanceof Error)) throw new Error('Missing synthetic failure');
    Object.assign(failure, { code: 'https://PRIVATE.invalid/token' });
    const env = envFixture(),
      request = vi.fn<typeof fetch>();
    Object.defineProperty(env, 'RUNNER_OS', {
      get() {
        throw failure;
      },
    });
    const report = await qualifyNativeWebReadOnly(env, {
      request,
      head: () => source,
      now: () => now,
      monotonic: () => 0,
    });
    expect(report.contextCode).toBe('ctx_unclassified');
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|https?:/);
    expect(request).not.toHaveBeenCalled();
  });
  it('reports the first failed predicate without inspecting later opaque values', async () => {
    const request = vi.fn<typeof fetch>();
    const env = { ...envFixture(), GITHUB_REF: 'PRIVATE' };
    const secretGetter = vi.fn(() => {
      throw new Error('PRIVATE');
    });
    Object.defineProperty(env, 'GH_TOKEN', { get: secretGetter });
    const report = await qualifyNativeWebReadOnly(env, {
      request,
      head: () => source,
      now: () => now,
      monotonic: () => 0,
    });
    expect(report.contextCode).toBe('ctx_ref');
    expect(secretGetter).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    'https://fixed.actions.githubusercontent.com.evil.invalid/token',
    'https://fixed.evilgithubusercontent.com/token',
    'https://nested.fixed.actions.githubusercontent.com/token',
    'https://127.0.0.1/token',
  ])('keeps the exact existing host restriction for a foreign endpoint', async (url) => {
    const request = vi.fn<typeof fetch>();
    const report = await qualifyNativeWebReadOnly(
      { ...envFixture(), ACTIONS_ID_TOKEN_REQUEST_URL: url },
      { request, head: () => source, now: () => now, monotonic: () => 0 },
    );
    expect(report.contextCode).toBe('ctx_oidc_host');
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(url);
  });
  it('does not mislabel a later transport failure as a context failure', async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error('PRIVATE');
    });
    const report = await qualifyNativeWebReadOnly(envFixture(), {
      request,
      head: () => source,
      now: () => now,
      monotonic: () => 0,
    });
    expect(report).not.toHaveProperty('contextCode');
    expect(report.reason).toBe('transport');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
