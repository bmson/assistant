import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FirestoreProfileMemoryMaintenance } from './profile-memory-maintenance.js';
import { FirestoreProfileMemoryManagementRepository } from './profile-memory-management.js';
import { disposeStore, emulatorStore } from './test-store.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

async function seedDeletionFence(
  store: ReturnType<typeof emulatorStore>,
  agentId: string,
  memoryId: string,
): Promise<void> {
  const contentHash = `hash-${memoryId}`;
  await Promise.all([
    store.doc('graphDeletionIntents', memoryId).set({
      memoryId,
      agentId,
      contentHash,
      cleanupCompletedAt: null,
    }),
    store.doc('memoryTombstones', contentHash).set({ contentHash }),
  ]);
}

describe.skipIf(!enabled)('Firestore profile memory maintenance', () => {
  it('resumes a faulted deletion from the durable memory intent', async () => {
    const store = emulatorStore(() => new Date('2026-09-19T22:14:37Z'));
    const agentId = randomUUID();
    const memoryId = randomUUID();
    const contentHash = `hash-${memoryId}`;
    const management = new FirestoreProfileMemoryManagementRepository(store, {
      provider: 'test',
      model: 'test',
      dimensions: 2,
      revision: '1',
    });
    try {
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('memories', memoryId).set({ id: memoryId, agentId, contentHash });
      await store.doc('memoryContentHashes', contentHash).set({ memoryId });
      await store
        .doc('knowledgeGraphSources', memoryId)
        .set({ memoryId, agentId, status: 'ready' });
      for (const entityId of ['left', 'right'])
        await store.doc('knowledgeGraphEntities', entityId).set({ id: entityId, agentId });
      await store
        .doc('knowledgeGraphEntityAliases', 'left-alias')
        .set({ id: 'left-alias', entityId: 'left', agentId });
      for (const relationId of ['first', 'second'])
        await store.doc('knowledgeGraphRelations', relationId).set({
          id: relationId,
          agentId,
          sourceMemoryId: memoryId,
          subjectEntityId: 'left',
          objectEntityId: 'right',
        });

      expect(await management.forget(memoryId, 'owner_forget')).toMatchObject({
        status: 'updated',
      });
      await expect(
        new FirestoreProfileMemoryMaintenance(store, {
          failAfterRelationDeletes: 1,
        }).removeOrphanedGraphEntities({ agentId, memoryId }),
      ).rejects.toThrow('Injected graph cleanup failure');
      expect(
        (
          await store
            .collection('knowledgeGraphRelations')
            .where('sourceMemoryId', '==', memoryId)
            .get()
        ).size,
      ).toBe(1);
      expect((await store.doc('knowledgeGraphEntities', 'left').get()).exists).toBe(true);

      expect(await management.forget(memoryId, 'owner_forget')).toMatchObject({
        status: 'updated',
        memory: { id: memoryId, agentId, contentHash },
      });
      await new FirestoreProfileMemoryMaintenance(store).removeOrphanedGraphEntities({
        agentId,
        memoryId,
      });
      expect(
        (
          await store
            .collection('knowledgeGraphRelations')
            .where('sourceMemoryId', '==', memoryId)
            .get()
        ).empty,
      ).toBe(true);
      expect((await store.doc('knowledgeGraphSources', memoryId).get()).exists).toBe(false);
      expect((await store.doc('knowledgeGraphEntities', 'left').get()).exists).toBe(false);
      expect((await store.doc('knowledgeGraphEntities', 'right').get()).exists).toBe(false);
      expect((await store.doc('knowledgeGraphEntityAliases', 'left-alias').get()).exists).toBe(
        false,
      );
      expect(
        (await store.doc('graphDeletionIntents', memoryId).get())
          .get('cleanupCompletedAt')
          .toDate(),
      ).toEqual(new Date('2026-09-19T22:14:37Z'));
    } finally {
      await disposeStore(store);
    }
  });

  it('deduplicates graph sync tasks across active jobs and repeated minute events', async () => {
    const now = new Date('2026-09-19T22:14:37Z');
    const store = emulatorStore(() => now);
    const repository = new FirestoreProfileMemoryMaintenance(store);
    const agentId = randomUUID();
    const memoryId = randomUUID();
    try {
      await Promise.all([
        repository.queueGraphSync({ agentId, memoryId }),
        repository.queueGraphSync({ agentId, memoryId }),
      ]);
      const first = await store.collection('tasks').where('agentId', '==', agentId).get();
      expect(first.size).toBe(1);
      expect(first.docs[0]?.get('trigger.payload.job')).toBe('memory.graph_sync');
      await first.docs[0]?.ref.update({ status: 'done' });
      await repository.queueGraphSync({ agentId, memoryId });
      expect((await store.collection('tasks').where('agentId', '==', agentId).get()).size).toBe(1);
    } finally {
      await disposeStore(store);
    }
  });

  it('retries only an owned blocked graph source', async () => {
    const now = new Date('2026-09-19T22:14:37Z');
    const store = emulatorStore(() => now);
    const repository = new FirestoreProfileMemoryMaintenance(store);
    const agentId = randomUUID();
    const memoryId = randomUUID();
    try {
      await store.doc('memories', memoryId).set({ id: memoryId, agentId });
      await store.doc('knowledgeGraphSources', memoryId).set({
        memoryId,
        status: 'quarantined',
        attempts: 4,
        lastError: 'blocked',
      });
      await repository.retryBlockedGraphSource({ agentId: randomUUID(), memoryId });
      expect((await store.doc('knowledgeGraphSources', memoryId).get()).get('status')).toBe(
        'quarantined',
      );
      await repository.retryBlockedGraphSource({ agentId, memoryId });
      const source = await store.doc('knowledgeGraphSources', memoryId).get();
      expect(source.get('status')).toBe('failed');
      expect(source.get('attempts')).toBe(0);
      expect(source.get('lastError')).toBeNull();
      expect(source.get('nextRetryAt').toDate()).toEqual(now);
    } finally {
      await disposeStore(store);
    }
  });

  it('cascades a forgotten projection and removes aliases only for orphaned entities', async () => {
    const store = emulatorStore();
    const repository = new FirestoreProfileMemoryMaintenance(store);
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const memoryId = randomUUID();
    const retainedMemoryId = randomUUID();
    try {
      await seedDeletionFence(store, agentId, memoryId);
      for (const [id, owner] of [
        ['orphan', agentId],
        ['shared', agentId],
        ['retained', agentId],
        ['foreign', foreignAgentId],
      ] as const)
        await store.doc('knowledgeGraphEntities', id).set({ id, agentId: owner });
      for (const [id, entityId, owner] of [
        ['orphan-alias', 'orphan', agentId],
        ['shared-alias', 'shared', agentId],
        ['foreign-alias', 'foreign', foreignAgentId],
      ] as const)
        await store.doc('knowledgeGraphEntityAliases', id).set({ id, entityId, agentId: owner });
      await store
        .doc('knowledgeGraphSources', memoryId)
        .set({ memoryId, agentId, status: 'ready' });
      await store.doc('knowledgeGraphRelations', 'forgotten').set({
        id: 'forgotten',
        agentId,
        sourceMemoryId: memoryId,
        subjectEntityId: 'orphan',
        objectEntityId: 'shared',
      });
      await store.doc('knowledgeGraphRelations', 'retained').set({
        id: 'retained',
        agentId,
        sourceMemoryId: retainedMemoryId,
        subjectEntityId: 'shared',
        objectEntityId: 'retained',
      });
      const unrelated = store.db.batch();
      for (let index = 0; index < 160; index++) {
        const id = `unrelated-${index}`;
        unrelated.set(store.doc('knowledgeGraphEntities', id), { id, agentId });
      }
      for (let index = 1; index < 125; index++) {
        const id = `forgotten-${index}`;
        unrelated.set(store.doc('knowledgeGraphRelations', id), {
          id,
          agentId,
          sourceMemoryId: memoryId,
          subjectEntityId: 'orphan',
          objectEntityId: 'shared',
        });
      }
      await unrelated.commit();

      await repository.removeOrphanedGraphEntities({ agentId, memoryId });
      await repository.removeOrphanedGraphEntities({ agentId, memoryId });

      expect((await store.doc('knowledgeGraphSources', memoryId).get()).exists).toBe(false);
      expect((await store.doc('knowledgeGraphRelations', 'forgotten').get()).exists).toBe(false);
      expect(
        (
          await store
            .collection('knowledgeGraphRelations')
            .where('sourceMemoryId', '==', memoryId)
            .get()
        ).empty,
      ).toBe(true);
      expect((await store.doc('knowledgeGraphEntities', 'orphan').get()).exists).toBe(false);
      expect((await store.doc('knowledgeGraphEntityAliases', 'orphan-alias').get()).exists).toBe(
        false,
      );
      expect((await store.doc('knowledgeGraphEntities', 'shared').get()).exists).toBe(true);
      expect((await store.doc('knowledgeGraphEntityAliases', 'shared-alias').get()).exists).toBe(
        true,
      );
      expect((await store.doc('knowledgeGraphEntities', 'foreign').get()).exists).toBe(true);
      expect((await store.doc('knowledgeGraphEntityAliases', 'foreign-alias').get()).exists).toBe(
        true,
      );
      expect((await store.doc('knowledgeGraphEntities', 'unrelated-159').get()).exists).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });

  it('removes canonical quotes across pages while preserving reviewed assertions and endpoints', async () => {
    const store = emulatorStore();
    const repository = new FirestoreProfileMemoryMaintenance(store);
    const agentId = randomUUID();
    const memoryId = randomUUID();
    const retainedMemoryId = randomUUID();
    const assertionId = randomUUID();
    const [subjectId, objectId] = [randomUUID(), randomUUID()];
    try {
      await seedDeletionFence(store, agentId, memoryId);
      const batch = store.db.batch();
      for (const id of [subjectId, objectId])
        batch.set(store.doc('knowledgeGraphEntities', id), { id, agentId });
      batch.set(store.doc('knowledgeGraphAssertions', assertionId), {
        id: assertionId,
        agentId,
        subjectEntityId: subjectId,
        objectEntityId: objectId,
        reviewStatus: 'rejected',
        reviewedRevision: 2,
        reviewedPayloadHash: 'owner-review-hash',
        lifecycle: 'current',
        ownerAuthored: true,
      });
      batch.set(store.doc('knowledgeGraphRelations', 'forgotten-canonical-edge'), {
        id: 'forgotten-canonical-edge',
        agentId,
        assertionId,
        sourceMemoryId: memoryId,
        subjectEntityId: subjectId,
        objectEntityId: objectId,
      });
      for (let index = 0; index < 47; index++) {
        const id = randomUUID();
        batch.set(store.doc('knowledgeGraphAssertionEvidence', id), {
          id,
          agentId,
          assertionId,
          sourceMemoryId: memoryId,
          evidenceQuote: 'Private forgotten quote',
        });
      }
      const retainedId = randomUUID();
      batch.set(store.doc('knowledgeGraphAssertionEvidence', retainedId), {
        id: retainedId,
        agentId,
        assertionId,
        sourceMemoryId: retainedMemoryId,
        evidenceQuote: 'Retained separate source',
      });
      await batch.commit();
      await repository.removeOrphanedGraphEntities({ agentId, memoryId });
      await repository.removeOrphanedGraphEntities({ agentId, memoryId });
      expect(
        (
          await store
            .collection('knowledgeGraphAssertionEvidence')
            .where('sourceMemoryId', '==', memoryId)
            .get()
        ).empty,
      ).toBe(true);
      expect(
        (await store.doc('knowledgeGraphAssertionEvidence', retainedId).get()).get('evidenceQuote'),
      ).toBe('Retained separate source');
      expect((await store.doc('knowledgeGraphAssertions', assertionId).get()).data()).toMatchObject(
        {
          reviewStatus: 'rejected',
          reviewedRevision: 2,
          reviewedPayloadHash: 'owner-review-hash',
          ownerAuthored: true,
        },
      );
      for (const id of [subjectId, objectId])
        expect((await store.doc('knowledgeGraphEntities', id).get()).exists).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });

  it('refuses canonical evidence with foreign ownership before deleting its private quote', async () => {
    const store = emulatorStore();
    const memoryId = randomUUID();
    const evidenceId = randomUUID();
    try {
      await seedDeletionFence(store, 'owner', memoryId);
      await store.doc('knowledgeGraphAssertionEvidence', evidenceId).set({
        id: evidenceId,
        agentId: 'foreign',
        sourceMemoryId: memoryId,
        evidenceQuote: 'Foreign quote',
      });
      await expect(
        new FirestoreProfileMemoryMaintenance(store).removeOrphanedGraphEntities({
          agentId: 'owner',
          memoryId,
        }),
      ).rejects.toThrow('another agent');
      expect(
        (await store.doc('knowledgeGraphAssertionEvidence', evidenceId).get()).get('evidenceQuote'),
      ).toBe('Foreign quote');
    } finally {
      await disposeStore(store);
    }
  });

  it('refuses to cascade a source projection containing a foreign relation', async () => {
    const store = emulatorStore();
    const repository = new FirestoreProfileMemoryMaintenance(store);
    const memoryId = randomUUID();
    try {
      await seedDeletionFence(store, 'owner', memoryId);
      await store.doc('knowledgeGraphSources', memoryId).set({ memoryId, status: 'ready' });
      await store.doc('knowledgeGraphRelations', 'foreign').set({
        id: 'foreign',
        agentId: 'foreign-agent',
        sourceMemoryId: memoryId,
      });
      await expect(
        repository.removeOrphanedGraphEntities({ agentId: 'owner', memoryId }),
      ).rejects.toThrow('another agent');
      expect((await store.doc('knowledgeGraphSources', memoryId).get()).exists).toBe(true);
      expect((await store.doc('knowledgeGraphRelations', 'foreign').get()).exists).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });

  it('refuses an unowned zero-relation source when its memory is already absent', async () => {
    const store = emulatorStore();
    const repository = new FirestoreProfileMemoryMaintenance(store);
    const memoryId = randomUUID();
    try {
      await seedDeletionFence(store, 'owner', memoryId);
      await store
        .doc('knowledgeGraphSources', memoryId)
        .set({ memoryId, agentId: 'foreign-agent', status: 'ready' });
      await expect(
        repository.removeOrphanedGraphEntities({ agentId: 'owner', memoryId }),
      ).rejects.toThrow('another agent');
      expect((await store.doc('knowledgeGraphSources', memoryId).get()).exists).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });

  it('fails an oversized alias cleanup before deleting its source relation', async () => {
    const store = emulatorStore();
    const repository = new FirestoreProfileMemoryMaintenance(store);
    const agentId = 'owner';
    const memoryId = randomUUID();
    try {
      await seedDeletionFence(store, agentId, memoryId);
      const batch = store.db.batch();
      batch.set(store.doc('knowledgeGraphSources', memoryId), {
        memoryId,
        agentId,
        status: 'ready',
      });
      batch.set(store.doc('knowledgeGraphEntities', 'alias-heavy'), {
        id: 'alias-heavy',
        agentId,
      });
      batch.set(store.doc('knowledgeGraphEntities', 'other'), { id: 'other', agentId });
      batch.set(store.doc('knowledgeGraphRelations', 'only-relation'), {
        id: 'only-relation',
        agentId,
        sourceMemoryId: memoryId,
        subjectEntityId: 'alias-heavy',
        objectEntityId: 'other',
      });
      for (let index = 0; index <= 450; index++) {
        const id = `alias-${index}`;
        batch.set(store.doc('knowledgeGraphEntityAliases', id), {
          id,
          agentId,
          entityId: 'alias-heavy',
        });
      }
      await batch.commit();

      await expect(repository.removeOrphanedGraphEntities({ agentId, memoryId })).rejects.toThrow(
        'alias transaction bound',
      );
      expect((await store.doc('knowledgeGraphRelations', 'only-relation').get()).exists).toBe(true);
      expect((await store.doc('knowledgeGraphEntities', 'alias-heavy').get()).exists).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });
});
