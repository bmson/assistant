import { createHash, randomUUID } from 'node:crypto';
import type {
  CardFormAdmissionRepository,
  CardFormAdmissionResult,
  CardFormSubmission,
  CardFormValues,
} from '@assistant/persistence';
import {
  CardFormSubmissionSchema,
  canonicalCardFormRequest,
  canonicalCardFormValues,
  cardFormAdmissionActiveEventId,
  cardFormAdmissionExternalEventId,
  cardFormTaskAdmission,
  findCardForm,
  newTaskRecord,
} from '@assistant/persistence';
import { assertFirestoreInstallationOwner } from './installation-owner.js';
import { createWakeIntent } from './outbox.js';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const MAX_REQUEST_BYTES = 16 * 1024;
const TASK_TITLE = 'Owner form request';

function digestSubmission(submission: CardFormSubmission, values: CardFormValues): string {
  return createHash('sha256').update(canonicalCardFormRequest(submission, values)).digest('hex');
}

function resultFromReplay(input: {
  task: RecordsTask;
  message: FirebaseFirestore.DocumentSnapshot;
  agentId: string;
  submission: CardFormSubmission;
  digest: string;
}): CardFormAdmissionResult {
  const binding = cardFormTaskAdmission(input.task);
  if (
    input.task.agentId !== input.agentId ||
    input.task.type !== 'chat_turn' ||
    input.task.trust !== 'owner' ||
    input.task.conversationId !== input.submission.conversationId ||
    !binding ||
    binding.operationId !== input.submission.operationId ||
    binding.cardId !== input.submission.cardId ||
    binding.expectedRevisionId !== input.submission.expectedRevisionId ||
    binding.conversationId !== input.submission.conversationId ||
    binding.formId !== input.submission.formId ||
    binding.payloadDigest !== input.digest ||
    !input.message.exists ||
    input.message.get('taskId') !== input.task.id ||
    input.message.get('conversationId') !== input.submission.conversationId ||
    input.message.get('role') !== 'user' ||
    input.message.get('origin') !== 'owner' ||
    input.message.get('id') !== binding.messageId ||
    input.message.get('text') !== input.submission.ownerMessageText ||
    (input.task.trigger as { payload?: { text?: unknown } } | null)?.payload?.text !==
      input.submission.ownerMessageText
  )
    return {
      ok: false,
      status: 409,
      error: 'This form submission conflicts with an earlier operation.',
    };
  return {
    ok: true,
    created: false,
    taskId: input.task.id,
    messageId: binding.messageId,
    taskStatus: String(input.task.status),
    queueGeneration: input.task.queueGeneration,
    dispatch: null,
  };
}

type RecordsTask = import('@assistant/persistence').Records['tasks'];

export class FirestoreCardFormAdmissionRepository implements CardFormAdmissionRepository {
  readonly kind = 'card-form-admission-repository' as const;
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId?: string,
  ) {}

  async submit(
    input: Parameters<CardFormAdmissionRepository['submit']>[0],
  ): Promise<CardFormAdmissionResult> {
    const parsed = CardFormSubmissionSchema.safeParse(input.submission);
    if (
      !parsed.success ||
      Buffer.byteLength(JSON.stringify(input.submission), 'utf8') > MAX_REQUEST_BYTES
    )
      return {
        ok: false,
        status: 422,
        error: 'This form could not be submitted. Review its fields and try again.',
      };
    const submission = parsed.data;
    const externalEventId = cardFormAdmissionExternalEventId({
      agentId: input.agentId,
      operationId: submission.operationId,
    });
    const opRef = this.store.doc(
      'taskEventKeys',
      createHash('sha256').update(externalEventId).digest('hex'),
    );
    const activeExternalEventId = cardFormAdmissionActiveEventId({
      agentId: input.agentId,
      cardId: submission.cardId,
      formId: submission.formId,
    });
    const activeRef = this.store.doc(
      'taskEventKeys',
      createHash('sha256').update(activeExternalEventId).digest('hex'),
    );
    await assertFirestoreInstallationOwner(this.store, this.configuredAgentId ?? input.agentId);

    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const ownerRef = this.store.doc('agents', input.agentId);
      const cardRef = this.store.doc('generatedCards', submission.cardId);
      const revisionRef = this.store.doc('generatedCardRevisions', submission.expectedRevisionId);
      const conversationRef = this.store.doc('conversations', submission.conversationId);
      const budgetRef = this.store.doc('budgets', 'task_default');
      const [
        owner,
        cardSnapshot,
        revisionSnapshot,
        conversationSnapshot,
        operationSnapshot,
        activeSnapshot,
        budget,
      ] = await tx.getAll(
        ownerRef,
        cardRef,
        revisionRef,
        conversationRef,
        opRef,
        activeRef,
        budgetRef,
      );
      if (
        !owner?.exists ||
        owner.get('id') !== input.agentId ||
        owner.id !== documentKey(input.agentId)
      )
        return { ok: false, status: 404, error: 'This owner is no longer available.' } as const;
      if (!cardSnapshot?.exists)
        return { ok: false, status: 404, error: 'This card form is no longer available.' } as const;
      const card = decodeRecord<Record<string, unknown>>(cardSnapshot.data());
      if (
        card.id !== submission.cardId ||
        card.agentId !== input.agentId ||
        card.conversationId !== submission.conversationId
      )
        return { ok: false, status: 404, error: 'This card form is no longer available.' } as const;
      if (!revisionSnapshot?.exists || revisionSnapshot.get('cardId') !== submission.cardId)
        return {
          ok: false,
          status: 409,
          error: 'This card changed. Reload it before submitting.',
        } as const;
      const spec = revisionSnapshot.get('spec');
      const form = findCardForm(spec, submission.formId);
      const values = form ? canonicalCardFormValues(form, submission.values) : null;
      if (!form || !values)
        return {
          ok: false,
          status: 422,
          error: 'This form is unavailable or its answers are invalid.',
        } as const;
      const payloadDigest = digestSubmission(submission, values);

      if (operationSnapshot?.exists) {
        const priorTaskId = operationSnapshot.get('taskId');
        if (typeof priorTaskId !== 'string')
          throw new Error('Card form operation index is malformed');
        const priorTaskSnapshot = await tx.get(this.store.doc('tasks', priorTaskId));
        if (!priorTaskSnapshot.exists)
          throw new Error('Card form operation index points to a missing task');
        const priorTask = decodeRecord<RecordsTask>(priorTaskSnapshot.data());
        const binding = cardFormTaskAdmission(priorTask);
        const message = binding
          ? await tx.get(this.store.doc('messages', binding.messageId))
          : null;
        if (!message) throw new Error('Card form task has no owner message binding');
        return resultFromReplay({
          task: priorTask,
          message,
          agentId: input.agentId,
          submission,
          digest: payloadDigest,
        });
      }

      if (activeSnapshot?.exists) {
        const activeTaskId = activeSnapshot.get('taskId');
        if (typeof activeTaskId !== 'string')
          throw new Error('Card form active-operation index is malformed');
        const activeTaskSnapshot = await tx.get(this.store.doc('tasks', activeTaskId));
        if (!activeTaskSnapshot.exists)
          throw new Error('Card form active-operation index points to a missing task');
        const activeTask = decodeRecord<RecordsTask>(activeTaskSnapshot.data());
        const activeBinding = cardFormTaskAdmission(activeTask);
        if (
          activeSnapshot.get('agentId') !== input.agentId ||
          activeSnapshot.get('cardId') !== submission.cardId ||
          activeSnapshot.get('formId') !== submission.formId ||
          activeSnapshot.get('operationId') !== activeBinding?.operationId ||
          activeTask.id !== activeTaskId ||
          activeTask.agentId !== input.agentId ||
          activeTask.type !== 'chat_turn' ||
          activeTask.trust !== 'owner' ||
          activeTask.conversationId !== submission.conversationId ||
          typeof activeTask.status !== 'string' ||
          activeBinding?.cardId !== submission.cardId ||
          activeBinding.formId !== submission.formId ||
          activeBinding.conversationId !== submission.conversationId ||
          activeTask.externalEventId !==
            cardFormAdmissionExternalEventId({
              agentId: input.agentId,
              operationId: activeBinding.operationId,
            })
        )
          throw new Error('Card form active-operation identity collision');
        if (!['done', 'failed', 'cancelled'].includes(String(activeTask.status)))
          return {
            ok: false,
            status: 409,
            reason: 'active_form',
            activeTaskId,
            taskStatus: activeTask.status,
            error: 'This form request is still in progress.',
          } as const;
      }

      const now = this.store.now();
      const expiresAt = card.expiresAt;
      const expired = expiresAt instanceof Date && expiresAt <= now;
      if (card.status !== 'active' || card.dismissedAt !== null || expired)
        return {
          ok: false,
          status: 409,
          error: 'This card changed or expired. Reload it before submitting.',
        } as const;
      if (card.currentRevisionId !== submission.expectedRevisionId)
        return {
          ok: false,
          status: 409,
          reason: 'stale_revision',
          error: 'This form version changed. Review the current card before submitting.',
        } as const;
      const conversation = decodeRecord<Record<string, unknown>>(conversationSnapshot?.data());
      if (
        !conversationSnapshot?.exists ||
        conversation.agentId !== input.agentId ||
        conversation.channel !== 'chat' ||
        conversation.trust !== 'owner'
      )
        return {
          ok: false,
          status: 404,
          error: 'This conversation is no longer available.',
        } as const;
      const prepared = input.prepare({
        revisionSpec: spec,
        form,
        values,
        ownerMessageText: submission.ownerMessageText,
      });
      if (
        !prepared ||
        prepared.ownerMessageText !== submission.ownerMessageText ||
        !prepared.ownerMessageText.trim() ||
        Buffer.byteLength(prepared.ownerMessageText, 'utf8') > MAX_REQUEST_BYTES
      )
        return { ok: false, status: 422, error: 'This form cannot safely be submitted.' } as const;

      const nowDate = now;
      const taskId = randomUUID();
      const messageId = randomUUID();
      const trigger = {
        source: 'chat',
        agentId: input.agentId,
        conversationId: submission.conversationId,
        trust: 'owner',
        payload: {
          text: prepared.ownerMessageText,
          triggerMessageId: messageId,
          requestAt: nowDate.toISOString(),
          intentRevision: 1,
          clientOperationId: submission.operationId,
          autonomous: false,
          force: false,
          spoken: false,
          triagedActionable: true,
          chatAdmission: {
            protocol: 'owner-chat-v1',
            clientOperationId: submission.operationId,
            requestHash: payloadDigest,
            triggerMessageId: messageId,
            phase: 'queued',
            triageOutcome: 'actionable',
          },
          cardFormAdmission: {
            protocol: 'card-form-v1',
            operationId: submission.operationId,
            cardId: submission.cardId,
            expectedRevisionId: submission.expectedRevisionId,
            conversationId: submission.conversationId,
            formId: submission.formId,
            payloadDigest,
            messageId,
          },
        },
      };
      const task = newTaskRecord(
        {
          agentId: input.agentId,
          conversationId: submission.conversationId,
          type: 'chat_turn',
          trust: 'owner',
          title: TASK_TITLE,
          externalEventId,
          trigger,
          budgetUsdLimit: budget?.get('limitUsd') ?? '0.50',
        },
        taskId,
        nowDate,
      );
      const messageRecord = {
        id: messageId,
        conversationId: submission.conversationId,
        taskId,
        role: 'user',
        origin: 'owner',
        parts: [{ type: 'text', text: prepared.ownerMessageText }],
        text: prepared.ownerMessageText,
        clientId: null,
        clientDeliveredAt: null,
        clientDeliveredBy: null,
        channelMessageId: null,
        embedding: null,
        embeddingSpaceKey: null,
        hiddenAt: null,
        createdAt: nowDate,
        appendSequence: '00000000000000000000',
      };
      tx.create(this.store.doc('tasks', taskId), encodeRecord(task));
      tx.create(opRef, { taskId, createdAt: nowDate });
      tx.set(activeRef, {
        taskId,
        agentId: input.agentId,
        cardId: submission.cardId,
        formId: submission.formId,
        operationId: submission.operationId,
        updatedAt: nowDate,
      });
      tx.create(this.store.doc('messages', messageId), encodeRecord(messageRecord));
      tx.update(conversationRef, { updatedAt: nowDate });
      createWakeIntent(tx, this.store, {
        taskId,
        generation: task.queueGeneration,
        availableAt: nowDate,
      });
      return {
        ok: true,
        created: true,
        taskId,
        messageId,
        taskStatus: task.status,
        queueGeneration: task.queueGeneration,
        dispatch: 'outbox',
      } as const;
    });
  }
}

export function createFirestoreCardFormAdmissionRepository(
  store: InstallationStore,
  configuredAgentId?: string,
): FirestoreCardFormAdmissionRepository {
  return new FirestoreCardFormAdmissionRepository(store, configuredAgentId);
}
