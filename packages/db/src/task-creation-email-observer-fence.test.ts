import { createHash, randomUUID } from 'node:crypto';
import {
  type EmailObserverTaskCreationFence,
  newTaskRecord,
  type TaskCreateInput,
} from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresEmailSyncRepository } from './email-sync-repository.js';
import {
  agents,
  conversations,
  emailIngest,
  emailObserverWork,
  maintenanceCursors,
  messages,
  tasks,
} from './schema.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';

const DATABASE_URL = process.env.DATABASE_URL;
function testUrl() {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

const hash = (value: string) =>
  createHash('sha256').update('assistant-email-content-v1\0').update(value).digest('hex');

describe('PostgreSQL durable email task-creation fence', () => {
  let db: Db;
  let agentId: string;
  let mailbox: string;

  beforeEach(async () => {
    db = createDb(testUrl());
    agentId = randomUUID();
    mailbox = `${agentId}@task-fence.invalid`;
    await db.insert(agents).values({
      id: agentId,
      name: 'email-task-fence-test',
      email: mailbox,
      workspacePrefix: `email-task-fence/${agentId}`,
    });
  });

  afterEach(async () => {
    await db.delete(tasks).where(eq(tasks.agentId, agentId));
    await db.delete(emailObserverWork).where(eq(emailObserverWork.agentId, agentId));
    await db.delete(emailIngest).where(eq(emailIngest.agentId, agentId));
    await db
      .delete(messages)
      .where(
        inArray(
          messages.conversationId,
          db
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.agentId, agentId)),
        ),
      );
    await db.delete(conversations).where(eq(conversations.agentId, agentId));
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agentId}`));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.$client.end();
  });

  async function preparedTask() {
    const providerMessageId = randomUUID();
    const channelMessageId = `gmail:${providerMessageId}`;
    const from = 'sender@example.test';
    const subject = 'Observer source';
    const body = 'Please review the attached travel details.';
    const prefix = `From: ${from}\nSubject: ${subject}\n\n`;
    const text = prefix + body;
    const provenance = {
      version: 1 as const,
      mode: 'direct' as const,
      authenticated: true,
      sourceLength: body.length,
      storedLength: body.length,
      sourceHash: hash(body),
      bodyHash: hash(body),
      messageHash: hash(text),
      prefixLength: prefix.length,
      hasExternalOrUnknown: false,
      spans: [{ start: 0, end: body.length, author: 'sender' as const }],
      parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: false, replyHeaders: false }],
    };
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', trust: 'unknown', title: subject })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('Missing conversation fixture');
    const base = {
      agentId,
      mailbox,
      providerMessageId,
      providerThreadId: randomUUID(),
      sourceMessageId: `<${providerMessageId}@example.test>`,
      channelMessageId,
      conversationId: conversation.id,
      fromEmail: from,
      fromName: null,
      subject,
      contentTrust: 'unknown' as const,
      authenticated: true,
      ingestMode: 'direct' as const,
      hasExternalOrUnknown: false,
      category: 'travel',
      importance: 4,
      actionable: true,
      reason: 'Stored score',
      dates: [],
      pipelineStage: 'score_prepared',
      scoreStatus: 'prepared',
      scoreOutcome: 'model_prepared',
      messagePersisted: false,
      directRouting: 'email_triage' as const,
      directRecoveryReason: null,
      emailContentProvenance: provenance,
    };
    const email = createPostgresEmailSyncRepository(db, agentId);
    const stage = await email.beginDirectEmailIngest(base, { expectedPrivacyGeneration: null });
    expect(await email.claimIngestClassification(agentId, stage.id, 'classifier-fence', null)).toBe(
      true,
    );
    await email.prepareIngestClassification(
      agentId,
      stage.id,
      'classifier-fence',
      { automated: false },
      null,
    );
    expect(await email.claimIngestScore(agentId, stage.id, 'score-fence', null)).toBe(true);
    await email.prepareIngestScore(
      agentId,
      stage.id,
      'score-fence',
      {
        category: base.category,
        importance: base.importance,
        actionable: base.actionable,
        reason: base.reason,
        dates: base.dates,
        cardCandidate: false,
        nextStep: null,
      },
      null,
    );
    const admission = await email.commitEmailAdmission({
      agentId,
      ingestId: stage.id,
      scoreClaimToken: 'score-fence',
      source: {
        kind: 'message',
        message: {
          conversationId: conversation.id,
          channelMessageId,
          role: 'user',
          origin: 'unknown',
          text,
          parts: [{ type: 'text', text: body }],
        },
      },
      finalizedIngest: {
        ...base,
        observerRegistrySnapshot: [
          { key: 'google.direct-email-routing', version: 1, workClass: 'idempotent_db' },
        ],
      },
      observers: [{ key: 'google.direct-email-routing', version: 1, workClass: 'idempotent_db' }],
      expectedPrivacyGeneration: null,
    });
    const workId = admission.observerIds[0];
    if (!workId) throw new Error('Missing route observer fixture');
    const claimResult = await email.claimEmailObserver({
      id: workId,
      agentId,
      token: 'routing-fence-token',
      now: new Date(),
      leaseMs: 60_000,
      expectedPrivacyGeneration: null,
    });
    if (claimResult.kind !== 'claimed') throw new Error('Route observer did not claim');
    expect(
      await email.prepareEmailObserver({
        id: workId,
        agentId,
        claimToken: claimResult.claim.claimToken,
        claimGeneration: claimResult.claim.claimGeneration,
        expectedPrivacyGeneration: null,
        now: new Date(),
        result: { route: 'email_triage' },
      }),
    ).toBe(true);

    const fence: EmailObserverTaskCreationFence = {
      id: workId,
      agentId,
      claimToken: claimResult.claim.claimToken,
      claimGeneration: claimResult.claim.claimGeneration,
      expectedPrivacyGeneration: null,
      channelMessageId,
    };
    const trigger = {
      source: 'email',
      externalEventId: channelMessageId,
      agentId,
      conversationId: conversation.id,
      trust: 'unknown',
      payload: {
        threadId: base.providerThreadId,
        messageId: providerMessageId,
        rfcMessageId: base.sourceMessageId,
        from,
        subject,
        quotesExternalContent: false,
        emailProvenance: provenance,
        ingest: {
          forwarded: false,
          contentTrust: 'unknown',
          authenticated: true,
          importance: 4,
          category: 'travel',
          ownerAlerted: false,
        },
      },
    };
    const input = {
      agentId,
      conversationId: conversation.id,
      type: 'email_triage',
      title: subject,
      trust: 'unknown',
      trigger,
      externalEventId: channelMessageId,
      maxSteps: 16,
      budgetUsdLimit: '1.20',
      emailObserverTaskFence: fence,
    } satisfies TaskCreateInput;
    return { email, input, fence, workId, stageId: stage.id, channelMessageId };
  }

  it('rolls back a new task if its observer lease expires behind an uncommitted event insert', async () => {
    const row = await preparedTask();
    const expiresAt = new Date(Date.now() + 1_000);
    await db
      .update(emailObserverWork)
      .set({ leaseExpiresAt: expiresAt })
      .where(eq(emailObserverWork.id, row.workId));
    const blocker = createDb(testUrl());
    let signalLocked: () => void = () => {};
    let releaseLock: () => void = () => {};
    let signalFailed: (error: unknown) => void = () => {};
    const locked = new Promise<void>((resolve, reject) => {
      signalLocked = resolve;
      signalFailed = reject;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const sentinel = new Error('synthetic event blocker rollback');
    const holding = blocker
      .transaction(async (tx) => {
        await tx.insert(tasks).values(newTaskRecord(row.input, randomUUID(), new Date()));
        signalLocked();
        await release;
        throw sentinel;
      })
      .then(
        () => null,
        (error: unknown) => {
          signalFailed(error);
          return error;
        },
      );
    await locked;
    const repository = createPostgresTaskRepository(db);
    const operation = repository.createTask(row.input).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    try {
      let observedWait = false;
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const waiting =
          await db.$client`select pid from pg_stat_activity where datname = current_database() and state = 'active' and wait_event_type = 'Lock' and query ilike '%insert into "tasks"%'`;
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
      expect(await holding).toBe(sentinel);
      await blocker.$client.end();
    }
    const outcome = await operation;
    expect(outcome.error).toBeInstanceOf(Error);
    expect(
      await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.externalEventId, row.channelMessageId)),
    ).toHaveLength(0);
  });

  it('rejects stale, expired, erased, and source-altered attempts before task/event writes, then accepts exact replay', async () => {
    const fixture = await preparedTask();
    const repo = createPostgresTaskRepository(db);
    const eventRows = () =>
      db.select().from(tasks).where(eq(tasks.externalEventId, fixture.channelMessageId));

    await expect(
      repo.createTask({
        ...fixture.input,
        trigger: {
          ...fixture.input.trigger,
          payload: { ...fixture.input.trigger.payload, subject: 'Altered source' },
        },
      }),
    ).rejects.toThrow(/fence/);
    await expect(
      repo.createTask({
        ...fixture.input,
        emailObserverTaskFence: { ...fixture.fence, claimToken: randomUUID() },
      }),
    ).rejects.toThrow(/fence/);
    expect(await eventRows()).toEqual([]);

    await db
      .update(emailObserverWork)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(emailObserverWork.id, fixture.workId));
    await expect(repo.createTask(fixture.input)).rejects.toThrow(/fence/);
    expect(await eventRows()).toEqual([]);
    await db
      .update(emailObserverWork)
      .set({ leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(emailObserverWork.id, fixture.workId));

    await db.insert(maintenanceCursors).values({
      name: `privacy-erasure-generation:${agentId}`,
      cursor: 'erased-after-claim',
      updatedAt: new Date(),
    });
    await expect(repo.createTask(fixture.input)).rejects.toThrow(/fence/);
    expect(await eventRows()).toEqual([]);
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agentId}`));

    const created = await repo.createTask(fixture.input);
    expect(created.created).toBe(true);
    const replay = await repo.createTask(fixture.input);
    expect(replay).toMatchObject({ created: false, task: { id: created.task.id } });
    await expect(
      repo.createTask({
        ...fixture.input,
        trigger: {
          ...fixture.input.trigger,
          payload: { ...fixture.input.trigger.payload, subject: 'Altered after admission' },
        },
      }),
    ).rejects.toThrow(/fence/);
    expect(await eventRows()).toHaveLength(1);
  });
});
