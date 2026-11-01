import { createHash } from 'node:crypto';
import {
  type OwnerEditorClaim,
  type OwnerEditorReply,
  type OwnerMemoryCorrectionEligibilityInput,
  type OwnerMemoryEditorSnapshot,
  ownerEditorCommitRevision,
  ownerEditorSnapshotRevision,
  ownerMemoryCorrectionEligibility,
  parseOwnerCorrection,
  validSingleOwnerMemoryImportUnit,
} from '@assistant/persistence';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { assertPostgresInstallationOwner } from './installation-owner.js';
import {
  beginPostgresOwnerEditorWrite,
  completePostgresOwnerEditorWrite,
} from './owner-editor-repository.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import {
  correctPostgresProfileMemoryInTransaction,
  invalidatePostgresProfileOwnerCard,
} from './profile-memory-management-repository.js';
import {
  contacts,
  conversations,
  emailIngest,
  importSources,
  memories,
  memoryImportLineage,
  memoryTombstones,
  messages,
  tasks,
} from './schema.js';

type Read = Pick<Db, 'select'>;
export interface PreparedPostgresOwnerMemoryCorrection {
  memoryId: string;
  expectedContentHash: string;
  expectedMemoryRevision: string;
  content: string;
  contentHash: string;
  embedding?: number[];
  embeddingSpaceKey?: string;
}
/** Caller passes its actual leased transaction. Fixed point reads + raw2/3 sentinels, never a directory scan. */
async function readScope(tx: Read, ownerId: string, memoryId: string, lock = false) {
  await lockPostgresPrivacyObservationFence(tx, ownerId);
  await assertPostgresInstallationOwner(tx as Db, ownerId);
  const query = tx
    .select({
      memory: memories,
      native: sql<Record<string, unknown>>`to_jsonb(${memories}) - 'embedding'`,
    })
    .from(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.agentId, ownerId)));
  const [target] = await (lock ? query.for('update') : query).limit(1);
  if (!target) return null;
  const memory = target.memory;
  const [lineage, tombstone, subject] = await Promise.all([
    tx
      .select({
        lineage: memoryImportLineage,
        source: importSources,
        native: sql<
          Record<string, unknown>
        >`jsonb_build_array(to_jsonb(${memoryImportLineage}),to_jsonb(${importSources}))`,
      })
      .from(memoryImportLineage)
      .leftJoin(importSources, eq(importSources.source, memoryImportLineage.source))
      .where(eq(memoryImportLineage.memoryId, memoryId))
      .limit(2),
    tx
      .select({ hash: memoryTombstones.contentHash })
      .from(memoryTombstones)
      .where(eq(memoryTombstones.contentHash, memory.contentHash))
      .limit(1),
    memory.subjectContactId
      ? tx
          .select({ id: contacts.id, native: sql<Record<string, unknown>>`to_jsonb(${contacts})` })
          .from(contacts)
          .where(eq(contacts.id, memory.subjectContactId))
          .limit(1)
      : Promise.resolve([]),
  ]);
  const native: unknown[] = [
    target.native,
    lineage.map((row) => row.native),
    tombstone,
    subject.map((row) => row.native),
  ];
  const proof: OwnerMemoryCorrectionEligibilityInput['proof'] = {
    complete: lineage.length < 2,
    shared: lineage.length > 1,
    conflictingLineage: false,
    subjectValid: memory.subjectContactId === null || subject[0]?.id === memory.subjectContactId,
    tombstoned: tombstone.length > 0,
    provenance: { kind: 'unknown' },
  };
  if (memory.source === 'manual' || memory.source === 'knowledge-graph-owner') {
    proof.conflictingLineage = lineage.length > 0;
    proof.provenance = { kind: memory.source === 'manual' ? 'manual' : 'graph_owner' };
  } else if (memory.source === 'extraction' && memory.sourceTaskId) {
    proof.conflictingLineage = lineage.length > 0;
    const [task] = await tx
      .select({ row: tasks, native: sql<Record<string, unknown>>`to_jsonb(${tasks})` })
      .from(tasks)
      .where(eq(tasks.id, memory.sourceTaskId))
      .limit(1);
    native.push(task?.native ?? null);
    if (task?.row.agentId === ownerId) {
      const trigger = task.row.trigger as Record<string, unknown> | null;
      if ((trigger?.source === 'chat' || trigger?.source === 'sms') && task.row.conversationId) {
        const [conversation] = await tx
          .select({
            row: conversations,
            native: sql<Record<string, unknown>>`to_jsonb(${conversations})`,
          })
          .from(conversations)
          .where(eq(conversations.id, task.row.conversationId))
          .limit(1);
        const rows = await tx
          .select({
            row: messages,
            native: sql<Record<string, unknown>>`to_jsonb(${messages}) - 'embedding'`,
          })
          .from(messages)
          .where(eq(messages.taskId, task.row.id))
          .orderBy(asc(messages.id))
          .limit(3);
        native.push(
          conversation?.native ?? null,
          rows.map((row) => row.native),
        );
        proof.complete = proof.complete && rows.length < 3;
        const users = rows.filter((row) => row.row.role === 'user');
        const payload = trigger.payload as Record<string, unknown> | null;
        const exact =
          users.length === 1 &&
          users[0]?.row.conversationId === task.row.conversationId &&
          typeof payload?.text === 'string' &&
          users[0].row.text === payload.text &&
          trigger.agentId === ownerId;
        proof.provenance = {
          kind: 'extracted',
          taskId: task.row.id,
          taskOwnerId: task.row.agentId,
          sourceRelationship: 'conversation_message',
          sourceOwnerId: conversation?.row.agentId ?? '',
          exactSourceMatch: exact,
        };
      } else if (trigger?.source === 'email') {
        const rows = await tx
          .select({
            row: emailIngest,
            native: sql<Record<string, unknown>>`to_jsonb(${emailIngest})`,
          })
          .from(emailIngest)
          .where(eq(emailIngest.triageTaskId, task.row.id))
          .limit(2);
        native.push(rows.map((row) => row.native));
        proof.complete = proof.complete && rows.length < 2;
        const source = rows[0]?.row;
        proof.provenance = {
          kind: 'extracted',
          taskId: task.row.id,
          taskOwnerId: task.row.agentId,
          sourceRelationship: 'email_source',
          sourceOwnerId: source?.agentId ?? '',
          exactSourceMatch:
            rows.length === 1 &&
            !!task.row.externalEventId &&
            source?.channelMessageId === task.row.externalEventId &&
            trigger.agentId === ownerId,
        };
      }
    }
  } else if (lineage.length === 1) {
    const item = lineage[0],
      units = item?.lineage.sourceUnitProvenance;
    proof.shared = Array.isArray(units) && units.length > 1;
    proof.provenance = {
      kind: 'import',
      canonicalOwnerId: item?.source?.agentId ?? '',
      canonicalSource: item?.source?.source ?? '',
      lineageCount: lineage.length,
      unitCount: Array.isArray(units) ? units.length : 0,
      strictUnit:
        item?.source?.status === 'done' &&
        Array.isArray(units) &&
        units.length === 1 &&
        validSingleOwnerMemoryImportUnit(units[0]),
    };
  }
  let eligibility = ownerMemoryCorrectionEligibility({ ownerId, memory, now: new Date(), proof });
  const contentMatches =
    createHash('sha256').update(memory.content).digest('hex') === memory.contentHash;
  if (!contentMatches)
    eligibility = {
      eligible: false,
      readOnlyReason: 'memory_content_hash_mismatch',
      sourceLabel: eligibility.sourceLabel,
    };
  let marker = null;
  try {
    marker = contentMatches
      ? parseOwnerCorrection(memory.ownerCorrection, memory.contentHash)
      : null;
  } catch {
    /* malformed attribution is readable, never an edit grant */
  }
  const snapshot: OwnerMemoryEditorSnapshot = {
    memoryId: memory.id,
    ownerId,
    content: memory.content,
    contentHash: memory.contentHash,
    revision: ownerEditorSnapshotRevision({ driver: 'postgres', ownerId, native }),
    ownerCorrection: marker,
    ...eligibility,
  };
  return { snapshot, memory };
}
export async function readPostgresOwnerMemoryEditorSnapshot(
  tx: Read,
  ownerId: string,
  memoryId: string,
): Promise<OwnerMemoryEditorSnapshot | null> {
  return (await readScope(tx, ownerId, memoryId))?.snapshot ?? null;
}

export function commitPostgresOwnerMemoryCorrection(
  db: Db,
  claim: OwnerEditorClaim,
  prepared: PreparedPostgresOwnerMemoryCorrection,
  now: Date,
): Promise<OwnerEditorReply> {
  return db.transaction(
    async (tx) => {
      const admitted = await beginPostgresOwnerEditorWrite(tx, claim, now);
      if (admitted.kind === 'reply') return admitted.reply;
      const finish = (result: Parameters<typeof completePostgresOwnerEditorWrite>[2]) =>
        completePostgresOwnerEditorWrite(tx, admitted, result, now);
      if (
        claim.scope.command !== 'correct_owner_memory' ||
        claim.scope.targetId !== prepared.memoryId
      )
        throw new Error('Memory claim target mismatch');
      const current = await readScope(tx, claim.scope.ownerId, prepared.memoryId, true);
      if (current?.snapshot.readOnlyReason === 'incomplete_provenance')
        return finish({ outcome: 'unavailable', reason: 'memory_provenance_limit' });
      if (
        !current ||
        !current.snapshot.eligible ||
        current.snapshot.revision !== prepared.expectedMemoryRevision ||
        current.snapshot.contentHash !== prepared.expectedContentHash
      )
        return finish({ outcome: 'conflict', reason: 'memory_snapshot_changed' });
      const ids = { memoryId: prepared.memoryId };
      if (prepared.content === current.memory.content)
        return finish({
          outcome: 'unchanged',
          ids,
          revision: ownerEditorCommitRevision(claim, ids),
        });
      // No owner->card advisory lock: compiler takes advisory->owner. The shared
      // owner/privacy lease already serializes its final read/write against this.
      if (!prepared.embedding || !prepared.embeddingSpaceKey)
        throw new Error('Prepared correction embedding unavailable');
      const changed = await correctPostgresProfileMemoryInTransaction(
        tx as unknown as Db,
        claim.scope.ownerId,
        {
          ...prepared,
          embedding: prepared.embedding,
          embeddingSpaceKey: prepared.embeddingSpaceKey,
        },
      );
      if (changed.status !== 'updated')
        return finish({ outcome: 'conflict', reason: `memory_${changed.status}` });
      await invalidatePostgresProfileOwnerCard(tx);
      return finish({
        outcome: 'saved',
        ids,
        revision: ownerEditorCommitRevision(claim, ids),
        refreshPending: true,
      });
    },
    { isolationLevel: 'serializable' },
  );
}
