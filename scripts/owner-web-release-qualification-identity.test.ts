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
