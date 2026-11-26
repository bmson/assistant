import { randomUUID } from 'node:crypto';
import { recordOwnerForeground, recordOwnerForegroundWithRepository } from '@assistant/application';
import {
  dispatchOutbox,
  type ExecutorDeps,
  executeTask,
  findDueTasks,
  runBriefing,
  runDueSchedules,
} from '@assistant/core';
import { getAmbientBlock } from '@assistant/core/memory/ambient';
import {
  agents,
  assertPostgresInstallationOwner,
  createDb,
  createPostgresExecutionPersistence,
  createPostgresHomeWeatherRepository,
  createPostgresScheduleRepository,
  type Db,
  locationPings,
  maintenanceCursors,
  messages,
  readPostgresSavedBriefing,
  schedules,
  tasks,
} from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreOutbox,
  FirestoreOwnerContextRepository,
  FirestoreScheduleRepository,
  InstallationStore,
  readFirestoreSavedBriefing,
} from '@assistant/firestore';
import {
  briefingCursorName,
  DAILY_BRIEFING,
  type HomeWeatherSettings,
  type Records,
  readBriefingWatchdogRecord,
} from '@assistant/persistence';
import { Firestore } from '@google-cloud/firestore';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';

const zone = 'America/Los_Angeles';
const localDate = (day: number) => `2026-12-${String(day).padStart(2, '0')}`;
const time = (day: number, minute: number) =>
  new Date(`${localDate(day)}T07:${String(minute).padStart(2, '0')}:00-08:00`);
const home = { city: 'Juniper Bay', revision: randomUUID(), enabled: true, lat: 38.5, lng: -120.5 };
const cron = { [DAILY_BRIEFING]: '45 7 * * *', 'ambient-refresh': '*/30 * * * *' };
const job = { [DAILY_BRIEFING]: 'briefing.compose', 'ambient-refresh': 'ambient.refresh' };
type Job = keyof typeof job;

interface Fixture {
  close(): Promise<void>;
  restart(): Promise<void>;
  setHome(choice: HomeWeatherSettings): Promise<boolean>;
  stalePing(): Promise<void>;
  news(): Promise<void>;
  archiveNews(): Promise<void>;
  ambient(): Promise<string | undefined>;
  foreground(): Promise<{ wakeBriefFired: boolean }>;
  tick(): Promise<{ schedule: string; taskId: string }[]>;
  drain(): Promise<void>;
  replay(task: Records['tasks']): Promise<unknown>;
  taskRows(): Promise<Records['tasks'][]>;
  completion(): Promise<ReturnType<typeof readBriefingWatchdogRecord>>;
  read(taskId: string): Promise<{ id: string; parts: unknown[] } | null>;
}

function executor(db: Db, persistence: ExecutorDeps['persistence']): ExecutorDeps {
  return {
    db,
    persistence,
    router: {
      object: vi.fn(async () => ({
        ok: true,
        modelId: 'synthetic',
        object: { lead: 'One synthetic task needs your attention.' },
      })),
    } as unknown as ExecutorDeps['router'],
    dispatcher: { toolDefs: () => [] } as unknown as ExecutorDeps['dispatcher'],
    calendarReader: async () => ({ complete: true, events: [] }),
  };
}

async function postgres(): Promise<Fixture> {
  const target = await createIsolatedTestDatabase();
  const agentId = await assertPostgresInstallationOwner(target.db);
  let db = target.db;
  await db.update(agents).set({ timezone: zone }).where(eq(agents.id, agentId));
  await db.update(schedules).set({ enabled: false });
  const repo = createPostgresScheduleRepository(db);
  for (const name of Object.keys(cron) as Job[]) {
    const row = await repo.getByName(agentId, name);
    if (!row) throw new Error(`Missing seeded schedule ${name}`);
    await db
      .update(schedules)
      .set({
        enabled: true,
        nextRunAt: time(1, name === DAILY_BRIEFING ? 45 : 30),
      })
      .where(eq(schedules.id, row.id));
  }
  const newsId = randomUUID();
  return {
    async close() {
      if (db !== target.db) await db.$client.end();
      await target.close();
    },
    async restart() {
      if (db !== target.db) await db.$client.end();
      db = createDb(target.databaseUrl);
    },
    setHome: (choice) => createPostgresHomeWeatherRepository(db).setHomeWeather(agentId, choice),
    stalePing: async () => {
      await db.insert(locationPings).values({
        agentId,
        lat: '51.5',
        lng: '-0.1',
        label: 'Other Town',
        accuracyM: 30,
        source: 'ios-app',
        capturedAt: new Date(time(1, 30).getTime() - 45 * 60_000),
      });
    },
    news: async () => {
      await db
        .insert(tasks)
        .values({
          id: newsId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'needs_attention',
          title: 'Review the synthetic task',
          progress: 'Decision required.',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({ target: tasks.id, set: { updatedAt: new Date(), archivedAt: null } });
    },
    archiveNews: async () => {
      await db.update(tasks).set({ archivedAt: new Date() }).where(eq(tasks.id, newsId));
    },
    ambient: () => getAmbientBlock(db, agentId),
    foreground: () => recordOwnerForeground(db),
    tick: () => runDueSchedules(db, zone),
    async drain() {
      const deps = executor(db, createPostgresExecutionPersistence(db));
      for (const task of await findDueTasks(db, 50))
        await executeTask(deps, task.id, task.queueGeneration);
    },
    async replay(task) {
      const result = await runBriefing(executor(db, createPostgresExecutionPersistence(db)), {
        agentId,
        taskId: task.id,
        trigger: task.trigger,
      });
      return result.outcome;
    },
    taskRows: () => db.select().from(tasks).where(eq(tasks.agentId, agentId)),
    async completion() {
      const schedule = await createPostgresScheduleRepository(db).getByName(
        agentId,
        DAILY_BRIEFING,
      );
      if (!schedule) throw new Error('Missing daily briefing schedule');
      const [row] = await db
        .select({ cursor: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, briefingCursorName(agentId, schedule.id)));
      return readBriefingWatchdogRecord(row?.cursor);
    },
    async read(taskId) {
      const receipt = await readPostgresSavedBriefing(db, agentId, taskId);
      if (!receipt) return null;
      const [message] = await db.select().from(messages).where(eq(messages.id, receipt.messageId));
      return message ? { id: message.id, parts: message.parts as unknown[] } : null;
    },
  };
}

async function firestore(): Promise<Fixture> {
  let store = emulatorStore(() => new Date());
  const agentId = randomUUID();
  await store.doc('agents', agentId).set({
    id: agentId,
    name: 'Synthetic owner',
    email: 'owner@example.invalid',
    timezone: zone,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const repo = new FirestoreScheduleRepository(store);
  for (const name of Object.keys(cron) as Job[]) {
    await repo.ensure({
      agentId,
      name,
      enabled: true,
      cron: cron[name],
      nextRunAt: time(1, name === DAILY_BRIEFING ? 45 : 30),
      taskTemplate: { type: 'scheduled', job: job[name] },
    });
  }
  const newsId = randomUUID();
  const forbiddenDb = new Proxy(
    {},
    {
      get() {
        throw new Error('Unexpected SQL access');
      },
    },
  ) as Db;
  const depsForStore = () =>
    executor(
      forbiddenDb,
      createFirestoreExecutionPersistence(store, agentId, {
        provider: 'synthetic',
        model: 'daily-home-weather',
        dimensions: 1536,
        revision: '1',
      }),
    );
  return {
    close: () => disposeStore(store),
    async restart() {
      const installationId = store.installationId;
      await store.db.terminate();
      store = new InstallationStore(
        new Firestore({ projectId: 'demo-assistant-test', databaseId: '(default)' }),
        installationId,
        () => new Date(),
      );
    },
    setHome: (choice) => new FirestoreOwnerContextRepository(store).setHomeWeather(agentId, choice),
    stalePing: async () => {
      const id = randomUUID();
      await store.doc('locationPings', id).set({
        id,
        agentId,
        lat: '51.5',
        lng: '-0.1',
        label: 'Other Town',
        accuracyM: 30,
        source: 'ios-app',
        capturedAt: new Date(time(1, 30).getTime() - 45 * 60_000),
        createdAt: new Date(),
      });
    },
    news: async () => {
      await store.doc('tasks', newsId).set({
        id: newsId,
        agentId,
        type: 'adhoc',
        trust: 'owner',
        status: 'needs_attention',
        title: 'Review the synthetic task',
        progress: 'Decision required.',
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    },
    archiveNews: async () => {
      await store.doc('tasks', newsId).update({ archivedAt: new Date() });
    },
    ambient: () => getAmbientBlock(new FirestoreOwnerContextRepository(store), agentId),
    foreground: () =>
      recordOwnerForegroundWithRepository(new FirestoreScheduleRepository(store), {
        id: agentId,
        timezone: zone,
      }),
    tick: () => runDueSchedules(new FirestoreScheduleRepository(store), zone),
    async drain() {
      const deps = depsForStore();
      const wake = await dispatchOutbox(
        new FirestoreOutbox(store),
        {
          enqueue: async (id, generation) => {
            await executeTask(deps, id, generation);
          },
        },
        { concurrency: 1 },
      );
      expect(wake.errors).toBe(0);
      expect(wake.retried).toBe(0);
    },
    async replay(task) {
      const result = await runBriefing(depsForStore(), {
        agentId,
        taskId: task.id,
        trigger: task.trigger,
      });
      return result.outcome;
    },
    async taskRows() {
      const rows = await store.collection('tasks').where('agentId', '==', agentId).get();
      return rows.docs.map((row) => row.data() as Records['tasks']);
    },
    async completion() {
      const schedule = await new FirestoreScheduleRepository(store).getByName(
        agentId,
        DAILY_BRIEFING,
      );
      if (!schedule) throw new Error('Missing daily briefing schedule');
      const row = await store
        .doc('maintenanceCursors', briefingCursorName(agentId, schedule.id))
        .get();
      return readBriefingWatchdogRecord(row.get('cursor'));
    },
    async read(taskId) {
      const receipt = await readFirestoreSavedBriefing(store, agentId, taskId);
      if (!receipt) return null;
      const message = await store.doc('messages', receipt.messageId).get();
      return message.exists ? { id: receipt.messageId, parts: message.get('parts') } : null;
    },
  };
}

function occurrences(rows: Records['tasks'][]) {
  return rows.filter(
    ({ trigger }) =>
      (trigger as { payload?: { schedule?: string } })?.payload?.schedule === DAILY_BRIEFING,
  );
}

function weather(parts: unknown[]) {
  const cards = parts as Array<{
    type?: string;
    data?: {
      kind?: string;
      date?: string;
      sections?: Array<{ type: string; location?: string; temperature?: string }>;
    };
  }>;
  const card = cards.find(
    ({ type, data }) => type === 'data-card' && data?.kind === 'briefing',
  )?.data;
  return { date: card?.date, forecasts: card?.sections?.filter(({ type }) => type === 'weather') };
}

describe.each([
  { driver: 'PostgreSQL', open: postgres, skip: false },
  { driver: 'Firestore', open: firestore, skip: !process.env.FIRESTORE_EMULATOR_HOST },
])('$driver daily Home weather', ({ driver, open, skip }) => {
  it.skipIf(skip)(
    'runs wake and cron against durable receipts across local dates and restarts',
    async () => {
      const fixture = await open();
      const requests: Array<{ at: string; lat: string | null; lng: string | null }> = [];
      const observations: Array<Record<string, unknown>> = [];
      let provider: { date: string; temperature: number } | null = null;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname !== 'api.open-meteo.com')
          throw new Error('Unexpected synthetic outbound request');
        requests.push({
          at: new Date().toISOString(),
          lat: url.searchParams.get('latitude'),
          lng: url.searchParams.get('longitude'),
        });
        if (!provider) return new Response(null, { status: 503 });
        return Response.json({
          timezone: zone,
          current: { temperature_2m: provider.temperature, weather_code: 0, wind_speed_10m: 8 },
          daily: {
            time: [provider.date],
            weather_code: [0],
            temperature_2m_min: [provider.temperature - 2],
            temperature_2m_max: [provider.temperature + 2],
            precipitation_probability_max: [0],
          },
        });
      });

      try {
        vi.setSystemTime(time(1, 30));
        expect(await fixture.setHome(home)).toBe(true);
        await fixture.stalePing();
        const controls = [
          { day: 1, mode: 'wake', temperature: 13, forecast: 13 },
          { day: 2, mode: 'cron', temperature: null, forecast: null },
          { day: 3, mode: 'wake', temperature: 11, forecast: null },
          { day: 4, mode: 'cron', temperature: 9, forecast: null },
          { day: 5, mode: 'wake', temperature: 7, forecast: 7 },
        ] as const;
        for (const { day, mode, temperature, forecast } of controls) {
          vi.setSystemTime(time(day, 30));
          await fixture.restart();
          await fixture.news();
          if (day === 4)
            expect(await fixture.setHome({ ...home, revision: randomUUID() })).toBe(true);
          provider =
            temperature === null ? null : { date: localDate(day === 4 ? 3 : day), temperature };
          expect(
            (await fixture.tick()).filter(({ schedule }) => schedule === 'ambient-refresh'),
          ).toHaveLength(1);
          await fixture.drain();
          if (day === 3)
            expect(await fixture.setHome({ ...home, revision: randomUUID(), enabled: false })).toBe(
              true,
            );
          vi.setSystemTime(time(day, 40));
          if (mode === 'wake') {
            expect((await fixture.foreground()).wakeBriefFired).toBe(true);
            expect((await fixture.foreground()).wakeBriefFired).toBe(false);
          }
          vi.setSystemTime(time(day, 45));
          expect(
            (await fixture.tick()).filter(({ schedule }) => schedule === DAILY_BRIEFING),
          ).toHaveLength(mode === 'wake' ? 0 : 1);
          // Force worker reconnection after the occurrence committed, before its wake is consumed.
          await fixture.restart();
          await fixture.drain();
          await fixture.drain();
          expect((await fixture.foreground()).wakeBriefFired).toBe(false);
          const rows = occurrences(await fixture.taskRows());
          expect(rows).toHaveLength(day);
          const row = rows.find((task) => task.externalEventId?.includes(localDate(day)));
          expect(row?.status).toBe('done');
          if (!row) throw new Error('Missing briefing occurrence');
          const saved = await fixture.read(row.id);
          expect(saved).not.toBeNull();
          if (!saved) throw new Error('Missing saved briefing');
          const reading = weather(saved.parts);
          expect(reading.date).toContain(`Dec ${day}`);
          expect(reading.forecasts).toEqual(
            forecast === null
              ? []
              : [
                  expect.objectContaining({
                    location: 'Home · Juniper Bay',
                    temperature: `${forecast}°C`,
                  }),
                ],
          );
          expect(await fixture.completion()).toMatchObject({
            taskId: row.id,
            outcome: { kind: 'delivered', messageId: saved.id },
          });
          observations.push({
            day: localDate(day),
            mode,
            taskId: row.id,
            messageId: saved.id,
            ...reading,
          });
        }
        expect(requests).toHaveLength(5);
        expect(requests.every(({ lat, lng }) => lat === '38.5' && lng === '-120.5')).toBe(true);

        // A real quiet occurrence records one completion, even with weather available.
        vi.setSystemTime(time(6, 30));
        await fixture.archiveNews();
        provider = { date: localDate(6), temperature: 6 };
        await fixture.tick();
        await fixture.drain();
        expect(await fixture.ambient()).toContain('6°C');
        vi.setSystemTime(time(6, 45));
        const [quiet] = await fixture.tick();
        if (!quiet || quiet.schedule !== DAILY_BRIEFING)
          throw new Error('Missing quiet schedule occurrence');
        await fixture.drain();
        expect(await fixture.read(quiet.taskId)).toBeNull();
        expect(await fixture.completion()).toMatchObject({
          taskId: quiet.taskId,
          outcome: { kind: 'quiet' },
        });
        observations.push({
          day: localDate(6),
          mode: 'cron',
          taskId: quiet.taskId,
          outcome: 'quiet',
          ambientTemperature: '6°C',
          messageId: null,
        });

        // Hold each real outbox/queue entry until the next morning.
        for (const { day, mode } of [
          { day: 7, mode: 'cron' },
          { day: 9, mode: 'wake' },
        ]) {
          vi.setSystemTime(time(day, mode === 'wake' ? 40 : 45));
          await fixture.news();
          if (mode === 'wake') expect((await fixture.foreground()).wakeBriefFired).toBe(true);
          else await fixture.tick();
          const delayed = occurrences(await fixture.taskRows()).find((task) =>
            task.externalEventId?.includes(localDate(day)),
          );
          if (!delayed) throw new Error('Missing delayed briefing wake');
          expect(await fixture.read(delayed.id)).toBeNull();

          vi.setSystemTime(time(day + 1, 30));
          provider = { date: localDate(day + 1), temperature: 12 - day };
          await fixture.restart();
          await fixture.tick();
          await fixture.drain();
          expect(await fixture.completion()).toMatchObject({
            taskId: delayed.id,
            outcome: { kind: 'aborted' },
          });
          expect(await fixture.read(delayed.id)).toBeNull();

          vi.setSystemTime(time(day + 1, 45));
          const current = (await fixture.tick()).find(
            ({ schedule }) => schedule === DAILY_BRIEFING,
          );
          if (!current) throw new Error('Missing current briefing');
          await fixture.drain();
          const published = await fixture.read(current.taskId);
          if (!published) throw new Error('Missing next-day briefing readback');
          const reading = weather(published.parts);
          expect(reading).toMatchObject({
            date: expect.stringContaining(`Dec ${day + 1}`),
            forecasts: [expect.objectContaining({ temperature: `${12 - day}°C` })],
          });
          expect(await fixture.completion()).toMatchObject({
            taskId: current.taskId,
            outcome: { kind: 'delivered', messageId: published.id },
          });
          observations.push(
            { day: localDate(day), mode, taskId: delayed.id, outcome: 'aborted', messageId: null },
            {
              day: localDate(day + 1),
              mode: 'cron',
              taskId: current.taskId,
              messageId: published.id,
              ...reading,
            },
          );
        }
        const all = occurrences(await fixture.taskRows());
        expect(all).toHaveLength(10);
        const first = all.find((task) => task.externalEventId?.includes(localDate(1)));
        if (!first) throw new Error('Missing original briefing');
        // The date guard does not discard a receipt committed on the intended day.
        expect(await fixture.replay(first)).toEqual({
          kind: 'delivered',
          messageId: observations[0]?.messageId,
        });
        console.info(
          'B5 simulated daily weather evidence',
          JSON.stringify({ driver, zone, observations, requests }),
        );
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        await fixture.close();
      }
    },
    60_000,
  );
});
