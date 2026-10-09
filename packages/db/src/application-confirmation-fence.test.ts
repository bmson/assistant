import { createHash, randomUUID } from 'node:crypto';
import { applicationConfirmationTaskInput } from '@assistant/persistence';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresApplicationConfirmationRepository } from './application-confirmation-repository.js';
import { createDb, type Db } from './client.js';
import { createPostgresMessageRepository } from './message-repository.js';
import { createPostgresNotificationOutboxRepository } from './notification-outbox-repository.js';
import { createPostgresNotificationsConversationRepository } from './notifications-conversation-repository.js';
import {
  agents,
  applicationConfirmations,
  conversations,
  emailIngest,
  emailObserverWork,
  maintenanceCursors,
  messages,
  notificationOutbox,
  tasks,
} from './schema.js';
import { createTask as createTaskInTransaction } from './task-creation-repository.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';

const DATABASE_URL = process.env.DATABASE_URL;
function testUrl() {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

describe('PostgreSQL durable email application-confirmation fence', () => {
  let db: Db;
  let agentId: string;
  let taskId: string;
  let conversationId: string;
  const sourceIds: string[] = [];
  const handoffTaskIds: string[] = [];
  const privacyGenerationName = () => `privacy-erasure-generation:${agentId}`;

  async function currentPrivacyGeneration(): Promise<string | null> {
    const [row] = await db
      .select({ cursor: maintenanceCursors.cursor })
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, privacyGenerationName()))
      .limit(1);
    return typeof row?.cursor === 'string' ? row.cursor : null;
  }

  async function advancePrivacyGeneration(): Promise<string> {
    const cursor = randomUUID();
    await db
      .insert(maintenanceCursors)
      .values({ name: privacyGenerationName(), cursor })
      .onConflictDoUpdate({
        target: maintenanceCursors.name,
        set: { cursor, updatedAt: new Date() },
      });
    return cursor;
  }

  beforeAll(async () => {
    db = createDb(testUrl());
    const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!owner) throw new Error('Seed the isolated test database');
    agentId = owner.id;
    const task = await createPostgresTaskRepository(db).createTask({
      agentId,
      type: 'adhoc',
      trust: 'owner',
      trigger: {},
    });
    taskId = task.task.id;
    const [conversation] = await db
      .insert(conversations)
      .values({
        agentId,
        channel: 'email',
        trust: 'unknown',
        title: 'Confirmation source fixture',
      })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('conversation insert failed');
    conversationId = conversation.id;
  });

  afterAll(async () => {
    for (const sourceKey of sourceIds) {
      await db
        .delete(emailObserverWork)
        .where(
          and(
            eq(emailObserverWork.agentId, agentId),
            eq(emailObserverWork.channelMessageId, sourceKey),
          ),
        );
      await db
        .delete(emailIngest)
        .where(and(eq(emailIngest.agentId, agentId), eq(emailIngest.channelMessageId, sourceKey)));
    }
    if (conversationId)
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
    if (agentId)
      await db
        .delete(maintenanceCursors)
        .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agentId}`));
    if (agentId)
      await db
        .delete(applicationConfirmations)
        .where(eq(applicationConfirmations.agentId, agentId));
    for (const id of handoffTaskIds) await db.delete(tasks).where(eq(tasks.id, id));
    if (taskId) await db.delete(tasks).where(eq(tasks.id, taskId));
    if (conversationId) await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.$client.end();
  });

  async function fixture(suffix: string, includeSecondAuthoredToken = false) {
    const providerMessageId = `confirmation-${suffix}-${randomUUID()}`;
    const channelMessageId = `gmail:${providerMessageId}`;
    const workId = randomUUID();
    const watchId = randomUUID();
    const token = `receipt-${suffix}`;
    const secondAuthoredToken = `second-${suffix}`;
    const externalToken = `external-${suffix}`;
    const absentToken = `absent-${suffix}`;
    const authoredBody = `Confirmation ${token}\n${includeSecondAuthoredToken ? `Also ${secondAuthoredToken}\n` : ''}`;
    const body = `${authoredBody}> quoted ${externalToken}`;
    const contentHash = createHash('sha256')
      .update('assistant-email-content-v1\0')
      .update(body)
      .digest('hex');
    const provenance = {
      version: 1 as const,
      mode: 'direct' as const,
      authenticated: true,
      sourceLength: body.length,
      storedLength: body.length,
      sourceHash: contentHash,
      bodyHash: contentHash,
      messageHash: contentHash,
      prefixLength: 0,
      hasExternalOrUnknown: true,
      spans: [
        { start: 0, end: authoredBody.length, author: 'sender' as const },
        { start: authoredBody.length, end: body.length, author: 'external' as const },
      ],
      parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: true, replyHeaders: false }],
    };
    const tokenHash = createHash('sha256').update(token.toUpperCase()).digest('hex');
    const externalTokenHash = createHash('sha256')
      .update(externalToken.toUpperCase())
      .digest('hex');
    const secondAuthoredTokenHash = createHash('sha256')
      .update(secondAuthoredToken.toUpperCase())
      .digest('hex');
    const absentTokenHash = createHash('sha256').update(absentToken.toUpperCase()).digest('hex');
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    const expectedPrivacyGeneration = await currentPrivacyGeneration();
    sourceIds.push(channelMessageId);
    const [message] = await db
      .insert(messages)
      .values({
        conversationId,
        role: 'user',
        origin: 'unknown',
        channelMessageId,
        parts: [{ type: 'text', text: body }],
        text: body,
      })
      .returning({ id: messages.id });
    if (!message) throw new Error('message insert failed');
    await db.insert(emailIngest).values({
      agentId,
      mailbox: 'owner@example.test',
      providerMessageId,
      providerThreadId: 'thread-1',
      channelMessageId,
      conversationId,
      fromEmail: 'sender@example.test',
      subject: 'Application receipt',
      contentTrust: 'unknown',
      authenticated: true,
      ingestMode: 'direct',
      hasExternalOrUnknown: true,
      emailContentProvenance: provenance,
      category: 'other',
      importance: 1,
      actionable: false,
      reason: '',
      dates: [],
      admittedSourceKind: 'message',
      admittedSourceId: message.id,
    });
    await db.insert(emailObserverWork).values({
      id: workId,
      agentId,
      sourceKey: channelMessageId,
      channelMessageId,
      sourceKind: 'message',
      observerKey: 'google.application-confirmation',
      observerVersion: 1,
      workClass: 'idempotent_db',
      status: 'prepared',
      claimToken: `claim-${suffix}`,
      claimGeneration: 4,
      leaseExpiresAt,
      privacyGeneration: expectedPrivacyGeneration,
      preparedResult: {},
    });
    await db.insert(applicationConfirmations).values({
      id: watchId,
      agentId,
      sourceTaskId: taskId,
      conversationId,
      company: 'Example Corp',
      role: 'Engineer',
      expectedSenderEmails: ['sender@example.test'],
      confirmationTokenHash: tokenHash,
      confirmationTokenHint: '1234',
      trackerUpdate: null,
      documentUpdate: null,
      actionState: {},
      status: 'awaiting_confirmation',
      expiresAt: new Date(now.getTime() + 120_000),
    });
    const absentWatchId = randomUUID();
    await db.insert(applicationConfirmations).values({
      id: absentWatchId,
      agentId,
      sourceTaskId: taskId,
      conversationId,
      company: 'Absent Corp',
      role: 'Analyst',
      expectedSenderEmails: ['sender@example.test'],
      confirmationTokenHash: absentTokenHash,
      confirmationTokenHint: '9876',
      trackerUpdate: null,
      documentUpdate: null,
      actionState: {},
      status: 'awaiting_confirmation',
      expiresAt: new Date(now.getTime() + 120_000),
    });
    const secondWatchId = randomUUID();
    await db.insert(applicationConfirmations).values({
      id: secondWatchId,
      agentId,
      sourceTaskId: taskId,
      conversationId,
      company: 'Other Corp',
      role: 'Designer',
      expectedSenderEmails: ['sender@example.test'],
      confirmationTokenHash: includeSecondAuthoredToken
        ? secondAuthoredTokenHash
        : externalTokenHash,
      confirmationTokenHint: includeSecondAuthoredToken ? '2222' : '5678',
      trackerUpdate: null,
      documentUpdate: null,
      actionState: {},
      status: 'awaiting_confirmation',
      expiresAt: new Date(now.getTime() + 120_000),
    });
    return {
      watchId,
      channelMessageId,
      providerMessageId,
      body,
      tokenHash,
      externalTokenHash,
      secondWatchId,
      absentWatchId,
      absentTokenHash,
      fence: {
        id: workId,
        agentId,
        claimToken: `claim-${suffix}`,
        claimGeneration: 4,
        expectedPrivacyGeneration,
      },
      digest: createHash('sha256')
        .update(
          JSON.stringify([channelMessageId, 'sender@example.test', 'Application receipt', body]),
        )
        .digest('hex'),
    };
  }

  async function taskNoticeFixture(suffix: string, producerPrivacyGeneration: string | null) {
    const applicationId = randomUUID();
    const confirmationMessageId = `gmail:notice-${suffix}-${randomUUID()}`;
    const taskInput = applicationConfirmationTaskInput({
      agentId,
      applicationId,
      confirmationMessageId,
      conversationId,
      subject: 'Application receipt',
      producerPrivacyGeneration,
    });
    const created = await createTaskInTransaction(db, taskInput);
    handoffTaskIds.push(created.task.id);
    const claimed = await createPostgresTaskRepository(db).claim(created.task.id);
    if (!claimed) throw new Error('application task was not claimable');
    if (!claimed.leaseToken) throw new Error('application task lease token missing');
    await db.insert(applicationConfirmations).values({
      id: applicationId,
      agentId,
      sourceTaskId: taskId,
      conversationId,
      company: 'Example Corp',
      role: 'Engineer',
      expectedSenderEmails: ['sender@example.test'],
      confirmationTokenHash: randomUUID().replaceAll('-', '').toUpperCase(),
      confirmationTokenHint: '1234',
      trackerUpdate: null,
      documentUpdate: null,
      actionState: {},
      status: 'confirmation_received',
      confirmationMessageId,
      confirmationFrom: 'sender@example.test',
      confirmedAt: new Date(),
      producerPrivacyGeneration,
      expiresAt: new Date(Date.now() + 120_000),
    });
    return {
      applicationId,
      confirmationMessageId,
      task: claimed,
      fence: {
        agentId,
        taskId: claimed.id,
        taskLeaseToken: claimed.leaseToken,
        taskQueueGeneration: claimed.queueGeneration,
        applicationId,
        confirmationMessageId,
        producerPrivacyGeneration,
      },
    };
  }

  it('claims the matched watch only for the live prepared owner/source/claim', async () => {
    const row = await fixture('positive');
    const notifications = createPostgresNotificationsConversationRepository(db);
    const noticeConversation = await notifications.getOrCreate(agentId, row.fence);
    expect(
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.id, noticeConversation), eq(conversations.title, 'Notifications')),
        ),
    ).toHaveLength(1);
    const claimed = await createPostgresApplicationConfirmationRepository(db).claim(row.watchId, {
      confirmationMessageId: row.channelMessageId,
      confirmationFrom: 'sender@example.test',
      now: new Date(),
      emailObserverEffectFence: row.fence,
      confirmationTokenHash: row.tokenHash,
      sourceDigest: row.digest,
    });
    expect(claimed).toMatchObject({
      id: row.watchId,
      status: 'confirmation_received',
      confirmationMessageId: row.channelMessageId,
      confirmationFrom: 'sender@example.test',
    });
  });

  it('atomically claims the watch and creates one exact internal task, then replays that handoff', async () => {
    const row = await fixture('atomic-handoff');
    const repository = createPostgresApplicationConfirmationRepository(db);
    const input = {
      confirmationMessageId: row.channelMessageId,
      confirmationFrom: 'sender@example.test',
      now: new Date(),
      emailObserverEffectFence: row.fence,
      confirmationTokenHash: row.tokenHash,
      sourceDigest: row.digest,
    };

    const first = await repository.claimAndEnqueue(row.watchId, input);
    expect(first).not.toBeNull();
    if (!first) throw new Error('handoff was not created');
    handoffTaskIds.push(first.task.id);
    expect(first.record).toMatchObject({
      status: 'confirmation_received',
      confirmationMessageId: row.channelMessageId,
      producerPrivacyGeneration: row.fence.expectedPrivacyGeneration,
    });
    expect(first.task.trigger).toMatchObject({
      source: 'internal',
      payload: {
        kind: 'application_confirmation',
        applicationId: row.watchId,
        confirmationMessageId: row.channelMessageId,
        producerPrivacyGeneration: row.fence.expectedPrivacyGeneration,
      },
    });

    const replay = await repository.claimAndEnqueue(row.watchId, input);
    expect(replay).toMatchObject({
      record: { status: 'confirmation_received', confirmationMessageId: row.channelMessageId },
      task: { id: first.task.id },
      created: false,
    });
    expect(
      await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.externalEventId, `application-confirmation:${row.channelMessageId}`)),
    ).toHaveLength(1);
  });

  it('does not claim the watch or create its task when the captured privacy generation is stale', async () => {
    const row = await fixture('atomic-handoff-stale');
    await advancePrivacyGeneration();
    const repository = createPostgresApplicationConfirmationRepository(db);
    const result = await repository.claimAndEnqueue(row.watchId, {
      confirmationMessageId: row.channelMessageId,
      confirmationFrom: 'sender@example.test',
      now: new Date(),
      emailObserverEffectFence: row.fence,
      confirmationTokenHash: row.tokenHash,
      sourceDigest: row.digest,
    });
    expect(result).toBeNull();
    expect(await repository.get(row.watchId)).toMatchObject({ status: 'awaiting_confirmation' });
    expect(
      await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.externalEventId, `application-confirmation:${row.channelMessageId}`)),
    ).toHaveLength(0);
  });

  it('rejects a delayed task notice after erasure and accepts a fresh generation once', async () => {
    const stale = await taskNoticeFixture('stale', await currentPrivacyGeneration());
    await advancePrivacyGeneration();
    const messagesRepository = createPostgresMessageRepository(db);
    const staleInput = {
      conversationId,
      taskId: stale.task.id,
      role: 'assistant' as const,
      origin: 'assistant' as const,
      parts: [{ type: 'text', text: 'The watch is updated.' }],
      text: 'The watch is updated.',
      channelMessageId: `application-confirmation-notice:${stale.task.id}:updated`,
      applicationConfirmationNoticeFence: stale.fence,
    };
    await expect(messagesRepository.append(staleInput)).rejects.toThrow(/fence|privacy/i);
    expect(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.channelMessageId, staleInput.channelMessageId)),
    ).toHaveLength(0);

    const [privacy] = await db
      .select({ cursor: maintenanceCursors.cursor })
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agentId}`));
    if (!privacy || typeof privacy.cursor !== 'string')
      throw new Error('privacy generation missing');
    const fresh = await taskNoticeFixture('fresh', privacy.cursor);
    const freshInput = {
      ...staleInput,
      taskId: fresh.task.id,
      channelMessageId: `application-confirmation-notice:${fresh.task.id}:updated`,
      applicationConfirmationNoticeFence: fresh.fence,
    };
    expect(await messagesRepository.append(freshInput)).toMatchObject({
      taskId: fresh.task.id,
      channelMessageId: freshInput.channelMessageId,
    });
    expect(await messagesRepository.append(freshInput)).toBeUndefined();
    expect(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.channelMessageId, freshInput.channelMessageId)),
    ).toHaveLength(1);
  });

  it('rejects a task notice when erasure advances while the append waits on the owner lock', async () => {
    const row = await taskNoticeFixture('owner-lock-wait', await currentPrivacyGeneration());
    const nextGeneration = randomUUID();
    const blocker = createDb(testUrl());
    let signalLocked: () => void = () => {};
    let releaseLock: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holding = blocker.$client.begin(async (sql) => {
      await sql`select id from agents where id = ${agentId} for update`;
      await sql`
        insert into maintenance_cursors (name, cursor)
        values (${privacyGenerationName()}, ${nextGeneration})
        on conflict (name) do update
        set cursor = excluded.cursor, updated_at = clock_timestamp()
      `;
      signalLocked();
      await release;
    });
    await locked;
    const messagesRepository = createPostgresMessageRepository(db);
    const input = {
      conversationId,
      taskId: row.task.id,
      role: 'assistant' as const,
      origin: 'assistant' as const,
      parts: [{ type: 'text', text: 'The watch is updated.' }],
      text: 'The watch is updated.',
      channelMessageId: `application-confirmation-notice:${row.task.id}:updated`,
      applicationConfirmationNoticeFence: row.fence,
    };
    const operation = messagesRepository.append(input).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    let observedWait = false;
    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const waiting = await db.$client`
          select pid from pg_stat_activity
          where datname = current_database()
            and state = 'active'
            and wait_event_type = 'Lock'
            and query ilike '%agents%'
        `;
        if (waiting.length > 0) {
          observedWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedWait).toBe(true);
    } finally {
      releaseLock();
      await holding;
      await blocker.$client.end();
    }
    const outcome = await operation;
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String(outcome.error)).toMatch(/privacy|fence/i);
    expect(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.channelMessageId, input.channelMessageId)),
    ).toHaveLength(0);
  });

  it('atomically records only canonical sender-authored ambiguous matches and replays exact task/notices', async () => {
    const row = await fixture('ambiguous-observer', true);
    const repository = createPostgresApplicationConfirmationRepository(db);
    const first = await repository.recordAmbiguousObserver({ emailObserverEffectFence: row.fence });
    expect(first).toMatchObject({
      kind: 'recorded',
      from: 'sender@example.test',
      applicationIds: expect.arrayContaining([row.watchId, row.secondWatchId]),
    });
    if (first.kind === 'not_ambiguous') throw new Error('ambiguous match was not recorded');
    handoffTaskIds.push(first.taskId);
    const eventId = `application-confirmation:${row.channelMessageId}:ambiguous`;
    const taskRows = await db.select().from(tasks).where(eq(tasks.externalEventId, eventId));
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]).toMatchObject({ status: 'needs_attention', trust: 'assistant' });
    const noticeRows = await db.select().from(messages).where(eq(messages.taskId, first.taskId));
    expect(noticeRows).toHaveLength(2);
    expect(
      noticeRows.every((notice) =>
        notice.channelMessageId?.startsWith(
          `application-confirmation-notice:${eventId}:ambiguous:`,
        ),
      ),
    ).toBe(true);
    expect(
      noticeRows.every((notice) =>
        notice.text.includes('matched more than one active application watch'),
      ),
    ).toBe(true);

    const replay = await repository.recordAmbiguousObserver({
      emailObserverEffectFence: row.fence,
    });
    expect(replay).toMatchObject({ kind: 'replay', taskId: first.taskId });
    expect(await db.select().from(tasks).where(eq(tasks.externalEventId, eventId))).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.taskId, first.taskId))).toHaveLength(
      2,
    );
  });

  it('does not create an ambiguous notice from a token that appears only in quoted external content', async () => {
    const row = await fixture('quoted-only-ambiguity');
    const repository = createPostgresApplicationConfirmationRepository(db);
    const result = await repository.recordAmbiguousObserver({
      emailObserverEffectFence: row.fence,
    });
    expect(result).toEqual({ kind: 'not_ambiguous' });
    expect(
      await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          eq(tasks.externalEventId, `application-confirmation:${row.channelMessageId}:ambiguous`),
        ),
    ).toHaveLength(0);
  });

  it('fails closed above the bounded matching-watch limit without creating task or notices', async () => {
    const row = await fixture('ambiguous-watch-overflow', true);
    const now = new Date();
    const tokens = Array.from(
      { length: 101 },
      (_, index) => `CASE-${String(index).padStart(3, '0')}`,
    );
    const authoredBody = `Confirmed ${tokens.join(' ')}`;
    const body = `${authoredBody}\n> quoted unrelated history`;
    const contentHash = createHash('sha256')
      .update('assistant-email-content-v1\0')
      .update(body)
      .digest('hex');
    const provenance = {
      version: 1 as const,
      mode: 'direct' as const,
      authenticated: true,
      sourceLength: body.length,
      storedLength: body.length,
      sourceHash: contentHash,
      bodyHash: contentHash,
      messageHash: contentHash,
      prefixLength: 0,
      hasExternalOrUnknown: true,
      spans: [
        { start: 0, end: authoredBody.length, author: 'sender' as const },
        { start: authoredBody.length, end: body.length, author: 'external' as const },
      ],
      parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: true, replyHeaders: false }],
    };
    await db
      .update(messages)
      .set({ parts: [{ type: 'text', text: body }], text: body })
      .where(eq(messages.channelMessageId, row.channelMessageId));
    await db
      .update(emailIngest)
      .set({ emailContentProvenance: provenance, hasExternalOrUnknown: true })
      .where(eq(emailIngest.channelMessageId, row.channelMessageId));
    await db
      .update(applicationConfirmations)
      .set({
        confirmationTokenHash: createHash('sha256')
          .update(tokens[0]?.toUpperCase() ?? '')
          .digest('hex'),
      })
      .where(eq(applicationConfirmations.id, row.watchId));
    await db
      .update(applicationConfirmations)
      .set({
        confirmationTokenHash: createHash('sha256')
          .update(tokens[1]?.toUpperCase() ?? '')
          .digest('hex'),
      })
      .where(eq(applicationConfirmations.id, row.secondWatchId));
    const overflowWatchIds = tokens.slice(2).map(() => randomUUID());
    await db.insert(applicationConfirmations).values(
      tokens.slice(2).map((token, index) => ({
        id: overflowWatchIds[index] as string,
        agentId,
        sourceTaskId: taskId,
        conversationId,
        company: `Overflow Corp ${index}`,
        role: 'Engineer',
        expectedSenderEmails: ['sender@example.test'],
        confirmationTokenHash: createHash('sha256').update(token.toUpperCase()).digest('hex'),
        confirmationTokenHint: '1234',
        trackerUpdate: null,
        documentUpdate: null,
        actionState: {},
        status: 'awaiting_confirmation' as const,
        expiresAt: new Date(now.getTime() + 120_000),
      })),
    );
    const repository = createPostgresApplicationConfirmationRepository(db);
    await expect(
      repository.recordAmbiguousObserver({ emailObserverEffectFence: row.fence }),
    ).rejects.toThrow(/watch_limit/);
    const eventId = `application-confirmation:${row.channelMessageId}:ambiguous`;
    expect(await db.select().from(tasks).where(eq(tasks.externalEventId, eventId))).toHaveLength(0);
    expect(
      (
        await db
          .select({ channelMessageId: messages.channelMessageId })
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
      ).filter((message) =>
        message.channelMessageId?.startsWith(
          `application-confirmation-notice:${eventId}:ambiguous:`,
        ),
      ),
    ).toHaveLength(0);
    await db
      .delete(applicationConfirmations)
      .where(inArray(applicationConfirmations.id, overflowWatchIds));
  });

  it('rejects stale privacy generation before creating any ambiguous task or message', async () => {
    const row = await fixture('ambiguous-erased');
    await advancePrivacyGeneration();
    const repository = createPostgresApplicationConfirmationRepository(db);
    await expect(
      repository.recordAmbiguousObserver({ emailObserverEffectFence: row.fence }),
    ).rejects.toThrow(/fence|privacy/i);
    expect(
      await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          eq(tasks.externalEventId, `application-confirmation:${row.channelMessageId}:ambiguous`),
        ),
    ).toHaveLength(0);
  });

  it('rolls back ambiguous task and notices when the observer lease expires waiting on a watch lock', async () => {
    const row = await fixture('ambiguous-lock-expiry', true);
    const expiresAt = new Date(Date.now() + 1_000);
    await db
      .update(emailObserverWork)
      .set({ leaseExpiresAt: expiresAt })
      .where(eq(emailObserverWork.id, row.fence.id));
    const blocker = createDb(testUrl());
    let signalLocked: () => void = () => {};
    let releaseLock: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holding = blocker.$client.begin(async (sql) => {
      await sql`select id from application_confirmations where id = ${row.watchId} for update`;
      signalLocked();
      await release;
    });
    await locked;
    const repository = createPostgresApplicationConfirmationRepository(db);
    let settled: { value: unknown; error: unknown } | null = null;
    const operation = repository
      .recordAmbiguousObserver({ emailObserverEffectFence: row.fence })
      .then(
        (value) => (settled = { value, error: null }),
        (error: unknown) => (settled = { value: null, error }),
      );
    let observedWait = false;
    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const waiting = await db.$client`
          select pid from pg_stat_activity
          where datname = current_database()
            and state = 'active'
            and wait_event_type = 'Lock'
            and query ilike '%application_confirmations%'
        `;
        if (waiting.length > 0) {
          observedWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(
        observedWait,
        `operation settled before observed lock wait: ${JSON.stringify(settled)}`,
      ).toBe(true);
      while (Date.now() <= expiresAt.getTime() + 10)
        await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      releaseLock();
      await holding;
      await blocker.$client.end();
    }
    const outcome = await operation;
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String(outcome.error)).toMatch(/fence|lease/i);
    const eventId = `application-confirmation:${row.channelMessageId}:ambiguous`;
    expect(await db.select().from(tasks).where(eq(tasks.externalEventId, eventId))).toHaveLength(0);
    expect(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          eq(
            messages.channelMessageId,
            `application-confirmation-notice:${eventId}:ambiguous:${row.watchId}`,
          ),
        ),
    ).toHaveLength(0);
    expect(await repository.get(row.watchId)).toMatchObject({ status: 'awaiting_confirmation' });
  });

  it('delivers a prepared task notice after task completion and suppresses it after owner erasure', async () => {
    const current = await currentPrivacyGeneration();
    const completed = await taskNoticeFixture('outbox-complete', current);
    const outbox = createPostgresNotificationOutboxRepository(db);
    const prepared = await outbox.prepare({
      agentId,
      deliveryKey: `application-confirmation-result:${completed.task.id}:updated`,
      legKey: 'dashboard',
      adapter: 'dashboard',
      destination: { conversationId },
      payload: { taskId: completed.task.id, text: 'The watch is updated.' },
      applicationConfirmationNoticeFence: completed.fence,
      now: new Date(),
    });
    await db
      .update(tasks)
      .set({ status: 'done', leaseToken: null, lockedUntil: null, updatedAt: new Date() })
      .where(eq(tasks.id, completed.task.id));
    const claim = await outbox.claim({
      agentId,
      legId: prepared.id,
      now: new Date(),
      leaseMs: 10_000,
    });
    expect(claim?.status).toBe('sending');
    if (!claim?.leaseToken) throw new Error('notification outbox lease token missing');
    await expect(
      outbox.complete({
        agentId,
        legId: prepared.id,
        leaseToken: claim.leaseToken,
        status: 'delivered',
        now: new Date(),
      }),
    ).resolves.toBe(true);

    const stale = await taskNoticeFixture('outbox-erased', await currentPrivacyGeneration());
    const stalePrepared = await outbox.prepare({
      agentId,
      deliveryKey: `application-confirmation-result:${stale.task.id}:updated`,
      legKey: 'dashboard',
      adapter: 'dashboard',
      destination: { conversationId },
      payload: { taskId: stale.task.id, text: 'The watch is updated.' },
      applicationConfirmationNoticeFence: stale.fence,
      now: new Date(),
    });
    await advancePrivacyGeneration();
    const suppressedResult = await outbox.claim({
      agentId,
      legId: stalePrepared.id,
      now: new Date(),
      leaseMs: 10_000,
    });
    expect(suppressedResult?.status).toBe('skipped');
    expect(suppressedResult?.payload).toBeNull();
    const [suppressed] = await db
      .select({ status: notificationOutbox.status, destination: notificationOutbox.destination })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, stalePrepared.id));
    expect(suppressed).toMatchObject({ status: 'skipped', destination: null });
  });

  it('rolls back the handoff if its lease expires while waiting for the watch lock', async () => {
    const row = await fixture('atomic-lock-expiry');
    const expiresAt = new Date(Date.now() + 1_000);
    await db
      .update(emailObserverWork)
      .set({ leaseExpiresAt: expiresAt })
      .where(eq(emailObserverWork.id, row.fence.id));
    const blocker = createDb(testUrl());
    let signalLocked: () => void = () => {};
    let releaseLock: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holding = blocker.$client.begin(async (sql) => {
      await sql`select id from application_confirmations where id = ${row.watchId} for update`;
      signalLocked();
      await release;
    });
    await locked;
    const repository = createPostgresApplicationConfirmationRepository(db);
    const operation = repository
      .claimAndEnqueue(row.watchId, {
        confirmationMessageId: row.channelMessageId,
        confirmationFrom: 'sender@example.test',
        now: new Date(),
        emailObserverEffectFence: row.fence,
        confirmationTokenHash: row.tokenHash,
        sourceDigest: row.digest,
      })
      .then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
    let observedWait = false;
    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const waiting =
          await db.$client`select pid from pg_stat_activity where datname = current_database() and state = 'active' and wait_event_type = 'Lock' and query ilike '%application_confirmations%'`;
        if (waiting.length > 0) {
          observedWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedWait).toBe(true);
      while (Date.now() <= expiresAt.getTime() + 10)
        await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      releaseLock();
      await holding;
      await blocker.$client.end();
    }
    const outcome = await operation;
    if (outcome.value) handoffTaskIds.push(outcome.value.task.id);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(await repository.get(row.watchId)).toMatchObject({ status: 'awaiting_confirmation' });
    expect(
      await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.externalEventId, `application-confirmation:${row.channelMessageId}`)),
    ).toHaveLength(0);
  });

  it('rolls back the watch claim when an existing task event has a different payload', async () => {
    const row = await fixture('atomic-handoff-mismatch');
    const eventId = `application-confirmation:${row.channelMessageId}`;
    const conflict = await createTaskInTransaction(db, {
      agentId,
      type: 'adhoc',
      trust: 'assistant',
      externalEventId: eventId,
      maxSteps: 2,
      trigger: {
        source: 'internal',
        externalEventId: eventId,
        agentId,
        trust: 'assistant',
        payload: { kind: 'wrong_task' },
      },
    });
    handoffTaskIds.push(conflict.task.id);
    const repository = createPostgresApplicationConfirmationRepository(db);
    await expect(
      repository.claimAndEnqueue(row.watchId, {
        confirmationMessageId: row.channelMessageId,
        confirmationFrom: 'sender@example.test',
        now: new Date(),
        emailObserverEffectFence: row.fence,
        confirmationTokenHash: row.tokenHash,
        sourceDigest: row.digest,
      }),
    ).rejects.toThrow('Task event does not match its fenced email source');
    expect(await repository.get(row.watchId)).toMatchObject({ status: 'awaiting_confirmation' });
    expect(
      await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.externalEventId, eventId)),
    ).toEqual([{ id: conflict.task.id }]);
  });

  it('does not mutate a watch when the observer claim, privacy generation, or canonical source is stale', async () => {
    const row = await fixture('stale');
    const repository = createPostgresApplicationConfirmationRepository(db);
    const before = await repository.get(row.watchId);
    const rejected = await repository.claim(row.watchId, {
      confirmationMessageId: row.channelMessageId,
      confirmationFrom: 'sender@example.test',
      now: new Date(),
      emailObserverEffectFence: { ...row.fence, claimToken: 'superseded-token' },
      confirmationTokenHash: row.tokenHash,
      sourceDigest: row.digest,
    });
    expect(rejected).toBeNull();
    expect(await repository.get(row.watchId)).toEqual(before);
    const conversationsBefore = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')));
    await expect(
      createPostgresNotificationsConversationRepository(db).getOrCreate(agentId, {
        ...row.fence,
        claimToken: 'superseded-token',
      }),
    ).rejects.toThrow(/claim is stale|fence changed/i);
    expect(
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications'))),
    ).toEqual(conversationsBefore);
    const wrongSource = await repository.claim(row.watchId, {
      confirmationMessageId: row.channelMessageId,
      confirmationFrom: 'sender@example.test',
      now: new Date(),
      emailObserverEffectFence: row.fence,
      confirmationTokenHash: row.tokenHash,
      sourceDigest: 'f'.repeat(64),
    });
    expect(wrongSource).toBeNull();
    expect(await repository.get(row.watchId)).toEqual(before);
  });

  it('rejects a same-sender watch whose token appears only in a quoted external span', async () => {
    const row = await fixture('quoted-token');
    const repository = createPostgresApplicationConfirmationRepository(db);
    const before = await repository.get(row.secondWatchId);
    const rejected = await repository.claim(row.secondWatchId, {
      confirmationMessageId: row.channelMessageId,
      confirmationFrom: 'sender@example.test',
      now: new Date(),
      emailObserverEffectFence: row.fence,
      confirmationTokenHash: row.externalTokenHash,
      sourceDigest: row.digest,
    });
    expect(rejected).toBeNull();
    expect(await repository.get(row.secondWatchId)).toEqual(before);
  });

  it('rejects a same-sender watch whose token is absent from the canonical source', async () => {
    const row = await fixture('absent-token');
    const repository = createPostgresApplicationConfirmationRepository(db);
    const before = await repository.get(row.absentWatchId);
    await expect(
      repository.claim(row.absentWatchId, {
        confirmationMessageId: row.channelMessageId,
        confirmationFrom: 'sender@example.test',
        now: new Date(),
        emailObserverEffectFence: row.fence,
        confirmationTokenHash: row.absentTokenHash,
        sourceDigest: row.digest,
      }),
    ).resolves.toBeNull();
    expect(await repository.get(row.absentWatchId)).toEqual(before);
  });

  it('rejects an application claim after the captured owner privacy generation changed', async () => {
    const row = await fixture('privacy');
    await advancePrivacyGeneration();
    const repository = createPostgresApplicationConfirmationRepository(db);
    const before = await repository.get(row.watchId);
    await expect(
      repository.claim(row.watchId, {
        confirmationMessageId: row.channelMessageId,
        confirmationFrom: 'sender@example.test',
        now: new Date(),
        emailObserverEffectFence: row.fence,
        confirmationTokenHash: row.tokenHash,
        sourceDigest: row.digest,
      }),
    ).resolves.toBeNull();
    expect(await repository.get(row.watchId)).toEqual(before);
  });
});
