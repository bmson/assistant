import { randomUUID } from 'node:crypto';
import {
  type ConversationSearchRepository,
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
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

function contextFor(repository: ConversationSearchRepository) {
  if (!repository.context) throw new Error('Conversation context is unavailable');
  return repository.context.bind(repository);
}

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

    it('returns a revision-bound three-message window with deterministic time/id ordering', async () => {
      const conversationId = randomUUID();
      const ids = Array.from({ length: 6 }, () => randomUUID());
      const times = [0, 1, 2, 3, 4, 5].map(
        (minutes) => new Date(`2026-10-16T10:${String(minutes).padStart(2, '0')}:00.000Z`),
      );
      const source = [
        ['owner initializer with Aurora exercise cue', 'user', 'owner'],
        ['earlier user turn', 'user', 'owner'],
        ['assistant setup note', 'assistant', 'assistant'],
        ['assistant next step', 'assistant', 'assistant'],
        ['later user turn', 'user', 'owner'],
        ['later assistant turn', 'assistant', 'assistant'],
      ] as const;
      await store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId: 'owner',
        trust: 'owner',
      });
      for (const [index, id] of ids.entries()) {
        const entry = source[index];
        const createdAt = times[index];
        if (!entry || !createdAt) throw new Error('Missing fixture row');
        await store.doc('messages', id).set({
          id,
          conversationId,
          role: entry[1],
          origin: entry[2],
          text: entry[0],
          createdAt,
        });
      }
      const hiddenNeighborId = randomUUID();
      await store.doc('messages', hiddenNeighborId).set({
        id: hiddenNeighborId,
        conversationId,
        role: 'assistant',
        origin: 'assistant',
        text: 'hidden neighbor omitted from context',
        hiddenAt: new Date('2026-10-16T10:02:30.000Z'),
        createdAt: new Date('2026-10-16T10:02:30.000Z'),
      });
      const anchorId = ids[3];
      const anchor = source[3];
      if (!anchorId || !anchor) throw new Error('Missing anchor fixture');
      const repository = new FirestoreConversationSearchRepository(store, space);
      const result = await contextFor(repository)({
        agentId: 'owner',
        anchors: [
          {
            messageId: anchorId,
            conversationId,
            sourceRevision: conversationMessageSourceRevision(anchorId, anchor[0]),
            speakerRevision: conversationMessageSpeakerRevision(
              anchorId,
              anchor[0],
              anchor[1],
              anchor[2],
            ),
          },
        ],
      });
      expect(result.matches.map((row) => row.text)).toEqual(
        source.slice(0, 5).map((row) => row[0]),
      );
      expect(result.matches).toHaveLength(5);
      expect(result.matches[0]?.role).toBe('user');
      expect(result.matches[0]?.origin).toBe('owner');
      expect(result.matches.every((row) => row.sourceRevision.length === 64)).toBe(true);
      expect(result.matches.every((row) => row.speakerRevision?.length === 64)).toBe(true);
      const firstContextId = ids[1];
      const secondContextId = ids[4];
      const firstContextSource = source[1];
      const secondContextSource = source[4];
      if (!firstContextId || !secondContextId || !firstContextSource || !secondContextSource)
        throw new Error('Missing context fixtures');
      const twoAnchors = await contextFor(repository)({
        agentId: 'owner',
        anchors: [
          {
            messageId: firstContextId,
            conversationId,
            sourceRevision: conversationMessageSourceRevision(
              firstContextId,
              firstContextSource[0],
            ),
            speakerRevision: conversationMessageSpeakerRevision(
              firstContextId,
              firstContextSource[0],
              firstContextSource[1],
              firstContextSource[2],
            ),
          },
          {
            messageId: secondContextId,
            conversationId,
            sourceRevision: conversationMessageSourceRevision(
              secondContextId,
              secondContextSource[0],
            ),
            speakerRevision: conversationMessageSpeakerRevision(
              secondContextId,
              secondContextSource[0],
              secondContextSource[1],
              secondContextSource[2],
            ),
          },
        ],
      });
      expect(twoAnchors.matches.length).toBeLessThanOrEqual(10);
      expect(twoAnchors.matches.map((row) => row.messageId)).toContain(firstContextId);
      expect(twoAnchors.matches.map((row) => row.messageId)).toContain(secondContextId);

      const tiedConversationId = randomUUID();
      // UUID hex fields are case-insensitive by identity, but Firestore string
      // ordering must stay deterministic and independent of host locale.
      const tieLow = '00000000-0000-4000-8000-00000000000A';
      const tieAnchor = '00000000-0000-4000-8000-00000000000B';
      const tieHigh = '00000000-0000-4000-8000-00000000000a';
      await store.doc('conversations', tiedConversationId).set({
        id: tiedConversationId,
        agentId: 'owner',
        trust: 'owner',
      });
      for (const [id, text] of [
        [tieLow, 'same-time prior'],
        [tieAnchor, 'same-time anchor'],
        [tieHigh, 'same-time next'],
      ] as const) {
        await store.doc('messages', id).set({
          id,
          conversationId: tiedConversationId,
          role: 'assistant',
          origin: 'assistant',
          text,
          createdAt: new Date('2026-10-16T10:00:00.000Z'),
        });
      }
      const tieResult = await contextFor(repository)({
        agentId: 'owner',
        anchors: [
          {
            messageId: tieAnchor,
            conversationId: tiedConversationId,
            sourceRevision: conversationMessageSourceRevision(tieAnchor, 'same-time anchor'),
            speakerRevision: conversationMessageSpeakerRevision(
              tieAnchor,
              'same-time anchor',
              'assistant',
              'assistant',
            ),
          },
        ],
      });
      expect(tieResult.matches.map((row) => row.messageId)).toEqual([tieLow, tieAnchor, tieHigh]);

      const nanosConversationId = randomUUID();
      await store.doc('conversations', nanosConversationId).set({
        id: nanosConversationId,
        agentId: 'owner',
        trust: 'owner',
      });
      const nanosRows = [
        { id: '00000000-0000-4000-8000-000000000090', text: 'nanos previous one', nanos: 100_000 },
        { id: '00000000-0000-4000-8000-000000000080', text: 'nanos previous two', nanos: 200_000 },
        {
          id: '00000000-0000-4000-8000-000000000070',
          text: 'nanos previous three',
          nanos: 300_000,
        },
        { id: '00000000-0000-4000-8000-000000000001', text: 'nanos anchor', nanos: 400_000 },
        { id: '00000000-0000-4000-8000-000000000000', text: 'nanos following', nanos: 500_000 },
      ] as const;
      const nanosSeconds = Math.floor(Date.parse('2026-10-16T10:00:00.000Z') / 1000);
      for (const row of nanosRows) {
        await store.doc('messages', row.id).set({
          id: row.id,
          conversationId: nanosConversationId,
          role: 'assistant',
          origin: 'assistant',
          text: row.text,
          createdAt: new Timestamp(nanosSeconds, row.nanos),
        });
      }
      const nanosAnchor = nanosRows[3];
      const nanosResult = await contextFor(repository)({
        agentId: 'owner',
        anchors: [
          {
            messageId: nanosAnchor.id,
            conversationId: nanosConversationId,
            sourceRevision: conversationMessageSourceRevision(nanosAnchor.id, nanosAnchor.text),
            speakerRevision: conversationMessageSpeakerRevision(
              nanosAnchor.id,
              nanosAnchor.text,
              'assistant',
              'assistant',
            ),
          },
        ],
      });
      expect(
        new Set(nanosRows.map((row) => new Date(nanosSeconds * 1000 + row.nanos / 1e6).getTime()))
          .size,
      ).toBe(1);
      expect(nanosResult.matches.map((row) => row.messageId)).toEqual(
        nanosRows.map((row) => row.id),
      );
    });

    it('fails the whole context read for stale, hidden, foreign, duplicate, or out-of-bound anchors', async () => {
      const conversationId = randomUUID();
      const messageId = randomUUID();
      await store
        .doc('conversations', conversationId)
        .set({ id: conversationId, agentId: 'owner' });
      await store.doc('messages', messageId).set({
        id: messageId,
        conversationId,
        role: 'assistant',
        origin: 'assistant',
        text: 'anchor body',
        createdAt: new Date('2026-10-16T10:00:00.000Z'),
      });
      const ref = {
        messageId,
        conversationId,
        sourceRevision: conversationMessageSourceRevision(messageId, 'anchor body'),
        speakerRevision: conversationMessageSpeakerRevision(
          messageId,
          'anchor body',
          'assistant',
          'assistant',
        ),
      };
      const repository = new FirestoreConversationSearchRepository(store, space);
      await expect(
        contextFor(repository)({
          agentId: 'owner',
          anchors: [{ ...ref, sourceRevision: '0'.repeat(64) }],
        }),
      ).rejects.toThrow('stale or unavailable');
      await expect(
        contextFor(repository)({
          agentId: 'owner',
          anchors: [{ ...ref, speakerRevision: '0'.repeat(64) }],
        }),
      ).rejects.toThrow('stale or unavailable');
      await expect(
        contextFor(repository)({
          agentId: 'owner',
          anchors: [{ ...ref, conversationId: randomUUID() }],
        }),
      ).rejects.toThrow('stale or unavailable');
      await expect(
        contextFor(repository)({ agentId: 'other-owner', anchors: [ref] }),
      ).rejects.toThrow('stale or unavailable');
      await expect(
        contextFor(repository)({ agentId: 'owner', anchors: [ref, ref] }),
      ).rejects.toThrow('Duplicate conversation context anchor');
      await expect(contextFor(repository)({ agentId: 'owner', anchors: [] })).rejects.toThrow(
        'one or two anchors',
      );
      await expect(
        contextFor(repository)({
          agentId: 'owner',
          anchors: [ref, { ...ref, messageId: randomUUID() }, { ...ref, messageId: randomUUID() }],
        }),
      ).rejects.toThrow('one or two anchors');
      await store.doc('messages', messageId).update({ text: 'body changed after search' });
      await expect(contextFor(repository)({ agentId: 'owner', anchors: [ref] })).rejects.toThrow(
        'stale or unavailable',
      );
      await store.doc('messages', messageId).update({ text: 'anchor body', origin: 'web' });
      await expect(contextFor(repository)({ agentId: 'owner', anchors: [ref] })).rejects.toThrow(
        'stale or unavailable',
      );
      await store.doc('messages', messageId).update({ hiddenAt: new Date() });
      await expect(contextFor(repository)({ agentId: 'owner', anchors: [ref] })).rejects.toThrow(
        'stale or unavailable',
      );
    });

    it('fails closed when hidden or fixture rows exhaust the bounded neighbor scan', async () => {
      const conversationId = randomUUID();
      await store
        .doc('conversations', conversationId)
        .set({ id: conversationId, agentId: 'owner' });
      const anchorId = randomUUID();
      const anchorText = 'bounded scan anchor';
      await store.doc('messages', anchorId).set({
        id: anchorId,
        conversationId,
        role: 'assistant',
        origin: 'assistant',
        text: anchorText,
        createdAt: new Date('2026-10-16T10:01:00.000Z'),
      });
      for (let index = 0; index < 20; index += 1) {
        const id = randomUUID();
        const createdAt = new Date(Date.parse('2026-10-16T10:00:00.000Z') + index);
        await store.doc('messages', id).set({
          id,
          conversationId,
          role: index % 2 ? 'assistant' : 'user',
          origin: index % 2 ? 'assistant' : 'owner',
          text: `bounded hidden fixture ${index}`,
          ...(index < 10
            ? { hiddenAt: createdAt }
            : { channelMessageId: `visual-qa:context:${index}` }),
          createdAt,
        });
      }
      await expect(
        contextFor(new FirestoreConversationSearchRepository(store, space))({
          agentId: 'owner',
          anchors: [
            {
              messageId: anchorId,
              conversationId,
              sourceRevision: conversationMessageSourceRevision(anchorId, anchorText),
              speakerRevision: conversationMessageSpeakerRevision(
                anchorId,
                anchorText,
                'assistant',
                'assistant',
              ),
            },
          ],
        }),
      ).rejects.toThrow('Conversation context bounded lookup unavailable');
    });

    it('fails closed when erasure changes during the anchor and neighbor read', async () => {
      const conversationId = randomUUID();
      const messageId = randomUUID();
      await store
        .doc('conversations', conversationId)
        .set({ id: conversationId, agentId: 'owner' });
      await store.doc('messages', messageId).set({
        id: messageId,
        conversationId,
        role: 'user',
        origin: 'owner',
        text: 'context erasure race anchor',
        createdAt: new Date('2026-10-16T10:00:00.000Z'),
      });
      const anchor = {
        messageId,
        conversationId,
        sourceRevision: conversationMessageSourceRevision(messageId, 'context erasure race anchor'),
        speakerRevision: conversationMessageSpeakerRevision(
          messageId,
          'context erasure race anchor',
          'user',
          'owner',
        ),
      };
      const originalDoc = store.doc.bind(store);
      const fenceRef = originalDoc('privacyErasureJobs', 'owner');
      await fenceRef.set({ agentId: 'owner', status: 'complete', generation: 'context-baseline' });
      let reads = 0;
      Object.defineProperty(store, 'doc', {
        configurable: true,
        value: (collection: string, id: string) => {
          const ref = originalDoc(collection, id);
          if (collection !== 'privacyErasureJobs' || id !== 'owner') return ref;
          return new Proxy(ref, {
            get(target, property) {
              if (property === 'get')
                return async () => {
                  reads += 1;
                  if (reads === 2)
                    await fenceRef.set({
                      agentId: 'owner',
                      status: 'complete',
                      generation: 'context-race',
                    });
                  return target.get();
                };
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      });
      await expect(
        contextFor(new FirestoreConversationSearchRepository(store, space))({
          agentId: 'owner',
          anchors: [anchor],
        }),
      ).rejects.toThrow('Privacy erasure changed during read');
    });

    it('diversifies owned semantic candidates before the public limit', async () => {
      const chats = ['diversity-qa-one', 'diversity-qa-two', 'diversity-preference'];
      for (const id of chats)
        await store
          .doc('conversations', id)
          .set({ id, agentId: 'diversity-owner', trust: 'owner' });
      await store.doc('conversations', 'diversity-foreign').set({
        id: 'diversity-foreign',
        agentId: 'someone-else',
        trust: 'owner',
      });
      const lowerRanked: number[] = [...vector];
      lowerRanked[0] = 0.9;
      lowerRanked[1] = 0.1;
      for (let index = 0; index < 24; index++) {
        const ownerQuestion = index < 4;
        await store.doc('messages', `diversity-${index}`).set({
          id: `diversity-${index}`,
          conversationId: chats[index % 2],
          role: ownerQuestion ? 'user' : 'assistant',
          origin: ownerQuestion ? 'owner' : 'assistant',
          text: ownerQuestion
            ? 'What are my display preferences?'
            : `Earlier assistant claim ${index}`,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          embedding: FieldValue.vector(vector),
          embeddingSpace: spaceKey,
        });
      }
      for (let index = 0; index < 60; index++)
        await store.doc('messages', `diversity-foreign-${index}`).set({
          id: `diversity-foreign-${index}`,
          conversationId: 'diversity-foreign',
          role: 'user',
          origin: 'owner',
          text: `Foreign owner's display preference ${index}`,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          embedding: FieldValue.vector(vector),
          embeddingSpace: spaceKey,
        });
      await store.doc('messages', 'diversity-visual-qa').set({
        id: 'diversity-visual-qa',
        conversationId: chats[0],
        channelMessageId: 'visual-qa:display-preference-test',
        role: 'user',
        origin: 'owner',
        text: 'Visual test claims the owner prefers a crowded display.',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        embedding: FieldValue.vector(vector),
        embeddingSpace: spaceKey,
      });
      await store.doc('messages', 'diversity-preference-message').set({
        id: 'diversity-preference-message',
        conversationId: chats[2],
        role: 'user',
        origin: 'owner',
        text: 'Please keep the display compact and easy to scan.',
        createdAt: new Date('2026-09-30T00:00:00Z'),
        embedding: FieldValue.vector(lowerRanked),
        embeddingSpace: spaceKey,
      });
      const matches = await new FirestoreConversationSearchRepository(store, space).semantic({
        agentId: 'diversity-owner',
        embedding: vector,
        embeddingSpaceKey: spaceKey,
        limit: 20,
      });
      expect(matches.length).toBeLessThanOrEqual(20);
      expect(matches.filter((row) => row.text === 'What are my display preferences?')).toHaveLength(
        1,
      );
      expect(matches.map((row) => row.text)).toContain(
        'Please keep the display compact and easy to scan.',
      );
      expect(matches.some((row) => row.role === 'assistant')).toBe(true);
      expect(matches.some((row) => row.conversationId === 'diversity-foreign')).toBe(false);
      expect(matches.some((row) => row.messageId === 'diversity-visual-qa')).toBe(false);
      expect(
        matches.find((row) => row.messageId === 'diversity-preference-message')?.speakerRevision,
      ).toMatch(/^[a-f0-9]{64}$/);
    });

    it('fails closed when the finite nearest-neighbor window is entirely foreign', async () => {
      await store.doc('conversations', 'bound-foreign').set({
        id: 'bound-foreign',
        agentId: 'someone-else',
      });
      await store.doc('conversations', 'bound-owner').set({
        id: 'bound-owner',
        agentId: 'bound-owner-agent',
      });
      const lowerRanked: number[] = [...vector];
      lowerRanked[0] = 0.9;
      lowerRanked[1] = 0.1;
      for (let index = 0; index < 16; index++)
        await store.doc('messages', `bound-foreign-${index}`).set({
          id: `bound-foreign-${index}`,
          conversationId: 'bound-foreign',
          role: 'user',
          origin: 'owner',
          text: `Foreign neighbor ${index}`,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          embedding: FieldValue.vector(vector),
          embeddingSpace: spaceKey,
        });
      await store.doc('messages', 'bound-owner-source').set({
        id: 'bound-owner-source',
        conversationId: 'bound-owner',
        role: 'user',
        origin: 'owner',
        text: 'A lower-ranked owner source',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        embedding: FieldValue.vector(lowerRanked),
        embeddingSpace: spaceKey,
      });
      await expect(
        new FirestoreConversationSearchRepository(store, space).semantic({
          agentId: 'bound-owner-agent',
          embedding: vector,
          embeddingSpaceKey: spaceKey,
          limit: 1,
        }),
      ).rejects.toThrow('candidate bound reached');
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

    it('invalidates speaker-only changes and rejects an empty optional speaker revision', async () => {
      const conversationId = '77000000-0000-4000-8000-000000000077';
      const messageId = '88000000-0000-4000-8000-000000000088';
      const body = 'speaker provenance marker for a stable message body';
      await store.doc('conversations', conversationId).set({
        id: conversationId,
        agentId: 'owner',
      });
      await store.doc('messages', messageId).set({
        id: messageId,
        conversationId,
        role: 'user',
        origin: 'owner',
        text: body,
        createdAt: new Date(),
      });

      const repository = new FirestoreConversationSearchRepository(store, space);
      const initial = await repository.text({
        agentId: 'owner',
        query: 'speaker provenance',
        limit: 5,
      });
      const original = initial.find((row) => row.messageId === messageId);
      if (!original?.speakerRevision) throw new Error('Expected a speaker-bound source');
      const originalRef = {
        messageId,
        conversationId,
        sourceRevision: original.sourceRevision,
        speakerRevision: original.speakerRevision,
      };

      const emptySpeakerRevision = { ...originalRef, speakerRevision: '' };
      await expect(
        repository.validateSources({ agentId: 'owner', sourceRefs: [emptySpeakerRevision] }),
      ).rejects.toThrow('Invalid conversation source identity');
      await expect(
        repository.refreshForResume({
          agentId: 'owner',
          query: 'speaker provenance',
          limit: 5,
          sourceRefs: [emptySpeakerRevision],
        }),
      ).rejects.toThrow('Invalid resumed conversation source identity');

      await store.doc('messages', messageId).update({ role: 'assistant' });
      expect(
        (await repository.validateSources({ agentId: 'owner', sourceRefs: [originalRef] }))
          .unchangedSourceRefs,
      ).toEqual([false]);
      const roleChanged = await repository.refreshForResume({
        agentId: 'owner',
        query: 'speaker provenance',
        limit: 5,
        sourceRefs: [originalRef],
      });
      expect(roleChanged.unchangedSourceRefs).toEqual([false]);
      const assistantMessage = roleChanged.matches.find((row) => row.messageId === messageId);
      expect(assistantMessage?.role).toBe('assistant');
      expect(assistantMessage?.sourceRevision).toBe(original.sourceRevision);
      expect(assistantMessage?.speakerRevision).not.toBe(original.speakerRevision);
      if (!assistantMessage?.speakerRevision)
        throw new Error('Expected refreshed assistant speaker provenance');

      const roleChangedRef = {
        messageId,
        conversationId,
        sourceRevision: assistantMessage.sourceRevision,
        speakerRevision: assistantMessage.speakerRevision,
      };
      await store.doc('messages', messageId).update({ origin: 'assistant' });
      expect(
        (await repository.validateSources({ agentId: 'owner', sourceRefs: [roleChangedRef] }))
          .unchangedSourceRefs,
      ).toEqual([false]);
      const originChanged = await repository.refreshForResume({
        agentId: 'owner',
        query: 'speaker provenance',
        limit: 5,
        sourceRefs: [roleChangedRef],
      });
      expect(originChanged.unchangedSourceRefs).toEqual([false]);
      const refreshedMessage = originChanged.matches.find((row) => row.messageId === messageId);
      expect(refreshedMessage?.role).toBe('assistant');
      expect(refreshedMessage?.origin).toBe('assistant');
      expect(refreshedMessage?.sourceRevision).toBe(original.sourceRevision);
      expect(refreshedMessage?.speakerRevision).not.toBe(roleChangedRef.speakerRevision);
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
