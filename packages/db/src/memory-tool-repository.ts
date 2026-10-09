import {
  type EmbeddingSpace,
  embeddingSpaceIdentityKey,
  type MemoryRecallResult,
  type MemorySaveInput,
  type MemorySaveResult,
  type MemoryToolRepository,
  snapshotEmbeddingSpace,
  validateEmbedding,
  validateSkillEmbedding,
} from '@assistant/persistence';
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { resolveSubjectContact } from './entities.js';
import {
  assertPostgresPrivacyObservationFence,
  lockPostgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import { memories, memoryTombstones } from './schema.js';

const LEXICAL_MATCH_BONUS = 0.06;

function validateVector(space: EmbeddingSpace | undefined, vector: number[]): void {
  if (space) validateEmbedding(space, vector);
  else validateSkillEmbedding(vector);
}

function validateSave(input: MemorySaveInput, space: EmbeddingSpace | undefined): void {
  if (!input.agentId || !input.content || !input.contentHash || !input.originTrust)
    throw new Error('Invalid memory save');
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
    throw new Error('Invalid memory confidence');
  if (!Number.isInteger(input.importance) || input.importance < 1 || input.importance > 5)
    throw new Error('Invalid memory importance');
  if (
    input.embeddingSpaceKey !== undefined &&
    input.embeddingSpaceKey !== null &&
    !/^[a-f0-9]{64}$/.test(input.embeddingSpaceKey)
  )
    throw new Error('Invalid memory embedding space identity');
  if (
    space &&
    input.embeddingSpaceKey &&
    input.embeddingSpaceKey !== embeddingSpaceIdentityKey(space)
  )
    throw new Error('Memory embedding space identity does not match the configured space');
  validateVector(space, input.embedding);
  if (input.expiresAt && !Number.isFinite(input.expiresAt.getTime()))
    throw new Error('Invalid memory expiry');
}

function lexicalTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .slice(0, 5);
}

export function createPostgresMemoryToolRepository(
  db: Db,
  embeddingSpace?: EmbeddingSpace,
): MemoryToolRepository {
  const capturedEmbeddingSpace = embeddingSpace
    ? snapshotEmbeddingSpace(embeddingSpace)
    : undefined;
  return {
    kind: 'memory-tool-repository',
    embeddingSpace: capturedEmbeddingSpace,
    observationGeneration: (agentId) =>
      db.transaction((tx) => lockPostgresPrivacyObservationFence(tx as unknown as Db, agentId)),

    async screenContentHash(agentId, contentHash) {
      if (!agentId || !/^[a-f0-9]{64}$/.test(contentHash))
        throw new Error('Invalid memory content hash preflight');
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const observed = await lockPostgresPrivacyObservationFence(txDb, agentId);
        const [tombstone] = await tx
          .select({ id: memoryTombstones.id })
          .from(memoryTombstones)
          .where(eq(memoryTombstones.contentHash, contentHash))
          .limit(1);
        let state: 'new' | 'duplicate' | 'tombstoned' = tombstone ? 'tombstoned' : 'new';
        if (!tombstone) {
          const [existing] = await tx
            .select({ agentId: memories.agentId })
            .from(memories)
            .where(eq(memories.contentHash, contentHash))
            .limit(1);
          if (existing?.agentId === agentId) state = 'duplicate';
          else if (existing) throw new Error('Memory duplicate preflight is unavailable');
        }
        await assertPostgresPrivacyObservationFence(txDb, agentId, observed);
        return state;
      });
    },

    async save(input): Promise<MemorySaveResult> {
      validateSave(input, capturedEmbeddingSpace);
      if (!input.embeddingSpaceKey)
        throw new Error('Memory writes require an exact embedding space identity');
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const observed = await lockPostgresPrivacyObservationFence(txDb, input.agentId);
        if (input.observedPrivacyGeneration !== undefined)
          await assertPostgresPrivacyObservationFence(
            txDb,
            input.agentId,
            input.observedPrivacyGeneration,
          );
        const [tombstone] = await tx
          .select({ id: memoryTombstones.id })
          .from(memoryTombstones)
          .where(eq(memoryTombstones.contentHash, input.contentHash))
          .limit(1);
        if (tombstone)
          return {
            saved: false,
            duplicate: false,
            tombstoned: true,
            quarantined: input.quarantined,
          };
        const subject = input.subject
          ? await resolveSubjectContact(txDb, {
              subject: input.subject,
              relationship: input.subjectRelationship,
            })
          : null;
        const [row] = await tx
          .insert(memories)
          .values({
            agentId: input.agentId,
            category: input.category,
            kind: input.kind,
            content: input.content,
            contentHash: input.contentHash,
            embedding: input.embedding,
            embeddingSpaceKey:
              input.embeddingSpaceKey ??
              (capturedEmbeddingSpace ? embeddingSpaceIdentityKey(capturedEmbeddingSpace) : null),
            importance: input.importance,
            confidence: input.confidence.toFixed(2),
            originTrust: input.originTrust,
            quarantined: input.quarantined,
            subjectContactId: subject?.contactId,
            domain: input.domain,
            sourceTaskId: input.sourceTaskId,
            expiresAt: input.expiresAt,
          })
          .onConflictDoNothing({ target: memories.contentHash })
          .returning({ id: memories.id });
        await assertPostgresPrivacyObservationFence(txDb, input.agentId, observed);
        return {
          ...(row ? { id: row.id } : {}),
          saved: Boolean(row),
          duplicate: !row,
          tombstoned: false,
          quarantined: input.quarantined,
        };
      });
    },

    async recall(input): Promise<MemoryRecallResult> {
      if (
        !input.agentId ||
        !input.query ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 20
      )
        throw new Error('Invalid memory recall');
      validateVector(capturedEmbeddingSpace, input.embedding);
      const configuredSpaceKey = capturedEmbeddingSpace
        ? embeddingSpaceIdentityKey(capturedEmbeddingSpace)
        : undefined;
      if (
        input.embeddingSpaceKey &&
        configuredSpaceKey &&
        input.embeddingSpaceKey !== configuredSpaceKey
      )
        throw new Error('Memory recall identity does not match the configured embedding space');
      const exactSpaceKey = input.embeddingSpaceKey ?? configuredSpaceKey;
      const now = input.now ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error('Invalid memory recall time');
      const vector = JSON.stringify(input.embedding);
      const distance = sql<number>`(${memories.embedding} <=> ${vector}::vector)`;
      const terms = lexicalTerms(input.query);
      const lexicalMatch =
        terms.length > 0
          ? sql<boolean>`${memories.content} ~* ${`\\y(${terms.join('|')})\\y`}`
          : undefined;
      const candidateLimit = Math.min(100, input.limit * 4);
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: memories.id,
            content: memories.content,
            category: memories.category,
            kind: memories.kind,
            importance: memories.importance,
            confidence: memories.confidence,
            validFrom: memories.validFrom,
            validUntil: memories.validUntil,
            source: memories.source,
            embeddingSpaceKey: memories.embeddingSpaceKey,
            ownerConfirmed: memories.ownerConfirmed,
            createdAt: memories.createdAt,
            expiresAt: memories.expiresAt,
            agentId: memories.agentId,
            sourceTaskId: memories.sourceTaskId,
            contentHash: memories.contentHash,
            goalId: memories.goalId,
            originTrust: memories.originTrust,
            quarantined: memories.quarantined,
            subjectContactId: memories.subjectContactId,
            domain: memories.domain,
            supersededById: memories.supersededById,
            pinned: memories.pinned,
            lastAccessedAt: memories.lastAccessedAt,
            lastConsolidatedAt: memories.lastConsolidatedAt,
            similarity: sql<number>`1 - ${distance}`,
          })
          .from(memories)
          .where(
            and(
              eq(memories.agentId, input.agentId),
              exactSpaceKey ? eq(memories.embeddingSpaceKey, exactSpaceKey) : undefined,
              eq(memories.quarantined, false),
              isNull(memories.supersededById),
              isNotNull(memories.embedding),
              or(isNull(memories.expiresAt), gt(memories.expiresAt, now)),
            ),
          )
          .orderBy(
            lexicalMatch
              ? sql`${distance} - CASE WHEN ${lexicalMatch} THEN ${sql.raw(String(LEXICAL_MATCH_BONUS))} ELSE 0 END`
              : distance,
          )
          .limit(candidateLimit);
        const selected = rows.slice(0, input.limit);
        if (selected.length) {
          await tx
            .update(memories)
            .set({ lastAccessedAt: now })
            .where(
              inArray(
                memories.id,
                selected.map((row) => row.id),
              ),
            );
        }
        return {
          memories: selected,
          candidateLimitReached: rows.length === candidateLimit,
        };
      });
    },
  };
}
