import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  ApplicationConfirmationAmbiguousInput,
  ApplicationConfirmationAmbiguousResult,
  ApplicationConfirmationClaimInput,
  ApplicationConfirmationRecord,
  ApplicationConfirmationRepository,
  ApplicationExternalEffectClaimInput,
  ApplicationExternalEffectSettlementInput,
  CreateApplicationWatchInput,
  Records,
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
  newTaskRecord,
} from '@assistant/persistence';
import type { DocumentSnapshot, Query } from '@google-cloud/firestore';
import { messageRecord } from './messages.js';
import {
  assertPrivacyErasureGenerationInTransaction,
  assertPrivacyErasureInactiveInTransaction,
  privacyErasureGeneration,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';
import { createTask as createTaskInTransaction } from './task-creation.js';

const AWAITING = 'awaiting_confirmation';
/** Watches one owner ever creates are few; this bounds the rare expiry scan. */
const EXPIRY_BATCH = 200;
const AMBIGUOUS_WATCH_LIMIT = 100;

function record(snapshot: DocumentSnapshot): ApplicationConfirmationRecord | null {
  if (!snapshot.exists) return null;
  const row = decodeRecord<ApplicationConfirmationRecord>(snapshot.data());
  if (row.producerPrivacyGeneration === undefined) row.producerPrivacyGeneration = null;
  return typeof row.id === 'string' &&
    documentKey(row.id) === snapshot.id &&
    row.expiresAt instanceof Date &&
    Array.isArray(row.expectedSenderEmails)
    ? row
    : null;
}

/** One active watch per `(agentId, token)`: the marker names the watch that holds it. */
function tokenMarkerId(agentId: string, tokenHash: string): string {
  return `application-token:${createHash('sha256')
    .update(JSON.stringify([agentId, tokenHash]))
    .digest('hex')}`;
}

/**
 * Application confirmation watches on Firestore. Every transition rereads the
 * record inside its transaction and checks the status it leaves, matching the
 * guarded PostgreSQL updates.
 */
export class FirestoreApplicationConfirmationRepository
  implements ApplicationConfirmationRepository
{
  readonly kind = 'application-confirmation-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private owned(agentId: string): void {
    if (agentId !== this.agentId)
      throw new Error('Application confirmation is outside the configured owner');
  }

  async createWatch(input: CreateApplicationWatchInput): Promise<ApplicationConfirmationRecord> {
    this.owned(input.agentId);
    const markerRef = this.store.doc(
      'applicationConfirmationTokens',
      tokenMarkerId(input.agentId, input.confirmationTokenHash),
    );
    // Imported watches predate the marker, so the active set is also queried.
    const imported = this.store
      .collection('applicationConfirmations')
      .where('agentId', '==', input.agentId)
      .where('confirmationTokenHash', '==', input.confirmationTokenHash)
      .where('status', '==', AWAITING)
      .limit(1);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const [marker, active] = await Promise.all([tx.get(markerRef), tx.get(imported)]);
      const heldBy = marker.exists ? marker.get('applicationId') : null;
      const holder =
        typeof heldBy === 'string'
          ? record(await tx.get(this.store.doc('applicationConfirmations', heldBy)))
          : null;
      if (!active.empty || holder?.status === AWAITING)
        throw new Error('an active confirmation watch already uses this token');

      const now = this.store.now();
      let conversationId = input.conversationId;
      if (!conversationId) {
        const conversation: Records['conversations'] = {
          id: randomUUID(),
          agentId: input.agentId,
          channel: 'chat',
          trust: 'owner',
          title: input.newConversationTitle,
          isPrimary: false,
          metadata: {},
          archivedAt: null,
          modelOverride: null,
          lastReadAt: null,
          messageSequence: 0,
          createdAt: now,
          updatedAt: now,
        };
        tx.create(
          this.store.doc('conversations', conversation.id),
          encodeRecord({ ...conversation, archived: false }),
        );
        conversationId = conversation.id;
      }
      const row: ApplicationConfirmationRecord = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        agentId: input.agentId,
        status: AWAITING,
        expiresAt: input.expiresAt,
        lastError: null,
        conversationId,
        role: input.role,
        sourceTaskId: input.sourceTaskId,
        company: input.company,
        expectedSenderEmails: input.expectedSenderEmails,
        confirmationTokenHash: input.confirmationTokenHash,
        confirmationTokenHint: input.confirmationTokenHint,
        trackerUpdate: input.trackerUpdate ?? null,
        documentUpdate: input.documentUpdate ?? null,
        actionState: input.actionState,
        confirmationMessageId: null,
        confirmationFrom: null,
        confirmedAt: null,
        producerPrivacyGeneration: null,
      };
      tx.create(this.store.doc('applicationConfirmations', row.id), encodeRecord(row));
      tx.set(markerRef, { agentId: input.agentId, applicationId: row.id, updatedAt: now });
      return row;
    });
  }

  async list(agentId: string, status?: string): Promise<ApplicationConfirmationRecord[]> {
    this.owned(agentId);
    let query: Query = this.store
      .collection('applicationConfirmations')
      .where('agentId', '==', agentId);
    if (status) query = query.where('status', '==', status);
    const snapshot = await query.orderBy('createdAt', 'desc').limit(100).get();
    return snapshot.docs.flatMap((doc) => {
      const row = record(doc);
      return row && row.agentId === agentId ? [row] : [];
    });
  }

  async cancel(agentId: string, id: string, now: Date) {
    this.owned(agentId);
    const ref = this.store.doc('applicationConfirmations', id);
    return this.store.db.runTransaction(async (tx) => {
      const current = record(await tx.get(ref));
      if (!current || current.agentId !== agentId) return null;
      if (current.status !== AWAITING)
        return { id: current.id, status: current.status, cancelled: false };
      tx.update(ref, encodeRecord({ status: 'cancelled', updatedAt: now }));
      return { id: current.id, status: 'cancelled', cancelled: true };
    });
  }

  async get(id: string): Promise<ApplicationConfirmationRecord | null> {
    const row = record(await this.store.doc('applicationConfirmations', id).get());
    return row && row.agentId === this.agentId ? row : null;
  }

  async updateActionState(
    id: string,
    input: Parameters<ApplicationConfirmationRepository['updateActionState']>[1],
  ): Promise<ApplicationConfirmationRecord | null> {
    const ref = this.store.doc('applicationConfirmations', id);
    return this.store.db.runTransaction(async (tx) => {
      const current = record(await tx.get(ref));
      if (!current || current.agentId !== this.agentId) return null;
      if (input.requireStatus && current.status !== input.requireStatus) return null;
      const next: ApplicationConfirmationRecord = {
        ...current,
        actionState: input.actionState,
        ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
        ...(input.status ? { status: input.status } : {}),
        updatedAt: input.now,
      };
      tx.update(
        ref,
        encodeRecord({
          actionState: next.actionState,
          lastError: next.lastError,
          status: next.status,
          updatedAt: input.now,
        }),
      );
      return next;
    });
  }

  async claimExternalEffect(input: ApplicationExternalEffectClaimInput) {
    this.owned(input.agentId);
    const claimToken = randomUUID();
    const applicationRef = this.store.doc('applicationConfirmations', input.applicationId);
    const taskRef = this.store.doc('tasks', input.taskId);
    const callRef = this.store.doc('toolCalls', input.toolCallId);
    const fenceRef = this.store.doc('privacyErasureJobs', input.agentId);
    try {
      return await this.store.db.runTransaction(async (tx) => {
        const [fenceSnapshot, applicationSnapshot, taskSnapshot, callSnapshot] = await Promise.all([
          tx.get(fenceRef),
          tx.get(applicationRef),
          tx.get(taskRef),
          tx.get(callRef),
        ]);
        const generation = privacyErasureGeneration(fenceSnapshot, input.agentId);
        const current = record(applicationSnapshot);
        const task = taskSnapshot.exists
          ? decodeRecord<Records['tasks']>(taskSnapshot.data())
          : null;
        const trigger = taskSnapshot.get('trigger') as
          | { source?: unknown; payload?: Record<string, unknown> }
          | undefined;
        const callArgs = callSnapshot.get('args') as { applicationId?: unknown } | undefined;
        const canonicalIdentity = applicationExternalEffectToolIdentity(
          input.action,
          input.applicationId,
        );
        const triggerPayload = trigger?.payload;
        const expectedEventId = `application-confirmation:${current?.confirmationMessageId ?? ''}`;
        if (
          generation !== input.expectedProducerPrivacyGeneration ||
          !current ||
          current.agentId !== input.agentId ||
          current.status !== 'confirmation_received' ||
          (current.producerPrivacyGeneration ?? null) !== input.expectedProducerPrivacyGeneration ||
          !task ||
          task.agentId !== input.agentId ||
          trigger?.source !== 'internal' ||
          triggerPayload?.kind !== 'application_confirmation' ||
          triggerPayload.applicationId !== input.applicationId ||
          typeof current.confirmationMessageId !== 'string' ||
          triggerPayload.confirmationMessageId !== current.confirmationMessageId ||
          !Object.hasOwn(triggerPayload, 'producerPrivacyGeneration') ||
          triggerPayload.producerPrivacyGeneration !== input.expectedProducerPrivacyGeneration ||
          task.externalEventId !== expectedEventId ||
          task.status !== 'running' ||
          task.leaseToken !== input.taskLeaseToken ||
          input.toolName !== canonicalIdentity.toolName ||
          input.idempotencyKey !== canonicalIdentity.idempotencyKey ||
          callSnapshot.get('taskId') !== input.taskId ||
          callSnapshot.get('toolName') !== canonicalIdentity.toolName ||
          callSnapshot.get('idempotencyKey') !== canonicalIdentity.idempotencyKey ||
          callSnapshot.get('status') !== 'executing' ||
          callArgs?.applicationId !== input.applicationId
        )
          return { status: 'blocked' as const };
        const dispatchAt = new Date();
        if (!task.lockedUntil || task.lockedUntil <= dispatchAt)
          return { status: 'blocked' as const };

        const state = (current.actionState ?? {}) as Record<string, unknown>;
        const actionKey = input.action === 'sheet' ? 'sheet' : 'document';
        const prior = state[actionKey] as { status?: unknown } | undefined;
        const frozenArgs =
          input.action === 'sheet' ? current.trackerUpdate : current.documentUpdate;
        if (
          prior?.status !== 'pending' ||
          applicationExternalEffectArgsDigest(input.action, frozenArgs) !== input.argsDigest
        )
          return { status: 'blocked' as const };

        const nextAction = {
          ...(prior ?? {}),
          status: 'unknown',
          error: 'The provider outcome is unresolved; automatic retry is suppressed.',
          effectReceipt: {
            claimToken,
            producerPrivacyGeneration: input.expectedProducerPrivacyGeneration,
            argsDigest: input.argsDigest,
            taskId: input.taskId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            idempotencyKey: input.idempotencyKey,
          },
        };
        const nextState = { ...state, [actionKey]: nextAction };
        const next: ApplicationConfirmationRecord = {
          ...current,
          actionState: nextState,
          updatedAt: dispatchAt,
        };
        tx.update(applicationRef, encodeRecord({ actionState: nextState, updatedAt: dispatchAt }));
        return { status: 'claimed' as const, claimToken, record: next };
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Privacy erasure is in progress')
        return { status: 'blocked' as const };
      throw error;
    }
  }

  async settleExternalEffect(input: ApplicationExternalEffectSettlementInput) {
    this.owned(input.agentId);
    const applicationRef = this.store.doc('applicationConfirmations', input.applicationId);
    const fenceRef = this.store.doc('privacyErasureJobs', input.agentId);
    return this.store.db.runTransaction(async (tx) => {
      // Reading this owner document serializes settlement with erasure while
      // allowing the matching pre-erasure claim to settle during an active job.
      const [fenceSnapshot, applicationSnapshot] = await Promise.all([
        tx.get(fenceRef),
        tx.get(applicationRef),
      ]);
      if (fenceSnapshot.exists && fenceSnapshot.get('agentId') !== input.agentId) return null;
      const current = record(applicationSnapshot);
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
      const nextAction = {
        ...priorWithoutError,
        status: input.status,
        ...(input.error !== undefined ? { error: input.error } : {}),
      };
      const nextState = { ...state, [actionKey]: nextAction };
      tx.update(applicationRef, encodeRecord({ actionState: nextState, updatedAt: input.now }));
      return { ...current, actionState: nextState, updatedAt: input.now };
    });
  }

  async expireDue(now: Date, agentId?: string): Promise<ApplicationConfirmationRecord[]> {
    if (agentId) this.owned(agentId);
    let query: Query = this.store
      .collection('applicationConfirmations')
      .where('agentId', '==', this.agentId)
      .where('status', '==', AWAITING)
      .where('expiresAt', '<=', now);
    query = query.orderBy('expiresAt', 'asc').limit(EXPIRY_BATCH);
    const due = await query.get();
    const expired: ApplicationConfirmationRecord[] = [];
    for (const doc of due.docs) {
      const moved = await this.store.db.runTransaction(async (tx) => {
        const current = record(await tx.get(doc.ref));
        if (!current || current.status !== AWAITING || current.expiresAt > now) return null;
        tx.update(doc.ref, encodeRecord({ status: 'expired', updatedAt: now }));
        return { ...current, status: 'expired', updatedAt: now };
      });
      if (moved) expired.push(moved);
    }
    return expired;
  }

  async byConfirmationMessage(agentId: string, confirmationMessageId: string) {
    this.owned(agentId);
    const snapshot = await this.store
      .collection('applicationConfirmations')
      .where('agentId', '==', agentId)
      .where('confirmationMessageId', '==', confirmationMessageId)
      .limit(1)
      .get();
    return snapshot.docs[0] ? record(snapshot.docs[0]) : null;
  }

  async awaitingFrom(agentId: string, from: string, now: Date) {
    this.owned(agentId);
    const snapshot = await this.store
      .collection('applicationConfirmations')
      .where('agentId', '==', agentId)
      .where('status', '==', AWAITING)
      .where('expectedSenderEmails', 'array-contains', from)
      .limit(EXPIRY_BATCH)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const row = record(doc);
      return row && row.expiresAt > now ? [row] : [];
    });
  }

  async claim(
    id: string,
    input: ApplicationConfirmationClaimInput,
  ): Promise<ApplicationConfirmationRecord | null> {
    const ref = this.store.doc('applicationConfirmations', id);
    return this.store.db.runTransaction(async (tx) => {
      const fence = input.emailObserverEffectFence;
      let preparedWork: Records['emailObserverWork'] | null = null;
      if (fence) {
        if (fence.agentId !== this.agentId || !input.confirmationTokenHash || !input.sourceDigest)
          return null;
        await assertPrivacyErasureGenerationInTransaction(
          tx,
          this.store,
          fence.agentId,
          fence.expectedPrivacyGeneration,
        );
        const workSnapshot = await tx.get(this.store.doc('emailObserverWork', fence.id));
        preparedWork = workSnapshot.exists
          ? decodeRecord<Records['emailObserverWork']>(workSnapshot.data())
          : null;
        const channelMessageId = input.confirmationMessageId;
        const providerMessageId = channelMessageId.startsWith('gmail:')
          ? channelMessageId.slice('gmail:'.length)
          : '';
        const ingests = await tx.get(
          this.store
            .collection('emailIngest')
            .where('agentId', '==', fence.agentId)
            .where('channelMessageId', '==', channelMessageId)
            .limit(2),
        );
        if (ingests.size !== 1 || !providerMessageId) return null;
        const ingestDoc = ingests.docs[0];
        if (!ingestDoc) return null;
        const ingest = decodeRecord<Records['emailIngest']>(ingestDoc.data());
        if (
          !preparedWork ||
          !matchesPreparedEmailObserverClaim(preparedWork, fence, this.store.now()) ||
          (preparedWork.observerKey !== 'google.application-confirmation' &&
            preparedWork.observerKey !== 'google.direct-email-routing') ||
          preparedWork.observerVersion !== 1 ||
          preparedWork.sourceKind !== 'message' ||
          preparedWork.sourceKey !== channelMessageId ||
          preparedWork.channelMessageId !== channelMessageId ||
          ingest.id !== ingestDoc.get('id') ||
          documentKey(ingest.id) !== ingestDoc.id ||
          ingest.agentId !== fence.agentId ||
          ingest.channelMessageId !== channelMessageId ||
          ingest.ingestMode !== 'direct' ||
          !ingest.authenticated ||
          ingest.emailContentProvenance?.authenticated !== true ||
          ingest.emailContentProvenance.hasExternalOrUnknown !== ingest.hasExternalOrUnknown ||
          (preparedWork.observerKey === 'google.direct-email-routing' &&
            ingest.directRouting !== 'application_confirmation') ||
          (preparedWork.observerKey === 'google.application-confirmation' &&
            ingest.directRouting !== null) ||
          ingest.providerMessageId !== providerMessageId ||
          ingest.fromEmail.trim().toLowerCase() !== input.confirmationFrom.trim().toLowerCase() ||
          ingest.admittedSourceKind !== 'message' ||
          !ingest.admittedSourceId
        )
          return null;
        const channel = await tx.get(this.store.doc('messageChannelIds', channelMessageId));
        if (!channel.exists || channel.get('messageId') !== ingest.admittedSourceId) return null;
        const sourceSnapshot = await tx.get(this.store.doc('messages', ingest.admittedSourceId));
        if (!sourceSnapshot.exists) return null;
        const source = decodeRecord<Records['messages']>(sourceSnapshot.data());
        if (
          source.id !== ingest.admittedSourceId ||
          documentKey(source.id) !== sourceSnapshot.id ||
          source.channelMessageId !== channelMessageId ||
          source.hiddenAt ||
          source.role !== 'user' ||
          source.conversationId !== ingest.conversationId ||
          channel.get('conversationId') !== source.conversationId
        )
          return null;
        const conversation = await tx.get(this.store.doc('conversations', source.conversationId));
        const body = emailObserverMessageBody(source.parts);
        if (
          !conversation.exists ||
          conversation.get('agentId') !== fence.agentId ||
          body === null ||
          !applicationConfirmationTokenInSource({
            tokenHash: input.confirmationTokenHash,
            subject: ingest.subject,
            body,
            provenance: ingest.emailContentProvenance,
          }) ||
          applicationConfirmationSourceDigest({
            confirmationMessageId: source.channelMessageId ?? '',
            confirmationFrom: ingest.fromEmail,
            subject: ingest.subject,
            body,
          }) !== input.sourceDigest
        )
          return null;
      }

      const current = record(await tx.get(ref));
      const now = fence ? this.store.now() : input.now;
      if (
        !current ||
        current.agentId !== (fence?.agentId ?? this.agentId) ||
        current.status !== AWAITING ||
        current.expiresAt <= now ||
        (fence !== undefined &&
          (!preparedWork ||
            !matchesPreparedEmailObserverClaim(preparedWork, fence, now) ||
            !input.confirmationTokenHash ||
            current.confirmationTokenHash !== input.confirmationTokenHash ||
            !current.expectedSenderEmails.some(
              (sender) =>
                sender.trim().toLowerCase() === input.confirmationFrom.trim().toLowerCase(),
            )))
      )
        return null;
      const claimed: ApplicationConfirmationRecord = {
        ...current,
        status: 'confirmation_received',
        confirmationMessageId: input.confirmationMessageId,
        confirmationFrom: input.confirmationFrom.trim().toLowerCase(),
        confirmedAt: now,
        lastError: null,
        updatedAt: now,
      };
      tx.update(
        ref,
        encodeRecord({
          status: claimed.status,
          confirmationMessageId: claimed.confirmationMessageId,
          confirmationFrom: claimed.confirmationFrom,
          confirmedAt: claimed.confirmedAt,
          lastError: null,
          updatedAt: now,
        }),
      );
      return claimed;
    });
  }

  async claimAndEnqueue(
    id: string,
    input: Parameters<ApplicationConfirmationRepository['claimAndEnqueue']>[1],
  ) {
    this.owned(input.emailObserverEffectFence.agentId);
    const fence = input.emailObserverEffectFence;
    const watchRef = this.store.doc('applicationConfirmations', id);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        fence.agentId,
        fence.expectedPrivacyGeneration,
      );
      const workSnapshot = await tx.get(this.store.doc('emailObserverWork', fence.id));
      const work = workSnapshot.exists
        ? decodeRecord<Records['emailObserverWork']>(workSnapshot.data())
        : null;
      const channelMessageId = input.confirmationMessageId;
      const providerMessageId = channelMessageId.startsWith('gmail:')
        ? channelMessageId.slice('gmail:'.length)
        : '';
      const ingestQuery = this.store
        .collection('emailIngest')
        .where('agentId', '==', fence.agentId)
        .where('channelMessageId', '==', channelMessageId)
        .limit(2);
      const ingests = await tx.get(ingestQuery);
      if (!work || ingests.size !== 1 || !providerMessageId) return null;
      const ingestDoc = ingests.docs[0];
      if (!ingestDoc) return null;
      const ingest = decodeRecord<Records['emailIngest']>(ingestDoc.data());
      if (
        !matchesPreparedEmailObserverClaim(work, fence, this.store.now()) ||
        !['google.application-confirmation', 'google.direct-email-routing'].includes(
          work.observerKey,
        ) ||
        work.observerVersion !== 1 ||
        work.sourceKind !== 'message' ||
        work.sourceKey !== channelMessageId ||
        work.channelMessageId !== channelMessageId ||
        ingest.id !== ingestDoc.get('id') ||
        documentKey(ingest.id) !== ingestDoc.id ||
        ingest.agentId !== fence.agentId ||
        ingest.channelMessageId !== channelMessageId ||
        ingest.ingestMode !== 'direct' ||
        !ingest.authenticated ||
        ingest.emailContentProvenance?.authenticated !== true ||
        ingest.emailContentProvenance.hasExternalOrUnknown !== ingest.hasExternalOrUnknown ||
        (work.observerKey === 'google.direct-email-routing' &&
          ingest.directRouting !== 'application_confirmation') ||
        (work.observerKey === 'google.application-confirmation' && ingest.directRouting !== null) ||
        ingest.providerMessageId !== providerMessageId ||
        ingest.fromEmail.trim().toLowerCase() !== input.confirmationFrom.trim().toLowerCase() ||
        !ingest.conversationId ||
        ingest.admittedSourceKind !== 'message' ||
        !ingest.admittedSourceId
      )
        return null;
      const channelSnapshot = await tx.get(this.store.doc('messageChannelIds', channelMessageId));
      const sourceSnapshot = await tx.get(this.store.doc('messages', ingest.admittedSourceId));
      const conversationSnapshot = await tx.get(
        this.store.doc('conversations', ingest.conversationId),
      );
      if (!channelSnapshot.exists || !sourceSnapshot.exists || !conversationSnapshot.exists)
        return null;
      const source = decodeRecord<Records['messages']>(sourceSnapshot.data());
      const body = emailObserverMessageBody(source.parts);
      if (
        channelSnapshot.get('messageId') !== ingest.admittedSourceId ||
        source.id !== ingest.admittedSourceId ||
        documentKey(source.id) !== sourceSnapshot.id ||
        source.channelMessageId !== channelMessageId ||
        source.hiddenAt ||
        source.role !== 'user' ||
        source.conversationId !== ingest.conversationId ||
        channelSnapshot.get('conversationId') !== source.conversationId ||
        conversationSnapshot.get('agentId') !== fence.agentId ||
        body === null ||
        !applicationConfirmationTokenInSource({
          tokenHash: input.confirmationTokenHash,
          subject: ingest.subject,
          body,
          provenance: ingest.emailContentProvenance,
        }) ||
        applicationConfirmationSourceDigest({
          confirmationMessageId: source.channelMessageId ?? '',
          confirmationFrom: ingest.fromEmail,
          subject: ingest.subject,
          body,
        }) !== input.sourceDigest
      )
        return null;
      const current = record(await tx.get(watchRef));
      const now = this.store.now();
      if (
        !current ||
        current.agentId !== fence.agentId ||
        current.confirmationTokenHash !== input.confirmationTokenHash ||
        !current.expectedSenderEmails.some(
          (sender) => sender.trim().toLowerCase() === input.confirmationFrom.trim().toLowerCase(),
        )
      )
        return null;
      const assertClaimAtCommit = () => {
        // Task creation queues writes. Reuse the transaction's locked read instead
        // of attempting an illegal Firestore read after those writes.
        const commitNow = this.store.now();
        if (
          !matchesPreparedEmailObserverClaim(work, fence, commitNow) ||
          (current.status === AWAITING && current.expiresAt <= commitNow)
        )
          throw new Error('Application confirmation claim expired before handoff commit');
      };
      const taskInput = applicationConfirmationTaskInput({
        agentId: fence.agentId,
        applicationId: current.id,
        confirmationMessageId: input.confirmationMessageId,
        conversationId: current.conversationId,
        subject: ingest.subject,
        producerPrivacyGeneration: fence.expectedPrivacyGeneration,
      });
      const eventKey = this.store.doc(
        'taskEventKeys',
        createHash('sha256')
          .update(taskInput.externalEventId ?? '')
          .digest('hex'),
      );
      if (current.status === 'confirmation_received') {
        if (
          current.confirmationMessageId !== input.confirmationMessageId ||
          current.producerPrivacyGeneration !== fence.expectedPrivacyGeneration ||
          !(await tx.get(eventKey)).exists
        )
          return null;
        const task = await createTaskInTransaction(this.store, taskInput, tx);
        const exactTask = existingFencedTaskResult(task.task, taskInput).task;
        assertClaimAtCommit();
        return { record: current, task: exactTask, created: false };
      }
      if (current.status !== AWAITING || current.expiresAt <= now) return null;
      const task = await createTaskInTransaction(this.store, taskInput, tx);
      const exactTask = existingFencedTaskResult(task.task, taskInput).task;
      assertClaimAtCommit();
      const claimed: ApplicationConfirmationRecord = {
        ...current,
        status: 'confirmation_received',
        confirmationMessageId: input.confirmationMessageId,
        confirmationFrom: input.confirmationFrom.trim().toLowerCase(),
        confirmedAt: now,
        producerPrivacyGeneration: fence.expectedPrivacyGeneration,
        lastError: null,
        updatedAt: now,
      };
      tx.update(
        watchRef,
        encodeRecord({
          status: claimed.status,
          confirmationMessageId: claimed.confirmationMessageId,
          confirmationFrom: claimed.confirmationFrom,
          confirmedAt: claimed.confirmedAt,
          producerPrivacyGeneration: claimed.producerPrivacyGeneration,
          lastError: null,
          updatedAt: now,
        }),
      );
      return { record: claimed, task: exactTask, created: task.created };
    });
  }

  async recordAmbiguousObserver(
    input: ApplicationConfirmationAmbiguousInput,
  ): Promise<ApplicationConfirmationAmbiguousResult> {
    const fence = input.emailObserverEffectFence;
    this.owned(fence.agentId);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        fence.agentId,
        fence.expectedPrivacyGeneration,
      );
      const workSnapshot = await tx.get(this.store.doc('emailObserverWork', fence.id));
      const work = workSnapshot.exists
        ? decodeRecord<Records['emailObserverWork']>(workSnapshot.data())
        : null;
      if (
        !work ||
        !matchesPreparedEmailObserverClaim(work, fence, this.store.now()) ||
        !['google.application-confirmation', 'google.direct-email-routing'].includes(
          work.observerKey,
        ) ||
        work.observerVersion !== 1 ||
        work.workClass !== 'idempotent_db' ||
        work.sourceKind !== 'message' ||
        work.sourceKey !== work.channelMessageId ||
        !work.channelMessageId
      )
        throw new EmailObserverEffectFenceRejectedError();

      const channelMessageId = work.channelMessageId;
      const providerMessageId = channelMessageId.startsWith('gmail:')
        ? channelMessageId.slice('gmail:'.length)
        : '';
      const ingests = await tx.get(
        this.store
          .collection('emailIngest')
          .where('agentId', '==', fence.agentId)
          .where('channelMessageId', '==', channelMessageId)
          .limit(2),
      );
      if (ingests.size !== 1 || !providerMessageId)
        throw new EmailObserverEffectFenceRejectedError();
      const ingestSnapshot = ingests.docs[0];
      if (!ingestSnapshot) throw new EmailObserverEffectFenceRejectedError();
      const ingest = decodeRecord<Records['emailIngest']>(ingestSnapshot.data());
      if (
        ingest.id !== ingestSnapshot.get('id') ||
        documentKey(ingest.id) !== ingestSnapshot.id ||
        ingest.agentId !== fence.agentId ||
        ingest.channelMessageId !== channelMessageId ||
        ingest.ingestMode !== 'direct' ||
        ingest.authenticated !== true ||
        ingest.emailContentProvenance?.authenticated !== true ||
        ingest.emailContentProvenance?.mode !== 'direct' ||
        ingest.emailContentProvenance.hasExternalOrUnknown !== ingest.hasExternalOrUnknown ||
        (work.observerKey === 'google.direct-email-routing' &&
          ingest.directRouting !== 'application_confirmation') ||
        (work.observerKey === 'google.application-confirmation' && ingest.directRouting !== null) ||
        ingest.providerMessageId !== providerMessageId ||
        ingest.channelMessageId !== `gmail:${ingest.providerMessageId}` ||
        ingest.admittedSourceKind !== 'message' ||
        !ingest.admittedSourceId ||
        !ingest.conversationId
      )
        throw new EmailObserverEffectFenceRejectedError();
      const channelRef = this.store.doc('messageChannelIds', channelMessageId);
      const sourceRef = this.store.doc('messages', ingest.admittedSourceId);
      const sourceConversationRef = this.store.doc('conversations', ingest.conversationId);
      const [channelSnapshot, sourceSnapshot, sourceConversationSnapshot] = await tx.getAll(
        channelRef,
        sourceRef,
        sourceConversationRef,
      );
      if (
        !channelSnapshot?.exists ||
        !sourceSnapshot?.exists ||
        !sourceConversationSnapshot?.exists
      )
        throw new EmailObserverEffectFenceRejectedError();
      const source = decodeRecord<Records['messages']>(sourceSnapshot.data());
      const body = emailObserverMessageBody(source.parts);
      const from = ingest.fromEmail.trim().toLowerCase();
      if (
        channelSnapshot.get('messageId') !== ingest.admittedSourceId ||
        source.id !== ingest.admittedSourceId ||
        documentKey(source.id) !== sourceSnapshot.id ||
        source.channelMessageId !== channelMessageId ||
        source.hiddenAt !== null ||
        source.role !== 'user' ||
        source.conversationId !== ingest.conversationId ||
        sourceConversationSnapshot.get('agentId') !== fence.agentId ||
        sourceConversationSnapshot.get('channel') !== 'email' ||
        body === null
      )
        throw new EmailObserverEffectFenceRejectedError();

      const watchesSnapshot = await tx.get(
        this.store
          .collection('applicationConfirmations')
          .where('agentId', '==', fence.agentId)
          .where('status', '==', AWAITING)
          .orderBy('id')
          .limit(AMBIGUOUS_WATCH_LIMIT + 1),
      );
      if (watchesSnapshot.size > AMBIGUOUS_WATCH_LIMIT)
        throw new Error('application_confirmation_watch_limit');
      const watches = watchesSnapshot.docs.flatMap((doc) => {
        const watch = record(doc);
        return watch && watch.agentId === fence.agentId ? [watch] : [];
      });
      const now = this.store.now();
      if (
        privacyErasureGeneration(
          await tx.get(this.store.doc('privacyErasureJobs', fence.agentId)),
          fence.agentId,
        ) !== fence.expectedPrivacyGeneration ||
        !matchesPreparedEmailObserverClaim(work, fence, now)
      )
        throw new EmailObserverEffectFenceRejectedError();
      const matches = watches
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
        .sort((left, right) => left.id.localeCompare(right.id));
      if (matches.length < 2) return { kind: 'not_ambiguous' };

      const taskInput = applicationConfirmationAmbiguousTaskInput({
        agentId: fence.agentId,
        confirmationMessageId: channelMessageId,
        from,
        matches,
      });
      const externalEventId = taskInput.externalEventId ?? '';
      const expectedProgress = applicationConfirmationAmbiguousProgress(from, matches.length);
      const noticeText = applicationConfirmationAmbiguousNotice({ from, matches });
      const noticeSpecs = matches
        .filter((watch) => watch.conversationId)
        .map((watch) => ({
          channelMessageId: `application-confirmation-notice:${externalEventId}:ambiguous:${watch.id}`,
          conversationId: watch.conversationId as string,
          text: noticeText,
        }));
      const noticeConversationIds = [
        ...new Set(noticeSpecs.map((notice) => notice.conversationId)),
      ];
      const eventKey = this.store.doc(
        'taskEventKeys',
        createHash('sha256').update(externalEventId).digest('hex'),
      );
      const eventSnapshot = await tx.get(eventKey);
      const existingTaskRef = eventSnapshot.exists
        ? this.store.doc('tasks', String(eventSnapshot.get('taskId') ?? ''))
        : null;
      const existingTaskSnapshot = existingTaskRef ? await tx.get(existingTaskRef) : null;
      if (eventSnapshot.exists && !existingTaskSnapshot?.exists)
        throw new Error('application_confirmation_ambiguous_event_index_corrupt');
      const noticeChannelRefs = noticeSpecs.map((notice) =>
        this.store.doc('messageChannelIds', notice.channelMessageId),
      );
      const noticeChannelSnapshots = noticeChannelRefs.length
        ? await tx.getAll(...noticeChannelRefs)
        : [];
      const noticeMappingsValid = noticeChannelSnapshots.every(
        (snapshot) => snapshot?.exists && typeof snapshot.get('messageId') === 'string',
      );
      const noticeMessageRefs = noticeMappingsValid
        ? noticeChannelSnapshots.map((snapshot) =>
            this.store.doc('messages', String(snapshot?.get('messageId'))),
          )
        : [];
      const noticeMessageSnapshots = noticeMessageRefs.length
        ? await tx.getAll(...noticeMessageRefs)
        : [];
      const conversationRefs = noticeConversationIds.map((id) =>
        this.store.doc('conversations', id),
      );
      const conversationSnapshots = conversationRefs.length
        ? await tx.getAll(...conversationRefs)
        : [];
      if (
        conversationSnapshots.length !== noticeConversationIds.length ||
        conversationSnapshots.some(
          (snapshot) => !snapshot?.exists || snapshot.get('agentId') !== fence.agentId,
        )
      )
        throw new EmailObserverEffectFenceRejectedError();

      if (existingTaskSnapshot?.exists) {
        const task = decodeRecord<Records['tasks']>(existingTaskSnapshot.data());
        const exactTask =
          task.id === existingTaskSnapshot.get('id') &&
          documentKey(task.id) === existingTaskSnapshot.id &&
          task.agentId === fence.agentId &&
          task.type === 'adhoc' &&
          task.trust === 'assistant' &&
          task.status === 'needs_attention' &&
          task.progress === expectedProgress.slice(0, 500) &&
          task.externalEventId === externalEventId &&
          isDeepStrictEqual(task.trigger, taskInput.trigger);
        const exactNotices =
          noticeMappingsValid &&
          noticeSpecs.every((notice, index) => {
            const channel = noticeChannelSnapshots[index];
            const message = noticeMessageSnapshots[index];
            if (!channel?.exists || !message?.exists) return false;
            const row = decodeRecord<Records['messages']>(message.data());
            return (
              channel.get('conversationId') === notice.conversationId &&
              row.channelMessageId === notice.channelMessageId &&
              row.conversationId === notice.conversationId &&
              row.taskId === task.id &&
              row.role === 'assistant' &&
              row.origin === 'assistant' &&
              row.text === notice.text &&
              row.hiddenAt === null
            );
          });
        if (!exactTask || noticeChannelSnapshots.length !== noticeSpecs.length || !exactNotices)
          throw new Error('application_confirmation_ambiguous_replay_mismatch');
        if (
          privacyErasureGeneration(
            await tx.get(this.store.doc('privacyErasureJobs', fence.agentId)),
            fence.agentId,
          ) !== fence.expectedPrivacyGeneration ||
          !matchesPreparedEmailObserverClaim(work, fence, this.store.now())
        )
          throw new EmailObserverEffectFenceRejectedError();
        return {
          kind: 'replay',
          taskId: task.id,
          from,
          applicationIds: matches.map((watch) => watch.id),
        };
      }
      if (noticeChannelSnapshots.some((snapshot) => snapshot?.exists))
        throw new Error('application_confirmation_ambiguous_notice_without_task');
      if (eventSnapshot.exists)
        throw new Error('application_confirmation_ambiguous_event_index_corrupt');
      if (
        privacyErasureGeneration(
          await tx.get(this.store.doc('privacyErasureJobs', fence.agentId)),
          fence.agentId,
        ) !== fence.expectedPrivacyGeneration ||
        !matchesPreparedEmailObserverClaim(work, fence, this.store.now())
      )
        throw new EmailObserverEffectFenceRejectedError();
      const createdAt = this.store.now();
      const task = {
        ...newTaskRecord(taskInput, randomUUID(), createdAt),
        status: 'needs_attention',
        progress: expectedProgress.slice(0, 500),
        attentionNotifiedAt: null,
        updatedAt: createdAt,
      };
      tx.create(this.store.doc('tasks', task.id), encodeRecord(task));
      tx.create(eventKey, { taskId: task.id, createdAt });
      for (const notice of noticeSpecs) {
        const id = randomUUID();
        const row = messageRecord(
          {
            conversationId: notice.conversationId,
            taskId: task.id,
            role: 'assistant',
            origin: 'assistant',
            parts: [{ type: 'text', text: notice.text }],
            text: notice.text,
            channelMessageId: notice.channelMessageId,
          },
          id,
          createdAt,
        );
        tx.create(this.store.doc('messages', id), encodeRecord(row));
        tx.create(this.store.doc('messageChannelIds', notice.channelMessageId), {
          messageId: id,
          conversationId: notice.conversationId,
        });
        tx.update(this.store.doc('conversations', notice.conversationId), {
          updatedAt: row.createdAt,
        });
      }
      return {
        kind: 'recorded',
        taskId: task.id,
        from,
        applicationIds: matches.map((watch) => watch.id),
      };
    });
  }

  async isPrivacyGenerationCurrent(agentId: string, expected: string | null): Promise<boolean> {
    this.owned(agentId);
    try {
      const snapshot = await this.store.doc('privacyErasureJobs', agentId).get();
      return privacyErasureGeneration(snapshot, agentId) === expected;
    } catch {
      return false;
    }
  }

  async toolCallStatus(idempotencyKey: string): Promise<string | null> {
    const mapping = await this.store.doc('toolCallIdempotency', idempotencyKey).get();
    const id = mapping.exists ? mapping.get('toolCallId') : null;
    if (typeof id === 'string') {
      const call = await this.store.doc('toolCalls', id).get();
      const status = call.exists ? call.get('status') : null;
      return typeof status === 'string' ? status : null;
    }
    const imported = await this.store
      .collection('toolCalls')
      .where('idempotencyKey', '==', idempotencyKey)
      .limit(1)
      .get();
    const status = imported.docs[0]?.get('status');
    return typeof status === 'string' ? status : null;
  }

  async settleExecutingToolCall(
    taskId: string,
    toolName: string,
    result: unknown,
    now: Date,
  ): Promise<void> {
    const executing = await this.store
      .collection('toolCalls')
      .where('taskId', '==', taskId)
      .where('toolName', '==', toolName)
      .where('status', '==', 'executing')
      .get();
    for (const doc of executing.docs) {
      await this.store.db.runTransaction(async (tx) => {
        const current = await tx.get(doc.ref);
        if (current.get('status') !== 'executing') return;
        tx.update(doc.ref, encodeRecord({ status: 'succeeded', result, finishedAt: now }));
      });
    }
  }
}
