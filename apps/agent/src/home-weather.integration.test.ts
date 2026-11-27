import { randomUUID } from 'node:crypto';
import { saveHomeWeather } from '@assistant/application/home-weather';
import { loadConfig } from '@assistant/config';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import { getAmbientBlock } from '@assistant/core/memory/ambient';
import { assessProactiveCanaries } from '@assistant/core/proactive/pipeline-health';
import {
  agents,
  assertPostgresInstallationOwner,
  createPostgresExecutionPersistence,
  createPostgresHomeWeatherRepository,
  createPostgresPrivacyErasureRepository,
  type Db,
  locationPings,
  messages,
  readPostgresSavedBriefing,
} from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreOwnerContextRepository,
  FirestoreOwnerNoticeRepository,
  FirestorePrivacyErasureRepository,
} from '@assistant/firestore';
import type { HomeWeatherRepository } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportWorkspaceSnapshot } from '../../../packages/db/src/workspace-migration.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { importWorkspaceBundle } from '../../../packages/firestore/src/workspace-migration.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';

const SPACE = { provider: 'synthetic', model: 'home-weather', dimensions: 1536, revision: '1' };
const HOME = 'Juniper Bay';
const ZONE = 'America/Los_Angeles';
const FOREIGN_HOME = {
  revision: randomUUID(),
  city: 'Silver Harbor',
  enabled: true,
  lat: 36.5,
  lng: -119.5,
};
const DAY_ONE = new Date('2026-11-20T07:20:00Z');
const DAY_TWO = new Date('2026-11-20T08:10:00Z');
type Persistence = ReturnType<typeof createPostgresExecutionPersistence>;

interface Fixture {
  agentId: string;
  db: Db;
  persistence: Persistence;
  settings(): HomeWeatherRepository;
  olderPhonePing(agentId: string, at: Date): Promise<() => Promise<unknown>>;
  foreignOwner(): Promise<{ id: string; remove: () => Promise<unknown> }>;
  readBriefing(taskId: string): Promise<unknown>;
  readStoredChoice(): Promise<unknown>;
  erase: ReturnType<typeof createPostgresPrivacyErasureRepository>['erase'];
  close(): Promise<void>;
}

function owner(id: string) {
  return {
    id,
    name: 'Fixture assistant',
    email: `${id}@example.test`,
    timezone: ZONE,
    workspacePrefix: 'synthetic',
    createdAt: new Date('2026-11-10T00:00:00Z'),
    updatedAt: new Date('2026-11-10T00:00:00Z'),
  };
}

function ping(agentId: string, capturedAt: Date) {
  return {
    id: randomUUID(),
    agentId,
    lat: '61.7',
    lng: '-115.9',
    label: 'Other Town',
    source: 'ios-app',
    accuracyM: 50,
    capturedAt,
  };
}

async function postgresFixture(): Promise<Fixture> {
  const { db, close } = await createIsolatedTestDatabase();
  const agentId = await assertPostgresInstallationOwner(db);
  await db.update(agents).set({ timezone: ZONE }).where(eq(agents.id, agentId));
  return {
    db,
    agentId,
    persistence: createPostgresExecutionPersistence(db),
    settings: () => createPostgresHomeWeatherRepository(db),
    async olderPhonePing(id, at) {
      const row = ping(id, at);
      await db.insert(locationPings).values(row);
      return async () => db.delete(locationPings).where(eq(locationPings.id, row.id));
    },
    async foreignOwner() {
      const id = randomUUID();
      await db.insert(agents).values({ ...owner(id), homeWeather: FOREIGN_HOME });
      return { id, remove: async () => db.delete(agents).where(eq(agents.id, id)) };
    },
    async readBriefing(taskId) {
      const receipt = await readPostgresSavedBriefing(db, agentId, taskId);
      if (!receipt) throw new Error('Missing PostgreSQL briefing receipt');
      const [row] = await db
        .select({ parts: messages.parts })
        .from(messages)
        .where(eq(messages.id, receipt.messageId));
      return row?.parts;
    },
    async readStoredChoice() {
      const [row] = await db
        .select({ choice: agents.homeWeather })
        .from(agents)
        .where(eq(agents.id, agentId));
      return row?.choice;
    },
    erase: () => createPostgresPrivacyErasureRepository(db).erase(),
    close,
  };
}

async function firestoreFixture(): Promise<Fixture> {
  const store = emulatorStore();
  const agentId = randomUUID();
  await store.doc('agents', agentId).set(owner(agentId));
  const persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
  return {
    db: new Proxy(
      {},
      {
        get() {
          throw new Error('Unexpected PostgreSQL access');
        },
      },
    ) as Db,
    agentId,
    persistence,
    settings: () => new FirestoreOwnerContextRepository(store),
    async olderPhonePing(id, at) {
      const row = ping(id, at);
      const ref = store.doc('locationPings', row.id);
      await ref.set({ ...row, createdAt: at });
      return async () => ref.delete();
    },
    async foreignOwner() {
      const id = randomUUID();
      const ref = store.doc('agents', id);
      await ref.set({ ...owner(id), homeWeather: FOREIGN_HOME });
      return { id, remove: async () => ref.delete() };
    },
    async readBriefing(taskId) {
      const receipt = await new FirestoreOwnerNoticeRepository(
        store,
        agentId,
      ).readBriefingPublication(agentId, taskId);
      if (!receipt) throw new Error('Missing Firestore briefing receipt');
      return (await store.doc('messages', receipt.messageId).get()).get('parts');
    },
    async readStoredChoice() {
      return (await store.doc('agents', agentId).get()).get('homeWeather');
    },
    erase: () => new FirestorePrivacyErasureRepository(store, agentId).erase(),
    close: () => disposeStore(store),
  };
}

function scriptWeather() {
  let next = { date: '2026-11-19', temp: 13 };
  const forecastRequests: string[] = [];
  const geocodes: string[] = [];
  let beforeForecast: (() => Promise<void>) | undefined;
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'geocoding-api.open-meteo.com') {
      geocodes.push(url.searchParams.get('name') ?? '');
      return Response.json({ results: [{ name: HOME, latitude: 38.5, longitude: -120.5 }] });
    }
    if (url.hostname !== 'api.open-meteo.com') throw new Error('Unexpected fixture request');
    forecastRequests.push(
      `${url.searchParams.get('latitude')},${url.searchParams.get('longitude')}`,
    );
    const applyBeforeForecast = beforeForecast;
    beforeForecast = undefined;
    await applyBeforeForecast?.();
    return Response.json({
      timezone: ZONE,
      current: { temperature_2m: next.temp, weather_code: 0, wind_speed_10m: 8 },
      daily: {
        time: [next.date],
        weather_code: [0],
        temperature_2m_max: [next.temp + 2],
        temperature_2m_min: [next.temp - 2],
        precipitation_probability_max: [0],
      },
    });
  });
  return {
    forecastRequests,
    geocodes,
    next(value: typeof next) {
      next = value;
    },
    beforeForecast(fn: () => Promise<void>) {
      beforeForecast = fn;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([
  { driver: 'PostgreSQL', open: postgresFixture, skip: false },
  { driver: 'Firestore', open: firestoreFixture, skip: !process.env.FIRESTORE_EMULATOR_HOST },
])('$driver Home weather', ({ open, skip }) => {
  it.skipIf(skip)(
    'uses the right Home on successive local days and revokes cached weather',
    async () => {
      const fixture = await open();
      const { db, agentId, persistence } = fixture;
      const script = scriptWeather();
      const config = loadConfig();
      async function canary() {
        if (!persistence.proactiveCanaries) throw new Error('Missing canary repository');
        return assessProactiveCanaries(persistence.proactiveCanaries, agentId, config);
      }
      const deps = {
        db,
        persistence,
        router: {
          object: vi.fn(async () => ({
            ok: true,
            modelId: 'fixture',
            object: { lead: 'A fixture task needs a decision.' },
          })),
        } as unknown as ExecutorDeps['router'],
        dispatcher: { toolDefs: () => [] } as unknown as ExecutorDeps['dispatcher'],
        calendarReader: async () => ({ complete: true, events: [] }),
      };

      async function run(job: 'ambient.refresh' | 'briefing.compose') {
        const { task } = await persistence.tasks.createTask({
          agentId,
          type: 'scheduled',
          trust: 'assistant',
          trigger: { source: 'schedule', payload: { job } },
        });
        const result = await executeTask(deps, task.id);
        return { id: task.id, result };
      }

      async function briefingWeather() {
        const { task } = await persistence.tasks.createTask({
          agentId,
          type: 'adhoc',
          trust: 'owner',
          title: 'Synthetic follow-up',
          trigger: { source: 'owner', payload: {} },
        });
        const lease = await persistence.tasks.claim(task.id);
        if (!lease) throw new Error('Missing fixture task lease');
        expect(await persistence.tasks.markTaskNeedsAttention(lease, 'Synthetic follow-up')).toBe(
          true,
        );
        const { id, result } = await run('briefing.compose');
        expect(result.outcome, result.detail).toBe('done');
        expect(result.detail).toMatch(/^briefing: delivered/);
        const parts = await fixture.readBriefing(id);
        expect(parts).toEqual(expect.any(Array));
        return JSON.stringify(parts);
      }

      try {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(DAY_ONE);
        expect(await fixture.settings().getHomeWeather(agentId)).toBeNull();
        expect((await canary()).weather.state).toBe('not_configured');
        const choice = await saveHomeWeather(fixture.settings(), agentId, {
          city: HOME,
          enabled: true,
        });
        expect(choice).toMatchObject({ saved: true, choice: { city: HOME, enabled: true } });
        const reopened = await fixture.settings().getHomeWeather(agentId);
        expect(reopened).toEqual(choice.saved && choice.choice);
        expect((await canary()).weather.state).toBe('unavailable');

        // No device publisher is running. Retain one old fix from another town.
        const removePing = await fixture.olderPhonePing(
          agentId,
          new Date(DAY_ONE.getTime() - 45 * 60_000),
        );
        expect((await run('ambient.refresh')).result).toEqual({
          outcome: 'done',
          detail: 'ambient: refreshed (saved home + weather)',
        });
        const first = await persistence.ownerContext.getAmbientSnapshot(agentId);
        expect(first?.sources).toMatchObject({
          home: { revision: reopened?.revision },
          weather: { todayDate: '2026-11-19', tempC: 13, fetchedAt: DAY_ONE.toISOString() },
        });
        expect(first?.sources).not.toHaveProperty('location');
        expect(first?.flags).toMatchObject({ has_location: false, has_weather: true });
        const briefOne = await briefingWeather();
        expect(briefOne).toContain('Home · Juniper Bay');
        expect(briefOne).toContain('13°C');
        expect(briefOne).not.toContain('Other Town');
        expect((await canary()).weather).toEqual({
          state: 'fresh',
          observedAt: DAY_ONE.toISOString(),
        });
        await removePing();

        // The UTC date is the same but Home crossed midnight within the weather TTL.
        vi.setSystemTime(DAY_TWO);
        expect((await canary()).weather.state).toBe('expired');
        expect(await getAmbientBlock(persistence.ownerContext, agentId)).toBeUndefined();
        // A newly fetched response carrying yesterday's weather is still unavailable.
        expect((await run('ambient.refresh')).result.detail).toBe(
          'ambient: refreshed (saved home, no weather)',
        );
        expect((await canary()).weather.state).toBe('unavailable');
        expect(await getAmbientBlock(persistence.ownerContext, agentId)).toBeUndefined();
        script.next({ date: '2026-11-20', temp: 7 });
        expect((await run('ambient.refresh')).result.detail).toBe(
          'ambient: refreshed (saved home + weather)',
        );
        const second = await persistence.ownerContext.getAmbientSnapshot(agentId);
        expect(second?.sources).toMatchObject({
          home: { revision: reopened?.revision },
          weather: { todayDate: '2026-11-20', tempC: 7, fetchedAt: DAY_TWO.toISOString() },
        });
        const briefTwo = await briefingWeather();
        expect(briefTwo).toContain('Home · Juniper Bay');
        expect(briefTwo).toContain('7°C');
        expect((await canary()).weather).toEqual({
          state: 'fresh',
          observedAt: DAY_TWO.toISOString(),
        });

        const foreign = await fixture.foreignOwner();
        try {
          expect(await fixture.settings().getHomeWeather(foreign.id)).toEqual(FOREIGN_HOME);
          expect(await getAmbientBlock(persistence.ownerContext, foreign.id)).toBeUndefined();
          expect(await fixture.settings().setHomeWeather(foreign.id, reopened)).toBe(false);
          expect(await fixture.settings().getHomeWeather(agentId)).toEqual(reopened);
          expect(await fixture.settings().getHomeWeather(foreign.id)).toEqual(FOREIGN_HOME);
        } finally {
          await foreign.remove();
        }
        expect(
          await saveHomeWeather(fixture.settings(), agentId, { city: HOME, enabled: false }),
        ).toMatchObject({ saved: true, choice: { enabled: false } });
        expect(await getAmbientBlock(persistence.ownerContext, agentId)).toBeUndefined();
        expect((await canary()).weather.state).toBe('not_configured');
        expect((await run('ambient.refresh')).result.detail).toContain('snapshot cleared');
        expect(await persistence.ownerContext.getAmbientSnapshot(agentId)).toBeNull();
        expect(await briefingWeather()).not.toContain('Juniper Bay');
        expect(script.geocodes).toEqual([HOME]);
        expect(script.forecastRequests).toEqual(Array(3).fill('38.5,-120.5'));

        // A provider response started before revocation must not recreate the cache.
        await saveHomeWeather(fixture.settings(), agentId, { city: HOME, enabled: true });
        script.beforeForecast(async () => {
          const result = await saveHomeWeather(fixture.settings(), agentId, {
            city: HOME,
            enabled: false,
          });
          expect(result.saved).toBe(true);
        });
        expect((await run('ambient.refresh')).result.outcome).toBe('failed');
        expect(await persistence.ownerContext.getAmbientSnapshot(agentId)).toBeNull();

        await saveHomeWeather(fixture.settings(), agentId, { city: HOME, enabled: true });
        await run('ambient.refresh');
        expect(await persistence.ownerContext.getAmbientSnapshot(agentId)).not.toBeNull();
        await fixture.erase();
        expect(await fixture.readStoredChoice()).toBeNull();
        expect(await fixture.settings().getHomeWeather(agentId)).toBeNull();
        expect(await persistence.ownerContext.getAmbientSnapshot(agentId)).toBeNull();
        expect(await persistence.executionContext.getAgent(agentId)).toMatchObject({ id: agentId });
      } finally {
        vi.useRealTimers();
        await fixture.close();
      }
    },
    55_000,
  );
});

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'preserves the owner-scoped Home choice through the PostgreSQL-to-Firestore workspace transfer',
  async () => {
    const { db, databaseUrl, close } = await createIsolatedTestDatabase();
    const store = emulatorStore();
    const target = {
      projectId: 'demo-assistant-test',
      databaseId: '(default)',
      installationId: store.installationId,
    };
    try {
      const agentId = await assertPostgresInstallationOwner(db);
      const fixture = scriptWeather();
      const saved = await saveHomeWeather(createPostgresHomeWeatherRepository(db), agentId, {
        city: HOME,
        enabled: true,
      });
      expect(saved.saved).toBe(true);
      const bundle = await exportWorkspaceSnapshot({
        databaseUrl,
        agentId,
        target,
        tables: ['agents'],
      });
      expect(bundle.records[0]?.data.homeWeather).toEqual(saved.saved && saved.choice);
      await importWorkspaceBundle(store, bundle, { sourceAgentId: agentId, target, mode: 'write' });
      expect(await new FirestoreOwnerContextRepository(store).getHomeWeather(agentId)).toEqual(
        saved.saved && saved.choice,
      );
      expect(fixture.forecastRequests).toEqual([]);
    } finally {
      await disposeStore(store);
      await close();
    }
  },
  55_000,
);
