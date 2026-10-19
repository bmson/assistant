import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mode: 'google',
  get: vi.fn(),
  post: vi.fn(),
  calendar: vi.fn(),
}));
vi.mock('@/auth', () => ({
  get authMode() {
    return state.mode;
  },
  handlers: { GET: state.get, POST: state.post },
}));
vi.mock('../../calendar-accounts/callback/route', () => ({ GET: state.calendar }));

import { GET, POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  state.mode = 'google';
  state.get.mockResolvedValue(new Response('owner sign-in'));
  state.calendar.mockResolvedValue(new Response('calendar consent'));
});
it('keeps normal Google callbacks in the owner allowlisted sign-in flow', async () => {
  const request = new NextRequest(
    'https://assistant.test/api/auth/callback/google?state=normal-state',
  );
  await GET(request);
  expect(state.get).toHaveBeenCalled();
  expect(state.calendar).not.toHaveBeenCalled();
});
it('routes only namespaced Google calendar callbacks to the independently guarded account flow', async () => {
  const request = new NextRequest(
    'https://assistant.test/api/auth/callback/google?state=calendar.random',
  );
  expect(await (await GET(request)).text()).toBe('calendar consent');
  expect(state.calendar).toHaveBeenCalledWith(request);
  expect(state.get).not.toHaveBeenCalled();
  await GET(new NextRequest('https://assistant.test/api/auth/signin?state=calendar.random'));
  expect(state.get).toHaveBeenCalled();
});
it('keeps regular Auth.js endpoints closed in passkey installations', async () => {
  state.mode = 'passkey';
  expect(
    (await GET(new NextRequest('https://assistant.test/api/auth/callback/google?state=ordinary')))
      .status,
  ).toBe(404);
  expect(
    (await POST(new NextRequest('https://assistant.test/api/auth/signin', { method: 'POST' })))
      .status,
  ).toBe(404);
  expect(state.get).not.toHaveBeenCalled();
  expect(state.post).not.toHaveBeenCalled();
});
