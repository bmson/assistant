import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  config: {
    GCP_PROJECT: 'fixture-project',
    MOBILE_API_TOKEN_SECRET_NAME: 'fixture-mobile-token',
    MOBILE_API_TOKEN: 'startup-token',
    OWNER_AUTH_MODE: 'google',
    PERSISTENCE_DRIVER: 'firestore',
    FIRESTORE_AGENT_ID: '11111111-1111-4111-8111-111111111111',
    AUTH_URL: 'https://assistant.example.com',
    PUBLIC_URL: 'https://assistant.example.com',
  },
  cookie: vi.fn(),
  device: vi.fn(),
  deviceIdentity: vi.fn(),
  postgresOwner: vi.fn(),
  database: vi.fn(),
  validatePersistence: vi.fn(),
}));
vi.mock('@assistant/config', () => ({
  loadConfig: () => authState.config,
  validateAgentPersistenceConfig: authState.validatePersistence,
}));
vi.mock('./auth', () => ({ isAuthed: authState.cookie }));
vi.mock('./lib/owner-auth/runtime', () => ({
  verifyOwnerDeviceToken: authState.device,
  ownerAuthService: () => ({ verifyDeviceToken: authState.deviceIdentity }),
}));
vi.mock('./lib/server', () => ({
  getDb: authState.database,
  assertPostgresInstallationOwner: authState.postgresOwner,
}));

import { clearMobileAccessTokenCache } from './lib/mobile-access-token';
import {
  authenticateMobileBearer,
  authenticateMobileOwner,
  isMobileAuthed,
  mobileJson,
  resolveMobileOwner,
} from './mobile-auth';
import { secureTokenMatches } from './mobile-token';

beforeEach(() => {
  clearMobileAccessTokenCache();
  authState.cookie.mockReset().mockResolvedValue(false);
  authState.device.mockReset().mockResolvedValue(false);
  authState.deviceIdentity.mockReset().mockResolvedValue(null);
  authState.postgresOwner.mockReset().mockResolvedValue('postgres-owner');
  authState.database.mockReset().mockReturnValue({ kind: 'fixture-db' });
  authState.validatePersistence.mockReset().mockReturnValue([]);
  authState.config.OWNER_AUTH_MODE = 'google';
  authState.config.MOBILE_API_TOKEN = 'startup-token';
  authState.config.PERSISTENCE_DRIVER = 'firestore';
  authState.config.FIRESTORE_AGENT_ID = '11111111-1111-4111-8111-111111111111';
});
afterEach(() => {
  clearMobileAccessTokenCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('mobile bearer authentication', () => {
  it('accepts only the complete configured token', () => {
    const token = 'd8d42649c69262c8d50f937066c66bc64c12e12d8ff0c2e2b16ef8ea275891ef';
    expect(secureTokenMatches(token, token)).toBe(true);
    expect(secureTokenMatches(token, `${token}0`)).toBe(false);
    expect(secureTokenMatches(token, token.slice(0, -1))).toBe(false);
  });

  it('never treats an empty token as a credential', () => {
    expect(secureTokenMatches('', '')).toBe(false);
    expect(secureTokenMatches('configured', '')).toBe(false);
  });

  it('bounds sequential and concurrent invalid bearer refreshes and recognizes rotation after 30 seconds', async () => {
    vi.stubEnv('K_SERVICE', 'fixture-web');
    vi.useFakeTimers();
    let token = 'old-token';
    const fetcher = vi.fn(async (url: string) =>
      url.includes('metadata.google.internal')
        ? Response.json({ access_token: 'mock-metadata' })
        : Response.json({ payload: { data: Buffer.from(token).toString('base64') } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const request = (value: string) =>
      new Request('https://assistant.example.com/api/mobile/v1/activity', {
        method: 'POST',
        headers: { authorization: `Bearer ${value}` },
      });
    for (let i = 0; i < 50; i++) expect(await isMobileAuthed(request(`invalid-${i}`))).toBe(false);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => isMobileAuthed(request(`overlap-${i}`))),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await isMobileAuthed(request('old-token'))).toBe(true);
    expect(await authenticateMobileBearer(request('old-token'))).toEqual({
      kind: 'configured_installation_bearer',
    });
    token = 'new-token';
    expect(await isMobileAuthed(request(token))).toBe(false);
    expect(await authenticateMobileBearer(request(token))).toBeNull();
    vi.advanceTimersByTime(30_001);
    expect(await isMobileAuthed(request(token))).toBe(true);
    expect(await authenticateMobileBearer(request(token))).toEqual({
      kind: 'configured_installation_bearer',
    });
    expect(await isMobileAuthed(request('old-token'))).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('fails closed and bounds read attempts during secret-service outage', async () => {
    vi.stubEnv('K_SERVICE', 'fixture-web');
    const fetcher = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 10; i++)
      expect(
        await isMobileAuthed(
          new Request('https://assistant.example.com/api/mobile/v1/activity', {
            headers: { authorization: 'Bearer startup-token' },
          }),
        ),
      ).toBe(false);
    expect(
      await authenticateMobileBearer(
        new Request('https://assistant.example.com/api/mobile/v1/activity', {
          headers: { authorization: 'Bearer startup-token' },
        }),
      ),
    ).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it.each(['https://sibling.example.com', 'https://other.test', 'null', null])(
    'rejects cookie writes from %s before owner-session lookup',
    async (origin) => {
      vi.stubEnv('K_SERVICE', '');
      authState.cookie.mockResolvedValue(true);
      const headers = new Headers({
        'content-type': 'text/plain',
        authorization: 'Bearer invalid',
      });
      if (origin !== null) headers.set('origin', origin);
      expect(
        await isMobileAuthed(
          new Request('https://assistant.example.com/api/mobile/v1/memory/profile', {
            method: 'POST',
            headers,
            body: '{"action":"erase"}',
          }),
        ),
      ).toBe(false);
      expect(authState.cookie).not.toHaveBeenCalled();
    },
  );

  it('preserves exact-origin cookie writes, safe cookie reads, and originless authenticated device writes', async () => {
    vi.stubEnv('K_SERVICE', '');
    authState.cookie.mockResolvedValue(true);
    expect(
      await isMobileAuthed(
        new Request('https://assistant.example.com/api/mobile', {
          method: 'POST',
          headers: { origin: 'https://assistant.example.com' },
        }),
      ),
    ).toBe(true);
    expect(await isMobileAuthed(new Request('https://assistant.example.com/api/mobile'))).toBe(
      true,
    );
    expect(
      await isMobileAuthed(
        new Request('https://assistant.example.com/api/mobile', {
          method: 'DELETE',
          headers: { authorization: 'Bearer startup-token' },
        }),
      ),
    ).toBe(true);
    authState.config.OWNER_AUTH_MODE = 'passkey';
    authState.device.mockResolvedValue(true);
    expect(
      await isMobileAuthed(
        new Request('https://assistant.example.com/api/mobile', {
          method: 'POST',
          headers: { authorization: 'Bearer asd1_fixture' },
        }),
      ),
    ).toBe(true);
  });
});

describe('typed bearer authentication and owner resolution', () => {
  const request = (authorization?: string, body?: string) =>
    new Request('https://assistant.example.com/api/mobile/v1/owner-editor', {
      method: 'POST',
      ...(authorization ? { headers: { authorization, 'content-type': 'application/json' } } : {}),
      ...(body ? { body } : {}),
    });

  it('accepts the configured installation bearer without inventing a user or scope', async () => {
    expect(await authenticateMobileBearer(request('Bearer startup-token'))).toEqual({
      kind: 'configured_installation_bearer',
    });
  });

  it('freshly resolves a device ID on every typed check while legacy auth keeps its Boolean path', async () => {
    authState.config.OWNER_AUTH_MODE = 'passkey';
    authState.device.mockResolvedValue(true);
    authState.deviceIdentity.mockResolvedValueOnce('device-123').mockResolvedValueOnce(null);
    const deviceRequest = request('Bearer asd1_fixture');

    expect(await isMobileAuthed(deviceRequest)).toBe(true);
    expect(await authenticateMobileBearer(deviceRequest)).toEqual({
      kind: 'owner_device_bearer',
      deviceId: 'device-123',
    });
    expect(await authenticateMobileBearer(deviceRequest)).toBeNull();
    expect(authState.deviceIdentity).toHaveBeenCalledTimes(2);
    expect(authState.device).toHaveBeenCalledTimes(1);
  });

  it('reserves asd1_ tokens for passkey device verification with no configured-token fallback', async () => {
    authState.config.MOBILE_API_TOKEN = 'asd1_fixture';
    expect(await authenticateMobileBearer(request('Bearer asd1_fixture'))).toBeNull();
    expect(authState.deviceIdentity).not.toHaveBeenCalled();

    authState.config.OWNER_AUTH_MODE = 'passkey';
    expect(await authenticateMobileBearer(request('Bearer asd1_fixture'))).toBeNull();
    expect(authState.deviceIdentity).toHaveBeenCalledTimes(1);
  });

  it('rejects cookie-only and invalid-bearer-plus-cookie requests without calling Auth.js', async () => {
    authState.cookie.mockResolvedValue(true);
    const cookieOnly = new Request('https://assistant.example.com/api/mobile/v1/owner-editor', {
      method: 'POST',
      headers: { origin: 'https://assistant.example.com' },
    });
    const invalidBearerAndCookie = new Request(
      'https://assistant.example.com/api/mobile/v1/owner-editor',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer invalid',
          origin: 'https://assistant.example.com',
        },
      },
    );

    expect(await authenticateMobileBearer(cookieOnly)).toBeNull();
    expect(await authenticateMobileBearer(invalidBearerAndCookie)).toBeNull();
    expect(await authenticateMobileOwner(invalidBearerAndCookie)).toBeNull();
    expect(authState.cookie).not.toHaveBeenCalled();
    expect(authState.validatePersistence).not.toHaveBeenCalled();
    expect(authState.database).not.toHaveBeenCalled();
  });

  it('resolves Firestore owner from validated server config and ignores a request owner field', async () => {
    const resolved = await authenticateMobileOwner(
      request('Bearer startup-token', JSON.stringify({ ownerId: 'attacker-owner' })),
    );
    expect(resolved).toEqual({
      principal: { kind: 'configured_installation_bearer' },
      ownerId: '11111111-1111-4111-8111-111111111111',
    });
    expect(authState.validatePersistence).toHaveBeenCalledWith(authState.config);
  });

  it('resolves Postgres owner only after bearer authentication', async () => {
    authState.config.PERSISTENCE_DRIVER = 'postgres';
    const resolved = await authenticateMobileOwner(request('Bearer startup-token'));
    expect(resolved).toEqual({
      principal: { kind: 'configured_installation_bearer' },
      ownerId: 'postgres-owner',
    });
    expect(authState.database).toHaveBeenCalledTimes(1);
    expect(authState.postgresOwner).toHaveBeenCalledWith({ kind: 'fixture-db' });
  });

  it('distinguishes owner-resolution unavailability from invalid bearer while preserving the wrapper', async () => {
    const principal = { kind: 'configured_installation_bearer' } as const;
    authState.config.PERSISTENCE_DRIVER = 'postgres';
    authState.postgresOwner.mockRejectedValue(new Error('private database diagnostic'));

    expect(await resolveMobileOwner(principal)).toEqual({ ok: false, reason: 'unavailable' });
    expect(await authenticateMobileOwner(request('Bearer startup-token'))).toBeNull();
    expect(await authenticateMobileBearer(request('Bearer invalid'))).toBeNull();
    expect(authState.postgresOwner).toHaveBeenCalledTimes(2);
  });

  it('fails closed for invalid Firestore configuration and owner-resolution errors', async () => {
    authState.validatePersistence.mockReturnValue(['missing installation owner']);
    expect(await authenticateMobileOwner(request('Bearer startup-token'))).toBeNull();

    authState.config.PERSISTENCE_DRIVER = 'postgres';
    authState.postgresOwner.mockRejectedValue(new Error('ambiguous owner'));
    expect(await authenticateMobileOwner(request('Bearer startup-token'))).toBeNull();
  });
});

describe('mobile JSON error boundary', () => {
  it('hides Firestore project and index diagnostics from server-error responses', async () => {
    const response = mobileJson(
      {
        error:
          '9 FAILED_PRECONDITION: The query requires an index. Create it: https://console.firebase.google.com/v1/r/project/private-project/firestore/indexes?create_composite=secret',
        outcome: 'unconfirmed',
        retryable: false,
        stack: 'FirestoreError: private stack at read (/srv/app.js:10:2)',
      },
      { status: 503 },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({
      error: 'The request could not be completed. Check its status before trying again.',
      outcome: 'unconfirmed',
      retryable: false,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /private-project|create_composite|FAILED_PRECONDITION|srv\/app/,
    );
  });

  it('preserves actionable validation errors but sanitizes provider diagnostics even on a 4xx', async () => {
    const validation = mobileJson(
      { error: 'Document page size must be between 1 and 100' },
      { status: 400 },
    );
    expect(validation.status).toBe(400);
    expect(await validation.json()).toEqual({
      error: 'Document page size must be between 1 and 100',
    });

    const selection = mobileJson(
      { error: 'Select a document before continuing.' },
      { status: 400 },
    );
    expect(await selection.json()).toEqual({ error: 'Select a document before continuing.' });

    const diagnostic = mobileJson(
      { error: 'SQLSTATE 42P01: relation private_table does not exist' },
      { status: 409 },
    );
    expect(diagnostic.status).toBe(409);
    expect(await diagnostic.json()).toEqual({
      error: 'The request could not be completed. Check its status before trying again.',
    });

    const drizzleDiagnostic = mobileJson(
      {
        error: 'Failed query: select "id" from "goals" where "id" = $1 params: ["private-goal-id"]',
      },
      { status: 409 },
    );
    expect(drizzleDiagnostic.status).toBe(409);
    const drizzleBody = await drizzleDiagnostic.json();
    expect(drizzleBody).toEqual({
      error: 'The request could not be completed. Check its status before trying again.',
    });
    expect(JSON.stringify(drizzleBody)).not.toMatch(/private-goal-id|select|params/i);
  });

  it('leaves normal structured success payloads unchanged', async () => {
    const payload = {
      ok: true,
      result: {
        status: 'needs_attention',
        noticeId: 'notice-1',
        createdAt: new Date('2026-10-13T12:00:00.000Z'),
      },
    };
    const response = mobileJson(payload, { status: 200 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      result: {
        status: 'needs_attention',
        noticeId: 'notice-1',
        createdAt: '2026-10-13T12:00:00.000Z',
      },
    });

    const diagnosticWordsInSuccess = {
      ok: true,
      message: 'Firestore index review includes the SELECT action requested by the owner.',
      details: 'These are safe product-facing details, not an error.',
    };
    expect(await mobileJson(diagnosticWordsInSuccess).json()).toEqual(diagnosticWordsInSuccess);
  });
});
