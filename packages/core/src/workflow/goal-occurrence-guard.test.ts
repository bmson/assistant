import { randomUUID } from 'node:crypto';
import {
  agents,
  createDb,
  createPostgresGoalRuntimeRepository,
  createPostgresScheduleRepository,
  createPostgresTaskRepository,
  type Db,
  goals,
  schedules,
  tasks,
} from '@assistant/db';
import {
  FirestoreGoalRuntimeRepository,
  FirestoreScheduleRepository,
  FirestoreTaskRepository,
} from '@assistant/firestore';
import {
  newTaskRecord,
  type Records,
  type ScheduleOccurrence,
  type ScheduleRepository,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeRecord,
  encodeRecord,
  type InstallationStore,
} from '../../../firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../firestore/src/test-store.js';
import { prepareGoalSession } from './schedules.js';

for (const backend of ['postgres', 'firestore'] as const) {
  describe.skipIf(backend === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
    `${backend} goal occurrence version guards`,
    () => {
      let db: Db | undefined;
      let store: InstallationStore | undefined;
      let repository: ScheduleRepository;
      let owner: string;
      let goal: Records['goals'];
      let stalled: Records['tasks'];
      let occurrence: ScheduleOccurrence;
      const now = new Date('2026-10-07T12:00:00Z');
      beforeEach(async () => {
        owner = randomUUID();
        goal = {
          id: randomUUID(),
          agentId: owner,
          title: 'Find suitable cities',
          description: '',
          status: 'active',
          priority: 3,
          progress: '',
          nextAction: '',
          targetDate: null,
          mirrorToPrimary: false,
          taintedOrigin: false,
          autonomy: true,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        stalled = {
          ...newTaskRecord(
            { agentId: owner, goalId: goal.id, type: 'scheduled', trust: 'assistant', trigger: {} },
            randomUUID(),
            now,
          ),
          status: 'needs_attention',
        };
        if (backend === 'postgres') {
          db = createDb(process.env.TEST_DATABASE_URL as string);
          await db.insert(agents).values({
            id: owner,
            name: 'Goal race',
            email: `${owner}@example.test`,
            workspacePrefix: owner,
          });
          await db.insert(goals).values(goal);
          await db.insert(tasks).values(stalled);
          repository = createPostgresScheduleRepository(db);
        } else {
          store = emulatorStore();
          await store.doc('agents', owner).set({ id: owner, name: 'Owner' });
          await store.doc('goals', goal.id).set(encodeRecord(goal));
          await store.doc('tasks', stalled.id).set(encodeRecord(stalled));
          repository = new FirestoreScheduleRepository(store);
        }
        const template = {
          type: 'scheduled' as const,
          goalId: goal.id,
          instruction: 'Continue the goal',
        };
        const schedule = await repository.ensure({
          agentId: owner,
          name: `goal:${goal.id}`,
          cron: '* * * * *',
          taskTemplate: template,
          nextRunAt: now,
        });
        const prepared = await prepareGoalSession(
          {
            goals: db
              ? createPostgresGoalRuntimeRepository(db)
              : new FirestoreGoalRuntimeRepository(store as InstallationStore, owner),
            tasks: db
              ? createPostgresTaskRepository(db)
              : new FirestoreTaskRepository(store as InstallationStore),
          },
          owner,
          template,
        );
        expect(prepared.action).toBe('fire');
        // Preparation itself must never invalidate the owner's continuation.
        expect((await readTask()).status).toBe('needs_attention');
        const event = `schedule:${schedule.id}:${now.toISOString()}`;
        occurrence = {
          expected: schedule,
          goalGuard: prepared.goalGuard,
          now,
          mode: 'due',
          enabled: true,
          nextRunAt: new Date(now.getTime() + 60_000),
          task: {
            agentId: owner,
            goalId: goal.id,
            type: 'scheduled',
            trust: 'assistant',
            externalEventId: event,
            trigger: {
              source: 'schedule',
              payload: { scheduleId: schedule.id, occurrenceId: event },
            },
          },
        };
      });
      afterEach(async () => {
        vi.restoreAllMocks();
        if (store) {
          await disposeStore(store);
          store = undefined;
        }
        if (db) {
          await db.delete(tasks).where(eq(tasks.agentId, owner));
          await db.delete(schedules).where(eq(schedules.agentId, owner));
          await db.delete(goals).where(eq(goals.agentId, owner));
          await db.delete(agents).where(eq(agents.id, owner));
          await db.$client.end();
          db = undefined;
        }
      });
      async function readTask(): Promise<Records['tasks']> {
        if (db)
          return (
            await db.select().from(tasks).where(eq(tasks.id, stalled.id))
          )[0] as Records['tasks'];
        return decodeRecord<Records['tasks']>(
          (await store?.doc('tasks', stalled.id).get())?.data(),
        );
      }
      async function allTasks() {
        if (db) return db.select().from(tasks).where(eq(tasks.agentId, owner));
        return (
          await (store as InstallationStore).collection('tasks').where('agentId', '==', owner).get()
        ).docs.map((doc) => decodeRecord<Records['tasks']>(doc.data()));
      }
      it.each([
        'owner-wake',
        'approved-resume',
        'schedule-disable',
        'goal-archive',
        'autonomy-revoke',
        'new-attended-work',
      ] as const)(
        'preserves work when %s occurs between preparation and commit',
        async (change) => {
          if (change === 'owner-wake' || change === 'approved-resume') {
            const patch = {
              status: change === 'owner-wake' ? 'pending' : 'running',
              updatedAt: new Date(now.getTime() + 1),
              ...(change === 'approved-resume'
                ? { leaseToken: randomUUID(), lockedUntil: new Date(now.getTime() + 60_000) }
                : {}),
            };
            if (db) await db.update(tasks).set(patch).where(eq(tasks.id, stalled.id));
            else await store?.doc('tasks', stalled.id).update(encodeRecord(patch));
          } else if (change === 'schedule-disable') {
            if (db)
              await db
                .update(schedules)
                .set({ enabled: false })
                .where(eq(schedules.id, occurrence.expected.id));
            else await store?.doc('schedules', occurrence.expected.id).update({ enabled: false });
          } else if (change === 'new-attended-work') {
            const task = newTaskRecord(
              { agentId: owner, goalId: goal.id, type: 'chat_turn', trust: 'owner', trigger: {} },
              randomUUID(),
              now,
            );
            if (db) await db.insert(tasks).values(task);
            else await store?.doc('tasks', task.id).set(encodeRecord(task));
          } else {
            const patch =
              change === 'goal-archive'
                ? { archivedAt: now }
                : { autonomy: false, updatedAt: new Date(now.getTime() + 1) };
            if (db) await db.update(goals).set(patch).where(eq(goals.id, goal.id));
            else await store?.doc('goals', goal.id).update(encodeRecord(patch));
          }
          expect(await repository.commitOccurrence(occurrence)).toBeNull();
          expect((await readTask()).status).not.toBe('cancelled');
          expect(
            (await allTasks()).filter(
              (task) => task.externalEventId === occurrence.task?.externalEventId,
            ),
          ).toHaveLength(0);
        },
      );
      it('commits exactly one replacement with supersession under concurrent sweepers', async () => {
        const results = await Promise.all([
          repository.commitOccurrence(occurrence),
          repository.commitOccurrence(occurrence),
        ]);
        expect(results.filter((result) => result?.task?.created)).toHaveLength(1);
        expect((await readTask()).status).toBe('cancelled');
        expect(
          (await allTasks()).filter(
            (task) => task.externalEventId === occurrence.task?.externalEventId,
          ),
        ).toHaveLength(1);
      }, 30_000);
      it('rolls back supersession and replacement when the final schedule write fails', async () => {
        if (db) {
          const database = db;
          await expect(
            database.transaction(async (tx) => {
              expect(
                (
                  await createPostgresScheduleRepository(tx as unknown as Db).commitOccurrence(
                    occurrence,
                  )
                )?.task?.created,
              ).toBe(true);
              throw new Error('final commit failed');
            }),
          ).rejects.toThrow('final commit failed');
        } else {
          const installation = store as InstallationStore;
          const original = installation.db.runTransaction.bind(installation.db);
          vi.spyOn(installation.db, 'runTransaction').mockImplementation((callback) =>
            original(async (tx) =>
              callback(
                new Proxy(tx, {
                  get(target, key) {
                    if (key === 'update')
                      return (ref: { path: string }, ...args: unknown[]) => {
                        if (ref.path === installation.doc('schedules', occurrence.expected.id).path)
                          throw new Error('final commit failed');
                        return Reflect.apply(target.update, target, [ref, ...args]);
                      };
                    const value = Reflect.get(target, key, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                  },
                }),
              ),
            ),
          );
          await expect(repository.commitOccurrence(occurrence)).rejects.toThrow(
            'final commit failed',
          );
        }
        expect((await readTask()).status).toBe('needs_attention');
        expect(await allTasks()).toHaveLength(1);
      });
    },
  );
}
