import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { type ExecutorDeps, executeTask, runDueSchedules } from '@assistant/core';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreReminderRepository,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import { remindersModule } from '@assistant/modules';
import { notificationLeg } from '@assistant/persistence';
import { ToolRegistry } from '@assistant/tools/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const TIMEZONE = 'America/Los_Angeles';
const CHAT_ID = randomUUID();

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore scheduled reminder delivery',
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let registry: ToolRegistry;
    let deps: ExecutorDeps;
    let schedules: FirestoreScheduleRepository;
    let sqlAccesses: string[];
    let notifyOwner: ReturnType<typeof vi.fn<NonNullable<ExecutorDeps['notifyOwner']>>>;

    beforeEach(async () => {
      vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
      store = emulatorStore();
      sqlAccesses = [];
      // Any SQL, model, or tool-dispatch access is a migration failure here.
      const unavailable = (name: string) =>
        new Proxy(
          {},
          {
            get: (_target, property) => {
              sqlAccesses.push(`${name}.${String(property)}`);
              throw new Error(`Unexpected ${name} access: ${String(property)}`);
            },
          },
        );
      schedules = new FirestoreScheduleRepository(store);
      registry = new ToolRegistry();
      remindersModule.create({
        config: loadConfig({ ASSISTANT_MODULES: 'reminders' }),
        db: unavailable('db') as Db,
        registry,
        router: {} as never,
        workspace: {} as never,
        workspacePrefix: 'workspace/test',
        workspaceRoot: '/tmp/test',
        repoRoot: '/tmp/test',
        persistence: {} as never,
        portableReminders: {
          schedules,
          reminders: new FirestoreReminderRepository(store),
          getTimezone: async () => TIMEZONE,
        },
      });
      notifyOwner = vi.fn<NonNullable<ExecutorDeps['notifyOwner']>>(async () =>
        notificationLeg('push', 'delivered'),
      );
      deps = {
        db: unavailable('db') as Db,
        router: unavailable('router') as ExecutorDeps['router'],
        dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
        persistence: createFirestoreExecutionPersistence(store, agentId, {
          provider: 'synthetic',
          model: 'reminder-fixture',
          dimensions: 1536,
          revision: '1',
        }),
        notifyOwner,
      };
      await store.doc('agents', agentId).set({
        id: agentId,
        name: 'Synthetic owner',
        timezone: TIMEZONE,
        createdAt: new Date(),
      });
      await store.doc('conversations', CHAT_ID).set({
        id: CHAT_ID,
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'Chat',
        isPrimary: true,
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    afterEach(async () => {
      await disposeStore(store);
      vi.unstubAllEnvs();
    });

    function toolContext(now: Date, conversationId?: string) {
      return {
        taskId: randomUUID(),
        agentId,
        trust: 'owner',
        tainted: false,
        db: {} as Db,
        now: () => now,
        signal: new AbortController().signal,
        log: async () => {},
        ...(conversationId ? { conversationId } : {}),
      } as never;
    }

    async function createReminder(
      args: Record<string, unknown>,
      now: Date,
      conversationId?: string,
    ): Promise<string> {
      const tool = registry.get('reminder.create')?.tool;
      if (!tool) throw new Error('reminder.create was not registered');
      const created = (await tool.execute(args, toolContext(now, conversationId))) as {
        reminderId: string;
      };
      return created.reminderId;
    }

    async function fire(now: Date): Promise<string[]> {
      const fired = await runDueSchedules(schedules, TIMEZONE, { now });
      return fired.map((item) => item.taskId);
    }

    async function messagesIn(conversationId: string) {
      const snapshot = await store
        .collection('messages')
        .where('conversationId', '==', conversationId)
        .get();
      return snapshot.docs.map((doc) => doc.data());
    }

    it('delivers a one-time reminder into its chat once, stamps the schedule, and pings ambiently', async () => {
      const created = new Date('2026-09-23T16:00:00.000Z');
      const reminderId = await createReminder(
        { text: 'Pick up the package', inMinutes: 15 },
        created,
        CHAT_ID,
      );
      const [taskId] = await fire(new Date('2026-09-23T16:16:00.000Z'));
      if (!taskId) throw new Error('reminder did not fire');

      expect(await executeTask(deps, taskId)).toEqual({
        outcome: 'done',
        detail: 'reminder: delivered and pinged',
      });
      const delivered = await messagesIn(CHAT_ID);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        taskId,
        role: 'assistant',
        origin: 'assistant',
        text: 'Pick up the package',
      });
      expect(JSON.stringify(delivered[0]?.parts)).toContain(`reminder-fired:${taskId}`);
      const schedule = (await store.doc('schedules', reminderId).get()).data();
      expect(schedule?.taskTemplate?.reminderDeliveredAt).toEqual(expect.any(String));
      expect(schedule?.enabled).toBe(false);
      expect(notifyOwner).toHaveBeenCalledExactlyOnceWith({
        taskId,
        conversationId: CHAT_ID,
        text: 'Pick up the package',
        urgency: 'ambient',
      });
      expect((await store.doc('tasks', taskId).get()).get('status')).toBe('done');
      expect(await executeTask(deps, taskId)).toEqual({ outcome: 'not_claimable' });
      expect(await messagesIn(CHAT_ID)).toHaveLength(1);
      expect(sqlAccesses).toEqual([]);
    });

    it('routes a reminder without a chat to one Notifications conversation', async () => {
      const created = new Date('2026-09-23T16:00:00.000Z');
      await createReminder({ text: 'Water the plants', inMinutes: 5 }, created);
      await createReminder({ text: 'Call the dentist', inMinutes: 6 }, created);
      const taskIds = await fire(new Date('2026-09-23T16:10:00.000Z'));
      expect(taskIds).toHaveLength(2);
      for (const taskId of taskIds) {
        expect((await executeTask(deps, taskId)).outcome).toBe('done');
      }
      const notifications = await store
        .collection('conversations')
        .where('agentId', '==', agentId)
        .where('title', '==', 'Notifications')
        .get();
      expect(notifications.size).toBe(1);
      const conversationId = String(notifications.docs[0]?.get('id') ?? '');
      expect((await messagesIn(conversationId)).map((message) => message.text).sort()).toEqual([
        'Call the dentist',
        'Water the plants',
      ]);
      expect(await messagesIn(CHAT_ID)).toHaveLength(0);
      expect(sqlAccesses).toEqual([]);
    });

    it('never delivers a reminder cancelled after it fired', async () => {
      const created = new Date('2026-09-23T16:00:00.000Z');
      const reminderId = await createReminder(
        { text: 'Move the car', inMinutes: 1 },
        created,
        CHAT_ID,
      );
      const [taskId] = await fire(new Date('2026-09-23T16:02:00.000Z'));
      if (!taskId) throw new Error('reminder did not fire');
      expect(
        (await new FirestoreReminderRepository(store).cancel(agentId, reminderId)).cancelled,
      ).toBe(true);
      expect(await executeTask(deps, taskId)).toEqual({ outcome: 'not_claimable' });
      expect(await messagesIn(CHAT_ID)).toHaveLength(0);
      expect(notifyOwner).not.toHaveBeenCalled();
      expect(sqlAccesses).toEqual([]);
    });

    it('does not append a second message when a recurring occurrence is re-run', async () => {
      // Relative to the real clock: creating a recurring reminder may stamp
      // its first run from the current time, whatever the tool context says.
      const now = new Date();
      await createReminder({ text: 'Stand up and stretch', time: '09:00' }, now, CHAT_ID);
      // At most one occurrence can be due within a day of creation; a pass two
      // days later fires exactly the next due one.
      await fire(now);
      const [taskId] = await fire(new Date(now.getTime() + 2 * 24 * 3_600_000));
      if (!taskId) throw new Error('recurring reminder did not fire');
      expect((await executeTask(deps, taskId)).outcome).toBe('done');

      // A worker that crashed after committing delivery but before completing
      // the task is recovered and runs the same occurrence again.
      await store.doc('tasks', taskId).update({
        status: 'pending',
        lockedUntil: null,
        leaseToken: null,
        runAfter: null,
      });
      expect(await executeTask(deps, taskId)).toEqual({
        outcome: 'done',
        detail: 'reminder: not delivered (cancelled, already delivered, or lease lost)',
      });
      expect(await messagesIn(CHAT_ID)).toHaveLength(1);
      expect(notifyOwner).toHaveBeenCalledOnce();
      expect(sqlAccesses).toEqual([]);
    });
  },
);
