import { randomUUID } from 'node:crypto';
import {
  type PhoneCalendarSharingCommand,
  readPhoneCalendars,
  savePhoneCalendars,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from './client.js';
import { agents, phoneCalendarSharing, toolCache } from './schema.js';
import { createPostgresToolExecutionRepository } from './tool-execution-repository.js';

it('replaces and revokes owner-scoped phone snapshots in the portable PostgreSQL cache', async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing isolated test database');
  const db = createDb(url);
  const agentId = randomUUID();
  const cacheKey = `phone-calendars:v1:${agentId}`;
  try {
    const cache = createPostgresToolExecutionRepository(db);
    const legacyCache = { cacheGet: cache.cacheGet, cachePut: cache.cachePut };
    await savePhoneCalendars(legacyCache, agentId, {
      timeMin: '2026-10-01T00:00:00Z',
      timeMax: '2026-12-01T00:00:00Z',
      timeZone: 'UTC',
      calendars: [{ id: 'work', name: 'Work' }],
      events: [],
    });
    expect((await readPhoneCalendars(legacyCache, agentId))?.calendars).toEqual([
      { id: 'work', name: 'Work' },
    ]);
    expect(await readPhoneCalendars(cache, agentId)).toBeNull();
    expect(await readPhoneCalendars(legacyCache, randomUUID())).toBeNull();
    await savePhoneCalendars(legacyCache, agentId, null);
    expect(await readPhoneCalendars(legacyCache, agentId)).toBeNull();
    const [stored] = await db.select().from(toolCache).where(eq(toolCache.cacheKey, cacheKey));
    expect(stored?.result).toEqual({ disconnected: true });
  } finally {
    await db.delete(toolCache).where(eq(toolCache.cacheKey, cacheKey));
    await db.$client.end();
  }
});

it('atomically persists phone sharing state, event snapshots, and revocation across repository restarts', async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing isolated test database');
  const db = createDb(url);
  const ownerId = randomUUID();
  const publisherId = 'device-publisher';
  const cacheKey = `phone-calendars:v1:${ownerId}`;
  const now = new Date('2026-10-22T12:00:00Z');
  try {
    await db.insert(agents).values({
      id: ownerId,
      name: 'Calendar owner',
      email: `${ownerId}@test.local`,
      workspacePrefix: `workspace/${ownerId}`,
    });
    const cache = createPostgresToolExecutionRepository(db);
    const command: PhoneCalendarSharingCommand = {
      command: 'enable',
      publisherId,
      expectedGeneration: 0,
      mutationId: 'enable-1',
      consentVersion: 1,
      calendars: [{ id: 'work', name: 'Work', purpose: 'commitments' }],
    };
    const enabled = await cache.phoneCalendarSharing?.apply(ownerId, command, now);
    expect(enabled).toMatchObject({ ok: true, state: { generation: 1, enabled: true } });

    const snapshot = {
      capturedAt: now.toISOString(),
      selectionRevision: 1,
      complete: true,
      truncated: false,
      timeMin: '2026-10-21T00:00:00Z',
      timeMax: '2026-10-29T00:00:00Z',
      timeZone: 'UTC',
      calendars: [{ id: 'work', name: 'Work', purpose: 'commitments' as const }],
      sourceAvailability: [{ calendarId: 'work', status: 'available' as const, complete: true }],
      events: [],
    };
    const applied = await cache.phoneCalendarSharing?.apply(
      ownerId,
      { command: 'snapshot', publisherId, expectedGeneration: 1, snapshot },
      now,
    );
    expect(applied).toMatchObject({ ok: true, state: { capturedAt: now.toISOString() } });
    expect(await readPhoneCalendars(cache, ownerId)).toMatchObject({
      capturedAt: now.toISOString(),
      selectionRevision: 1,
      calendars: [{ id: 'work', purpose: 'commitments' }],
    });

    const foreignPublisher = await cache.phoneCalendarSharing?.apply(
      ownerId,
      {
        command: 'enable',
        publisherId: 'other-device',
        expectedGeneration: 1,
        mutationId: 'foreign-enable',
        consentVersion: 1,
        calendars: [],
      },
      now,
    );
    expect(foreignPublisher).toMatchObject({ ok: false, error: 'publisher_conflict' });

    const revoked = await cache.phoneCalendarSharing?.apply(
      ownerId,
      { command: 'revoke', publisherId, expectedGeneration: 1 },
      now,
    );
    expect(revoked).toMatchObject({ ok: true, state: { generation: 2, enabled: false } });
    const restarted = createPostgresToolExecutionRepository(db);
    expect(await restarted.phoneCalendarSharing?.get(ownerId)).toMatchObject({
      generation: 2,
      enabled: false,
    });
    expect(await readPhoneCalendars(restarted, ownerId)).toBeNull();
    const [stored] = await db
      .select({ result: toolCache.result })
      .from(toolCache)
      .where(eq(toolCache.cacheKey, cacheKey));
    expect(stored?.result).toEqual({ disconnected: true });

    const pendingEnable = await restarted.phoneCalendarSharing?.apply(
      ownerId,
      {
        command: 'enable',
        publisherId,
        expectedGeneration: 2,
        mutationId: 'enable-2',
        consentVersion: 1,
        calendars: [{ id: 'work', name: 'Work', purpose: 'commitments' }],
      },
      now,
    );
    expect(pendingEnable?.ok).toBe(true);
    const cancelledPending = await restarted.phoneCalendarSharing?.apply(
      ownerId,
      {
        command: 'revoke',
        publisherId,
        expectedGeneration: 2,
        cancelPendingMutationId: 'enable-2',
      },
      now,
    );
    expect(cancelledPending).toMatchObject({
      ok: true,
      state: { generation: 4, enabled: false },
    });
  } finally {
    await db.delete(phoneCalendarSharing).where(eq(phoneCalendarSharing.agentId, ownerId));
    await db.delete(toolCache).where(eq(toolCache.cacheKey, cacheKey));
    await db.delete(agents).where(eq(agents.id, ownerId));
    await db.$client.end();
  }
});
