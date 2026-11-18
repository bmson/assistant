import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: {
    OWNER_AUTH_MODE: 'google',
    PERSISTENCE_DRIVER: 'postgres',
    GCP_PROJECT: 'fixture-project',
    FIRESTORE_AGENT_ID: 'firestore-owner',
  },
  cookie: vi.fn(),
  token: vi.fn(),
  owner: vi.fn(),
  device: vi.fn(),
  validate: vi.fn(),
}));
vi.mock('@assistant/config', () => ({
  loadConfig: () => state.config,
  validateAgentPersistenceConfig: state.validate,
}));
vi.mock('@/auth', () => ({ isAuthed: state.cookie }));
vi.mock('@/lib/mobile-access-token', () => ({ getMobileAccessToken: state.token }));
vi.mock('@/lib/server', () => ({
  getDb: () => ({ kind: 'fixture-db' }),
  assertPostgresInstallationOwner: state.owner,
}));
vi.mock('@/lib/owner-auth/runtime', () => ({
  ownerAuthService: () => ({ verifyDeviceToken: state.device }),
}));

import { authenticateMcpAuthorizationRead } from './mcp-authorization-auth';

const request = (authorization?: string) =>
  new Request(
    'https://assistant.example/api/mobile/v1/mcp/id/authorization',
    authorization === undefined ? {} : { headers: { Authorization: authorization } },
  );
beforeEach(() => {
  vi.clearAllMocks();
  state.cookie.mockResolvedValue(null);
  state.token.mockResolvedValue('current-token');
  state.owner.mockResolvedValue('owner');
  state.device.mockResolvedValue(null);
  state.validate.mockReturnValue([]);
  state.config.OWNER_AUTH_MODE = 'google';
  state.config.PERSISTENCE_DRIVER = 'postgres';
});
afterEach(() => vi.unstubAllEnvs());

describe('MCP diagnostic web/native read authentication', () => {
  it('accepts the existing owner web session and then resolves configured ownership', async () => {
    state.cookie.mockResolvedValue({ user: { email: 'owner@example.com' } });
    expect(await authenticateMcpAuthorizationRead(request())).toEqual({
      kind: 'authenticated',
      ownerId: 'owner',
    });
    expect(state.token).not.toHaveBeenCalled();
    expect(state.owner).toHaveBeenCalledOnce();
  });
  it('rejects an absent/foreign web session before owner resolution', async () => {
    expect(await authenticateMcpAuthorizationRead(request())).toEqual({ kind: 'unauthenticated' });
    expect(state.owner).not.toHaveBeenCalled();
  });
  it('keeps valid configured native bearer requests independent of cookies', async () => {
    expect(await authenticateMcpAuthorizationRead(request('Bearer current-token'))).toEqual({
      kind: 'authenticated',
      ownerId: 'owner',
    });
    expect(state.cookie).not.toHaveBeenCalled();
  });
  it.each(['Bearer invalid-token', 'Basic abc', '', 'Bearer'])(
    'rejects supplied invalid authorization %s even with a valid cookie',
    async (header) => {
      state.cookie.mockResolvedValue({ user: { email: 'owner@example.com' } });
      expect(await authenticateMcpAuthorizationRead(request(header))).toEqual({
        kind: 'unauthenticated',
      });
      expect(state.cookie).not.toHaveBeenCalled();
      expect(state.owner).not.toHaveBeenCalled();
    },
  );
  it('preserves warm-cache token rotation checks without accepting an old bearer via cookie', async () => {
    vi.stubEnv('K_SERVICE', 'fixture-service');
    state.cookie.mockResolvedValue({ user: { email: 'owner@example.com' } });
    state.token.mockResolvedValueOnce('stale-cache').mockResolvedValueOnce('new-token');
    expect(await authenticateMcpAuthorizationRead(request('Bearer new-token'))).toEqual({
      kind: 'authenticated',
      ownerId: 'owner',
    });
    expect(state.token).toHaveBeenLastCalledWith('mismatch');
    state.token.mockResolvedValue('new-token');
    expect(await authenticateMcpAuthorizationRead(request('Bearer stale-cache'))).toEqual({
      kind: 'unauthenticated',
    });
    expect(state.cookie).not.toHaveBeenCalled();
  });
  it('checks revocable per-device identities fresh and never uses a cookie on revocation', async () => {
    state.config.OWNER_AUTH_MODE = 'passkey';
    state.device.mockResolvedValueOnce('device').mockResolvedValueOnce(null);
    state.cookie.mockResolvedValue({ user: { email: 'owner@example.com' } });
    expect((await authenticateMcpAuthorizationRead(request('Bearer asd1_fixture'))).kind).toBe(
      'authenticated',
    );
    expect((await authenticateMcpAuthorizationRead(request('Bearer asd1_fixture'))).kind).toBe(
      'unauthenticated',
    );
    expect(state.device).toHaveBeenCalledTimes(2);
    expect(state.cookie).not.toHaveBeenCalled();
  });
  it('does not cache configured ownership across owner rotation or hide resolution failures as authorization', async () => {
    state.cookie.mockResolvedValue({ user: { email: 'owner@example.com' } });
    state.owner.mockResolvedValueOnce('owner-before').mockResolvedValueOnce('owner-after');
    expect(await authenticateMcpAuthorizationRead(request())).toMatchObject({
      ownerId: 'owner-before',
    });
    expect(await authenticateMcpAuthorizationRead(request())).toMatchObject({
      ownerId: 'owner-after',
    });
    state.owner.mockRejectedValue(Error('private storage details'));
    expect(await authenticateMcpAuthorizationRead(request())).toEqual({ kind: 'unavailable' });
  });
  it('does not authorize a mutation through this read-only cookie boundary', async () => {
    state.cookie.mockResolvedValue({ user: { email: 'owner@example.com' } });
    expect(
      await authenticateMcpAuthorizationRead(
        new Request('https://assistant.example/api/mobile/v1/mcp/id/authorization', {
          method: 'POST',
        }),
      ),
    ).toEqual({ kind: 'unauthenticated' });
    expect(state.cookie).not.toHaveBeenCalled();
  });
});
