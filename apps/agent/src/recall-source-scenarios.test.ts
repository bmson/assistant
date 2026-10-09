import { randomUUID } from 'node:crypto';
import { assembleDiscussionFrame } from '@assistant/core/memory/discussion-frame';
import { recallRelevantContext } from '@assistant/core/memory/recall';
import { agents, conversations, createDb, type Db, messages } from '@assistant/db';
import {
  embeddingSpaceKey,
  FirestoreHistoryRecallRepository,
  FirestoreRecallSurfacingRepository,
} from '@assistant/firestore';
import {
  type EmbeddingSpace,
  embeddingSpaceIdentityKey,
  type RecallSurfacingRepository,
} from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fuseContextCandidates } from '../../../packages/core/src/memory/context-fusion.js';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const space: EmbeddingSpace = {
  provider: 'offline-test',
  model: 'hashed-token',
  dimensions: 1536,
  revision: '1',
};
const oldAt = new Date('2025-01-01T12:00:00.000Z');
const liveAt = new Date('2026-10-07T12:00:00.000Z');

/** Deterministic local embedding port; it ranks token overlap, not semantic answers. */
function localEmbedding(text: string): number[] {
  const vector = new Array<number>(1536).fill(0);
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) {
    let hash = 2166136261;
    for (const char of token) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0;
    const index = hash % vector.length;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude ? vector.map((value) => value / magnitude) : vector;
}

type Scenario = {
  name: string;
  query: string;
  source: string;
  expected: boolean;
  trust?: string;
  sourceAgent?: 'owner' | 'foreign';
  live?: boolean;
  blank?: boolean;
  antecedent?: string;
};

const scenarios: Scenario[] = [
  {
    name: 'retrieves a matching owner topic',
    query: 'garden plan basil raised beds',
    source: 'garden plan basil raised beds',
    expected: true,
  },
  {
    name: 'resolves a pronoun through the supplied antecedent frame',
    query: 'what did I choose for it',
    source: 'we discussed cedar deck stain and chose dark walnut',
    expected: true,
    antecedent: 'We discussed cedar deck stain and chose dark walnut.',
  },
  {
    name: 'abstains on an ambiguous pronoun without an antecedent',
    query: 'what did I choose for it',
    source: 'cedar deck stain dark walnut',
    expected: false,
  },
  {
    name: 'does not retrieve an unrelated topic',
    query: 'garden plan basil raised beds',
    source: 'airport shuttle terminal schedule',
    expected: false,
  },
  {
    name: 'excludes a stranger-trust conversation',
    query: 'security key recovery code device',
    source: 'security key recovery code device',
    expected: false,
    trust: 'unknown',
  },
  {
    name: 'excludes another owner namespace',
    query: 'tax folder quarterly estimate',
    source: 'tax folder quarterly estimate',
    expected: false,
    sourceAgent: 'foreign',
  },
  {
    name: 'excludes content already inside the live conversation window',
    query: 'live discussion garden plan basil',
    source: 'live discussion garden plan basil',
    expected: false,
    live: true,
  },
  {
    name: 'allows trusted owner history from another conversation',
    query: 'weekly meal lentils spinach',
    source: 'weekly meal lentils spinach',
    expected: true,
  },
  {
    name: 'allows trusted owner context from another conversation',
    query: 'printer setup duplex tray',
    source: 'printer setup duplex tray',
    expected: true,
  },
  {
    name: 'rejects empty source text even when its vector is nearby',
    query: 'empty source text sentinel',
    source: 'empty source text sentinel',
    expected: false,
    blank: true,
  },
  {
    name: 'keeps query and source identity evidence on the selected result',
    query: 'passport renewal appointment',
    source: 'passport renewal appointment',
    expected: true,
  },
  {
    name: 'uses discussion framing without turning a reference into authority',
    query: 'which one did I choose',
    source: 'we compared the blue ceramic tile with the white stone tile',
    expected: true,
    antecedent: 'We compared the blue ceramic tile with the white stone tile.',
  },
  {
    name: 'does not infer a referent from an unrelated antecedent',
    query: 'what did I choose for that',
    source: 'blue ceramic tile white stone tile',
    expected: false,
    antecedent: 'We talked about the weather forecast.',
  },
  {
    name: 'excludes a recent message from the already-visible live tail',
    query: 'recent visible call notes',
    source: 'recent visible call notes',
    expected: false,
    live: true,
  },
  {
    name: 'selects a bounded source with stable provenance',
    query: 'renew library card address',
    source: 'renew library card address',
    expected: true,
  },
];

describe('source-grounded offline recall scenarios (actual adapters)', () => {
  let db: Db;
  let pgReady = false;
  let agentId = '';
  let foreignAgentId = '';
  const pgConversationIds: string[] = [];
  const pgMessageIds: string[] = [];
  let fsStore: InstallationStore | undefined;

  beforeAll(async () => {
    if (process.env.DATABASE_URL) {
      db = createDb(DATABASE_URL);
      try {
        const [agent] = await db.select().from(agents).limit(1);
        agentId = agent?.id ?? '';
        const [foreign] = await db
          .insert(agents)
          .values({
            name: `Recall fixture ${randomUUID()}`,
            email: `recall-${randomUUID()}@example.test`,
            workspacePrefix: `recall-fixtures/${randomUUID()}`,
          })
          .returning({ id: agents.id });
        foreignAgentId = foreign?.id ?? '';
        pgReady = Boolean(agentId);
      } catch {
        pgReady = false;
      }
    }
  });
  afterAll(async () => {
    if (pgReady) {
      if (pgMessageIds.length) await db.delete(messages).where(inArray(messages.id, pgMessageIds));
      if (pgConversationIds.length)
        await db.delete(conversations).where(inArray(conversations.id, pgConversationIds));
      if (foreignAgentId) await db.delete(agents).where(eq(agents.id, foreignAgentId));
      await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
    }
  });
  beforeEach(() => {
    if (process.env.FIRESTORE_EMULATOR_HOST) fsStore = emulatorStore();
  });
  afterEach(async () => {
    if (pgReady) {
      if (pgMessageIds.length) await db.delete(messages).where(inArray(messages.id, pgMessageIds));
      if (pgConversationIds.length)
        await db.delete(conversations).where(inArray(conversations.id, pgConversationIds));
      pgMessageIds.length = 0;
      pgConversationIds.length = 0;
    }
    if (fsStore) await disposeStore(fsStore);
    fsStore = undefined;
  });

  async function actualRecall(input: {
    adapter: 'postgres' | 'firestore';
    scenario: Scenario;
    ctx: { skip: () => void };
  }) {
    const { adapter, scenario, ctx } = input;
    if (adapter === 'postgres' && !pgReady) return ctx.skip();
    if (adapter === 'firestore' && !fsStore) return ctx.skip();
    const ownerId = adapter === 'postgres' ? agentId : 'owner';
    const sourceAgentId =
      scenario.sourceAgent === 'foreign'
        ? adapter === 'postgres'
          ? foreignAgentId
          : 'foreign-owner'
        : ownerId;
    const sourceConversationId = randomUUID();
    const liveConversationPlaceholder = randomUUID();
    const messageId = randomUUID();
    const sourceDate = scenario.live ? liveAt : oldAt;
    let store: Parameters<typeof recallRelevantContext>[0];
    let surfacing: RecallSurfacingRepository;
    const sourceMessageId = messageId;
    if (adapter === 'postgres') {
      const [conversation] = await db
        .insert(conversations)
        .values({
          id: sourceConversationId,
          agentId: sourceAgentId,
          channel: 'chat',
          trust: scenario.trust ?? 'owner',
          title: `recall-${scenario.name}`,
        })
        .returning();
      if (!conversation) throw new Error('Could not create recall scenario conversation');
      pgConversationIds.push(conversation.id);
      const [message] = await db
        .insert(messages)
        .values({
          id: messageId,
          conversationId: sourceConversationId,
          role: 'user',
          origin: 'owner',
          text: scenario.blank ? '' : scenario.source,
          embedding: localEmbedding(scenario.source),
          embeddingSpaceKey: embeddingSpaceIdentityKey(space),
          createdAt: sourceDate,
          parts: [],
        })
        .returning();
      if (!message) throw new Error('Could not create recall scenario message');
      pgMessageIds.push(message.id);
      store = db;
      const { createPostgresRecallSurfacingRepository } = await import('@assistant/db');
      surfacing = createPostgresRecallSurfacingRepository(db);
    } else {
      const target = fsStore;
      if (!target) return ctx.skip();
      const fsAgentId = sourceAgentId || 'owner';
      await target
        .doc('conversations', sourceConversationId)
        .set({ id: sourceConversationId, agentId: fsAgentId, trust: scenario.trust ?? 'owner' });
      await target.doc('messages', messageId).set({
        id: messageId,
        conversationId: sourceConversationId,
        role: 'user',
        text: scenario.blank ? '' : scenario.source,
        createdAt: sourceDate,
        embedding: FieldValue.vector(localEmbedding(scenario.source)),
        embeddingSpace: embeddingSpaceKey(space),
      });
      store = new FirestoreHistoryRecallRepository(target, space);
      surfacing = new FirestoreRecallSurfacingRepository(target);
    }

    let queryText = scenario.query;
    if (scenario.antecedent) {
      queryText = assembleDiscussionFrame({
        currentText: scenario.query,
        turns: [{ role: 'user', text: scenario.antecedent }],
      }).queryText;
    }
    const result = await recallRelevantContext(
      store,
      {
        agentId: ownerId,
        queryText,
        embed: async ([text]) => [localEmbedding(text ?? '')],
        exclude: {
          conversationId: scenario.live ? sourceConversationId : liveConversationPlaceholder,
          sinceCreatedAt: liveAt,
        },
      },
      {
        limit: 4,
        minSimilarity: 0.35,
        embeddingSpaceKey: embeddingSpaceIdentityKey(space),
        isSuppressed: async (sourceKey, sourceRevision) =>
          (await surfacing.suppressed(ownerId, [sourceKey], { [sourceKey]: sourceRevision })).has(
            sourceKey,
          ),
      },
    );
    const fused = fuseContextCandidates(result.rankedContext ?? [], { limit: 4, maxBytes: 1000 });
    return {
      result,
      fused,
      surfacing,
      agentId: ownerId,
      sourceConversationId,
      messageId: sourceMessageId,
    };
  }

  for (const adapter of ['postgres', 'firestore'] as const) {
    describe(adapter, () => {
      for (const scenario of scenarios) {
        it(scenario.name, async (ctx) => {
          const outcome = await actualRecall({ adapter, scenario, ctx });
          if (!outcome) return;
          expect(Boolean(outcome.fused.block)).toBe(scenario.expected);
          if (scenario.expected) {
            expect(outcome.fused.sources.length).toBeGreaterThan(0);
            expect(
              outcome.fused.sources.every((source) => source.surfaceKey && source.sourceRevision),
            ).toBe(true);
          } else {
            expect(outcome.fused.sources).toEqual([]);
          }
        });
      }

      it('enforces current-version mute and allows a newer source revision', async (ctx) => {
        const scenario: Scenario = {
          name: 'revision suppression',
          query: 'changed source revision garden plan',
          source: 'changed source revision garden plan',
          expected: true,
        };
        const first = await actualRecall({ adapter, scenario, ctx });
        if (!first) return;
        const source = first.result.sources[0];
        if (!source?.surfaceKey || !source.sourceRevision)
          throw new Error('Missing recall provenance');
        await first.surfacing.recordSurfaced({
          agentId: first.agentId,
          messageId: first.messageId,
          refs: [
            { sourceKey: source.surfaceKey, sourceRevision: source.sourceRevision, kind: 'chat' },
          ],
        });
        await first.surfacing.setSuppressed({
          agentId: first.agentId,
          sourceKey: source.surfaceKey,
          expectedSourceRevision: source.sourceRevision,
          suppressed: true,
        });
        if (adapter === 'firestore' && !fsStore) return ctx.skip();
        const recallStore: Parameters<typeof recallRelevantContext>[0] =
          adapter === 'postgres'
            ? db
            : new FirestoreHistoryRecallRepository(fsStore as InstallationStore, space);
        const hidden = await recallRelevantContext(
          // actualRecall seeded and returned the exact same actual repository.
          recallStore,
          {
            agentId: first.agentId,
            queryText: scenario.query,
            embed: async ([text]) => [localEmbedding(text ?? '')],
            exclude: { conversationId: randomUUID(), sinceCreatedAt: liveAt },
          },
          {
            minSimilarity: 0.35,
            embeddingSpaceKey: embeddingSpaceIdentityKey(space),
            isSuppressed: async (key, revision) =>
              (await first.surfacing.suppressed(first.agentId, [key], { [key]: revision })).has(
                key,
              ),
          },
        );
        expect(hidden.block).toBe('');
        const revised = 'changed source revision garden plan latest';
        if (adapter === 'postgres') {
          await db
            .update(messages)
            .set({
              text: revised,
              embedding: localEmbedding(revised),
              embeddingSpaceKey: embeddingSpaceIdentityKey(space),
            })
            .where(eq(messages.id, first.messageId));
        } else {
          await fsStore?.doc('messages', first.messageId).update({
            text: revised,
            embedding: FieldValue.vector(localEmbedding(revised)),
            embeddingSpace: embeddingSpaceKey(space),
          });
        }
        const visible = await recallRelevantContext(
          recallStore,
          {
            agentId: first.agentId,
            queryText: revised,
            embed: async ([text]) => [localEmbedding(text ?? '')],
            exclude: { conversationId: randomUUID(), sinceCreatedAt: liveAt },
          },
          {
            minSimilarity: 0.35,
            embeddingSpaceKey: embeddingSpaceIdentityKey(space),
            isSuppressed: async (key, revision) =>
              (await first.surfacing.suppressed(first.agentId, [key], { [key]: revision })).has(
                key,
              ),
          },
        );
        expect(visible.block).toContain('latest');
      });
    });
  }
});
