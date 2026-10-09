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
  type Records,
  type TaskCreateInput,
  type TaskCreateResult,
  TaskRateLimitError,
} from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import { createWakeIntent } from './outbox.js';
import { assertPrivacyErasureGenerationInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

function textHash(value: string): string {
  return createHash('sha256').update('assistant-email-content-v1\0').update(value).digest('hex');
}

function expectedTaskTitle(subject: string): string | undefined {
  const value = subject.replace(/\s+/g, ' ').trim();
  if (!value) return undefined;
  return value.length > 80 ? `${value.slice(0, 79)}…` : value;
}

async function validateEmailObserverTaskFence(
  tx: Transaction,
  store: InstallationStore,
  input: TaskCreateInput,
): Promise<void> {
  const fence = input.emailObserverTaskFence;
  if (!fence) return;
  await assertPrivacyErasureGenerationInTransaction(
    tx,
    store,
    fence.agentId,
    fence.expectedPrivacyGeneration,
  );
  const workRef = store.doc('emailObserverWork', fence.id);
  const ingestQuery = store
    .collection('emailIngest')
    .where('agentId', '==', fence.agentId)
    .where('channelMessageId', '==', fence.channelMessageId)
    .limit(1);
  const workSnapshot = await tx.get(workRef);
  if (!workSnapshot.exists) throw new EmailObserverEffectFenceRejectedError();
  const work = decodeRecord<Records['emailObserverWork']>(workSnapshot.data());
  const now = store.now();
  if (
    !matchesPreparedEmailObserverClaim(work, fence, now) ||
    work.observerKey !== 'google.direct-email-routing' ||
    work.observerVersion !== 1 ||
    work.workClass !== 'idempotent_db' ||
    work.sourceKind !== 'message' ||
    work.sourceKey !== fence.channelMessageId ||
    work.channelMessageId !== fence.channelMessageId ||
    !work.preparedResult ||
    typeof work.preparedResult !== 'object' ||
    Array.isArray(work.preparedResult) ||
    Object.keys(work.preparedResult).length !== 1 ||
    (work.preparedResult as { route?: unknown }).route !== 'email_triage'
  )
    throw new EmailObserverEffectFenceRejectedError();

  const ingestSnapshot = await tx.get(ingestQuery);
  if (ingestSnapshot.empty || ingestSnapshot.size !== 1)
    throw new EmailObserverEffectFenceRejectedError();
  const ingest = decodeRecord<Records['emailIngest']>(ingestSnapshot.docs[0]?.data());
  if (
    ingest.agentId !== fence.agentId ||
    ingest.ingestMode !== 'direct' ||
    ingest.authenticated !== true ||
    !['owner', 'known', 'unknown'].includes(ingest.contentTrust) ||
    ingest.directRouting !== 'email_triage' ||
    ingest.directRecoveryReason !== null ||
    !ingest.providerMessageId ||
    ingest.channelMessageId !== `gmail:${ingest.providerMessageId}` ||
    ingest.admittedSourceKind !== 'message' ||
    !ingest.admittedSourceId ||
    !ingest.messagePersisted ||
    !ingest.conversationId ||
    !ingest.providerThreadId ||
    !isValidEmailContentProvenanceSnapshot(ingest.emailContentProvenance) ||
    ingest.emailContentProvenance.mode !== 'direct' ||
    ingest.emailContentProvenance.authenticated !== true ||
    ingest.emailContentProvenance.hasExternalOrUnknown !== ingest.hasExternalOrUnknown
  )
    throw new EmailObserverEffectFenceRejectedError();

  const channelRef = store.doc('messageChannelIds', fence.channelMessageId);
  const messageRef = store.doc('messages', ingest.admittedSourceId);
  const conversationRef = store.doc('conversations', ingest.conversationId);
  const [channelSnapshot, messageSnapshot, conversationSnapshot] = await tx.getAll(
    channelRef,
    messageRef,
    conversationRef,
  );
  if (!channelSnapshot?.exists || !messageSnapshot?.exists || !conversationSnapshot?.exists)
    throw new EmailObserverEffectFenceRejectedError();
  const message = decodeRecord<Records['messages']>(messageSnapshot.data());
  const conversation = decodeRecord<Records['conversations']>(conversationSnapshot.data());
  const expectedOrigin =
    ingest.contentTrust === 'owner'
      ? 'owner'
      : ingest.contentTrust === 'known'
        ? 'known_contact'
        : 'unknown';
  const messagePrefix = `From: ${ingest.fromEmail}\nSubject: ${ingest.subject}\n\n`;
  const storedBody = emailObserverMessageBody(message.parts);
  if (
    channelSnapshot.get('messageId') !== ingest.admittedSourceId ||
    channelSnapshot.get('conversationId') !== ingest.conversationId ||
    message.id !== ingest.admittedSourceId ||
    message.conversationId !== ingest.conversationId ||
    message.channelMessageId !== fence.channelMessageId ||
    message.role !== 'user' ||
    message.hiddenAt !== null ||
    message.origin !== expectedOrigin ||
    conversation.agentId !== fence.agentId ||
    conversation.channel !== 'email' ||
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
  if (!work.leaseExpiresAt || work.leaseExpiresAt.getTime() <= store.now().getTime())
    throw new EmailObserverEffectFenceRejectedError();
}

export async function createTask(
  store: InstallationStore,
  input: TaskCreateInput,
  transaction?: Transaction,
): Promise<TaskCreateResult> {
  const id = randomUUID();
  const eventRef = input.externalEventId
    ? store.doc('taskEventKeys', createHash('sha256').update(input.externalEventId).digest('hex'))
    : null;
  const createWithin = async (tx: Transaction): Promise<TaskCreateResult> => {
    if (input.emailObserverTaskFence) await validateEmailObserverTaskFence(tx, store, input);
    const guardRef = store.doc('coordination', 'external-task-enqueue');
    if (isExternalRoot(input)) await tx.get(guardRef);
    if (input.parentTaskId) {
      const parent = await tx.get(store.doc('tasks', input.parentTaskId));
      if (
        !parent.exists ||
        parent.get('agentId') !== input.agentId ||
        parent.get('id') !== input.parentTaskId ||
        documentKey(input.parentTaskId) !== parent.id
      )
        throw new Error('Task parent is missing or belongs to another agent');
    }
    if (eventRef) {
      const key = await tx.get(eventRef);
      if (key.exists) {
        const existing = await tx.get(store.doc('tasks', String(key.get('taskId'))));
        if (!existing.exists) throw new Error('Task event index points to a missing task');
        const task = decodeRecord<Records['tasks']>(existing.data());
        if (input.emailObserverTaskFence) await validateEmailObserverTaskFence(tx, store, input);
        return input.emailObserverTaskFence
          ? existingFencedTaskResult(task, input)
          : existingTaskResult(task, input);
      }
    }
    const now = store.now();
    if (isExternalRoot(input)) {
      const policy = await tx.get(store.doc('rateLimits', 'task'));
      // Installation bootstrap must explicitly supply a policy, even if caps are null.
      if (!policy.exists) throw new Error('Missing external task rate policy');
      for (const [cap, hours] of [
        [policy.get('maxPerHour'), 1],
        [policy.get('maxPerDay'), 24],
      ] as const) {
        if (cap === null) continue;
        if (!Number.isSafeInteger(cap) || cap < 0)
          throw new Error('Invalid external task rate policy');
        if (cap === 0) throw new TaskRateLimitError();
        const count = await tx.get(
          store
            .collection('tasks')
            .where('trust', 'in', ['known', 'unknown'])
            .where('parentTaskId', '==', null)
            .where('createdAt', '>=', new Date(now.getTime() - hours * 3_600_000))
            .limit(cap)
            .count(),
        );
        if (count.data().count >= cap) throw new TaskRateLimitError();
      }
    }
    if (input.emailObserverTaskFence) await validateEmailObserverTaskFence(tx, store, input);
    const task = newTaskRecord(input, id, now);
    // All reads precede writes; retry callbacks contain no external side effects.
    if (isExternalRoot(input)) tx.set(guardRef, { lastTaskId: id, updatedAt: now });
    tx.create(store.doc('tasks', id), encodeRecord(task));
    if (eventRef) tx.create(eventRef, { taskId: id, createdAt: now });
    createWakeIntent(tx, store, { taskId: id, generation: 0, availableAt: task.runAfter ?? now });
    return { task, created: true };
  };
  return transaction ? createWithin(transaction) : store.db.runTransaction(createWithin);
}
