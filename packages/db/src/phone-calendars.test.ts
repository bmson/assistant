import { randomUUID } from 'node:crypto';
import { readPhoneCalendars, savePhoneCalendars } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from './client.js';
import { toolCache } from './schema.js';
import { createPostgresToolExecutionRepository } from './tool-execution-repository.js';

it('replaces and revokes owner-scoped phone snapshots in the portable PostgreSQL cache', async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing isolated test database');
  const db = createDb(url);
  const agentId = randomUUID();
  const cacheKey = `phone-calendars:v1:${agentId}`;
  try {
    const cache = createPostgresToolExecutionRepository(db);
    await savePhoneCalendars(cache, agentId, {
      timeMin: '2026-10-01T00:00:00Z',
      timeMax: '2026-12-01T00:00:00Z',
      timeZone: 'UTC',
      calendars: [{ id: 'work', name: 'Work' }],
      events: [],
    });
    expect((await readPhoneCalendars(cache, agentId))?.calendars).toEqual([
      { id: 'work', name: 'Work' },
    ]);
    expect(await readPhoneCalendars(cache, randomUUID())).toBeNull();
    await savePhoneCalendars(cache, agentId, null);
    expect(await readPhoneCalendars(cache, agentId)).toBeNull();
    const [stored] = await db.select().from(toolCache).where(eq(toolCache.cacheKey, cacheKey));
    expect(stored?.result).toEqual({ disconnected: true });
  } finally {
    await db.delete(toolCache).where(eq(toolCache.cacheKey, cacheKey));
    await db.$client.end();
  }
});
