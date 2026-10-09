import type { OwnerContextRepository } from '@assistant/persistence';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  agents,
  ambientSnapshots,
  commitments,
  conversations,
  locationPings,
  messages,
  ownerCard,
} from './schema.js';

function boundedCommitmentLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 120) {
    throw new Error('Owner context commitment limit must be between 1 and 120');
  }
  return limit;
}

function boundedOpenCommitmentLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
    throw new Error('Owner context commitment limit must be between 1 and 60');
  }
  return limit;
}

type CommitmentVisibility = 'open' | 'resolvable' | 'closed';

/** Shared owner-visible commitment filter for chat, resolution and closed-loop views. */
export async function listEligibleOwnerCommitments(
  db: Db,
  input: { agentId: string; limit: number; visibility: CommitmentVisibility; now?: Date },
) {
  const visibility =
    input.visibility === 'closed'
      ? inArray(commitments.status, ['resolved', 'dismissed'])
      : input.visibility === 'resolvable'
        ? and(
            isNull(commitments.resolvedAt),
            inArray(commitments.status, ['open', 'snoozed', 'stale']),
          )
        : and(
            isNull(commitments.resolvedAt),
            or(
              inArray(commitments.status, ['open', 'stale']),
              and(
                eq(commitments.status, 'snoozed'),
                lte(commitments.snoozedUntil, input.now ?? new Date()),
              ),
            ),
          );
  const validSourceFreeRow = or(
    isNull(commitments.sourceOccurrenceKey),
    and(
      isNotNull(commitments.reopenedFromId),
      isNotNull(commitments.reopenOperationId),
      sql`${commitments.sourceOccurrenceKey} = concat('manual-reopen:v1:', ${commitments.agentId}, ':', ${commitments.reopenOperationId})`,
    ),
  );
  const ordinarySourceMessage = sql`(
    ${messages.channelMessageId} is null or (
      ${messages.channelMessageId} not like 'visual-qa:%' and
      ${messages.channelMessageId} not like 'readability-%'
    )
  )`;
  const eligibleSource = or(
    and(isNull(commitments.sourceMessageId), validSourceFreeRow),
    and(
      isNotNull(commitments.sourceMessageId),
      isNotNull(messages.id),
      eq(messages.role, 'user'),
      isNull(messages.hiddenAt),
      ordinarySourceMessage,
    ),
  );
  const rows = await db
    .select({ commitment: commitments })
    .from(commitments)
    .innerJoin(
      conversations,
      and(
        eq(conversations.id, commitments.conversationId),
        eq(conversations.agentId, commitments.agentId),
      ),
    )
    .leftJoin(
      messages,
      and(
        eq(messages.id, commitments.sourceMessageId),
        eq(messages.conversationId, commitments.conversationId),
      ),
    )
    .where(
      and(
        eq(commitments.agentId, input.agentId),
        visibility,
        sql`jsonb_typeof(${conversations.metadata}) = 'object'`,
        sql`jsonb_typeof(${conversations.metadata}->'visualQaRunId') is null`,
        eligibleSource,
      ),
    )
    .orderBy(desc(commitments.updatedAt))
    .limit(boundedCommitmentLimit(input.limit));
  return rows.map(({ commitment }) => commitment);
}

export function createPostgresOwnerContextRepository(db: Db): OwnerContextRepository {
  return {
    kind: 'owner-context-repository',

    async getOwnerCard(agentId) {
      // `owner_card` predates agent scoping. It is safe only for the sole agent in
      // this installation; a multi-agent database cannot attribute the singleton.
      const configuredAgents = await db.select({ id: agents.id }).from(agents).limit(2);
      if (configuredAgents.length !== 1 || configuredAgents[0]?.id !== agentId) return null;
      const [row] = await db
        .select({ content: ownerCard.content, compiledAt: ownerCard.compiledAt })
        .from(ownerCard)
        .where(eq(ownerCard.id, 1))
        .limit(1);
      return row ?? null;
    },

    async getAmbientSnapshot(agentId) {
      const [row] = await db
        .select({
          agentId: ambientSnapshots.agentId,
          block: ambientSnapshots.block,
          flags: ambientSnapshots.flags,
          sources: ambientSnapshots.sources,
          computedAt: ambientSnapshots.computedAt,
        })
        .from(ambientSnapshots)
        .where(eq(ambientSnapshots.agentId, agentId))
        .limit(1);
      return row ?? null;
    },

    async getLatestLocation({ agentId, notBefore, notAfter, source }) {
      const [row] = await db
        .select()
        .from(locationPings)
        .where(
          and(
            eq(locationPings.agentId, agentId),
            gte(locationPings.capturedAt, notBefore),
            lte(locationPings.capturedAt, notAfter),
            source ? eq(locationPings.source, source) : undefined,
          ),
        )
        .orderBy(desc(locationPings.capturedAt))
        .limit(1);
      return row ?? null;
    },

    async listOpenCommitments({ agentId, now, limit }) {
      return listEligibleOwnerCommitments(db, {
        agentId,
        now,
        limit: boundedOpenCommitmentLimit(limit),
        visibility: 'open',
      });
    },
  };
}
