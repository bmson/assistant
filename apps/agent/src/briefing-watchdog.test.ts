import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask, runBriefing } from '@assistant/core';
import { runScheduleBatch } from '@assistant/core/workflow/schedules';
import {
  assertPostgresInstallationOwner,
  createPostgresExecutionPersistence,
  createPostgresScheduleRepository,
  type Db,
  messages,
  schedules,
  tasks,
} from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import {
  BRIEFING_DEADLINE_MS,
  briefingMessageKey,
  DAILY_BRIEFING,
  type ScheduleRepository,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  disposeStore,
  emulatorStore,
  seedBudget,
} from '../../../packages/firestore/src/test-store.js';
import { readFirestoreBriefingHealth, readPostgresBriefingHealth } from './briefing-watchdog.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';

interface Fixture {
  deps: ExecutorDeps;
  repo: ScheduleRepository;
  agentId: string;
  health(at?: Date): Promise<{ ok: boolean; state: string; recordedAt?: string }>;
  makeDue(scheduleId: string, at: Date): Promise<void>;
  setClock(now: Date): void;
  addNews(): Promise<void>;
  countSaved(taskId: string): Promise<number>;
  deleteSaved(taskId: string): Promise<void>;
  close(): Promise<void>;
}

const HOUR = 3_600_000;

function fixtureDeps(persistence: ExecutorDeps['persistence'], db: Db): ExecutorDeps {
  const object = vi.fn(async () => ({
    ok: true,
    modelId: 'synthetic-briefing',
    object: { lead: 'One task needs your attention.' },
  }));
  return {
    db,
    persistence,
    router: { object } as unknown as ExecutorDeps['router'],
    dispatcher: { toolDefs: () => [] } as unknown as ExecutorDeps['dispatcher'],
    calendarReader: async () => ({ complete: true, events: [] }),
  };
}

async function postgresFixture(): Promise<Fixture> {
  const { db, close } = await createIsolatedTestDatabase();
  const agentId = await assertPostgresInstallationOwner(db);
  const repo = createPostgresScheduleRepository(db);
  await db.update(schedules).set({ enabled: false });
  const [schedule] = await db.select().from(schedules).where(eq(schedules.name, DAILY_BRIEFING));
  if (!schedule) throw new Error('Seeded default briefing missing');
  await db
    .update(schedules)
    .set({ enabled: true, createdAt: new Date(Date.now() - 3 * 24 * HOUR) })
    .where(eq(schedules.id, schedule.id));
  return {
    agentId,
    repo,
    deps: fixtureDeps(createPostgresExecutionPersistence(db), db),
    close,
    health: (at) => readPostgresBriefingHealth(db, at),
    setClock: () => {},
    makeDue: async (id, nextRunAt) => {
      await db.update(schedules).set({ nextRunAt }).where(eq(schedules.id, id));
    },
    async addNews() {
      await db.insert(tasks).values({
        agentId,
        type: 'adhoc',
        trust: 'owner',
        status: 'needs_attention',
        title: 'Review the synthetic task',
        progress: 'A decision is needed.',
      });
    },
    async countSaved(taskId) {
      return (
        await db
          .select()
          .from(messages)
          .where(eq(messages.channelMessageId, briefingMessageKey(taskId)))
      ).length;
    },
    async deleteSaved(taskId) {
      await db.delete(messages).where(eq(messages.channelMessageId, briefingMessageKey(taskId)));
    },
  };
}

async function firestoreFixture(): Promise<Fixture> {
  let now = new Date();
  const store = emulatorStore(() => now);
  const agentId = randomUUID();
  const repo = new FirestoreScheduleRepository(store);
  await seedBudget(store);
  const createdAt = new Date(now.getTime() - 3 * 24 * HOUR);
  await store.doc('agents', agentId).set({
    id: agentId,
    name: 'Synthetic owner',
    email: 'briefing@example.invalid',
    timezone: 'UTC',
    createdAt,
    updatedAt: createdAt,
  });
  await repo.ensure({
    agentId,
    name: DAILY_BRIEFING,
    enabled: true,
    cron: '0 8 * * *',
    nextRunAt: null,
    taskTemplate: { type: 'scheduled', job: 'briefing.compose' },
  });
  const schedule = await repo.getByName(agentId, DAILY_BRIEFING);
  if (!schedule) throw new Error('Synthetic briefing schedule missing');
  await store.doc('schedules', schedule.id).update({ createdAt });
  const persistence = createFirestoreExecutionPersistence(store, agentId, {
    provider: 'synthetic',
    model: 'briefing-watchdog',
    revision: '1',
    dimensions: 1536,
  });
  const forbiddenDb = new Proxy(
    {},
    {
      get() {
        throw new Error('Unexpected PostgreSQL access');
      },
    },
  ) as Db;
  return {
    agentId,
    repo,
    deps: fixtureDeps(persistence, forbiddenDb),
    close: () => disposeStore(store),
    health: (at) => readFirestoreBriefingHealth(store, agentId, at),
    setClock: (at) => {
      now = at;
    },
    makeDue: async (id, nextRunAt) => {
      await store.doc('schedules', id).update({ nextRunAt });
    },
    async addNews() {
      const { task } = await persistence.tasks.createTask({
        agentId,
        type: 'adhoc',
        trust: 'owner',
        trigger: { source: 'internal', payload: {} },
      });
      await store.doc('tasks', task.id).update({
        status: 'needs_attention',
        title: 'Review the synthetic task',
        progress: 'A decision is needed.',
      });
    },
    async countSaved(taskId) {
      return Number((await store.doc('messages', briefingMessageKey(taskId)).get()).exists);
    },
    async deleteSaved(taskId) {
      await store.doc('messages', briefingMessageKey(taskId)).delete();
    },
  };
}

async function exercise(fixture: Fixture) {
  try {
    const { repo, agentId, deps } = fixture;
    const schedule = await repo.getByName(agentId, DAILY_BRIEFING);
    if (!schedule) throw new Error('Fixture schedule unavailable');
    const scheduleId = schedule.id;
    const scheduledAt = new Date();
    expect(await fixture.health(scheduledAt)).toMatchObject({ ok: false, state: 'stale' });
    async function dispatch(offset: number, options = deps) {
      const due = new Date(scheduledAt.getTime() - (4 - offset) * HOUR);
      const clock = new Date(scheduledAt.getTime() + offset * 1000);
      fixture.setClock(clock);
      await fixture.makeDue(scheduleId, due);
      const [occurrence] = await runScheduleBatch(repo, 'UTC', { now: clock });
      if (!occurrence) throw new Error('Due briefing did not fire');
      expect(await runScheduleBatch(repo, 'UTC', { now: clock })).toEqual([]);
      const result = await executeTask(options, occurrence.taskId);
      return { occurrence, result, clock };
    }

    const quiet = await dispatch(1);
    expect(quiet.result.outcome, quiet.result.detail).toBe('done');
    const health = await fixture.health(new Date(Date.now() + 10_000));
    expect(health).toMatchObject({ ok: true, state: 'quiet' });
    if (!health.recordedAt) throw new Error('Missing quiet outcome timestamp');
    expect(
      await fixture.health(new Date(Date.parse(health.recordedAt) + BRIEFING_DEADLINE_MS)),
    ).toMatchObject({
      ok: false,
      state: 'stale',
      lastOutcome: 'quiet',
    });

    const unavailable = await dispatch(2, {
      ...deps,
      calendarReader: async () => {
        throw new Error('synthetic calendar outage');
      },
    });
    expect(unavailable.result.outcome, unavailable.result.detail).toBe('done');
    expect(await fixture.health(new Date(Date.now() + 10_000))).toMatchObject({
      ok: false,
      state: 'unavailable',
    });

    await dispatch(3, {
      ...deps,
      jobUnavailable: () => {
        throw new Error('synthetic interruption');
      },
    });
    expect(await fixture.health(new Date(Date.now() + 10_000))).toMatchObject({
      ok: false,
      state: 'aborted',
    });

    await fixture.addNews();
    const delivery = await dispatch(4);
    expect(delivery.result.outcome, delivery.result.detail).toBe('done');
    const taskId = delivery.occurrence.taskId;
    expect(await fixture.health(new Date(Date.now() + 10_000))).toMatchObject({
      ok: true,
      state: 'delivered',
    });
    expect(await runBriefing(deps, { taskId, agentId })).toMatchObject({
      outcome: { kind: 'delivered' },
      pinged: false,
    });
    expect(await fixture.countSaved(taskId)).toBe(1);
    await fixture.deleteSaved(taskId);
    expect(await fixture.health(new Date(Date.now() + 10_000))).toMatchObject({
      ok: false,
      state: 'unavailable',
    });

    expect(await repo.setOwnerEnabled(agentId, schedule.id, false)).toBe(true);
    expect(await fixture.health(new Date(Date.now() + 10_000))).toMatchObject({
      ok: true,
      state: 'disabled',
    });
    fixture.setClock(new Date(delivery.clock.getTime() + HOUR));
    expect(await repo.setOwnerEnabled(agentId, schedule.id, true)).toBe(true);
    expect(await fixture.health(new Date(delivery.clock.getTime() + 2 * HOUR))).toMatchObject({
      ok: true,
      state: 'awaiting_first_run',
    });
  } finally {
    await fixture.close();
  }
}

describe('briefing watchdog on the real scheduled execution path', () => {
  it('separates successful and failed outcomes in PostgreSQL', async () => {
    await exercise(await postgresFixture());
  }, 90_000);

  it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
    'separates successful and failed outcomes in Firestore',
    async () => {
      await exercise(await firestoreFixture());
    },
    90_000,
  );
});
