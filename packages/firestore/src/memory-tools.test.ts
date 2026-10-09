import { createHash, randomUUID } from 'node:crypto';
import { type EmbeddingSpace, embeddingSpaceIdentityKey } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreMemoryToolRepository } from './memory-tools.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = { provider: 'test', model: 'unit', dimensions: 3, revision: '1' };
const vector = [1, 0, 0];

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore memory tool repository', () => {
  let store: InstallationStore;
  beforeEach(() => {
    store = emulatorStore(() => new Date('2026-09-12T12:00:00Z'));
  });
  afterEach(async () => disposeStore(store));

  function input(content: string, overrides: Record<string, unknown> = {}) {
    return {
      agentId: 'agent',
      content,
      contentHash: createHash('sha256').update(`${content}-${randomUUID()}`).digest('hex'),
      embedding: vector,
      embeddingSpaceKey: embeddingSpaceIdentityKey(space),
      category: 'knowledge' as const,
      kind: 'fact' as const,
      importance: 3,
      confidence: 0.9,
      originTrust: 'owner',
      quarantined: false,
      ...overrides,
    };
  }

  it('saves idempotently, filters private and expired rows, hybrid-ranks, and records access', async () => {
    const repo = new FirestoreMemoryToolRepository(store, space);
    const coffee = input('The owner prefers coffee in the morning.');
    expect(await repo.screenContentHash('agent', coffee.contentHash)).toBe('new');
    expect(await repo.save(coffee)).toMatchObject({ saved: true, duplicate: false });
    expect(await repo.screenContentHash('agent', coffee.contentHash)).toBe('duplicate');
    expect(await repo.save(coffee)).toMatchObject({ saved: false, duplicate: true });
    await repo.save(input('The owner enjoys a quiet morning.'));
    await repo.save(
      input('A quarantined coffee note.', { quarantined: true, originTrust: 'unknown' }),
    );
    await repo.save(input('An expired coffee note.', { expiresAt: new Date(0) }));
    const foreign = input('A foreign coffee note.', { agentId: 'foreign' });
    await repo.save(foreign);
    await expect(repo.screenContentHash('agent', foreign.contentHash)).rejects.toThrow(
      'Memory duplicate preflight is unavailable',
    );
    expect(await repo.screenContentHash('foreign', foreign.contentHash)).toBe('duplicate');

    const result = await repo.recall({
      agentId: 'agent',
      embedding: vector,
      query: 'coffee',
      limit: 2,
      now: new Date('2026-09-12T12:00:00Z'),
      embeddingSpaceKey: embeddingSpaceIdentityKey(space),
    });
    expect(result.memories[0]?.content).toContain('coffee');
    expect(result.memories).toHaveLength(2);
    expect(result.memories.some((row) => row.content.startsWith('A quarantined'))).toBe(false);
    expect(result.memories.some((row) => row.content.startsWith('An expired'))).toBe(false);
    const [stored] = await store
      .collection('memories')
      .where('contentHash', '==', coffee.contentHash)
      .get()
      .then((snapshot) => snapshot.docs);
    expect(stored?.get('lastAccessedAt').toDate().getTime()).toBe(
      new Date('2026-09-12T12:00:00Z').getTime(),
    );
    expect(stored?.get('embeddingSpace')).toBe(embeddingSpaceIdentityKey(space));
  });

  it('preserves tombstones across retries', async () => {
    const repo = new FirestoreMemoryToolRepository(store, space);
    const raced = input('A fact forgotten after its preflight.');
    expect(await repo.screenContentHash('agent', raced.contentHash)).toBe('new');
    await store.doc('memoryTombstones', raced.contentHash).set({
      id: raced.contentHash,
      contentHash: raced.contentHash,
      reason: 'raced owner forget',
      createdAt: new Date(),
    });
    expect(await repo.save(raced)).toMatchObject({
      saved: false,
      duplicate: false,
      tombstoned: true,
    });

    const forgotten = input('A forgotten fact.');
    await store.doc('memoryTombstones', forgotten.contentHash).set({
      id: forgotten.contentHash,
      contentHash: forgotten.contentHash,
      reason: 'test',
      createdAt: new Date(),
    });
    expect(await repo.screenContentHash('agent', forgotten.contentHash)).toBe('tombstoned');
    expect(await repo.save(forgotten)).toMatchObject({
      saved: false,
      duplicate: false,
      tombstoned: true,
    });
  });

  it('keeps the constructor-captured vector identity when the input object changes', async () => {
    const configured: EmbeddingSpace = { ...space };
    const repository = new FirestoreMemoryToolRepository(store, configured);
    configured.provider = 'other-provider';
    configured.model = 'other-model';
    configured.dimensions = 768;
    configured.revision = 'changed';
    const fact = input('captured-space fact');

    expect(await repository.save(fact)).toMatchObject({ saved: true, duplicate: false });
    const stored = await store
      .collection('memories')
      .where('contentHash', '==', fact.contentHash)
      .get();
    expect(stored.docs[0]?.get('embeddingSpace')).toBe(embeddingSpaceIdentityKey(space));
    await expect(
      repository.save(
        input('foreign-space fact', {
          embeddingSpaceKey: embeddingSpaceIdentityKey({ ...space, revision: 'foreign' }),
        }),
      ),
    ).rejects.toThrow('embedding space identity');
  });

  it('fails closed for an orphan or mismatched hash sentinel', async () => {
    const repo = new FirestoreMemoryToolRepository(store, space);
    const orphan = input('An orphaned hash index.');
    await store.doc('memoryContentHashes', orphan.contentHash).set({
      id: orphan.contentHash,
      contentHash: orphan.contentHash,
      memoryId: 'missing-memory',
    });
    await expect(repo.screenContentHash('agent', orphan.contentHash)).rejects.toThrow(
      'Memory duplicate preflight is unavailable',
    );

    const foreign = input('A mismatched owner source.', { agentId: 'foreign' });
    const foreignSaved = await repo.save(foreign);
    expect(foreignSaved.id).toBeTruthy();
    await store.doc('memoryContentHashes', orphan.contentHash).set({
      id: orphan.contentHash,
      contentHash: orphan.contentHash,
      memoryId: foreignSaved.id,
    });
    await expect(repo.screenContentHash('agent', orphan.contentHash)).rejects.toThrow(
      'Memory duplicate preflight is unavailable',
    );
  });
});
