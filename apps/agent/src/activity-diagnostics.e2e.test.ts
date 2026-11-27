import { randomUUID } from 'node:crypto';
import { getChatConversationView } from '@assistant/application/chat';
import {
  discoverActivityWithRepository,
  getTaskDetail,
  getTaskDetailWithRepository,
} from '@assistant/application/tasks';
import { resetConfigForTest } from '@assistant/config';
import { type ExecutorDeps, executeTask, reportRepair } from '@assistant/core';
import {
  assertPostgresInstallationOwner,
  createPostgresApplicationChatPersistence,
  createPostgresExecutionPersistence,
  createPostgresSelfRepairRepository,
  createPostgresTaskDiscoveryRepository,
  type Db,
  recallMetrics,
  tasks,
} from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreApplicationChatPersistence,
  FirestoreTaskActivityRepository,
  FirestoreTaskDiscoveryRepository,
} from '@assistant/firestore';
import { notificationLeg, PROTECTED_REPAIR_TARGET } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { notifyOwnerOfDeliveredAnswer } from '../../../packages/core/src/workflow/executor/notices.js';
import {
  disposeStore,
  emulatorStore,
  seedBudget,
} from '../../../packages/firestore/src/test-store.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';

const jobs = ['self.repair', 'health.monitor', 'dream.run'] as const;
const space = { provider: 'synthetic', model: 'activity-fixture', dimensions: 1536, revision: '1' };
const historyFailure = 'Conversation memory recall was unavailable 3 times';
const footnote = 'The synthetic ferry check should use its published schedule.';
const privateReply = 'Private fixture reply for the secondary chat.';
const existingNotice = 'Existing synthetic owner notice.';
const progressTitle = 'Synthetic background repair failure';
const actionableTitle = 'Synthetic repair awaiting owner action';
const protectedTitle = 'Synthetic repair requiring a separate owner-led change';
const exhaustedText =
  'This scheduled run exhausted its retries. You can retry it in Activity on your iPhone.';

for (const driver of ['postgres', 'firestore'] as const) {
  it.skipIf(driver === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
    `${driver}: scheduled diagnostics stay in Activity and owner notices retain their destinations`,
    async () => {
      const installation = driver === 'postgres' ? await createIsolatedTestDatabase() : undefined;
      const db = installation?.db ?? ({} as Db);
      const store = driver === 'firestore' ? emulatorStore() : undefined;
      try {
        vi.stubEnv('CHAT_RECALL_ENABLED', 'true');
        vi.stubEnv('SELF_REPAIR_ENABLED', 'true');
        vi.stubEnv('SELF_REPAIR_PROVIDER', 'github');
        vi.stubEnv('GITHUB_TOKEN', 'synthetic');
        vi.stubEnv('GITHUB_REPO', 'fixture/assistant');
        resetConfigForTest();
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            throw new Error('Unexpected external call');
          }),
        );

        const agentId = store ? randomUUID() : await assertPostgresInstallationOwner(db);
        if (store) {
          await store.doc('agents', agentId).set({
            id: agentId,
            name: 'Fixture assistant',
            email: 'assistant@example.test',
            timezone: 'UTC',
          });
          await seedBudget(store);
        }
        const persistence = store
          ? createFirestoreExecutionPersistence(store, agentId, space)
          : createPostgresExecutionPersistence(db);
        const chat = store
          ? new FirestoreApplicationChatPersistence(store, agentId)
          : createPostgresApplicationChatPersistence(db);
        const primary = await chat.getOrCreatePrimaryConversation(agentId);
        const secondary = await chat.createConversation(agentId);
        const notifications = await persistence.notifications.getOrCreate(agentId);
        await persistence.messages.append({
          conversationId: notifications,
          text: existingNotice,
          parts: [{ type: 'text', text: existingNotice }],
          role: 'assistant',
          origin: 'assistant',
        });

        const scheduled = async (job: (typeof jobs)[number], title: string = job) =>
          (
            await persistence.tasks.createTask({
              agentId,
              title,
              type: 'scheduled',
              trust: 'assistant',
              trigger: { source: 'schedule', payload: { job } },
            })
          ).task;
        const setTask = async (id: string, patch: Partial<typeof tasks.$inferInsert>) => {
          if (store) await store.doc('tasks', id).update(patch);
          else await db.update(tasks).set(patch).where(eq(tasks.id, id));
        };
        const repair = persistence.selfRepair ?? createPostgresSelfRepairRepository(db);
        if (!repair) throw new Error('Repair repository unavailable');
        const seedRepair = async (
          title: string,
          status: 'failed' | 'blocked',
          notice: { ownerActionRequired?: string; lastError?: string } = {},
        ) => {
          const issue = await reportRepair(repair, agentId, {
            key: title,
            source: 'feedback',
            title,
            summary: title,
          });
          const updated = await repair.update(issue, status, notice, new Date());
          if (!updated) throw new Error('Repair fixture update failed');
          return updated;
        };
        const ordinaryIssue = await seedRepair(progressTitle, 'failed');
        await seedRepair(actionableTitle, 'blocked', {
          ownerActionRequired: 'Choose whether to request another investigation.',
        });
        await seedRepair(protectedTitle, 'blocked', { lastError: PROTECTED_REPAIR_TARGET });

        const router = {
          object: vi.fn(async () => ({
            ok: true,
            object: { footnotes: [footnote], hypotheses: [], anticipations: [] },
          })),
        } as unknown as ExecutorDeps['router'];
        const notifyOwner = vi.fn<NonNullable<ExecutorDeps['notifyOwner']>>(async () =>
          notificationLeg('test-sink', 'delivered'),
        );
        const deps: ExecutorDeps = {
          db,
          persistence,
          router,
          notifyOwner,
          dispatcher: {} as ExecutorDeps['dispatcher'],
        };

        const ordinary = await scheduled('self.repair', 'E6 ordinary repair');
        // Simulate a worker losing the issue-update receipt after the durable diagnostic append.
        const ordinaryDiagnosticPersistence = {
          ...persistence,
          selfRepair: new Proxy(repair, {
            get(target, property, receiver) {
              if (property !== 'update') return Reflect.get(target, property, receiver);
              return async (...args: Parameters<typeof repair.update>) =>
                args[0].id === ordinaryIssue.id && args[2].notifiedStatus
                  ? null
                  : repair.update(...args);
            },
          }),
        };
        expect(
          (await executeTask({ ...deps, persistence: ordinaryDiagnosticPersistence }, ordinary.id))
            .outcome,
        ).toBe('done');
        const nextRun = await scheduled('self.repair', 'E6 repair replay');
        expect((await executeTask(deps, nextRun.id)).outcome).toBe('done');

        for (let index = 0; index < 3; index++) {
          const row = {
            agentId,
            path: 'executor',
            graphAttempted: false,
            historyFailed: true,
            historyTier: 'message',
          };
          if (store) {
            const id = randomUUID();
            await store.doc('recallMetrics', id).set({ ...row, id, createdAt: new Date() });
          } else await db.insert(recallMetrics).values(row);
        }
        const health = await scheduled('health.monitor', 'E6 ordinary health');
        const brokenHealthPersistence = {
          ...persistence,
          tasks: new Proxy(persistence.tasks, {
            get(target, property, receiver) {
              if (property === 'appendActivityDiagnostic') return async () => false;
              return Reflect.get(target, property, receiver);
            },
          }),
        };
        expect(
          (await executeTask({ ...deps, persistence: brokenHealthPersistence }, health.id)).outcome,
        ).toBe('failed');
        await setTask(health.id, { runAfter: new Date(0) });
        expect((await executeTask(deps, health.id)).outcome).toBe('done');

        const dreamSource = await scheduled('dream.run', 'E6 historic source');
        await setTask(dreamSource.id, {
          status: 'failed',
          progress: 'Synthetic ferry check stalled.',
        });
        const dream = await scheduled('dream.run', 'E6 ordinary reflection');
        expect((await executeTask(deps, dream.id)).outcome).toBe('done');

        const exhausted = [];
        const tasksWithFailedHeartbeat = new Proxy(persistence.tasks, {
          get(target, property, receiver) {
            if (property === 'renew')
              return async () => {
                throw new Error('Synthetic retry exhaustion');
              };
            return Reflect.get(target, property, receiver);
          },
        });
        for (const job of jobs) {
          const task = await scheduled(job, `E6 exhausted ${job}`);
          await setTask(task.id, { attempt: 7 });
          expect(
            (
              await executeTask(
                {
                  ...deps,
                  persistence: { ...persistence, tasks: tasksWithFailedHeartbeat },
                },
                task.id,
              )
            ).outcome,
          ).toBe('dead_letter');
          exhausted.push(task);
        }

        const { task: answer } = await persistence.tasks.createTask({
          agentId,
          conversationId: secondary.id,
          type: 'chat_turn',
          trust: 'owner',
          trigger: { source: 'internal', payload: {} },
        });
        await persistence.messages.append({
          conversationId: secondary.id,
          taskId: answer.id,
          role: 'assistant',
          origin: 'assistant',
          text: privateReply,
          parts: [{ type: 'text', text: privateReply }],
        });
        expect(await notifyOwnerOfDeliveredAnswer(deps, answer, privateReply)).toBe(true);
        expect(notifyOwner).toHaveBeenCalledWith(
          expect.objectContaining({
            text: 'Your reply is ready.',
            purpose: 'answer-ready',
            conversationId: secondary.id,
          }),
        );

        const discovery = await discoverActivityWithRepository(
          store
            ? new FirestoreTaskDiscoveryRepository(store)
            : createPostgresTaskDiscoveryRepository(db),
          agentId,
          { filter: 'all', archived: false },
        );
        const cases = [
          [ordinary, progressTitle],
          [health, historyFailure],
          [dream, footnote],
          ...exhausted.map((task) => [task, exhaustedText] as const),
        ] as const;
        for (const [task, text] of cases) {
          const detail = store
            ? await getTaskDetailWithRepository(
                new FirestoreTaskActivityRepository(store),
                agentId,
                task.id,
              )
            : await getTaskDetail(db, task.id);
          expect(detail?.task.diagnostics).toEqual([
            { id: expect.any(String), text: expect.stringContaining(text) },
          ]);
          expect(discovery.items.find(({ id }) => id === task.id)?.diagnostics).toEqual(
            detail?.task.diagnostics,
          );
        }
        expect(discovery.items.find(({ id }) => id === nextRun.id)?.diagnostics).toBeUndefined();

        async function openedText(conversationId: string) {
          const opened = await getChatConversationView(chat, conversationId, {});
          expect(opened?.conversation.id).toBe(conversationId);
          return opened?.messages.flatMap(({ parts }) =>
            parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
          );
        }
        expect(await openedText(primary.id)).toEqual([]);
        expect(await openedText(secondary.id)).toEqual([privateReply]);
        const ownerNotices = await openedText(notifications);
        expect(ownerNotices).toHaveLength(3);
        expect(ownerNotices).toEqual(
          expect.arrayContaining([
            existingNotice,
            expect.stringContaining(actionableTitle),
            expect.stringContaining(
              `“${protectedTitle}”: The proposed repair targets protected code.`,
            ),
          ]),
        );
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        resetConfigForTest();
        await installation?.close();
        if (store) await disposeStore(store);
      }
    },
    90_000,
  );
}
