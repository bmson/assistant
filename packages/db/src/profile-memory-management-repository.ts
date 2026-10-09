import { randomUUID } from 'node:crypto';
import type { MemoryMutation, ProfileMemoryManagementRepository } from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { OWNER_CARD_ADVISORY_LOCK } from './owner-card-compilation-repository.js';
import { agents, contacts, memories, memoryTombstones, ownerCard } from './schema.js';

export function createPostgresProfileMemoryManagementRepository(
  db: Db,
  configuredAgentId?: string,
): ProfileMemoryManagementRepository {
  const mutate = (run: (tx: Db, agentId: string) => Promise<MemoryMutation>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select ${OWNER_CARD_ADVISORY_LOCK}`);
      const configured = configuredAgentId
        ? await tx
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.id, configuredAgentId))
            .limit(1)
        : await tx.select({ id: agents.id }).from(agents).limit(2);
      if (configuredAgentId ? !configured[0] : configured.length !== 1 || !configured[0])
        throw new Error('Memory management requires exactly one configured agent');
      const ownerId = configuredAgentId ?? configured[0]?.id;
      if (!ownerId) throw new Error('Memory management requires exactly one configured agent');
      const result = await run(tx as unknown as Db, ownerId);
      if (result.status === 'updated')
        await tx
          .insert(ownerCard)
          .values({ id: 1, content: '', compiledAt: sql`now()` })
          .onConflictDoUpdate({
            target: ownerCard.id,
            set: { content: '', compiledAt: sql`now()` },
          });
      return result;
    });
  const owned = async (tx: Db, agentId: string, id: string) =>
    (
      await tx
        .select()
        .from(memories)
        .where(and(eq(memories.id, id), eq(memories.agentId, agentId)))
        .limit(1)
    )[0];
  // Legacy profile writers do not share the owner-card advisory lock. Lock the
  // source row before reading its hash so a stale CAS cannot commit a tombstone.
  const ownedForMutation = async (tx: Db, agentId: string, id: string) =>
    (
      await tx
        .select()
        .from(memories)
        .where(and(eq(memories.id, id), eq(memories.agentId, agentId)))
        .for('update')
        .limit(1)
    )[0];
  const tombstoned = async (tx: Db, contentHash: string) =>
    Boolean(
      (
        await tx
          .select({ id: memoryTombstones.id })
          .from(memoryTombstones)
          .where(eq(memoryTombstones.contentHash, contentHash))
          .limit(1)
      )[0],
    );
  const changed = (
    row: { id: string; agentId: string; contentHash: string } | undefined,
  ): MemoryMutation => (row ? { status: 'updated', memory: row } : { status: 'not-found' });
  const existingMutation =
    (run: (tx: Db, agentId: string, id: string) => Promise<MemoryMutation>) => (id: string) =>
      mutate(async (tx, agentId) => {
        const current = await ownedForMutation(tx, agentId, id);
        if (!current) return { status: 'not-found' };
        if (await tombstoned(tx, current.contentHash)) return { status: 'tombstoned' };
        return run(tx, agentId, id);
      });
  return {
    kind: 'profile-memory-management-repository',
    async get(memoryId) {
      const configured = configuredAgentId
        ? await db
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.id, configuredAgentId))
            .limit(1)
        : await db.select({ id: agents.id }).from(agents).limit(2);
      if (configuredAgentId ? !configured[0] : configured.length !== 1 || !configured[0])
        return null;
      const ownerId = configuredAgentId ?? configured[0]?.id;
      if (!ownerId) return null;
      const row = await owned(db, ownerId, memoryId);
      if (row && (await tombstoned(db, row.contentHash))) return null;
      return row ? { id: row.id, agentId: row.agentId, contentHash: row.contentHash } : null;
    },
    confirm: existingMutation(async (tx, agentId, id) =>
      changed(
        (
          await tx
            .update(memories)
            .set({ confidence: '1.00', ownerConfirmed: true, quarantined: false })
            .where(and(eq(memories.id, id), eq(memories.agentId, agentId)))
            .returning({
              id: memories.id,
              agentId: memories.agentId,
              contentHash: memories.contentHash,
            })
        )[0],
      ),
    ),
    restore: existingMutation(async (tx, agentId, id) =>
      changed(
        (
          await tx
            .update(memories)
            .set({
              expiresAt: null,
              supersededById: null,
              confidence: '1.00',
              ownerConfirmed: true,
              quarantined: false,
            })
            .where(and(eq(memories.id, id), eq(memories.agentId, agentId)))
            .returning({
              id: memories.id,
              agentId: memories.agentId,
              contentHash: memories.contentHash,
            })
        )[0],
      ),
    ),
    correct: (input) =>
      mutate(async (tx, agentId) => {
        const current = await ownedForMutation(tx, agentId, input.memoryId);
        if (!current) return { status: 'not-found' };
        if (current.contentHash !== input.expectedContentHash) return { status: 'stale' };
        if (await tombstoned(tx, current.contentHash)) return { status: 'tombstoned' };
        if (input.contentHash !== current.contentHash) {
          if (await tombstoned(tx, input.contentHash)) return { status: 'tombstoned' };
          const duplicate = (
            await tx
              .select({ id: memories.id })
              .from(memories)
              .where(eq(memories.contentHash, input.contentHash))
              .limit(1)
          )[0];
          if (duplicate) return { status: 'duplicate' };
          await tx
            .insert(memoryTombstones)
            .values({ contentHash: current.contentHash, reason: 'owner_correct' })
            .onConflictDoNothing();
        }
        const row = (
          await tx
            .update(memories)
            .set({
              content: input.content,
              contentHash: input.contentHash,
              embedding: input.embedding,
              embeddingSpaceKey: input.embeddingSpaceKey ?? null,
              confidence: '1.00',
              ownerConfirmed: true,
              originTrust: 'owner',
              quarantined: false,
            })
            .where(
              and(
                eq(memories.id, input.memoryId),
                eq(memories.agentId, agentId),
                eq(memories.contentHash, input.expectedContentHash),
              ),
            )
            .returning({
              id: memories.id,
              agentId: memories.agentId,
              contentHash: memories.contentHash,
            })
        )[0];
        return row ? { status: 'updated', memory: row } : { status: 'stale' };
      }),
    forget: (id, reason) =>
      mutate(async (tx, agentId) => {
        const current = await ownedForMutation(tx, agentId, id);
        if (!current) return { status: 'not-found' };
        await tx
          .insert(memoryTombstones)
          .values({ contentHash: current.contentHash, reason })
          .onConflictDoNothing();
        const row = (
          await tx
            .delete(memories)
            .where(
              and(
                eq(memories.id, id),
                eq(memories.agentId, agentId),
                eq(memories.contentHash, current.contentHash),
              ),
            )
            .returning({
              id: memories.id,
              agentId: memories.agentId,
              contentHash: memories.contentHash,
            })
        )[0];
        return row ? { status: 'updated', memory: row } : { status: 'stale' };
      }),
    setProminence: (id, level) =>
      existingMutation(async (tx, agentId, ownedId) =>
        changed(
          (
            await tx
              .update(memories)
              .set(
                level === 'always'
                  ? { pinned: true }
                  : level === 'minor'
                    ? { pinned: false, importance: 1 }
                    : {
                        pinned: false,
                        importance: sql`CASE WHEN ${memories.importance} <= 1 THEN 3 ELSE ${memories.importance} END`,
                      },
              )
              .where(and(eq(memories.id, ownedId), eq(memories.agentId, agentId)))
              .returning({
                id: memories.id,
                agentId: memories.agentId,
                contentHash: memories.contentHash,
              })
          )[0],
        ),
      )(id),
    approveQuarantined: (id) =>
      existingMutation(async (tx, agentId, ownedId) =>
        changed(
          (
            await tx
              .update(memories)
              .set({ quarantined: false })
              .where(and(eq(memories.id, ownedId), eq(memories.agentId, agentId)))
              .returning({
                id: memories.id,
                agentId: memories.agentId,
                contentHash: memories.contentHash,
              })
          )[0],
        ),
      )(id),
    create: (input) =>
      mutate(async (tx, agentId) => {
        if (await tombstoned(tx, input.contentHash)) return { status: 'tombstoned' };
        if (
          !(
            await tx
              .select({ id: contacts.id })
              .from(contacts)
              .where(eq(contacts.id, input.subjectContactId))
              .limit(1)
          )[0]
        )
          return { status: 'not-found' };
        const row = (
          await tx
            .insert(memories)
            .values({
              id: randomUUID(),
              agentId,
              category: 'knowledge',
              kind: 'fact',
              content: input.content,
              contentHash: input.contentHash,
              embedding: input.embedding,
              embeddingSpaceKey: input.embeddingSpaceKey ?? null,
              importance: input.importance,
              confidence: '1.00',
              originTrust: 'owner',
              ownerConfirmed: true,
              pinned: input.pinned,
              subjectContactId: input.subjectContactId,
              domain: input.domain,
              source: 'manual',
            })
            .onConflictDoNothing({ target: memories.contentHash })
            .returning({
              id: memories.id,
              agentId: memories.agentId,
              contentHash: memories.contentHash,
            })
        )[0];
        if (row) return { status: 'updated', memory: row };
        const duplicate = (
          await tx
            .select({
              id: memories.id,
              agentId: memories.agentId,
              contentHash: memories.contentHash,
            })
            .from(memories)
            .where(and(eq(memories.contentHash, input.contentHash), eq(memories.agentId, agentId)))
            .limit(1)
        )[0];
        return duplicate ? { status: 'duplicate', memory: duplicate } : { status: 'duplicate' };
      }),
  };
}
