import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  ApplicationConfirmationAmbiguousInput,
  ApplicationConfirmationAmbiguousResult,
  ApplicationConfirmationClaimInput,
  ApplicationConfirmationRecord,
  ApplicationConfirmationRepository,
  ApplicationExternalEffectClaimInput,
  ApplicationExternalEffectSettlementInput,
} from '@assistant/persistence';
import {
  applicationConfirmationAmbiguousNotice,
  applicationConfirmationAmbiguousProgress,
  applicationConfirmationAmbiguousTaskInput,
  applicationConfirmationSourceDigest,
  applicationConfirmationTaskInput,
  applicationConfirmationTokenInSource,
  applicationExternalEffectArgsDigest,
  applicationExternalEffectToolIdentity,
  EmailObserverEffectFenceRejectedError,
  emailObserverMessageBody,
  existingFencedTaskResult,
  matchesPreparedEmailObserverClaim,
} from '@assistant/persistence';
import { and, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  lockPostgresPrivacyCleanupFence,
  lockPostgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import {
  applicationConfirmations,
  conversations,
  emailIngest,
  emailObserverWork,
  messages,
  tasks,
  toolCalls,
} from './schema.js';
import { createTask as createTaskInTransaction } from './task-creation-repository.js';

async function preparedApplicationEmailSourceIsCurrent(
  tx: Db,
  input: ApplicationConfirmationClaimInput,
): Promise<boolean> {
  const fence = input.emailObserverEffectFence;
  if (!fence || !input.confirmationTokenHash || !input.sourceDigest) return false;
  if (!input.confirmationMessageId.startsWith('gmail:')) return false;
  const providerMessageId = input.confirmationMessageId.slice('gmail:'.length);
  if (!providerMessageId) return false;
  if (
    (await lockPostgresPrivacyObservationFence(tx, fence.agentId)) !==
    fence.expectedPrivacyGeneration
  )
    return false;

  const [work] = await tx
    .select()
    .from(emailObserverWork)
    .where(and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, fence.agentId)))
    .for('update')
    .limit(1);
  if (
    !matchesPreparedEmailObserverClaim(work ?? null, fence, new Date()) ||
    (work?.observerKey !== 'google.application-confirmation' &&
      work?.observerKey !== 'google.direct-email-routing') ||
    work?.observerVersion !== 1 ||
    work?.sourceKind !== 'message' ||
    work?.sourceKey !== input.confirmationMessageId ||
    work?.channelMessageId !== input.confirmationMessageId
  )
    return false;

  const [ingest] = await tx
    .select()
    .from(emailIngest)
    .where(
      and(
        eq(emailIngest.agentId, fence.agentId),
        eq(emailIngest.channelMessageId, input.confirmationMessageId),
      ),
    )
    .for('share')
    .limit(2);
  if (
    ingest?.ingestMode !== 'direct' ||
    !ingest.authenticated ||
    ingest.emailContentProvenance?.authenticated !== true ||
    ingest.emailContentProvenance.hasExternalOrUnknown !== ingest.hasExternalOrUnknown ||
    (work.observerKey === 'google.direct-email-routing' &&
      ingest.directRouting !== 'application_confirmation') ||
    (work.observerKey === 'google.application-confirmation' && ingest.directRouting !== null) ||
    ingest.providerMessageId !== providerMessageId ||
    ingest.fromEmail.trim().toLowerCase() !== input.confirmationFrom.trim().toLowerCase() ||
    ingest.admittedSourceKind !== 'message' ||
    !ingest.admittedSourceId
  )
    return false;
  const [message] = await tx
    .select()
    .from(messages)
    .where(eq(messages.channelMessageId, input.confirmationMessageId))
    .for('share')
    .limit(2);
  if (
    !message ||
    message.id !== ingest.admittedSourceId ||
    message.hiddenAt !== null ||
    message.role !== 'user' ||
    message.conversationId !== ingest.conversationId
  )
    return false;
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, message.conversationId))
    .for('share')
    .limit(1);
  const body = emailObserverMessageBody(message.parts);
  if (
    !conversation ||
    conversation.agentId !== fence.agentId ||
    body === null ||
    !applicationConfirmationTokenInSource({
      tokenHash: input.confirmationTokenHash,
      subject: ingest.subject,
      body,
      provenance: ingest.emailContentProvenance,
    }) ||
    applicationConfirmationSourceDigest({
      confirmationMessageId: message.channelMessageId ?? '',
      confirmationFrom: ingest.fromEmail,
      subject: ingest.subject,
      body,
    }) !== input.sourceDigest
  )
    return false;
  return true;
}

/** Application confirmation watches with the queries the tools and email match always ran. */
export function createPostgresApplicationConfirmationRepository(
  db: Db,
): ApplicationConfirmationRepository {
  const byId = async (id: string) => {
    const [record] = await db
      .select()
      .from(applicationConfirmations)
      .where(eq(applicationConfirmations.id, id));
    return (record as ApplicationConfirmationRecord | undefined) ?? null;
  };
  return {
    kind: 'application-confirmation-repository',
    async createWatch(input) {
      const [existing] = await db
        .select({ id: applicationConfirmations.id })
        .from(applicationConfirmations)
        .where(
          and(
            eq(applicationConfirmations.agentId, input.agentId),
            eq(applicationConfirmations.confirmationTokenHash, input.confirmationTokenHash),
            eq(applicationConfirmations.status, 'awaiting_confirmation'),
          ),
        )
        .limit(1);
      if (existing) throw new Error('an active confirmation watch already uses this token');
      let conversationId = input.conversationId;
      if (!conversationId) {
        const [conversation] = await db
          .insert(conversations)
          .values({
            agentId: input.agentId,
            channel: 'chat',
            trust: 'owner',
            title: input.newConversationTitle,
          })
          .returning({ id: conversations.id });
        if (!conversation) throw new Error('failed to create application follow-up chat');
        conversationId = conversation.id;
      }
      const [record] = await db
        .insert(applicationConfirmations)
        .values({
          agentId: input.agentId,
          sourceTaskId: input.sourceTaskId,
          conversationId,
          company: input.company,
          role: input.role,
          expectedSenderEmails: input.expectedSenderEmails,
          confirmationTokenHash: input.confirmationTokenHash,
          confirmationTokenHint: input.confirmationTokenHint,
          trackerUpdate: input.trackerUpdate,
          documentUpdate: input.documentUpdate,
          actionState: input.actionState,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!record) throw new Error('failed to create application confirmation watch');
      return record as ApplicationConfirmationRecord;
    },
    async list(agentId, status) {
      const rows = await db
        .select()
        .from(applicationConfirmations)
        .where(
          status
            ? and(
                eq(applicationConfirmations.agentId, agentId),
                eq(applicationConfirmations.status, status),
              )
            : eq(applicationConfirmations.agentId, agentId),
        )
        .orderBy(desc(applicationConfirmations.createdAt))
        .limit(100);
      return rows as ApplicationConfirmationRecord[];
    },
    async cancel(agentId, id, now) {
      const [cancelled] = await db
        .update(applicationConfirmations)
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(applicationConfirmations.id, id),
            eq(applicationConfirmations.agentId, agentId),
            eq(applicationConfirmations.status, 'awaiting_confirmation'),
          ),
        )
        .returning({ id: applicationConfirmations.id });
      if (cancelled) return { id: cancelled.id, status: 'cancelled', cancelled: true };
      const [current] = await db
        .select({ id: applicationConfirmations.id, status: applicationConfirmations.status })
        .from(applicationConfirmations)
        .where(
          and(eq(applicationConfirmations.id, id), eq(applicationConfirmations.agentId, agentId)),
        );
      return current ? { id: current.id, status: current.status, cancelled: false } : null;
    },
    get: byId,
    async updateActionState(id, input) {
      const [updated] = await db
        .update(applicationConfirmations)
        .set({
          actionState: input.actionState,
          ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
          ...(input.status ? { status: input.status } : {}),
          updatedAt: input.now,
        })
        .where(
          input.requireStatus
            ? and(
                eq(applicationConfirmations.id, id),
                eq(applicationConfirmations.status, input.requireStatus),
              )
            : eq(applicationConfirmations.id, id),
        )
        .returning();
      return (updated as ApplicationConfirmationRecord | undefined) ?? null;
    },
    async claimExternalEffect(input: ApplicationExternalEffectClaimInput) {
      const claimToken = randomUUID();
      try {
        return await db.transaction(async (tx) => {
          // This is the same first owner lock used by memory erasure. The
          // transaction commits the unknown receipt before any Google call.
          const generation = await lockPostgresPrivacyObservationFence(tx, input.agentId);
          if (generation !== input.expectedProducerPrivacyGeneration) return { status: 'blocked' };

          const [current] = await tx
            .select()
            .from(applicationConfirmations)
            .where(eq(applicationConfirmations.id, input.applicationId))
            .for('update')
            .limit(1);
          if (
            !current ||
            current.agentId !== input.agentId ||
            current.status !== 'confirmation_received' ||
            (current.producerPrivacyGeneration ?? null) !== input.expectedProducerPrivacyGeneration
          )
            return { status: 'blocked' };

          const [task] = await tx
            .select()
            .from(tasks)
            .where(and(eq(tasks.id, input.taskId), eq(tasks.agentId, input.agentId)))
            .for('update')
            .limit(1);
          const trigger = task?.trigger as
            | { source?: unknown; payload?: Record<string, unknown> }
            | undefined;
          const triggerPayload = trigger?.payload;
          const expectedEventId = `application-confirmation:${current.confirmationMessageId ?? ''}`;
          const canonicalIdentity = applicationExternalEffectToolIdentity(
            input.action,
            input.applicationId,
          );
          if (
            trigger?.source !== 'internal' ||
            triggerPayload?.kind !== 'application_confirmation' ||
            triggerPayload.applicationId !== input.applicationId ||
            typeof current.confirmationMessageId !== 'string' ||
            triggerPayload.confirmationMessageId !== current.confirmationMessageId ||
            !Object.hasOwn(triggerPayload, 'producerPrivacyGeneration') ||
            triggerPayload.producerPrivacyGeneration !== input.expectedProducerPrivacyGeneration ||
            task?.externalEventId !== expectedEventId ||
            task.status !== 'running' ||
            task.leaseToken !== input.taskLeaseToken ||
            input.toolName !== canonicalIdentity.toolName ||
            input.idempotencyKey !== canonicalIdentity.idempotencyKey
          )
            return { status: 'blocked' };

          const [call] = await tx
            .select()
            .from(toolCalls)
            .where(eq(toolCalls.id, input.toolCallId))
            .for('update')
            .limit(1);
          const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
          const dispatchAt = clock ? new Date(clock.now) : new Date();
          const callArgs = call?.args as { applicationId?: unknown } | undefined;
          if (
            !call ||
            !task ||
            call.taskId !== input.taskId ||
            call.toolName !== canonicalIdentity.toolName ||
            call.idempotencyKey !== canonicalIdentity.idempotencyKey ||
            call.status !== 'executing' ||
            !task.lockedUntil ||
            task.lockedUntil <= dispatchAt ||
            callArgs?.applicationId !== input.applicationId
          )
            return { status: 'blocked' };

          const state = (current.actionState ?? {}) as Record<string, unknown>;
          const actionKey = input.action === 'sheet' ? 'sheet' : 'document';
          const prior = state[actionKey] as { status?: unknown } | undefined;
          const frozenArgs =
            input.action === 'sheet' ? current.trackerUpdate : current.documentUpdate;
          if (
            prior?.status !== 'pending' ||
            applicationExternalEffectArgsDigest(input.action, frozenArgs) !== input.argsDigest
          )
            return { status: 'blocked' };

          const receipt = {
            claimToken,
            producerPrivacyGeneration: input.expectedProducerPrivacyGeneration,
            argsDigest: input.argsDigest,
            taskId: input.taskId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            idempotencyKey: input.idempotencyKey,
          };
          const nextAction = {
            ...(prior ?? {}),
            status: 'unknown',
            error: 'The provider outcome is unresolved; automatic retry is suppressed.',
            effectReceipt: receipt,
          };
          const nextState = { ...state, [actionKey]: nextAction };
          const [updated] = await tx
            .update(applicationConfirmations)
            .set({ actionState: nextState, updatedAt: dispatchAt })
            .where(eq(applicationConfirmations.id, input.applicationId))
            .returning();
          return updated
            ? {
                status: 'claimed',
                claimToken,
                record: updated as ApplicationConfirmationRecord,
              }
            : { status: 'blocked' };
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'Privacy erasure is in progress')
          return { status: 'blocked' };
        throw error;
      }
    },
    async settleExternalEffect(input: ApplicationExternalEffectSettlementInput) {
      return db.transaction(async (tx) => {
        // Settlement is allowed after erasure starts, but serializes with its
        // owner fence and updates only the opaque action receipt.
        await lockPostgresPrivacyCleanupFence(tx, input.agentId);
        const [current] = await tx
          .select()
          .from(applicationConfirmations)
          .where(eq(applicationConfirmations.id, input.applicationId))
          .for('update')
          .limit(1);
        if (!current || current.agentId !== input.agentId) return null;
        const state = (current.actionState ?? {}) as Record<string, unknown>;
        const actionKey = input.action === 'sheet' ? 'sheet' : 'document';
        const prior = state[actionKey] as
          | {
              status?: unknown;
              error?: unknown;
              effectReceipt?: { claimToken?: unknown };
            }
          | undefined;
        if (prior?.status !== 'unknown' || prior.effectReceipt?.claimToken !== input.claimToken)
          return null;
        const { error: _priorError, ...priorWithoutError } = prior;
        const nextState = {
          ...state,
          [actionKey]: {
            ...priorWithoutError,
            status: input.status,
            ...(input.error !== undefined ? { error: input.error } : {}),
          },
        };
        const [updated] = await tx
          .update(applicationConfirmations)
          .set({ actionState: nextState, updatedAt: input.now })
          .where(eq(applicationConfirmations.id, input.applicationId))
          .returning();
        return (updated as ApplicationConfirmationRecord | undefined) ?? null;
      });
    },
    async expireDue(now, agentId) {
      const expired = await db
        .update(applicationConfirmations)
        .set({ status: 'expired', updatedAt: now })
        .where(
          and(
            ...(agentId ? [eq(applicationConfirmations.agentId, agentId)] : []),
            eq(applicationConfirmations.status, 'awaiting_confirmation'),
            lte(applicationConfirmations.expiresAt, now),
          ),
        )
        .returning();
      return expired as ApplicationConfirmationRecord[];
    },
    async byConfirmationMessage(agentId, confirmationMessageId) {
      const [record] = await db
        .select()
        .from(applicationConfirmations)
        .where(
          and(
            eq(applicationConfirmations.agentId, agentId),
            eq(applicationConfirmations.confirmationMessageId, confirmationMessageId),
          ),
        );
      return (record as ApplicationConfirmationRecord | undefined) ?? null;
    },
    async awaitingFrom(agentId, from, now) {
      const rows = await db
        .select()
        .from(applicationConfirmations)
        .where(
          and(
            eq(applicationConfirmations.agentId, agentId),
            eq(applicationConfirmations.status, 'awaiting_confirmation'),
            gt(applicationConfirmations.expiresAt, now),
            sql`${from} = ANY(${applicationConfirmations.expectedSenderEmails})`,
          ),
        );
      return rows as ApplicationConfirmationRecord[];
    },
    async claim(id, input) {
      if (input.emailObserverEffectFence) {
        const fence = input.emailObserverEffectFence;
        return db.transaction(async (tx) => {
          if (!(await preparedApplicationEmailSourceIsCurrent(tx as unknown as Db, input)))
            return null;
          const [current] = await tx
            .select()
            .from(applicationConfirmations)
            .where(eq(applicationConfirmations.id, id))
            .for('update')
            .limit(1);
          const [liveWork] = await tx
            .select()
            .from(emailObserverWork)
            .where(
              and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, fence.agentId)),
            )
            .for('update')
            .limit(1);
          const now = new Date();
          const from = input.confirmationFrom.trim().toLowerCase();
          if (
            !current ||
            current.agentId !== fence.agentId ||
            current.status !== 'awaiting_confirmation' ||
            current.expiresAt <= now ||
            !matchesPreparedEmailObserverClaim(liveWork ?? null, fence, now) ||
            !current.expectedSenderEmails.some((sender) => sender.trim().toLowerCase() === from) ||
            current.confirmationTokenHash !== input.confirmationTokenHash
          )
            return null;
          const [claimed] = await tx
            .update(applicationConfirmations)
            .set({
              status: 'confirmation_received',
              confirmationMessageId: input.confirmationMessageId,
              confirmationFrom: from,
              confirmedAt: now,
              lastError: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(applicationConfirmations.id, id),
                eq(applicationConfirmations.agentId, fence.agentId),
                eq(applicationConfirmations.status, 'awaiting_confirmation'),
                gt(applicationConfirmations.expiresAt, now),
                eq(applicationConfirmations.confirmationTokenHash, input.confirmationTokenHash),
              ),
            )
            .returning();
          return (claimed as ApplicationConfirmationRecord | undefined) ?? null;
        });
      }
      const [claimed] = await db
        .update(applicationConfirmations)
        .set({
          status: 'confirmation_received',
          confirmationMessageId: input.confirmationMessageId,
          confirmationFrom: input.confirmationFrom,
          confirmedAt: input.now,
          lastError: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(applicationConfirmations.id, id),
            eq(applicationConfirmations.status, 'awaiting_confirmation'),
            gt(applicationConfirmations.expiresAt, input.now),
          ),
        )
        .returning();
      return (claimed as ApplicationConfirmationRecord | undefined) ?? null;
    },
    async claimAndEnqueue(id, input) {
      const fence = input.emailObserverEffectFence;
      return db.transaction(async (tx) => {
        if (!(await preparedApplicationEmailSourceIsCurrent(tx as unknown as Db, input)))
          return null;
        const [current] = await tx
          .select()
          .from(applicationConfirmations)
          .where(eq(applicationConfirmations.id, id))
          .for('update')
          .limit(1);
        const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
        const [source] = await tx
          .select({ subject: emailIngest.subject })
          .from(emailIngest)
          .where(
            and(
              eq(emailIngest.agentId, fence.agentId),
              eq(emailIngest.channelMessageId, input.confirmationMessageId),
            ),
          )
          .limit(1);
        if (!current || !clock || !source || current.agentId !== fence.agentId) return null;
        const now = new Date(clock.now);
        if (
          current.confirmationTokenHash !== input.confirmationTokenHash ||
          !current.expectedSenderEmails.some(
            (sender) => sender.trim().toLowerCase() === input.confirmationFrom.trim().toLowerCase(),
          )
        )
          return null;
        const assertClaimAtCommit = async () => {
          // The watch and task event can block after the initial source validation.
          // Read the database clock only after those waits, while the owner/work locks remain held.
          const [liveWork] = await tx
            .select()
            .from(emailObserverWork)
            .where(
              and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, fence.agentId)),
            )
            .limit(1);
          const [commitClock] = await tx.execute<{ now: string }>(
            sql`select clock_timestamp() as now`,
          );
          const commitNow = commitClock ? new Date(commitClock.now) : null;
          if (
            !commitNow ||
            !matchesPreparedEmailObserverClaim(liveWork ?? null, fence, commitNow) ||
            (current.status === 'awaiting_confirmation' && current.expiresAt <= commitNow)
          )
            throw new Error('Application confirmation claim expired before handoff commit');
        };
        const taskInput = applicationConfirmationTaskInput({
          agentId: fence.agentId,
          applicationId: current.id,
          confirmationMessageId: input.confirmationMessageId,
          conversationId: current.conversationId,
          subject: source.subject,
          producerPrivacyGeneration: fence.expectedPrivacyGeneration,
        });

        if (current.status === 'awaiting_confirmation') {
          if (current.expiresAt <= now) return null;
          const [claimed] = await tx
            .update(applicationConfirmations)
            .set({
              status: 'confirmation_received',
              confirmationMessageId: input.confirmationMessageId,
              confirmationFrom: input.confirmationFrom.trim().toLowerCase(),
              confirmedAt: now,
              producerPrivacyGeneration: fence.expectedPrivacyGeneration,
              lastError: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(applicationConfirmations.id, id),
                eq(applicationConfirmations.agentId, fence.agentId),
                eq(applicationConfirmations.status, 'awaiting_confirmation'),
                gt(applicationConfirmations.expiresAt, now),
                eq(applicationConfirmations.confirmationTokenHash, input.confirmationTokenHash),
              ),
            )
            .returning();
          if (!claimed) return null;
          const task = await createTaskInTransaction(db, taskInput, tx);
          const exactTask = existingFencedTaskResult(task.task, taskInput).task;
          await assertClaimAtCommit();
          return {
            record: claimed as ApplicationConfirmationRecord,
            task: exactTask,
            created: task.created,
          };
        }

        if (
          current.status !== 'confirmation_received' ||
          current.confirmationMessageId !== input.confirmationMessageId ||
          current.producerPrivacyGeneration !== fence.expectedPrivacyGeneration
        )
          return null;
        const [existing] = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.externalEventId, taskInput.externalEventId ?? ''))
          .limit(1);
        if (!existing) return null;
        const replay = await createTaskInTransaction(db, taskInput, tx);
        const exactTask = existingFencedTaskResult(replay.task, taskInput).task;
        await assertClaimAtCommit();
        return {
          record: current as ApplicationConfirmationRecord,
          task: exactTask,
          created: false,
        };
      });
    },
    async recordAmbiguousObserver(
      input: ApplicationConfirmationAmbiguousInput,
    ): Promise<ApplicationConfirmationAmbiguousResult> {
      const fence = input.emailObserverEffectFence;
      return db.transaction(async (tx) => {
        if (
          (await lockPostgresPrivacyObservationFence(tx as unknown as Db, fence.agentId)) !==
          fence.expectedPrivacyGeneration
        )
          throw new EmailObserverEffectFenceRejectedError();
        const [work] = await tx
          .select()
          .from(emailObserverWork)
          .where(
            and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, fence.agentId)),
          )
          .for('update')
          .limit(1);
        const [startClock] = await tx.execute<{ now: string }>(
          sql`select clock_timestamp() as now`,
        );
        const startNow = startClock ? new Date(startClock.now) : null;
        if (
          !startNow ||
          !matchesPreparedEmailObserverClaim(work ?? null, fence, startNow) ||
          !['google.application-confirmation', 'google.direct-email-routing'].includes(
            work?.observerKey ?? '',
          ) ||
          work?.observerVersion !== 1 ||
          work?.workClass !== 'idempotent_db' ||
          work?.sourceKind !== 'message' ||
          work?.sourceKey !== work?.channelMessageId ||
          !work?.channelMessageId
        )
          throw new EmailObserverEffectFenceRejectedError();

        const channelMessageId = work.channelMessageId;
        const providerMessageId = channelMessageId.startsWith('gmail:')
          ? channelMessageId.slice('gmail:'.length)
          : '';
        const [ingest] = await tx
          .select()
          .from(emailIngest)
          .where(
            and(
              eq(emailIngest.agentId, fence.agentId),
              eq(emailIngest.channelMessageId, channelMessageId),
            ),
          )
          .for('share')
          .limit(1);
        if (
          !ingest ||
          !providerMessageId ||
          ingest.ingestMode !== 'direct' ||
          ingest.authenticated !== true ||
          ingest.emailContentProvenance?.authenticated !== true ||
          ingest.emailContentProvenance?.mode !== 'direct' ||
          ingest.emailContentProvenance.hasExternalOrUnknown !== ingest.hasExternalOrUnknown ||
          (work.observerKey === 'google.direct-email-routing' &&
            ingest.directRouting !== 'application_confirmation') ||
          (work.observerKey === 'google.application-confirmation' &&
            ingest.directRouting !== null) ||
          ingest.providerMessageId !== providerMessageId ||
          ingest.channelMessageId !== `gmail:${ingest.providerMessageId}` ||
          ingest.admittedSourceKind !== 'message' ||
          !ingest.admittedSourceId ||
          !ingest.conversationId
        )
          throw new EmailObserverEffectFenceRejectedError();

        const [source] = await tx
          .select()
          .from(messages)
          .where(eq(messages.id, ingest.admittedSourceId))
          .for('share')
          .limit(1);
        const [conversation] = await tx
          .select()
          .from(conversations)
          .where(eq(conversations.id, ingest.conversationId))
          .for('share')
          .limit(1);
        const body = emailObserverMessageBody(source?.parts);
        const from = ingest.fromEmail.trim().toLowerCase();
        if (
          !source ||
          source.hiddenAt !== null ||
          source.role !== 'user' ||
          source.conversationId !== ingest.conversationId ||
          source.channelMessageId !== channelMessageId ||
          conversation?.agentId !== fence.agentId ||
          conversation.channel !== 'email' ||
          body === null
        )
          throw new EmailObserverEffectFenceRejectedError();

        const watchRows = await tx
          .select()
          .from(applicationConfirmations)
          .where(
            and(
              eq(applicationConfirmations.agentId, fence.agentId),
              eq(applicationConfirmations.status, 'awaiting_confirmation'),
              sql`${from} = ANY(${applicationConfirmations.expectedSenderEmails})`,
              gt(applicationConfirmations.expiresAt, startNow),
            ),
          )
          .orderBy(applicationConfirmations.id)
          .limit(101)
          .for('update');
        if (watchRows.length > 100) throw new Error('application_confirmation_watch_limit');

        const [commitClock] = await tx.execute<{ now: string }>(
          sql`select clock_timestamp() as now`,
        );
        const now = commitClock ? new Date(commitClock.now) : null;
        const [liveWork] = await tx
          .select()
          .from(emailObserverWork)
          .where(
            and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, fence.agentId)),
          )
          .limit(1);
        if (
          !now ||
          (await lockPostgresPrivacyObservationFence(tx as unknown as Db, fence.agentId)) !==
            fence.expectedPrivacyGeneration ||
          !matchesPreparedEmailObserverClaim(liveWork ?? null, fence, now)
        )
          throw new EmailObserverEffectFenceRejectedError();

        const matches = watchRows
          .filter(
            (watch) =>
              watch.expiresAt > now &&
              watch.expectedSenderEmails.some((sender) => sender.trim().toLowerCase() === from) &&
              applicationConfirmationTokenInSource({
                tokenHash: watch.confirmationTokenHash,
                subject: ingest.subject,
                body,
                provenance: ingest.emailContentProvenance,
              }),
          )
          .sort((left, right) =>
            left.id.localeCompare(right.id),
          ) as ApplicationConfirmationRecord[];
        if (matches.length < 2) return { kind: 'not_ambiguous' };

        const taskInput = applicationConfirmationAmbiguousTaskInput({
          agentId: fence.agentId,
          confirmationMessageId: channelMessageId,
          from,
          matches,
        });
        const taskExternalEventId = taskInput.externalEventId ?? '';
        const expectedProgress = applicationConfirmationAmbiguousProgress(from, matches.length);
        const noticeText = applicationConfirmationAmbiguousNotice({ from, matches });
        const noticeSpecs = matches
          .filter((watch) => watch.conversationId)
          .map((watch) => ({
            channelMessageId: `application-confirmation-notice:${taskExternalEventId}:ambiguous:${watch.id}`,
            conversationId: watch.conversationId as string,
            text: noticeText,
          }));
        const conversationIds = [...new Set(noticeSpecs.map((notice) => notice.conversationId))];
        const noticeIds = noticeSpecs.map((notice) => notice.channelMessageId);
        const existingTaskRows = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.externalEventId, taskExternalEventId))
          .limit(2);
        const existingTask = existingTaskRows[0];
        const existingNotices = noticeIds.length
          ? await tx.select().from(messages).where(inArray(messages.channelMessageId, noticeIds))
          : [];
        const noticeConversations = conversationIds.length
          ? await tx
              .select({ id: conversations.id, agentId: conversations.agentId })
              .from(conversations)
              .where(inArray(conversations.id, conversationIds))
          : [];
        if (
          noticeConversations.length !== conversationIds.length ||
          noticeConversations.some((row) => row.agentId !== fence.agentId)
        )
          throw new EmailObserverEffectFenceRejectedError();
        const expectedTaskTrigger = taskInput.trigger;
        if (existingTask) {
          const exactTask =
            existingTaskRows.length === 1 &&
            existingTask.agentId === fence.agentId &&
            existingTask.type === 'adhoc' &&
            existingTask.trust === 'assistant' &&
            existingTask.status === 'needs_attention' &&
            existingTask.progress === expectedProgress.slice(0, 500) &&
            existingTask.externalEventId === taskExternalEventId &&
            isDeepStrictEqual(existingTask.trigger, expectedTaskTrigger);
          const exactNotices = noticeSpecs.every((notice) =>
            existingNotices.some(
              (row) =>
                row.channelMessageId === notice.channelMessageId &&
                row.taskId === existingTask.id &&
                row.conversationId === notice.conversationId &&
                row.role === 'assistant' &&
                row.origin === 'assistant' &&
                row.text === notice.text &&
                row.hiddenAt === null,
            ),
          );
          if (!exactTask || existingNotices.length !== noticeSpecs.length || !exactNotices)
            throw new Error('application_confirmation_ambiguous_replay_mismatch');
          const [finalClock] = await tx.execute<{ now: string }>(
            sql`select clock_timestamp() as now`,
          );
          const [finalWork] = await tx
            .select()
            .from(emailObserverWork)
            .where(
              and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, fence.agentId)),
            )
            .limit(1);
          if (
            !finalClock ||
            (await lockPostgresPrivacyObservationFence(tx as unknown as Db, fence.agentId)) !==
              fence.expectedPrivacyGeneration ||
            !matchesPreparedEmailObserverClaim(finalWork ?? null, fence, new Date(finalClock.now))
          )
            throw new EmailObserverEffectFenceRejectedError();
          return {
            kind: 'replay',
            taskId: existingTask.id,
            from,
            applicationIds: matches.map((watch) => watch.id),
          };
        }
        if (existingNotices.length)
          throw new Error('application_confirmation_ambiguous_notice_without_task');
        const created = await createTaskInTransaction(db, taskInput, tx);
        if (!created.created) throw new Error('application_confirmation_ambiguous_task_race');
        const [parked] = await tx
          .update(tasks)
          .set({
            status: 'needs_attention',
            progress: expectedProgress.slice(0, 500),
            lockedUntil: null,
            runAfter: null,
            attempt: 0,
            attentionNotifiedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.id, created.task.id),
              eq(tasks.agentId, fence.agentId),
              eq(tasks.status, 'pending'),
            ),
          )
          .returning({ id: tasks.id });
        if (!parked) throw new Error('application_confirmation_ambiguous_task_park_failed');
        for (const notice of noticeSpecs) {
          const [row] = await tx
            .insert(messages)
            .values({
              conversationId: notice.conversationId,
              taskId: created.task.id,
              role: 'assistant',
              origin: 'assistant',
              parts: [{ type: 'text', text: notice.text }],
              text: notice.text,
              channelMessageId: notice.channelMessageId,
            })
            .onConflictDoNothing({
              target: messages.channelMessageId,
              where: sql`${messages.channelMessageId} IS NOT NULL`,
            })
            .returning({ id: messages.id });
          if (!row) throw new Error('application_confirmation_ambiguous_notice_race');
          await tx
            .update(conversations)
            .set({ updatedAt: now })
            .where(eq(conversations.id, notice.conversationId));
        }
        const [finalClock] = await tx.execute<{ now: string }>(
          sql`select clock_timestamp() as now`,
        );
        const [finalWork] = await tx
          .select()
          .from(emailObserverWork)
          .where(
            and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, fence.agentId)),
          )
          .limit(1);
        if (
          !finalClock ||
          (await lockPostgresPrivacyObservationFence(tx as unknown as Db, fence.agentId)) !==
            fence.expectedPrivacyGeneration ||
          !matchesPreparedEmailObserverClaim(finalWork ?? null, fence, new Date(finalClock.now))
        )
          throw new EmailObserverEffectFenceRejectedError();
        return {
          kind: 'recorded',
          taskId: created.task.id,
          from,
          applicationIds: matches.map((watch) => watch.id),
        };
      });
    },
    async isPrivacyGenerationCurrent(agentId, expected) {
      try {
        return await db.transaction(
          async (tx) => (await lockPostgresPrivacyObservationFence(tx, agentId)) === expected,
        );
      } catch {
        return false;
      }
    },
    async toolCallStatus(idempotencyKey) {
      const [prior] = await db
        .select({ status: toolCalls.status })
        .from(toolCalls)
        .where(eq(toolCalls.idempotencyKey, idempotencyKey));
      return prior?.status ?? null;
    },
    async settleExecutingToolCall(taskId, toolName, result, now) {
      await db
        .update(toolCalls)
        .set({ status: 'succeeded', result, finishedAt: now })
        .where(
          and(
            eq(toolCalls.taskId, taskId),
            eq(toolCalls.toolName, toolName),
            eq(toolCalls.status, 'executing'),
          ),
        );
    },
  };
}
