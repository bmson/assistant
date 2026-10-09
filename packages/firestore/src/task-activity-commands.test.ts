import { randomUUID } from 'node:crypto';
import {
  chatAdmissionCancellationTrigger,
  chatAdmissionExternalEventId,
} from '@assistant/persistence';
import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from './store.js';
import { FirestoreTaskActivityCommandRepository } from './task-activity-commands.js';
import { FirestoreTaskRepository } from './task-lifecycle.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore Activity retry and cancel commands',
  () => {
    let store: InstallationStore;
    let repository: FirestoreTaskActivityCommandRepository;
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const retryId = randomUUID();
    const runningId = randomUUID();
    const markerId = randomUUID();

    beforeEach(async () => {
      store = emulatorStore();
      repository = new FirestoreTaskActivityCommandRepository(store);
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('tasks', retryId).set({
        ...taskFixture({
          id: retryId,
          agentId,
          conversationId: randomUUID(),
          reminderId: '',
        }),
        status: 'needs_attention',
        queueGeneration: 5,
        attempt: 3,
        state: { checkpoint: 'resume', pendingFinal: { text: 'already delivered' } },
      });
      await store.doc('tasks', runningId).set({
        ...taskFixture({
          id: runningId,
          agentId,
          conversationId: randomUUID(),
          reminderId: '',
        }),
        status: 'running',
        lockedUntil: new Date(Date.now() + 60_000),
        leaseToken: randomUUID(),
      });
      await store.doc('tasks', 'foreign').set({
        ...taskFixture({
          id: 'foreign',
          agentId: foreignAgentId,
          conversationId: randomUUID(),
          reminderId: '',
        }),
        status: 'needs_attention',
      });
    });

    async function seedCancellationMarker() {
      const markerConversationId = randomUUID();
      const markerOperationId = randomUUID();
      await store.doc('tasks', markerId).set({
        ...taskFixture({
          id: markerId,
          agentId,
          conversationId: markerConversationId,
          reminderId: '',
        }),
        type: 'chat_turn',
        status: 'cancelled',
        title: null,
        progress: '',
        trust: 'owner',
        spentUsd: '0.000000',
        budgetUsdLimit: '0.5000',
        archivedAt: null,
        autonomyGrant: null,
        trigger: chatAdmissionCancellationTrigger({
          agentId,
          conversationId: markerConversationId,
          clientOperationId: markerOperationId,
        }),
        externalEventId: chatAdmissionExternalEventId({
          agentId,
          conversationId: markerConversationId,
          clientOperationId: markerOperationId,
        }),
        updatedAt: new Date('2020-01-01T00:00:00Z'),
      });
    }

    afterEach(async () => {
      await disposeStore(store);
    });

    it('retries once, reports the winning generation, and commits one matching wake intent', async () => {
      const results = await Promise.all([
        repository.retry(agentId, retryId),
        repository.retry(agentId, retryId),
      ]);
      expect(results.map((row) => row.outcome).sort()).toEqual(['no_longer_retriable', 'retried']);
      expect(results.filter((row) => row.transitioned)).toHaveLength(1);
      expect(results.find((row) => row.transitioned)).toMatchObject({
        outcome: 'retried',
        current: { status: 'pending', queueGeneration: 6 },
      });
      const task = await store.doc('tasks', retryId).get();
      expect(task.get('status')).toBe('pending');
      expect(task.get('queueGeneration')).toBe(6);
      expect(task.get('attempt')).toBe(0);
      expect(task.get('state')).toEqual({ checkpoint: 'resume' });
      const intents = await store.collection('outbox').get();
      expect(intents.size).toBe(1);
      expect(intents.docs[0]?.get('taskId')).toBe(retryId);
      expect(intents.docs[0]?.get('generation')).toBe(6);
    });

    it('rejects foreign work and fences retry during privacy erasure', async () => {
      await expect(repository.retry(agentId, 'foreign')).resolves.toMatchObject({
        outcome: 'not_found',
        transitioned: false,
        current: null,
      });
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(repository.retry(agentId, retryId)).rejects.toThrow(
        'Privacy erasure is in progress',
      );
      expect((await store.doc('tasks', retryId).get()).get('status')).toBe('needs_attention');
      expect((await store.collection('outbox').get()).size).toBe(0);
      await store.doc('privacyErasureJobs', agentId).delete();
      await expect(repository.cancel(agentId, 'foreign')).resolves.toMatchObject({
        outcome: 'not_found',
      });
    });

    it('hides cancellation marker task IDs from archive, restore, and archive-old', async () => {
      await seedCancellationMarker();
      await expect(repository.archive(agentId, markerId)).resolves.toMatchObject({
        outcome: 'not_found',
        transitioned: false,
        current: null,
      });
      await expect(repository.restore(agentId, markerId)).resolves.toMatchObject({
        outcome: 'not_found',
        transitioned: false,
        current: null,
      });
      const progress = await repository.archiveOld(agentId, 30);
      expect(progress.archivedTotal).toBe(0);
      const marker = await store.doc('tasks', markerId).get();
      expect(marker.get('status')).toBe('cancelled');
      expect(marker.get('archivedAt')).toBeNull();
    });

    it('cancels a running task idempotently and prevents its lease from being claimed', async () => {
      await expect(repository.cancel(agentId, runningId)).resolves.toMatchObject({
        outcome: 'cancelled',
        transitioned: true,
        current: { status: 'cancelled' },
      });
      await expect(repository.cancel(agentId, runningId)).resolves.toMatchObject({
        outcome: 'already_cancelled',
        transitioned: false,
        current: { status: 'cancelled' },
      });
      const task = await store.doc('tasks', runningId).get();
      expect(task.get('status')).toBe('cancelled');
      expect(task.get('leaseToken')).toBeNull();
      expect(task.get('lockedUntil')).toBeNull();
      expect(await new FirestoreTaskRepository(store).claim(runningId)).toBeNull();
    });

    it('leaves the task unchanged when cancellation races with privacy erasure', async () => {
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(repository.cancel(agentId, runningId)).rejects.toThrow(
        'Privacy erasure is in progress',
      );
      expect((await store.doc('tasks', runningId).get()).get('status')).toBe('running');
    });

    it.each(['done', 'failed'])(
      'does not turn an already %s result into cancellation',
      async (status) => {
        await store.doc('tasks', runningId).update({ status });
        await expect(repository.cancel(agentId, runningId)).resolves.toMatchObject({
          outcome: 'already_terminal',
          transitioned: false,
          current: { status },
        });
        expect((await store.doc('tasks', runningId).get()).get('status')).toBe(status);
      },
    );

    it('archives more than 400 rows in durable bounded batches and resumes after a retry', async () => {
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      for (let offset = 0; offset < 601; offset += 400) {
        const batch = store.db.batch();
        for (let index = offset; index < Math.min(offset + 400, 601); index += 1) {
          const id = `archive-${String(index).padStart(3, '0')}`;
          batch.set(store.doc('tasks', id), {
            ...taskFixture({
              id,
              agentId,
              conversationId: randomUUID(),
              reminderId: '',
            }),
            status: 'done',
            updatedAt: old,
          });
        }
        await batch.commit();
      }
      await store.doc('tasks', 'still-live').set({
        ...taskFixture({
          id: 'still-live',
          agentId,
          conversationId: randomUUID(),
          reminderId: '',
        }),
        status: 'running',
        updatedAt: old,
      });

      const first = await repository.archiveOld(agentId);
      expect(first).toMatchObject({
        archivedThisBatch: 250,
        archivedTotal: 250,
        scannedThisBatch: 250,
        scannedTotal: 250,
        complete: false,
      });
      expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/i);
      expect((await store.doc('tasks', 'still-live').get()).get('archivedAt')).toBeNull();

      // A restarted caller resumes the durable operation rather than restarting at page one.
      const second = await repository.archiveOld(agentId, 30, first.operationId ?? undefined);
      expect(second).toMatchObject({
        operationId: first.operationId,
        archivedThisBatch: 250,
        archivedTotal: 500,
        scannedTotal: 500,
        complete: false,
      });
      const third = await repository.archiveOld(agentId, 30, first.operationId ?? undefined);
      expect(third).toMatchObject({
        operationId: first.operationId,
        archivedThisBatch: 101,
        archivedTotal: 601,
        scannedTotal: 601,
        complete: true,
      });
      expect(
        (await store.collection('tasks').where('agentId', '==', agentId).get()).docs,
      ).toHaveLength(604);
      const archivedCount = (
        await store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .where('archivedAt', '!=', null)
          .get()
      ).size;
      expect(archivedCount).toBe(601);

      // Retrying a completed operation reports its stored total without starting another run.
      expect(
        await repository.archiveOld(agentId, 30, first.operationId ?? undefined),
      ).toMatchObject({ archivedTotal: 601, complete: true, scannedThisBatch: 0 });
    });

    it('rechecks ownership and privacy erasure before each continuation batch', async () => {
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      for (let index = 0; index < 251; index += 1) {
        const id = `erase-archive-${String(index).padStart(3, '0')}`;
        await store.doc('tasks', id).set({
          ...taskFixture({
            id,
            agentId,
            conversationId: randomUUID(),
            reminderId: '',
          }),
          status: 'done',
          updatedAt: old,
        });
      }
      const first = await repository.archiveOld(agentId);
      expect(first.complete).toBe(false);
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
      await expect(
        repository.archiveOld(agentId, 30, first.operationId ?? undefined),
      ).rejects.toThrow('Privacy erasure is in progress');
      const unarchived = await store
        .collection('tasks')
        .where('agentId', '==', agentId)
        .where('archivedAt', '==', null)
        .get();
      expect(unarchived.docs.filter((doc) => doc.get('status') === 'done')).toHaveLength(1);
    });
  },
);
