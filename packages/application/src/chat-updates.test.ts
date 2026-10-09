import { encodeMessageCursor, getAgent } from '@assistant/core/chat';
import { conversations, createDb, type Db, messages, tasks } from '@assistant/db';
import { getTableColumns, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getChatUpdates, hideChatMessage, unhideChatMessage } from './chat.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId = '';
const createdChatIds: string[] = [];
const createdTaskIds: string[] = [];
/** A well-formed id that matches no row — hydration must call it 'missing'. */
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

async function newChat(channel: 'chat' | 'sms' = 'chat'): Promise<string> {
  const [chat] = await db
    .insert(conversations)
    .values({ agentId, channel, trust: 'owner', title: 'chat-updates-test' })
    .returning();
  const id = (chat as NonNullable<typeof chat>).id;
  createdChatIds.push(id);
  return id;
}

async function newTask(conversationId: string): Promise<string> {
  const [task] = await db
    .insert(tasks)
    .values({ agentId, type: 'adhoc', trust: 'owner', conversationId })
    .returning();
  const id = (task as NonNullable<typeof task>).id;
  createdTaskIds.push(id);
  return id;
}

async function post(
  conversationId: string,
  role: 'user' | 'assistant',
  text: string,
  options: { createdAt?: Date; parts?: unknown[]; taskId?: string } = {},
) {
  // Project created_at at full timestamptz precision like listMessages does:
  // cursor assertions compare against cursors advanced over stored rows, which
  // carry microsecond-exact timestamps.
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      role,
      origin: role === 'user' ? 'owner' : 'assistant',
      parts: options.parts ?? [{ type: 'text', text }],
      text,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
    })
    .returning({
      ...getTableColumns(messages),
      createdAtExact: sql<string>`to_char(${messages.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    });
  return row as NonNullable<typeof row>;
}

/** A moment far enough past a row's timestamp that the cursor may pass it. */
function settled(row: { createdAt: Date }): Date {
  return new Date(row.createdAt.getTime() + 60_000);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('chat-updates.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdChatIds.length) {
    await db.delete(messages).where(inArray(messages.conversationId, createdChatIds));
  }
  if (dbUp && createdTaskIds.length) {
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  if (dbUp && createdChatIds.length) {
    await db.delete(conversations).where(inArray(conversations.id, createdChatIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('getChatUpdates without a task (the idle thread poll)', () => {
  it('returns what the assistant posted on its own after the cursor', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const seen = await post(conversationId, 'user', 'what is on today?');

    // A scheduled task, a watch firing, or an approval resuming — none of them
    // carry a task id the open page knows about. Before the conversation-level
    // poll these were invisible until the page was loaded again.
    const posted = await post(conversationId, 'assistant', 'Your 3pm moved to 4pm.');

    const updates = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
    });

    expect(updates).not.toBeNull();
    expect(updates?.messages.map((message) => message.id)).toEqual([posted.id]);
    expect(updates?.taskStatus).toBeNull();
    expect(updates?.activity).toEqual([]);
    // The cursor follows transaction commit order, independently of its
    // transaction-start createdAt timestamp.
    expect(updates?.nextCursor).toBe(encodeMessageCursor(posted));
    expect(
      (
        await getChatUpdates(db, {
          conversationId,
          cursor: updates?.nextCursor ?? undefined,
        })
      )?.nextCursor,
    ).toBe(encodeMessageCursor(posted));
  });

  it('advances its cursor so the same message is not delivered twice', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const seen = await post(conversationId, 'user', 'first');
    const posted = await post(conversationId, 'assistant', 'second');

    const first = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
      now: settled(posted),
    });
    expect(first?.messages).toHaveLength(1);
    expect(first?.nextCursor).toBe(encodeMessageCursor(posted));

    const second = await getChatUpdates(db, {
      conversationId,
      cursor: first?.nextCursor ?? undefined,
      now: settled(posted),
    });
    expect(second?.messages).toEqual([]);
    expect(second?.nextCursor).toBe(encodeMessageCursor(posted));
  });

  it('refuses a conversation that is not this agent’s chat', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The task lookup is what authorised the caller on the task path; without
    // one, an id from the query string must not be enough on its own.
    const smsThread = await newChat('sms');
    await expect(getChatUpdates(db, { conversationId: smsThread })).resolves.toBeNull();

    await expect(getChatUpdates(db, { conversationId: MISSING_ID })).resolves.toBeNull();
  });

  it('pages a long backlog rather than returning it all at once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const seen = await post(conversationId, 'user', 'start');
    for (let index = 0; index < 4; index += 1) {
      await post(conversationId, 'assistant', `update ${index.toString()}`);
    }

    const page = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
      pageSize: 2,
    });
    expect(page?.messages).toHaveLength(2);
    expect(page?.hasMore).toBe(true);

    const rest = await getChatUpdates(db, {
      conversationId,
      cursor: page?.nextCursor ?? undefined,
      pageSize: 2,
    });
    expect(rest?.messages).toHaveLength(2);
    expect(rest?.hasMore).toBe(false);
  });
});

describe('commit-ordered chat cursors', () => {
  it('does not skip a delayed old-timestamp row after a full-page backlog and >15 seconds', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const seen = await post(conversationId, 'user', 'cursor baseline');
    const backlog = [];
    for (let index = 0; index < 6; index += 1) {
      backlog.push(await post(conversationId, 'assistant', `backlog ${index.toString()}`));
    }

    const first = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
      pageSize: 2,
    });
    expect(first?.messages.map((message) => message.id)).toEqual(
      backlog.slice(0, 2).map((row) => row.id),
    );
    expect(first?.hasMore).toBe(true);

    let beginHeld!: () => void;
    let releaseHeld!: () => void;
    const heldStarted = new Promise<void>((resolve) => (beginHeld = resolve));
    const heldGate = new Promise<void>((resolve) => (releaseHeld = resolve));
    const lateTimestamp = new Date('2020-01-01T00:00:00.000Z');
    let delayedId = '';
    const heldInsert = db.transaction(async (tx) => {
      const [delayed] = await tx
        .insert(messages)
        .values({
          conversationId,
          role: 'assistant',
          origin: 'assistant',
          parts: [{ type: 'text', text: 'delayed commit' }],
          text: 'delayed commit',
          createdAt: lateTimestamp,
        })
        .returning();
      delayedId = delayed?.id ?? '';
      beginHeld();
      await heldGate;
    });

    await heldStarted;
    const delivered = first?.messages.map((message) => message.id) ?? [];
    let cursor = first?.nextCursor ?? undefined;
    try {
      // The transaction remains open past the former 15-second safety window.
      await new Promise((resolve) => setTimeout(resolve, 15_100));
      let page = await getChatUpdates(db, { conversationId, cursor, pageSize: 2 });
      while (page?.hasMore) {
        delivered.push(...page.messages.map((message) => message.id));
        cursor = page.nextCursor ?? undefined;
        page = await getChatUpdates(db, { conversationId, cursor, pageSize: 2 });
      }
      delivered.push(...(page?.messages.map((message) => message.id) ?? []));
      cursor = page?.nextCursor ?? cursor;
      expect(new Set(delivered).size).toBe(delivered.length);
      expect(delivered).toEqual(backlog.map((row) => row.id));
    } finally {
      releaseHeld();
    }
    await heldInsert;

    const afterCommit = await getChatUpdates(db, { conversationId, cursor, pageSize: 2 });
    expect(afterCommit?.messages).toHaveLength(1);
    expect(afterCommit?.messages[0]?.id).toBe(delayedId);
    const replay = await getChatUpdates(db, {
      conversationId,
      cursor: afterCommit?.nextCursor ?? undefined,
      pageSize: 2,
    });
    expect(replay?.messages).toEqual([]);
  }, 30_000);

  it('replays a legacy timestamp cursor into the append-order stream', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const legacy = await post(conversationId, 'user', 'legacy client cursor');
    const later = await post(conversationId, 'assistant', 'new append');
    const updates = await getChatUpdates(db, {
      conversationId,
      cursor: `${legacy.createdAt.toISOString()}|${legacy.id}`,
    });
    expect(updates?.messages.map((message) => message.id)).toContain(later.id);
    expect(updates?.nextCursor).toMatch(/^v2\|\d{20}\|/);
  });
});

describe('refreshing decision cards already on screen', () => {
  it('re-reads named rows without counting them as new output', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const card = await post(conversationId, 'assistant', 'This needs your approval before I act:', {
      parts: [
        { type: 'text', text: 'This needs your approval before I act:' },
        { type: 'approval', approvalId: MISSING_ID, shortCode: 'A19CG', summary: 'Send the email' },
      ],
    });

    const updates = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(card),
      refreshIds: [card.id],
    });
    // The row the caller already has comes back under `refreshed`, hydrated —
    // never under `messages`, which is what tells the client a turn produced an
    // answer.
    expect(updates?.messages).toEqual([]);
    expect(updates?.refreshed.map((message) => message.id)).toEqual([card.id]);
    const parts = (updates?.refreshed[0]?.parts ?? []) as Array<{
      type: string;
      status?: string;
    }>;
    expect(parts.find((part) => part.type === 'approval')?.status).toBe('missing');
  });

  it('ignores ids that are not this conversation’s', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const elsewhere = await post(await newChat(), 'assistant', 'not yours');
    const updates = await getChatUpdates(db, { conversationId, refreshIds: [elsewhere.id] });
    expect(updates?.refreshed).toEqual([]);
  });
});

describe('superseding runtime rows an open client is already showing', () => {
  // Read-time collapse only sees the rows in one fetch. When the older twin of
  // a state row was delivered by an earlier tick it sits behind the cursor, so
  // the page never contains it and a merge-by-id client would show both until
  // the next full load. The poll therefore names those losers in `superseded`.
  const T0 = new Date('2026-08-26T08:00:00.000Z');
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

  it('retracts the earlier state row when a retry re-emits it newer', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const taskId = await newTask(conversationId);
    const stale = await post(
      conversationId,
      'assistant',
      "I couldn't complete this after repeated attempts and stopped. Last error: 2302 tokens",
      { taskId, createdAt: at(0) },
    );
    // The open client has this row; its cursor has moved past it.
    const cursor = encodeMessageCursor(stale);
    const retried = await post(
      conversationId,
      'assistant',
      "I couldn't complete this after repeated attempts and stopped. Last error: 2277 tokens",
      {
        taskId,
        createdAt: at(60),
        parts: [
          {
            type: 'text',
            text: "I couldn't complete this after repeated attempts and stopped. Last error: 2277 tokens",
          },
          { type: 'notice', notice: 'needs-attention' },
        ],
      },
    );

    const updates = await getChatUpdates(db, { conversationId, cursor });
    expect(updates?.messages.map((message) => message.id)).toEqual([retried.id]);
    expect(updates?.superseded).toEqual([stale.id]);
  });

  it('never delivers an approval nudge whose card the client already has', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const taskId = await newTask(conversationId);
    const card = await post(conversationId, 'assistant', 'This needs your approval before I act:', {
      taskId,
      createdAt: at(0),
      parts: [
        { type: 'text', text: 'This needs your approval before I act:' },
        { type: 'approval', approvalId: MISSING_ID, shortCode: 'A7', summary: 'Search the web' },
      ],
    });
    // The card went out on an earlier tick; only the nudge lands in this one.
    // Collapsing the page alone cannot see the card behind the cursor.
    const nudge = await post(
      conversationId,
      'assistant',
      'Something needs your approval:\nA7: Search the web',
      { taskId, createdAt: at(30) },
    );

    const updates = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(card),
    });
    expect(updates?.messages).toEqual([]);
    // The card is the family winner — it stays up; nothing names it for removal.
    expect(updates?.superseded).toEqual([]);
    expect(nudge).toBeDefined();
  });

  it('leaves ordinary conversation untouched and empty-handed', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const seen = await post(conversationId, 'user', 'hello', { createdAt: at(0) });
    const reply = await post(conversationId, 'assistant', 'hi there', { createdAt: at(1) });

    const updates = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
    });
    expect(updates?.messages.map((message) => message.id)).toEqual([reply.id]);
    expect(updates?.superseded).toEqual([]);
  });
});

describe('hideChatMessage / unhideChatMessage', () => {
  const T0 = new Date('2026-09-01T09:00:00.000Z');
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

  it('hides a message from the update poll and puts it back', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const seen = await post(conversationId, 'user', 'ignore this one', { createdAt: at(0) });
    const junk = await post(conversationId, 'assistant', 'a wrong answer', { createdAt: at(1) });

    expect(await hideChatMessage(db, conversationId, junk.id)).toBe(true);
    const hidden = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
    });
    // A wrong answer that stays in the update feed would keep steering the
    // owner (and, via listMessages, the model) after they asked to hide it.
    expect(hidden?.messages.map((message) => message.id)).toEqual([]);

    expect(await unhideChatMessage(db, conversationId, junk.id)).toBe(true);
    const restored = await getChatUpdates(db, {
      conversationId,
      cursor: encodeMessageCursor(seen),
    });
    expect(restored?.messages.map((message) => message.id)).toEqual([junk.id]);
  });

  it('reports false for a message id outside the chat, never touching it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const conversationId = await newChat();
    const otherConversationId = await newChat();
    const outside = await post(otherConversationId, 'assistant', 'not yours', {
      createdAt: at(0),
    });

    expect(await hideChatMessage(db, conversationId, outside.id)).toBe(false);
  });

  it('rejects a chat the caller does not own', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await expect(
      hideChatMessage(db, '11111111-1111-4111-8111-111111111111', MISSING_ID),
    ).rejects.toThrow('chat not found');
  });
});
