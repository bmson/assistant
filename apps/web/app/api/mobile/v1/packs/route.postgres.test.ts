import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ allowed: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: auth.allowed,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

describe('mobile packs in PostgreSQL mode', () => {
  const creationKey = randomUUID();
  let route: typeof import('./route.js') | undefined;
  let database: ReturnType<typeof import('@/lib/server').getDb> | undefined;
  let createdPackId: string | undefined;

  beforeAll(async () => {
    if (!process.env.ASSISTANT_TEST_TARGET_TOKEN)
      throw new Error('Requires the isolated test database allocator');
    vi.stubEnv('PERSISTENCE_DRIVER', 'postgres');
    resetConfigForTest();
    auth.allowed.mockResolvedValue(true);
    const [server, mobilePacksRoute] = await Promise.all([
      import('@/lib/server'),
      import('./route.js'),
    ]);
    database = server.getDb();
    route = mobilePacksRoute;
  });

  afterAll(async () => {
    if (createdPackId)
      await database?.$client.unsafe('DELETE FROM situation_packs WHERE id = $1', [createdPackId]);
    await database?.$client.end();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('accepts a bounded owner pack command through the PostgreSQL route', async () => {
    if (!route) throw new Error('Route fixture is not initialized');
    const response = await route.POST(
      new Request('http://localhost/api/mobile/v1/packs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', title: 'Bounded body regression', creationKey }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; packId: string };
    expect(body).toMatchObject({ ok: true, packId: expect.any(String) });
    createdPackId = body.packId;
  });
});
