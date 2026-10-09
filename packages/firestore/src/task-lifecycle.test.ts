import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirestoreLocationPingRepository } from './location-pings.js';
import type { InstallationStore } from './store.js';
import { FirestoreTaskRepository } from './task-lifecycle.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore task lifecycle coordination',
  () => {
    let store: InstallationStore, repo: FirestoreTaskRepository;
    beforeEach(async () => {
      store = emulatorStore();
      repo = new FirestoreTaskRepository(store);
      await store.doc('schedules', 'reminder').set({ id: 'reminder', enabled: true });
      await store.doc('tasks', 'task').set(
        taskFixture({
          id: 'task',
          agentId: 'agent',
          conversationId: 'conversation',
          reminderId: 'reminder',
        }),
      );
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await disposeStore(store);
    });
    it('commits sleep/wake generations with durable queue intents and excludes future tasks', async () => {
      const lease = await repo.claim('task');
      if (!lease) throw new Error('Missing test lease');
      expect(await repo.sleepTask(lease, { phase: 'paused' }, new Date(Date.now() + 60_000))).toBe(
        true,
      );
      expect((await store.collection('outbox').get()).size).toBe(1);
      expect(await repo.findDueTasks()).toEqual([]);
      expect(await repo.wakeTask('task')).toMatchObject({ queueGeneration: 2 });
      expect((await store.collection('outbox').get()).size).toBe(2);
      expect((await repo.findDueTasks()).map((t) => t.id)).toEqual(['task']);
    });
    it('preserves retry and reclaim budgets for metadata-only checkpoints', async () => {
      await store.doc('tasks', 'task').update({ attempt: 7, reclaimCount: 4 });
      const lease = await repo.claim('task');
      if (!lease) throw new Error('Missing test lease');
      const state = { plannerState: { planningRecall: { status: 'skipped' } } };
      expect(await repo.checkpoint(lease, state, { preserveFailureCounters: true })).toBe(true);
      const stored = await store.doc('tasks', 'task').get();
      expect(stored.get('attempt')).toBe(7);
      expect(stored.get('reclaimCount')).toBe(4);
      expect(stored.get('state')).toEqual(state);
      expect(stored.get('preserveFailureCounters')).toBeUndefined();
      expect(await repo.recordFailedAttempt(lease, 'first work step failed')).toBe('dead_letter');
    });
    it('returns only the ten preceding owner tasks for the same conversation and type', async () => {
      const base = new Date(Date.now() - 60_000);
      const ids = Array.from({ length: 12 }, (_, index) => `receipt-${index}`);
      await Promise.all(
        ids.map((id, index) => {
          const task = taskFixture({
            id,
            agentId: 'agent',
            conversationId: 'conversation',
            reminderId: '',
          });
          task.type = 'chat_turn';
          task.createdAt = new Date(base.getTime() + index * 1000);
          task.trigger = { payload: { text: `turn ${index}` } };
          return store.doc('tasks', id).set(task);
        }),
      );
      const unrelated = taskFixture({
        id: 'receipt-other',
        agentId: 'agent',
        conversationId: 'other-conversation',
        reminderId: '',
      });
      unrelated.type = 'chat_turn';
      unrelated.createdAt = new Date(base.getTime() + 20_000);
      await store.doc('tasks', unrelated.id).set(unrelated);

      const rows = await repo.precedingOwnerTasks({
        agentId: 'agent',
        conversationId: 'conversation',
        taskType: 'chat_turn',
        createdBefore: new Date(base.getTime() + 12_000),
        limit: 10,
      });
      expect(rows.map((row) => row.id)).toEqual(ids.slice(2).reverse());
    });
    it('creates an owned tainted scheduled child with its generation-zero wake atomically', async () => {
      const runAfter = new Date(store.now().getTime() + 60_000);
      const result = await repo.createScheduledFollowUp({
        parentTaskId: 'task',
        agentId: 'agent',
        conversationId: 'conversation',
        instruction: 'review this later',
        runAfter,
        trust: 'assistant',
        tainted: true,
      });
      expect(result.created).toBe(true);
      expect(result.task).toMatchObject({
        parentTaskId: 'task',
        agentId: 'agent',
        status: 'sleeping',
        queueGeneration: 0,
        runAfter,
        trust: 'assistant',
        trigger: {
          source: 'internal',
          payload: { instruction: 'review this later', taintedOrigin: true },
        },
      });
      const outbox = await store.collection('outbox').get();
      expect(outbox.size).toBe(1);
      expect(outbox.docs[0]?.get('taskId')).toBe(result.task.id);
      expect(outbox.docs[0]?.get('generation')).toBe(0);
    });
    it('rechecks a lease renewed after the recovery query before mutating it', async () => {
      await store.doc('tasks', 'task').update({ status: 'running', lockedUntil: new Date(0) });
      const runTransaction = store.db.runTransaction.bind(store.db);
      vi.spyOn(store.db, 'runTransaction').mockImplementationOnce(async (callback, options) => {
        await store.doc('tasks', 'task').update({ lockedUntil: new Date(Date.now() + 600_000) });
        return runTransaction(callback, options);
      });
      await repo.findDueTasks();
      expect((await store.doc('tasks', 'task').get()).get('status')).toBe('running');
      expect((await store.doc('tasks', 'task').get()).get('reclaimCount')).toBe(0);
    });
    it('dead-letters repeatedly abandoned work without publishing another queue intent', async () => {
      await store
        .doc('tasks', 'task')
        .update({ status: 'running', lockedUntil: new Date(0), reclaimCount: 7 });
      expect(await repo.findDueTasks()).toEqual([]);
      expect((await store.doc('tasks', 'task').get()).get('status')).toBe('needs_attention');
      expect((await store.collection('outbox').get()).size).toBe(0);
    });
    it('scopes recovery and the limited due batch before touching foreign tasks', async () => {
      for (let i = 0; i < 4; i++) {
        await store.doc('tasks', `foreign-${i}`).set({
          ...taskFixture({
            id: `foreign-${i}`,
            agentId: 'foreign-agent',
            conversationId: 'foreign-conversation',
            reminderId: 'reminder',
          }),
          updatedAt: new Date(0),
          ...(i === 0 ? { status: 'running', lockedUntil: new Date(0) } : {}),
        });
      }
      expect((await repo.findDueTasksForAgent('agent', 1)).map((task) => task.id)).toEqual([
        'task',
      ]);
      const foreignRunning = await store.doc('tasks', 'foreign-0').get();
      expect(foreignRunning.get('status')).toBe('running');
      expect(foreignRunning.get('reclaimCount')).toBe(0);
      expect(foreignRunning.get('queueGeneration')).toBe(0);
      expect((await repo.findDueTasksForAgent('foreign-agent', 3)).map((task) => task.id)).toEqual([
        'foreign-0',
        'foreign-1',
        'foreign-2',
      ]);
      expect((await store.doc('tasks', 'foreign-0').get()).get('status')).toBe('pending');
    });
    it('persists plans only for the current owner lease', async () => {
      const first = await repo.claim('task');
      if (!first) throw new Error('Missing initial lease');

      // Reclaim the task so the first worker's token is stale.
      await store.doc('tasks', 'task').update({ lockedUntil: new Date(0) });
      const replacement = await repo.claim('task');
      if (!replacement) throw new Error('Missing replacement lease');

      expect(await repo.persistPlan(first, { stale: true })).toBe(false);
      expect(
        await repo.persistPlan({ ...replacement, agentId: 'foreign-agent' }, { foreign: true }),
      ).toBe(false);
      expect(await repo.persistPlan(replacement, { steps: ['current'] })).toBe(true);
      expect((await store.doc('tasks', 'task').get()).get('plan')).toEqual({
        steps: ['current'],
      });
    });
    it('commits mission child failure and generic mission terminal reports atomically', async () => {
      const mission = taskFixture({
        id: 'mission-session-parent',
        agentId: 'agent',
        conversationId: 'conversation',
        reminderId: '',
      });
      mission.type = 'mission';
      mission.status = 'sleeping';
      const session = taskFixture({
        id: 'mission-session-child',
        agentId: 'agent',
        conversationId: 'conversation',
        reminderId: '',
      });
      session.type = 'adhoc';
      session.parentTaskId = mission.id;
      await store.doc('tasks', mission.id).set(mission);
      await store.doc('tasks', session.id).set(session);

      const sessionLease = await repo.claim(session.id);
      if (!sessionLease) throw new Error('Could not claim the mission session');
      expect(
        await repo.completeTask(sessionLease, {
          status: 'failed',
          progress: 'Do not copy unverified provider claims into the owner notice.',
        }),
      ).toBe(true);
      expect(await repo.completeTask(sessionLease, { status: 'failed' })).toBe(false);
      expect((await store.doc('tasks', mission.id).get()).get('status')).toBe('needs_attention');
      const sessionReport = await store
        .doc('missionReports', `mission:${mission.id}:session:${session.id}:terminal:failed`)
        .get();
      expect(sessionReport.get('outcome')).toBe('session_failed');
      expect(sessionReport.get('ownerStatus')).toBe('pending');
      expect(sessionReport.get('text')).not.toContain('unverified provider claims');

      const cancelledMission = taskFixture({
        id: 'mission-cancelled-parent',
        agentId: 'agent',
        conversationId: 'conversation',
        reminderId: '',
      });
      cancelledMission.type = 'mission';
      cancelledMission.status = 'sleeping';
      const cancelledSession = taskFixture({
        id: 'mission-cancelled-child',
        agentId: 'agent',
        conversationId: 'conversation',
        reminderId: '',
      });
      cancelledSession.type = 'adhoc';
      cancelledSession.parentTaskId = cancelledMission.id;
      await store.doc('tasks', cancelledMission.id).set(cancelledMission);
      await store.doc('tasks', cancelledSession.id).set(cancelledSession);
      const cancelledLease = await repo.claim(cancelledSession.id);
      if (!cancelledLease) throw new Error('Could not claim the mission session to cancel');
      expect(await repo.completeTask(cancelledLease, { status: 'cancelled' })).toBe(true);
      const cancelledReport = await store
        .doc(
          'missionReports',
          `mission:${cancelledMission.id}:session:${cancelledSession.id}:terminal:cancelled`,
        )
        .get();
      expect(cancelledReport.get('outcome')).toBe('session_cancelled');
      expect((await store.doc('tasks', cancelledMission.id).get()).get('status')).toBe(
        'needs_attention',
      );

      const generic = taskFixture({
        id: 'mission-generic-terminal',
        agentId: 'agent',
        conversationId: 'conversation',
        reminderId: '',
      });
      generic.type = 'mission';
      await store.doc('tasks', generic.id).set(generic);
      const genericLease = await repo.claim(generic.id);
      if (!genericLease) throw new Error('Could not claim the generic mission');
      expect(
        await repo.completeTask(genericLease, {
          status: 'done',
          progress: 'This generic status must not imply an external action succeeded.',
        }),
      ).toBe(true);
      const genericReport = await store
        .doc('missionReports', `mission:${generic.id}:task-terminal:done`)
        .get();
      expect(genericReport.get('outcome')).toBe('task_done');
      expect(genericReport.get('text')).toContain('does not verify external delivery');
      expect(genericReport.get('text')).not.toContain('external action succeeded');
    });
    it('redacts arrival capabilities and checkpoint state at terminal completion', async () => {
      const externalEventId = 'arrival:agent:2026-09-24';
      const arrival = taskFixture({
        id: 'arrival-terminal-redaction',
        agentId: 'agent',
        conversationId: '',
        reminderId: '',
      });
      arrival.trust = 'assistant';
      arrival.externalEventId = externalEventId;
      arrival.title = 'generic arrival';
      arrival.state = { contextWindow: [{ role: 'user', content: 'private place: Harbour' }] };
      arrival.trigger = {
        source: 'internal',
        externalEventId,
        payload: {
          kind: 'arrival',
          arrivalObservationId: 'opaque-reference',
          arrivalExpiresAt: '2026-09-24T12:05:00.000Z',
          instruction: 'generic location-free instruction',
        },
      };
      await store.doc('tasks', arrival.id).set(arrival);
      const lease = await repo.claim(arrival.id);
      if (!lease) throw new Error('Could not claim the arrival task');
      expect(await repo.completeTask(lease, { status: 'done' })).toBe(true);
      const completed = await store.doc('tasks', arrival.id).get();
      expect(completed.get('externalEventId')).toBe(externalEventId);
      expect(
        await new FirestoreLocationPingRepository(store).hasArrivalTaskSince(
          'agent',
          new Date(Date.now() - 60_000),
        ),
      ).toBe(true);
      expect(completed.get('title')).toBeNull();
      expect(completed.get('state')).toEqual({});
      expect(completed.get('trigger')).toMatchObject({ payload: { kind: 'arrival' } });
      expect(JSON.stringify(completed.get('trigger'))).not.toContain('opaque-reference');
      expect(JSON.stringify(completed.get('trigger'))).not.toContain('arrivalExpiresAt');
      expect(JSON.stringify(completed.get('trigger'))).not.toContain('instruction');
    });
    it('rolls back a dead-lettered mission session when its report write fails, then recovers once', async () => {
      const mission = taskFixture({
        id: 'mission-dead-letter-parent',
        agentId: 'agent',
        conversationId: 'conversation',
        reminderId: '',
      });
      mission.type = 'mission';
      mission.status = 'sleeping';
      const session = taskFixture({
        id: 'mission-dead-letter-child',
        agentId: 'agent',
        conversationId: 'conversation',
        reminderId: '',
      });
      session.type = 'adhoc';
      session.parentTaskId = mission.id;
      session.attempt = 7;
      await store.doc('tasks', mission.id).set(mission);
      await store.doc('tasks', session.id).set(session);
      const lease = await repo.claim(session.id);
      if (!lease) throw new Error('Could not claim mission session');

      const runTransaction = store.db.runTransaction.bind(store.db);
      vi.spyOn(store.db, 'runTransaction').mockImplementationOnce((callback, options) =>
        runTransaction(async (tx) => {
          await callback(tx);
          // Simulate a commit-time report-store fault after every write has
          // been staged. Firestore must abort the entire transaction.
          throw new Error('injected report write failure');
        }, options),
      );
      await expect(repo.recordFailedAttempt(lease, 'synthetic failure')).rejects.toThrow(
        'injected report write failure',
      );
      expect((await store.doc('tasks', session.id).get()).get('status')).toBe('running');
      expect((await store.doc('tasks', session.id).get()).get('attempt')).toBe(7);
      expect((await store.doc('tasks', mission.id).get()).get('status')).toBe('sleeping');
      expect(
        (await store.collection('missionReports').where('missionId', '==', mission.id).get()).size,
      ).toBe(0);

      expect(await repo.recordFailedAttempt(lease, 'synthetic failure')).toBe('dead_letter');
      expect(await repo.recordFailedAttempt(lease, 'duplicate delivery')).toBe('lost_lease');
      expect((await store.doc('tasks', session.id).get()).get('status')).toBe('needs_attention');
      expect((await store.doc('tasks', mission.id).get()).get('status')).toBe('needs_attention');
      const reports = await store
        .collection('missionReports')
        .where('missionId', '==', mission.id)
        .get();
      expect(reports.size).toBe(1);
      expect(reports.docs[0]?.get('outcome')).toBe('session_needs_attention');
      expect(reports.docs[0]?.get('text')).toContain('does not verify external delivery');

      const rootMission = taskFixture({
        id: 'mission-dead-letter-root',
        agentId: 'agent',
        conversationId: 'conversation',
        reminderId: '',
      });
      rootMission.type = 'mission';
      rootMission.attempt = 7;
      await store.doc('tasks', rootMission.id).set(rootMission);
      const rootLease = await repo.claim(rootMission.id);
      if (!rootLease) throw new Error('Could not claim root mission');
      expect(await repo.recordFailedAttempt(rootLease, 'root synthetic failure')).toBe(
        'dead_letter',
      );
      const rootReport = await store
        .doc('missionReports', `mission:${rootMission.id}:task-terminal:needs_attention:attempt:8`)
        .get();
      expect(rootReport.get('outcome')).toBe('task_needs_attention');
      expect(rootReport.get('text')).toContain('does not verify external delivery');
    });
  },
);
