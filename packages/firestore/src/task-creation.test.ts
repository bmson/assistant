import { randomUUID } from 'node:crypto';
import { taskFixture } from '@assistant/persistence/testing';
import { expect, it } from 'vitest';
import { createTask } from './task-creation.js';
import { disposeStore, emulatorStore } from './test-store.js';

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'round-trips the numeric(8,4) task budget maximum and rejects overflow before writing',
  async () => {
    const store = emulatorStore();
    const operationId = randomUUID();
    try {
      await store.doc('agents', 'owner').set({ id: 'owner' });
      const created = await createTask(store, {
        agentId: 'owner',
        type: 'adhoc',
        trust: 'owner',
        trigger: {},
        budgetUsdLimit: '9999.9999',
        externalEventId: `valid-${operationId}`,
      });
      const stored = await store.doc('tasks', created.task.id).get();
      expect(stored.get('budgetUsdLimit')).toBe('9999.9999');

      await expect(
        createTask(store, {
          agentId: 'owner',
          type: 'adhoc',
          trust: 'owner',
          trigger: {},
          budgetUsdLimit: '10000.0000',
          externalEventId: `invalid-${operationId}`,
        }),
      ).rejects.toThrow('task budget precision');
      expect(
        await store
          .collection('tasks')
          .where('externalEventId', '==', `invalid-${operationId}`)
          .get(),
      ).toMatchObject({ empty: true });
    } finally {
      await disposeStore(store);
    }
  },
);

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'rejects missing, foreign and mismatched generic task parents before writing wake or event receipts',
  async () => {
    const store = emulatorStore();
    try {
      await store.doc('tasks', 'foreign-parent').set(
        taskFixture({
          id: 'foreign-parent',
          agentId: 'foreign',
          conversationId: 'conversation',
          reminderId: '',
        }),
      );
      await store.doc('tasks', 'corrupt-parent').set(
        taskFixture({
          id: 'different-id',
          agentId: 'owner',
          conversationId: 'conversation',
          reminderId: '',
        }),
      );
      for (const parentTaskId of ['missing-parent', 'foreign-parent', 'corrupt-parent']) {
        await expect(
          createTask(store, {
            agentId: 'owner',
            type: 'adhoc',
            trust: 'owner',
            trigger: {},
            parentTaskId,
            externalEventId: `child-${parentTaskId}`,
          }),
        ).rejects.toThrow('Task parent is missing or belongs to another agent');
      }
      expect((await store.collection('tasks').get()).size).toBe(2);
      expect((await store.collection('taskEventKeys').get()).empty).toBe(true);
      expect((await store.collection('outbox').get()).empty).toBe(true);
      const child = await createTask(store, {
        agentId: 'foreign',
        type: 'adhoc',
        trust: 'owner',
        trigger: {},
        parentTaskId: 'foreign-parent',
        externalEventId: 'valid-child',
      });
      expect(child.created).toBe(true);
      expect(child.task.parentTaskId).toBe('foreign-parent');
      expect((await store.collection('outbox').get()).size).toBe(1);
      expect((await store.collection('taskEventKeys').get()).size).toBe(1);
    } finally {
      await disposeStore(store);
    }
  },
);
