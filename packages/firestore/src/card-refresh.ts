import { createHash, randomUUID } from 'node:crypto';
import {
  type CardRefreshRepository,
  type CardRefreshRequestResult,
  newTaskRecord,
  type Records,
} from '@assistant/persistence';
import { createWakeIntent } from './outbox.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

const ACTIVE = [
  'pending',
  'running',
  'waiting_approval',
  'waiting_event',
  'sleeping',
  'waiting_budget',
];

function primaryConversationId(agentId: string): string {
  const hex = createHash('sha256')
    .update(`assistant:primary-conversation:${agentId}`)
    .digest('hex');
  const value = `${hex.slice(0, 12)}5${hex.slice(13, 16)}8${hex.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(
    16,
    20,
  )}-${value.slice(20)}`;
}

export class FirestoreCardRefreshRepository implements CardRefreshRepository {
  readonly kind = 'card-refresh-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async request(
    input: Parameters<CardRefreshRepository['request']>[0],
  ): Promise<CardRefreshRequestResult> {
    const taskId = randomUUID();
    const externalEventId = input.operationId
      ? `saved-card-refresh:${input.agentId}:${input.cardId}:${input.operationId}`
      : undefined;
    const operationRef = externalEventId
      ? this.store.doc('taskEventKeys', createHash('sha256').update(externalEventId).digest('hex'))
      : null;
    return this.store.db.runTransaction(async (tx) => {
      const cardRef = this.store.doc('generatedCards', input.cardId);
      const guardRef = this.store.doc('cardRefreshKeys', input.cardId);
      const erasureRef = this.store.doc('privacyErasureJobs', input.agentId);
      const snapshots = await tx.getAll(
        cardRef,
        guardRef,
        erasureRef,
        ...(operationRef ? [operationRef] : []),
      );
      const [cardSnapshot, guardSnapshot, erasure, operation] = snapshots;
      if (!cardSnapshot || !guardSnapshot || !erasure)
        throw new Error('Card refresh transaction read failed');
      if (
        erasure.exists &&
        (erasure.get('agentId') !== input.agentId || privacyErasureIsActive(erasure.get('status')))
      )
        return { ok: false, error: 'Card not found.', status: 404 } as const;
      if (!cardSnapshot.exists)
        return { ok: false, error: 'Card not found.', status: 404 } as const;
      const card = decodeRecord<Records['generatedCards']>(cardSnapshot.data());
      if (
        card.id !== input.cardId ||
        card.agentId !== input.agentId ||
        card.status !== 'active' ||
        card.dismissedAt !== null
      )
        return { ok: false, error: 'Card not found.', status: 404 } as const;
      if (input.expectedRevisionId && input.expectedRevisionId !== card.currentRevisionId)
        return {
          ok: false,
          status: 409,
          error: 'This card changed. Reload it before starting another refresh.',
        } as const;

      if (operation?.exists) {
        const priorTaskId = operation.get('taskId');
        if (typeof priorTaskId !== 'string')
          throw new Error('Saved-card refresh operation index is malformed');
        const priorTaskSnapshot = await tx.get(this.store.doc('tasks', priorTaskId));
        if (!priorTaskSnapshot.exists)
          throw new Error('Saved-card refresh operation index points to a missing task');
        const priorTask = decodeRecord<Records['tasks']>(priorTaskSnapshot.data());
        const priorPayload = (priorTask.trigger as { payload?: Record<string, unknown> })?.payload;
        const sameOperationIdentity =
          priorTask.agentId === input.agentId && priorPayload?.refreshCardId === card.id;
        if (
          input.expectedRevisionId &&
          (!sameOperationIdentity ||
            priorPayload?.refreshCardRevisionId !== input.expectedRevisionId)
        )
          return {
            ok: false,
            status: 409,
            error: 'This card changed. Reload it before starting another refresh.',
          } as const;
        if (!sameOperationIdentity)
          throw new Error('Saved-card refresh operation identity collision');
        return {
          ok: true,
          taskId: priorTask.id,
          queueGeneration: priorTask.queueGeneration,
          created: false,
          dispatch: 'outbox',
          refreshState: 'refreshing',
        } as const;
      }

      const guardedTaskId = guardSnapshot.exists ? String(guardSnapshot.get('taskId') ?? '') : '';
      const guardedTask = guardedTaskId
        ? await tx.get(this.store.doc('tasks', guardedTaskId))
        : null;
      if (guardedTask?.exists) {
        const task = decodeRecord<Records['tasks']>(guardedTask.data());
        if (
          task.agentId === input.agentId &&
          ACTIVE.includes(task.status) &&
          (task.trigger as { payload?: { refreshCardId?: unknown } })?.payload?.refreshCardId ===
            card.id
        ) {
          const taskRevisionId = (task.trigger as { payload?: Record<string, unknown> }).payload
            ?.refreshCardRevisionId;
          if (input.expectedRevisionId && taskRevisionId !== input.expectedRevisionId)
            return {
              ok: false,
              status: 409,
              error: 'This card changed. Reload it before starting another refresh.',
            } as const;
          if (operationRef)
            tx.create(operationRef, { taskId: task.id, createdAt: this.store.now() });
          return {
            ok: true,
            taskId: task.id,
            queueGeneration: task.queueGeneration,
            created: false,
            dispatch: 'outbox',
            refreshState: 'refreshing',
          } as const;
        }
      }

      const activeQuery = this.store
        .collection('tasks')
        .where('agentId', '==', input.agentId)
        .where('trigger.payload.refreshCardId', '==', card.id)
        .where('status', 'in', ACTIVE)
        .orderBy('createdAt', 'desc')
        .limit(1);
      const active = await tx.get(activeQuery);
      const existing = active.docs[0];
      if (existing) {
        const task = decodeRecord<Records['tasks']>(existing.data());
        if (ACTIVE.includes(task.status)) {
          const taskRevisionId = (task.trigger as { payload?: Record<string, unknown> }).payload
            ?.refreshCardRevisionId;
          if (input.expectedRevisionId && taskRevisionId !== input.expectedRevisionId)
            return {
              ok: false,
              status: 409,
              error: 'This card changed. Reload it before starting another refresh.',
            } as const;
          tx.set(guardRef, { taskId: task.id, updatedAt: this.store.now() });
          if (operationRef)
            tx.create(operationRef, { taskId: task.id, createdAt: this.store.now() });
          return {
            ok: true,
            taskId: task.id,
            queueGeneration: task.queueGeneration,
            created: false,
            dispatch: 'outbox',
            refreshState: 'refreshing',
          } as const;
        }
      }

      const revision = await tx.get(
        this.store.doc('generatedCardRevisions', card.currentRevisionId),
      );
      const formatted = input.formatInstruction(revision.exists ? revision.get('spec') : undefined);
      if (!formatted)
        return {
          ok: false,
          status: 409,
          error:
            'This older card has no reliable source reference to refresh. Ask me to look it up again.',
        } as const;

      const requestedConversation = input.conversationId ?? card.conversationId ?? undefined;
      const requested = requestedConversation
        ? await tx.get(this.store.doc('conversations', requestedConversation))
        : null;
      let destination =
        requested?.exists &&
        requested.get('agentId') === input.agentId &&
        requested.get('channel') === 'chat'
          ? requestedConversation
          : undefined;
      let createPrimary = false;
      let restorePrimary = false;
      if (!destination) {
        const primary = await tx.get(
          this.store
            .collection('conversations')
            .where('agentId', '==', input.agentId)
            .where('channel', '==', 'chat')
            .where('trust', '==', 'owner')
            .where('isPrimary', '==', true)
            .limit(1),
        );
        const primaryConversation = primary.docs[0];
        destination = primaryConversation?.get('id');
        restorePrimary = Boolean(primaryConversation?.get('archivedAt'));
      }
      let promotePrimary = false;
      if (!destination) {
        destination = primaryConversationId(input.agentId);
        const deterministic = await tx.get(this.store.doc('conversations', destination));
        if (deterministic.exists) {
          if (
            deterministic.get('agentId') !== input.agentId ||
            deterministic.get('channel') !== 'chat' ||
            deterministic.get('trust') !== 'owner'
          )
            throw new Error('Deterministic primary conversation identity collision');
          promotePrimary = deterministic.get('isPrimary') !== true;
          restorePrimary = Boolean(deterministic.get('archivedAt'));
        } else createPrimary = true;
      }

      const now = this.store.now();
      const task = newTaskRecord(
        {
          agentId: input.agentId,
          conversationId: destination,
          type: 'adhoc',
          title: formatted.title,
          trust: 'owner',
          externalEventId,
          trigger: {
            source: 'internal',
            agentId: input.agentId,
            conversationId: destination,
            trust: 'owner',
            payload: {
              instruction: formatted.instruction,
              refreshCardId: card.id,
              ...(input.expectedRevisionId
                ? { refreshCardRevisionId: input.expectedRevisionId }
                : {}),
              taintedOrigin: true,
            },
          },
        },
        taskId,
        now,
      );
      if (createPrimary)
        tx.set(
          this.store.doc('conversations', destination),
          encodeRecord({
            id: destination,
            agentId: input.agentId,
            channel: 'chat',
            title: '',
            trust: 'owner',
            modelOverride: null,
            isPrimary: true,
            metadata: {},
            archivedAt: null,
            archived: false,
            lastReadAt: null,
            createdAt: now,
            updatedAt: now,
          }),
        );
      else if (promotePrimary || restorePrimary)
        tx.update(this.store.doc('conversations', destination), {
          ...(promotePrimary ? { isPrimary: true } : {}),
          archivedAt: null,
          archived: false,
          updatedAt: now,
        });
      tx.create(this.store.doc('tasks', task.id), encodeRecord(task));
      if (operationRef) tx.create(operationRef, { taskId: task.id, createdAt: now });
      tx.set(guardRef, { taskId: task.id, updatedAt: now });
      createWakeIntent(tx, this.store, {
        taskId: task.id,
        generation: task.queueGeneration,
        availableAt: now,
      });
      return {
        ok: true,
        taskId: task.id,
        queueGeneration: task.queueGeneration,
        created: true,
        dispatch: 'outbox',
        refreshState: 'refreshing',
      } as const;
    });
  }
}

export function createFirestoreCardRefreshRepository(
  store: InstallationStore,
): CardRefreshRepository {
  return new FirestoreCardRefreshRepository(store);
}
