import { randomUUID } from 'node:crypto';
import {
  type PhoneCalendarSharingCommand,
  readPhoneCalendars,
  savePhoneCalendars,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from './client.js';
import { agents, maintenanceCursors, phoneCalendarSharing, toolCache } from './schema.js';
import { createPostgresToolExecutionRepository } from './tool-execution-repository.js';

it('replaces and revokes owner-scoped phone snapshots in the portable PostgreSQL cache', async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing isolated test database');
  const db = createDb(url);
  const agentId = randomUUID();
  const cacheKey = `phone-calendars:v1:${agentId}`;
  try {
    await db.insert(agents).values({
      id: agentId,
      name: 'Calendar owner',
      email: `${agentId}@test.local`,
      workspacePrefix: `workspace/${agentId}`,
    });
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
    await expect(readPhoneCalendars(cache, randomUUID())).rejects.toThrow(
      'Privacy owner row is unavailable',
    );
    expect(await readPhoneCalendars(cache, agentId)).toBeNull();
    expect(await readPhoneCalendars(legacyCache, randomUUID())).toBeNull();
    await savePhoneCalendars(legacyCache, agentId, null);
    expect(await readPhoneCalendars(legacyCache, agentId)).toBeNull();
    const [stored] = await db.select().from(toolCache).where(eq(toolCache.cacheKey, cacheKey));
    expect(stored?.result).toEqual({ disconnected: true });
  } finally {
    await db.delete(toolCache).where(eq(toolCache.cacheKey, cacheKey));
    await db.delete(agents).where(eq(agents.id, agentId));
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
    expect(await cache.phoneCalendarSharing?.readSnapshot?.(ownerId, now)).toMatchObject({
      state: { enabled: true, generation: 1 },
      snapshot: { selectionRevision: 1, calendars: [{ id: 'work', purpose: 'commitments' }] },
    });
    expect(
      await cache.phoneCalendarSharing?.readSnapshot?.(
        ownerId,
        new Date(now.getTime() + 8 * 86_400_000),
      ),
    ).toMatchObject({ state: { enabled: true, generation: 1 }, snapshot: null });

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
    expect(await restarted.phoneCalendarSharing?.readSnapshot?.(ownerId, now)).toMatchObject({
      state: { enabled: false, generation: 2 },
      snapshot: null,
    });
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

it('rejects sharing state and snapshot reads while privacy erasure is active', async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing isolated test database');
  const db = createDb(url);
  const ownerId = randomUUID();
  const fenceName = `privacy-erasure-active:${ownerId}`;
  try {
    await db.insert(agents).values({
      id: ownerId,
      name: 'Calendar owner',
      email: `${ownerId}@test.local`,
      workspacePrefix: `workspace/${ownerId}`,
    });
    await db.insert(maintenanceCursors).values({
      name: fenceName,
      cursor: JSON.stringify({
        version: 1,
        generation: randomUUID(),
        phase: 'attachments',
        afterId: null,
      }),
      updatedAt: new Date(),
    });
    const repository = createPostgresToolExecutionRepository(db);
    await expect(repository.phoneCalendarSharing?.get(ownerId)).rejects.toThrow(/privacy erasure/i);
    await expect(repository.phoneCalendarSharing?.readSnapshot?.(ownerId)).rejects.toThrow(
      /privacy erasure/i,
    );
    await expect(readPhoneCalendars(repository, ownerId)).rejects.toThrow(/privacy erasure/i);
  } finally {
    await db.delete(maintenanceCursors).where(eq(maintenanceCursors.name, fenceName));
    await db.delete(phoneCalendarSharing).where(eq(phoneCalendarSharing.agentId, ownerId));
    await db.delete(toolCache).where(eq(toolCache.cacheKey, `phone-calendars:v1:${ownerId}`));
    await db.delete(agents).where(eq(agents.id, ownerId));
    await db.$client.end();
  }
});

it('returns coherent state and snapshot values during concurrent selection and revoke smoke races', async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing isolated test database');
  const db = createDb(url);
  const ownerId = randomUUID();
  const publisherId = 'device-publisher';
  const cacheKey = `phone-calendars:v1:${ownerId}`;
  const now = new Date('2026-10-22T12:00:00Z');
  const work = [{ id: 'work', name: 'Work', purpose: 'commitments' as const }];
  try {
    await db.insert(agents).values({
      id: ownerId,
      name: 'Calendar owner',
      email: `${ownerId}@test.local`,
      workspacePrefix: `workspace/${ownerId}`,
    });
    const repository = createPostgresToolExecutionRepository(db);
    await repository.phoneCalendarSharing?.apply(
      ownerId,
      {
        command: 'enable',
        publisherId,
        expectedGeneration: 0,
        mutationId: 'enable-1',
        consentVersion: 1,
        calendars: work,
      },
      now,
    );
    const snapshot = {
      capturedAt: now.toISOString(),
      selectionRevision: 1,
      complete: true,
      truncated: false,
      timeMin: '2026-10-21T00:00:00Z',
      timeMax: '2026-10-29T00:00:00Z',
      timeZone: 'UTC',
      calendars: work,
      sourceAvailability: [{ calendarId: 'work', status: 'available' as const, complete: true }],
      events: [],
    };
    await repository.phoneCalendarSharing?.apply(
      ownerId,
      { command: 'snapshot', publisherId, expectedGeneration: 1, snapshot },
      now,
    );

    // This is a scheduling smoke test; the forced lock ordering is covered below.
    const [changed, observed] = await Promise.all([
      repository.phoneCalendarSharing?.apply(
        ownerId,
        {
          command: 'select',
          publisherId,
          expectedGeneration: 1,
          mutationId: 'select-2',
          consentVersion: 1,
          calendars: [{ id: 'family', name: 'Family', purpose: 'unspecified' }],
        },
        now,
      ),
      repository.phoneCalendarSharing?.readSnapshot?.(ownerId, now),
    ]);
    expect(changed).toMatchObject({ ok: true, state: { generation: 2 } });
    expect([1, 2]).toContain(observed?.state?.generation);
    if (observed?.state?.generation === 1) {
      expect(observed.snapshot).toMatchObject({ selectionRevision: 1, calendars: work });
    } else {
      expect(observed?.snapshot).toBeNull();
      expect(observed?.state?.calendars).toEqual([
        { id: 'family', name: 'Family', purpose: 'unspecified' },
      ]);
    }
    expect(await repository.phoneCalendarSharing?.readSnapshot?.(ownerId, now)).toMatchObject({
      state: { generation: 2 },
      snapshot: null,
    });

    const family = [{ id: 'family', name: 'Family', purpose: 'unspecified' as const }];
    const familySnapshot = {
      ...snapshot,
      selectionRevision: 2,
      calendars: family,
      sourceAvailability: [{ calendarId: 'family', status: 'available' as const, complete: true }],
    };
    await repository.phoneCalendarSharing?.apply(
      ownerId,
      { command: 'snapshot', publisherId, expectedGeneration: 2, snapshot: familySnapshot },
      now,
    );
    const [revoked, revokeRead] = await Promise.all([
      repository.phoneCalendarSharing?.apply(
        ownerId,
        { command: 'revoke', publisherId, expectedGeneration: 2 },
        now,
      ),
      repository.phoneCalendarSharing?.readSnapshot?.(ownerId, now),
    ]);
    expect(revoked).toMatchObject({ ok: true, state: { generation: 3, enabled: false } });
    expect([2, 3]).toContain(revokeRead?.state?.generation);
    if (revokeRead?.state?.generation === 2) {
      expect(revokeRead.snapshot).toMatchObject({ selectionRevision: 2, calendars: family });
    } else {
      expect(revokeRead?.snapshot).toBeNull();
    }
    expect(await repository.phoneCalendarSharing?.readSnapshot?.(ownerId, now)).toMatchObject({
      state: { generation: 3, enabled: false },
      snapshot: null,
    });
  } finally {
    await db.delete(phoneCalendarSharing).where(eq(phoneCalendarSharing.agentId, ownerId));
    await db.delete(toolCache).where(eq(toolCache.cacheKey, cacheKey));
    await db.delete(agents).where(eq(agents.id, ownerId));
    await db.$client.end();
  }
});

it('holds a calendar snapshot read ahead of a queued selection update', async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing isolated test database');
  const db = createDb(url);
  const ownerId = randomUUID();
  const publisherId = 'device-publisher';
  const cacheKey = `phone-calendars:v1:${ownerId}`;
  const now = new Date('2026-10-22T12:00:00Z');
  const work = [{ id: 'work', name: 'Work', purpose: 'commitments' as const }];
  const lockName = `assistant:phone-calendar-sharing:${ownerId}`;
  let releaseBlocker!: () => void;
  let signalLocked!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  let blocker: Promise<unknown> | undefined;
  try {
    await db.insert(agents).values({
      id: ownerId,
      name: 'Calendar owner',
      email: `${ownerId}@test.local`,
      workspacePrefix: `workspace/${ownerId}`,
    });
    const repository = createPostgresToolExecutionRepository(db);
    await repository.phoneCalendarSharing?.apply(
      ownerId,
      {
        command: 'enable',
        publisherId,
        expectedGeneration: 0,
        mutationId: 'enable-1',
        consentVersion: 1,
        calendars: work,
      },
      now,
    );
    const snapshot = {
      capturedAt: now.toISOString(),
      selectionRevision: 1,
      complete: true,
      truncated: false,
      timeMin: '2026-10-21T00:00:00Z',
      timeMax: '2026-10-29T00:00:00Z',
      timeZone: 'UTC',
      calendars: work,
      sourceAvailability: [{ calendarId: 'work', status: 'available' as const, complete: true }],
      events: [],
    };
    await repository.phoneCalendarSharing?.apply(
      ownerId,
      { command: 'snapshot', publisherId, expectedGeneration: 1, snapshot },
      now,
    );

    blocker = db.$client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`;
      signalLocked();
      await hold;
    });
    await locked;

    const reading = repository.phoneCalendarSharing?.readSnapshot?.(ownerId, now);
    if (!reading) throw new Error('Atomic phone calendar snapshot reader is unavailable');
    const [lockKeyRow] = await db.$client<{ lockKey: string }[]>`
      select hashtextextended(${lockName}, 0)::text as "lockKey"
    `;
    if (!lockKeyRow) throw new Error('Could not resolve the controlled advisory lock key');
    const lockKey = BigInt.asUintN(64, BigInt(lockKeyRow.lockKey));
    const lockHigh = Number(lockKey >> 32n);
    const lockLow = Number(lockKey & 0xffff_ffffn);
    const waitUntil = async (predicate: () => Promise<boolean>, message: string) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(message);
    };
    await waitUntil(async () => {
      const rows = await db.$client`
          select 1 from pg_locks l
          join pg_stat_activity a on a.pid = l.pid
          where a.datname = current_database()
            and l.locktype = 'advisory' and l.granted = false
            and l.classid = ${lockHigh}::oid and l.objid = ${lockLow}::oid and l.objsubid = 1
        `;
      return rows.length > 0;
    }, 'Calendar snapshot read did not queue behind the controlled advisory lock');

    const selecting = repository.phoneCalendarSharing?.apply(
      ownerId,
      {
        command: 'select',
        publisherId,
        expectedGeneration: 1,
        mutationId: 'select-2',
        consentVersion: 1,
        calendars: [{ id: 'family', name: 'Family', purpose: 'unspecified' }],
      },
      now,
    );
    if (!selecting) throw new Error('Phone calendar selection writer is unavailable');
    await waitUntil(async () => {
      const rows = await db.$client`
          select 1 from pg_stat_activity
          where datname = current_database() and state = 'active'
            and wait_event_type = 'Lock' and query ilike '%for no key update%'
        `;
      return rows.length > 0;
    }, 'Calendar selection update did not queue behind the privacy observation fence');

    releaseBlocker();
    await blocker;
    const [observed, changed] = await Promise.all([reading, selecting]);
    expect(observed).toMatchObject({
      state: { generation: 1, enabled: true },
      snapshot: { selectionRevision: 1, calendars: work },
    });
    expect(changed).toMatchObject({ ok: true, state: { generation: 2 } });
    expect(await repository.phoneCalendarSharing?.readSnapshot?.(ownerId, now)).toMatchObject({
      state: { generation: 2 },
      snapshot: null,
    });
  } finally {
    releaseBlocker();
    if (blocker) await blocker;
    await db.delete(phoneCalendarSharing).where(eq(phoneCalendarSharing.agentId, ownerId));
    await db.delete(toolCache).where(eq(toolCache.cacheKey, cacheKey));
    await db.delete(agents).where(eq(agents.id, ownerId));
    await db.$client.end();
  }
});
