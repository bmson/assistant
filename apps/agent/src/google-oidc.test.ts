import { generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  oidcAudienceForPath,
  verifyGoogleServiceAccountToken,
  verifyInternalAuthorization,
} from './google-oidc.js';

const audience = 'https://agent.example.test';
const serviceAccount = 'assistant-invoker@example.iam.gserviceaccount.com';

async function signedToken(overrides: Record<string, unknown> = {}, tokenAudience = audience) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const token = await new SignJWT({
    email: serviceAccount,
    email_verified: true,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://accounts.google.com')
    .setAudience(tokenAudience)
    .setSubject('123456789')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { token, publicKey };
}

describe('Google OIDC authorization', () => {
  it('binds an internal token audience to one route', () => {
    expect(oidcAudienceForPath(audience, '/internal/sweep')).toBe(
      'https://agent.example.test/internal/sweep',
    );
    expect(oidcAudienceForPath('', '/internal/sweep')).toBe('');
  });

  it('accepts the expected audience and verified service-account email', async () => {
    const { token, publicKey } = await signedToken();
    expect(
      await verifyGoogleServiceAccountToken(`Bearer ${token}`, {
        audience,
        serviceAccount,
        jwks: async () => publicKey,
      }),
    ).toBe(true);
  });

  it('keeps private callbacks route-bound even when IAM accepts both custom audiences', async () => {
    const executeAudience = oidcAudienceForPath(audience, '/internal/tasks/execute');
    const sweepAudience = oidcAudienceForPath(audience, '/internal/sweep');
    const { token, publicKey } = await signedToken({}, executeAudience);
    const config = {
      INTERNAL_AUTH_MODE: 'oidc',
      INTERNAL_API_SECRET: '',
      INTERNAL_OIDC_AUDIENCE: executeAudience,
      INTERNAL_OIDC_SERVICE_ACCOUNT: serviceAccount,
      QUEUE_DRIVER: 'cloudtasks',
    } as const;
    const jwks = async () => publicKey;
    expect(await verifyInternalAuthorization(`Bearer ${token}`, config, jwks)).toBe(true);
    for (const wrongAudience of [sweepAudience, audience, `${audience}/internal/other`]) {
      expect(
        await verifyInternalAuthorization(
          `Bearer ${token}`,
          { ...config, INTERNAL_OIDC_AUDIENCE: wrongAudience },
          jwks,
        ),
      ).toBe(false);
    }
    expect(
      await verifyInternalAuthorization(
        `Bearer ${token}`,
        { ...config, INTERNAL_OIDC_SERVICE_ACCOUNT: 'other@example.iam.gserviceaccount.com' },
        jwks,
      ),
    ).toBe(false);
    // Platform-transformed or unsigned payloads never become application proof.
    expect(
      await verifyInternalAuthorization(
        `Bearer ${token.split('.').slice(0, 2).join('.')}.`,
        config,
        jwks,
      ),
    ).toBe(false);
  });

  it('rejects a token for a different service account or audience', async () => {
    const { token, publicKey } = await signedToken();
    const jwks = async () => publicKey;
    expect(
      await verifyGoogleServiceAccountToken(`Bearer ${token}`, {
        audience,
        serviceAccount: 'attacker@example.iam.gserviceaccount.com',
        jwks,
      }),
    ).toBe(false);
    expect(
      await verifyGoogleServiceAccountToken(`Bearer ${token}`, {
        audience: 'https://other.example.test',
        serviceAccount,
        jwks,
      }),
    ).toBe(false);
  });

  it('rejects an unverified email claim', async () => {
    const { token, publicKey } = await signedToken({ email_verified: false });
    expect(
      await verifyGoogleServiceAccountToken(`Bearer ${token}`, {
        audience,
        serviceAccount,
        jwks: async () => publicKey,
      }),
    ).toBe(false);
  });

  it('allows shared-secret auth only when explicitly configured', async () => {
    const base = {
      INTERNAL_API_SECRET: 'local-test-secret',
      INTERNAL_OIDC_AUDIENCE: '',
      INTERNAL_OIDC_SERVICE_ACCOUNT: '',
      QUEUE_DRIVER: 'local',
    } as const;

    expect(
      await verifyInternalAuthorization(`Bearer ${base.INTERNAL_API_SECRET}`, {
        ...base,
        INTERNAL_AUTH_MODE: 'shared-secret',
      }),
    ).toBe(true);
    expect(
      await verifyInternalAuthorization(`Bearer ${base.INTERNAL_API_SECRET}`, {
        ...base,
        INTERNAL_AUTH_MODE: 'oidc',
      }),
    ).toBe(false);
    expect(
      await verifyInternalAuthorization(
        `Bearer ${base.INTERNAL_API_SECRET}`,
        { ...base, INTERNAL_AUTH_MODE: 'shared-secret' },
        undefined,
        'production',
      ),
    ).toBe(false);
    // A cloudtasks-shaped installation is internet-facing: refuse the shared
    // secret even when NODE_ENV never got set.
    expect(
      await verifyInternalAuthorization(`Bearer ${base.INTERNAL_API_SECRET}`, {
        ...base,
        INTERNAL_AUTH_MODE: 'shared-secret',
        QUEUE_DRIVER: 'cloudtasks',
      }),
    ).toBe(false);
  });
});
