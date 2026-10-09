import { conversations, createDb, type Db, messages, type TaskRow } from '@assistant/db';
import type { ModelMessage } from 'ai';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../../chat.js';
import type { TaskState } from '../../events.js';
import { foldOwnerRepliesSincePark } from './seed.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('foldOwnerRepliesSincePark', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  const conversationIds: string[] = [];

  async function makeConversation(channel: 'chat' | 'email'): Promise<string> {
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, channel, trust: 'owner', title: `xtest-fold-${channel}` })
      .returning({ id: conversations.id });
    const id = (conv as NonNullable<typeof conv>).id;
    conversationIds.push(id);
    return id;
  }

  async function addOwnerMessage(
    conversationId: string,
    text: string,
    at: Date,
    id?: string,
  ): Promise<void> {
    await db.insert(messages).values({
      id,
      conversationId,
      role: 'user',
      origin: 'owner',
      parts: [{ type: 'text', text }],
      text,
      createdAt: at,
    });
  }

  const stateWith = (seenConversationAt?: string, seenConversationId?: string): TaskState =>
    ({ seenConversationAt, seenConversationId, contextWindow: [] }) as unknown as TaskState;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
    } catch {
      console.warn('reply-fold.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (!dbUp) return;
    if (conversationIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
  });

  it('persists precise microsecond watermarks across repeated resumes', async () => {
    if (!dbUp) throw new Error('Database unavailable');
    const conversationId = await makeConversation('chat');
    const task = { conversationId, agentId };
    const state = stateWith('2026-07-22T09:00:00.000Z');
    const window: ModelMessage[] = [];
    for (const [index, fraction] of ['123456', '123789'].entries()) {
      await db.insert(messages).values({
        conversationId,
        role: 'user',
        origin: 'owner',
        text: `micro-${index}`,
        parts: [],
        createdAt: sql`(${`2026-07-22T10:00:00.${fraction}Z`})::timestamptz`,
      });
    }
    await foldOwnerRepliesSincePark(db, task, state, window);
    expect(window.map((m) => m.content)).toEqual([
      '[The owner added this while the task was paused:]\nmicro-0',
      '[The owner added this while the task was paused:]\nmicro-1',
    ]);
    expect(state.seenConversationAt).toBe('2026-07-22T10:00:00.123789000Z');
    const resumed = JSON.parse(JSON.stringify(state)) as TaskState;
    for (let i = 0; i < 3; i++) await foldOwnerRepliesSincePark(db, task, resumed, window);
    expect(window).toHaveLength(2);
    await db.insert(messages).values({
      conversationId,
      role: 'user',
      origin: 'owner',
      text: 'third',
      parts: [],
      createdAt: sql`('2026-07-22T10:00:00.123790Z')::timestamptz`,
    });
    await foldOwnerRepliesSincePark(db, task, resumed, window);
    expect(window).toHaveLength(3);
    expect(resumed.seenConversationAt).toBe('2026-07-22T10:00:00.123790000Z');
  });

  it('baselines the watermark on the first run without folding', async () => {
    if (!dbUp) return;
    const conversationId = await makeConversation('chat');
    await addOwnerMessage(conversationId, 'seed message', new Date('2026-07-22T10:00:00Z'));
    const state = stateWith(undefined);
    const window: ModelMessage[] = [];
    await foldOwnerRepliesSincePark(db, { agentId, conversationId } as TaskRow, state, window);
    expect(window).toHaveLength(0); // nothing folded — seed already holds it
    expect(state.seenConversationAt).toBe('2026-07-22T10:00:00.000000000Z');
    expect(state.seenConversationId).toBeTruthy();
  });

  it('folds an owner reply newer than the watermark and advances it', async () => {
    if (!dbUp) return;
    const conversationId = await makeConversation('chat');
    await addOwnerMessage(conversationId, 'actually make it Bob', new Date('2026-07-22T11:00:00Z'));
    const state = stateWith('2026-07-22T10:00:00.000000000Z');
    const window: ModelMessage[] = [];
    await foldOwnerRepliesSincePark(db, { agentId, conversationId } as TaskRow, state, window);
    expect(window).toHaveLength(1);
    expect(String(window[0]?.content)).toContain('actually make it Bob');
    expect(String(window[0]?.content)).toContain('while the task was paused');
    expect(state.seenConversationAt).toBe('2026-07-22T11:00:00.000000000Z');
    expect(state.seenConversationId).toBeTruthy();

    // Idempotent: a second fold with the advanced watermark appends nothing.
    const window2: ModelMessage[] = [];
    await foldOwnerRepliesSincePark(db, { agentId, conversationId } as TaskRow, state, window2);
    expect(window2).toHaveLength(0);
  });

  it('folds a later message ID at the same timestamp exactly once', async () => {
    if (!dbUp) return;
    const conversationId = await makeConversation('chat');
    const at = new Date('2026-07-22T11:00:00Z');
    const firstId = '00000000-0000-4000-8000-000000000001';
    const secondId = '00000000-0000-4000-8000-000000000002';
    await addOwnerMessage(conversationId, 'already seen', at, firstId);
    await addOwnerMessage(conversationId, 'same-time correction', at, secondId);
    const state = stateWith(at.toISOString(), firstId);
    const window: ModelMessage[] = [];

    await foldOwnerRepliesSincePark(db, { agentId, conversationId } as TaskRow, state, window);

    expect(window.map((message) => String(message.content))).toEqual([
      expect.stringContaining('same-time correction'),
    ]);
    expect(state.seenConversationAt).toBe(at.toISOString().replace(/(\.\d{3})Z$/, '$1000000Z'));
    expect(state.seenConversationId).toBe(secondId);
    const repeated: ModelMessage[] = [];
    await foldOwnerRepliesSincePark(db, { agentId, conversationId } as TaskRow, state, repeated);
    expect(repeated).toEqual([]);
  });

  it('never folds email-channel conversations (no third-party reinjection)', async () => {
    if (!dbUp) return;
    const conversationId = await makeConversation('email');
    await addOwnerMessage(conversationId, 'a quoted forward', new Date('2026-07-22T11:00:00Z'));
    const state = stateWith('2026-07-22T10:00:00.000000000Z');
    const window: ModelMessage[] = [];
    await foldOwnerRepliesSincePark(db, { agentId, conversationId } as TaskRow, state, window);
    expect(window).toHaveLength(0);
    // The watermark is left untouched for a non-chat channel.
    expect(state.seenConversationAt).toBe('2026-07-22T10:00:00.000000000Z');
  });
});
