import { createHash, randomUUID } from 'node:crypto';
import type { EmbeddingSpace, Records } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embeddingSpaceKey, FirestoreMemoryRepository } from './memory.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = { provider: 'test', model: 'unit', dimensions: 3, revision: '1' };
function memory(content: string, patch: Partial<Records['memories']> = {}): Records['memories'] {
  return {
    id: randomUUID(),
    agentId: 'agent',
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    createdAt: new Date(),
    expiresAt: null,
    embedding: [1, 0, 0],
    sourceTaskId: null,
    kind: 'fact',
    confidence: '1',
    goalId: null,
    originTrust: 'owner',
    category: 'knowledge',
    importance: 3,
    quarantined: false,
    subjectContactId: null,
    domain: null,
    validFrom: null,
    validUntil: null,
    supersededById: null,
    ownerConfirmed: true,
    pinned: false,
    source: 'test source',
    embeddingSpaceKey: null,
    lastAccessedAt: null,
    lastConsolidatedAt: null,
    ...patch,
  };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore vector feasibility', () => {
  let store: InstallationStore;
  let repo: FirestoreMemoryRepository;
  beforeEach(() => {
    store = emulatorStore();
    repo = new FirestoreMemoryRepository(store, space);
  });
  afterEach(async () => {
    await disposeStore(store);
  });
  it('retrieves matching vectors with provenance and excludes private/stale/other-agent records', async () => {
    await repo.save(memory('relevant'));
    await repo.save(memory('unrelated', { embedding: [0, 1, 0] }));
    await repo.save(memory('quarantined', { quarantined: true }));
    await repo.save(memory('expired', { expiresAt: new Date(0) }));
    await repo.save(memory('superseded', { supersededById: 'new' }));
    await repo.save(memory('other', { agentId: 'other' }));
    const result = await repo.retrieve({ agentId: 'agent', vector: [1, 0, 0], limit: 5 });
    expect(result.memories.map((m) => m.content)).toEqual(['relevant', 'unrelated']);
    expect(result.memories[0]).toMatchObject({ source: 'test source', similarity: 1 });
    expect(result.memories[0]).not.toHaveProperty('embedding');
    expect(result.memories[0]).not.toHaveProperty('retrievalRevision');
  });
  it('keeps incompatible model versions out of recall even with equal dimensions', async () => {
    await repo.save(memory('old'));
    const newer = new FirestoreMemoryRepository(store, { ...space, revision: '2' });
    expect((await newer.retrieve({ agentId: 'agent', vector: [1, 0, 0] })).memories).toEqual([]);
    await expect(repo.retrieve({ agentId: 'agent', vector: [1, 0] })).rejects.toThrow(
      'embedding space',
    );
    await expect(repo.retrieve({ agentId: 'agent', vector: [0, 0, 0] })).rejects.toThrow(
      'embedding space',
    );
  });

  it('pins 768- and 1536-wide storage identities against later caller mutation', async () => {
    const source768: EmbeddingSpace = {
      provider: 'test',
      model: 'unit-768',
      dimensions: 768,
      revision: 'r1',
    };
    const source1536: EmbeddingSpace = {
      provider: 'test',
      model: 'unit-1536',
      dimensions: 1536,
      revision: 'r1',
    };
    const repo768 = new FirestoreMemoryRepository(store, source768);
    const repo1536 = new FirestoreMemoryRepository(store, source1536);
    source768.dimensions = 1536;
    source768.revision = 'mutated';
    source1536.dimensions = 768;
    source1536.revision = 'mutated';

    const vector768 = [1, ...Array(767).fill(0)];
    const vector1536 = [1, ...Array(1535).fill(0)];
    const memory768 = memory('captured 768', { embedding: vector768 });
    const memory1536 = memory('captured 1536', { embedding: vector1536 });
    expect(await repo768.save(memory768)).toBe(true);
    expect(await repo1536.save(memory1536)).toBe(true);
    expect((await store.doc('memories', memory768.id).get()).get('embeddingSpace')).toBe(
      embeddingSpaceKey({
        provider: 'test',
        model: 'unit-768',
        dimensions: 768,
        revision: 'r1',
      }),
    );
    expect((await store.doc('memories', memory1536.id).get()).get('embeddingSpace')).toBe(
      embeddingSpaceKey({
        provider: 'test',
        model: 'unit-1536',
        dimensions: 1536,
        revision: 'r1',
      }),
    );
    expect((await repo768.retrieve({ agentId: 'agent', vector: vector768 })).memories).toHaveLength(
      1,
    );
    expect(
      (await repo1536.retrieve({ agentId: 'agent', vector: vector1536 })).memories,
    ).toHaveLength(1);
  });
  it('requires a consistent persisted identity on actual vector retrieval', async () => {
    const validAlias = memory('valid-alias');
    expect(await repo.save(validAlias)).toBe(true);
    const validResult = await repo.retrieve({ agentId: 'agent', vector: [1, 0, 0] });
    expect(validResult.memories.map((row) => row.id)).toContain(validAlias.id);
    expect(validResult.memories.find((row) => row.id === validAlias.id)).not.toHaveProperty(
      'embedding',
    );

    const identityless = memory('identityless-vector');
    expect(await repo.save(identityless)).toBe(true);
    await store.doc('memories', identityless.id).update({ embeddingSpace: FieldValue.delete() });
    expect(
      (await repo.retrieve({ agentId: 'agent', vector: [1, 0, 0] })).memories.map((row) => row.id),
    ).not.toContain(identityless.id);

    const inconsistent = memory('inconsistent-identity');
    expect(await repo.save(inconsistent)).toBe(true);
    await store.doc('memories', inconsistent.id).update({ embeddingSpaceKey: 'b'.repeat(64) });
    await expect(repo.retrieve({ agentId: 'agent', vector: [1, 0, 0] })).rejects.toThrow(
      'Memory embedding space identity is malformed or inconsistent',
    );
  });
  it('concurrent erasure wins over re-ingestion and its tombstone survives retries', async () => {
    const row = memory('forgotten');
    await Promise.all([repo.save(row), repo.forget(row.contentHash)]);
    expect(await repo.save({ ...row, id: randomUUID() })).toBe(false);
    expect((await repo.retrieve({ agentId: 'agent', vector: [1, 0, 0] })).memories).toEqual([]);
    expect((await store.doc('memoryTombstones', row.contentHash).get()).exists).toBe(true);
  });
});
