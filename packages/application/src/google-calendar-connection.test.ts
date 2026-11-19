import { randomUUID } from 'node:crypto';
import {
  getGoogleCalendarAccessToken,
  reportGoogleCalendarReadFailure,
} from '@assistant/core/google-calendar-oauth';
import {
  createGoogleCalendarConnectionRepository,
  emptyGoogleCalendarConnection,
  GOOGLE_CALENDAR_READ_SCOPE,
  type GoogleCalendarConnectionState,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { createGoogleCalendarConnectionService } from './google-calendar-connection.js';

const config = {
  clientId: 'client',
  clientSecret: 'client-secret',
  callbackUrl: 'https://example.invalid/api/oauth/google-calendar/callback',
};
const scopes = `openid email ${GOOGLE_CALENDAR_READ_SCOPE}`;
function fixture() {
  let row: GoogleCalendarConnectionState | null = null;
  let clock = new Date('2026-11-14T12:00:00Z');
  const repository = createGoogleCalendarConnectionRepository({
    read: async (ownerId) => (row?.ownerId === ownerId ? structuredClone(row) : null),
    async update(ownerId, change) {
      const next = change(structuredClone(row ?? emptyGoogleCalendarConnection(ownerId)));
      row = next.state;
      return next.result;
    },
  });
  const encrypt = (value: string) => `sealed:${Buffer.from(value).toString('base64url')}`;
  const decrypt = (value: string) => {
    if (!value.startsWith('sealed:')) throw Error('sealed');
    return Buffer.from(value.slice(7), 'base64url').toString();
  };
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).includes('/token')
      ? Response.json({
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: scopes,
          id_token: 'id-token',
        })
      : Response.json({ kind: 'calendar#calendarList' }),
  );
  const verifyIdentity = vi.fn(async () => ({
    sub: 'subject',
    email: 'owner@example.com',
    email_verified: true,
    nonce: row?.flow?.nonce,
  }));
  const ports = { repository, config, encrypt, decrypt, fetcher, verifyIdentity, now: () => clock };
  const service = createGoogleCalendarConnectionService(ports);
  async function begin() {
    const flow = await service.connect('owner');
    return { flow, state: required(new URL(flow.authorizationUrl).searchParams.get('state')) };
  }
  async function connect() {
    const { state } = await begin();
    await service.callback(new URLSearchParams({ state, code: 'code' }));
  }
  const token = (extra: Partial<Parameters<typeof getGoogleCalendarAccessToken>[0]> = {}) =>
    getGoogleCalendarAccessToken({ ...ports, ownerId: 'owner', ...extra });
  return {
    repository,
    service,
    ports,
    begin,
    connect,
    token,
    fetcher,
    verifyIdentity,
    advance: () => {
      clock = new Date(clock.getTime() + 11 * 60_000);
    },
  };
}

describe('personal Calendar OAuth', () => {
  it('stays optional and starts only the readonly identity flow', async () => {
    const f = fixture();
    const disabled = createGoogleCalendarConnectionService({ ...f.ports, config: null });
    expect((await disabled.status('owner')).state).toBe('unconfigured');
    await expect(disabled.connect('owner')).rejects.toThrow('disconnected');
    const { flow } = await f.begin();
    const params = new URL(flow.authorizationUrl).searchParams;
    expect(params.get('scope')).toBe(scopes);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('include_granted_scopes')).toBe('false');
  });
  it('verifies identity and API read before connected; responses contain no credentials', async () => {
    const f = fixture();
    await f.connect();
    const status = await f.service.status('owner');
    expect(status).toMatchObject({
      state: 'connected',
      account: { subject: 'subject' },
      capabilities: { calendarRead: true },
    });
    expect(JSON.stringify(status)).not.toMatch(/secret|sealed|nonce|verifier/);
    const record = await f.repository.get('owner');
    expect(record?.adopted).toBe(true);
    expect(record?.flow?.verifierEncrypted).toBeNull();
    expect(record?.connection?.refreshTokenEncrypted).not.toContain('refresh-secret');
  });
  it('rejects tampered, expired, and replayed state without another exchange', async () => {
    const f = fixture();
    const { state } = await f.begin();
    expect(
      (await f.service.callback(new URLSearchParams({ state: `${state}x`, code: 'code' })))
        .accepted,
    ).toBe(false);
    f.advance();
    expect((await f.service.callback(new URLSearchParams({ state, code: 'code' }))).accepted).toBe(
      false,
    );
    expect(f.fetcher).not.toHaveBeenCalled();
    const next = await f.begin();
    await f.service.callback(new URLSearchParams({ state: next.state, code: 'code' }));
    const calls = f.fetcher.mock.calls.length;
    expect(
      (await f.service.callback(new URLSearchParams({ state: next.state, code: 'code' }))).accepted,
    ).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });
  it.each([
    'denied',
    'cancelled',
    'partial',
    'wrong-identity',
    'wrong-nonce',
    'unverified',
    'probe-failure',
  ])('preserves prior valid grant on %s reconnect', async (scenario) => {
    const f = fixture();
    await f.connect();
    const before = required(await f.repository.get('owner')).connection;
    const { flow, state } = await f.begin();
    if (scenario === 'cancelled') await f.service.flow('owner', flow.flowId, true);
    if (scenario === 'partial')
      f.fetcher.mockResolvedValueOnce(
        Response.json({
          access_token: 'new',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid email',
        }),
      );
    if (scenario === 'wrong-identity')
      f.verifyIdentity.mockImplementationOnce(async () => ({
        sub: 'other',
        email: 'other@example.com',
        email_verified: true,
        nonce: (await f.repository.get('owner'))?.flow?.nonce,
      }));
    if (scenario === 'wrong-nonce')
      f.verifyIdentity.mockResolvedValueOnce({
        sub: 'subject',
        email: 'owner@example.com',
        email_verified: true,
        nonce: 'wrong',
      });
    if (scenario === 'unverified')
      f.verifyIdentity.mockImplementationOnce(async () => ({
        sub: 'subject',
        email: 'owner@example.com',
        email_verified: false,
        nonce: (await f.repository.get('owner'))?.flow?.nonce,
      }));
    if (scenario === 'probe-failure')
      f.fetcher.mockImplementation(async (url) =>
        String(url).includes('/token')
          ? Response.json({
              access_token: 'new',
              refresh_token: 'new-refresh',
              token_type: 'Bearer',
              expires_in: 3600,
              scope: scopes,
              id_token: 'id',
            })
          : new Response('', { status: 503 }),
      );
    await f.service.callback(
      new URLSearchParams({
        state,
        ...(scenario === 'denied' ? { error: 'access_denied' } : { code: 'code' }),
      }),
    );
    expect(required(await f.repository.get('owner')).connection).toEqual(before);
    expect((await f.service.status('owner')).state).toBe('connected');
  });
  it('records verified auth separately from temporary Calendar availability', async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async (url) =>
      String(url).includes('/token')
        ? Response.json({
            access_token: 'a',
            refresh_token: 'r',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: scopes,
            id_token: 'id',
          })
        : new Response('', { status: 503 }),
    );
    await f.connect();
    expect(await f.service.status('owner')).toMatchObject({
      state: 'provider_unavailable',
      account: { subject: 'subject' },
      capabilities: { calendarRead: false },
    });
  });
  it('disconnect retains adoption and prevents an in-flight callback from restoring credentials', async () => {
    const f = fixture();
    await f.connect();
    const { state } = await f.begin();
    f.verifyIdentity.mockImplementationOnce(async () => {
      await f.service.disconnect('owner');
      return {
        sub: 'subject',
        email: 'owner@example.com',
        email_verified: true,
        nonce: (await f.repository.get('owner'))?.flow?.nonce,
      };
    });
    expect((await f.service.callback(new URLSearchParams({ state, code: 'code' }))).accepted).toBe(
      false,
    );
    expect(await f.repository.get('owner')).toMatchObject({ adopted: true, connection: null });
    await expect(f.token()).rejects.toThrow('disconnected');
  });
  it('newer flows fence old callbacks and owner flow lookups', async () => {
    const f = fixture();
    const a = await f.begin();
    const b = await f.begin();
    expect(await f.service.flow('other', b.flow.flowId)).toBeNull();
    expect(
      (await f.service.callback(new URLSearchParams({ state: a.state, code: 'code' }))).accepted,
    ).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('concurrent cached reads do not refresh or change the authorization revision', async () => {
    const f = fixture();
    await f.connect();
    f.fetcher.mockClear();
    const before = await f.repository.get('owner');
    const results = await Promise.all([f.token(), f.token(), f.token()]);
    expect(new Set(results.map((r) => r.connectionId)).size).toBe(1);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await f.repository.get('owner'))?.revision).toBe(before?.revision);
  });
  it('serializes concurrent refresh and preserves refresh token when omitted', async () => {
    const f = fixture();
    await f.connect();
    const before = required(await f.repository.get('owner'));
    f.fetcher.mockClear();
    f.fetcher.mockImplementation(async (url) => {
      if (!String(url).includes('/token')) return Response.json({ kind: 'calendar#calendarList' });
      await new Promise((resolve) => setTimeout(resolve, 15));
      return Response.json({ access_token: 'refreshed', token_type: 'Bearer', expires_in: 3600 });
    });
    const results = await Promise.all([
      f.token({ forceRefresh: true, rejectedAccessToken: 'access-secret' }),
      f.token({ forceRefresh: true, rejectedAccessToken: 'access-secret' }),
    ]);
    expect(results.map((r) => r.accessToken)).toEqual(['refreshed', 'refreshed']);
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes('/token'))).toHaveLength(1);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    const after = required(await f.repository.get('owner'));
    expect(after.connection?.refreshTokenEncrypted).toBe(before.connection?.refreshTokenEncrypted);
    expect(after.revision).toBe(before.revision);
  });
  it('rotation stays encrypted and reads during pending reconnect do not invalidate completion', async () => {
    const f = fixture();
    await f.connect();
    const next = await f.begin();
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );
    await f.token({ forceRefresh: true });
    expect((await f.repository.get('owner'))?.connection?.refreshTokenEncrypted).not.toContain(
      'rotated-refresh',
    );
    expect(
      (await f.service.callback(new URLSearchParams({ state: next.state, code: 'code' }))).accepted,
    ).toBe(true);
  });
  it('disconnect during refresh prevents token return and credential resurrection', async () => {
    const f = fixture();
    await f.connect();
    f.fetcher.mockImplementationOnce(async () => {
      await f.service.disconnect('owner');
      return Response.json({
        access_token: 'late',
        refresh_token: 'late',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    });
    await expect(f.token({ forceRefresh: true })).rejects.toThrow('disconnected');
    expect((await f.repository.get('owner'))?.connection).toBeNull();
  });
  it('rejects a stale selected connection before network calls', async () => {
    const f = fixture();
    await f.connect();
    f.fetcher.mockClear();
    await expect(f.token({ expectedConnectionId: randomUUID() })).rejects.toThrow('disconnected');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('marks revoked refresh grants as requiring reconnect with sanitized errors', async () => {
    const f = fixture();
    await f.connect();
    f.fetcher.mockResolvedValueOnce(
      Response.json(
        { error: 'invalid_grant', error_description: 'provider-secret' },
        { status: 400 },
      ),
    );
    await expect(f.token({ forceRefresh: true })).rejects.toThrow('invalid_grant');
    expect((await f.service.status('owner')).state).toBe('reconnect_required');
  });
  it('retains a rotated refresh token through a failed availability probe and recovers with it', async () => {
    const f = fixture();
    await f.connect();
    f.fetcher
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'new-access',
          refresh_token: 'rotated-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, { status: 403 }),
      );
    await expect(f.token({ forceRefresh: true })).rejects.toThrow('provider_unavailable');
    const failed = required((await f.repository.get('owner'))?.connection);
    expect(f.ports.decrypt(failed.refreshTokenEncrypted)).toBe('rotated-refresh');
    expect(failed).toMatchObject({
      status: 'provider_unavailable',
      accessTokenEncrypted: null,
      refreshLease: null,
    });
    await expect(f.token()).resolves.toMatchObject({ accessToken: 'access-secret' });
    const tokenRequests = f.fetcher.mock.calls.filter(([url]) => String(url).includes('/token'));
    const last = required(tokenRequests.at(-1));
    expect(String(last[1]?.body)).toContain('refresh_token=rotated-refresh');
    expect((await f.service.status('owner')).state).toBe('connected');
  });
  it.each([
    [401, '', 'reconnect_required'],
    [403, 'insufficientPermissions', 'reconnect_required'],
    [403, 'rateLimitExceeded', 'provider_unavailable'],
    [403, 'forbidden', 'connected'],
    [404, 'notFound', 'connected'],
  ] as const)('persists only global failure for HTTP %s %s', async (status, reason, expected) => {
    const f = fixture();
    await f.connect();
    const connection = required((await f.repository.get('owner'))?.connection);
    await reportGoogleCalendarReadFailure({
      repository: f.repository,
      ownerId: 'owner',
      connectionId: connection.id,
      accessToken: 'access-secret',
      status,
      body: { error: { errors: [{ reason }] } },
      decrypt: f.ports.decrypt,
    });
    expect((await f.service.status('owner')).state).toBe(expected);
  });
  it('ignores a late failure from an old token or a replaced connection', async () => {
    const f = fixture();
    await f.connect();
    const before = required((await f.repository.get('owner'))?.connection);
    f.fetcher.mockResolvedValueOnce(
      Response.json({ access_token: 'fresh-access', token_type: 'Bearer', expires_in: 3600 }),
    );
    await f.token({ forceRefresh: true });
    const failure = {
      repository: f.repository,
      ownerId: 'owner',
      connectionId: before.id,
      accessToken: 'access-secret',
      status: 401,
      body: {},
      decrypt: f.ports.decrypt,
    };
    await reportGoogleCalendarReadFailure(failure);
    expect((await f.service.status('owner')).state).toBe('connected');
    await f.connect();
    await reportGoogleCalendarReadFailure({ ...failure, accessToken: 'access-secret' });
    expect((await f.service.status('owner')).state).toBe('connected');
    expect((await f.repository.get('owner'))?.connection?.id).not.toBe(before.id);
  });
  it('credential-version fencing prevents a failure report overwriting a concurrent refresh', async () => {
    const f = fixture();
    await f.connect();
    const before = required((await f.repository.get('owner'))?.connection);
    const read = f.repository.get.bind(f.repository);
    vi.spyOn(f.repository, 'get').mockImplementationOnce(async (ownerId) => {
      const stale = await read(ownerId);
      f.fetcher.mockResolvedValueOnce(
        Response.json({
          access_token: 'fresh-access',
          refresh_token: 'rotated-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      await f.token({ forceRefresh: true });
      return stale;
    });
    await reportGoogleCalendarReadFailure({
      repository: f.repository,
      ownerId: 'owner',
      connectionId: before.id,
      accessToken: 'access-secret',
      status: 401,
      body: {},
      decrypt: f.ports.decrypt,
    });
    const after = required((await f.repository.get('owner'))?.connection);
    expect(after.status).toBe('connected');
    expect(f.ports.decrypt(after.refreshTokenEncrypted)).toBe('rotated-refresh');
    expect(f.ports.decrypt(required(after.accessTokenEncrypted))).toBe('fresh-access');
  });
  it('an active refresh owns its failure probe and cannot be invalidated by an older API request', async () => {
    const f = fixture();
    await f.connect();
    const before = required((await f.repository.get('owner'))?.connection);
    const leaseId = randomUUID();
    const claim = await f.repository.acquireRefresh(
      'owner',
      before.id,
      leaseId,
      f.ports.now(),
      true,
    );
    if (claim.kind !== 'claimed') throw new Error('Expected refresh claim');
    await reportGoogleCalendarReadFailure({
      repository: f.repository,
      ownerId: 'owner',
      connectionId: before.id,
      accessToken: 'access-secret',
      status: 401,
      body: {},
      decrypt: f.ports.decrypt,
    });
    expect(
      await f.repository.completeRefresh(
        'owner',
        before.id,
        leaseId,
        claim.credential.credentialVersion,
        { ...claim.credential, refreshTokenEncrypted: f.ports.encrypt('new-refresh') },
      ),
    ).toBe(true);
    expect((await f.service.status('owner')).state).toBe('connected');
  });
  it('ignores old credential versions even if Google reuses the same access token', async () => {
    const f = fixture();
    await f.connect();
    const before = required((await f.repository.get('owner'))?.connection);
    await f.token({ forceRefresh: true });
    await reportGoogleCalendarReadFailure({
      repository: f.repository,
      ownerId: 'owner',
      connectionId: before.id,
      credentialVersion: before.credentialVersion,
      accessToken: 'access-secret',
      status: 401,
      body: {},
      decrypt: f.ports.decrypt,
    });
    expect((await f.service.status('owner')).state).toBe('connected');
    expect((await f.repository.get('owner'))?.connection?.credentialVersion).toBe(
      before.credentialVersion + 1,
    );
  });
  it('does not remove a refresh lease acquired between reading and recording a failure', async () => {
    const f = fixture();
    await f.connect();
    const before = required((await f.repository.get('owner'))?.connection);
    const read = f.repository.get.bind(f.repository);
    const leaseId = randomUUID();
    vi.spyOn(f.repository, 'get').mockImplementationOnce(async (ownerId) => {
      const stale = await read(ownerId);
      await f.repository.acquireRefresh('owner', before.id, leaseId, f.ports.now(), true);
      return stale;
    });
    await reportGoogleCalendarReadFailure({
      repository: f.repository,
      ownerId: 'owner',
      connectionId: before.id,
      credentialVersion: before.credentialVersion,
      accessToken: 'access-secret',
      status: 401,
      body: {},
      decrypt: f.ports.decrypt,
    });
    const active = required((await read('owner'))?.connection);
    expect(active).toMatchObject({
      status: 'connected',
      credentialVersion: before.credentialVersion,
      refreshLease: { id: leaseId },
    });
    expect(
      await f.repository.completeRefresh(
        'owner',
        before.id,
        leaseId,
        before.credentialVersion,
        active,
      ),
    ).toBe(true);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected fixture value');
  return value;
}
