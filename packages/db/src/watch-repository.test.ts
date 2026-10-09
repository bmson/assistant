import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import {
  agents,
  conversations,
  suggestions,
  watches,
  watchFireEffects,
  watchFires,
} from './schema.js';
import { createPostgresWatchRepository } from './watch-repository.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://assistant@127.0.0.1:55432/assistant_test';

describe('PostgreSQL watch repository suggestions', () => {
  let db: Db;
  const ownerId = randomUUID();
  const foreignId = randomUUID();

  it('lets a queued cancellation win before a blocked fire without resurrecting the watch', async () => {
    const repository = createPostgresWatchRepository(db);
    const now = new Date();
    const watch = await repository.create({
      agentId: ownerId,
      kind: 'email',
      tier: 'notify',
      name: 'Lock race',
      match: { expectedSenderEmails: ['sender@example.com'] },
      maxFires: null,
      expiresAt: new Date(now.getTime() + 86400000),
    });
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(watches).where(eq(watches.id, watch.id)).for('update');
      locked();
      await hold;
    });
    await ready;
    const cancellation = repository.cancel(ownerId, watch.id, now);
    try {
      let queued = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await db.execute<{ waiting: boolean }>(
          sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event='transactionid' and query like 'update "watches"%') as waiting`,
        );
        if (rows[0]?.waiting) {
          queued = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(queued).toBe(true);
      const firing = repository.recordFire({
        agentId: ownerId,
        watchId: watch.id,
        triggerRef: 'cancel-race',
        summary: 'Race',
        excerpt: 'Race',
        now,
      });
      let fireQueued = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await db.execute<{ count: number }>(
          sql`select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event in ('transactionid', 'tuple') and query like '%"watches"%'`,
        );
        if ((rows[0]?.count ?? 0) >= 2) {
          fireQueued = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(fireQueued).toBe(true);
      release();
      await holder;
      expect(await cancellation).toEqual({ status: 'cancelled', cancelled: true });
      expect(await firing).toMatchObject({ recorded: false, watch: { status: 'cancelled' } });
      expect(await db.select().from(watchFires).where(eq(watchFires.watchId, watch.id))).toEqual(
        [],
      );
      expect((await db.select().from(watches).where(eq(watches.id, watch.id)))[0]?.status).toBe(
        'cancelled',
      );
    } finally {
      release();
      await holder;
      await cancellation;
    }
  });

  beforeEach(async () => {
    db = createDb(DATABASE_URL);
    await db.insert(agents).values([
      {
        id: ownerId,
        name: 'Watch owner',
        email: `${ownerId}@example.com`,
        workspacePrefix: `workspace/${ownerId}`,
      },
      {
        id: foreignId,
        name: 'Foreign owner',
        email: `${foreignId}@example.com`,
        workspacePrefix: `workspace/${foreignId}`,
      },
    ]);
  });

  afterEach(async () => {
    await db.delete(suggestions).where(eq(suggestions.agentId, ownerId));
    await db
      .delete(watchFireEffects)
      .where(inArray(watchFireEffects.agentId, [ownerId, foreignId]));
    await db.delete(watchFires).where(eq(watchFires.agentId, ownerId));
    await db.delete(watches).where(eq(watches.agentId, ownerId));
    await db.delete(conversations).where(inArray(conversations.agentId, [ownerId, foreignId]));
    await db.delete(agents).where(inArray(agents.id, [ownerId, foreignId]));
    await db.$client.end();
  });

  it('serializes identical commits and never returns a foreign conversation', async () => {
    const repository = createPostgresWatchRepository(db);
    const now = new Date('2026-09-19T12:00:00Z');
    const watch = await repository.create({
      agentId: ownerId,
      kind: 'email',
      tier: 'suggest',
      name: 'Suggestion race',
      match: {},
      maxFires: null,
      expiresAt: new Date('2026-09-20T12:00:00Z'),
    });
    const [foreign] = await db
      .insert(conversations)
      .values({ agentId: foreignId, channel: 'chat', trust: 'owner', title: 'Foreign' })
      .returning({ id: conversations.id });
    if (!foreign) throw new Error('foreign conversation fixture failed');
    await db.update(watches).set({ conversationId: foreign.id }).where(eq(watches.id, watch.id));
    await repository.recordFire({
      watchId: watch.id,
      agentId: ownerId,
      triggerRef: 'gmail:race',
      summary: 'race',
      excerpt: 'reply requested',
      now,
    });
    const input = {
      agentId: ownerId,
      watchId: watch.id,
      triggerRef: 'gmail:race',
      summary: 'Reply?',
      proposedAction: 'Draft a reply.',
      now,
    };
    const results = await Promise.all([
      repository.commitSuggestion(input),
      repository.commitSuggestion(input),
    ]);

    expect(results[0]?.suggestion.id).toBe(results[1]?.suggestion.id);
    expect(results[0]?.conversationId).not.toBe(foreign.id);
    const [destination] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, results[0]?.conversationId ?? ''));
    expect(destination).toMatchObject({ agentId: ownerId, title: 'Notifications' });
    expect(
      await db.select().from(suggestions).where(eq(suggestions.agentId, ownerId)),
    ).toHaveLength(1);
    expect(await db.select().from(watchFires).where(eq(watchFires.watchId, watch.id))).toHaveLength(
      1,
    );
  });
});
