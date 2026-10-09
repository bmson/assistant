import {
  conversations,
  createDb,
  createPostgresMessageRepository,
  createPostgresWatchRepository,
  type Db,
  messages,
  watches,
  watchFires,
} from '@assistant/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WatchFireDeps } from './fire.js';
import { pollDueWebWatches, type WebWatchFetch } from './web-watches.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const RUN = `Xtest-WebPoll-${Date.now()}`;
const T0 = new Date('2026-07-18T12:00:00.000Z');
const at = (secondsFromT0: number) => new Date(T0.getTime() + secondsFromT0 * 1000);

let db: Db;
let dbUp = false;
let agentId: string;
const notices: string[] = [];
let deps: WatchFireDeps;

/** A fetch whose pages and failures the test controls. */
function makeFetch(pages: Map<string, string>, fail = new Set<string>()): WebWatchFetch {
  return async (url) => {
    if (fail.has(url)) throw new Error(`boom ${url}`);
    return { text: pages.get(url) ?? '', finalUrl: url };
  };
}

interface WebWatchInput {
  url: string;
  mode?: 'change' | 'contains' | 'absent';
  pattern?: string;
  nextPollAt?: Date;
  intervalSeconds?: number;
  maxFires?: number | null;
}

async function createWebWatch(name: string, input: WebWatchInput) {
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
      kind: 'web',
      tier: 'notify',
      name: `${RUN} ${name}`,
      match: { url: input.url, mode: input.mode ?? 'change', pattern: input.pattern },
      maxFires: input.maxFires ?? null,
      nextPollAt: input.nextPollAt ?? T0,
      pollIntervalSeconds: input.intervalSeconds ?? 60,
      state: {},
      expiresAt: new Date(T0.getTime() + 30 * 24 * 60 * 60_000),
    })
    .returning();
  if (!watch) throw new Error('watch insert failed');
  return watch;
}

async function stateOf(watchId: string) {
  const [row] = await db.select().from(watches).where(eq(watches.id, watchId));
  const fires = await db.select().from(watchFires).where(eq(watchFires.watchId, watchId));
  return {
    status: row?.status,
    fireCount: row?.fireCount,
    fires: fires.length,
    state: row?.state as { fingerprint?: string; present?: boolean; failures?: number },
    nextPollAt: row?.nextPollAt,
  };
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
      notifyOwner: async ({ text }) => {
        notices.push(text);
      },
    };
    dbUp = true;
  } catch {
    console.warn('web-watches.e2e: database unreachable — skipping');
  }
});

// The poller polls EVERY due web watch (single-agent system), so a watch left
// active by one test would be re-polled by the next. Cancel each test's watches
// between cases; assertions target a specific watchId to stay independent of any
// other rows that a concurrent test file may have active.
afterEach(async () => {
  if (!dbUp) return;
  await db
    .update(watches)
    .set({ status: 'cancelled' })
    .where(and(like(watches.name, `${RUN}%`), eq(watches.status, 'active')));
});

afterAll(async () => {
  if (!dbUp) return;
  const rows = await db
    .select({ id: watches.id })
    .from(watches)
    .where(like(watches.name, `${RUN}%`));
  const ids = rows.map((r) => r.id);
  if (ids.length) await db.delete(watchFires).where(inArray(watchFires.watchId, ids));
  const convos = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(like(conversations.title, `${RUN}%`));
  const convoIds = convos.map((r) => r.id);
  if (convoIds.length) await db.delete(messages).where(inArray(messages.conversationId, convoIds));
  await db.delete(watches).where(like(watches.name, `${RUN}%`));
  await db.delete(conversations).where(like(conversations.title, `${RUN}%`));
});

describe('web watch polling', () => {
  it('records a baseline on the first poll and does not fire', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const watch = await createWebWatch('baseline', { url: 'https://ex.test/a' });
    const pages = new Map([['https://ex.test/a', 'version one']]);
    await pollDueWebWatches(deps, { now: T0, fetch: makeFetch(pages) });
    const s = await stateOf(watch.id);
    expect(s).toMatchObject({ status: 'active', fireCount: 0, fires: 0 });
    expect(s.state.fingerprint).toBeTruthy();
    // The claim advanced nextPollAt past T0.
    expect(s.nextPollAt?.getTime()).toBeGreaterThan(T0.getTime());
  });

  it('fires exactly once when the page changes, and not when it is stable', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const watch = await createWebWatch('change', { url: 'https://ex.test/b', intervalSeconds: 60 });
    const pages = new Map([['https://ex.test/b', 'v1']]);
    await pollDueWebWatches(deps, { now: T0, fetch: makeFetch(pages) }); // baseline
    expect((await stateOf(watch.id)).fires).toBe(0);

    pages.set('https://ex.test/b', 'v2');
    await pollDueWebWatches(deps, { now: at(300), fetch: makeFetch(pages) });
    expect((await stateOf(watch.id)).fires).toBe(1);

    // Unchanged content on the next due poll must not re-fire.
    await pollDueWebWatches(deps, { now: at(600), fetch: makeFetch(pages) });
    expect(await stateOf(watch.id)).toMatchObject({ fireCount: 1, fires: 1 });
  });

  it('does not poll a watch that is not yet due, and claims a due one only once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const notDue = await createWebWatch('future', {
      url: 'https://ex.test/c',
      nextPollAt: at(10_000),
    });
    await pollDueWebWatches(deps, {
      now: T0,
      fetch: makeFetch(new Map([['https://ex.test/c', 'x']])),
    });
    // Not due → never observed, so no baseline was recorded.
    expect((await stateOf(notDue.id)).state.fingerprint).toBeUndefined();

    // A due watch is claimed once: its nextPollAt is bumped past `now`, so a
    // second poll at the same instant leaves its state untouched.
    const dueOnce = await createWebWatch('due-once', { url: 'https://ex.test/d' });
    await pollDueWebWatches(deps, {
      now: at(20_000),
      fetch: makeFetch(new Map([['https://ex.test/d', 'y']])),
    });
    const afterFirst = await stateOf(dueOnce.id);
    expect(afterFirst.state.fingerprint).toBeTruthy();
    await pollDueWebWatches(deps, {
      now: at(20_000),
      fetch: makeFetch(new Map([['https://ex.test/d', 'y']])),
    });
    const afterSecond = await stateOf(dueOnce.id);
    expect(afterSecond.nextPollAt?.getTime()).toBe(afterFirst.nextPollAt?.getTime());
  });

  it('fires a contains watch on the absent → present transition', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const watch = await createWebWatch('contains', {
      url: 'https://ex.test/e',
      mode: 'contains',
      pattern: 'in stock',
      intervalSeconds: 60,
    });
    const pages = new Map([['https://ex.test/e', 'Sold out']]);
    await pollDueWebWatches(deps, { now: T0, fetch: makeFetch(pages) }); // baseline, absent
    expect((await stateOf(watch.id)).fires).toBe(0);

    pages.set('https://ex.test/e', 'Great news — In Stock now!');
    await pollDueWebWatches(deps, { now: at(300), fetch: makeFetch(pages) });
    expect((await stateOf(watch.id)).fires).toBe(1);
  });

  it.for(['change', 'contains'] as const)(
    'admits repeated %s cycles without repeating a claimed poll',
    async (mode, ctx) => {
      if (!dbUp) return ctx.skip();
      const watch = await createWebWatch('repeated-cycle', {
        url: 'https://ex.test/repeat',
        mode,
        pattern: 'in stock',
        intervalSeconds: 60,
      });
      const pages = new Map([['https://ex.test/repeat', 'Sold out']]);
      const before = notices.length;
      await pollDueWebWatches(deps, { now: T0, fetch: makeFetch(pages) });
      for (const [minute, text] of [
        [5, 'In stock'],
        [10, 'Sold out'],
        [15, 'In stock'],
      ] as const) {
        pages.set('https://ex.test/repeat', text);
        const options = { now: at(minute * 60), fetch: makeFetch(pages) };
        await Promise.all([pollDueWebWatches(deps, options), pollDueWebWatches(deps, options)]);
      }
      const fires = await db.select().from(watchFires).where(eq(watchFires.watchId, watch.id));
      const expected = mode === 'contains' ? 2 : 3;
      expect(fires).toHaveLength(expected);
      expect(new Set(fires.map((fire) => fire.triggerRef)).size).toBe(expected);
      expect((await stateOf(watch.id)).fireCount).toBe(expected);
      expect(notices.length - before).toBe(expected);
      expect(
        await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, watch.conversationId ?? '')),
      ).toHaveLength(expected);
    },
  );

  it('backs off a persistently failing watch and expires it with one notice', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const watch = await createWebWatch('failing', {
      url: 'https://ex.test/f',
      intervalSeconds: 60,
    });
    const fail = new Set(['https://ex.test/f']);
    const before = notices.length;
    for (let i = 0; i < 5; i += 1) {
      await pollDueWebWatches(deps, {
        now: at(1000 + i * 120),
        fetch: makeFetch(new Map(), fail),
      });
    }
    const s = await stateOf(watch.id);
    expect(s.status).toBe('expired');
    expect(s.state.failures).toBeGreaterThanOrEqual(5);
    expect(s.fires).toBe(0);
    const failureNotices = notices.slice(before).filter((n) => n.includes('keeps failing'));
    expect(failureNotices.length).toBe(1);
  });
});
