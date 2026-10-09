import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  EmailObserverEffectFenceRejectedError,
  emailObserverMessageBody,
  existingFencedTaskResult,
  existingTaskResult,
  isExternalRoot,
  isValidEmailContentProvenanceSnapshot,
  matchesPreparedEmailObserverClaim,
  newTaskRecord,
  type TaskCreateInput,
  type TaskCreateResult,
  TaskRateLimitError,
} from '@assistant/persistence';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import {
  conversations,
  emailIngest,
  emailObserverWork,
  messages,
  rateLimits,
  tasks,
} from './schema.js';

type TaskTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

function textHash(value: string): string {
  return createHash('sha256').update('assistant-email-content-v1\0').update(value).digest('hex');
}

function expectedTaskTitle(subject: string): string | undefined {
  const value = subject.replace(/\s+/g, ' ').trim();
  if (!value) return undefined;
  return value.length > 80 ? `${value.slice(0, 79)}…` : value;
}

async function validateEmailObserverTaskFence(tx: Db, input: TaskCreateInput): Promise<void> {
  const fence = input.emailObserverTaskFence;
  if (!fence) return;
  const currentPrivacyGeneration = await lockPostgresPrivacyObservationFence(tx, fence.agentId);
  const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
  if (!clock) throw new Error('Missing database clock');
  const now = new Date(clock.now);
  const [work] = await tx
    .select()
    .from(emailObserverWork)
    .where(and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, fence.agentId)))
    .for('update')
    .limit(1);
  if (
    !work ||
    !matchesPreparedEmailObserverClaim(work ?? null, fence, now) ||
    currentPrivacyGeneration !== fence.expectedPrivacyGeneration ||
    work?.observerKey !== 'google.direct-email-routing' ||
    work.observerVersion !== 1 ||
    work.workClass !== 'idempotent_db' ||
    work.sourceKind !== 'message' ||
    work.sourceKey !== fence.channelMessageId ||
    work.channelMessageId !== fence.channelMessageId ||
    work.preparedResult === null ||
    typeof work.preparedResult !== 'object' ||
    Array.isArray(work.preparedResult) ||
    Object.keys(work.preparedResult).length !== 1 ||
    (work.preparedResult as { route?: unknown }).route !== 'email_triage'
  )
    throw new EmailObserverEffectFenceRejectedError();

  const [ingest] = await tx
    .select()
    .from(emailIngest)
    .where(
      and(
        eq(emailIngest.agentId, fence.agentId),
        eq(emailIngest.channelMessageId, fence.channelMessageId),
      ),
    )
    .for('update')
    .limit(1);
  if (
    !ingest ||
    ingest.ingestMode !== 'direct' ||
    ingest.authenticated !== true ||
    !['owner', 'known', 'unknown'].includes(ingest.contentTrust) ||
    ingest.directRouting !== 'email_triage' ||
    ingest.directRecoveryReason !== null ||
    ingest.providerMessageId === null ||
    ingest.providerMessageId.length === 0 ||
    ingest.channelMessageId !== `gmail:${ingest.providerMessageId}` ||
    ingest.admittedSourceKind !== 'message' ||
    !ingest.admittedSourceId ||
    !ingest.messagePersisted ||
    !ingest.conversationId ||
    !ingest.providerThreadId ||
    !isValidEmailContentProvenanceSnapshot(ingest.emailContentProvenance) ||
    ingest.emailContentProvenance.mode !== 'direct' ||
    ingest.emailContentProvenance.authenticated !== true ||
    ingest.emailContentProvenance.hasExternalOrUnknown !== ingest.hasExternalOrUnknown ||
    ingest.emailContentProvenance.messageHash.length !== 64
  )
    throw new EmailObserverEffectFenceRejectedError();
  const [conversation] = await tx
    .select({ agentId: conversations.agentId, channel: conversations.channel })
    .from(conversations)
    .where(eq(conversations.id, ingest.conversationId))
    .for('share')
    .limit(1);
  const [message] = await tx
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      role: messages.role,
      origin: messages.origin,
      text: messages.text,
      parts: messages.parts,
      channelMessageId: messages.channelMessageId,
      hiddenAt: messages.hiddenAt,
    })
    .from(messages)
    .where(eq(messages.id, ingest.admittedSourceId))
    .for('share')
    .limit(1);
  const expectedOrigin =
    ingest.contentTrust === 'owner'
      ? 'owner'
      : ingest.contentTrust === 'known'
        ? 'known_contact'
        : 'unknown';
  const messagePrefix = `From: ${ingest.fromEmail}\nSubject: ${ingest.subject}\n\n`;
  const storedBody = emailObserverMessageBody(message?.parts);
  if (
    !conversation ||
    conversation.agentId !== fence.agentId ||
    conversation.channel !== 'email' ||
    !message ||
    message.id !== ingest.admittedSourceId ||
    message.conversationId !== ingest.conversationId ||
    message.channelMessageId !== fence.channelMessageId ||
    message.role !== 'user' ||
    message.hiddenAt !== null ||
    message.origin !== expectedOrigin ||
    storedBody === null ||
    message.text !== messagePrefix + storedBody ||
    storedBody.length !== ingest.emailContentProvenance.storedLength ||
    ingest.emailContentProvenance.prefixLength !== messagePrefix.length ||
    textHash(storedBody) !== ingest.emailContentProvenance.bodyHash ||
    textHash(message.text) !== ingest.emailContentProvenance.messageHash
  )
    throw new EmailObserverEffectFenceRejectedError();

  const expectedEvent = {
    source: 'email',
    externalEventId: fence.channelMessageId,
    agentId: fence.agentId,
    conversationId: ingest.conversationId,
    trust: ingest.contentTrust,
    payload: {
      threadId: ingest.providerThreadId,
      messageId: ingest.providerMessageId,
      rfcMessageId: ingest.sourceMessageId,
      from: ingest.fromEmail,
      subject: ingest.subject,
      quotesExternalContent: ingest.hasExternalOrUnknown,
      emailProvenance: ingest.emailContentProvenance,
      ingest: {
        forwarded: false,
        contentTrust: ingest.contentTrust,
        authenticated: true,
        importance: ingest.importance,
        category: ingest.category,
        ownerAlerted: false,
      },
    },
  };
  if (
    input.agentId !== fence.agentId ||
    input.conversationId !== ingest.conversationId ||
    input.type !== 'email_triage' ||
    input.trust !== ingest.contentTrust ||
    input.externalEventId !== fence.channelMessageId ||
    input.title !== expectedTaskTitle(ingest.subject) ||
    input.maxSteps !== 16 ||
    input.budgetUsdLimit !== '1.20' ||
    input.goalId !== undefined ||
    input.parentTaskId !== undefined ||
    input.runAfter !== undefined ||
    input.deadline !== undefined ||
    input.plan !== undefined ||
    input.autonomyGrant !== undefined ||
    input.nextAction !== undefined ||
    input.reflectEvery !== undefined ||
    !isDeepStrictEqual(input.trigger, expectedEvent)
  )
    throw new EmailObserverEffectFenceRejectedError();
  const [finalClock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
  if (
    !finalClock ||
    !work.leaseExpiresAt ||
    work.leaseExpiresAt.getTime() <= new Date(finalClock.now).getTime()
  )
    throw new EmailObserverEffectFenceRejectedError();
}

/** Also works inside a caller's transaction; queue notification belongs after commit. */
export async function createTask(
  db: Db,
  input: TaskCreateInput,
  transaction?: TaskTransaction,
): Promise<TaskCreateResult> {
  const createWithin = async (tx: TaskTransaction): Promise<TaskCreateResult> => {
    if (input.emailObserverTaskFence)
      await validateEmailObserverTaskFence(tx as unknown as Db, input);
    // A shared lock serializes the count + insert, including when no policy row exists.
    // Owner work and internal children never wait on this external flood backstop.
    if (isExternalRoot(input))
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('assistant:external-task-limit'))`,
      );
    if (input.parentTaskId) {
      const [parent] = await tx
        .select({ agentId: tasks.agentId })
        .from(tasks)
        .where(eq(tasks.id, input.parentTaskId))
        .for('share')
        .limit(1);
      if (!parent || parent.agentId !== input.agentId)
        throw new Error('Task parent is missing or belongs to another agent');
    }
    if (input.externalEventId) {
      const [existing] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.externalEventId, input.externalEventId));
      if (existing) {
        if (input.emailObserverTaskFence)
          await validateEmailObserverTaskFence(tx as unknown as Db, input);
        return input.emailObserverTaskFence
          ? existingFencedTaskResult(existing, input)
          : existingTaskResult(existing, input);
      }
    }
    if (isExternalRoot(input)) {
      const [policy] = await tx.select().from(rateLimits).where(eq(rateLimits.scope, 'task'));
      for (const [cap, hours] of [
        [policy?.maxPerHour, 1],
        [policy?.maxPerDay, 24],
      ] as const) {
        if (cap == null) continue;
        const [count] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(tasks)
          .where(
            and(
              inArray(tasks.trust, ['known', 'unknown']),
              isNull(tasks.parentTaskId),
              gte(tasks.createdAt, sql`clock_timestamp() - ${hours} * interval '1 hour'`),
            ),
          );
        if (Number(count?.n ?? 0) >= cap) throw new TaskRateLimitError();
      }
    }
    if (input.emailObserverTaskFence)
      await validateEmailObserverTaskFence(tx as unknown as Db, input);
    const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    if (!clock) throw new Error('Missing database clock');
    const row = newTaskRecord(input, randomUUID(), new Date(clock.now));
    const [task] = await tx
      .insert(tasks)
      .values(row)
      .onConflictDoNothing({
        target: tasks.externalEventId,
        where: sql`${tasks.externalEventId} IS NOT NULL`,
      })
      .returning();
    // A competing event insert can hold the unique index until this claim expires.
    // Revalidate after that wait so a successful new insert is still rolled back.
    if (input.emailObserverTaskFence)
      await validateEmailObserverTaskFence(tx as unknown as Db, input);
    if (task) return { task, created: true };
    if (input.externalEventId) {
      const [existing] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.externalEventId, input.externalEventId));
      if (existing) {
        if (input.emailObserverTaskFence)
          await validateEmailObserverTaskFence(tx as unknown as Db, input);
        return input.emailObserverTaskFence
          ? existingFencedTaskResult(existing, input)
          : existingTaskResult(existing, input);
      }
    }
    throw new Error('Task creation conflict without an existing task');
  };
  return transaction ? createWithin(transaction) : db.transaction((tx) => createWithin(tx));
}
