import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  cookie: vi.fn(),
  mutate: vi.fn(),
  config: {
    OWNER_AUTH_MODE: 'google',
    AUTH_URL: 'https://assistant.example.test',
    PUBLIC_URL: 'https://assistant.example.test',
    MOBILE_API_TOKEN: 'offline-owner-fixture-token',
    PERSISTENCE_DRIVER: 'postgres',
  },
}));
vi.mock('@assistant/config', () => ({ loadConfig: () => state.config }));
vi.mock('../auth', () => ({ isAuthed: state.cookie }));
vi.mock('@/lib/server', () => ({ getDb: state.mutate }));
vi.mock('@assistant/application/profile', () => ({ createPerson: state.mutate }));
vi.mock('@/lib/firestore-profile-commands', () => ({
  getFirestoreProfileCommands: state.mutate,
  recompileFirestoreProfileCard: state.mutate,
}));

import { POST } from '../app/api/mobile/v1/memory/people/route';
import { clearMobileAccessTokenCache } from './mobile-access-token';

beforeEach(() => {
  vi.clearAllMocks();
  clearMobileAccessTokenCache();
  state.cookie.mockResolvedValue(true);
});
describe('actual mobile credential and origin guard with bounded mutation route', () => {
  it.each([
    { origin: 'https://hostile.example.test', token: 'invalid', status: 401 },
    { origin: 'null', token: '', status: 401 },
    { origin: undefined, token: 'invalid', status: 401 },
    { origin: 'https://assistant.example.test', token: '', status: 400 },
    { origin: undefined, token: 'offline-owner-fixture-token', status: 400 },
  ])(
    'rejects body or authentication without mutation: $status',
    async ({ origin, token, status }) => {
      const headers = new Headers({ 'content-type': 'application/json' });
      if (origin) headers.set('origin', origin);
      if (token) headers.set('authorization', `Bearer ${token}`);
      const request = new Request('https://assistant.example.test/api/mobile/v1/memory/people', {
        method: 'POST',
        headers,
        body: '{',
      });
      expect((await POST(request)).status).toBe(status);
      expect(request.bodyUsed).toBe(status !== 401);
      expect(state.mutate).not.toHaveBeenCalled();
    },
  );
  it('rejects an oversized body for an actual owner bearer credential before mutation', async () => {
    const response = await POST(
      new Request('https://assistant.example.test/api/mobile/v1/memory/people', {
        method: 'POST',
        headers: { authorization: 'Bearer offline-owner-fixture-token', 'content-length': '65537' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(413);
    expect(state.mutate).not.toHaveBeenCalled();
  });
});
