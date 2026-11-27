import { beforeEach, expect, it, vi } from 'vitest';
import { mobileQuietHours } from '@/lib/server';
import { GET, PATCH } from './route';

vi.mock('@/lib/server', () => ({ mobileQuietHours: vi.fn() }));
vi.mock('@/auth', () => ({ isAuthed: vi.fn() }));
const auth = vi.hoisted(() => ({ bearer: vi.fn(), owner: vi.fn() }));
vi.mock('@/mobile-auth', async (original) => ({
  ...(await original<typeof import('@/mobile-auth')>()),
  authenticateMobileBearer: auth.bearer,
  resolveMobileOwner: auth.owner,
}));

const url = 'https://assistant.example.test/api/mobile/v1/settings/quiet-hours';
const patch = (body: object) =>
  new Request(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const off = { quietStartMin: null, quietEndMin: null };
const overnight = { quietStartMin: 1320, quietEndMin: 420 };

beforeEach(() => {
  vi.resetAllMocks();
  auth.bearer.mockResolvedValue({ kind: 'configured_installation_bearer' });
  auth.owner.mockResolvedValue({ ok: true, ownerId: 'synthetic-owner' });
});

it('requires a bearer for each operation', async () => {
  auth.bearer.mockResolvedValue(null);
  expect((await GET(new Request(url))).status).toBe(401);
  expect((await PATCH(patch(overnight))).status).toBe(401);
  expect(auth.owner).not.toHaveBeenCalled();
  expect(mobileQuietHours).not.toHaveBeenCalled();
});

it('keeps an unavailable read distinct from a confirmed off window', async () => {
  vi.mocked(mobileQuietHours).mockRejectedValueOnce(new Error('synthetic read error'));
  expect((await GET(new Request(url))).status).toBe(503);
  const view = { timezone: 'America/Los_Angeles', ...off };
  vi.mocked(mobileQuietHours).mockResolvedValueOnce(view);
  const response = await GET(new Request(url));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(view);
});

it.each([
  {},
  { quietStartMin: 1320 },
  { quietStartMin: 1320, quietEndMin: null },
  { quietStartMin: 420, quietEndMin: 420 },
  { quietStartMin: 1440, quietEndMin: 420 },
  { quietStartMin: 1320, quietEndMin: 1.5 },
  { ...overnight, ambientDailyCap: 2 },
])('rejects unsafe or incomplete input without mutating %j', async (body) => {
  expect((await PATCH(patch(body))).status).toBe(400);
  expect(mobileQuietHours).not.toHaveBeenCalled();
});

it('returns a failed mutation as unconfirmed and supports a deliberate retry and clear', async () => {
  vi.mocked(mobileQuietHours).mockRejectedValueOnce(new Error('synthetic write error'));
  expect((await PATCH(patch(overnight))).status).toBe(503);
  const view = { timezone: 'America/Los_Angeles', ...overnight };
  vi.mocked(mobileQuietHours).mockResolvedValueOnce(view);
  expect(await (await PATCH(patch(overnight))).json()).toEqual(view);
  vi.mocked(mobileQuietHours).mockResolvedValueOnce({ ...view, ...off });
  expect(await (await PATCH(patch(off))).json()).toEqual({ ...view, ...off });
  expect(mobileQuietHours).toHaveBeenNthCalledWith(2, 'synthetic-owner', overnight);
  expect(mobileQuietHours).toHaveBeenNthCalledWith(3, 'synthetic-owner', off);
});
