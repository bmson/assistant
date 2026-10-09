import {
  conversations,
  createDb,
  type Db,
  messages,
  suggestions,
  tasks,
  watches,
  watchFireEffects,
  watchFires,
} from '@assistant/db';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { ModelRouter } from '../model-router/router.js';
import { acceptSuggestion } from './suggestions.js';
import { runWatchSuggest } from './watch-suggest.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-watch-suggest-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
let conversationId: string;
let watchId: string;
const acceptedTaskIds: string[] = [];

/** Answers the compose step with a fixed draft (or a "nothing" verdict). */
function fakeRouter(draft: { worthSuggesting: boolean; summary: string; proposedAction: string }) {
  return {
    async object() {
      return { ok: true, modelId: 'fake', degraded: false, object: draft };
    },
  } as unknown as ModelRouter;
}

const GOOD_DRAFT = {
  worthSuggesting: true,
  summary: `${MARKER} The recruiter wrote back about Thursday — propose two times?`,
  proposedAction: `Draft a reply to the recruiter proposing two Thursday times. Context: ${MARKER}.`,
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('watch-suggest.test: database unreachable — skipping');
    return;
  }
  const [conv] = await db
    .insert(conversations)
    .values({ agentId, channel: 'chat', trust: 'owner', title: `${MARKER} thread` })
    .returning();
  if (!conv) throw new Error('conversation fixture failed');
  conversationId = conv.id;
  const [watch] = await db
    .insert(watches)
    .values({
      agentId,
      conversationId,
      kind: 'email',
      tier: 'suggest',
      name: `${MARKER} watch`,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    })
    .returning();
  if (!watch) throw new Error('watch fixture failed');
  watchId = watch.id;
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(suggestions).where(like(suggestions.sourceRef, `watch:${watchId}:%`));
    await db.delete(watchFireEffects).where(eq(watchFireEffects.agentId, agentId));
    await db.delete(watchFires).where(eq(watchFires.watchId, watchId));
    await db.delete(watches).where(eq(watches.id, watchId));
    if (acceptedTaskIds.length) {
      await db.delete(tasks).where(inArray(tasks.id, acceptedTaskIds));
    }
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

async function addFire(triggerRef: string, excerpt = 'Body text the trigger carried.') {
  const [fire] = await db
    .insert(watchFires)
    .values({ watchId, agentId, triggerRef, summary: 'heads-up', excerpt })
    .returning({ id: watchFires.id });
  if (!fire) throw new Error('fire fixture failed');
  return fire.id;
}

describe('runWatchSuggest', () => {
  it('drafts one inert suggestion and surfaces it as a card in the watch thread', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addFire('gmail:msg-a');
    const result = await runWatchSuggest(
      { db, router: fakeRouter(GOOD_DRAFT) },
      { agentId, watchId, triggerRef: 'gmail:msg-a' },
    );
    expect(result.suggested).toBe(true);

    // The proposal is a row of text: nothing queued, nothing frozen.
    const [row] = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.sourceRef, `watch:${watchId}:gmail:msg-a`));
    expect(row?.origin).toBe('watch');
    expect(row?.status).toBe('pending');
    expect(row?.acceptedTaskId).toBeNull();

    const posted = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(posted).toHaveLength(1);
    const parts = (posted[0]?.parts ?? []) as Array<{ type?: string; suggestionId?: string }>;
    expect(parts.some((part) => part.type === 'suggestion' && part.suggestionId === row?.id)).toBe(
      true,
    );
  });

  it('converges on exactly one card across a redelivery retry', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Same trigger as the previous test: re-running proposes nothing twice
    // and posts no second message — the sourceRef and channelMessageId fences.
    let modelCalled = false;
    const retryRouter = {
      async object() {
        modelCalled = true;
        throw new Error('changed retry model verdict');
      },
    } as unknown as ModelRouter;
    const result = await runWatchSuggest(
      { db, router: retryRouter },
      { agentId, watchId, triggerRef: 'gmail:msg-a' },
    );
    const posted = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(posted).toHaveLength(1);
    expect(result.suggested).toBe(true);
    expect(modelCalled).toBe(false);
  });

  it('recovers an atomically prepared proposal after a crash before message append', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const triggerRef = 'gmail:msg-crash-before-append';
    const fireId = await addFire(triggerRef);
    const { createPostgresWatchRepository } = await import('@assistant/db');
    const committed = await createPostgresWatchRepository(db).commitSuggestion({
      agentId,
      watchId,
      triggerRef,
      summary: GOOD_DRAFT.summary,
      proposedAction: GOOD_DRAFT.proposedAction,
    });
    if (!committed) throw new Error('suggestion fixture failed');
    expect(
      await db
        .select()
        .from(messages)
        .where(eq(messages.channelMessageId, `watch-suggest:${fireId}`)),
    ).toHaveLength(0);

    let modelCalled = false;
    const result = await runWatchSuggest(
      {
        db,
        router: {
          async object() {
            modelCalled = true;
            throw new Error('model unavailable after restart');
          },
        } as unknown as ModelRouter,
      },
      { agentId, watchId, triggerRef },
    );
    expect(result.suggested).toBe(true);
    expect(modelCalled).toBe(false);
    expect(
      await db
        .select()
        .from(messages)
        .where(eq(messages.channelMessageId, `watch-suggest:${fireId}`)),
    ).toHaveLength(1);
  });

  it('does not surface a committed suggestion accepted before its message leg runs', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const triggerRef = 'gmail:msg-accepted-before-delivery';
    await addFire(triggerRef);
    const { createPostgresWatchRepository } = await import('@assistant/db');
    const repository = createPostgresWatchRepository(db);
    const committed = await repository.commitSuggestion({
      agentId,
      watchId,
      triggerRef,
      summary: `${MARKER} already accepted`,
      proposedAction: `Do the accepted work. ${MARKER}`,
    });
    if (!committed) throw new Error('suggestion fixture failed');
    const accepted = await acceptSuggestion(db, committed.suggestion.id);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) acceptedTaskIds.push(accepted.taskId);

    let modelCalled = false;
    const result = await runWatchSuggest(
      {
        db,
        router: {
          async object() {
            modelCalled = true;
            throw new Error('must not recompose an existing proposal');
          },
        } as unknown as ModelRouter,
      },
      { agentId, watchId, triggerRef },
    );
    expect(result.suggested).toBe(false);
    expect(modelCalled).toBe(false);
    const posted = await db
      .select()
      .from(messages)
      .where(eq(messages.channelMessageId, `watch-suggest:${committed.fireId}`));
    expect(posted).toHaveLength(0);
  });

  it('proposes nothing when the composer sees no concrete next step', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addFire('gmail:msg-b');
    const result = await runWatchSuggest(
      {
        db,
        router: fakeRouter({ worthSuggesting: false, summary: '', proposedAction: '' }),
      },
      { agentId, watchId, triggerRef: 'gmail:msg-b' },
    );
    expect(result.suggested).toBe(false);
    const [row] = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.sourceRef, `watch:${watchId}:gmail:msg-b`));
    expect(row).toBeUndefined();
  });

  it('completes benignly when the fire has no excerpt', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addFire('gmail:msg-c', '');
    const result = await runWatchSuggest(
      { db, router: fakeRouter(GOOD_DRAFT) },
      { agentId, watchId, triggerRef: 'gmail:msg-c' },
    );
    expect(result.suggested).toBe(false);
  });

  it('acceptance runs the normal pipeline, tainted by its origin', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [row] = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.sourceRef, `watch:${watchId}:gmail:msg-a`));
    if (!row) throw new Error('the first test did not leave its suggestion');
    const outcome = await acceptSuggestion(db, row.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    acceptedTaskIds.push(outcome.taskId);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, outcome.taskId));
    // The proposal was written from a third party's email — the accepted work
    // starts tainted, so its outward calls still stop for approval.
    const trigger = task?.trigger as {
      payload?: { taintedOrigin?: unknown; instruction?: unknown };
    } | null;
    expect(trigger?.payload?.taintedOrigin).toBe(true);
    expect(String(trigger?.payload?.instruction ?? '')).toContain(MARKER);
  });
});
