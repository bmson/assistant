import { getAgent } from '@assistant/core';
import {
  channelBindings,
  contacts,
  conversations,
  createDb,
  createPostgresEmailSyncRepository,
  createPostgresVoiceContextRepository,
  type Db,
  type TaskRow,
  tasks,
} from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deliverEmailFinal, type EmailChannelDeps } from './email-channel.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
let agentName: string;
let agentEmail: string;
let emailConvId: string;
let chatConvId: string;
const createdConversationIds: string[] = [];
const createdTaskIds: string[] = [];
const createdContactIds: string[] = [];
let ownerEmailRestore: { id: string; emails: string[] } | undefined;
/**
 * Auto-reply now requires the recipient to be a real owner address, so the
 * fixture has to own the one it replies to. In production that holds by
 * construction — an email task only reaches owner trust when `classifySender`
 * matched the sender against an owner contact — but a hand-built TaskRow can
 * assert any trust it likes, which is exactly what the check exists to catch.
 */
const OWNER_ADDRESS = 'bmson@bmson.com';

/** Captures Gmail sends instead of performing them; serves Message-ID metadata reads. */
function makeDeps(): { deps: EmailChannelDeps; sent: Array<{ url: string; body: string }> } {
  const sent: Array<{ url: string; body: string }> = [];
  const deps = {
    persistence: {
      emailSync: createPostgresEmailSyncRepository(db),
      voiceContext: createPostgresVoiceContextRepository(db),
    },
    googleClient: {
      configured: () => true,
      api: async (url: string, init?: { body?: string }) => {
        if (url.includes('format=metadata')) {
          return { payload: { headers: [{ name: 'Message-ID', value: '<orig-123@mail>' }] } };
        }
        sent.push({ url, body: init?.body ?? '' });
        return { id: 'sent-1', threadId: 'thread-1' };
      },
    },
  } as unknown as EmailChannelDeps;
  return { deps, sent };
}

function emailTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    type: 'email_triage',
    trust: 'owner',
    conversationId: emailConvId,
    trigger: {
      source: 'email',
      payload: {
        threadId: 'thread-1',
        messageId: 'msg-1',
        from: 'bmson@bmson.com',
        subject: 'Camp performance',
      },
    },
    ...overrides,
  } as TaskRow;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const agent = await getAgent(db);
    agentId = agent.id;
    agentName = agent.name;
    agentEmail = agent.email;
    dbUp = true;
  } catch {
    console.warn('email-channel.test: database unreachable — skipping');
    return;
  }
  const [emailConv] = await db
    .insert(conversations)
    .values({ agentId, channel: 'email', trust: 'owner', title: 'email-channel-test' })
    .returning();
  const [chatConv] = await db
    .insert(conversations)
    .values({ agentId, channel: 'chat', trust: 'owner', title: 'email-channel-test' })
    .returning();
  emailConvId = (emailConv as NonNullable<typeof emailConv>).id;
  chatConvId = (chatConv as NonNullable<typeof chatConv>).id;
  createdConversationIds.push(emailConvId, chatConvId);

  const [existingOwner] = await db
    .select({ id: contacts.id, emails: contacts.emails })
    .from(contacts)
    .where(eq(contacts.trust, 'owner'))
    .limit(1);
  if (existingOwner) {
    // Lend the seeded owner this test's address rather than adding a second
    // owner row, and remember the original list so afterAll can put it back —
    // these suites share one database.
    if (!existingOwner.emails.includes(OWNER_ADDRESS)) {
      ownerEmailRestore = { id: existingOwner.id, emails: existingOwner.emails };
      await db
        .update(contacts)
        .set({ emails: [...existingOwner.emails, OWNER_ADDRESS] })
        .where(eq(contacts.id, existingOwner.id));
    }
  } else {
    const [created] = await db
      .insert(contacts)
      .values({ name: 'Test Owner', emails: [OWNER_ADDRESS], trust: 'owner' })
      .returning();
    if (created) createdContactIds.push(created.id);
  }
});

afterAll(async () => {
  if (dbUp && ownerEmailRestore) {
    await db
      .update(contacts)
      .set({ emails: ownerEmailRestore.emails })
      .where(eq(contacts.id, ownerEmailRestore.id));
  }
  if (dbUp && createdContactIds.length) {
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
  if (dbUp && createdTaskIds.length) {
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  if (dbUp && createdConversationIds.length) {
    await db
      .delete(channelBindings)
      .where(inArray(channelBindings.conversationId, createdConversationIds));
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('deliverEmailFinal', () => {
  it('replies on the same Gmail thread for owner email tasks', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { deps, sent } = makeDeps();

    const delivered = await deliverEmailFinal(deps, emailTask(), 'The performance is at 4pm.');
    expect(delivered).toMatchObject({ channel: 'email', status: 'accepted' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain('/messages/send');

    const body = JSON.parse(sent[0]?.body ?? '{}') as { raw: string; threadId: string };
    expect(body.threadId).toBe('thread-1');
    const decoded = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(decoded).toContain(`From: "${agentName}" <${agentEmail}>`);
    expect(decoded).toContain('To: bmson@bmson.com');
    expect(decoded).toContain('Subject: Re: Camp performance');
    expect(decoded).toContain('In-Reply-To: <orig-123@mail>');
    expect(decoded).toContain('The performance is at 4pm.');
  });

  it('never auto-replies to non-owner senders', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { deps, sent } = makeDeps();
    const delivered = await deliverEmailFinal(
      deps,
      emailTask({ trust: 'unknown' }),
      'should not send',
    );
    expect(delivered).toMatchObject({ channel: 'email', status: 'not_applicable' });
    expect(sent).toHaveLength(0);
  });

  it('never auto-replies to a forwarded-ingest task, even at owner trust', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { deps, sent } = makeDeps();
    // The shape forwarded ingest produces: owner trust (the owner's forwarding
    // rule asked for the work) but a third-party `from`. Replying here would
    // mail the assistant's output to a stranger.
    const delivered = await deliverEmailFinal(
      deps,
      emailTask({
        trigger: {
          source: 'email',
          payload: {
            threadId: 'thread-1',
            messageId: 'msg-1',
            from: 'newsletter@example.com',
            subject: 'Your statement is ready',
            ingest: { forwarded: true, contentTrust: 'unknown' },
          },
        } as TaskRow['trigger'],
      }),
      'should never be sent',
    );
    expect(delivered).toMatchObject({ channel: 'email', status: 'rejected' });
    expect(sent).toHaveLength(0);
  });

  it('refuses to auto-reply to an address the owner does not own', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { deps, sent } = makeDeps();
    // Owner trust alone must not be enough: the recipient itself is checked, so
    // a task that claims owner trust with a stranger's `from` sends nothing.
    const delivered = await deliverEmailFinal(
      deps,
      emailTask({
        trigger: {
          source: 'email',
          payload: { threadId: 'thread-1', from: 'stranger@example.com', subject: 'Hello' },
        } as TaskRow['trigger'],
      }),
      'should never be sent',
    );
    expect(delivered).toMatchObject({ channel: 'email', status: 'rejected' });
    expect(sent).toHaveLength(0);
  });

  it('ignores non-email tasks and conversations', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { deps, sent } = makeDeps();
    expect(await deliverEmailFinal(deps, emailTask({ type: 'chat_turn' }), 'no')).toMatchObject({
      status: 'not_applicable',
    });
    expect(
      await deliverEmailFinal(deps, emailTask({ conversationId: chatConvId }), 'no'),
    ).toMatchObject({ status: 'rejected' });
    expect(
      await deliverEmailFinal(
        deps,
        emailTask({ trigger: { source: 'email', payload: {} } as TaskRow['trigger'] }),
        'no',
      ),
    ).toMatchObject({ status: 'rejected' });
    expect(sent).toHaveLength(0);
  });

  it('returns a required-channel rejection for an unavailable client or missing thread binding', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { deps, sent } = makeDeps();
    deps.googleClient.configured = () => false;
    expect(await deliverEmailFinal(deps, emailTask(), 'answer')).toMatchObject({
      channel: 'email',
      status: 'rejected',
      reason: 'provider-not-configured',
    });
    expect(sent).toHaveLength(0);

    deps.googleClient.configured = () => true;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', trust: 'owner', title: 'unbound-email-test' })
      .returning({ id: conversations.id });
    const conversationId = conversation?.id;
    if (!conversationId) throw new Error('test email conversation was not created');
    createdConversationIds.push(conversationId);
    const followUp = emailTask({ type: 'adhoc', conversationId, trigger: { source: 'internal' } });
    expect(await deliverEmailFinal(deps, followUp, 'answer')).toMatchObject({
      channel: 'email',
      status: 'rejected',
      reason: 'missing-owner-target',
    });
    expect(sent).toHaveLength(0);
  });

  it('distinguishes definite provider rejection from ambiguous send outcome', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { deps, sent } = makeDeps();
    deps.googleClient.api = async () => {
      throw Object.assign(new Error('provider rejected request'), { status: 403 });
    };
    expect(await deliverEmailFinal(deps, emailTask(), 'answer')).toMatchObject({
      status: 'rejected',
      reason: 'provider-rejected',
    });
    expect(sent).toHaveLength(0);

    deps.googleClient.api = async () => {
      throw Object.assign(new Error('response lost after send'), {
        deliveryMayHaveSucceeded: true,
      });
    };
    expect(await deliverEmailFinal(deps, emailTask(), 'answer')).toMatchObject({
      status: 'unknown',
      reason: 'provider-outcome-unknown',
    });
    expect(sent).toHaveLength(0);
  });

  it('replies to the email thread for a follow-up (adhoc) task on the same conversation (D5)', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // A conversation started by email, with its thread binding and the original
    // authenticated email_triage task recorded.
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', trust: 'owner', title: 'followup-thread' })
      .returning();
    const convId = (conv as NonNullable<typeof conv>).id;
    createdConversationIds.push(convId);
    await db.insert(channelBindings).values({
      conversationId: convId,
      channel: 'email',
      externalId: 'thread-followup',
    });
    const [origin] = await db
      .insert(tasks)
      .values({
        agentId,
        conversationId: convId,
        type: 'email_triage',
        trust: 'owner',
        trigger: {
          source: 'email',
          payload: {
            threadId: 'thread-followup',
            from: 'bmson@bmson.com',
            subject: 'Trip planning',
            rfcMessageId: '<orig-followup@mail>',
          },
        },
      })
      .returning();
    createdTaskIds.push((origin as NonNullable<typeof origin>).id);

    const { deps, sent } = makeDeps();
    // A mission/adhoc continuation carries no email payload of its own.
    const adhoc = {
      id: '00000000-0000-0000-0000-0000000000aa',
      type: 'adhoc',
      trust: 'owner',
      conversationId: convId,
      trigger: { source: 'internal', payload: {} },
    } as TaskRow;

    const delivered = await deliverEmailFinal(deps, adhoc, 'Booked the flights.');
    expect(delivered).toMatchObject({ channel: 'email', status: 'accepted' });
    const body = JSON.parse(sent[0]?.body ?? '{}') as { raw: string; threadId: string };
    expect(body.threadId).toBe('thread-followup');
    const decoded = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(decoded).toContain('To: bmson@bmson.com');
    expect(decoded).toContain('Subject: Re: Trip planning');
    expect(decoded).toContain('In-Reply-To: <orig-followup@mail>');
    expect(decoded).toContain('Booked the flights.');
  });

  it('keeps an existing Re: prefix', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const { deps, sent } = makeDeps();
    await deliverEmailFinal(
      deps,
      emailTask({
        trigger: {
          source: 'email',
          payload: { threadId: 'thread-1', from: 'bmson@bmson.com', subject: 'Re: Camp' },
        } as TaskRow['trigger'],
      }),
      'ok',
    );
    const decoded = Buffer.from(
      (JSON.parse(sent[0]?.body ?? '{}') as { raw: string }).raw,
      'base64url',
    ).toString('utf8');
    expect(decoded).toContain('Subject: Re: Camp');
    expect(decoded).not.toContain('Re: Re:');
  });
});
