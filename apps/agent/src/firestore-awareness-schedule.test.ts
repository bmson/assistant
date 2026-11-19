import { randomUUID } from 'node:crypto';
import { runDueSchedules } from '@assistant/core/workflow/schedules';
import { FirestoreScheduleRepository, type InstallationStore } from '@assistant/firestore';
import { PROACTIVE_AWARENESS_SCHEDULE } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { ensureAwarenessSchedule } from './awareness-schedule.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('awareness schedule lifecycle', () => {
  let store: InstallationStore;
  const agentId = randomUUID();
  beforeEach(async () => {
    store = emulatorStore();
    await store.doc('agents', agentId).set({ id: agentId, timezone: 'Pacific/Auckland' });
  });
  afterEach(async () => disposeStore(store));

  it('creates once under concurrent sweeps and preserves owner edits and pauses', async () => {
    const created = await Promise.all([
      ensureAwarenessSchedule(store, agentId),
      ensureAwarenessSchedule(store, agentId),
    ]);
    expect(created.reduce((a, b) => a + b, 0)).toBe(1);
    const rows = await store.collection('schedules').where('agentId', '==', agentId).get();
    expect(rows.size).toBe(1);
    const row = rows.docs[0];
    if (!row) throw new Error('Missing awareness schedule');
    expect(row.get('nextRunAt').toMillis()).toBeGreaterThan(Date.now() - 1000);
    expect(row.get('taskTemplate')).toEqual(PROACTIVE_AWARENESS_SCHEDULE.taskTemplate);
    await row.ref.update({
      enabled: false,
      cron: '0 9 * * 1',
      taskTemplate: { instruction: 'Owner edited review' },
    });
    expect(await ensureAwarenessSchedule(store, agentId)).toBe(0);
    expect((await row.ref.get()).get('taskTemplate.instruction')).toBe('Owner edited review');
    expect((await row.ref.get()).get('enabled')).toBe(false);
  });

  it('creates exactly one runnable assistant task for a due review', async () => {
    await ensureAwarenessSchedule(store, agentId);
    const row = (await store.collection('schedules').where('agentId', '==', agentId).get()).docs[0];
    if (!row) throw new Error('Missing awareness schedule');
    await row.ref.update({ nextRunAt: new Date(Date.now() - 1000) });
    const repository = new FirestoreScheduleRepository(store);
    const fired = await runDueSchedules(repository, 'Pacific/Auckland');
    expect(fired).toHaveLength(1);
    const firing = fired[0];
    if (!firing) throw new Error('Missing awareness task');
    const task = await store.doc('tasks', firing.taskId).get();
    expect(task.get('trust')).toBe('assistant');
    expect(task.get('trigger.payload.instruction')).toBe(
      PROACTIVE_AWARENESS_SCHEDULE.taskTemplate.instruction,
    );
    expect(await runDueSchedules(repository, 'Pacific/Auckland')).toHaveLength(0);
  });
});
