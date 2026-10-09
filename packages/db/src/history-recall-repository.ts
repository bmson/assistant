import {
  type HistoryRecallRepository,
  historyLimit,
  validateSkillEmbedding,
} from '@assistant/persistence';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import type { Db } from './client.js';
import { withPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { conversationSegments, conversations, maintenanceCursors, messages } from './schema.js';

const isVisualQaSource = (id: string | null | undefined) =>
  id?.startsWith('visual-qa:') === true || id?.startsWith('readability-') === true;

const messageFields = {
  id: messages.id,
  conversationId: messages.conversationId,
  role: messages.role,
  text: messages.text,
  createdAt: messages.createdAt,
};

export function createPostgresHistoryRecallRepository(db: Db): HistoryRecallRepository {
  const trusted = (agentId: string) =>
    and(eq(conversations.agentId, agentId), inArray(conversations.trust, ['owner', 'assistant']));
  function afterPrivacyErasure(
    field: typeof messages.createdAt | typeof conversationSegments.startedAt,
    agentId: string,
    currentConversationId: string,
    conversationField: typeof messages.conversationId | typeof conversationSegments.conversationId,
  ) {
    const generation = `privacy-erasure-generation:${agentId}`;
    return sql`(
      not exists (
        select 1 from ${maintenanceCursors}
        where ${maintenanceCursors.name} = ${generation}
      )
      or ${conversationField} = ${currentConversationId}
      or ${field} > (
        select ${maintenanceCursors.updatedAt} from ${maintenanceCursors}
        where ${maintenanceCursors.name} = ${generation}
        limit 1
      )
    )`;
  }
  return {
    kind: 'history-recall-repository',
    async segments({ agentId, embedding, embeddingSpaceKey, exclude, limit }) {
      validateSkillEmbedding(embedding);
      const vector = JSON.stringify(embedding);
      const rows = await withPostgresPrivacyObservationFence(db, agentId, async () => {
        return db
          .select({
            conversationId: conversationSegments.conversationId,
            summary: conversationSegments.summary,
            startMessageId: conversationSegments.startMessageId,
            endMessageId: conversationSegments.endMessageId,
            startedAt: conversationSegments.startedAt,
            endedAt: conversationSegments.endedAt,
            similarity: sql<number>`1 - (${conversationSegments.embedding} <=> ${vector}::vector)`,
          })
          .from(conversationSegments)
          .innerJoin(conversations, eq(conversations.id, conversationSegments.conversationId))
          .where(
            and(
              trusted(agentId),
              eq(conversationSegments.agentId, agentId),
              eq(conversationSegments.embeddingSpaceKey, embeddingSpaceKey),
              isNotNull(conversationSegments.embedding),
              sql`length(${conversationSegments.summary}) > 0`,
              notExists(
                db
                  .select({ id: messages.id })
                  .from(messages)
                  .where(
                    and(
                      eq(messages.conversationId, conversationSegments.conversationId),
                      gte(messages.createdAt, conversationSegments.startedAt),
                      lte(messages.createdAt, conversationSegments.endedAt),
                      or(
                        like(messages.channelMessageId, 'visual-qa:%'),
                        like(messages.channelMessageId, 'readability-%'),
                      ),
                    ),
                  )
                  .limit(1),
              ),
              afterPrivacyErasure(
                conversationSegments.startedAt,
                agentId,
                exclude.conversationId,
                conversationSegments.conversationId,
              ),
              or(
                ne(conversationSegments.conversationId, exclude.conversationId),
                lt(conversationSegments.endedAt, exclude.sinceCreatedAt),
              ),
            ),
          )
          .orderBy(
            sql`${conversationSegments.embedding} <=> ${vector}::vector`,
            asc(conversationSegments.id),
          )
          .limit(historyLimit(limit));
      });
      if (rows.length === 0) return [];
      const endpoints = await db
        .select({ id: messages.id, channelMessageId: messages.channelMessageId })
        .from(messages)
        .where(
          inArray(
            messages.id,
            rows.flatMap((row) => [row.startMessageId, row.endMessageId]),
          ),
        );
      const endpointById = new Map(endpoints.map((row) => [row.id, row.channelMessageId]));
      const eligible = rows.filter(
        (row) =>
          !isVisualQaSource(endpointById.get(row.startMessageId)) &&
          !isVisualQaSource(endpointById.get(row.endMessageId)),
      );
      const keys = eligible.length
        ? await db
            .select(messageFields)
            .from(messages)
            .where(
              and(
                inArray(
                  messages.id,
                  eligible.map((row) => row.startMessageId),
                ),
                isNull(messages.hiddenAt),
              ),
            )
        : [];
      return eligible.map((row) => ({
        ...row,
        keyMessage: keys.find(
          (key) => key.id === row.startMessageId && key.conversationId === row.conversationId,
        ),
      }));
    },
    async messages({ agentId, embedding, embeddingSpaceKey, exclude, limit }) {
      validateSkillEmbedding(embedding);
      const vector = JSON.stringify(embedding);
      return withPostgresPrivacyObservationFence(db, agentId, async () => {
        return db
          .select({
            ...messageFields,
            similarity: sql<number>`1 - (${messages.embedding} <=> ${vector}::vector)`,
          })
          .from(messages)
          .innerJoin(conversations, eq(messages.conversationId, conversations.id))
          .where(
            and(
              trusted(agentId),
              eq(messages.embeddingSpaceKey, embeddingSpaceKey),
              sql`(${messages.channelMessageId} is null or (${messages.channelMessageId} not like 'visual-qa:%' and ${messages.channelMessageId} not like 'readability-%'))`,
              isNull(messages.hiddenAt),
              isNotNull(messages.embedding),
              inArray(messages.role, ['user', 'assistant']),
              sql`length(${messages.text}) > 0`,
              afterPrivacyErasure(
                messages.createdAt,
                agentId,
                exclude.conversationId,
                messages.conversationId,
              ),
              or(
                ne(messages.conversationId, exclude.conversationId),
                lt(messages.createdAt, exclude.sinceCreatedAt),
              ),
            ),
          )
          .orderBy(sql`${messages.embedding} <=> ${vector}::vector`, asc(messages.id))
          .limit(historyLimit(limit));
      });
    },
    async neighborhood({ agentId, anchor, radius, exclude }) {
      if (!Number.isInteger(radius) || radius < 0 || radius > 20)
        throw new Error('Invalid history neighborhood radius');
      return withPostgresPrivacyObservationFence(db, agentId, async () => {
        const eligible = and(
          trusted(agentId),
          eq(messages.conversationId, anchor.conversationId),
          sql`(${messages.channelMessageId} is null or (${messages.channelMessageId} not like 'visual-qa:%' and ${messages.channelMessageId} not like 'readability-%'))`,
          inArray(messages.role, ['user', 'assistant']),
          afterPrivacyErasure(
            messages.createdAt,
            agentId,
            exclude.conversationId,
            messages.conversationId,
          ),
          anchor.conversationId === exclude.conversationId
            ? lt(messages.createdAt, exclude.sinceCreatedAt)
            : undefined,
        );
        const [current] = await db
          .select(messageFields)
          .from(messages)
          .innerJoin(conversations, eq(messages.conversationId, conversations.id))
          .where(and(eligible, eq(messages.id, anchor.id)))
          .limit(1);
        if (!current) return [];
        if (radius === 0) return [current];
        const [before, after] = await Promise.all([
          db
            .select(messageFields)
            .from(messages)
            .innerJoin(conversations, eq(messages.conversationId, conversations.id))
            .where(and(eligible, lt(messages.createdAt, current.createdAt)))
            .orderBy(desc(messages.createdAt), desc(messages.id))
            .limit(radius),
          db
            .select(messageFields)
            .from(messages)
            .innerJoin(conversations, eq(messages.conversationId, conversations.id))
            .where(and(eligible, gt(messages.createdAt, current.createdAt)))
            .orderBy(asc(messages.createdAt), asc(messages.id))
            .limit(radius),
        ]);
        return [...before.reverse(), current, ...after];
      });
    },
    async recentWindowStart({ agentId, conversationId, size }) {
      const rows = await db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            trusted(agentId),
            eq(messages.conversationId, conversationId),
            sql`(${messages.channelMessageId} is null or (${messages.channelMessageId} not like 'visual-qa:%' and ${messages.channelMessageId} not like 'readability-%'))`,
            inArray(messages.role, ['user', 'assistant']),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(historyLimit(size));
      return rows.at(-1)?.createdAt ?? null;
    },
  };
}
