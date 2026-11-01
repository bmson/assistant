import { createHash } from 'node:crypto';
import {
  type EmbeddingSpace,
  type OwnerEditorClaim,
  type OwnerEditorReply,
  type OwnerMemoryCorrectionEligibilityInput,
  type OwnerMemoryEditorSnapshot,
  ownerEditorCommitRevision,
  ownerEditorSnapshotRevision,
  ownerMemoryCorrectionEligibility,
  parseOwnerCorrection,
  type Records,
  validSingleOwnerMemoryImportUnit,
} from '@assistant/persistence';
import type { DocumentSnapshot, Query, Transaction } from '@google-cloud/firestore';
import { decodeMemoryRecord } from './memory-record.js';
import {
  beginFirestoreOwnerEditorWrite,
  completeFirestoreOwnerEditorWrite,
  ownerEditorFirestorePrivacyToken,
} from './owner-editor-repository.js';
import { FirestoreProfileMemoryManagementRepository } from './profile-memory-management.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

export interface PreparedFirestoreOwnerMemoryCorrection {
  memoryId: string;
  expectedContentHash: string;
  expectedMemoryRevision: string;
  content: string;
  contentHash: string;
  embedding?: number[];
  embeddingSpaceKey?: string;
}
function native(doc: DocumentSnapshot) {
  if (!doc.exists) return null;
  if (!doc.updateTime) throw new Error('Memory source native revision unavailable');
  return { id: doc.id, seconds: doc.updateTime.seconds, nanoseconds: doc.updateTime.nanoseconds };
}
function row<T extends { id: string }>(doc: DocumentSnapshot): T | null {
  if (!doc.exists) return null;
  const value = decodeRecord<T>(doc.data());
  if (!value || typeof value.id !== 'string' || documentKey(value.id) !== doc.id)
    throw new Error('Memory source physical identity mismatch');
  return value;
}
async function readScope(
  store: InstallationStore,
  tx: Transaction,
  ownerId: string,
  memoryId: string,
) {
  const owners = await tx.get(store.collection('agents').limit(2));
  if (
    owners.size !== 1 ||
    owners.docs[0]?.get('id') !== ownerId ||
    owners.docs[0]?.id !== documentKey(ownerId)
  )
    throw new Error('Memory editor owner unavailable');
  ownerEditorFirestorePrivacyToken(await tx.get(store.doc('privacyErasureJobs', ownerId)), ownerId);
  const target = await tx.get(store.doc('memories', memoryId));
  if (!target.exists) return null;
  const memory = decodeMemoryRecord(target.data());
  if (memory.id !== memoryId || documentKey(memory.id) !== target.id || memory.agentId !== ownerId)
    return null;
  if (typeof memory.content !== 'string') throw new Error('Memory content malformed');
  const query = async (q: Query, cap: number) => {
    const page = await tx.get(q.limit(cap));
    if (page.docs.length !== page.size || page.size > cap)
      throw new Error('Memory proof page malformed');
    return page.docs;
  };
  const [lineageDocs, tombstone, subject] = await Promise.all([
    query(store.collection('memoryImportLineage').where('memoryId', '==', memoryId), 2),
    tx.get(store.doc('memoryTombstones', memory.contentHash)),
    memory.subjectContactId
      ? tx.get(store.doc('contacts', memory.subjectContactId))
      : Promise.resolve(null),
  ]);
  const lineage = lineageDocs.map((doc) => {
    // Actual importer records use the composite physical key and do not carry
    // an id field. Historical fixtures/imports may carry the same explicit id.
    const value = decodeRecord<
      Records['memoryImportLineage'] & { id?: unknown; agentId?: unknown }
    >(doc.data());
    if (!value || value.memoryId !== memoryId || typeof value.source !== 'string' || !value.source)
      throw new Error('Memory lineage binding unavailable');
    const id = createHash('sha256')
      .update(JSON.stringify([value.source, value.memoryId]))
      .digest('hex');
    if (
      doc.id !== documentKey(id) ||
      (value.id !== undefined && value.id !== id) ||
      (value.agentId !== undefined && value.agentId !== ownerId)
    )
      throw new Error('Memory lineage binding unavailable');
    return value;
  });
  const subjectRow = subject ? row<Records['contacts'] & { agentId?: string }>(subject) : null;
  const exact: unknown[] = [
    native(target),
    lineageDocs.map(native),
    native(tombstone),
    subject ? native(subject) : null,
  ];
  const proof: OwnerMemoryCorrectionEligibilityInput['proof'] = {
    complete: lineage.length < 2,
    shared: lineage.length > 1,
    conflictingLineage: false,
    subjectValid:
      memory.subjectContactId === null ||
      (!!subjectRow &&
        subjectRow.id === memory.subjectContactId &&
        (subjectRow.agentId === undefined || subjectRow.agentId === ownerId)),
    tombstoned: tombstone.exists,
    provenance: { kind: 'unknown' },
  };
  if (memory.source === 'manual' || memory.source === 'knowledge-graph-owner') {
    proof.conflictingLineage = lineage.length > 0;
    proof.provenance = { kind: memory.source === 'manual' ? 'manual' : 'graph_owner' };
  } else if (memory.source === 'extraction' && memory.sourceTaskId) {
    proof.conflictingLineage = lineage.length > 0;
    const taskDoc = await tx.get(store.doc('tasks', memory.sourceTaskId)),
      task = row<Records['tasks']>(taskDoc);
    exact.push(native(taskDoc));
    if (task?.agentId === ownerId) {
      const trigger = task.trigger as Record<string, unknown> | null;
      if ((trigger?.source === 'chat' || trigger?.source === 'sms') && task.conversationId) {
        const [conversationDoc, messageDocs] = await Promise.all([
          tx.get(store.doc('conversations', task.conversationId)),
          query(store.collection('messages').where('taskId', '==', task.id), 3),
        ]);
        const conversation = row<Records['conversations']>(conversationDoc),
          messageRows = messageDocs.map((doc) => row<Records['messages']>(doc));
        exact.push(native(conversationDoc), messageDocs.map(native));
        proof.complete = proof.complete && messageDocs.length < 3;
        const users = messageRows.filter((message) => message?.role === 'user'),
          payload = trigger.payload as Record<string, unknown> | null;
        const match =
          users.length === 1 &&
          users[0]?.conversationId === task.conversationId &&
          typeof payload?.text === 'string' &&
          users[0]?.text === payload.text &&
          trigger.agentId === ownerId;
        proof.provenance = {
          kind: 'extracted',
          taskId: task.id,
          taskOwnerId: task.agentId,
          sourceRelationship: 'conversation_message',
          sourceOwnerId: conversation?.agentId ?? '',
          exactSourceMatch: match,
        };
      } else if (trigger?.source === 'email') {
        const docs = await query(
            store.collection('emailIngest').where('triageTaskId', '==', task.id),
            2,
          ),
          sources = docs.map((doc) => row<Records['emailIngest']>(doc));
        exact.push(docs.map(native));
        proof.complete = proof.complete && docs.length < 2;
        const source = sources[0];
        proof.provenance = {
          kind: 'extracted',
          taskId: task.id,
          taskOwnerId: task.agentId,
          sourceRelationship: 'email_source',
          sourceOwnerId: source?.agentId ?? '',
          exactSourceMatch:
            sources.length === 1 &&
            !!task.externalEventId &&
            source?.channelMessageId === task.externalEventId &&
            trigger.agentId === ownerId,
        };
      }
    }
  } else if (lineage.length === 1) {
    const item = lineage[0];
    if (item) {
      const docs = await query(
          store.collection('importSources').where('source', '==', item.source),
          2,
        ),
        sources = docs.map((doc) => row<Records['importSources']>(doc));
      exact.push(docs.map(native));
      proof.complete = proof.complete && docs.length < 2;
      const source = sources[0],
        units = item.sourceUnitProvenance;
      proof.shared = Array.isArray(units) && units.length > 1;
      proof.provenance = {
        kind: 'import',
        canonicalOwnerId: source?.agentId ?? '',
        canonicalSource: source?.source ?? '',
        lineageCount: lineage.length,
        unitCount: Array.isArray(units) ? units.length : 0,
        strictUnit:
          sources.length === 1 &&
          source?.status === 'done' &&
          Array.isArray(units) &&
          units.length === 1 &&
          validSingleOwnerMemoryImportUnit(units[0]),
      };
    }
  }
  let eligibility = ownerMemoryCorrectionEligibility({ ownerId, memory, now: store.now(), proof });
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
    /* Readable, without an edit grant or attribution assertion. */
  }
  const snapshot: OwnerMemoryEditorSnapshot = {
    memoryId,
    ownerId,
    content: memory.content,
    contentHash: memory.contentHash,
    revision: ownerEditorSnapshotRevision({ driver: 'firestore', ownerId, native: exact }),
    ownerCorrection: marker,
    ...eligibility,
  };
  return { snapshot, memory };
}
export async function readFirestoreOwnerMemoryEditorSnapshot(
  store: InstallationStore,
  ownerId: string,
  memoryId: string,
  transaction?: Transaction,
): Promise<OwnerMemoryEditorSnapshot | null> {
  return transaction
    ? ((await readScope(store, transaction, ownerId, memoryId))?.snapshot ?? null)
    : store.db.runTransaction(
        async (tx) => (await readScope(store, tx, ownerId, memoryId))?.snapshot ?? null,
      );
}
export function commitFirestoreOwnerMemoryCorrection(
  store: InstallationStore,
  embeddingSpace: EmbeddingSpace,
  claim: OwnerEditorClaim,
  prepared: PreparedFirestoreOwnerMemoryCorrection,
  now: Date,
): Promise<OwnerEditorReply> {
  const repository = new FirestoreProfileMemoryManagementRepository(store, embeddingSpace);
  return store.db.runTransaction(async (tx) => {
    const admitted = await beginFirestoreOwnerEditorWrite(store, tx, claim, now);
    if (admitted.kind === 'reply') return admitted.reply;
    const finish = (result: Parameters<typeof completeFirestoreOwnerEditorWrite>[3]) =>
      completeFirestoreOwnerEditorWrite(store, tx, admitted, result, now);
    if (
      claim.scope.command !== 'correct_owner_memory' ||
      claim.scope.targetId !== prepared.memoryId
    )
      throw new Error('Memory claim target mismatch');
    const current = await readScope(store, tx, claim.scope.ownerId, prepared.memoryId);
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
      return finish({ outcome: 'unchanged', ids, revision: ownerEditorCommitRevision(claim, ids) });
    // The primitive completes its source/hash/tombstone reads before any write.
    // It also invalidates the card; completion below performs no further reads.
    if (!prepared.embedding || !prepared.embeddingSpaceKey)
      throw new Error('Prepared correction embedding unavailable');
    const result = await repository.correctInTransaction(tx, claim.scope.ownerId, {
      ...prepared,
      embedding: prepared.embedding,
      embeddingSpaceKey: prepared.embeddingSpaceKey,
    });
    if (result.status !== 'updated')
      return finish({ outcome: 'conflict', reason: `memory_${result.status}` });
    return finish({
      outcome: 'saved',
      ids,
      revision: ownerEditorCommitRevision(claim, ids),
      refreshPending: true,
    });
  });
}
