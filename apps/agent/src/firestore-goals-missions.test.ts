import { randomUUID } from 'node:crypto';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import {
  type ExecutorDeps,
  executeTask,
  type Plan,
  type Reflection,
  TaskStateSchema,
} from '@assistant/core';
import {
  createInstallationStore,
  FirestoreOwnerNoticeRepository,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import type { Records } from '@assistant/persistence';
import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createDb = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('createDb must not run in the Firestore composition');
  }),
);
vi.mock('@assistant/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/db')>()),
  createDb,
}));

const { composeFirestoreAgent } = await import('./deps.js');
const { runFirestoreSweep } = await import('./firestore-sweep.js');

type Task = Records['tasks'];

/**
 * The executor's Notifications delivery and goal-blocked write, the goal and
 * mission tools, the missions domain, and goal session scheduling, all on the
 * Firestore composition. Its `db` is the SQL tripwire, which throws on any
 * property access, and `createDb` must never run.
 */
describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore goals, missions, and Notifications delivery',
  () => {
    const agentId = randomUUID();
    let installationId: string;
    let store: ReturnType<typeof createInstallationStore>;
    let composed: ReturnType<typeof composeFirestoreAgent>;
    let deps: ExecutorDeps;
    let plan: Plan;
    let reflection: Reflection;
    let sqlErrors: string[];

    beforeEach(async () => {
      vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
      resetConfigForTest();
      installationId = `goals-missions-${randomUUID()}`;
      store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
      composed = composeFirestoreAgent(
        loadConfig({
          PERSISTENCE_DRIVER: 'firestore',
          ASSISTANT_MODULES: 'reminders',
          ASSISTANT_WORKSPACE_ID: installationId,
          FIRESTORE_AGENT_ID: agentId,
          FIRESTORE_EMBEDDING_SPACE:
            '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
          GCP_PROJECT: 'demo-assistant-test',
          QUEUE_DRIVER: 'local',
          OPENROUTER_API_KEY: 'test-key',
        }),
      );
      reflection = { decision: 'continue', reasoning: 'on track', progressPercent: 40 };
      deps = {
        db: composed.db,
        persistence: composed.persistence,
        // Only the planner and mission reflection may reach the model here.
        router: {
          object: async (role: string) => {
            if (role !== 'plan' && role !== 'reason')
              throw new Error(`Unexpected model role: ${role}`);
            return {
              ok: true,
              modelId: 'fake',
              degraded: false,
              object: role === 'plan' ? plan : reflection,
            };
          },
        } as unknown as ExecutorDeps['router'],
        dispatcher: composed.dispatcher,
      };
      sqlErrors = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        sqlErrors.push(
          ...args.map(String).filter((line) => line.includes('PostgreSQL access is unavailable')),
        );
      });
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
      await store.doc('coordination', 'budget-policy').set({
        dailyLimitMicros: 1_000_000,
        monthlyLimitMicros: 10_000_000,
        softPct: 80,
      });
    });

    afterEach(async () => {
      expect(sqlErrors).toEqual([]);
      expect(createDb).not.toHaveBeenCalled();
      await store.db.recursiveDelete(store.root);
      resetConfigForTest();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    function task(overrides: Partial<Task>): Task {
      return {
        ...taskFixture({ id: randomUUID(), agentId, conversationId: '', reminderId: '' }),
        conversationId: null,
        trigger: {},
        ...overrides,
      };
    }

    async function saveTask(row: Task): Promise<Task> {
      await store.doc('tasks', row.id).set(row);
      return row;
    }

    async function readTask(id: string): Promise<Task> {
      const snapshot = await store.doc('tasks', id).get();
      return snapshot.data() as Task;
    }

    async function chat(title: string, extra: Record<string, unknown> = {}) {
      const id = randomUUID();
      await store.doc('conversations', id).set({
        id,
        agentId,
        channel: 'chat',
        trust: 'owner',
        title,
        isPrimary: false,
        metadata: {},
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...extra,
      });
      return id;
    }

    /** Oldest first: an unordered query returns document-id order, so `.at(-1)` would be random. */
    async function messagesIn(conversationId: string) {
      const snapshot = await store
        .collection('messages')
        .where('conversationId', '==', conversationId)
        .get();
      return snapshot.docs
        .map((doc) => doc.data())
        .sort((left, right) => left.createdAt.toMillis() - right.createdAt.toMillis());
    }

    async function notificationsConversations() {
      const snapshot = await store
        .collection('conversations')
        .where('title', '==', 'Notifications')
        .get();
      return snapshot.docs.map((doc) => doc.get('id') as string);
    }

    function tool(name: string) {
      const found = composed.registry.get(name)?.tool;
      if (!found) throw new Error(`${name} was not registered`);
      return found;
    }

    function toolContext(taskId: string, tainted = false) {
      return {
        taskId,
        agentId,
        trust: 'owner',
        tainted,
        db: composed.db,
        now: () => new Date(),
        signal: new AbortController().signal,
        log: async () => {},
      } as never;
    }

    async function goal(fields: Partial<Records['goals']> = {}) {
      const id = randomUUID();
      const now = new Date();
      await store.doc('goals', id).set({
        id,
        agentId,
        title: 'Find a venue',
        description: 'Somewhere near the river',
        status: 'active',
        priority: 2,
        progress: 'Shortlisted three venues.',
        nextAction: 'Call the first venue.',
        targetDate: null,
        mirrorToPrimary: false,
        taintedOrigin: false,
        autonomy: false,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        ...fields,
      });
      return id;
    }

    it('delivers a conversation-less assistant final into the Notifications chat', async () => {
      const scheduled = await saveTask(
        task({
          type: 'scheduled',
          trust: 'assistant',
          title: 'Tomorrow check',
          state: TaskStateSchema.parse({
            pendingFinal: {
              text: 'Nothing on tomorrow.',
              progress: 'Checked tomorrow',
              terminalStatus: 'done',
              outcome: 'done',
            },
          }),
        }),
      );

      expect(await executeTask(deps, scheduled.id)).toEqual({
        outcome: 'done',
        detail: 'Checked tomorrow',
      });
      const [notificationsId] = await notificationsConversations();
      if (!notificationsId) throw new Error('Notifications conversation was not created');
      const delivered = await messagesIn(notificationsId);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        taskId: scheduled.id,
        role: 'assistant',
        text: '**Tomorrow check**\n\nNothing on tomorrow.',
      });
      expect((await readTask(scheduled.id)).status).toBe('done');
    });

    // Six transactions contend for one marker; under the emulator's shared lock
    // manager this takes ~3.5s and can pass 5s, so it gets the Firestore
    // package's emulator budget.
    it('converges racing first uses on one Notifications conversation', {
      timeout: 30_000,
    }, async () => {
      const finals = await Promise.all(
        ['First check', 'Second check'].map((title) =>
          saveTask(
            task({
              type: 'scheduled',
              trust: 'assistant',
              title,
              state: TaskStateSchema.parse({
                pendingFinal: {
                  text: `${title} done.`,
                  progress: title,
                  terminalStatus: 'done',
                  outcome: 'done',
                },
              }),
            }),
          ),
        ),
      );
      const direct = Array.from({ length: 4 }, () =>
        new FirestoreOwnerNoticeRepository(store, agentId).getOrCreate(agentId),
      );
      const [results, ids] = await Promise.all([
        Promise.all(finals.map((row) => executeTask(deps, row.id))),
        Promise.all(direct),
      ]);

      expect(results.map((result) => result.outcome)).toEqual(['done', 'done']);
      const conversations = await notificationsConversations();
      expect(conversations).toHaveLength(1);
      expect(new Set(ids)).toEqual(new Set(conversations));
      const marker = await store.doc('notificationConversations', agentId).get();
      expect(marker.get('conversationId')).toBe(conversations[0]);
      expect((await messagesIn(conversations[0] as string)).map((row) => row.text).sort()).toEqual([
        '**First check**\n\nFirst check done.',
        '**Second check**\n\nSecond check done.',
      ]);
    });

    it('parks an unattended goal session on its question and records it on the goal', async () => {
      const goalId = await goal();
      const workChat = await chat('Work: Find a venue', { metadata: { goalId } });
      const session = await saveTask(
        task({
          type: 'scheduled',
          trust: 'assistant',
          goalId,
          conversationId: workChat,
          trigger: {
            source: 'schedule',
            agentId,
            conversationId: workChat,
            trust: 'assistant',
            payload: { instruction: 'Run one focused goal session.', goalId },
          },
        }),
      );
      plan = {
        action: 'clarify',
        reasoning: 'The venue budget is unknown',
        steps: [],
        missingInfo: ['the venue budget'],
      };

      expect(await executeTask(deps, session.id)).toMatchObject({ outcome: 'needs_attention' });
      const blocked = await store.doc('goals', goalId).get();
      expect(blocked.get('nextAction')).toBe(
        'Waiting on the owner: I need one thing from you: The venue budget',
      );
      expect(blocked.get('progress')).toBe('Shortlisted three venues.');
      expect((await readTask(session.id)).status).toBe('needs_attention');
      expect((await messagesIn(workChat)).map((row) => row.text)).toContain(
        "This goal's automatic session is blocked until you answer: I need one thing from you: The venue budget",
      );
    });

    it('lists and creates goals through the goal tools', async () => {
      await goal({ title: 'Paused goal', status: 'paused', priority: 1 });
      await goal({ title: 'Low active goal', priority: 4 });
      await goal({ title: 'High active goal', priority: 1 });
      await goal({ title: 'Archived goal', archivedAt: new Date() });

      const listed = (await tool('goals.list').execute({}, toolContext(randomUUID()))) as {
        goals: Array<{ title: string }>;
      };
      expect(listed.goals.map((row) => row.title)).toEqual([
        'High active goal',
        'Low active goal',
        'Paused goal',
      ]);

      const created = (await tool('goals.create').execute(
        {
          title: 'Learn to sail',
          description: 'Get a dinghy certificate',
          priority: 2,
          targetDate: undefined,
        },
        toolContext(randomUUID(), true),
      )) as { goalId: string; title: string };
      const row = (await store.doc('goals', created.goalId).get()).data();
      expect(row).toMatchObject({
        agentId,
        title: 'Learn to sail',
        status: 'active',
        priority: 2,
        progress: '',
        nextAction: '',
        taintedOrigin: true,
        autonomy: false,
        archivedAt: null,
      });
      // Like the PostgreSQL goal sync: a work chat and a tainted daily
      // automation, but no opening task.
      const schedules = await store
        .collection('schedules')
        .where('name', '==', `goal:${created.goalId}`)
        .get();
      expect(schedules.size).toBe(1);
      expect(schedules.docs[0]?.get('cron')).toBe('15 9 * * *');
      expect(schedules.docs[0]?.get('taskTemplate')).toMatchObject({
        goalId: created.goalId,
        taintedOrigin: true,
      });
      const workChat = schedules.docs[0]?.get('taskTemplate.conversationId') as string;
      expect((await store.doc('conversations', workChat).get()).get('metadata')).toEqual({
        goalId: created.goalId,
      });
      expect((await messagesIn(workChat)).map((message) => message.text)).toEqual([
        'Automatic goal work is enabled. Use this chat to refine what I should prioritize.',
      ]);
      expect(
        (await store.collection('tasks').where('goalId', '==', created.goalId).get()).size,
      ).toBe(0);
    });

    it('starts a mission, wakes it into a session, records session progress, and reflects', async () => {
      const goalId = await goal({ mirrorToPrimary: true });
      const origin = await chat('Mortgage');
      const source = await saveTask(
        task({
          type: 'adhoc',
          trust: 'owner',
          goalId,
          conversationId: origin,
          trigger: {
            source: 'internal',
            agentId,
            conversationId: origin,
            trust: 'owner',
            payload: { instruction: 'Watch mortgage rates for me.' },
          },
        }),
      );
      plan = {
        action: 'mission',
        reasoning: 'Watch mortgage rates',
        steps: ['check rates', 'compare offers'],
        missingInfo: [],
      };

      expect(await executeTask(deps, source.id)).toMatchObject({ outcome: 'done' });
      const missions = await store.collection('tasks').where('type', '==', 'mission').get();
      expect(missions.size).toBe(1);
      const mission = missions.docs[0]?.data() as Task;
      expect(mission).toMatchObject({
        agentId,
        goalId,
        conversationId: origin,
        status: 'pending',
        reflectEvery: '7 days',
        nextAction: 'check rates',
        externalEventId: `mission:source:${source.id}`,
      });
      expect((await messagesIn(origin)).at(-1)?.text).toContain('Started a mission (id ');

      // First wake: no reflection is due, so a bounded session child spawns.
      expect(await executeTask(deps, mission.id)).toEqual({
        outcome: 'sleeping',
        detail: 'sessioned',
      });
      const sessions = await store
        .collection('tasks')
        .where('parentTaskId', '==', mission.id)
        .get();
      expect(sessions.size).toBe(1);
      const session = sessions.docs[0]?.data() as Task;
      expect(session).toMatchObject({ type: 'adhoc', status: 'pending', budgetUsdLimit: '0.2500' });
      expect(session.goalId).toBe(goalId);
      expect(session.parentTaskId).toBe(mission.id);
      const sessionPayload = (
        session.trigger as { payload?: { instruction?: string; missionId?: string } }
      ).payload;
      expect(sessionPayload?.missionId).toBe(mission.id);
      expect(sessionPayload?.instruction).toContain(`mission ${mission.id}`);
      expect(sessionPayload?.instruction).toContain(`goal ${goalId}`);
      expect(sessionPayload?.instruction).toContain('Watch mortgage rates');
      expect((await readTask(mission.id)).status).toBe('sleeping');

      // A wake while that session is still in flight never spawns a second one.
      await store.doc('tasks', mission.id).update({ status: 'pending', runAfter: null });
      expect(await executeTask(deps, mission.id)).toEqual({
        outcome: 'sleeping',
        detail: 'sessioned',
      });
      expect(
        (await store.collection('tasks').where('parentTaskId', '==', mission.id).get()).size,
      ).toBe(1);

      expect(
        await tool('mission.update').execute(
          {
            progress: 'Rates checked at three lenders.',
            nextAction: 'Compare offers',
            progressPercent: 30,
            notes: 'Lender B looks best.',
          },
          toolContext(session.id),
        ),
      ).toEqual({ updated: mission.id });
      const updated = await readTask(mission.id);
      expect(updated).toMatchObject({
        progress: 'Rates checked at three lenders.',
        nextAction: 'Compare offers',
        progressPercent: 30,
      });
      expect((updated.state as { scratchpad?: string }).scratchpad).toBe('Lender B looks best.');
      await expect(
        tool('mission.update').execute(
          { progress: 'Not a session', nextAction: '', notes: '' },
          toolContext(source.id),
        ),
      ).rejects.toThrow('this task has no parent mission');

      // Reflection is due: an escalation parks the mission and reports it in
      // its chat, mirrored into Notifications for the opted-in goal.
      await store.doc('tasks', session.id).update({ status: 'done' });
      await store.doc('tasks', mission.id).update({
        status: 'pending',
        runAfter: null,
        lastReflectedAt: new Date(Date.now() - 8 * 24 * 3600e3),
      });
      reflection = {
        decision: 'escalate',
        reasoning: 'rates need a decision',
        progressPercent: 50,
      };
      expect(await executeTask(deps, mission.id)).toEqual({
        outcome: 'sleeping',
        detail: 'reflected',
      });
      expect(await readTask(mission.id)).toMatchObject({
        status: 'needs_attention',
        progressPercent: 50,
      });
      expect((await messagesIn(origin)).at(-1)?.text).toBe(
        'Mission needs your attention: rates need a decision',
      );
      const [notificationsId] = await notificationsConversations();
      expect((await messagesIn(notificationsId as string)).map((row) => row.text)).toEqual([
        'Quick update on your “Find a venue” goal: Mission needs your attention: rates need a decision',
      ]);
    });

    it('stops a mission at its budget across all of its sessions', async () => {
      const origin = await chat('Mission budget');
      const mission = await saveTask(
        task({
          type: 'mission',
          trust: 'owner',
          conversationId: origin,
          budgetUsdLimit: '1.0000',
          spentUsd: '0.400000',
          trigger: { payload: { instruction: 'Track prices' } },
        }),
      );
      await saveTask(
        task({ type: 'adhoc', parentTaskId: mission.id, status: 'done', spentUsd: '0.600000' }),
      );

      expect(await executeTask(deps, mission.id)).toEqual({
        outcome: 'sleeping',
        detail: 'reflected',
      });
      expect((await readTask(mission.id)).status).toBe('needs_attention');
      expect((await messagesIn(origin)).at(-1)?.text).toBe(
        "This mission has used its full budget ($1.00 of $1.00). I've paused it — raise its budget or wake it from the dashboard to keep going.",
      );
    });

    it('runs goal sessions through the portable gate in the Firestore sweep', async () => {
      const schedules = new FirestoreScheduleRepository(store);
      const due = new Date(Date.now() - 60_000);
      const armed = await goal({ title: 'Armed goal', autonomy: true });
      const busy = await goal({ title: 'Busy goal' });
      const paused = await goal({ title: 'Paused goal', status: 'paused' });
      const workChat = await chat('Work: Armed goal', { metadata: { goalId: armed } });
      const ensure = (goalId: string, conversationId?: string) =>
        schedules.ensure({
          agentId,
          name: `goal:${goalId}`,
          cron: '15 9 * * *',
          taskTemplate: {
            type: 'scheduled',
            goalId,
            ...(conversationId ? { conversationId } : {}),
            budgetUsdLimit: '0.75',
            maxSteps: 16,
            instruction: 'Stale instruction from when the goal was created.',
          },
          nextRunAt: due,
        });
      const armedSchedule = await ensure(armed, workChat);
      const busySchedule = await ensure(busy);
      const pausedSchedule = await ensure(paused);
      // A stalled session that is not waiting on the owner is superseded; the
      // busy goal's session is still in flight, so it must not get a second one.
      const stalled = await saveTask(
        task({
          type: 'scheduled',
          goalId: armed,
          status: 'needs_attention',
          updatedAt: new Date(Date.now() - 3600e3),
        }),
      );
      await saveTask(task({ type: 'scheduled', goalId: busy, status: 'sleeping' }));

      const result = await runFirestoreSweep(composed);
      expect(result).toMatchObject({ ready: true, report: { schedulesFired: 1 } });

      const fired = (
        await store
          .collection('tasks')
          .where('goalId', '==', armed)
          .where('status', '==', 'pending')
          .get()
      ).docs.map((doc) => doc.data() as Task);
      expect(fired).toHaveLength(1);
      const [session] = fired;
      if (!session) throw new Error('goal session was not fired');
      const { instruction } = (session.trigger as { payload: { instruction: string } }).payload;
      expect(instruction).toContain('Verified progress from the last session: Shortlisted three');
      expect(instruction).not.toContain('Stale instruction');
      expect(session.autonomyGrant).toMatchObject({ grantedVia: 'goal' });
      expect(await readTask(stalled.id)).toMatchObject({
        status: 'cancelled',
        progress: 'superseded by the next automatic session',
      });

      const read = async (id: string) => (await store.doc('schedules', id).get()).data();
      expect((await read(armedSchedule.id))?.nextRunAt.toDate().getTime()).toBeGreaterThan(
        Date.now(),
      );
      expect((await read(busySchedule.id))?.nextRunAt.toDate().getTime()).toBeGreaterThan(
        Date.now(),
      );
      expect(await read(pausedSchedule.id)).toMatchObject({ enabled: false, nextRunAt: null });
      expect(
        (await store.collection('tasks').where('goalId', 'in', [busy, paused]).get()).size,
      ).toBe(1);
    });
  },
);
