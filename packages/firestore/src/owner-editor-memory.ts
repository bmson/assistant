import { createHash } from 'node:crypto';
import {
  type EmbeddingSpace,
  type OwnerEditorClaim,
  type OwnerEditorMemoryRemovalImpact,
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
import type {
  DocumentReference,
  DocumentSnapshot,
  Query,
  Transaction,
} from '@google-cloud/firestore';
import { decodeMemoryRecord } from './memory-record.js';
import {
  beginFirestoreOwnerEditorWrite,
  completeFirestoreOwnerEditorWrite,
  ownerEditorFirestorePrivacyToken,
} from './owner-editor-repository.js';
import { FirestoreProfileMemoryManagementRepository } from './profile-memory-management.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

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

const MEMORY_REMOVAL_RELATION_LIMIT = 100;
const MEMORY_REMOVAL_EVIDENCE_LIMIT = 500;
const MEMORY_REMOVAL_ALIAS_LIMIT = 450;
const MEMORY_REMOVAL_GRAPH_DOCUMENT_LIMIT = 2_048;
const MEMORY_REMOVAL_GRAPH_REQUEST_LIMIT = 64;

interface MemoryRemovalReadBudget {
  documents: number;
  requests: number;
}

async function readMemoryRemovalDoc(
  tx: Transaction,
  ref: DocumentReference,
  budget: MemoryRemovalReadBudget,
) {
  if (
    budget.requests >= MEMORY_REMOVAL_GRAPH_REQUEST_LIMIT ||
    budget.documents >= MEMORY_REMOVAL_GRAPH_DOCUMENT_LIMIT
  )
    throw new Error('Memory removal graph scan budget exceeded');
  budget.requests += 1;
  // Count absent document reads too, so the budget is conservative.
  budget.documents += 1;
  return tx.get(ref);
}

async function readMemoryRemovalQuery(
  tx: Transaction,
  query: Query,
  requestedLimit: number,
  budget: MemoryRemovalReadBudget,
) {
  if (
    budget.requests >= MEMORY_REMOVAL_GRAPH_REQUEST_LIMIT ||
    budget.documents >= MEMORY_REMOVAL_GRAPH_DOCUMENT_LIMIT
  )
    throw new Error('Memory removal graph scan budget exceeded');
  const remainingDocuments = MEMORY_REMOVAL_GRAPH_DOCUMENT_LIMIT - budget.documents;
  const effectiveLimit = Math.min(requestedLimit, remainingDocuments);
  budget.requests += 1;
  const result = await tx.get(query.limit(effectiveLimit));
  budget.documents += result.size;
  if (result.size === effectiveLimit && effectiveLimit < requestedLimit)
    throw new Error('Memory removal graph scan budget exceeded');
  return result;
}

function nativeRevision(doc: DocumentSnapshot) {
  if (!doc.exists) return null;
  if (!doc.updateTime) throw new Error('Memory removal native revision unavailable');
  return { id: doc.id, seconds: doc.updateTime.seconds, nanoseconds: doc.updateTime.nanoseconds };
}

function memoryRemovalRelation(doc: DocumentSnapshot, ownerId: string) {
  const value = decodeRecord<Record<string, unknown>>(doc.data());
  if (
    typeof value.id !== 'string' ||
    documentKey(value.id) !== doc.id ||
    value.agentId !== ownerId ||
    typeof value.sourceMemoryId !== 'string' ||
    typeof value.subjectEntityId !== 'string' ||
    typeof value.objectEntityId !== 'string'
  )
    throw new Error('Memory removal graph relation is malformed');
  return {
    id: value.id,
    sourceMemoryId: value.sourceMemoryId,
    subjectEntityId: value.subjectEntityId,
    objectEntityId: value.objectEntityId,
    revision: nativeRevision(doc),
  };
}

/** Exact bounded source graph membership for the impact review and commit CAS. */
async function readMemoryRemovalImpact(
  store: InstallationStore,
  tx: Transaction,
  ownerId: string,
  memoryId: string,
  contentHash: string,
  memorySnapshotRevision: string,
): Promise<OwnerEditorMemoryRemovalImpact> {
  const budget: MemoryRemovalReadBudget = { documents: 0, requests: 0 };
  const intentRef = store.doc('graphDeletionIntents', memoryId);
  const sourceRef = store.doc('knowledgeGraphSources', memoryId);
  const tombstoneRef = store.doc('memoryTombstones', contentHash);
  const hashRef = store.doc('memoryContentHashes', contentHash);
  const relationQuery = store
    .collection('knowledgeGraphRelations')
    .where('sourceMemoryId', '==', memoryId)
    .limit(MEMORY_REMOVAL_RELATION_LIMIT + 1);
  const evidenceQuery = store
    .collection('knowledgeGraphAssertionEvidence')
    .where('sourceMemoryId', '==', memoryId)
    .limit(MEMORY_REMOVAL_EVIDENCE_LIMIT + 1);
  const intentDoc = await readMemoryRemovalDoc(tx, intentRef, budget);
  const sourceDoc = await readMemoryRemovalDoc(tx, sourceRef, budget);
  const tombstoneDoc = await readMemoryRemovalDoc(tx, tombstoneRef, budget);
  const hashDoc = await readMemoryRemovalDoc(tx, hashRef, budget);
  const relationPage = await readMemoryRemovalQuery(
    tx,
    relationQuery,
    MEMORY_REMOVAL_RELATION_LIMIT + 1,
    budget,
  );
  const evidencePage = await readMemoryRemovalQuery(
    tx,
    evidenceQuery,
    MEMORY_REMOVAL_EVIDENCE_LIMIT + 1,
    budget,
  );
  if (intentDoc.exists) throw new Error('Memory removal already has a graph deletion intent');
  if (tombstoneDoc.exists) throw new Error('Memory removal content is already tombstoned');
  if (
    hashDoc.exists &&
    (hashDoc.get('memoryId') !== memoryId ||
      (hashDoc.get('agentId') !== undefined && hashDoc.get('agentId') !== ownerId))
  )
    throw new Error('Memory removal content hash index is foreign or malformed');
  if (relationPage.size > MEMORY_REMOVAL_RELATION_LIMIT)
    throw new Error('Memory removal graph relation impact exceeds its bound');
  if (evidencePage.size > MEMORY_REMOVAL_EVIDENCE_LIMIT)
    throw new Error('Memory removal graph evidence impact exceeds its bound');
  if (
    sourceDoc.exists &&
    (sourceDoc.get('memoryId') !== memoryId || sourceDoc.get('agentId') !== ownerId)
  )
    throw new Error('Memory removal graph source is foreign or malformed');
  const relations = relationPage.docs.map((doc) => memoryRemovalRelation(doc, ownerId));
  const evidence = evidencePage.docs.map((doc) => {
    const value = decodeRecord<Record<string, unknown>>(doc.data());
    if (
      typeof value.id !== 'string' ||
      documentKey(value.id) !== doc.id ||
      value.agentId !== ownerId ||
      value.sourceMemoryId !== memoryId
    )
      throw new Error('Memory removal graph evidence is malformed');
    return { id: value.id, revision: nativeRevision(doc) };
  });
  const endpointIds = [
    ...new Set(relations.flatMap((row) => [row.subjectEntityId, row.objectEntityId])),
  ].sort();
  const endpointProofs = [];
  for (const entityId of endpointIds) {
    const entityRef = store.doc('knowledgeGraphEntities', entityId);
    const entityDoc = await readMemoryRemovalDoc(tx, entityRef, budget);
    const subjectPage = await readMemoryRemovalQuery(
      tx,
      store.collection('knowledgeGraphRelations').where('subjectEntityId', '==', entityId),
      MEMORY_REMOVAL_RELATION_LIMIT + 1,
      budget,
    );
    const objectPage = await readMemoryRemovalQuery(
      tx,
      store.collection('knowledgeGraphRelations').where('objectEntityId', '==', entityId),
      MEMORY_REMOVAL_RELATION_LIMIT + 1,
      budget,
    );
    const assertionsAsSubject = await readMemoryRemovalQuery(
      tx,
      store.collection('knowledgeGraphAssertions').where('subjectEntityId', '==', entityId),
      1,
      budget,
    );
    const assertionsAsObject = await readMemoryRemovalQuery(
      tx,
      store.collection('knowledgeGraphAssertions').where('objectEntityId', '==', entityId),
      1,
      budget,
    );
    const aliases = await readMemoryRemovalQuery(
      tx,
      store.collection('knowledgeGraphEntityAliases').where('entityId', '==', entityId),
      MEMORY_REMOVAL_ALIAS_LIMIT + 1,
      budget,
    );
    if (
      !entityDoc.exists ||
      entityDoc.get('id') !== entityId ||
      entityDoc.get('agentId') !== ownerId
    )
      throw new Error('Memory removal graph endpoint is unavailable');
    if (
      subjectPage.size > MEMORY_REMOVAL_RELATION_LIMIT ||
      objectPage.size > MEMORY_REMOVAL_RELATION_LIMIT ||
      aliases.size > MEMORY_REMOVAL_ALIAS_LIMIT
    )
      throw new Error('Memory removal graph endpoint impact exceeds its bound');
    for (const alias of aliases.docs) {
      if (alias.get('agentId') !== ownerId || alias.get('entityId') !== entityId)
        throw new Error('Memory removal graph alias is foreign or malformed');
    }
    const incident = new Map<string, ReturnType<typeof memoryRemovalRelation>>();
    for (const doc of [...subjectPage.docs, ...objectPage.docs])
      incident.set(doc.id, memoryRemovalRelation(doc, ownerId));
    const assertionDocs = [...assertionsAsSubject.docs, ...assertionsAsObject.docs];
    if (assertionDocs.some((doc) => doc.get('agentId') !== ownerId))
      throw new Error('Memory removal graph assertion is foreign or malformed');
    const hasOtherRelation = [...incident.values()].some((row) => row.sourceMemoryId !== memoryId);
    const orphaned = !hasOtherRelation && assertionDocs.length === 0;
    const preferredLabel = entityDoc.get('preferredLabel');
    const label =
      typeof preferredLabel === 'string' && preferredLabel.trim()
        ? preferredLabel
        : entityDoc.get('label');
    if (typeof label !== 'string' || !label.trim())
      throw new Error('Memory removal graph endpoint label is unavailable');
    endpointProofs.push({
      id: entityId,
      label,
      native: nativeRevision(entityDoc),
      incident: [...incident.values()].sort((a, b) => a.id.localeCompare(b.id)),
      assertions: assertionDocs
        .map(nativeRevision)
        .sort((a, b) => (a?.id ?? '').localeCompare(b?.id ?? '')),
      aliases: aliases.docs
        .map(nativeRevision)
        .sort((a, b) => (a?.id ?? '').localeCompare(b?.id ?? '')),
      orphaned,
    });
  }
  const orphanedItems = endpointProofs
    .filter((row) => row.orphaned)
    .map(({ id, label }) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const orphanedProofs = endpointProofs.filter((row) => row.orphaned);
  const orphanedAliasCount = orphanedProofs.reduce((count, row) => count + row.aliases.length, 0);
  if (
    orphanedAliasCount >
    Math.min(MEMORY_REMOVAL_ALIAS_LIMIT, 490 - relations.length - orphanedProofs.length)
  )
    throw new Error('Memory removal graph cleanup impact exceeds its bound');
  const revision = ownerEditorSnapshotRevision({
    driver: 'firestore',
    ownerId,
    native: {
      memorySnapshotRevision,
      source: nativeRevision(sourceDoc),
      intent: nativeRevision(intentDoc),
      tombstone: nativeRevision(tombstoneDoc),
      contentHashIndex: nativeRevision(hashDoc),
      relations: relations.sort((a, b) => a.id.localeCompare(b.id)),
      evidence: evidence.sort((a, b) => a.id.localeCompare(b.id)),
      endpoints: endpointProofs.sort((a, b) => a.id.localeCompare(b.id)),
    },
  });
  return {
    memoryId,
    revision,
    connectionCount: relations.length,
    sourceEvidenceCount: evidence.length,
    orphanedItems,
  };
}

export async function readFirestoreOwnerMemoryRemovalSnapshot(
  store: InstallationStore,
  ownerId: string,
  memoryId: string,
  transaction?: Transaction,
): Promise<{
  snapshot: OwnerMemoryEditorSnapshot;
  impact: OwnerEditorMemoryRemovalImpact | null;
} | null> {
  const read = async (tx: Transaction) => {
    const current = await readScope(store, tx, ownerId, memoryId);
    if (!current) return null;
    if (!current.snapshot.eligible) return { snapshot: current.snapshot, impact: null };
    let impact: OwnerEditorMemoryRemovalImpact | null = null;
    try {
      impact = await readMemoryRemovalImpact(
        store,
        tx,
        ownerId,
        memoryId,
        current.memory.contentHash,
        current.snapshot.revision,
      );
    } catch {
      // Graph-review unavailability removes only the forget control. The base note
      // remains readable/correctable; commit independently rechecks and fails closed.
    }
    return { snapshot: current.snapshot, impact };
  };
  return transaction ? read(transaction) : store.db.runTransaction(read);
}

export interface PreparedFirestoreOwnerMemoryRemoval {
  memoryId: string;
  expectedContentHash: string;
  expectedMemoryRevision: string;
  expectedImpactRevision: string;
}

export function commitFirestoreOwnerMemoryRemoval(
  store: InstallationStore,
  claim: OwnerEditorClaim,
  prepared: PreparedFirestoreOwnerMemoryRemoval,
  now: Date,
): Promise<OwnerEditorReply> {
  return store.db.runTransaction(async (tx) => {
    const admitted = await beginFirestoreOwnerEditorWrite(store, tx, claim, now);
    if (admitted.kind === 'reply') return admitted.reply;
    const finish = (result: Parameters<typeof completeFirestoreOwnerEditorWrite>[3]) =>
      completeFirestoreOwnerEditorWrite(store, tx, admitted, result, now);
    if (claim.scope.command !== 'remove_owner_memory' || claim.scope.targetId !== prepared.memoryId)
      throw new Error('Memory removal claim target mismatch');
    const current = await readScope(store, tx, claim.scope.ownerId, prepared.memoryId);
    if (
      !current ||
      !current.snapshot.eligible ||
      current.snapshot.revision !== prepared.expectedMemoryRevision ||
      current.snapshot.contentHash !== prepared.expectedContentHash
    )
      return finish({ outcome: 'conflict', reason: 'memory_snapshot_changed' });
    const impact = await readMemoryRemovalImpact(
      store,
      tx,
      claim.scope.ownerId,
      prepared.memoryId,
      prepared.expectedContentHash,
      current.snapshot.revision,
    );
    if (impact.revision !== prepared.expectedImpactRevision)
      return finish({ outcome: 'conflict', reason: 'memory_removal_impact_changed' });

    // All authority, provenance, deletion-fence, graph-impact, tombstone, and
    // content-hash-index reads complete before the first write in this transaction.
    const memoryRef = store.doc('memories', prepared.memoryId);
    const tombstoneRef = store.doc('memoryTombstones', prepared.expectedContentHash);
    const hashRef = store.doc('memoryContentHashes', prepared.expectedContentHash);
    const [memoryDoc, tombstone, hash] = await tx.getAll(memoryRef, tombstoneRef, hashRef);
    if (
      !memoryDoc?.exists ||
      memoryDoc.get('agentId') !== claim.scope.ownerId ||
      memoryDoc.get('contentHash') !== prepared.expectedContentHash
    )
      return finish({ outcome: 'conflict', reason: 'memory_snapshot_changed' });
    if (tombstone?.exists)
      return finish({ outcome: 'conflict', reason: 'memory_snapshot_changed' });
    if (
      hash?.exists &&
      (hash.get('memoryId') !== prepared.memoryId ||
        (hash.get('agentId') !== undefined && hash.get('agentId') !== claim.scope.ownerId))
    )
      return finish({ outcome: 'unavailable', reason: 'memory_hash_index_unavailable' });

    const createdAt = store.now();
    tx.create(
      tombstoneRef,
      encodeRecord({
        id: prepared.expectedContentHash,
        contentHash: prepared.expectedContentHash,
        reason: 'owner_forget',
        createdAt,
      }),
    );
    if (hash?.exists) tx.delete(hashRef);
    tx.set(
      store.doc('graphDeletionIntents', prepared.memoryId),
      encodeRecord({
        memoryId: prepared.memoryId,
        agentId: claim.scope.ownerId,
        contentHash: prepared.expectedContentHash,
        reason: 'owner_forget',
        createdAt,
        cleanupCompletedAt: null,
      }),
    );
    tx.delete(memoryRef);
    tx.set(
      store.doc('ownerCards', claim.scope.ownerId),
      encodeRecord({
        agentId: claim.scope.ownerId,
        content: '',
        compiledAt: createdAt,
        invalidatedAt: createdAt,
      }),
    );
    const ids = { memoryId: prepared.memoryId };
    return finish({
      outcome: 'saved',
      ids,
      revision: ownerEditorCommitRevision(claim, ids),
      refreshPending: true,
    });
  });
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
