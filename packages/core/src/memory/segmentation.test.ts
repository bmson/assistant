import {
  agents,
  conversationSegments,
  conversations,
  createDb,
  type Db,
  messages,
} from '@assistant/db';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import { segmentConversations } from './segmentation.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const TEST_SPACE = {
  provider: 'test',
  model: 'segment-test',
  dimensions: 1536,
  revision: '1',
} as const;

function unit(i: number): number[] {
  const v = new Array(1536).fill(0);
  v[i] = 1;
  return v;
}

// Summaries embed to a fixed vector; every generate() returns a canned summary.
const fakeRouter = {
  async embeddingSpace() {
    return TEST_SPACE;
  },
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.02));
  },
  async generate() {
    return {
      ok: true as const,
      modelId: 'fake',
      degraded: false,
      text: 'Discussed the topic and agreed next steps.',
    };
  },
} as unknown as ModelRouter;

const BASE = new Date('2025-02-01T09:00:00.000Z');
const at = (minutesAfter: number) => new Date(BASE.getTime() + minutesAfter * 60_000);
const FUTURE = new Date(BASE.getTime() + 48 * 60 * 60_000); // well past the settle window

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;
const messageIds: string[] = [];

async function seedMessage(
  embedding: number[],
  text: string,
  createdAt: Date,
  channelMessageId?: string,
): Promise<void> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      role: 'user',
      origin: 'owner',
      parts: [],
      text,
      embedding,
      embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE),
      createdAt,
      ...(channelMessageId ? { channelMessageId } : {}),
    })
    .returning();
  messageIds.push((row as NonNullable<typeof row>).id);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    // A dedicated agent isolates this run from every other conversation.
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Segment Test',
        email: `segment-test-${BASE.getTime()}@example.com`,
        workspacePrefix: 'segment-test',
      })
      .returning();
    agentId = (agent as NonNullable<typeof agent>).id;
    dbUp = true;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'segment-test' })
      .returning();
    conversationId = (conversation as NonNullable<typeof conversation>).id;

    // Topic A (three turns), then a drift to topic B (three turns), one minute
    // apart so no time gap fires — the drift is the only boundary.
    await seedMessage(unit(0), 'A1 kubernetes rollout plan', at(0));
    await seedMessage(unit(0), 'A2 staging first then prod', at(1));
    await seedMessage(unit(0), 'A3 rollback if error rate spikes', at(2));
    await seedMessage(unit(1), 'B1 apartment lease terms', at(3));
    await seedMessage(unit(1), 'B2 twelve month term', at(4));
    await seedMessage(unit(1), 'B3 sign by friday', at(5));
    await seedMessage(unit(2), 'QA fixture topic one', at(6), 'visual-qa:segmentation:1');
    await seedMessage(unit(2), 'QA fixture topic two', at(7), 'visual-qa:segmentation:2');
    await seedMessage(unit(2), 'QA fixture topic three', at(8), 'visual-qa:segmentation:3');
    await seedMessage(
      unit(2),
      'Readability fixture topic one',
      at(9),
      'readability-run-segment-01-user',
    );
    await seedMessage(
      unit(2),
      'Readability fixture topic two',
      at(10),
      'readability-run-segment-02-assistant',
    );
    await seedMessage(
      unit(2),
      'Readability fixture topic three',
      at(11),
      'readability-run-segment-03-user',
    );
  } catch {
    console.warn('segmentation.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db
      .delete(conversationSegments)
      .where(eq(conversationSegments.conversationId, conversationId));
    if (messageIds.length) await db.delete(messages).where(inArray(messages.id, messageIds));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('segmentConversations (integration)', () => {
  it('splits a conversation into topic segments at the drift boundary', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await segmentConversations({ db, router: fakeRouter }, { agentId, now: FUTURE });
    expect(result.segmentsCreated).toBe(2);

    const segs = await db
      .select()
      .from(conversationSegments)
      .where(eq(conversationSegments.conversationId, conversationId))
      .orderBy(conversationSegments.startedAt);
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.messageCount)).toEqual([3, 3]);
    expect(segs.every((s) => s.summary.length > 0)).toBe(true);
    expect(segs.every((s) => s.embedding !== null)).toBe(true);
    // First segment spans topic A, second spans topic B.
    expect(segs[0]?.startedAt.toISOString()).toBe(at(0).toISOString());
    expect(segs[0]?.endedAt.toISOString()).toBe(at(2).toISOString());
    expect(segs[1]?.startedAt.toISOString()).toBe(at(3).toISOString());
    expect(segs[1]?.endedAt.toISOString()).toBe(at(5).toISOString());
  });

  it('is idempotent — a second run adds nothing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await segmentConversations({ db, router: fakeRouter }, { agentId, now: FUTURE });
    expect(result.segmentsCreated).toBe(0);
    const count = await db
      .select()
      .from(conversationSegments)
      .where(eq(conversationSegments.conversationId, conversationId));
    expect(count).toHaveLength(2);
  });

  it('holds back a still-active trailing group until it settles', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // "now" just after the last message: the trailing (only) group has not
    // settled, so nothing new is committed on a fresh conversation.
    const [freshConvo] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'segment-test-fresh' })
      .returning();
    const freshId = (freshConvo as NonNullable<typeof freshConvo>).id;
    const [m1] = await db
      .insert(messages)
      .values({
        conversationId: freshId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'C1 hi',
        embedding: unit(2),
        embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE),
        createdAt: at(10),
      })
      .returning();
    const [m2] = await db
      .insert(messages)
      .values({
        conversationId: freshId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'C2 there',
        embedding: unit(2),
        embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE),
        createdAt: at(11),
      })
      .returning();

    const result = await segmentConversations(
      { db, router: fakeRouter },
      { agentId, now: at(12) }, // one minute after the last message → not settled
    );
    const segs = await db
      .select()
      .from(conversationSegments)
      .where(eq(conversationSegments.conversationId, freshId));
    expect(segs).toHaveLength(0);
    expect(result.segmentsCreated).toBe(0);

    // cleanup
    await db
      .delete(messages)
      .where(
        inArray(messages.id, [
          (m1 as NonNullable<typeof m1>).id,
          (m2 as NonNullable<typeof m2>).id,
        ]),
      );
    await db.delete(conversations).where(eq(conversations.id, freshId));
  });

  it('does not advance past an unembedded substantive turn and repairs the range later', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [freshConvo] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'segment-gap-test' })
      .returning();
    const freshId = (freshConvo as NonNullable<typeof freshConvo>).id;
    const [pending] = await db
      .insert(messages)
      .values({
        conversationId: freshId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'This older substantive source turn awaits its embedding',
        embedding: null,
        embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE),
        createdAt: at(20),
      })
      .returning();
    const [middle] = await db
      .insert(messages)
      .values({
        conversationId: freshId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'Then we discussed the garden project',
        embedding: unit(2),
        embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE),
        createdAt: at(21),
      })
      .returning();
    const [last] = await db
      .insert(messages)
      .values({
        conversationId: freshId,
        role: 'assistant',
        origin: 'assistant',
        parts: [],
        text: 'The garden project is ready for spring',
        embedding: unit(2),
        embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE),
        createdAt: at(22),
      })
      .returning();
    const pendingId = (pending as NonNullable<typeof pending>).id;
    const ids = [
      pendingId,
      (middle as NonNullable<typeof middle>).id,
      (last as NonNullable<typeof last>).id,
    ];
    try {
      const first = await segmentConversations(
        { db, router: fakeRouter },
        { agentId, now: FUTURE },
      );
      expect(first.segmentsCreated).toBe(0);
      expect(
        await db
          .select()
          .from(conversationSegments)
          .where(eq(conversationSegments.conversationId, freshId)),
      ).toHaveLength(0);

      await db
        .update(messages)
        .set({ embedding: unit(2), embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE) })
        .where(eq(messages.id, pendingId));
      const repaired = await segmentConversations(
        { db, router: fakeRouter },
        { agentId, now: FUTURE },
      );
      expect(repaired.segmentsCreated).toBe(1);
      const rows = await db
        .select()
        .from(conversationSegments)
        .where(eq(conversationSegments.conversationId, freshId));
      expect(rows).toMatchObject([
        { startMessageId: ids[0], endMessageId: ids[2], messageCount: 3 },
      ]);
    } finally {
      await db.delete(conversationSegments).where(eq(conversationSegments.conversationId, freshId));
      await db.delete(messages).where(inArray(messages.id, ids));
      await db.delete(conversations).where(eq(conversations.id, freshId));
    }
  });

  it('creates a settled singleton segment so it remains inside explicit coverage', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [freshConvo] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'segment-singleton-test' })
      .returning();
    const freshId = (freshConvo as NonNullable<typeof freshConvo>).id;
    const [only] = await db
      .insert(messages)
      .values({
        conversationId: freshId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'A single turn about gardening plans',
        embedding: unit(3),
        embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE),
        createdAt: at(30),
      })
      .returning();
    const onlyId = (only as NonNullable<typeof only>).id;
    try {
      const result = await segmentConversations(
        { db, router: fakeRouter },
        { agentId, now: FUTURE },
      );
      expect(result.segmentsCreated).toBe(1);
      const rows = await db
        .select()
        .from(conversationSegments)
        .where(eq(conversationSegments.conversationId, freshId));
      expect(rows).toMatchObject([
        { startMessageId: onlyId, endMessageId: onlyId, messageCount: 1 },
      ]);
    } finally {
      await db.delete(conversationSegments).where(eq(conversationSegments.conversationId, freshId));
      await db.delete(messages).where(eq(messages.id, onlyId));
      await db.delete(conversations).where(eq(conversations.id, freshId));
    }
  });

  it('repairs a foreign-space message after its vector identity is refreshed', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [freshConvo] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'segment-space-repair-test' })
      .returning();
    const freshId = (freshConvo as NonNullable<typeof freshConvo>).id;
    const foreignSpaceKey = embeddingSpaceIdentityKey({
      ...TEST_SPACE,
      revision: 'foreign-revision',
    });
    const [source] = await db
      .insert(messages)
      .values({
        conversationId: freshId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'A substantive owner message with a vector from another space',
        embedding: unit(5),
        embeddingSpaceKey: foreignSpaceKey,
        createdAt: at(35),
      })
      .returning();
    const sourceId = (source as NonNullable<typeof source>).id;
    try {
      const withheld = await segmentConversations(
        { db, router: fakeRouter },
        { agentId, now: FUTURE },
      );
      expect(withheld.segmentsCreated).toBe(0);
      expect(
        await db
          .select()
          .from(conversationSegments)
          .where(eq(conversationSegments.conversationId, freshId)),
      ).toHaveLength(0);

      await db
        .update(messages)
        .set({ embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE) })
        .where(eq(messages.id, sourceId));
      const repaired = await segmentConversations(
        { db, router: fakeRouter },
        { agentId, now: FUTURE },
      );
      expect(repaired.segmentsCreated).toBe(1);
      expect(
        await db
          .select()
          .from(conversationSegments)
          .where(eq(conversationSegments.conversationId, freshId)),
      ).toMatchObject([{ startMessageId: sourceId, endMessageId: sourceId, messageCount: 1 }]);
    } finally {
      await db.delete(conversationSegments).where(eq(conversationSegments.conversationId, freshId));
      await db.delete(messages).where(eq(messages.id, sourceId));
      await db.delete(conversations).where(eq(conversations.id, freshId));
    }
  });

  it('leaves a failed summary span retryable and commits after the summarizer recovers', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [freshConvo] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'segment-summary-retry-test' })
      .returning();
    const freshId = (freshConvo as NonNullable<typeof freshConvo>).id;
    const [only] = await db
      .insert(messages)
      .values({
        conversationId: freshId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'A source turn whose summary model will recover',
        embedding: unit(4),
        embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE),
        createdAt: at(40),
      })
      .returning();
    const onlyId = (only as NonNullable<typeof only>).id;
    let recovered = false;
    const router = {
      async embeddingSpace() {
        return TEST_SPACE;
      },
      async generate() {
        if (!recovered) throw new Error('temporary summarizer outage');
        return {
          ok: true as const,
          modelId: 'fixture',
          degraded: false,
          text: 'Recovered summary includes the source decision.',
        };
      },
      async embed(texts: string[]) {
        return texts.map(() => unit(7));
      },
    } as unknown as ModelRouter;
    try {
      expect(
        (await segmentConversations({ db, router }, { agentId, now: FUTURE })).segmentsCreated,
      ).toBe(0);
      expect(
        await db
          .select()
          .from(conversationSegments)
          .where(eq(conversationSegments.conversationId, freshId)),
      ).toHaveLength(0);
      recovered = true;
      expect(
        (await segmentConversations({ db, router }, { agentId, now: FUTURE })).segmentsCreated,
      ).toBe(1);
      const rows = await db
        .select()
        .from(conversationSegments)
        .where(eq(conversationSegments.conversationId, freshId));
      expect(rows).toMatchObject([
        {
          startMessageId: onlyId,
          endMessageId: onlyId,
          summary: 'Recovered summary includes the source decision.',
        },
      ]);
    } finally {
      await db.delete(conversationSegments).where(eq(conversationSegments.conversationId, freshId));
      await db.delete(messages).where(eq(messages.id, onlyId));
      await db.delete(conversations).where(eq(conversations.id, freshId));
    }
  });

  it('keeps the decisive last turn in the bounded summary prompt beyond 6,000 characters', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [freshConvo] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'segment-bounded-summary-test' })
      .returning();
    const freshId = (freshConvo as NonNullable<typeof freshConvo>).id;
    const ids: string[] = [];
    for (let index = 0; index < 24; index += 1) {
      const text =
        index === 23
          ? `DECISIVE_LAST_TURN_${'z'.repeat(490)}`
          : `topic ${index} ${'x'.repeat(490)}`;
      const [row] = await db
        .insert(messages)
        .values({
          conversationId: freshId,
          role: index % 2 === 0 ? 'user' : 'assistant',
          origin: index % 2 === 0 ? 'owner' : 'assistant',
          parts: [],
          text,
          embedding: unit(8),
          embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE),
          createdAt: at(50 + index),
        })
        .returning();
      ids.push((row as NonNullable<typeof row>).id);
    }
    const prompts: string[] = [];
    const router = {
      async embeddingSpace() {
        return TEST_SPACE;
      },
      async generate(_role: string, input: { prompt: string }) {
        prompts.push(input.prompt);
        return {
          ok: true as const,
          modelId: 'fixture',
          degraded: false,
          text: 'Bounded summary includes the final decision.',
        };
      },
      async embed(texts: string[]) {
        return texts.map(() => unit(9));
      },
    } as unknown as ModelRouter;
    try {
      const result = await segmentConversations({ db, router }, { agentId, now: FUTURE });
      expect(result.segmentsCreated).toBe(1);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('DECISIVE_LAST_TURN');
      expect(prompts[0]?.length).toBeLessThan(13_000);
    } finally {
      await db.delete(conversationSegments).where(eq(conversationSegments.conversationId, freshId));
      await db.delete(messages).where(inArray(messages.id, ids));
      await db.delete(conversations).where(eq(conversations.id, freshId));
    }
  });

  it('uses message ID as a stable tie-breaker after a same-timestamp segment watermark', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [freshConvo] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'segment-tie-cursor-test' })
      .returning();
    const freshId = (freshConvo as NonNullable<typeof freshConvo>).id;
    const timestamp = at(80);
    const firstId = '00000000-0000-4000-8000-000000000001';
    const nextId = '00000000-0000-4000-8000-000000000002';
    try {
      await db.insert(messages).values({
        id: firstId,
        conversationId: freshId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'An already summarized source turn',
        embedding: unit(10),
        embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE),
        createdAt: timestamp,
      });
      await db.insert(conversationSegments).values({
        agentId,
        conversationId: freshId,
        startMessageId: firstId,
        endMessageId: firstId,
        summary: 'Prior same-time source',
        embedding: unit(11),
        embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE),
        messageCount: 1,
        startedAt: timestamp,
        endedAt: timestamp,
      });
      await db.insert(messages).values({
        id: nextId,
        conversationId: freshId,
        role: 'assistant',
        origin: 'assistant',
        parts: [],
        text: 'A same-timestamp assistant correction follows',
        embedding: unit(10),
        embeddingSpaceKey: embeddingSpaceIdentityKey(TEST_SPACE),
        createdAt: timestamp,
      });
      const result = await segmentConversations(
        { db, router: fakeRouter },
        { agentId, now: FUTURE },
      );
      expect(result.segmentsCreated).toBe(1);
      const rows = await db
        .select()
        .from(conversationSegments)
        .where(eq(conversationSegments.conversationId, freshId))
        .orderBy(conversationSegments.startMessageId);
      expect(rows.map((row) => [row.startMessageId, row.endMessageId])).toContainEqual([
        nextId,
        nextId,
      ]);
    } finally {
      await db.delete(conversationSegments).where(eq(conversationSegments.conversationId, freshId));
      await db.delete(messages).where(eq(messages.conversationId, freshId));
      await db.delete(conversations).where(eq(conversations.id, freshId));
    }
  });
});
