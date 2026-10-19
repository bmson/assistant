import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  owner: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  set: vi.fn(),
  cookie: 'sealed-flow',
  ports: { config: { AUTH_URL: 'https://assistant.test' } },
}));
vi.mock('@/auth', () => ({ isAuthed: state.owner }));
vi.mock('@/lib/server', () => ({ getCalendarAccountPorts: () => state.ports }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (state.cookie ? { value: state.cookie } : undefined),
    set: state.set,
  }),
}));
vi.mock('@assistant/application/calendar-accounts', async (original) => ({
  ...(await original<typeof import('@assistant/application/calendar-accounts')>()),
  beginCalendarConnection: state.begin,
  completeCalendarConnection: state.complete,
}));

import { GET as callback } from './callback/route';
import { GET as start } from './connect/route';

beforeEach(() => {
  vi.clearAllMocks();
  state.cookie = 'sealed-flow';
  state.owner.mockResolvedValue({ formSessionScope: 'owner-session' });
  state.begin.mockResolvedValue({
    url: 'https://accounts.google.com/authorize',
    cookie: 'sealed-flow',
  });
  state.complete.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

it('requires owner authentication on both endpoints', async () => {
  state.owner.mockResolvedValue(null);
  expect(
    (await start(new Request('https://assistant.test/api/calendar-accounts/connect'))).status,
  ).toBe(401);
  expect(
    (await callback(new Request('https://assistant.test/api/calendar-accounts/callback'))).status,
  ).toBe(401);
  expect(state.begin).not.toHaveBeenCalled();
  expect(state.complete).not.toHaveBeenCalled();
});
it('rejects cross-site initiation and seals a secure browser flow on a Settings navigation', async () => {
  expect(
    (
      await start(
        new Request('https://assistant.test/api/calendar-accounts/connect', {
          headers: { 'sec-fetch-site': 'cross-site' },
        }),
      )
    ).status,
  ).toBe(403);
  expect(state.begin).not.toHaveBeenCalled();
  const response = await start(
    new Request('https://assistant.test/api/calendar-accounts/connect', {
      headers: { 'sec-fetch-site': 'same-origin' },
    }),
  );
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('https://accounts.google.com/authorize');
  expect(state.set).toHaveBeenCalledWith(
    'assistant-calendar-connect',
    'sealed-flow',
    expect.objectContaining({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/api',
    }),
  );
});
it('consumes the flow cookie and binds the exchange to the current owner login', async () => {
  const response = await callback(
    new Request(
      'https://assistant.test/api/calendar-accounts/callback?state=random&code=private-code',
    ),
  );
  expect(state.complete).toHaveBeenCalledWith(state.ports, {
    cookie: 'sealed-flow',
    state: 'random',
    code: 'private-code',
    sessionScope: 'owner-session',
  });
  expect(state.set).toHaveBeenCalledWith(
    'assistant-calendar-connect',
    '',
    expect.objectContaining({ maxAge: 0 }),
  );
  expect(response.headers.get('location')).toBe(
    'https://assistant.test/settings?calendarConnection=connected',
  );
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
});
it('reports denied or missing consent without leaking provider descriptions or codes', async () => {
  const response = await callback(
    new Request(
      'https://assistant.test/api/calendar-accounts/callback?error=access_denied&error_description=private-description',
    ),
  );
  expect(response.headers.get('location')).toBe(
    'https://assistant.test/settings?calendarConnection=failed',
  );
  expect(state.complete).not.toHaveBeenCalled();
  state.cookie = '';
  await callback(
    new Request(
      'https://assistant.test/api/calendar-accounts/callback?state=random&code=private-code',
    ),
  );
  expect(state.complete).not.toHaveBeenCalled();
});
