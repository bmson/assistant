import { afterEach, expect, it, vi } from 'vitest';
import { getMobileNoticingHealth } from '@/lib/server';
import { GET } from './route';

vi.mock('@/lib/server', () => ({
  getMobileNoticingHealth: vi.fn(),
}));
vi.mock('@/auth', () => ({ isAuthed: vi.fn() }));

const auth = vi.hoisted(() => ({ bearer: vi.fn(), owner: vi.fn() }));
vi.mock('@/mobile-auth', async (original) => ({
  ...(await original<typeof import('@/mobile-auth')>()),
  authenticateMobileBearer: auth.bearer,
  resolveMobileOwner: auth.owner,
}));

const request = () => new Request('https://assistant.example.test/api/mobile/v1/proactive-health');
afterEach(() => vi.resetAllMocks());

it('requires a mobile credential before resolving the owner', async () => {
  auth.bearer.mockResolvedValue(null);
  expect((await GET(request())).status).toBe(401);
  expect(auth.owner).not.toHaveBeenCalled();
});

it('reports an unavailable installation separately from a quiet one', async () => {
  auth.bearer.mockResolvedValue({ kind: 'configured_installation_bearer' });
  auth.owner.mockResolvedValue({ ok: false, reason: 'unavailable' });
  expect((await GET(request())).status).toBe(503);
});

it('returns the authenticated owner’s health view without caching it', async () => {
  auth.bearer.mockResolvedValue({ kind: 'configured_installation_bearer' });
  auth.owner.mockResolvedValue({ ok: true, ownerId: 'test-owner' });
  const view = {
    mailReceived7d: 3,
    mailScored7d: 2,
    mailProcessed7d: 1,
    mailAwaitingAdmissionOver6h7d: 1,
    mailPendingOver6h7d: 1,
    mailScored24h: 2,
    canaries: {
      pulse: { state: 'fresh' },
      googleCalendar: { state: 'connected' },
      phoneCalendar: { state: 'not_configured' },
      weather: { state: 'expired' },
      urgentSms: { state: 'within_limit', attempts: 1, limit: 3 },
    } as const,
    ingestMode: 'direct',
    pushDevices: 1,
    warnings: [],
    lastMailAt: null,
    healthy: true,
    dailyBudgetHolds: 'within_limit' as const,
    momentsDelivered24h: 0,
    pingsHeld24h: 2,
    quietHoursHeld24h: 1,
    pingsDelivered24h: 0,
  };
  const briefing = { ok: false, state: 'stale', ageMs: 27 * 3600_000 } as const;
  vi.mocked(getMobileNoticingHealth).mockResolvedValue({ ...view, healthy: false, briefing });
  const res = await GET(request());
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toContain('no-store');
  expect(await res.json()).toEqual({ ...view, healthy: false, briefing });
  expect(getMobileNoticingHealth).toHaveBeenCalledExactlyOnceWith('test-owner');
});

it('reports a failed owner-fenced health read as unavailable', async () => {
  auth.bearer.mockResolvedValue({ kind: 'configured_installation_bearer' });
  auth.owner.mockResolvedValue({ ok: true, ownerId: 'test-owner' });
  vi.mocked(getMobileNoticingHealth).mockRejectedValue(new Error('health read failed'));
  expect((await GET(request())).status).toBe(503);
});
