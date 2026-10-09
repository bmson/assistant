import { randomUUID } from 'node:crypto';
import type { EmbeddingSpace, Records } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreGraphRecallRepository } from './graph-recall.js';
import { FirestoreHistoryRecallRepository } from './history-recall.js';
import { embeddingSpaceKey, FirestoreMemoryRepository } from './memory.js';
import { FirestoreRecallMetricsRepository } from './recall-metrics.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space: EmbeddingSpace = {
  provider: 'test',
  model: 'recall',
  dimensions: 1536,
  revision: '1',
};
const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
const now = new Date('2026-09-12T12:00:00Z');
const before = new Date(now.getTime() - 3600000);

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore private history and graph recall',
  () => {
    let store: InstallationStore;
    beforeEach(() => {
      store = emulatorStore(() => now);
    });
    afterEach(async () => {
      await disposeStore(store);
    });
    async function conversation(id: string, agentId = 'owner', trust = 'owner') {
      await store.doc('conversations', id).set({ id, agentId, trust });
    }
    async function message(
      id: string,
      conversationId: string,
      createdAt = before,
      revision = '1',
      channelMessageId?: string,
    ) {
      await store.doc('messages', id).set({
        id,
        conversationId,
        ...(channelMessageId ? { channelMessageId } : {}),
        role: 'user',
        text: `History ${id}`,
        createdAt,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey({ ...space, revision }),
      });
    }
    const input = () => ({
      agentId: 'owner',
      embedding: vector,
      embeddingSpaceKey: embeddingSpaceKey(space),
      exclude: { conversationId: 'current', sinceCreatedAt: now },
      limit: 4,
    });

    it('retrieves only owned trusted history in the correct space outside the live window', async () => {
      await conversation('current');
      await conversation('other', 'foreign');
      await conversation('untrusted', 'owner', 'unknown');
      await message('old', 'current');
      await message('recent', 'current', now);
      await message('visual-fixture', 'current', before, '1', 'visual-qa:test-run:message-1');
      await message(
        'visual-window-fixture',
        'current',
        new Date(now.getTime() + 1000),
        '1',
        'visual-qa:test-run:message-2',
      );
      await message(
        'readability-window-fixture',
        'current',
        new Date(now.getTime() + 2000),
        '1',
        'readability-run-test-02-assistant',
      );
      await message('foreign', 'other');
      await message('tainted', 'untrusted');
      await message('different-model', 'current', before, '2');
      const repo = new FirestoreHistoryRecallRepository(store, space);
      expect((await repo.messages(input())).map((row) => row.id)).toEqual(['old']);
      expect(
        await repo.recentWindowStart({ agentId: 'owner', conversationId: 'current', size: 1 }),
      ).toEqual(now);
      expect(
        await repo.recentWindowStart({ agentId: 'owner', conversationId: 'other', size: 20 }),
      ).toBeNull();
      expect(
        await repo.recentWindowStart({ agentId: 'owner', conversationId: 'current', size: 1 }),
      ).toEqual(now);
      const anchor = (await repo.messages(input()))[0];
      if (!anchor) throw new Error('Missing anchor');
      await store.doc('conversations', 'current').update({ trust: 'unknown' });
      expect(
        await repo.neighborhood({ agentId: 'owner', anchor, radius: 1, exclude: input().exclude }),
      ).toEqual([]);
    });

    it('excludes tagged visual fixtures from semantic message recall and segment endpoints', async () => {
      await conversation('current');
      await message('real-history', 'current');
      await message('fixture-history', 'current', before, '1', 'visual-qa:test-run:history');
      await message('readability-history', 'current', before, '1', 'readability-run-test-03-user');
      await store.doc('conversationSegments', 'fixture-segment').set({
        id: 'fixture-segment',
        agentId: 'owner',
        conversationId: 'current',
        startMessageId: 'fixture-history',
        endMessageId: 'fixture-history',
        summary: 'Visual QA synthetic conversation segment',
        startedAt: before,
        endedAt: before,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
      await store.doc('conversationSegments', 'readability-segment').set({
        id: 'readability-segment',
        agentId: 'owner',
        conversationId: 'current',
        startMessageId: 'readability-history',
        endMessageId: 'readability-history',
        summary: 'Readability synthetic conversation segment',
        startedAt: before,
        endedAt: before,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
      const repo = new FirestoreHistoryRecallRepository(store, space);
      expect((await repo.messages(input())).map((row) => row.id)).toEqual(['real-history']);
      expect(await repo.segments(input())).toEqual([]);
    });

    it('returns empty when every stored segment contains a fixture-only interior row', async () => {
      await conversation('current');
      for (const [index, marker] of [
        'visual-qa:legacy-run:interior',
        'readability-legacy-run-interior',
      ].entries()) {
        const startedAt = new Date(before.getTime() - 40_000 + index * 10_000);
        const middleAt = new Date(startedAt.getTime() + 1_000);
        const endedAt = new Date(startedAt.getTime() + 2_000);
        const prefix = 'all-fixture-' + index;
        await message(prefix + '-start', 'current', startedAt);
        await message(prefix + '-middle', 'current', middleAt, '1', marker);
        await message(prefix + '-end', 'current', endedAt);
        await store.doc('conversationSegments', prefix + '-segment').set({
          id: prefix + '-segment',
          agentId: 'owner',
          conversationId: 'current',
          startMessageId: prefix + '-start',
          endMessageId: prefix + '-end',
          summary: 'Fixture-only legacy segment ' + index,
          messageCount: 3,
          startedAt,
          endedAt,
          embedding: FieldValue.vector(vector),
          embeddingSpace: embeddingSpaceKey(space),
        });
      }

      const rows = await new FirestoreHistoryRecallRepository(store, space).segments(input());
      expect(rows).toEqual([]);
    });

    it('excludes stored segments containing an interior fixture row but keeps clean segments', async () => {
      await conversation('current');
      const mixedStartAt = new Date(before.getTime() - 20_000);
      const mixedMiddleAt = new Date(mixedStartAt.getTime() + 1_000);
      const mixedEndAt = new Date(mixedStartAt.getTime() + 2_000);
      await message('mixed-start', 'current', mixedStartAt);
      await message(
        'mixed-middle',
        'current',
        mixedMiddleAt,
        '1',
        'readability-legacy-run-01-assistant',
      );
      await message('mixed-end', 'current', mixedEndAt);
      const secondMixedStartAt = new Date(before.getTime() - 15_000);
      const secondMixedMiddleAt = new Date(secondMixedStartAt.getTime() + 1_000);
      const secondMixedEndAt = new Date(secondMixedStartAt.getTime() + 2_000);
      await message('second-mixed-start', 'current', secondMixedStartAt);
      await message(
        'second-mixed-middle',
        'current',
        secondMixedMiddleAt,
        '1',
        `visual-qa:${randomUUID()}:assistant`,
      );
      await message('second-mixed-end', 'current', secondMixedEndAt);
      const cleanStartAt = new Date(before.getTime() - 10_000);
      const cleanMiddleAt = new Date(cleanStartAt.getTime() + 1_000);
      const cleanEndAt = new Date(cleanStartAt.getTime() + 2_000);
      await message('clean-start', 'current', cleanStartAt);
      await message('clean-middle', 'current', cleanMiddleAt);
      await message('clean-end', 'current', cleanEndAt);
      await store.doc('conversationSegments', 'mixed-range-segment').set({
        id: 'mixed-range-segment',
        agentId: 'owner',
        conversationId: 'current',
        startMessageId: 'mixed-start',
        endMessageId: 'mixed-end',
        summary: 'MIXED_RANGE_SEGMENT_MARKER legacy segment summary',
        messageCount: 3,
        startedAt: mixedStartAt,
        endedAt: mixedEndAt,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
      await store.doc('conversationSegments', 'second-mixed-range-segment').set({
        id: 'second-mixed-range-segment',
        agentId: 'owner',
        conversationId: 'current',
        startMessageId: 'second-mixed-start',
        endMessageId: 'second-mixed-end',
        summary: 'SECOND_MIXED_RANGE_SEGMENT_MARKER legacy segment summary',
        messageCount: 3,
        startedAt: secondMixedStartAt,
        endedAt: secondMixedEndAt,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
      await store.doc('conversationSegments', 'clean-range-segment').set({
        id: 'clean-range-segment',
        agentId: 'owner',
        conversationId: 'current',
        startMessageId: 'clean-start',
        endMessageId: 'clean-end',
        summary: 'CLEAN_ORDINARY_SEGMENT_MARKER ordinary history summary',
        messageCount: 3,
        startedAt: cleanStartAt,
        endedAt: cleanEndAt,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });

      const rows = await new FirestoreHistoryRecallRepository(store, space).segments(input());
      expect(rows.map((row) => row.summary)).toEqual([
        'CLEAN_ORDINARY_SEGMENT_MARKER ordinary history summary',
      ]);
    });

    it('keeps automatic history recall behind the completed erasure boundary', async () => {
      await conversation('current');
      await conversation('history');
      await message('current-conversation-before-reset', 'current');
      await message('before-erasure', 'history');
      const fenceRef = store.doc('privacyErasureJobs', 'owner');
      await fenceRef.set({ agentId: 'owner', generation: 'completed-reset', status: 'complete' });
      const fence = await fenceRef.get();
      if (!fence.updateTime) throw new Error('Missing Firestore erasure update time');
      const afterBoundary = new Date(fence.updateTime.toMillis() + 1000);
      await message('after-erasure', 'history', afterBoundary);
      const repo = new FirestoreHistoryRecallRepository(store, space);
      expect((await repo.messages(input())).map((row) => row.id).sort()).toEqual([
        'after-erasure',
        'current-conversation-before-reset',
      ]);

      await store.doc('conversationSegments', 'before-reset-segment').set({
        id: 'before-reset-segment',
        agentId: 'owner',
        conversationId: 'history',
        startMessageId: 'before-erasure',
        endMessageId: 'before-erasure',
        summary: 'Summary from before the reset',
        startedAt: before,
        endedAt: before,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
        embeddingSpaceKey: embeddingSpaceKey(space),
      });
      await store.doc('conversationSegments', 'after-reset-segment').set({
        id: 'after-reset-segment',
        agentId: 'owner',
        conversationId: 'history',
        startMessageId: 'after-erasure',
        endMessageId: 'after-erasure',
        summary: 'Summary authored after the reset',
        startedAt: afterBoundary,
        endedAt: afterBoundary,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
      await store.doc('conversationSegments', 'after-reset-old-key-segment').set({
        id: 'after-reset-old-key-segment',
        agentId: 'owner',
        conversationId: 'history',
        startMessageId: 'before-erasure',
        endMessageId: 'after-erasure',
        summary: 'A forged post-reset segment with a pre-reset key message',
        startedAt: afterBoundary,
        endedAt: afterBoundary,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
      await store.doc('conversationSegments', 'current-before-reset-segment').set({
        id: 'current-before-reset-segment',
        agentId: 'owner',
        conversationId: 'current',
        startMessageId: 'current-conversation-before-reset',
        endMessageId: 'current-conversation-before-reset',
        summary: 'Earlier messages from this same conversation',
        startedAt: before,
        endedAt: before,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
      expect((await repo.segments(input())).map((row) => row.startMessageId).sort()).toEqual([
        'after-erasure',
        'current-conversation-before-reset',
      ]);
    });

    it('fails closed while an owner erasure is active', async () => {
      await conversation('history');
      await message('active-reset-source', 'history');
      await store.doc('privacyErasureJobs', 'owner').set({
        agentId: 'owner',
        generation: 'active-reset',
        status: 'active',
      });
      const repo = new FirestoreHistoryRecallRepository(store, space);
      await expect(repo.messages(input())).rejects.toThrow(/privacy erasure/i);
    });

    it('does not attach a foreign key message to an otherwise owned segment', async () => {
      await conversation('current');
      await conversation('foreign', 'foreign');
      await message('foreign-key', 'foreign');
      await store.doc('conversationSegments', 'segment').set({
        id: 'segment',
        agentId: 'owner',
        conversationId: 'current',
        startMessageId: 'foreign-key',
        endMessageId: 'foreign-key',
        summary: 'An owned summary',
        startedAt: before,
        endedAt: before,
        embedding: FieldValue.vector(vector),
        embeddingSpace: embeddingSpaceKey(space),
      });
      const repo = new FirestoreHistoryRecallRepository(store, space);
      const rows = await repo.segments(input());
      expect(rows).toHaveLength(1);
      expect(rows[0]?.keyMessage).toBeUndefined();
      await store.doc('conversations', 'current').update({ agentId: 'foreign' });
      expect(await repo.segments(input())).toEqual([]);
    });

    async function graphMemory(
      id: string,
      entityA: string,
      entityB: string,
      options: Partial<Records['memories']> = {},
    ) {
      const memory: Records['memories'] = {
        id,
        agentId: 'owner',
        content: `Fact ${id}`,
        contentHash: `hash-${id}`,
        createdAt: before,
        expiresAt: null,
        embedding: vector,
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
        source: 'synthetic',
        embeddingSpaceKey: null,
        lastAccessedAt: null,
        lastConsolidatedAt: null,
        ...options,
      };
      await new FirestoreMemoryRepository(store, space).save(memory);
      for (const entityId of [entityA, entityB])
        await store
          .doc('knowledgeGraphEntities', entityId)
          .set({ id: entityId, agentId: 'owner', label: entityId, preferredLabel: null });
      await store.doc('knowledgeGraphSources', id).set({
        memoryId: id,
        status: 'ready',
        contentHash: memory.contentHash,
        extractionVersion: 2,
      });
      const relationId = `relation-${id}`;
      await store.doc('knowledgeGraphRelations', relationId).set(
        encodeRecord({
          id: relationId,
          agentId: 'owner',
          sourceMemoryId: id,
          subjectEntityId: entityA,
          objectEntityId: entityB,
          predicate: 'knows',
          evidenceQuote: `Fact ${id}`,
          confidence: '1',
          assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
          reviewStatus: 'pending',
          validFrom: null,
          validUntil: null,
        }),
      );
      return relationId;
    }

    it('traverses verified graph sources and rechecks rejection, ownership, provenance and erasure', async () => {
      const seed = await graphMemory('seed', 'a', 'b');
      const connected = await graphMemory('neighbor', 'b', 'c');
      await graphMemory('expired', 'd', 'e', { expiresAt: new Date(0) });
      const repo = new FirestoreGraphRecallRepository(store, space);
      expect(
        (await repo.seeds({ agentId: 'owner', embedding: vector, limit: 4, extractionVersion: 2 }))
          .map((row) => row.relationId)
          .sort(),
      ).toEqual([connected, seed].sort());
      const follow = {
        agentId: 'owner',
        entityIds: ['b'],
        sourceMemoryIds: ['seed'],
        limit: 4,
        extractionVersion: 2,
      };
      expect((await repo.connected(follow)).map((row) => row.relationId)).toEqual([connected]);
      await store.doc('knowledgeGraphRelations', connected).update({ reviewStatus: 'rejected' });
      expect(await repo.connected(follow)).toEqual([]);
      await store.doc('knowledgeGraphRelations', connected).update({ reviewStatus: 'pending' });
      await store.doc('knowledgeGraphSources', 'neighbor').update({ contentHash: 'changed' });
      expect(await repo.connected(follow)).toEqual([]);
      await store.doc('knowledgeGraphSources', 'neighbor').update({ contentHash: 'hash-neighbor' });
      await store.doc('knowledgeGraphEntities', 'c').update({ agentId: 'foreign' });
      expect(await repo.connected(follow)).toEqual([]);
      await store.doc('knowledgeGraphEntities', 'c').update({ agentId: 'owner' });
      await new FirestoreMemoryRepository(store, space).forget('hash-neighbor');
      expect(await repo.connected(follow)).toEqual([]);
    });

    it('records scoped content-free recall metrics and purges only the requested age', async () => {
      await store.doc('agents', 'owner').set({ id: 'owner' });
      await conversation('current');
      const repo = new FirestoreRecallMetricsRepository(store);
      const metric = {
        agentId: 'owner',
        conversationId: 'current',
        path: 'executor' as const,
        graphAttempted: true,
        graphFailed: false,
        historyFailed: false,
        graphCandidates: 2,
        graphUsed: 1,
        historyTier: 'message' as const,
        historyUsed: 1,
        sourceCount: 2,
      };
      await repo.record(metric);
      await expect(repo.record({ ...metric, taskId: randomUUID() })).rejects.toThrow(
        'missing source',
      );
      expect(await repo.purge({ notAfter: before, limit: 10 })).toBe(0);
      expect(await repo.purge({ notAfter: now, limit: 10 })).toBe(1);
    });
  },
);
