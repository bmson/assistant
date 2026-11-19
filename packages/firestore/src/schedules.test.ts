import { randomUUID } from 'node:crypto';
import type { Records } from '@assistant/persistence';
import { scheduleContract } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreReminderRepository } from './reminders.js';
import { FirestoreScheduleRepository } from './schedules.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';
import { FirestoreTaskRepository } from './task-lifecycle.js';
import { disposeStore, emulatorStore } from './test-store.js';

scheduleContract(
  'Firestore schedule persistence contract',
  async () => {
    const now = new Date();
    const store = emulatorStore(() => now);
    const agentId = randomUUID();
    const conversationId = randomUUID();
    await store.doc('conversations', conversationId).set({
      id: conversationId,
      agentId,
    });
    const repository = new FirestoreScheduleRepository(store);
    const tasks = new FirestoreTaskRepository(store);

    return {
      agentId,
      conversationId,
      repository,
      reminders: new FirestoreReminderRepository(store),
      tasks,
      readSchedule: async (id: string) => {
        const snapshot = await store.doc('schedules', id).get();
        if (!snapshot.exists) throw new Error(`Missing schedule ${id}`);
        return decodeRecord<Records['schedules']>(snapshot.data());
      },
      patchSchedule: async (id: string, patch: Partial<Records['schedules']>) => {
        await store.doc('schedules', id).update(encodeRecord(patch));
      },
      listTasks: async (scheduleId: string) => {
        const result = await store
          .collection('tasks')
          .where('trigger.payload.scheduleId', '==', scheduleId)
          .get();
        return result.docs.map((doc) => decodeRecord<Records['tasks']>(doc.data()));
      },
      outboxCount: async (scheduleId: string) => {
        const taskIds = new Set(
          (
            await store
              .collection('tasks')
              .where('trigger.payload.scheduleId', '==', scheduleId)
              .get()
          ).docs.map((doc) => String(doc.get('id'))),
        );
        if (!taskIds.size) return 0;
        const outbox = await store.collection('outbox').get();
        return outbox.docs.filter((doc) => taskIds.has(String(doc.get('taskId')))).length;
      },
      dispose: () => disposeStore(store),
    };
  },
  !process.env.FIRESTORE_EMULATOR_HOST,
);

function scheduleRow(input: {
  id: string;
  agentId: string;
  name: string;
  now: Date;
}): Records['schedules'] {
  return {
    id: input.id,
    name: input.name,
    createdAt: input.now,
    updatedAt: input.now,
    agentId: input.agentId,
    enabled: true,
    cron: '* * * * *',
    taskTemplate: { type: 'scheduled', instruction: 'existing' },
    seedTemplateKey: null,
    seedTemplateRevision: null,
    seedDefinition: null,
    seedReviewRequired: false,
    lastRunAt: null,
    nextRunAt: new Date(input.now.getTime() + 60_000),
  };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore schedule name migration', () => {
  let store: InstallationStore;

  beforeEach(() => {
    store = emulatorStore(() => new Date());
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  it('updates only an enabled unchanged default health monitor cadence', async () => {
    const now = new Date('2026-11-18T08:00:00Z');
    const nextAt = new Date('2026-11-18T08:15:00Z');
    const repo = new FirestoreScheduleRepository(store);
    const template = { type: 'scheduled', job: 'health.monitor', budgetUsdLimit: '0.02' };
    const name = 'assistant-health-monitor';
    for (const edited of ['untouched', 'paused', 'edited', 'unmanaged']) {
      const agentId = randomUUID();
      const id = randomUUID();
      const cron = edited === 'edited' ? '15 2 * * *' : '15 1 * * *';
      const changed = edited === 'untouched';
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('schedules', id).set(
        encodeRecord({
          ...scheduleRow({ id, agentId, name, now }),
          cron,
          enabled: edited !== 'paused',
          taskTemplate: template,
          seedTemplateKey: edited === 'unmanaged' ? null : `assistant.schedule.${name}`,
          seedTemplateRevision: edited === 'unmanaged' ? null : 1,
          seedDefinition: { cron: '15 1 * * *', taskTemplate: template },
        }),
      );
      await repo.updateDefaultHealthMonitorCadence(agentId, nextAt);
      const row = await store.doc('schedules', id).get();
      expect(row.get('cron'), edited).toBe(changed ? '15 * * * *' : cron);
      expect(row.get('nextRunAt').toDate(), edited).toEqual(
        changed ? nextAt : new Date(now.getTime() + 60_000),
      );
      expect(row.get('enabled')).toBe(edited !== 'paused');
    }
    expect((await store.collection('schedules').get()).size).toBe(4);
  });

  it('adopts an existing complete schedule document without a name key', async () => {
    const now = new Date();
    const agentId = randomUUID();
    const name = `legacy:${randomUUID()}`;
    const id = randomUUID();
    const row = scheduleRow({ id, agentId, name, now });
    await store.doc('schedules', id).set(encodeRecord(row));

    const adopted = await new FirestoreScheduleRepository(store).ensure({
      agentId,
      name,
      cron: '0 0 * * *',
      taskTemplate: { instruction: 'ignored' },
      nextRunAt: new Date(now.getTime() + 120_000),
    });

    expect(adopted).toEqual(row);
    expect((await store.collection('schedules').get()).size).toBe(1);
    expect((await store.collection('scheduleNames').get()).size).toBe(1);
  });

  it('rejects ambiguous duplicate legacy schedule names', async () => {
    const now = new Date();
    const agentId = randomUUID();
    const name = `legacy-duplicate:${randomUUID()}`;
    await Promise.all(
      [randomUUID(), randomUUID()].map(async (id) => {
        await store.doc('schedules', id).set(encodeRecord(scheduleRow({ id, agentId, name, now })));
      }),
    );

    await expect(
      new FirestoreScheduleRepository(store).ensure({
        agentId,
        name,
        cron: '* * * * *',
        taskTemplate: {},
        nextRunAt: null,
      }),
    ).rejects.toThrow('Ambiguous schedule name');
  });
});
