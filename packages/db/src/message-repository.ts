import { isDeepStrictEqual } from 'node:util';
import type { AppendMessageInput, MessageRepository } from '@assistant/persistence';
import {
  EmailObserverEffectFenceRejectedError,
  notificationDashboardMessageId,
  recallSurfaceRefs,
} from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import { postgresApplicationConfirmationNoticeIsCurrent } from './application-confirmation-notice-fence.js';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import {
  conversations,
  emailObserverWork,
  messages,
  notificationOutbox,
  recallSurfaces,
} from './schema.js';

export function createPostgresMessageRepository(db: Db): MessageRepository {
  return {
    kind: 'message-repository',
    append: async (input: AppendMessageInput) =>
      db.transaction(async (tx) => {
        const fence = input.notificationOutboxFence;
        let claimedOutbox: typeof notificationOutbox.$inferSelect | undefined;
        let fenceWork: typeof emailObserverWork.$inferSelect | undefined;
        let currentPrivacyGeneration: string | null | undefined;
        if (fence) {
          currentPrivacyGeneration = await lockPostgresPrivacyObservationFence(
            tx as unknown as Db,
            fence.agentId,
          );
          const [conversation] = await tx
            .select({ agentId: conversations.agentId })
            .from(conversations)
            .where(eq(conversations.id, input.conversationId))
            .limit(1);
          [claimedOutbox] = await tx
            .select()
            .from(notificationOutbox)
            .where(
              and(
                eq(notificationOutbox.id, fence.legId),
                eq(notificationOutbox.agentId, fence.agentId),
              ),
            )
            .for('update')
            .limit(1);
          if (fence.producerWorkId) {
            [fenceWork] = await tx
              .select()
              .from(emailObserverWork)
              .where(
                and(
                  eq(emailObserverWork.id, fence.producerWorkId),
                  eq(emailObserverWork.agentId, fence.agentId),
                ),
              )
              .for('share')
              .limit(1);
          }
          if (conversation?.agentId !== fence.agentId)
            throw new EmailObserverEffectFenceRejectedError();
          if (fence.producerTaskId) {
            if (
              fence.producerWorkId ||
              !fence.producerApplicationId ||
              !fence.producerConfirmationMessageId ||
              !(await postgresApplicationConfirmationNoticeIsCurrent(
                tx as unknown as Db,
                {
                  agentId: fence.agentId,
                  taskId: fence.producerTaskId,
                  taskLeaseToken: '',
                  taskQueueGeneration: -1,
                  applicationId: fence.producerApplicationId,
                  confirmationMessageId: fence.producerConfirmationMessageId,
                  producerPrivacyGeneration: fence.producerPrivacyGeneration,
                },
                false,
              ))
            )
              throw new EmailObserverEffectFenceRejectedError();
          }
        }
        if (input.applicationConfirmationNoticeFence) {
          const noticeFence = input.applicationConfirmationNoticeFence;
          if (
            fence ||
            input.role !== 'assistant' ||
            input.origin !== 'assistant' ||
            input.taskId !== noticeFence.taskId ||
            !input.channelMessageId?.startsWith(
              `application-confirmation-notice:${noticeFence.taskId}:`,
            ) ||
            !(await postgresApplicationConfirmationNoticeIsCurrent(
              tx as unknown as Db,
              noticeFence,
              true,
              input.conversationId,
            ))
          )
            throw new EmailObserverEffectFenceRejectedError();
        }
        const {
          notificationOutboxFence: _notificationOutboxFence,
          applicationConfirmationNoticeFence: _applicationConfirmationNoticeFence,
          ...messageInput
        } = input;
        const refs = input.role === 'assistant' ? recallSurfaceRefs(input.parts) : [];
        let ownerAgentId: string | undefined;
        if (refs.length > 0) {
          const [conversation] = await tx
            .select({ agentId: conversations.agentId })
            .from(conversations)
            .where(eq(conversations.id, input.conversationId))
            .limit(1);
          if (!conversation) throw new Error('Conversation does not exist');
          ownerAgentId = conversation.agentId;
          await lockPostgresPrivacyObservationFence(tx, ownerAgentId);
        }
        if (fence) {
          const payload = claimedOutbox?.payload as {
            text?: unknown;
            taskId?: unknown;
            extraParts?: unknown;
          } | null;
          const destination = claimedOutbox?.destination as { conversationId?: unknown } | null;
          const expectedPayload = {
            text: input.text,
            ...(input.taskId ? { taskId: input.taskId } : {}),
            extraParts: input.parts.slice(1),
          };
          const exactDashboardAppend = Boolean(
            claimedOutbox?.adapter === 'dashboard' &&
              destination?.conversationId === input.conversationId &&
              payload &&
              isDeepStrictEqual(payload, expectedPayload) &&
              isDeepStrictEqual(input.parts, [
                { type: 'text', text: input.text },
                ...input.parts.slice(1),
              ]) &&
              input.channelMessageId ===
                notificationDashboardMessageId(
                  fence.agentId,
                  claimedOutbox.deliveryKey,
                  claimedOutbox.legKey,
                ),
          );
          const exactProducerAssociation = Boolean(
            claimedOutbox &&
              (fence.producerTaskId
                ? !fence.producerWorkId &&
                  claimedOutbox.producerWorkId === null &&
                  claimedOutbox.producerTaskId === fence.producerTaskId &&
                  claimedOutbox.producerApplicationId === fence.producerApplicationId &&
                  claimedOutbox.producerConfirmationMessageId ===
                    fence.producerConfirmationMessageId &&
                  fence.producerApplicationId &&
                  fence.producerConfirmationMessageId
                : claimedOutbox.producerTaskId === null &&
                  claimedOutbox.producerWorkId === fence.producerWorkId &&
                  fenceWork &&
                  fenceWork.privacyGeneration === fence.producerPrivacyGeneration &&
                  fenceWork.status !== 'skipped_erased'),
          );
          const now = new Date();
          if (
            !exactDashboardAppend ||
            currentPrivacyGeneration !== fence.producerPrivacyGeneration ||
            !claimedOutbox ||
            claimedOutbox.status !== 'sending' ||
            claimedOutbox.leaseToken !== fence.leaseToken ||
            !claimedOutbox.leaseUntil ||
            claimedOutbox.leaseUntil.getTime() <= now.getTime() ||
            claimedOutbox.producerPrivacyGeneration !== fence.producerPrivacyGeneration ||
            !exactProducerAssociation
          )
            throw new EmailObserverEffectFenceRejectedError();
        }
        // channel_message_id's unique index is partial (WHERE NOT NULL) — the
        // ON CONFLICT arbiter must match its predicate, and only applies when a
        // channel id is present at all (chat messages have none).
        const [row] = input.channelMessageId
          ? await tx
              .insert(messages)
              .values(messageInput)
              .onConflictDoNothing({
                target: messages.channelMessageId,
                where: sql`${messages.channelMessageId} IS NOT NULL`,
              })
              .returning()
          : await tx.insert(messages).values(messageInput).returning();
        if (row && input.role === 'assistant') {
          if (refs.length > 0) {
            if (!ownerAgentId)
              throw new Error('Conversation owner is unavailable for recall ledger');
            const now = row.createdAt;
            for (const ref of refs) {
              const [current] = await tx
                .select()
                .from(recallSurfaces)
                .where(
                  and(
                    eq(recallSurfaces.agentId, ownerAgentId),
                    eq(recallSurfaces.sourceKey, ref.sourceKey),
                  ),
                )
                .for('update')
                .limit(1);
              if (current) {
                const revised = current.sourceRevision !== ref.sourceRevision;
                await tx
                  .update(recallSurfaces)
                  .set({
                    suppressedAt: revised ? null : current.suppressedAt,
                    sourceRevision: ref.sourceRevision,
                    kind: ref.kind,
                    lastSurfacedAt: now,
                    lastMessageId: row.id,
                    surfaceCount: current.surfaceCount + 1,
                    version: current.version + (revised ? 1 : 0),
                  })
                  .where(eq(recallSurfaces.id, current.id));
                continue;
              }
              await tx
                .insert(recallSurfaces)
                .values({
                  agentId: ownerAgentId,
                  sourceKey: ref.sourceKey,
                  sourceRevision: ref.sourceRevision,
                  kind: ref.kind,
                  firstSurfacedAt: now,
                  lastSurfacedAt: now,
                  lastMessageId: row.id,
                  surfaceCount: 1,
                })
                .onConflictDoNothing();
            }
          }
        }
        await tx
          .update(conversations)
          .set({ updatedAt: sql`now()` })
          .where(eq(conversations.id, input.conversationId));
        return row;
      }),
  };
}
