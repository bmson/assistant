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
  cardFormAdmissionExternalEventId,
  cardFormTaskAdmission,
  findCardForm,
  newTaskRecord,
} from '@assistant/persistence';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import {
  agents,
  budgets,
  conversations,
  generatedCardRevisions,
  generatedCards,
  messages,
  tasks,
} from './schema.js';

const MAX_REQUEST_BYTES = 16 * 1024;
const TASK_TITLE = 'Owner form request';
const MESSAGE_LIMIT_BYTES = 16 * 1024;

function digestSubmission(submission: CardFormSubmission, values: CardFormValues): string {
  return createHash('sha256').update(canonicalCardFormRequest(submission, values)).digest('hex');
}

function replayResult(input: {
  task: typeof tasks.$inferSelect;
  message: typeof messages.$inferSelect | undefined;
  agentId: string;
  submission: CardFormSubmission;
  payloadDigest: string;
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
    binding.payloadDigest !== input.payloadDigest ||
    !input.message ||
    input.message.taskId !== input.task.id ||
    input.message.conversationId !== input.submission.conversationId ||
    input.message.role !== 'user' ||
    input.message.origin !== 'owner' ||
    input.message.id !== binding.messageId ||
    input.message.text !== input.submission.ownerMessageText ||
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
    messageId: input.message.id,
    taskStatus: input.task.status,
    queueGeneration: input.task.queueGeneration,
    dispatch: null,
  };
}

export class PostgresCardFormAdmissionRepository implements CardFormAdmissionRepository {
  readonly kind = 'card-form-admission-repository' as const;
  constructor(readonly db: Db) {}

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

    return this.db.transaction(async (tx) => {
      // Match privacy erasure's owner lock before any card/message read.
      await lockPostgresPrivacyObservationFence(tx, input.agentId);
      const [owner] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!owner)
        return { ok: false, status: 404, error: 'This card form is no longer available.' } as const;
      const [card] = await tx
        .select()
        .from(generatedCards)
        .where(
          and(eq(generatedCards.id, submission.cardId), eq(generatedCards.agentId, input.agentId)),
        )
        .for('update');
      if (!card)
        return { ok: false, status: 404, error: 'This card form is no longer available.' } as const;
      if (card.conversationId !== submission.conversationId)
        return { ok: false, status: 404, error: 'This card form is no longer available.' } as const;
      const [revision] = await tx
        .select({ id: generatedCardRevisions.id, spec: generatedCardRevisions.spec })
        .from(generatedCardRevisions)
        .where(
          and(
            eq(generatedCardRevisions.id, submission.expectedRevisionId),
            eq(generatedCardRevisions.cardId, card.id),
          ),
        )
        .limit(1);
      if (!revision)
        return {
          ok: false,
          status: 409,
          error: 'This card changed. Reload it before submitting.',
        } as const;
      const form = findCardForm(revision.spec, submission.formId);
      const values = form ? canonicalCardFormValues(form, submission.values) : null;
      if (!form || !values)
        return {
          ok: false,
          status: 422,
          error: 'This form is unavailable or its answers are invalid.',
        } as const;
      const payloadDigest = digestSubmission(submission, values);

      const readReplay = async () => {
        const [existing] = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.externalEventId, externalEventId))
          .limit(1);
        if (!existing) return null;
        const binding = cardFormTaskAdmission(existing);
        const [message] = binding
          ? await tx
              .select()
              .from(messages)
              .where(
                and(
                  eq(messages.id, binding.messageId),
                  eq(messages.taskId, existing.id),
                  eq(messages.conversationId, submission.conversationId),
                  eq(messages.role, 'user'),
                  eq(messages.origin, 'owner'),
                ),
              )
              .limit(1)
          : [];
        return replayResult({
          task: existing,
          message,
          agentId: input.agentId,
          submission,
          payloadDigest,
        });
      };
      const prior = await readReplay();
      if (prior) return prior;

      // The card row lock serializes form submissions for this card. Keep one
      // owner/card/form request until its task reaches a terminal status.
      const [activeFormTask] = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, input.agentId),
            sql`${tasks.trigger}->'payload'->'cardFormAdmission'->>'cardId' = ${submission.cardId}`,
            sql`${tasks.trigger}->'payload'->'cardFormAdmission'->>'formId' = ${submission.formId}`,
            notInArray(tasks.status, ['done', 'failed', 'cancelled']),
          ),
        )
        .limit(1);
      if (activeFormTask) {
        const activeBinding = cardFormTaskAdmission(activeFormTask);
        if (
          activeFormTask.type !== 'chat_turn' ||
          activeFormTask.trust !== 'owner' ||
          activeFormTask.conversationId !== submission.conversationId ||
          activeBinding?.cardId !== submission.cardId ||
          activeBinding.formId !== submission.formId ||
          activeBinding.conversationId !== submission.conversationId ||
          activeFormTask.externalEventId !==
            cardFormAdmissionExternalEventId({
              agentId: input.agentId,
              operationId: activeBinding.operationId,
            })
        )
          throw new Error('Card form active-operation identity collision');
        return {
          ok: false,
          status: 409,
          reason: 'active_form',
          activeTaskId: activeFormTask.id,
          taskStatus: activeFormTask.status,
          error: 'This form request is still in progress.',
        } as const;
      }

      const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
      if (!clock) throw new Error('Missing database clock');
      const now = new Date(clock.now);
      if (
        card.status !== 'active' ||
        card.dismissedAt !== null ||
        (card.expiresAt !== null && card.expiresAt <= now)
      )
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
      const [conversation] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, submission.conversationId),
            eq(conversations.agentId, input.agentId),
            eq(conversations.channel, 'chat'),
            eq(conversations.trust, 'owner'),
          ),
        )
        .limit(1);
      if (!conversation)
        return {
          ok: false,
          status: 404,
          error: 'This conversation is no longer available.',
        } as const;
      const [budget] = await tx
        .select()
        .from(budgets)
        .where(eq(budgets.scope, 'task_default'))
        .limit(1);
      const prepared = input.prepare({
        revisionSpec: revision.spec,
        form,
        values,
        ownerMessageText: submission.ownerMessageText,
      });
      if (
        !prepared ||
        prepared.ownerMessageText !== submission.ownerMessageText ||
        !prepared.ownerMessageText.trim() ||
        Buffer.byteLength(prepared.ownerMessageText, 'utf8') > MESSAGE_LIMIT_BYTES
      )
        return { ok: false, status: 422, error: 'This form cannot safely be submitted.' } as const;
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
          requestAt: now.toISOString(),
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
          budgetUsdLimit: budget?.limitUsd ?? '0.50',
        },
        taskId,
        now,
      );
      const [created] = await tx
        .insert(tasks)
        .values(task)
        .onConflictDoNothing({
          target: tasks.externalEventId,
          where: sql`${tasks.externalEventId} IS NOT NULL`,
        })
        .returning();
      if (!created) {
        const raced = await readReplay();
        return (
          raced ?? {
            ok: false,
            status: 409,
            error: 'This form submission is being retried. Try again shortly.',
          }
        );
      }
      const [message] = await tx
        .insert(messages)
        .values({
          id: messageId,
          conversationId: submission.conversationId,
          taskId,
          role: 'user',
          origin: 'owner',
          clientId: null,
          clientDeliveredAt: null,
          clientDeliveredBy: null,
          parts: [{ type: 'text', text: prepared.ownerMessageText }],
          text: prepared.ownerMessageText,
        })
        .returning();
      if (!message) throw new Error('Form task has no owner message');
      await tx
        .update(conversations)
        .set({ updatedAt: now })
        .where(eq(conversations.id, submission.conversationId));
      return {
        ok: true,
        created: true,
        taskId,
        messageId,
        taskStatus: 'pending',
        queueGeneration: task.queueGeneration,
        dispatch: 'notify',
      } as const;
    });
  }
}

export function createPostgresCardFormAdmissionRepository(
  db: Db,
): PostgresCardFormAdmissionRepository {
  return new PostgresCardFormAdmissionRepository(db);
}
