import { getAgent } from '@assistant/core';
import {
  channelBindings,
  conversations,
  createDb,
  createPostgresExecutionPersistence,
  type Db,
  emailIngest,
  messages,
  tasks,
} from '@assistant/db';
import { type EmailSyncDeps, processMessage } from '@assistant/modules';
import type { GoogleClient } from '@assistant/tools';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Forwarded-mail ingest, end to end through `processMessage`.
 *
 * The properties under test are the ones the feature turns on, and the ones a
 * regression here would quietly break:
 *   - nothing is dropped any more, so "automated" mail still lands and is
 *     searchable (that is where flight times and invoices live);
 *   - an above-threshold message becomes an OWNER-trust task, because the
 *     owner's forwarding rule is what asked for the work — without that the
 *     task cannot reach the calendar, workspace, memory or owner.notify at all;
 *   - it is simultaneously marked as quoting external content, so the session
 *     runs tainted and every outward call stays gated;
 *   - a below-threshold message costs no task at all.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const RUN = `Xtest-Ingest-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

function gmailMessage(input: {
  id: string;
  from: string;
  subject: string;
  body: string;
  authenticated?: boolean;
  extraHeaders?: Array<{ name: string; value: string }>;
}) {
  const headers = [
    { name: 'From', value: input.from },
    { name: 'Subject', value: input.subject },
    { name: 'Message-ID', value: `<${input.id}@mail>` },
    ...(input.authenticated === false
      ? []
      : [
          {
            name: 'Authentication-Results',
            value: `mx.google.com; dkim=pass header.d=${input.from.split('@')[1]}`,
          },
        ]),
    ...(input.extraHeaders ?? []),
  ];
  return {
    id: input.id,
    threadId: `thread-${input.id}`,
    labelIds: ['INBOX'],
    snippet: input.body.slice(0, 80),
    payload: {
      mimeType: 'text/plain',
      headers,
      body: { data: b64(input.body) },
    },
  };
}

/** Deps wired for forwarded ingest, with the importance scorer stubbed. */
function harness(score: Record<string, unknown>) {
  const object = vi.fn().mockResolvedValue({ ok: true, object: score });
  const api = vi.fn(async (url: string) => {
    const match = url.match(/\/messages\/([^/?]+)/);
    const id = match?.[1] ?? '';
    return messagesById.get(id) ?? {};
  });
  const deps = {
    db,
    persistence: createPostgresExecutionPersistence(db),
    config: {
      ASSISTANT_MODULES: ['google'],
      GMAIL_SYNC_ENABLED: 'true',
      EMAIL_INGEST_MODE: 'forwarded',
      EMAIL_INGEST_IMPORTANCE_THRESHOLD: 3,
      EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 40,
    },
    router: { object },
    workspace: { writeBytes: async () => {}, delete: async () => {} },
    googleClient: { api, configured: () => true } as unknown as GoogleClient,
    notifyOwner: async () => {},
    observeInboundEmail: async () => {},
  } as unknown as EmailSyncDeps;
  return { deps, object };
}

const messagesById = new Map<string, unknown>();

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('email-ingest.e2e: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    const convs = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(like(conversations.title, `${RUN}%`));
    const ids = convs.map((c) => c.id);
    if (ids.length) {
      // messages.task_id references tasks, so messages must go first.
      await db.delete(messages).where(inArray(messages.conversationId, ids));
      await db.delete(tasks).where(inArray(tasks.conversationId, ids));
      await db.delete(emailIngest).where(inArray(emailIngest.conversationId, ids));
      await db.delete(channelBindings).where(inArray(channelBindings.conversationId, ids));
      await db.delete(conversations).where(inArray(conversations.id, ids));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('forwarded email ingest', () => {
  it('keeps automated mail, records a verdict, and triages what clears the bar', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = `${RUN}-flight`;
    messagesById.set(
      id,
      gmailMessage({
        id,
        // A no-reply sender: the exact class the old pipeline discarded before
        // it was ever stored.
        from: 'no-reply@airline.example',
        subject: `${RUN} Your itinerary`,
        body: 'You depart on 1 September at 08:00 from gate B12.',
      }),
    );
    const { deps } = harness({
      category: 'travel',
      importance: 4,
      actionable: true,
      dates: [{ iso: '2026-09-01T08:00:00Z', what: 'flight departs' }],
      reason: 'flight confirmation with a departure time',
    });

    const outcome = await processMessage(deps, agentId, 'bot@bmson.com', new Map(), id);
    expect(outcome).toBe('triaged');

    const [row] = await db
      .select()
      .from(emailIngest)
      .where(eq(emailIngest.channelMessageId, `gmail:${id}`));
    expect(row?.category).toBe('travel');
    expect(row?.importance).toBe(4);
    expect(row?.triaged).toBe(true);
    // Sender trust stays sender-derived, so memory quarantine still applies.
    expect(row?.contentTrust).toBe('unknown');

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalEventId, `gmail:${id}`));
    if (!task) throw new Error('triage task was not queued');
    // Owner trust is what gives the task the calendar/workspace/notify tools.
    expect(task.trust).toBe('owner');
    const payload = (task.trigger as { payload: Record<string, unknown> }).payload;
    expect(payload.ingest).toMatchObject({ forwarded: true, contentTrust: 'unknown' });
    // ...and taint is what keeps every outward call gated despite that trust.
    expect(payload.quotesExternalContent).toBe(true);
    expect(task.budgetUsdLimit).toBe('1.2000');
    expect(task.maxSteps).toBe(16);
  });

  it('stores below-threshold mail without spending a triage task', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = `${RUN}-newsletter`;
    messagesById.set(
      id,
      gmailMessage({
        id,
        from: 'news@example.com',
        subject: `${RUN} This week in things`,
        body: 'Lots of things happened.',
      }),
    );
    const { deps } = harness({
      category: 'bulk',
      importance: 1,
      actionable: false,
      dates: [],
      reason: 'newsletter',
    });

    const outcome = await processMessage(deps, agentId, 'bot@bmson.com', new Map(), id);
    expect(outcome).toBe('skipped');

    // Still stored and searchable — just not interrupting, and not billed for.
    const [row] = await db
      .select()
      .from(emailIngest)
      .where(eq(emailIngest.channelMessageId, `gmail:${id}`));
    expect(row?.importance).toBe(1);
    expect(row?.triaged).toBe(false);
    const persisted = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.channelMessageId, `gmail:${id}`));
    expect(persisted).toHaveLength(1);

    const queued = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.externalEventId, `gmail:${id}`));
    expect(queued).toHaveLength(0);
  });

  it('keeps unauthenticated mail instead of dropping it, at unknown trust', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Forwarding breaks SPF by construction, so dropping on failed
    // authentication would silently discard much of a real forwarded inbox.
    const id = `${RUN}-unauth`;
    messagesById.set(
      id,
      gmailMessage({
        id,
        from: 'someone@example.com',
        subject: `${RUN} No auth headers`,
        body: 'Plain message.',
        authenticated: false,
      }),
    );
    const { deps } = harness({
      category: 'personal',
      importance: 4,
      actionable: false,
      dates: [],
      reason: 'a person wrote this',
    });

    await processMessage(deps, agentId, 'bot@bmson.com', new Map(), id);
    const [row] = await db
      .select()
      .from(emailIngest)
      .where(eq(emailIngest.channelMessageId, `gmail:${id}`));
    expect(row).toBeDefined();
    expect(row?.authenticated).toBe(false);
    expect(row?.contentTrust).toBe('unknown');
  });

  it('re-scores nothing when Gmail replays the same message', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = `${RUN}-replay`;
    messagesById.set(
      id,
      gmailMessage({
        id,
        from: 'billing@example.com',
        subject: `${RUN} Invoice`,
        body: 'Due on the 5th.',
      }),
    );
    const { deps, object } = harness({
      category: 'financial',
      importance: 4,
      actionable: true,
      dates: [],
      reason: 'invoice with a due date',
    });

    await processMessage(deps, agentId, 'bot@bmson.com', new Map(), id);
    const callsAfterFirst = object.mock.calls.length;
    await processMessage(deps, agentId, 'bot@bmson.com', new Map(), id);

    // History replays are routine; paying the scorer twice for one message is
    // a cost bug, and a second task would be a duplicate-work bug.
    expect(object.mock.calls.length).toBe(callsAfterFirst);
    const rows = await db
      .select({ id: emailIngest.id })
      .from(emailIngest)
      .where(eq(emailIngest.channelMessageId, `gmail:${id}`));
    expect(rows).toHaveLength(1);
    const queued = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.externalEventId, `gmail:${id}`));
    expect(queued).toHaveLength(1);
  });
});
