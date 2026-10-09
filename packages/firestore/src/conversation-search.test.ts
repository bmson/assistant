import {
  type ConversationSearchRepository,
  conversationMessageSourceRevision,
  type EmbeddingSpace,
} from '@assistant/persistence';
import { FieldValue, Timestamp } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreConversationSearchRepository } from './conversation-search.js';
import { embeddingSpaceKey } from './memory.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = {
  provider: 'test',
  model: 'conversation-search',
  dimensions: 1536,
  revision: '1',
};
const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
const spaceKey = embeddingSpaceKey(space);

function compareTimestamps(left: Timestamp, right: Timestamp): number {
  return left.seconds - right.seconds || left.nanoseconds - right.nanoseconds;
}

function shiftTimestamp(timestamp: Timestamp, deltaNanoseconds: number): Timestamp {
  const nanoseconds = timestamp.nanoseconds + deltaNanoseconds;
  if (nanoseconds < 0) return new Timestamp(timestamp.seconds - 1, 1_000_000_000 + nanoseconds);
  if (nanoseconds >= 1_000_000_000)
    return new Timestamp(timestamp.seconds + 1, nanoseconds - 1_000_000_000);
  return new Timestamp(timestamp.seconds, nanoseconds);
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore conversation search fixture isolation',
  () => {
    let store: InstallationStore;
    beforeEach(() => {
      store = emulatorStore();
    });
    afterEach(async () => {
      await disposeStore(store);
    });

    it('omits tagged visual fixtures from semantic and text search while keeping owner rows', async () => {
      await store.doc('conversations', 'owner-thread').set({
        id: 'owner-thread',
        agentId: 'owner',
        trust: 'owner',
      });
      await store.doc('messages', 'owner-message').set({
        id: 'owner-message',
        conversationId: 'owner-thread',
        role: 'user',
        text: 'shared ordinary owner phrase',
        createdAt: new Date('2026-09-12T10:00:00Z'),
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
      await store.doc('messages', 'readability-message').set({
        id: 'readability-message',
        conversationId: 'owner-thread',
        channelMessageId: 'readability-search-run-01-assistant',
        role: 'assistant',
        text: 'shared synthetic readability fixture phrase',
        createdAt: new Date('2026-09-12T10:30:00Z'),
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
      await store.doc('messages', 'visual-message').set({
        id: 'visual-message',
        conversationId: 'owner-thread',
        channelMessageId: 'visual-qa:search-run:message-1',
        role: 'assistant',
        text: 'shared synthetic visual fixture phrase',
        createdAt: new Date('2026-09-12T11:00:00Z'),
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
      await store.doc('conversations', 'foreign-thread').set({
        id: 'foreign-thread',
        agentId: 'other-owner',
        trust: 'owner',
      });
      await store.doc('messages', 'foreign-message').set({
        id: 'foreign-message',
        conversationId: 'foreign-thread',
        role: 'user',
        text: 'shared foreign owner phrase',
        createdAt: new Date('2026-09-12T09:00:00Z'),
        embedding: FieldValue.vector(vector),
        embeddingSpace: spaceKey,
      });
      await store.doc('messages', 'old-space-message').set({
        id: 'old-space-message',
        conversationId: 'owner-thread',
        role: 'user',
        text: 'legacy embedding phrase',
        createdAt: new Date('2026-09-12T08:00:00Z'),
        embedding: FieldValue.vector(vector),
        embeddingSpace: 'a'.repeat(64),
      });
      await store.doc('messages', 'hidden-message').set({
        id: 'hidden-message',
        conversationId: 'owner-thread',
        role: 'assistant',
        text: 'shared hidden owner phrase',
        hiddenAt: new Date('2026-09-12T12:00:00Z'),
        createdAt: new Date('2026-09-12T12:00:00Z'),
        embedding: FieldValue.vector(vector),
        embeddingSpace: spaceKey,
      });
      const repository = new FirestoreConversationSearchRepository(store, space);
      const semantic = await repository.semantic({
        agentId: 'owner',
        embedding: vector,
        embeddingSpaceKey: spaceKey,
        limit: 5,
      });
      expect(semantic.map((row) => row.text)).toEqual(['shared ordinary owner phrase']);
      const text = await repository.text({ agentId: 'owner', query: 'shared', limit: 5 });
      expect(text.map((row) => row.text)).toEqual(['shared ordinary owner phrase']);
      await expect(
        repository.semantic({
          agentId: 'owner',
          embedding: vector,
          embeddingSpaceKey: 'b'.repeat(64),
          limit: 5,
        }),
      ).rejects.toThrow('embedding space changed');
    });

    it('applies the owner erasure cutoff while keeping only the trusted current conversation exception', async () => {
      const before = new Date(Date.now() - 10_000);
      const after = new Date(Date.now() + 10_000);
      await store.doc('conversations', 'current-thread').set({
        id: 'current-thread',
        agentId: 'owner',
      });
      await store
        .doc('conversations', 'older-thread')
        .set({ id: 'older-thread', agentId: 'owner' });
      await store.doc('conversations', 'foreign-thread').set({
        id: 'foreign-thread',
        agentId: 'other-owner',
      });
      await store.doc('messages', 'before-cutoff').set({
        id: 'before-cutoff',
        conversationId: 'older-thread',
        role: 'user',
        text: 'cutoff marker old source',
        createdAt: before,
        embedding: FieldValue.vector(vector),
        embeddingSpace: spaceKey,
      });
      await store.doc('messages', 'current-before-cutoff').set({
        id: 'current-before-cutoff',
        conversationId: 'current-thread',
        role: 'user',
        text: 'cutoff marker current conversation',
        createdAt: before,
        embedding: FieldValue.vector(vector),
        embeddingSpace: spaceKey,
      });
      await store.doc('messages', 'after-cutoff').set({
        id: 'after-cutoff',
        conversationId: 'older-thread',
        role: 'user',
        text: 'cutoff marker fresh source',
        createdAt: after,
        embedding: FieldValue.vector(vector),
        embeddingSpace: spaceKey,
      });
      await store.doc('messages', 'foreign-after-cutoff').set({
        id: 'foreign-after-cutoff',
        conversationId: 'foreign-thread',
        role: 'user',
        text: 'cutoff marker foreign source',
        createdAt: after,
        embedding: FieldValue.vector(vector),
        embeddingSpace: spaceKey,
      });
      await store.doc('privacyErasureJobs', 'owner').set({
        agentId: 'owner',
        status: 'complete',
        generation: 'cutoff-fixture',
      });

      const repository = new FirestoreConversationSearchRepository(store, space);
      const current = (await repository.text({
        agentId: 'owner',
        query: 'cutoff marker',
        limit: 10,
        currentConversationId: 'current-thread',
      } as Parameters<ConversationSearchRepository['text']>[0])) as Array<{
        conversationId: string;
        messageId: string;
        sourceRevision: string;
      }>;
      expect(current.map((row) => row.messageId)).toEqual([
        'after-cutoff',
        'current-before-cutoff',
      ]);
      expect(current.every((row) => /^[a-f0-9]{64}$/.test(row.sourceRevision))).toBe(true);

      const foreignCurrent = (await repository.text({
        agentId: 'owner',
        query: 'cutoff marker',
        limit: 10,
        currentConversationId: 'foreign-thread',
      } as Parameters<ConversationSearchRepository['text']>[0])) as Array<{ messageId: string }>;
      expect(foreignCurrent.map((row) => row.messageId)).toEqual(['after-cutoff']);

      const semantic = (await repository.semantic({
        agentId: 'owner',
        embedding: vector,
        embeddingSpaceKey: spaceKey,
        limit: 10,
        currentConversationId: 'current-thread',
      } as Parameters<ConversationSearchRepository['semantic']>[0])) as Array<{
        messageId: string;
        sourceRevision: string;
      }>;
      expect(semantic.map((row) => row.messageId).sort()).toEqual(
        ['after-cutoff', 'current-before-cutoff'].sort(),
      );

      const previousRevision = current.find(
        (row) => row.messageId === 'after-cutoff',
      )?.sourceRevision;
      await store.doc('messages', 'after-cutoff').update({
        text: 'cutoff marker fresh source revised',
      });
      const revised = await repository.text({
        agentId: 'owner',
        query: 'cutoff marker',
        limit: 10,
      });
      expect(revised.find((row) => row.messageId === 'after-cutoff')?.sourceRevision).not.toBe(
        previousRevision,
      );
    });

    it('uses the strict raw Timestamp cutoff for semantic, text, and exact resume sources', async () => {
      const precisionConversationId = '60000000-0000-4000-8000-000000000006';
      await store.doc('conversations', precisionConversationId).set({
        id: precisionConversationId,
        agentId: 'owner',
        trust: 'owner',
      });
      await store.doc('privacyErasureJobs', 'owner').set({
        agentId: 'owner',
        status: 'complete',
        generation: 'precision-cutoff',
      });
      const job = await store.doc('privacyErasureJobs', 'owner').get();
      const cutoff = job.updateTime;
      if (!cutoff) throw new Error('Firestore did not assign an erasure update time');
      // Firestore persists timestamps to microsecond precision. One-nanosecond
      // fixtures collapse onto the same stored value, so use the nearest
      // representable sub-millisecond values around the exact commit time.
      const before = shiftTimestamp(cutoff, -1_000);
      const after = shiftTimestamp(cutoff, 1_000);
      const marker = `precision marker ${Date.now()}`;
      const sources = [
        { id: '70000000-0000-4000-8000-000000000007', suffix: 'before', createdAt: before },
        { id: '80000000-0000-4000-8000-000000000008', suffix: 'equal', createdAt: cutoff },
        { id: '90000000-0000-4000-8000-000000000009', suffix: 'after', createdAt: after },
      ];
      for (const source of sources) {
        await store.doc('messages', source.id).set({
          id: source.id,
          conversationId: precisionConversationId,
          role: 'user',
          origin: 'owner',
          text: `${marker} ${source.suffix}`,
          createdAt: source.createdAt,
          hiddenAt: null,
          embedding: FieldValue.vector(vector),
          embeddingSpace: spaceKey,
        });
      }
      const storedTimes = new Map<string, Timestamp>();
      for (const source of sources) {
        const stored = await store.doc('messages', source.id).get();
        const createdAt = stored.get('createdAt');
        if (!(createdAt instanceof Timestamp))
          throw new Error('Firestore did not preserve the test message timestamp');
        storedTimes.set(source.id, createdAt);
      }
      const beforeSource = sources[0];
      const equalSource = sources[1];
      const afterSource = sources[2];
      if (!beforeSource || !equalSource || !afterSource)
        throw new Error('Timestamp fixture source rows are missing');
      const beforeStored = storedTimes.get(beforeSource.id);
      const equalStored = storedTimes.get(equalSource.id);
      const afterStored = storedTimes.get(afterSource.id);
      if (!beforeStored || !equalStored || !afterStored)
        throw new Error('Firestore timestamp readback is incomplete');
      expect(compareTimestamps(beforeStored, cutoff)).toBeLessThan(0);
      expect(compareTimestamps(equalStored, cutoff)).toBe(0);
      expect(compareTimestamps(afterStored, cutoff)).toBeGreaterThan(0);
      const repository = new FirestoreConversationSearchRepository(store, space);
      const text = await repository.text({ agentId: 'owner', query: marker, limit: 10 });
      expect(text.map((row) => row.text)).toEqual([`${marker} after`]);
      const semantic = await repository.semantic({
        agentId: 'owner',
        embedding: vector,
        embeddingSpaceKey: spaceKey,
        limit: 10,
      });
      expect(semantic.map((row) => row.text)).toEqual([`${marker} after`]);
      const resumed = await repository.refreshForResume({
        agentId: 'owner',
        query: marker,
        limit: 10,
        sourceRefs: sources.map((source) => ({
          messageId: source.id,
          conversationId: precisionConversationId,
          sourceRevision: conversationMessageSourceRevision(
            source.id,
            `${marker} ${source.suffix}`,
          ),
        })),
      });
      expect(resumed.unchangedSourceRefs).toEqual([false, false, true]);
      expect(resumed.matches.map((row) => row.messageId)).toEqual([sources[2]?.id]);
      const current = await repository.text({
        agentId: 'owner',
        query: marker,
        limit: 10,
        currentConversationId: precisionConversationId,
      } as Parameters<ConversationSearchRepository['text']>[0]);
      expect(current.map((row) => row.messageId).sort()).toEqual(
        sources.map((source) => source.id).sort(),
      );
    });

    it('validates exact source revisions and returns bounded fresh text after the erasure cutoff', async () => {
      const oldConversationId = '11000000-0000-4000-8000-000000000011';
      const freshConversationId = '22000000-0000-4000-8000-000000000022';
      const foreignConversationId = '33000000-0000-4000-8000-000000000033';
      await store
        .doc('conversations', oldConversationId)
        .set({ id: oldConversationId, agentId: 'owner' });
      await store
        .doc('conversations', freshConversationId)
        .set({ id: freshConversationId, agentId: 'owner' });
      await store
        .doc('conversations', foreignConversationId)
        .set({ id: foreignConversationId, agentId: 'other-owner' });
      await store.doc('privacyErasureJobs', 'owner').set({
        agentId: 'owner',
        status: 'complete',
        generation: 'refresh-cutoff',
      });
      const oldText = 'newsletter private source before reset';
      const oldMessageId = '44000000-0000-4000-8000-000000000044';
      await store.doc('messages', oldMessageId).set({
        id: oldMessageId,
        conversationId: oldConversationId,
        role: 'user',
        text: oldText,
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        hiddenAt: null,
      });
      const freshMessageId = '55000000-0000-4000-8000-000000000055';
      const freshText = 'newsletter fresh source after reset';
      await store.doc('messages', freshMessageId).set({
        id: freshMessageId,
        conversationId: freshConversationId,
        role: 'user',
        text: freshText,
        createdAt: new Date(Date.now() + 10_000),
        hiddenAt: null,
      });
      const foreignMessageId = '66000000-0000-4000-8000-000000000066';
      await store.doc('messages', foreignMessageId).set({
        id: foreignMessageId,
        conversationId: foreignConversationId,
        role: 'user',
        text: 'newsletter foreign source',
        createdAt: new Date(Date.now() + 20_000),
        hiddenAt: null,
      });
      const repository = new FirestoreConversationSearchRepository(store, space);
      const refreshed = await repository.refreshForResume({
        agentId: 'owner',
        query: 'newsletter',
        limit: 5,
        sourceRefs: [
          {
            messageId: oldMessageId,
            conversationId: oldConversationId,
            sourceRevision: conversationMessageSourceRevision(oldMessageId, oldText),
          },
        ],
      });
      expect(refreshed.mode).toBe('text');
      expect(refreshed.unchangedSourceRefs).toEqual([false]);
      expect(refreshed.matches.map((row) => row.messageId)).toEqual([freshMessageId]);
      expect(refreshed.matches.map((row) => row.messageId)).not.toContain(foreignMessageId);

      const freshRef = {
        messageId: freshMessageId,
        conversationId: freshConversationId,
        sourceRevision: refreshed.matches[0]?.sourceRevision ?? '',
      };
      const unchanged = await repository.refreshForResume({
        agentId: 'owner',
        query: 'newsletter',
        limit: 5,
        sourceRefs: [freshRef],
      });
      expect(unchanged.unchangedSourceRefs).toEqual([true]);
      await store
        .doc('messages', freshMessageId)
        .update({ text: 'newsletter corrected after reset' });
      const corrected = await repository.refreshForResume({
        agentId: 'owner',
        query: 'newsletter',
        limit: 5,
        sourceRefs: [freshRef],
      });
      expect(corrected.unchangedSourceRefs).toEqual([false]);
      expect(corrected.matches[0]?.text).toBe('newsletter corrected after reset');
      await store.doc('messages', freshMessageId).update({ hiddenAt: new Date() });
      const hidden = await repository.refreshForResume({
        agentId: 'owner',
        query: 'newsletter',
        limit: 5,
        sourceRefs: [
          {
            ...freshRef,
            sourceRevision: corrected.matches[0]?.sourceRevision ?? '',
          },
        ],
      });
      expect(hidden.unchangedSourceRefs).toEqual([false]);
      expect(hidden.matches).toEqual([]);
    });

    it('fails closed during active erasure and when the erasure fence changes during a read', async () => {
      await store
        .doc('conversations', 'fence-thread')
        .set({ id: 'fence-thread', agentId: 'owner' });
      await store.doc('messages', 'fence-message').set({
        id: 'fence-message',
        conversationId: 'fence-thread',
        role: 'user',
        text: 'fence race marker',
        createdAt: new Date(),
      });
      const repository = new FirestoreConversationSearchRepository(store, space);
      await store.doc('privacyErasureJobs', 'owner').set({ agentId: 'owner', status: 'active' });
      await expect(
        repository.text({ agentId: 'owner', query: 'fence race', limit: 5 }),
      ).rejects.toThrow('Privacy erasure is in progress');
      await expect(
        repository.refreshForResume({
          agentId: 'owner',
          query: 'fence race',
          limit: 5,
          sourceRefs: [],
        }),
      ).rejects.toThrow('Privacy erasure is in progress');
      await store.doc('privacyErasureJobs', 'owner').delete();

      const originalDoc = store.doc.bind(store);
      let fenceReads = 0;
      const fenceRef = originalDoc('privacyErasureJobs', 'owner');
      let textTransition: Timestamp | undefined;
      let refreshTransition: Timestamp | undefined;
      Object.defineProperty(store, 'doc', {
        configurable: true,
        value: (collection: string, id: string) => {
          const ref = originalDoc(collection, id);
          if (collection !== 'privacyErasureJobs' || id !== 'owner') return ref;
          return new Proxy(ref, {
            get(target, property) {
              if (property === 'get')
                return async () => {
                  fenceReads += 1;
                  if (fenceReads === 2) {
                    await fenceRef.set({
                      agentId: 'owner',
                      status: 'complete',
                      generation: 'text-race',
                    });
                    textTransition = (await fenceRef.get()).updateTime;
                  }
                  return target.get();
                };
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      });
      const racedRepository = new FirestoreConversationSearchRepository(store, space);
      await expect(
        racedRepository.text({ agentId: 'owner', query: 'fence race', limit: 5 }),
      ).rejects.toThrow('Privacy erasure changed during read');
      if (!textTransition) throw new Error('Text search did not observe a fence transition');
      await fenceRef.set({ agentId: 'owner', status: 'complete', generation: 'refresh-baseline' });
      const refreshBaseline = (await fenceRef.get()).updateTime;
      fenceReads = 0;
      refreshTransition = undefined;
      const refreshRace = originalDoc('privacyErasureJobs', 'owner');
      Object.defineProperty(store, 'doc', {
        configurable: true,
        value: (collection: string, id: string) => {
          const ref = originalDoc(collection, id);
          if (collection !== 'privacyErasureJobs' || id !== 'owner') return ref;
          return new Proxy(ref, {
            get(target, property) {
              if (property === 'get')
                return async () => {
                  fenceReads += 1;
                  if (fenceReads === 2) {
                    await refreshRace.set({
                      agentId: 'owner',
                      status: 'complete',
                      generation: 'refresh-race',
                    });
                    refreshTransition = (await refreshRace.get()).updateTime;
                  }
                  return target.get();
                };
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      });
      await expect(
        racedRepository.refreshForResume({
          agentId: 'owner',
          query: 'fence race',
          limit: 5,
          sourceRefs: [],
        }),
      ).rejects.toThrow('Privacy erasure changed during read');
      if (!refreshBaseline || !refreshTransition)
        throw new Error('Resume search did not observe a fence transition');
      expect(compareTimestamps(refreshTransition, refreshBaseline)).not.toBe(0);
    });
  },
);
