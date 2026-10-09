import {
  conversations,
  createDb,
  createPostgresMessageRepository,
  createPostgresTaskRepository,
  createPostgresWatchRepository,
  type Db,
  messages,
  tasks,
  watches,
  watchFireEffects,
  watchFires,
} from '@assistant/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { noopOwnerNotifier } from '../platform.js';
import { matchEmailWatches, reapExpiredWatches, type WatchesDeps } from './email-watches.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const RUN = `Xtest-Watch-${Date.now()}`;
const NOW = new Date('2026-07-18T12:00:00.000Z');

let db: Db;
let dbUp = false;
let agentId: string;
let deps: WatchesDeps;

interface WatchInput {
  senders?: string[];
  keywords?: string[];
  maxFires?: number | null;
  expiresAt?: Date;
  tier?: 'notify' | 'suggest';
}

async function createEmailWatch(name: string, input: WatchInput = {}) {
  const [conversation] = await db
    .insert(conversations)
    .values({ agentId, channel: 'chat', trust: 'owner', title: `${RUN} ${name}` })
    .returning();
  if (!conversation) throw new Error('conversation insert failed');
  const [watch] = await db
    .insert(watches)
    .values({
      agentId,
      conversationId: conversation.id,
      kind: 'email',
      tier: input.tier ?? 'notify',
      name: `${RUN} ${name}`,
      match: {
        expectedSenderEmails: input.senders ?? ['recruiter@acme.example'],
        ...(input.keywords ? { keywords: input.keywords } : {}),
      },
      maxFires: input.maxFires ?? null,
      expiresAt: input.expiresAt ?? new Date(NOW.getTime() + 30 * 24 * 60 * 60_000),
    })
    .returning();
  if (!watch) throw new Error('watch insert failed');
  return { watch, conversationId: conversation.id };
}

function email(overrides: Partial<Parameters<typeof matchEmailWatches>[1]> = {}) {
  return {
    agentId,
    messageId: `${RUN}-msg-1`,
    from: 'recruiter@acme.example',
    subject: 'Your interview',
    body: 'Details inside.',
    authenticated: true,
    now: NOW,
    ...overrides,
  };
}

async function fireCountFor(watchId: string) {
  const [row] = await db.select().from(watches).where(eq(watches.id, watchId));
  const fires = await db.select().from(watchFires).where(eq(watchFires.watchId, watchId));
  return { status: row?.status, fireCount: row?.fireCount, fires: fires.length };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db.query.agents.findMany({ limit: 1 });
    if (!agent) throw new Error('unseeded');
    agentId = agent.id;
    deps = {
      watches: createPostgresWatchRepository(db),
      messages: createPostgresMessageRepository(db),
      tasks: createPostgresTaskRepository(db),
      notifyOwner: noopOwnerNotifier.notifyOwner,
    };
    dbUp = true;
  } catch {
    console.warn('watches.e2e: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (!dbUp) return;
  const rows = await db
    .select({ id: watches.id })
    .from(watches)
    .where(like(watches.name, `${RUN}%`));
  const ids = rows.map((row) => row.id);
  if (ids.length) await db.delete(watchFires).where(inArray(watchFires.watchId, ids));
  for (const id of ids) {
    await db.delete(tasks).where(like(tasks.externalEventId, `watch-suggest:${id}:%`));
  }
  const convos = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(like(conversations.title, `${RUN}%`));
  const convoIds = convos.map((row) => row.id);
  if (convoIds.length) await db.delete(messages).where(inArray(messages.conversationId, convoIds));
  await db.delete(watches).where(like(watches.name, `${RUN}%`));
  await db.delete(conversations).where(like(conversations.title, `${RUN}%`));
});

describe('inbox watchers (notify tier)', () => {
  it('fires once on an authenticated match and posts a notice', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch, conversationId } = await createEmailWatch('basic', { keywords: ['interview'] });
    const result = await matchEmailWatches(deps, email());
    expect(result.fired).toContain(watch.id);

    const state = await fireCountFor(watch.id);
    expect(state).toMatchObject({ status: 'active', fireCount: 1, fires: 1 });

    const notices = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.origin, 'assistant')));
    expect(notices.length).toBe(1);
    expect(notices[0]?.text).toContain('basic');
  });

  it('does not double-fire when the same message is replayed', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch } = await createEmailWatch('replay', { keywords: ['interview'] });
    await matchEmailWatches(deps, email({ messageId: `${RUN}-replay` }));
    await matchEmailWatches(deps, email({ messageId: `${RUN}-replay` }));
    expect(await fireCountFor(watch.id)).toMatchObject({ fireCount: 1, fires: 1 });
  });

  it('replays a failed dashboard leg independently after the watch reached maxFires', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch, conversationId } = await createEmailWatch('outbox-retry', { maxFires: 1 });
    const trigger = `${RUN}-outbox-retry`;
    await matchEmailWatches(deps, email({ messageId: trigger }));
    const [fire] = await db.select().from(watchFires).where(eq(watchFires.watchId, watch.id));
    if (!fire) throw new Error('fire fixture missing');
    const [noticeEffect] = await db
      .select()
      .from(watchFireEffects)
      .where(
        and(eq(watchFireEffects.fireId, fire.id), eq(watchFireEffects.kind, 'dashboard_notice')),
      );
    if (!noticeEffect) throw new Error('notice effect fixture missing');
    await db
      .update(watchFireEffects)
      .set({ status: 'failed' })
      .where(eq(watchFireEffects.id, noticeEffect.id));

    // The owning watch is exhausted, but the event outbox remains retryable.
    await matchEmailWatches(deps, email({ messageId: trigger }));
    const [replayed] = await db
      .select()
      .from(watchFireEffects)
      .where(eq(watchFireEffects.id, noticeEffect.id));
    const noticeRows = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.channelMessageId, `watch-fire:${watch.id}:${trigger}`),
        ),
      );
    expect(replayed?.status, JSON.stringify(replayed?.result)).toBe('delivered');
    expect(noticeRows).toHaveLength(1);
    expect(await fireCountFor(watch.id)).toMatchObject({ status: 'fired', fireCount: 1, fires: 1 });
  });

  it('marks an expired owner-notification claim unknown instead of resending it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch } = await createEmailWatch('outbox-unknown');
    await matchEmailWatches(deps, email({ messageId: `${RUN}-outbox-unknown` }));
    const [fire] = await db.select().from(watchFires).where(eq(watchFires.watchId, watch.id));
    if (!fire) throw new Error('fire fixture missing');
    const [ownerEffect] = await db
      .select()
      .from(watchFireEffects)
      .where(
        and(eq(watchFireEffects.fireId, fire.id), eq(watchFireEffects.kind, 'owner_notification')),
      );
    if (!ownerEffect) throw new Error('notification effect fixture missing');
    const claimedAt = new Date(NOW.getTime() + 1000);
    await db
      .update(watchFireEffects)
      .set({ status: 'sending', claimedAt, leaseUntil: new Date(claimedAt.getTime() + 1000) })
      .where(eq(watchFireEffects.id, ownerEffect.id));
    await deps.watches.recoverExpiredFireEffectClaims(
      agentId,
      new Date(claimedAt.getTime() + 2000),
    );
    const [recovered] = await db
      .select()
      .from(watchFireEffects)
      .where(eq(watchFireEffects.id, ownerEffect.id));
    expect(recovered?.status).toBe('unknown');
    expect(await deps.watches.pendingFireEffects(agentId)).not.toContainEqual(
      expect.objectContaining({ id: ownerEffect.id }),
    );
  });

  it('ignores unauthenticated mail and senders the owner never named', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch } = await createEmailWatch('gated', { keywords: ['interview'] });
    await matchEmailWatches(deps, email({ messageId: `${RUN}-unauth`, authenticated: false }));
    await matchEmailWatches(
      deps,
      email({ messageId: `${RUN}-wrong`, from: 'stranger@nowhere.example' }),
    );
    expect(await fireCountFor(watch.id)).toMatchObject({ fireCount: 0, fires: 0 });
  });

  it('exhausts a bounded watch after maxFires and stops firing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch } = await createEmailWatch('bounded', { maxFires: 1 });
    await matchEmailWatches(deps, email({ messageId: `${RUN}-b1` }));
    const afterFirst = await fireCountFor(watch.id);
    expect(afterFirst).toMatchObject({ status: 'fired', fireCount: 1 });
    // A second, distinct message must not fire an exhausted watch.
    await matchEmailWatches(deps, email({ messageId: `${RUN}-b2` }));
    expect(await fireCountFor(watch.id)).toMatchObject({ fireCount: 1 });
  });

  it('reaps an expired watch and never fires it late', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch } = await createEmailWatch('expired', {
      keywords: ['interview'],
      expiresAt: new Date(NOW.getTime() - 60_000),
    });
    const reaped = await reapExpiredWatches(deps, NOW);
    expect(reaped).toBeGreaterThanOrEqual(1);
    await matchEmailWatches(deps, email({ messageId: `${RUN}-late` }));
    expect(await fireCountFor(watch.id)).toMatchObject({ status: 'expired', fireCount: 0 });
  });
});

describe('inbox watchers (suggest tier)', () => {
  it('stores a bounded excerpt and hands the fire to the suggest job', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { watch } = await createEmailWatch('suggestive', { tier: 'suggest' });
    const result = await matchEmailWatches(
      deps,
      email({ messageId: `${RUN}-suggest`, body: 'Can you do Thursday? '.repeat(400) }),
    );
    expect(result.fired).toContain(watch.id);

    const [fire] = await db.select().from(watchFires).where(eq(watchFires.watchId, watch.id));
    // Bounded at write time: the compose step never sees more than this.
    expect(fire?.excerpt.length).toBeLessThanOrEqual(2048);
    expect(fire?.excerpt).toContain('Subject: Your interview');

    const [job] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalEventId, `watch-suggest:${watch.id}:${RUN}-suggest`));
    expect(job?.type).toBe('adhoc');
    expect((job?.trigger as { payload?: { job?: string } } | null)?.payload?.job).toBe(
      'watch.suggest',
    );

    // A replayed message enqueues nothing twice.
    await matchEmailWatches(deps, email({ messageId: `${RUN}-suggest` }));
    const jobs = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalEventId, `watch-suggest:${watch.id}:${RUN}-suggest`));
    expect(jobs).toHaveLength(1);
  });

  it('keeps the plain notice behavior: one heads-up, no model in the fire path', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { conversationId } = await createEmailWatch('suggest-notice', {
      tier: 'suggest',
    });
    await matchEmailWatches(deps, email({ messageId: `${RUN}-sn` }));
    const notices = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.origin, 'assistant')));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain('suggest-notice');
  });
});
