import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  type PhoneCalendarSharingState,
  phoneCalendarCacheKey,
  phoneCalendarCacheRecord,
  phoneCalendarCoverage,
  phoneCalendarSnapshotSchema,
  readPhoneCalendars,
  savePhoneCalendars,
  transitionPhoneCalendarSharing,
} from '@assistant/persistence';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresPhoneCalendarCompatibilityRepository } from './phone-calendar-compatibility.js';
import { createPostgresPrivacyErasureRepository } from './privacy-erasure-repository.js';
import { createPostgresPrivacyExportRepository } from './privacy-export-repository.js';
import { assertAllocatedTestTarget } from './test-target.js';
import { createPostgresToolExecutionRepository } from './tool-execution-repository.js';

const instant = '2026-10-22T18:00:00.000Z';
const legacy = {
  timeMin: instant,
  timeMax: '2026-10-23T18:00:00.000Z',
  timeZone: 'UTC',
  calendars: [{ id: 'work', name: 'Work' }],
  events: [],
};
const stateFor = (ownerId: string): PhoneCalendarSharingState => ({
  version: 1,
  ownerId,
  publisherId: 'publisher-private-token',
  generation: 4,
  enabled: true,
  consentVersion: 1,
  calendars: [{ id: 'work', name: 'Work', purpose: 'commitments' }],
  updatedAt: instant,
  capturedAt: instant,
  receivedAt: instant,
  timeMin: instant,
  timeMax: legacy.timeMax,
  complete: true,
  truncated: false,
});
function compatibilityCache(db: Db) {
  const repository = createPostgresToolExecutionRepository(db);
  const cache = {
    cacheGet: repository.cacheGet.bind(repository),
    cachePut: repository.cachePut.bind(repository),
    phoneCalendarCompatibility: repository.phoneCalendarCompatibility,
  };
  const legacyWriter = {
    cacheGet: repository.cacheGet.bind(repository),
    cachePut: repository.cachePut.bind(repository),
  };
  return { cache, legacyWriter, repository };
}
async function rolledBack(body: (db: Db, ownerId: string) => Promise<void>) {
  assertAllocatedTestTarget({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing allocated database URL');
  const db = createDb(databaseUrl);
  try {
    await expect(
      db.transaction(async (tx) => {
        const owners = await tx.query.agents.findMany({ columns: { id: true }, limit: 2 });
        if (owners.length !== 1 || !owners[0])
          throw new Error('Requires the isolated seeded owner');
        // The allocated database is migrated through schema 129 before Vitest.
        // Hide it only inside this transaction so both rollback protocol states
        // can be exercised without changing the durable test schema.
        await tx.execute(sql`drop table if exists public.phone_calendar_sharing`);
        await body(tx as unknown as Db, owners[0].id);
        throw new Error('rollback bridge fixture');
      }),
    ).rejects.toThrow('rollback bridge fixture');
  } finally {
    await db.$client.end();
  }
}
async function add129(db: Db) {
  const ddl = await readFile(
    new URL('./fixtures/phone-calendar-sharing-129.sql', import.meta.url),
    'utf8',
  );
  expect(createHash('sha256').update(ddl).digest('hex')).toBe(
    '09047938c28be5eb0232176d4452aea14960fe563dff097d7dbc467d62e51a6a',
  );
  for (const statement of ddl.split('--> statement-breakpoint').filter((value) => value.trim()))
    await db.execute(sql.raw(statement));
}
async function seedState(db: Db, ownerId: string, state = stateFor(ownerId)) {
  await db.execute(
    sql`insert into phone_calendar_sharing(id,agent_id,state) values (${ownerId},${ownerId},${JSON.stringify(state)}::jsonb)`,
  );
  const snapshot = phoneCalendarSnapshotSchema.parse({
    ...legacy,
    calendars: state.calendars,
    selectionRevision: 4,
    capturedAt: instant,
    complete: true,
    truncated: false,
    sourceAvailability: [{ calendarId: 'work', status: 'available', complete: true }],
    events: [
      {
        eventId: 'private-event',
        calendarId: 'work',
        summary: 'private-event-body',
        location: 'Private clinic',
        start: instant,
        end: '2026-10-22T19:00:00.000Z',
        allDay: false,
        blocksTime: true,
      },
    ],
  });
  const record = phoneCalendarCacheRecord(ownerId, snapshot, new Date(instant));
  await db.execute(
    sql`insert into tool_cache(cache_key,tool_name,result,expires_at) values (${record.cacheKey},${record.toolName},${JSON.stringify(record.result)}::jsonb, ${record.expiresAt.toISOString()}::timestamptz)`,
  );
}
it('runs legacy reads, export, and full privacy erasure with table 129 absent', async () =>
  rolledBack(async (db, ownerId) => {
    expect(
      (await db.execute(sql`select to_regclass('public.phone_calendar_sharing') as relation`))[0]
        ?.relation,
    ).toBeNull();
    const { cache, legacyWriter } = compatibilityCache(db);
    expect(await cache.phoneCalendarCompatibility?.read(ownerId)).toEqual({
      schema: 'legacy',
      state: null,
    });
    await expect(savePhoneCalendars(cache, ownerId, legacy)).rejects.toThrow(
      'Legacy calendar writes',
    );
    await savePhoneCalendars(legacyWriter, ownerId, legacy);
    expect((await readPhoneCalendars(cache, ownerId))?.calendars).toEqual(legacy.calendars);
    expect(
      (await createPostgresPrivacyExportRepository(db).exportOwnerData()).phoneCalendarSharing
        ?.state,
    ).toBeNull();
    const erasure = createPostgresPrivacyErasureRepository(db);
    await erasure.erase();
    await expect(readPhoneCalendars(cache, ownerId)).rejects.toThrow(
      'Privacy erasure is in progress',
    );
    for (const asset of await erasure.pendingAssets()) await erasure.assetDeleted(asset);
    await erasure.complete();
    expect(await readPhoneCalendars(cache, ownerId)).toBeNull();
  }));
it('safely rolls back over populated schema 129, exports consent, erases data, and rejects pre-erasure replay', async () =>
  rolledBack(async (db, ownerId) => {
    await add129(db);
    await seedState(db, ownerId);
    const { cache } = compatibilityCache(db);
    const snapshot = await readPhoneCalendars(cache, ownerId);
    expect(snapshot).toMatchObject({
      calendars: [{ id: 'work', name: 'Work' }],
      events: [],
      complete: false,
      selectionRevision: 4,
    });
    if (!snapshot) throw new Error('Missing selected-source coverage');
    expect(
      phoneCalendarCoverage(snapshot, legacy.timeMin, legacy.timeMax, new Date(instant)).complete,
    ).toBe(false);
    await expect(savePhoneCalendars(cache, ownerId, legacy)).rejects.toThrow(
      'Legacy calendar writes',
    );
    await expect(savePhoneCalendars(cache, ownerId, null)).rejects.toThrow(
      'Legacy calendar writes',
    );
    const exported = (await createPostgresPrivacyExportRepository(db).exportOwnerData())
      .phoneCalendarSharing;
    expect(exported).toMatchObject({
      scope: 'consent-metadata-only',
      eventCachePolicy: 'transient-event-cache-excluded',
      state: { generation: 4, calendars: [{ name: 'Work' }] },
    });
    expect(JSON.stringify(exported)).not.toMatch(
      /publisher-private-token|private-event-body|mutationId/,
    );
    await createPostgresPrivacyErasureRepository(db).erase();
    const cleanup = createPostgresPrivacyErasureRepository(db);
    for (const asset of await cleanup.pendingAssets()) await cleanup.assetDeleted(asset);
    await cleanup.complete();
    const tombstone = (await cache.phoneCalendarCompatibility?.read(ownerId))?.state;
    expect(tombstone).toMatchObject({
      generation: 5,
      publisherId: null,
      enabled: false,
      consentVersion: 0,
      calendars: [],
    });
    expect(await cache.cacheGet(phoneCalendarCacheKey(ownerId))).toBeNull();
    expect(await readPhoneCalendars(cache, ownerId)).toBeNull();
    if (!tombstone) throw new Error('Missing erasure tombstone');
    expect(
      transitionPhoneCalendarSharing(ownerId, tombstone, {
        command: 'enable',
        publisherId: 'publisher-private-token',
        expectedGeneration: 0,
        mutationId: 'delayed-enable',
        consentVersion: 1,
        calendars: [],
      }).result.ok,
    ).toBe(false);
    await createPostgresPrivacyErasureRepository(db).erase();
    for (const asset of await cleanup.pendingAssets()) await cleanup.assetDeleted(asset);
    await cleanup.complete();
    expect((await cache.phoneCalendarCompatibility?.read(ownerId))?.state?.generation).toBe(5);
    expect(
      JSON.stringify(
        (await createPostgresPrivacyExportRepository(db).exportOwnerData()).phoneCalendarSharing,
      ),
    ).not.toContain('Work');
  }));
it('fails closed for foreign or malformed sharing state on the rollback binary', async () =>
  rolledBack(async (db, ownerId) => {
    await add129(db);
    await seedState(db, ownerId, { ...stateFor(ownerId), ownerId: 'foreign-owner' });
    await expect(
      createPostgresPhoneCalendarCompatibilityRepository(db).read(ownerId),
    ).rejects.toThrow('ownership or state');
  }));
