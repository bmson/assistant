import type {
  GeneratedCardPersistInput,
  GeneratedCardPersistResult,
  GeneratedCardRecord,
  GeneratedCardRepository,
  Records,
} from '@assistant/persistence';
import { emailObserverPreparedCardMatches } from '@assistant/persistence';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import {
  conversations,
  emailObserverWork,
  generatedCardRevisions,
  generatedCards,
  tasks,
} from './schema.js';

function validateInput(input: GeneratedCardPersistInput): void {
  if (
    !input.agentId ||
    !input.id ||
    !input.revisionId ||
    !input.sourceFingerprint ||
    !input.sourceLabel ||
    input.spec === null ||
    input.spec === undefined
  )
    throw new Error('Invalid generated card');
  if (input.expiresAt && !Number.isFinite(input.expiresAt.getTime()))
    throw new Error('Invalid generated card expiry');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

function sameSpec(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

async function databaseNow(db: Db): Promise<Date> {
  const [clock] = await db.execute<{ now: string }>(sql`select clock_timestamp() as now`);
  if (!clock) throw new Error('Missing database clock');
  return new Date(clock.now);
}

export function createPostgresGeneratedCardRepository(db: Db): GeneratedCardRepository {
  return {
    kind: 'generated-card-repository',

    async createOrRevise(input): Promise<GeneratedCardPersistResult> {
      validateInput(input);
      return db.transaction(async (tx) => {
        if (input.emailObserverEffectFence) {
          const fence = input.emailObserverEffectFence;
          if (fence.agentId !== input.agentId)
            throw new Error('Email observer card effect owner mismatch');
          const txDb = tx as unknown as Db;
          const privacyGeneration = await lockPostgresPrivacyObservationFence(txDb, fence.agentId);
          if (privacyGeneration !== fence.expectedPrivacyGeneration)
            throw new Error('Email observer card effect privacy generation changed');
          const [work] = await tx
            .select()
            .from(emailObserverWork)
            .where(
              and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, fence.agentId)),
            )
            .for('update')
            .limit(1);
          const effectNow = await databaseNow(txDb);
          if (
            !work ||
            work.agentId !== fence.agentId ||
            work.claimToken !== fence.claimToken ||
            work.claimGeneration !== fence.claimGeneration ||
            work.privacyGeneration !== fence.expectedPrivacyGeneration ||
            work.status !== 'prepared' ||
            !work.leaseExpiresAt ||
            work.leaseExpiresAt <= effectNow ||
            work.observerKey !== 'google.email-card' ||
            !emailObserverPreparedCardMatches(work.preparedResult, input)
          )
            throw new Error('Email observer card effect claim is no longer current');
        }
        if (input.conversationId) {
          const [conversation] = await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, input.conversationId),
                eq(conversations.agentId, input.agentId),
              ),
            )
            .limit(1);
          if (!conversation) throw new Error('Conversation does not belong to this agent');
        }

        let [card] = await tx
          .select()
          .from(generatedCards)
          .where(
            and(
              eq(generatedCards.agentId, input.agentId),
              input.targetCardId
                ? eq(generatedCards.id, input.targetCardId)
                : eq(generatedCards.sourceFingerprint, input.sourceFingerprint),
            ),
          )
          .for('update');

        const now = await databaseNow(tx as unknown as Db);
        if (input.emailObserverEffectFence) {
          const fence = input.emailObserverEffectFence;
          const [work] = await tx
            .select({
              status: emailObserverWork.status,
              claimToken: emailObserverWork.claimToken,
              claimGeneration: emailObserverWork.claimGeneration,
              leaseExpiresAt: emailObserverWork.leaseExpiresAt,
              privacyGeneration: emailObserverWork.privacyGeneration,
              observerKey: emailObserverWork.observerKey,
              preparedResult: emailObserverWork.preparedResult,
            })
            .from(emailObserverWork)
            .where(
              and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, fence.agentId)),
            )
            .for('update')
            .limit(1);
          if (
            !work ||
            work.status !== 'prepared' ||
            work.claimToken !== fence.claimToken ||
            work.claimGeneration !== fence.claimGeneration ||
            work.privacyGeneration !== fence.expectedPrivacyGeneration ||
            !work.leaseExpiresAt ||
            work.leaseExpiresAt <= now ||
            work.observerKey !== 'google.email-card' ||
            !emailObserverPreparedCardMatches(work.preparedResult, input)
          )
            throw new Error('Email observer card effect claim expired before card write');
        }
        if (input.targetCardId && (card?.status !== 'active' || card.dismissedAt))
          throw new Error('Generated card refresh target is unavailable');
        if (input.targetRevisionId && card?.currentRevisionId !== input.targetRevisionId)
          throw new Error('Generated card refresh revision is stale');
        if (!card) {
          const [sameId] = await tx
            .select({ id: generatedCards.id })
            .from(generatedCards)
            .where(eq(generatedCards.id, input.id))
            .limit(1);
          if (sameId) throw new Error('Generated card ID belongs to another card');
          const [sameRevision] = await tx
            .select({ cardId: generatedCardRevisions.cardId })
            .from(generatedCardRevisions)
            .where(eq(generatedCardRevisions.id, input.revisionId))
            .limit(1);
          if (sameRevision) throw new Error('Generated card revision belongs to another card');

          [card] = await tx
            .insert(generatedCards)
            .values({
              id: input.id,
              agentId: input.agentId,
              conversationId: input.conversationId ?? null,
              messageId: null,
              status: 'active',
              sourceLabel: input.sourceLabel,
              sourceFingerprint: input.sourceFingerprint,
              currentRevisionId: input.revisionId,
              expiresAt: input.expiresAt,
              dismissedAt: null,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({
              target: [generatedCards.agentId, generatedCards.sourceFingerprint],
            })
            .returning();
          if (card) {
            const [revision] = await tx
              .insert(generatedCardRevisions)
              .values({
                id: input.revisionId,
                cardId: card.id,
                version: 1,
                spec: input.spec,
                createdAt: now,
              })
              .returning();
            if (!revision) throw new Error('Generated card revision was not created');
            return { card, revision };
          }

          // A concurrent creator won the unique source fence. Re-read it in
          // this transaction and continue through the idempotent revise path.
          [card] = await tx
            .select()
            .from(generatedCards)
            .where(
              and(
                eq(generatedCards.agentId, input.agentId),
                eq(generatedCards.sourceFingerprint, input.sourceFingerprint),
              ),
            )
            .for('update');
          if (!card) throw new Error('Generated card conflict without an existing card');
        }

        const [current] = await tx
          .select()
          .from(generatedCardRevisions)
          .where(eq(generatedCardRevisions.id, card.currentRevisionId))
          .for('update');
        if (!current || current.cardId !== card.id)
          throw new Error('Generated card current revision does not belong to the card');
        const [incoming] = await tx
          .select({ cardId: generatedCardRevisions.cardId })
          .from(generatedCardRevisions)
          .where(eq(generatedCardRevisions.id, input.revisionId))
          .limit(1);
        if (incoming && incoming.cardId !== card.id)
          throw new Error('Generated card revision belongs to another card');
        if (sameSpec(current.spec, input.spec)) {
          if (!input.touch) return { card, revision: current };
          const [updated] = await tx
            .update(generatedCards)
            .set({
              status: 'active',
              dismissedAt: null,
              sourceLabel: input.sourceLabel,
              expiresAt: input.expiresAt,
              updatedAt: now,
            })
            .where(eq(generatedCards.id, card.id))
            .returning();
          if (!updated) throw new Error('Generated card disappeared while refreshing');
          return { card: updated, revision: current };
        }
        if (input.revisionId === current.id)
          throw new Error('Generated card revision ID is already in use');

        const [revision] = await tx
          .insert(generatedCardRevisions)
          .values({
            id: input.revisionId,
            cardId: card.id,
            version: current.version + 1,
            spec: input.spec,
            createdAt: now,
          })
          .returning();
        if (!revision) throw new Error('Generated card revision was not created');
        const [updated] = await tx
          .update(generatedCards)
          .set({
            currentRevisionId: revision.id,
            status: 'active',
            dismissedAt: null,
            sourceLabel: input.sourceLabel,
            expiresAt: input.expiresAt,
            updatedAt: now,
          })
          .where(eq(generatedCards.id, card.id))
          .returning();
        if (!updated) throw new Error('Generated card disappeared while revising');
        return { card: updated, revision };
      });
    },

    async get(agentId, cardId): Promise<GeneratedCardRecord | null> {
      if (!agentId || !cardId) return null;
      const [row] = await db
        .select()
        .from(generatedCards)
        .innerJoin(
          generatedCardRevisions,
          and(
            eq(generatedCardRevisions.id, generatedCards.currentRevisionId),
            eq(generatedCardRevisions.cardId, generatedCards.id),
          ),
        )
        .where(
          and(
            eq(generatedCards.agentId, agentId),
            eq(generatedCards.id, cardId),
            eq(generatedCards.status, 'active'),
            isNull(generatedCards.dismissedAt),
          ),
        )
        .limit(1);
      return row
        ? {
            card: row.generated_cards as Records['generatedCards'],
            revision: row.generated_card_revisions as Records['generatedCardRevisions'],
          }
        : null;
    },

    async list(agentId, now = new Date(), ids): Promise<GeneratedCardRecord[]> {
      if (!agentId || !Number.isFinite(now.getTime())) throw new Error('Invalid card listing');
      const rows = await db
        .select()
        .from(generatedCards)
        .innerJoin(
          generatedCardRevisions,
          and(
            eq(generatedCardRevisions.id, generatedCards.currentRevisionId),
            eq(generatedCardRevisions.cardId, generatedCards.id),
          ),
        )
        .where(
          and(
            eq(generatedCards.agentId, agentId),
            ids ? inArray(generatedCards.id, ids) : undefined,
            eq(generatedCards.status, 'active'),
            isNull(generatedCards.dismissedAt),
            ids
              ? undefined
              : or(isNull(generatedCards.expiresAt), gte(generatedCards.expiresAt, now)),
          ),
        )
        .orderBy(desc(generatedCards.updatedAt));
      return rows.map((row) => ({
        card: row.generated_cards as Records['generatedCards'],
        revision: row.generated_card_revisions as Records['generatedCardRevisions'],
      }));
    },

    async listRefreshes(agentId, cardIds) {
      if (!agentId || cardIds.length === 0) return [];
      return db
        .select({
          id: tasks.id,
          cardId: sql<string>`${tasks.trigger}->'payload'->>'refreshCardId'`,
          status: tasks.status,
          createdAt: tasks.createdAt,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            inArray(sql<string>`${tasks.trigger}->'payload'->>'refreshCardId'`, cardIds),
          ),
        )
        .orderBy(desc(tasks.createdAt), desc(tasks.id));
    },

    async dismiss(agentId, cardId, now = new Date()): Promise<boolean> {
      if (!agentId || !cardId || !Number.isFinite(now.getTime())) return false;
      const [updated] = await db
        .update(generatedCards)
        .set({ status: 'dismissed', dismissedAt: now, updatedAt: now })
        .where(and(eq(generatedCards.id, cardId), eq(generatedCards.agentId, agentId)))
        .returning({ id: generatedCards.id });
      return Boolean(updated);
    },
  };
}
