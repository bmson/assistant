import { createHash, randomUUID } from 'node:crypto';
import type { Records } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { FirestoreOwnerCardCompilationRepository } from './owner-card-compilation.js';
import { encodeRecord } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

function memory(
  id: string,
  agentId: string,
  subjectContactId: string,
  content: string,
  patch: Partial<Records['memories']> = {},
): Records['memories'] {
  return {
    id,
    agentId,
    createdAt: new Date('2026-09-19T12:00:00Z'),
    expiresAt: null,
    embedding: null,
    sourceTaskId: null,
    kind: 'fact',
    confidence: '0.80',
    content,
    contentHash: createHash('sha256').update(id).digest('hex'),
    goalId: null,
    originTrust: 'owner',
    category: 'knowledge',
    importance: 4,
    quarantined: false,
    subjectContactId,
    domain: 'home',
    validFrom: null,
    validUntil: null,
    supersededById: null,
    ownerConfirmed: false,
    pinned: false,
    source: 'test',
    embeddingSpaceKey: null,
    lastAccessedAt: null,
    lastConsolidatedAt: null,
    ...patch,
  };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore owner-card compilation', () => {
  it('publishes only the requested agent’s eligible facts and person pins', async () => {
    const store = emulatorStore();
    try {
      const ownerId = randomUUID();
      const personId = randomUUID();
      await store.doc('contacts', ownerId).set(
        encodeRecord({
          id: ownerId,
          name: 'Owner',
          trust: 'owner',
          aliases: [],
          emails: [],
          phones: [],
          relationship: '',
          notes: '',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      await store.doc('contacts', personId).set(
        encodeRecord({
          id: personId,
          name: 'Known person',
          trust: 'known',
          aliases: [],
          emails: [],
          phones: [],
          relationship: 'friend',
          notes: 'private and never projected',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      const tombstoned = memory(randomUUID(), 'agent-a', ownerId, 'erased');
      const rows = [
        memory(randomUUID(), 'agent-a', ownerId, 'eligible'),
        memory(randomUUID(), 'agent-b', ownerId, 'foreign'),
        memory(randomUUID(), 'agent-a', ownerId, 'quarantined', { quarantined: true }),
        memory(randomUUID(), 'agent-a', ownerId, 'retired', { supersededById: randomUUID() }),
        memory(randomUUID(), 'agent-a', personId, 'pinned person fact', {
          pinned: true,
          importance: 1,
        }),
        tombstoned,
      ];
      await Promise.all(rows.map((row) => store.doc('memories', row.id).set(encodeRecord(row))));
      await store
        .doc('memoryTombstones', tombstoned.contentHash)
        .set({ contentHash: tombstoned.contentHash, reason: 'owner_forget' });
      const repository = new FirestoreOwnerCardCompilationRepository(store);
      const content = await repository.compile({
        agentId: 'agent-a',
        now: new Date('2026-09-19T13:00:00Z'),
        render: (input) => JSON.stringify(input),
      });
      expect(content).toContain('eligible');
      expect(content).toContain('pinned person fact');
      expect(content).not.toContain('foreign');
      expect(content).not.toContain('quarantined');
      expect(content).not.toContain('retired');
      expect(content).not.toContain('erased');
      expect(content).not.toContain('private and never projected');
      expect((await store.doc('ownerCards', 'agent-a').get()).data()).toMatchObject({
        agentId: 'agent-a',
        content,
      });
    } finally {
      await disposeStore(store);
    }
  });

  it('reads projected memory inputs across multiple bounded pages', async () => {
    const store = emulatorStore();
    try {
      const ownerId = randomUUID();
      await store.doc('contacts', ownerId).set(
        encodeRecord({
          id: ownerId,
          name: 'Owner',
          trust: 'owner',
          aliases: [],
          emails: [],
          phones: [],
          relationship: '',
          notes: '',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      const rows = Array.from({ length: 501 }, (_, index) =>
        memory(`paged-${String(index).padStart(4, '0')}`, 'agent-a', ownerId, `fact-${index}`),
      );
      for (let offset = 0; offset < rows.length; offset += 400) {
        const batch = store.db.batch();
        for (const row of rows.slice(offset, offset + 400))
          batch.set(store.doc('memories', row.id), encodeRecord(row));
        await batch.commit();
      }
      const content = await new FirestoreOwnerCardCompilationRepository(store).compile({
        agentId: 'agent-a',
        now: new Date('2026-09-19T13:00:00Z'),
        render: (input) => String(input.ownerFacts.length),
      });
      expect(content).toBe('501');
    } finally {
      await disposeStore(store);
    }
  });
});
