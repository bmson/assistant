import { randomUUID } from 'node:crypto';
import type { Db } from '@assistant/db';
import {
  createInstallationStore,
  FirestoreReminderRepository,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry.js';
import { registerReminderTools } from './reminders.js';
import type { ToolContext } from './types.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore reminder invocation identity',
  () => {
    it('returns one winning relative time across concurrent invocations and never revives cancellation', async () => {
      const store = createInstallationStore({
        projectId: 'demo-assistant-test',
        installationId: `reminder-replay-${randomUUID()}`,
      });
      const registry = new ToolRegistry();
      registerReminderTools(registry, {
        schedules: new FirestoreScheduleRepository(store),
        reminders: new FirestoreReminderRepository(store),
        getTimezone: async () => 'UTC',
      });
      let now = new Date('2027-01-01T10:00:00Z');
      const context: ToolContext = {
        taskId: 'task',
        agentId: 'owner',
        trust: 'owner',
        tainted: false,
        db: null as unknown as Db,
        now: () => now,
        signal: new AbortController().signal,
        log: async () => {},
        execution: {
          dbToolCallId: 'invocation',
          modelToolCallId: 'model',
          toolName: 'reminder.create',
        },
      };
      const create = registry.get('reminder.create')?.tool;
      const cancel = registry.get('reminder.cancel')?.tool;
      if (!create || !cancel) throw new Error('Missing reminder tools');
      const args = { text: 'Call the dentist', inMinutes: 10 };
      try {
        const receipts = (await Promise.all([
          create.execute(args, context),
          create.execute(args, context),
          create.execute(args, context),
        ])) as Array<{ reminderId: string; nextFires: string }>;
        expect(receipts[1]).toEqual(receipts[0]);
        expect(receipts[2]).toEqual(receipts[0]);
        expect((await store.collection('schedules').get()).size).toBe(1);
        now = new Date('2027-01-02T10:00:00Z');
        expect(await create.execute(args, context)).toEqual(receipts[0]);
        const second = (await create.execute(args, {
          ...context,
          execution: {
            dbToolCallId: 'different-invocation',
            modelToolCallId: 'model-two',
            toolName: 'reminder.create',
          },
        })) as { reminderId: string };
        expect(second.reminderId).not.toBe(receipts[0]?.reminderId);
        expect((await store.collection('schedules').get()).size).toBe(2);
        await cancel.execute({ reminderId: receipts[0]?.reminderId }, context);
        expect(await create.execute(args, context)).toMatchObject({
          reminderId: receipts[0]?.reminderId,
          enabled: false,
          nextFires: null,
        });
      } finally {
        await store.db.recursiveDelete(store.root);
        await store.db.terminate();
      }
    }, 30_000);
  },
);
