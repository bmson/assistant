import type { CardRefreshRepository, CardRefreshRequestResult } from '@assistant/persistence';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversations, generatedCardRevisions, generatedCards, tasks } from './schema.js';
import { createTask } from './task-creation-repository.js';

const ACTIVE = [
  'pending',
  'running',
  'waiting_approval',
  'waiting_event',
  'sleeping',
  'waiting_budget',
];

export class PostgresCardRefreshRepository implements CardRefreshRepository {
  readonly kind = 'card-refresh-repository' as const;
  constructor(readonly db: Db) {}

  request(
    input: Parameters<CardRefreshRepository['request']>[0],
  ): Promise<CardRefreshRequestResult> {
    return this.db.transaction(async (tx) => {
      const [card] = await tx
        .select()
        .from(generatedCards)
        .where(
          and(
            eq(generatedCards.id, input.cardId),
            eq(generatedCards.agentId, input.agentId),
            eq(generatedCards.status, 'active'),
            isNull(generatedCards.dismissedAt),
          ),
        )
        .for('update');
      if (!card) return { ok: false, error: 'Card not found.', status: 404 };
      if (input.expectedRevisionId && input.expectedRevisionId !== card.currentRevisionId)
        return {
          ok: false,
          status: 409,
          error: 'This card changed. Reload it before starting another refresh.',
        };
      const externalEventId = input.operationId
        ? `saved-card-refresh:${input.agentId}:${card.id}:${input.operationId}`
        : undefined;
      if (externalEventId && input.expectedRevisionId) {
        const [priorOperation] = await tx
          .select({
            id: tasks.id,
            agentId: tasks.agentId,
            queueGeneration: tasks.queueGeneration,
            trigger: tasks.trigger,
          })
          .from(tasks)
          .where(eq(tasks.externalEventId, externalEventId));
        if (priorOperation) {
          const payload = (priorOperation.trigger as { payload?: Record<string, unknown> } | null)
            ?.payload;
          if (
            priorOperation.agentId !== input.agentId ||
            payload?.refreshCardId !== card.id ||
            payload?.refreshCardRevisionId !== input.expectedRevisionId
          )
            return {
              ok: false,
              status: 409,
              error: 'This card changed. Reload it before starting another refresh.',
            };
          return {
            ok: true,
            taskId: priorOperation.id,
            queueGeneration: priorOperation.queueGeneration,
            created: false,
            dispatch: 'notify',
            refreshState: 'refreshing',
          };
        }
      }
      const [active] = await tx
        .select({ id: tasks.id, queueGeneration: tasks.queueGeneration, trigger: tasks.trigger })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, input.agentId),
            sql`${tasks.trigger}->'payload'->>'refreshCardId' = ${card.id}`,
            inArray(tasks.status, ACTIVE),
          ),
        )
        .orderBy(desc(tasks.createdAt))
        .limit(1);
      if (
        active &&
        input.expectedRevisionId &&
        (active.trigger as { payload?: Record<string, unknown> } | null)?.payload
          ?.refreshCardRevisionId !== input.expectedRevisionId
      )
        return {
          ok: false,
          status: 409,
          error: 'This card changed. Reload it before starting another refresh.',
        };
      if (active && externalEventId && input.expectedRevisionId)
        return {
          ok: false,
          status: 409,
          error: 'A refresh is already running. Check its status before trying again.',
        };
      if (active)
        return {
          ok: true,
          taskId: active.id,
          queueGeneration: active.queueGeneration,
          created: false,
          dispatch: 'notify',
          refreshState: 'refreshing',
        };
      const [revision] = await tx
        .select({ spec: generatedCardRevisions.spec })
        .from(generatedCardRevisions)
        .where(eq(generatedCardRevisions.id, card.currentRevisionId));
      const formatted = input.formatInstruction(revision?.spec);
      if (!formatted)
        return {
          ok: false,
          status: 409,
          error:
            'This older card has no reliable source reference to refresh. Ask me to look it up again.',
        };
      const requestedConversation = input.conversationId ?? card.conversationId ?? undefined;
      const [owned] = requestedConversation
        ? await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, requestedConversation),
                eq(conversations.agentId, input.agentId),
                eq(conversations.channel, 'chat'),
              ),
            )
        : [];
      let destination = owned?.id;
      if (!destination) {
        const [primary] = await tx
          .select({ id: conversations.id, archivedAt: conversations.archivedAt })
          .from(conversations)
          .where(and(eq(conversations.agentId, input.agentId), eq(conversations.isPrimary, true)))
          .limit(1);
        destination = primary?.id;
        if (primary?.archivedAt) {
          await tx
            .update(conversations)
            .set({ archivedAt: null, updatedAt: sql`now()` })
            .where(eq(conversations.id, primary.id));
        }
      }
      if (!destination) {
        const [recent] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.agentId, input.agentId),
              eq(conversations.channel, 'chat'),
              isNull(conversations.archivedAt),
              sql`${conversations.metadata}->>'goalId' IS NULL`,
            ),
          )
          .orderBy(desc(conversations.updatedAt))
          .limit(1);
        if (recent) {
          await tx
            .update(conversations)
            .set({ isPrimary: true, updatedAt: sql`now()` })
            .where(eq(conversations.id, recent.id));
          destination = recent.id;
        }
      }
      if (!destination) {
        const [created] = await tx
          .insert(conversations)
          .values({ agentId: input.agentId, channel: 'chat', trust: 'owner', isPrimary: true })
          .returning({ id: conversations.id });
        if (!created) throw new Error('failed to create primary conversation');
        destination = created.id;
      }
      const result = await createTask(tx as unknown as Db, {
        agentId: input.agentId,
        conversationId: destination,
        type: 'adhoc',
        title: formatted.title,
        trust: 'owner',
        ...(externalEventId ? { externalEventId } : {}),
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
      });
      return {
        ok: true,
        taskId: result.task.id,
        queueGeneration: result.task.queueGeneration,
        created: result.created,
        dispatch: 'notify',
        refreshState: 'refreshing',
      };
    });
  }
}

export function createPostgresCardRefreshRepository(db: Db): CardRefreshRepository {
  return new PostgresCardRefreshRepository(db);
}
