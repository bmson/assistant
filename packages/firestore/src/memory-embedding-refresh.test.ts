import { createHash, randomUUID } from 'node:crypto';
import { refreshMemoryEmbeddingPage } from '@assistant/core';
import { type EmbeddingSpace, embeddingSpaceIdentityKey } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, describe, expect, it } from 'vitest';
import { FirestoreMemoryEmbeddingRefreshRepository } from './memory-embedding-refresh.js';
import { FirestorePrivacyErasureRepository } from './privacy-erasure.js';
import { FirestorePrivacyExportRepository } from './privacy-export.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = { provider: 'test', model: 'refresh', dimensions: 3, revision: 'v2' };
const key = (value: string) => createHash('sha256').update(value).digest('hex');
const vector = (head: number) => [head, 0, 0];

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore completed-memory embedding refresh',
  () => {
    let store: InstallationStore;
    afterEach(async () => {
      if (store) await disposeStore(store);
    });

    async function seedMemory(
      agentId: string,
      content: string,
      embeddingSpace: string | null = key('old'),
    ) {
      const id = randomUUID();
      const contentHash = key(`${content}:${randomUUID()}`);
      await store.doc('memories', id).set(
        encodeRecord({
          id,
          agentId,
          content,
          contentHash,
          category: 'knowledge',
          kind: 'fact',
          embedding: FieldValue.vector(vector(1)),
          embeddingSpace,
          importance: 3,
          confidence: '0.90',
          originTrust: 'owner',
          quarantined: false,
          createdAt: new Date(),
          expiresAt: null,
        }),
      );
      return { id, content, contentHash };
    }

    it('applies a prepared vector after restart and does no work on same-space replay', async () => {
      store = emulatorStore();
      const agentId = randomUUID();
      const source = await seedMemory(agentId, 'completed source');
      const repository = new FirestoreMemoryEmbeddingRefreshRepository(store);
      const target = embeddingSpaceIdentityKey(space);
      const now = new Date('2026-10-07T12:00:00Z');
      const claim = await repository.claim({
        agentId,
        memoryId: source.id,
        sourceHash: source.contentHash,
        targetSpaceKey: target,
        targetDimensions: 3,
        now,
        leaseUntil: new Date(now.getTime() + 60_000),
      });
      expect(claim.kind).toBe('claimed');
      if (claim.kind !== 'claimed' || !claim.receipt.claimToken) throw new Error('claim failed');
      expect(
        await repository.savePrepared({
          agentId,
          receiptId: claim.receipt.id,
          claimToken: claim.receipt.claimToken,
          vector: vector(0.5),
          now,
        }),
      ).toBe(true);
      let calls = 0;
      const resumed = await refreshMemoryEmbeddingPage({
        repository,
        agentId,
        targetSpace: space,
        targetSpaceKey: target,
        batch: 10,
        embed: async () => {
          calls += 1;
          return vector(0.25);
        },
        now: () => new Date(now.getTime() + 1),
      });
      expect(resumed).toMatchObject({ resumed: 1, applied: 1, done: true });
      expect(calls).toBe(0);
      const saved = await store.doc('memories', source.id).get();
      expect(saved.get('embeddingSpace')).toBe(target);
      expect(saved.get('embedding').toArray()).toEqual(vector(0.5));
      const replay = await refreshMemoryEmbeddingPage({
        repository,
        agentId,
        targetSpace: space,
        targetSpaceKey: target,
        batch: 10,
        embed: async () => {
          calls += 1;
          return vector(0.25);
        },
        now: () => new Date(now.getTime() + 2),
      });
      expect(replay).toMatchObject({ done: true, applied: 0, embedded: 0 });
      expect(calls).toBe(0);
    });

    it('persists and replays a 2048-dimensional refresh without embedding twice', async () => {
      store = emulatorStore();
      const agentId = randomUUID();
      const source = await seedMemory(agentId, 'wide completed source');
      const repository = new FirestoreMemoryEmbeddingRefreshRepository(store);
      const targetSpace: EmbeddingSpace = {
        provider: 'synthetic',
        model: 'refresh-wide',
        dimensions: 2048,
        revision: 'wide-r1',
      };
      const targetSpaceKey = embeddingSpaceIdentityKey(targetSpace);
      const now = new Date('2026-10-07T12:30:00Z');
      const preparedVector = new Array(2048).fill(0.005);
      let embeddingCalls = 0;

      const result = await refreshMemoryEmbeddingPage({
        repository,
        agentId,
        targetSpace,
        targetSpaceKey,
        batch: 10,
        embed: async (_text, expectedSpace) => {
          embeddingCalls += 1;
          expect(expectedSpace).toEqual(targetSpace);
          expect(Object.isFrozen(expectedSpace)).toBe(true);
          return preparedVector;
        },
        now: () => now,
      });
      expect(result).toMatchObject({ embedded: 1, applied: 1, done: true });
      expect(embeddingCalls).toBe(1);

      const memory = await store.doc('memories', source.id).get();
      expect(memory.get('embeddingSpace')).toBe(targetSpaceKey);
      expect(memory.get('embedding').toArray()).toEqual(preparedVector);
      const receipts = await store
        .collection('memoryEmbeddingRefreshes')
        .where('agentId', '==', agentId)
        .where('targetSpaceKey', '==', targetSpaceKey)
        .get();
      expect(receipts.size).toBe(1);
      expect(receipts.docs[0]?.get('targetDimensions')).toBe(2048);
      expect(receipts.docs[0]?.get('status')).toBe('completed');

      const replay = await refreshMemoryEmbeddingPage({
        repository,
        agentId,
        targetSpace,
        targetSpaceKey,
        batch: 10,
        embed: async () => {
          embeddingCalls += 1;
          return preparedVector;
        },
        now: () => new Date(now.getTime() + 1),
      });
      expect(replay).toMatchObject({ embedded: 0, applied: 0, done: true });
      expect(embeddingCalls).toBe(1);
    });

    it('marks an expired unknown dispatch for review and only retries after explicit authorization', async () => {
      store = emulatorStore();
      const agentId = randomUUID();
      const source = await seedMemory(agentId, 'unknown provider attempt');
      const repository = new FirestoreMemoryEmbeddingRefreshRepository(store);
      const target = embeddingSpaceIdentityKey(space);
      const now = new Date('2026-10-07T12:00:00Z');
      const claim = await repository.claim({
        agentId,
        memoryId: source.id,
        sourceHash: source.contentHash,
        targetSpaceKey: target,
        targetDimensions: 3,
        now: new Date(now.getTime() - 10_000),
        leaseUntil: new Date(now.getTime() - 1_000),
      });
      expect(claim.kind).toBe('claimed');
      let calls = 0;
      const held = await refreshMemoryEmbeddingPage({
        repository,
        agentId,
        targetSpace: space,
        targetSpaceKey: target,
        batch: 10,
        embed: async () => {
          calls += 1;
          return vector(0.75);
        },
        now: () => now,
      });
      expect(held.needsReview).toBe(1);
      expect(calls).toBe(0);
      const unknown = (await repository.listUnknown(agentId, 5))[0];
      expect(unknown?.status).toBe('unknown');
      if (!unknown) throw new Error('unknown receipt missing');
      expect(
        await repository.resolveUnknown({
          agentId,
          receiptId: unknown.id,
          expectedUpdatedAt: unknown.updatedAt,
          action: 'authorize_retry',
          now: new Date(now.getTime() + 1),
        }),
      ).toMatchObject({ authorized: true });
      const retried = await refreshMemoryEmbeddingPage({
        repository,
        agentId,
        targetSpace: space,
        targetSpaceKey: target,
        batch: 10,
        embed: async () => {
          calls += 1;
          return vector(0.75);
        },
        now: () => new Date(now.getTime() + 2),
      });
      expect(retried.applied).toBe(1);
      expect(calls).toBe(1);
    });

    it('refuses a prepared vector after its source revision changes', async () => {
      store = emulatorStore();
      const agentId = randomUUID();
      const source = await seedMemory(agentId, 'before edit');
      const repository = new FirestoreMemoryEmbeddingRefreshRepository(store);
      const target = embeddingSpaceIdentityKey(space);
      const now = new Date();
      const claim = await repository.claim({
        agentId,
        memoryId: source.id,
        sourceHash: source.contentHash,
        targetSpaceKey: target,
        targetDimensions: 3,
        now,
        leaseUntil: new Date(now.getTime() + 60_000),
      });
      if (claim.kind !== 'claimed' || !claim.receipt.claimToken) throw new Error('claim failed');
      await repository.savePrepared({
        agentId,
        receiptId: claim.receipt.id,
        claimToken: claim.receipt.claimToken,
        vector: vector(0.5),
        now,
      });
      await store
        .doc('memories', source.id)
        .update({ content: 'after edit', contentHash: key('after edit') });
      expect(
        await repository.applyPrepared({
          agentId,
          memoryId: source.id,
          sourceHash: source.contentHash,
          targetSpaceKey: target,
          receiptId: claim.receipt.id,
          now: new Date(now.getTime() + 1),
        }),
      ).toBe('stale');
      expect((await store.doc('memories', source.id).get()).get('embeddingSpace')).toBe(key('old'));
    });

    it('does not rescore an explicitly abandoned unknown receipt', async () => {
      store = emulatorStore();
      const agentId = randomUUID();
      const source = await seedMemory(agentId, 'abandoned refresh');
      const repository = new FirestoreMemoryEmbeddingRefreshRepository(store);
      const target = embeddingSpaceIdentityKey(space);
      const now = new Date();
      const claim = await repository.claim({
        agentId,
        memoryId: source.id,
        sourceHash: source.contentHash,
        targetSpaceKey: target,
        targetDimensions: 3,
        now: new Date(now.getTime() - 10_000),
        leaseUntil: new Date(now.getTime() - 1_000),
      });
      if (claim.kind !== 'claimed') throw new Error('claim failed');
      await refreshMemoryEmbeddingPage({
        repository,
        agentId,
        targetSpace: space,
        targetSpaceKey: target,
        batch: 5,
        embed: async () => vector(0.75),
        now: () => now,
      });
      const unknown = (await repository.listUnknown(agentId, 5))[0];
      if (!unknown) throw new Error('unknown receipt missing');
      await repository.resolveUnknown({
        agentId,
        receiptId: unknown.id,
        expectedUpdatedAt: unknown.updatedAt,
        action: 'abandon',
        now: new Date(now.getTime() + 1),
      });
      let calls = 0;
      const replay = await refreshMemoryEmbeddingPage({
        repository,
        agentId,
        targetSpace: space,
        targetSpaceKey: target,
        batch: 5,
        embed: async () => {
          calls += 1;
          return vector(0.25);
        },
        now: () => new Date(now.getTime() + 2),
      });
      expect(replay.embedded).toBe(0);
      expect(calls).toBe(0);
    });

    it('clears callback output after source edits, deletion, and a completed privacy-generation change', async () => {
      store = emulatorStore();
      const agentId = randomUUID();
      await store
        .doc('agents', agentId)
        .set({ id: agentId, createdAt: new Date(), workspacePrefix: `owners/${agentId}` });
      const repository = new FirestoreMemoryEmbeddingRefreshRepository(store);
      const target = embeddingSpaceIdentityKey(space);
      const now = new Date('2026-10-07T14:00:00Z');

      const claimFor = async (content: string, offset: number) => {
        const source = await seedMemory(agentId, content);
        const claim = await repository.claim({
          agentId,
          memoryId: source.id,
          sourceHash: source.contentHash,
          targetSpaceKey: target,
          targetDimensions: 3,
          now: new Date(now.getTime() + offset),
          leaseUntil: new Date(now.getTime() + offset + 60_000),
        });
        if (claim.kind !== 'claimed' || !claim.receipt.claimToken) throw new Error('claim failed');
        return { source, receipt: claim.receipt };
      };
      const saveAfterCallback = (
        receipt: { id: string; claimToken: string | null },
        offset: number,
      ) =>
        repository.savePrepared({
          agentId,
          receiptId: receipt.id,
          claimToken: receipt.claimToken as string,
          vector: vector(0.5),
          now: new Date(now.getTime() + offset),
        });
      const assertStaleWithoutVector = async (receiptId: string) => {
        const row = await store.doc('memoryEmbeddingRefreshes', receiptId).get();
        expect(row.get('status')).toBe('stale');
        expect(row.get('preparedVector')).toBeNull();
      };

      const edited = await claimFor('edit during embed', 0);
      await store
        .doc('memories', edited.source.id)
        .update({ content: 'edited', contentHash: key('edited after claim') });
      expect(await saveAfterCallback(edited.receipt, 1)).toBe(false);
      await assertStaleWithoutVector(edited.receipt.id);

      const deleted = await claimFor('delete during embed', 2);
      await store.doc('memories', deleted.source.id).delete();
      expect(await saveAfterCallback(deleted.receipt, 3)).toBe(false);
      await assertStaleWithoutVector(deleted.receipt.id);

      const forgotten = await claimFor('forget during embed', 4);
      await store.doc('privacyErasureJobs', agentId).set({
        agentId,
        generation: randomUUID(),
        status: 'complete',
        counts: {},
        updatedAt: new Date(now.getTime() + 5),
      });
      expect(await saveAfterCallback(forgotten.receipt, 6)).toBe(false);
      await assertStaleWithoutVector(forgotten.receipt.id);
    });

    it('excludes prepared vectors from privacy export and erases receipts and cursors', async () => {
      store = emulatorStore();
      const agentId = randomUUID();
      await store
        .doc('agents', agentId)
        .set({ id: agentId, createdAt: new Date(), workspacePrefix: `owners/${agentId}` });
      const source = await seedMemory(agentId, 'private refresh source');
      const repository = new FirestoreMemoryEmbeddingRefreshRepository(store);
      const target = embeddingSpaceIdentityKey(space);
      const now = new Date();
      const claim = await repository.claim({
        agentId,
        memoryId: source.id,
        sourceHash: source.contentHash,
        targetSpaceKey: target,
        targetDimensions: 3,
        now,
        leaseUntil: new Date(now.getTime() + 60_000),
      });
      if (claim.kind !== 'claimed' || !claim.receipt.claimToken) throw new Error('claim failed');
      await repository.savePrepared({
        agentId,
        receiptId: claim.receipt.id,
        claimToken: claim.receipt.claimToken,
        vector: vector(0.5),
        now,
      });
      await repository.saveCursor(agentId, target, source.id);
      const exported = await new FirestorePrivacyExportRepository(store).exportOwnerData();
      expect(JSON.stringify(exported)).not.toContain('memoryEmbeddingRefreshes');
      expect(JSON.stringify(exported)).not.toContain('preparedVector');
      expect(JSON.stringify(exported)).not.toContain('0.5,0,0');
      const erasure = new FirestorePrivacyErasureRepository(store, agentId);
      await erasure.erase();
      expect(
        (await store.collection('memoryEmbeddingRefreshes').where('agentId', '==', agentId).get())
          .empty,
      ).toBe(true);
      expect(
        (
          await store
            .collection('memoryEmbeddingRefreshCursors')
            .where('agentId', '==', agentId)
            .get()
        ).empty,
      ).toBe(true);
    });
  },
);
