import type { ConversationSearchRepository } from '@assistant/persistence';
import {
  conversationMessageSourceRevision,
  historyLimit,
  validateSkillEmbedding,
} from '@assistant/persistence';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  assertPostgresPrivacyObservationFence,
  lockPostgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import { conversations, maintenanceCursors, messages } from './schema.js';

const ordinaryMessage = sql`(${messages.channelMessageId} is null or (${messages.channelMessageId} not like 'visual-qa:%' and ${messages.channelMessageId} not like 'readability-%'))`;

/** Owner- and privacy-scoped message search for the shared conversations.search tool. */
export function createPostgresConversationSearchRepository(db: Db): ConversationSearchRepository {
  async function read<T>(
    agentId: string,
    query: (tx: Pick<Db, 'select'>, hasCutoff: boolean, generation: string | null) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      const observed = await lockPostgresPrivacyObservationFence(tx, agentId);
      const generationName = `privacy-erasure-generation:${agentId}`;
      const [generation] = await tx
        .select({ cursor: maintenanceCursors.cursor, updatedAt: maintenanceCursors.updatedAt })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, generationName))
        .limit(1);
      if (generation && generation.cursor !== observed)
        throw new Error('Privacy erasure changed during conversation search');
      if (generation && !generation.updatedAt)
        throw new Error('Privacy erasure cutoff is malformed');
      const value = await query(tx, generation !== undefined, observed);
      await assertPostgresPrivacyObservationFence(tx, agentId, observed);
      return value;
    });
  }

  function cutoffClause(hasCutoff: boolean, agentId: string, currentConversationId?: string) {
    if (!hasCutoff) return undefined;
    // Compare against the database timestamp directly: converting it to a JS
    // Date truncates PostgreSQL's microseconds and can resurrect a row exactly
    // on the erasure boundary. The cutoff is exclusive, matching Firestore's
    // raw Timestamp comparison and the history-recall contract.
    const cutoff = sql`(select ${maintenanceCursors.updatedAt} from ${maintenanceCursors} where ${maintenanceCursors.name} = ${`privacy-erasure-generation:${agentId}`})`;
    const afterCutoff = sql`${messages.createdAt} > ${cutoff}`;
    const current = currentConversationId
      ? eq(messages.conversationId, currentConversationId)
      : undefined;
    return current ? or(afterCutoff, current) : afterCutoff;
  }

  return {
    async validateSources(input) {
      if (input.sourceRefs.length > 20) throw new Error('Too many conversation sources');
      const ids = input.sourceRefs.map((ref) => ref.messageId);
      if (new Set(ids).size !== ids.length) throw new Error('Duplicate conversation source');
      for (const ref of input.sourceRefs) {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.messageId) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            ref.conversationId,
          ) ||
          !/^[a-f0-9]{64}$/.test(ref.sourceRevision)
        )
          throw new Error('Invalid conversation source identity');
      }
      return read(input.agentId, async (tx, hasCutoff, observationGeneration) => {
        const sourceRows = ids.length
          ? await tx
              .select({
                messageId: messages.id,
                conversationId: messages.conversationId,
                text: messages.text,
              })
              .from(messages)
              .innerJoin(conversations, eq(conversations.id, messages.conversationId))
              .where(
                and(
                  eq(conversations.agentId, input.agentId),
                  inArray(messages.id, ids),
                  isNull(messages.hiddenAt),
                  ordinaryMessage,
                  cutoffClause(hasCutoff, input.agentId, input.currentConversationId),
                ),
              )
          : [];
        const byId = new Map(sourceRows.map((row) => [row.messageId, row]));
        return {
          unchangedSourceRefs: input.sourceRefs.map((ref) => {
            const row = byId.get(ref.messageId);
            return (
              row?.conversationId === ref.conversationId &&
              conversationMessageSourceRevision(ref.messageId, row.text) === ref.sourceRevision
            );
          }),
          observationGeneration,
        };
      });
    },
    async refreshForResume(input) {
      historyLimit(input.limit);
      if (typeof input.query !== 'string' || input.query.length < 2 || input.query.length > 500)
        throw new Error('Invalid resumed conversation search query');
      if (input.sourceRefs.length > 20) throw new Error('Too many resumed conversation sources');
      const ids = input.sourceRefs.map((ref) => ref.messageId);
      if (new Set(ids).size !== ids.length)
        throw new Error('Duplicate resumed conversation source');
      for (const ref of input.sourceRefs) {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.messageId) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            ref.conversationId,
          ) ||
          !/^[a-f0-9]{64}$/.test(ref.sourceRevision)
        )
          throw new Error('Invalid resumed conversation source identity');
      }
      return read(input.agentId, async (tx, hasCutoff, observationGeneration) => {
        const sourceRows = ids.length
          ? await tx
              .select({
                messageId: messages.id,
                conversationId: messages.conversationId,
                text: messages.text,
                createdAt: messages.createdAt,
              })
              .from(messages)
              .innerJoin(conversations, eq(conversations.id, messages.conversationId))
              .where(
                and(
                  eq(conversations.agentId, input.agentId),
                  inArray(messages.id, ids),
                  isNull(messages.hiddenAt),
                  ordinaryMessage,
                  cutoffClause(hasCutoff, input.agentId, input.currentConversationId),
                ),
              )
          : [];
        const sourceById = new Map(sourceRows.map((row) => [row.messageId, row]));
        const unchangedSourceRefs = input.sourceRefs.map((ref) => {
          const row = sourceById.get(ref.messageId);
          return (
            row?.conversationId === ref.conversationId &&
            conversationMessageSourceRevision(ref.messageId, row.text) === ref.sourceRevision
          );
        });
        const escapedQuery = input.query.replace(/[\\%_]/g, '\\$&');
        const textRows = await tx
          .select({
            messageId: messages.id,
            conversationId: messages.conversationId,
            text: messages.text,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .where(
            and(
              eq(conversations.agentId, input.agentId),
              isNull(messages.hiddenAt),
              sql`${messages.text} ILIKE ${`%${escapedQuery}%`} ESCAPE ${'\\'}`,
              ordinaryMessage,
              cutoffClause(hasCutoff, input.agentId, input.currentConversationId),
            ),
          )
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(input.limit);
        return {
          unchangedSourceRefs,
          matches: textRows.map(({ messageId, text, ...row }) => ({
            ...row,
            messageId,
            text,
            sourceRevision: conversationMessageSourceRevision(messageId, text),
          })),
          mode: 'text' as const,
          observationGeneration,
        };
      });
    },
    async semantic(input) {
      historyLimit(input.limit);
      validateSkillEmbedding(input.embedding);
      if (!/^[a-f0-9]{64}$/.test(input.embeddingSpaceKey))
        throw new Error('Invalid conversation search embedding space');
      const vector = JSON.stringify(input.embedding);
      return read(input.agentId, async (tx, hasCutoff) => {
        const rows = await tx
          .select({
            messageId: messages.id,
            conversationId: messages.conversationId,
            text: messages.text,
            createdAt: messages.createdAt,
            similarity: sql<number>`1 - (${messages.embedding} <=> ${vector}::vector)`,
          })
          .from(messages)
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .where(
            and(
              eq(conversations.agentId, input.agentId),
              eq(messages.embeddingSpaceKey, input.embeddingSpaceKey),
              isNull(messages.hiddenAt),
              isNotNull(messages.embedding),
              ordinaryMessage,
              cutoffClause(hasCutoff, input.agentId, input.currentConversationId),
            ),
          )
          .orderBy(sql`${messages.embedding} <=> ${vector}::vector`, asc(messages.id))
          .limit(input.limit);
        return rows.map(({ messageId, text, ...row }) => ({
          ...row,
          messageId,
          text,
          sourceRevision: conversationMessageSourceRevision(messageId, text),
        }));
      });
    },

    async text(input) {
      historyLimit(input.limit);
      if (typeof input.query !== 'string' || input.query.length < 2 || input.query.length > 500)
        throw new Error('Invalid conversation search query');
      return read(input.agentId, async (tx, hasCutoff) => {
        const escapedQuery = input.query.replace(/[\\%_]/g, '\\$&');
        const rows = await tx
          .select({
            messageId: messages.id,
            conversationId: messages.conversationId,
            text: messages.text,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .where(
            and(
              eq(conversations.agentId, input.agentId),
              isNull(messages.hiddenAt),
              sql`${messages.text} ILIKE ${`%${escapedQuery}%`} ESCAPE ${'\\'}`,
              ordinaryMessage,
              cutoffClause(hasCutoff, input.agentId, input.currentConversationId),
            ),
          )
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(input.limit);
        return rows.map(({ messageId, text, ...row }) => ({
          ...row,
          messageId,
          text,
          sourceRevision: conversationMessageSourceRevision(messageId, text),
        }));
      });
    },
  };
}
