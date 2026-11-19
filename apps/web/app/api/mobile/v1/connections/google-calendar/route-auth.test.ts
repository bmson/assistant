import { resetConfigForTest } from '@assistant/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  verifyDeviceToken: vi.fn(),
  ownerCookie: vi.fn(),
  connectionService: vi.fn(),
}));

// Keep the route and mobile bearer/owner helpers real. Only replace the
// external identity sources and the downstream service boundary.
vi.mock('@/lib/owner-auth/runtime', () => ({
  ownerAuthService: () => ({ verifyDeviceToken: state.verifyDeviceToken }),
}));
vi.mock('@/auth', () => ({ isAuthed: state.ownerCookie }));
vi.mock('@/lib/google-calendar-connection-runtime', () => ({
  getGoogleCalendarConnectionService: state.connectionService,
}));

import { POST } from './connect/route';
import { DELETE as cancelFlow } from './flow/route';
import { DELETE as disconnect } from './route';

const base = 'https://assistant.example.test/api/mobile/v1/connections/google-calendar';
const mutations = [
  { name: 'connect', handler: POST, method: 'POST', path: '/connect' },
  { name: 'disconnect', handler: disconnect, method: 'DELETE', path: '' },
  {
    name: 'cancel flow',
    handler: cancelFlow,
    method: 'DELETE',
    path: '/flow?flowId=11111111-1111-4111-8111-111111111111',
  },
];

describe('Calendar mutations through real mobile authentication', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('OWNER_AUTH_MODE', 'passkey');
    resetConfigForTest();
    state.verifyDeviceToken.mockResolvedValue(null);
    // Even a valid owner web session cannot authorize these bearer-only routes.
    state.ownerCookie.mockResolvedValue({ user: { email: 'owner@example.test' } });
    state.connectionService.mockImplementation(() => {
      throw new Error('Unauthorized request reached the connection service');
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it.each(mutations)('rejects a revoked device bearer for $name', async (mutation) => {
    const response = await mutation.handler(
      new Request(`${base}${mutation.path}`, {
        method: mutation.method,
        headers: {
          authorization: 'Bearer asd1_revoked-fixture',
          'content-type': 'application/json',
        },
        ...(mutation.method === 'POST' ? { body: '{}' } : {}),
      }),
    );

    expect(response.status).toBe(401);
    expect(state.verifyDeviceToken).toHaveBeenCalledExactlyOnceWith('asd1_revoked-fixture');
    expect(state.ownerCookie).not.toHaveBeenCalled();
    expect(state.connectionService).not.toHaveBeenCalled();
  });

  it.each(mutations)('rejects cookie-only authentication for $name', async (mutation) => {
    const response = await mutation.handler(
      new Request(`${base}${mutation.path}`, {
        method: mutation.method,
        headers: {
          cookie: 'authjs.session-token=owner-session-fixture',
          origin: 'https://assistant.example.test',
          'content-type': 'application/json',
        },
        ...(mutation.method === 'POST' ? { body: '{}' } : {}),
      }),
    );

    expect(response.status).toBe(401);
    expect(state.verifyDeviceToken).not.toHaveBeenCalled();
    expect(state.ownerCookie).not.toHaveBeenCalled();
    expect(state.connectionService).not.toHaveBeenCalled();
  });
});
