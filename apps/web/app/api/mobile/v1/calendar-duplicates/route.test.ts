import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ auth: vi.fn(), assess: vi.fn(), router: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  authenticateMobileOwner: state.auth,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/server', () => ({ getCalendarDuplicateRouter: state.router }));
vi.mock('@assistant/application/calendar-duplicates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/application/calendar-duplicates')>()),
  assessCalendarDuplicates: state.assess,
}));
const events = [
  {
    id: 'a',
    calendar: 'one',
    title: 'One',
    start: '2026-11-07T17:00:00Z',
    end: '2026-11-07T18:00:00Z',
    location: 'North Meadow',
  },
  {
    id: 'b',
    calendar: 'two',
    title: 'Two',
    start: '2026-11-07T17:00:00Z',
    end: '2026-11-07T18:00:00Z',
    location: 'North Meadow',
  },
];
const request = (body: unknown) =>
  new Request('https://assistant.test/api/mobile/v1/calendar-duplicates', {
    method: 'POST',
    body: JSON.stringify(body),
  });
describe('mobile calendar duplicate route', () => {
  it('authenticates and validates before provider access', async () => {
    const { POST } = await import('./route');
    state.auth.mockResolvedValueOnce(null);
    expect((await POST(request({ events }))).status).toBe(401);
    state.auth.mockResolvedValue({ ownerId: 'owner' });
    expect((await POST(request({ events: [events[0], events[0]] }))).status).toBe(400);
    expect(state.assess).not.toHaveBeenCalled();
  });
  it('rejects oversized request bodies before assessment', async () => {
    const { POST } = await import('./route');
    state.auth.mockResolvedValue({ ownerId: 'owner' });
    state.assess.mockClear();
    expect((await POST(request({ padding: 'x'.repeat(24_001) }))).status).toBe(413);
    expect(state.assess).not.toHaveBeenCalled();
  });
  it('returns owner-bound assessments and exposes failures as unavailable', async () => {
    const { POST } = await import('./route');
    state.auth.mockResolvedValue({ ownerId: 'owner' });
    state.assess.mockResolvedValueOnce({ groups: [] }).mockRejectedValueOnce(new Error('offline'));
    const response = await POST(request({ events }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ groups: [] });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(state.assess).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'owner', events }),
    );
    expect((await POST(request({ events }))).status).toBe(503);
  });
});
