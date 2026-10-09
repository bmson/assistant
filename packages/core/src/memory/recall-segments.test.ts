import {
  agents,
  conversationSegments,
  conversations,
  createDb,
  type Db,
  messages,
} from '@assistant/db';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recallRelevantContext } from './recall.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

// A basis vector orthogonal to the ones the message-tier recall test uses, so
// the two suites never retrieve each other's data regardless of run order.
function unit(i: number): number[] {
  const v = new Array(1536).fill(0);
  v[i] = 1;
  return v;
}
function blend(a: number, b: number): number[] {
  const vector = new Array(1536).fill(0);
  vector[5] = a;
  vector[6] = b;
  return vector;
}
const EMBEDDING_SPACE_KEY = embeddingSpaceIdentityKey({
  provider: 'synthetic',
  model: 'recall-segment-fixture',
  dimensions: 1536,
  revision: '1',
});
const QUERY_VEC = unit(5);
const queryEmbed = async () => [QUERY_VEC];

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Recall Segment Test',
        email: `recall-seg-${Date.now()}@example.com`,
        workspacePrefix: 'recall-seg-test',
      })
      .returning();
    agentId = (agent as NonNullable<typeof agent>).id;
    dbUp = true;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'seg-recall' })
      .returning();
    conversationId = (conversation as NonNullable<typeof conversation>).id;

    const [keyMsg] = await db
      .insert(messages)
      .values({
        conversationId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'KEY_LINE what were the lease terms again',
        embedding: unit(6),
        embeddingSpaceKey: EMBEDDING_SPACE_KEY,
        createdAt: new Date('2025-01-10T10:00:00.000Z'),
      })
      .returning();

    await db.insert(conversationSegments).values({
      agentId,
      conversationId,
      startMessageId: (keyMsg as NonNullable<typeof keyMsg>).id,
      endMessageId: (keyMsg as NonNullable<typeof keyMsg>).id,
      summary: 'SEGMENT_SUMMARY apartment lease was a 12-month term, sign by Friday',
      // It qualifies, but at a lower cosine score than the raw correction.
      embedding: blend(0.8, 0.6),
      embeddingSpaceKey: EMBEDDING_SPACE_KEY,
      messageCount: 1,
      startedAt: new Date('2025-01-10T10:00:00.000Z'),
      endedAt: new Date('2025-01-10T10:05:00.000Z'),
    });
    await db.insert(messages).values({
      conversationId,
      role: 'assistant',
      origin: 'assistant',
      parts: [],
      text: 'CORRECTION: the lease term was fifteen months, not twelve',
      embedding: unit(5),
      embeddingSpaceKey: EMBEDDING_SPACE_KEY,
      createdAt: new Date('2025-01-10T10:06:00.000Z'),
    });
  } catch {
    console.warn('recall-segments.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db
      .delete(conversationSegments)
      .where(eq(conversationSegments.conversationId, conversationId));
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('recall — segment and raw tiers', () => {
  it('blends segment summaries with raw message neighborhoods and grounds both', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await recallRelevantContext(
      db,
      {
        agentId,
        queryText: 'remind me about the apartment lease',
        embed: queryEmbed,
        // Live window is in a different conversation, so the segment is eligible.
        exclude: {
          conversationId: '00000000-0000-0000-0000-000000000000',
          sinceCreatedAt: new Date(),
        },
      },
      { embeddingSpaceKey: EMBEDDING_SPACE_KEY },
    );
    expect(result.tier).toBe('blended');
    expect(result.block).toContain('SEGMENT_SUMMARY');
    expect(result.block).toContain('CORRECTION');
    expect(result.block.indexOf('CORRECTION')).toBeLessThan(
      result.block.indexOf('SEGMENT_SUMMARY'),
    );
    expect(result.used).toBeGreaterThanOrEqual(2);
    // Phase 4: provenance for the UI affordance.
    expect(result.sources.length).toBeGreaterThanOrEqual(2);
    expect(result.sources[0]?.date).toBe('2025-01-10');
    expect(result.sources[0]?.label).toContain('CORRECTION');
  });

  it('excludes a segment that overlaps the live window', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Treat the whole seeded conversation as the live window: its only segment
    // ends after `sinceCreatedAt`, so it must not be recalled — and there is no
    // message-tier fallback match either.
    const result = await recallRelevantContext(
      db,
      {
        agentId,
        queryText: 'remind me about the apartment lease',
        embed: queryEmbed,
        exclude: {
          conversationId,
          sinceCreatedAt: new Date('2025-01-10T00:00:00.000Z'),
        },
      },
      { embeddingSpaceKey: EMBEDDING_SPACE_KEY },
    );
    expect(result.block).not.toContain('SEGMENT_SUMMARY');
  });
});
