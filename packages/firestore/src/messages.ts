import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type AppendMessageInput,
  EmailObserverEffectFenceRejectedError,
  type MessageRepository,
  matchesApplicationConfirmationNoticeLineage,
  notificationDashboardMessageId,
  type Records,
  recallSurfaceRefs,
} from '@assistant/persistence';
import {
  assertPrivacyErasureGenerationInTransaction,
  assertPrivacyErasureInactiveInTransaction,
} from './privacy-erasure.js';
import { deterministicUuid } from './stable-id.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

export function messageRecord(
  input: AppendMessageInput,
  id: string,
  now: Date,
): Records['messages'] {
  const {
    notificationOutboxFence: _notificationOutboxFence,
    applicationConfirmationNoticeFence: _applicationConfirmationNoticeFence,
    ...messageInput
  } = input;
  const row = {
    ...messageInput,
    id,
    createdAt: now,
    taskId: input.taskId ?? null,
    channelMessageId: input.channelMessageId ?? null,
    clientId: null,
    clientDeliveredAt: null,
    clientDeliveredBy: null,
    embedding: null,
    embeddingSpaceKey: null,
    hiddenAt: null,
    appendSequence: '00000000000000000000',
  };
  // Leave room for Firestore's field-name/type overhead. Oversize content must go through
  // the forthcoming GCS payload adapter; never silently truncate or split a transaction.
  if (Buffer.byteLength(JSON.stringify(row), 'utf8') > 900_000) {
    throw new Error('Message exceeds inline storage limit; store its payload in Cloud Storage');
  }
  return row;
}

export class FirestoreMessageRepository implements MessageRepository {
  readonly kind = 'message-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async append(input: AppendMessageInput): Promise<Records['messages'] | undefined> {
    const id = randomUUID();
    const conversation = this.store.doc('conversations', input.conversationId);
    const refs = input.role === 'assistant' ? recallSurfaceRefs(input.parts) : [];
    const dedupe = input.channelMessageId
      ? this.store.doc('messageChannelIds', input.channelMessageId)
      : null;
    return this.store.db.runTransaction(async (tx) => {
      const parent = await tx.get(conversation);
      if (!parent.exists) throw new Error('Conversation does not exist');
      const fence = input.notificationOutboxFence;
      let outbox: Records['notificationOutbox'] | null = null;
      let work: Records['emailObserverWork'] | null = null;
      let producerTask: Records['tasks'] | null = null;
      let producerApplication: Records['applicationConfirmations'] | null = null;
      if (fence) {
        const outboxRef = this.store.doc('notificationOutbox', fence.legId);
        const workRef = fence.producerWorkId
          ? this.store.doc('emailObserverWork', fence.producerWorkId)
          : null;
        const producerTaskRef = fence.producerTaskId
          ? this.store.doc('tasks', fence.producerTaskId)
          : null;
        const producerApplicationRef = fence.producerApplicationId
          ? this.store.doc('applicationConfirmations', fence.producerApplicationId)
          : null;
        await assertPrivacyErasureGenerationInTransaction(
          tx,
          this.store,
          fence.agentId,
          fence.producerPrivacyGeneration,
        );
        const refs = [outboxRef, workRef, producerTaskRef, producerApplicationRef].filter(
          (ref): ref is NonNullable<typeof ref> => ref !== null,
        );
        const snapshots = await tx.getAll(...refs);
        const outboxSnapshot = snapshots[0];
        const workSnapshot = workRef ? snapshots[1] : null;
        const producerTaskSnapshot = producerTaskRef
          ? snapshots[refs.indexOf(producerTaskRef)]
          : null;
        const producerApplicationSnapshot = producerApplicationRef
          ? snapshots[refs.indexOf(producerApplicationRef)]
          : null;
        outbox = outboxSnapshot?.exists
          ? decodeRecord<Records['notificationOutbox']>(outboxSnapshot.data())
          : null;
        work = workSnapshot?.exists
          ? decodeRecord<Records['emailObserverWork']>(workSnapshot.data())
          : null;
        producerTask = producerTaskSnapshot?.exists
          ? decodeRecord<Records['tasks']>(producerTaskSnapshot.data())
          : null;
        producerApplication = producerApplicationSnapshot?.exists
          ? decodeRecord<Records['applicationConfirmations']>(producerApplicationSnapshot.data())
          : null;
      }
      const existing = dedupe ? await tx.get(dedupe) : null;
      if (existing?.exists) {
        // A provider ID cannot redirect a message into a different conversation.
        if (existing.data()?.conversationId !== input.conversationId) {
          throw new Error('Channel message ID belongs to another conversation');
        }
        return undefined;
      }
      const now = this.store.now();
      const row = messageRecord(input, id, now);
      const ownerId = parent.get('agentId');
      if (refs.length > 0 && (typeof ownerId !== 'string' || !ownerId))
        throw new Error('Conversation owner is unavailable for recall ledger');
      if (refs.length > 0)
        await assertPrivacyErasureInactiveInTransaction(tx, this.store, ownerId as string);
      const actualSurfaces = refs.map((source) => ({
        source,
        doc: this.store.doc(
          'recallSurfaces',
          deterministicUuid('assistant:recall-surface', ownerId as string, source.sourceKey),
        ),
      }));
      const priorSurfaces = actualSurfaces.length
        ? await tx.getAll(...actualSurfaces.map((item) => item.doc))
        : [];
      if (fence) {
        const destination = outbox?.destination as { conversationId?: unknown } | null;
        const payload = outbox?.payload as {
          text?: unknown;
          taskId?: unknown;
          extraParts?: unknown;
        } | null;
        const expectedPayload = {
          text: input.text,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          extraParts: input.parts.slice(1),
        };
        const exactDashboardAppend = Boolean(
          outbox?.adapter === 'dashboard' &&
            destination?.conversationId === input.conversationId &&
            payload &&
            isDeepStrictEqual(payload, expectedPayload) &&
            isDeepStrictEqual(input.parts, [
              { type: 'text', text: input.text },
              ...input.parts.slice(1),
            ]) &&
            input.channelMessageId ===
              notificationDashboardMessageId(fence.agentId, outbox.deliveryKey, outbox.legKey),
        );
        const now = this.store.now();
        const taskNotice = Boolean(
          fence.producerTaskId &&
            fence.producerApplicationId &&
            fence.producerConfirmationMessageId &&
            !fence.producerWorkId &&
            matchesApplicationConfirmationNoticeLineage(
              producerTask,
              producerApplication,
              {
                agentId: fence.agentId,
                taskId: fence.producerTaskId,
                applicationId: fence.producerApplicationId,
                confirmationMessageId: fence.producerConfirmationMessageId,
                producerPrivacyGeneration: fence.producerPrivacyGeneration,
              },
              { now, requireLiveTaskLease: false },
            ),
        );
        if (
          ownerId !== fence.agentId ||
          !exactDashboardAppend ||
          !outbox ||
          outbox.status !== 'sending' ||
          outbox.leaseToken !== fence.leaseToken ||
          !outbox.leaseUntil ||
          outbox.leaseUntil.getTime() <= now.getTime() ||
          (outbox.producerWorkId ?? null) !== (fence.producerWorkId ?? null) ||
          (outbox.producerTaskId ?? null) !== (fence.producerTaskId ?? null) ||
          (outbox.producerApplicationId ?? null) !== (fence.producerApplicationId ?? null) ||
          (outbox.producerConfirmationMessageId ?? null) !==
            (fence.producerConfirmationMessageId ?? null) ||
          (outbox.producerPrivacyGeneration ?? null) !== fence.producerPrivacyGeneration ||
          !(
            taskNotice ||
            Boolean(
              work &&
                work.agentId === fence.agentId &&
                work.privacyGeneration === fence.producerPrivacyGeneration &&
                work.status !== 'skipped_erased' &&
                !fence.producerTaskId,
            )
          )
        )
          throw new EmailObserverEffectFenceRejectedError();
      }
      if (input.applicationConfirmationNoticeFence) {
        const noticeFence = input.applicationConfirmationNoticeFence;
        await assertPrivacyErasureGenerationInTransaction(
          tx,
          this.store,
          noticeFence.agentId,
          noticeFence.producerPrivacyGeneration,
        );
        const task = await tx.get(this.store.doc('tasks', noticeFence.taskId));
        const application = await tx.get(
          this.store.doc('applicationConfirmations', noticeFence.applicationId),
        );
        if (
          fence ||
          input.role !== 'assistant' ||
          input.origin !== 'assistant' ||
          input.taskId !== noticeFence.taskId ||
          !input.channelMessageId?.startsWith(
            `application-confirmation-notice:${noticeFence.taskId}:`,
          ) ||
          ownerId !== noticeFence.agentId ||
          !matchesApplicationConfirmationNoticeLineage(
            task.exists ? decodeRecord<Records['tasks']>(task.data()) : null,
            application.exists
              ? decodeRecord<Records['applicationConfirmations']>(application.data())
              : null,
            noticeFence,
            { now: this.store.now(), requireLiveTaskLease: true },
          )
        )
          throw new EmailObserverEffectFenceRejectedError();
      }
      tx.create(this.store.doc('messages', id), encodeRecord(row));
      if (dedupe) tx.create(dedupe, { messageId: id, conversationId: input.conversationId });
      tx.update(conversation, { updatedAt: now });
      actualSurfaces.forEach(({ source, doc }, index) => {
        const prior = priorSurfaces[index];
        if (prior?.exists) {
          const current = prior.data() as Partial<Records['recallSurfaces']>;
          if (current.agentId !== ownerId || current.sourceKey !== source.sourceKey)
            throw new Error('Recall surface ownership mismatch');
          const revised = current.sourceRevision !== source.sourceRevision;
          tx.update(
            doc,
            encodeRecord({
              suppressedAt: revised ? null : (current.suppressedAt ?? null),
              sourceRevision: source.sourceRevision,
              kind: source.kind,
              lastSurfacedAt: now,
              lastMessageId: id,
              surfaceCount: (current.surfaceCount ?? 0) + 1,
              version: (current.version ?? 1) + (revised ? 1 : 0),
            }),
          );
        } else {
          const surfaceId = deterministicUuid(
            'assistant:recall-surface',
            ownerId as string,
            source.sourceKey,
          );
          tx.create(
            doc,
            encodeRecord({
              id: surfaceId,
              agentId: ownerId,
              sourceKey: source.sourceKey,
              sourceRevision: source.sourceRevision,
              kind: source.kind,
              firstSurfacedAt: now,
              lastSurfacedAt: now,
              lastMessageId: id,
              surfaceCount: 1,
              suppressedAt: null,
              version: 1,
            }),
          );
        }
      });
      return row;
    });
  }
}
