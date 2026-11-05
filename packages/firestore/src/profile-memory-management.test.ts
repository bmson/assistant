import { createHash, randomUUID } from 'node:crypto';
import type { EmbeddingSpace, Records } from '@assistant/persistence';
import { FieldValue, type Transaction } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embeddingSpaceKey } from './memory.js';
import { FirestoreProfileMemoryManagementRepository } from './profile-memory-management.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = {
  provider: 'test',
  model: 'profile-memory-management',
  dimensions: 3,
  revision: '1',
};
const vector = [1, 0, 0];
const embeddingIdentity = { embeddingSpaceKey: embeddingSpaceKey(space) };
const testAgentId = 'agent-a';
const testContactId = 'owner-contact';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function memory(
  id: string,
  agentId: string,
  subjectContactId: string,
  content: string,
  patch: Partial<Records['memories']> = {},
): Records['memories'] {
  return {
    id,
    createdAt: new Date('2026-09-19T12:00:00Z'),
    agentId,
    expiresAt: null,
    embedding: vector,
    sourceTaskId: null,
    kind: 'fact',
    confidence: '0.70',
    contentHash: hash(content),
    goalId: null,
    originTrust: 'known',
    category: 'knowledge',
    content,
    importance: 4,
    quarantined: false,
    subjectContactId,
    domain: 'home',
    validFrom: null,
    validUntil: null,
    supersededById: null,
    ownerConfirmed: false,
    pinned: false,
    source: 'import:test',
    embeddingSpaceKey: null,
    lastAccessedAt: null,
    lastConsolidatedAt: null,
    ...patch,
  };
}

describe('Firestore profile memory witness writes', () => {
  it('writes fresh unattributed witnesses for manual creates, including same-hash recreation', () => {
    type CapturedWrite = {
      operation: 'create' | 'set';
      ref: { collection: string; id: string };
      data: Record<string, unknown>;
    };
    const firstWrites: CapturedWrite[] = [];
    const secondWrites: CapturedWrite[] = [];
    const fakeStore = {
      doc: (collection: string, id: string) => ({ collection, id }),
      now: () => new Date('2026-09-19T15:00:00Z'),
    } as unknown as InstallationStore;
    const transaction = (writes: CapturedWrite[]) =>
      ({
        create: (ref: { collection: string; id: string }, data: Record<string, unknown>) =>
          writes.push({ operation: 'create', ref, data }),
        set: (ref: { collection: string; id: string }, data: Record<string, unknown>) =>
          writes.push({ operation: 'set', ref, data }),
      }) as unknown as Transaction;
    const repository = new FirestoreProfileMemoryManagementRepository(fakeStore, space);
    const content = 'same manual fact';
    const input = {
      memoryId: randomUUID(),
      retrievalRevision: randomUUID(),
      subjectContactId: testContactId,
      content,
      contentHash: hash(content),
      domain: 'preferences',
      importance: 3,
      pinned: false,
      embedding: vector,
      embeddingSpaceKey: embeddingSpaceKey(space),
    };

    repository.createRecordInTransaction(transaction(firstWrites), testAgentId, input, new Date());
    repository.createRecordInTransaction(
      transaction(secondWrites),
      testAgentId,
      { ...input, retrievalRevision: randomUUID() },
      new Date(),
    );

    const memoryWrites = [firstWrites, secondWrites].map((writes) =>
      writes.find((write) => write.ref.collection === 'memories'),
    );
    const witnesses = memoryWrites.map((write) =>
      write ? decodeRecord<Records['memories']>(write.data).memoryWriteWitness : undefined,
    );
    expect(memoryWrites.every((write) => write?.ref.id === input.memoryId)).toBe(true);
    expect(witnesses[0]).toMatchObject({ contentHash: input.contentHash, attribution: null });
    expect(witnesses[1]).toMatchObject({ contentHash: input.contentHash, attribution: null });
    expect(witnesses[0]?.writeVersion).not.toBe(witnesses[1]?.writeVersion);
    expect(
      firstWrites.filter((write) => write.ref.collection === 'memoryContentHashes'),
    ).toHaveLength(1);
    expect(
      secondWrites.filter((write) => write.ref.collection === 'memoryContentHashes'),
    ).toHaveLength(1);
  });

  it('replaces prior/imported witness on a same-hash correction in the same transaction update', async () => {
    const id = randomUUID();
    const original = memory(id, testAgentId, testContactId, 'unchanged body', {
      memoryWriteWitness: {
        version: 1,
        writeVersion: '22222222-2222-4222-8222-222222222222',
        contentHash: hash('unchanged body'),
        attribution: {
          operationKey: 'b'.repeat(64),
          requestHash: 'c'.repeat(64),
          provenanceFingerprint: 'd'.repeat(64),
        },
      },
    });
    const memoryRef = { collection: 'memories', id };
    const snapshot = {
      exists: true,
      id: documentKey(id),
      ref: memoryRef,
      data: () => original,
    };
    const writes: Array<{
      operation: 'update' | 'set';
      ref: { collection: string; id: string };
      data: Record<string, unknown>;
    }> = [];
    const fakeStore = {
      doc: (collection: string, key: string) => ({ collection, id: key }),
      now: () => new Date('2026-09-19T15:00:00Z'),
    } as unknown as InstallationStore;
    const tx = {
      get: async () => snapshot,
      getAll: async (...refs: Array<{ collection: string; id: string }>) =>
        refs.map((ref) =>
          ref.collection === 'memoryTombstones'
            ? { exists: false }
            : { exists: true, get: (field: string) => (field === 'memoryId' ? id : undefined) },
        ),
      update: (ref: { collection: string; id: string }, data: Record<string, unknown>) =>
        writes.push({ operation: 'update', ref, data }),
      set: (ref: { collection: string; id: string }, data: Record<string, unknown>) =>
        writes.push({ operation: 'set', ref, data }),
    } as unknown as Transaction;
    const repository = new FirestoreProfileMemoryManagementRepository(fakeStore, space);
    const correction = {
      memoryId: id,
      expectedContentHash: original.contentHash,
      content: original.content,
      contentHash: original.contentHash,
      embedding: vector,
      embeddingSpaceKey: embeddingSpaceKey(space),
    };

    await repository.correctInTransaction(tx, testAgentId, correction);
    await repository.correctInTransaction(tx, testAgentId, correction);

    const updates = writes.filter((write) => write.operation === 'update');
    expect(updates).toHaveLength(2);
    const witnesses = updates.map(
      (write) =>
        decodeRecord<{ memoryWriteWitness: Records['memories']['memoryWriteWitness'] }>(write.data)
          .memoryWriteWitness,
    );
    expect(witnesses[0]).toMatchObject({ contentHash: original.contentHash, attribution: null });
    expect(witnesses[1]).toMatchObject({ contentHash: original.contentHash, attribution: null });
    expect(witnesses[0]?.writeVersion).not.toBe(original.memoryWriteWitness?.writeVersion);
    expect(witnesses[1]?.writeVersion).not.toBe(witnesses[0]?.writeVersion);
    expect(updates.every((write) => write.ref === memoryRef)).toBe(true);
  });
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore profile memory management repository',
  () => {
    let store: InstallationStore;
    let repository: FirestoreProfileMemoryManagementRepository;
    const agentId = 'agent-a';
    const contactId = 'owner-contact';

    beforeEach(async () => {
      store = emulatorStore(() => new Date('2026-09-19T15:00:00Z'));
      repository = new FirestoreProfileMemoryManagementRepository(store, space);
      await Promise.all([
        store.doc('agents', agentId).set({ id: agentId }),
        store.doc('contacts', contactId).set({ id: contactId, trust: 'owner' }),
      ]);
    });

    afterEach(async () => disposeStore(store));

    async function seed(row: Records['memories']): Promise<void> {
      await Promise.all([
        store.doc('memories', row.id).set(
          encodeRecord({
            ...row,
            embedding: row.embedding ? FieldValue.vector(row.embedding) : null,
            embeddingSpace: embeddingSpaceKey(space),
            retrievalRevision: randomUUID(),
          }),
        ),
        store.doc('memoryContentHashes', row.contentHash).set({ memoryId: row.id }),
      ]);
    }

    it('owner-scopes confirmation, restore, prominence, approval, and tombstoned reads', async () => {
      const id = randomUUID();
      const row = memory(id, agentId, contactId, 'A fact to review', {
        expiresAt: new Date('2026-09-18T00:00:00Z'),
        supersededById: randomUUID(),
        quarantined: true,
        importance: 1,
      });
      const foreign = memory(randomUUID(), 'agent-b', contactId, 'Foreign fact', {
        quarantined: true,
      });
      await Promise.all([seed(row), seed(foreign)]);
      await store.doc('ownerCards', agentId).set({
        agentId,
        content: 'compiled content',
        compiledAt: new Date('2026-09-19T14:00:00Z'),
      });

      expect(await repository.get(id)).toEqual({ id, agentId, contentHash: row.contentHash });
      expect(await repository.confirm(foreign.id)).toEqual({ status: 'not-found' });
      expect((await store.doc('memories', foreign.id).get()).get('quarantined')).toBe(true);
      expect(await repository.confirm(id)).toMatchObject({ status: 'updated' });
      await store.doc('memories', id).update({ quarantined: true });
      expect(await repository.restore(id)).toMatchObject({ status: 'updated' });
      expect(await repository.setProminence(id, 'minor')).toMatchObject({ status: 'updated' });
      expect(await repository.setProminence(id, 'auto')).toMatchObject({ status: 'updated' });
      expect(await repository.setProminence(id, 'always')).toMatchObject({ status: 'updated' });
      const restored = decodeRecord<Records['memories']>(
        (await store.doc('memories', id).get()).data(),
      );
      expect(restored).toMatchObject({
        expiresAt: null,
        supersededById: null,
        quarantined: false,
        ownerConfirmed: true,
        confidence: '1.00',
        importance: 3,
        pinned: true,
      });
      expect((await store.doc('ownerCards', agentId).get()).data()).toMatchObject({
        agentId,
        content: '',
      });

      await store.doc('memories', id).update({ quarantined: true });
      expect(await repository.approveQuarantined(id)).toMatchObject({ status: 'updated' });
      expect(await repository.approveQuarantined(id)).toMatchObject({ status: 'updated' });
      await store.doc('memoryTombstones', row.contentHash).set({ contentHash: row.contentHash });
      expect(await repository.get(id)).toBeNull();
      expect(await repository.confirm(id)).toEqual({ status: 'tombstoned' });
    });

    it('corrects with a hash CAS while preserving ownership and source provenance', async () => {
      const id = randomUUID();
      const original = memory(id, agentId, contactId, 'Original imported fact', {
        sourceTaskId: randomUUID(),
        source: 'takeout-mail-2025',
      });
      await seed(original);
      const correctedContent = 'Corrected owner fact';
      const correctedHash = hash(correctedContent);

      expect(
        await repository.correct({
          memoryId: id,
          expectedContentHash: 'stale-hash',
          content: correctedContent,
          contentHash: correctedHash,
          embedding: vector,
          ...embeddingIdentity,
        }),
      ).toEqual({ status: 'stale' });
      expect((await store.doc('memoryTombstones', original.contentHash).get()).exists).toBe(false);
      await store.doc('memories', id).update({ embeddingSpaceKey: 'b'.repeat(64) });
      expect(await repository.get(id)).toEqual({ id, agentId, contentHash: original.contentHash });

      const result = await repository.correct({
        memoryId: id,
        expectedContentHash: original.contentHash,
        content: correctedContent,
        contentHash: correctedHash,
        embedding: vector,
        ...embeddingIdentity,
      });
      expect(result).toEqual({
        status: 'updated',
        memory: { id, agentId, contentHash: correctedHash },
      });
      const snapshot = await store.doc('memories', id).get();
      const corrected = decodeRecord<Records['memories']>(snapshot.data());
      expect(corrected).toMatchObject({
        id,
        agentId,
        subjectContactId: contactId,
        sourceTaskId: original.sourceTaskId,
        source: original.source,
        content: correctedContent,
        contentHash: correctedHash,
        originTrust: 'owner',
        ownerConfirmed: true,
        quarantined: false,
      });
      expect(snapshot.get('embeddingSpace')).toBe(embeddingSpaceKey(space));
      expect(snapshot.get('embeddingSpaceKey')).toBe(embeddingSpaceKey(space));
      expect(snapshot.get('embedding').toArray()).toEqual(vector);
      expect(
        (await store.doc('memoryTombstones', original.contentHash).get()).data(),
      ).toMatchObject({
        contentHash: original.contentHash,
        reason: 'owner_correct',
      });
      expect((await store.doc('memoryContentHashes', original.contentHash).get()).exists).toBe(
        false,
      );
      expect((await store.doc('memoryContentHashes', correctedHash).get()).get('memoryId')).toBe(
        id,
      );
      expect((await store.doc('ownerCards', agentId).get()).get('content')).toBe('');
    });

    it('rejects forgotten and duplicate corrections without partially tombstoning the source', async () => {
      const source = memory(randomUUID(), agentId, contactId, 'Source fact');
      const duplicate = memory(randomUUID(), agentId, contactId, 'Duplicate target');
      await Promise.all([seed(source), seed(duplicate)]);
      const forgottenContent = 'Previously forgotten correction';
      const forgottenHash = hash(forgottenContent);
      await store.doc('memoryTombstones', forgottenHash).set({
        id: forgottenHash,
        contentHash: forgottenHash,
        reason: 'owner_forget',
        createdAt: new Date(),
      });

      expect(
        await repository.correct({
          memoryId: source.id,
          expectedContentHash: source.contentHash,
          content: forgottenContent,
          contentHash: forgottenHash,
          embedding: vector,
          ...embeddingIdentity,
        }),
      ).toEqual({ status: 'tombstoned' });
      expect(
        await repository.correct({
          memoryId: source.id,
          expectedContentHash: source.contentHash,
          content: duplicate.content,
          contentHash: duplicate.contentHash,
          embedding: vector,
          ...embeddingIdentity,
        }),
      ).toEqual({ status: 'duplicate' });
      expect((await store.doc('memoryTombstones', source.contentHash).get()).exists).toBe(false);
      expect((await store.doc('memories', source.id).get()).get('content')).toBe(source.content);
    });

    it('lets one concurrent correction win and leaves no index for the stale attempt', async () => {
      const source = memory(randomUUID(), agentId, contactId, 'Contested source');
      await seed(source);
      const first = { content: 'First correction', contentHash: hash('First correction') };
      const second = { content: 'Second correction', contentHash: hash('Second correction') };
      const results = await Promise.all([
        repository.correct({
          memoryId: source.id,
          expectedContentHash: source.contentHash,
          ...first,
          embedding: vector,
          ...embeddingIdentity,
        }),
        repository.correct({
          memoryId: source.id,
          expectedContentHash: source.contentHash,
          ...second,
          embedding: vector,
          ...embeddingIdentity,
        }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['stale', 'updated']);
      const storedHash = (await store.doc('memories', source.id).get()).get('contentHash');
      const losingHash = storedHash === first.contentHash ? second.contentHash : first.contentHash;
      expect((await store.doc('memoryContentHashes', storedHash).get()).get('memoryId')).toBe(
        source.id,
      );
      expect((await store.doc('memoryContentHashes', losingHash).get()).exists).toBe(false);
    });

    it('forgets and quarantine-rejects atomically with tombstone, index, and card changes', async () => {
      const forgotten = memory(randomUUID(), agentId, contactId, 'Forget this');
      const rejected = memory(randomUUID(), agentId, contactId, 'Reject this', {
        quarantined: true,
      });
      await Promise.all([seed(forgotten), seed(rejected)]);
      // Erasure depends on owner/document/content-hash identity, not vector metadata.
      await store.doc('memories', forgotten.id).update({ embeddingSpaceKey: 'b'.repeat(64) });

      expect(await repository.forget(forgotten.id, 'owner_forget')).toMatchObject({
        status: 'updated',
      });
      expect(await repository.forget(rejected.id, 'quarantine_reject')).toMatchObject({
        status: 'updated',
      });
      expect(await repository.forget(forgotten.id, 'owner_forget')).toEqual({
        status: 'updated',
        memory: {
          id: forgotten.id,
          agentId,
          contentHash: forgotten.contentHash,
        },
      });
      for (const [row, reason] of [
        [forgotten, 'owner_forget'],
        [rejected, 'quarantine_reject'],
      ] as const) {
        expect((await store.doc('memories', row.id).get()).exists).toBe(false);
        expect((await store.doc('memoryContentHashes', row.contentHash).get()).exists).toBe(false);
        expect((await store.doc('memoryTombstones', row.contentHash).get()).get('reason')).toBe(
          reason,
        );
        expect((await store.doc('graphDeletionIntents', row.id).get()).data()).toMatchObject({
          memoryId: row.id,
          agentId,
          contentHash: row.contentHash,
          cleanupCompletedAt: null,
        });
      }
      expect((await store.doc('ownerCards', agentId).get()).get('content')).toBe('');
    });

    it('creates manual facts idempotently and refuses missing or forgotten subjects and hashes', async () => {
      const missingSubject = {
        content: 'Missing subject fact',
        contentHash: hash('Missing subject fact'),
        embedding: vector,
        ...embeddingIdentity,
        importance: 3,
        pinned: false,
        subjectContactId: 'missing-contact',
      };
      expect(await repository.create(missingSubject)).toEqual({ status: 'not-found' });

      const forgotten = { ...missingSubject, subjectContactId: contactId };
      await store.doc('memoryTombstones', forgotten.contentHash).set({
        contentHash: forgotten.contentHash,
      });
      expect(await repository.create(forgotten)).toEqual({ status: 'tombstoned' });

      const content = 'A manually entered fact';
      const input = {
        content,
        contentHash: hash(content),
        embedding: vector,
        ...embeddingIdentity,
        importance: 5,
        pinned: true,
        subjectContactId: contactId,
        domain: 'preferences',
      };
      const results = await Promise.all([repository.create(input), repository.create(input)]);
      expect(results.map((result) => result.status).sort()).toEqual(['duplicate', 'updated']);
      const saved = results.find((result) => result.status === 'updated');
      const duplicate = results.find((result) => result.status === 'duplicate');
      if (saved?.status !== 'updated') throw new Error('Expected one created memory');
      expect(duplicate).toEqual({ status: 'duplicate', memory: saved.memory });
      expect(await repository.create({ ...input, subjectContactId: 'missing-contact' })).toEqual({
        status: 'not-found',
      });
      const snapshot = await store.doc('memories', saved.memory.id).get();
      expect(decodeRecord<Records['memories']>(snapshot.data())).toMatchObject({
        id: saved.memory.id,
        agentId,
        subjectContactId: contactId,
        content,
        contentHash: input.contentHash,
        source: 'manual',
        sourceTaskId: null,
        category: 'knowledge',
        kind: 'fact',
        ownerConfirmed: true,
        originTrust: 'owner',
        domain: 'preferences',
        importance: 5,
        pinned: true,
      });
      expect(snapshot.get('embedding').toArray()).toEqual(vector);
      expect(snapshot.get('embeddingSpace')).toBe(embeddingSpaceKey(space));
      expect(
        (await store.doc('memoryContentHashes', input.contentHash).get()).get('memoryId'),
      ).toBe(saved.memory.id);
    });
  },
);
