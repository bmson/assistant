import { type EmbeddingSpace, type Records, snapshotEmbeddingSpace } from '@assistant/persistence';
import type { DocumentSnapshot, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { graphSourceEligible } from './graph-source-eligibility.js';
import { decodeMemoryRecord } from './memory-record.js';
import { getFirestorePersonDetail } from './people-directory.js';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const NEIGHBOR_LIMIT = 120;
type Entity = Records['knowledgeGraphEntities'];
type Relation = Records['knowledgeGraphRelations'];
type Assertion = Records['knowledgeGraphAssertions'];
type Source = Records['knowledgeGraphSources'];

export interface FirestorePersonGraphEdge {
  id: string;
  predicate: string;
  outbound: boolean;
  reviewStatus: 'confirmed' | 'unreviewed';
  validFrom: string | null;
  validUntil: string | null;
  other: {
    id: string;
    label: string;
    kind: string;
    canonicalKey: string;
  };
}

export interface FirestorePersonGraphRead {
  entityId: string | null;
  edges: FirestorePersonGraphEdge[];
}

function ownedEntity(doc: DocumentSnapshot | undefined, agentId: string): Entity | null {
  if (!doc?.exists) return null;
  const row = decodeRecord<Entity>(doc.data());
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== doc.id ||
    row.agentId !== agentId ||
    typeof row.kind !== 'string' ||
    typeof row.canonicalKey !== 'string' ||
    typeof row.label !== 'string' ||
    (row.preferredLabel !== null && typeof row.preferredLabel !== 'string')
  )
    return null;
  return row;
}

function activeEdge(
  doc: QueryDocumentSnapshot,
  documents: Map<string, DocumentSnapshot>,
  store: InstallationStore,
  agentId: string,
  entityId: string,
  extractionVersion: number,
  now: Date,
  space: EmbeddingSpace | undefined,
): (FirestorePersonGraphEdge & { createdAt: Date }) | null {
  const row = decodeRecord<Relation>(doc.data());
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== doc.id ||
    row.agentId !== agentId ||
    row.reviewStatus === 'rejected' ||
    typeof row.evidenceQuote !== 'string' ||
    typeof row.predicate !== 'string' ||
    typeof row.subjectEntityId !== 'string' ||
    typeof row.objectEntityId !== 'string' ||
    typeof row.sourceMemoryId !== 'string' ||
    !(row.createdAt instanceof Date) ||
    (row.assertionId != null &&
      (typeof row.assertionId !== 'string' || row.assertionId.length === 0)) ||
    (row.validFrom !== null && typeof row.validFrom !== 'string') ||
    (row.validUntil !== null && typeof row.validUntil !== 'string') ||
    (row.subjectEntityId !== entityId && row.objectEntityId !== entityId)
  )
    return null;
  const read = (collection: string, id: string) => documents.get(store.doc(collection, id).path);
  if (row.assertionId != null) {
    const assertionDoc = read('knowledgeGraphAssertions', row.assertionId);
    if (!assertionDoc?.exists) return null;
    const assertion = decodeRecord<Assertion>(assertionDoc.data());
    if (
      assertion.id !== row.assertionId ||
      assertion.agentId !== agentId ||
      assertion.lifecycle !== 'current' ||
      assertion.reviewStatus === 'rejected'
    )
      return null;
  }
  const memoryDoc = read('memories', row.sourceMemoryId);
  const sourceDoc = read('knowledgeGraphSources', row.sourceMemoryId);
  if (!memoryDoc?.exists || !sourceDoc?.exists) return null;
  const memory = decodeMemoryRecord(memoryDoc.data());
  const source = decodeRecord<Source>(sourceDoc.data());
  if (
    typeof memory.id !== 'string' ||
    documentKey(memory.id) !== memoryDoc.id ||
    memory.id !== row.sourceMemoryId ||
    memory.agentId !== agentId ||
    memory.category !== 'knowledge' ||
    memory.quarantined !== false ||
    (memory.expiresAt !== null &&
      (!(memory.expiresAt instanceof Date) || memory.expiresAt <= now)) ||
    !space ||
    !graphSourceEligible({
      memory,
      source,
      agentId,
      space,
      storedSpace: memoryDoc.get('embeddingSpace'),
      extractionVersion,
      now,
      tombstoned:
        typeof memory.contentHash === 'string' &&
        read('memoryTombstones', memory.contentHash)?.exists === true,
    }) ||
    typeof memory.contentHash !== 'string' ||
    source.memoryId !== memory.id ||
    documentKey(source.memoryId) !== sourceDoc.id ||
    source.status !== 'ready' ||
    source.contentHash !== memory.contentHash ||
    !Number.isInteger(source.extractionVersion) ||
    source.extractionVersion < extractionVersion
  )
    return null;
  const subject = ownedEntity(read('knowledgeGraphEntities', row.subjectEntityId), agentId);
  const object = ownedEntity(read('knowledgeGraphEntities', row.objectEntityId), agentId);
  if (!subject || !object) return null;
  const outbound = row.subjectEntityId === entityId;
  const other = outbound ? object : subject;
  return {
    id: row.id,
    predicate: row.predicate,
    outbound,
    reviewStatus: row.reviewStatus === 'confirmed' ? 'confirmed' : 'unreviewed',
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    other: {
      id: other.id,
      label: other.preferredLabel ?? other.label,
      kind: other.kind,
      canonicalKey: other.canonicalKey,
    },
    createdAt: row.createdAt,
  };
}

/** One contact's source-backed graph neighborhood; the mobile card remains gated. */
export async function getFirestorePersonGraph(
  store: InstallationStore,
  configuredAgentId: string,
  contactId: string,
  extractionVersion: number,
  now: Date = store.now(),
  embeddingSpace?: EmbeddingSpace,
): Promise<FirestorePersonGraphRead | null> {
  embeddingSpace = embeddingSpace ? snapshotEmbeddingSpace(embeddingSpace) : undefined;
  const contact = await getFirestorePersonDetail(store, configuredAgentId, contactId);
  if (!contact) return null;
  if (!Number.isInteger(extractionVersion) || extractionVersion < 1)
    throw new Error('Invalid graph extraction version');
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const result = await store.db.runTransaction(
    async (tx) => {
      const entities = await tx.get(
        store
          .collection('knowledgeGraphEntities')
          .where('agentId', '==', configuredAgentId)
          .where('contactId', '==', contactId)
          .limit(2),
      );
      if (entities.size > 1) throw new Error('Person graph has ambiguous contact entities');
      const self = entities.docs[0];
      if (!self) return { entityId: null, edges: [] };
      const entity = ownedEntity(self, configuredAgentId);
      if (!entity || entity.contactId !== contactId)
        throw new Error('Person graph has a malformed contact entity');
      const [outbound, inbound] = await Promise.all([
        tx.get(
          store
            .collection('knowledgeGraphRelations')
            .where('agentId', '==', configuredAgentId)
            .where('subjectEntityId', '==', entity.id)
            .limit(NEIGHBOR_LIMIT + 1),
        ),
        tx.get(
          store
            .collection('knowledgeGraphRelations')
            .where('agentId', '==', configuredAgentId)
            .where('objectEntityId', '==', entity.id)
            .limit(NEIGHBOR_LIMIT + 1),
        ),
      ]);
      const candidates = new Map([...outbound.docs, ...inbound.docs].map((doc) => [doc.id, doc]));
      if (
        outbound.size > NEIGHBOR_LIMIT ||
        inbound.size > NEIGHBOR_LIMIT ||
        candidates.size > NEIGHBOR_LIMIT
      )
        throw new Error('Person graph relation scan bound reached');
      const refs = new Map<string, FirebaseFirestore.DocumentReference>();
      for (const doc of candidates.values()) {
        const row = decodeRecord<Relation>(doc.data());
        if (
          typeof row.sourceMemoryId !== 'string' ||
          typeof row.subjectEntityId !== 'string' ||
          typeof row.objectEntityId !== 'string'
        )
          continue;
        for (const [collection, id] of [
          ['memories', row.sourceMemoryId],
          ['knowledgeGraphSources', row.sourceMemoryId],
          ['knowledgeGraphEntities', row.subjectEntityId],
          ['knowledgeGraphEntities', row.objectEntityId],
        ] as const) {
          const ref = store.doc(collection, id);
          refs.set(ref.path, ref);
        }
        if (row.assertionId) {
          const ref = store.doc('knowledgeGraphAssertions', row.assertionId);
          refs.set(ref.path, ref);
        }
      }
      const documents = new Map<string, DocumentSnapshot>();
      const allRefs = [...refs.values()];
      for (let offset = 0; offset < allRefs.length; offset += 200) {
        for (const snapshot of await tx.getAll(...allRefs.slice(offset, offset + 200)))
          documents.set(snapshot.ref.path, snapshot);
      }
      const tombstoneRefs = new Map<string, FirebaseFirestore.DocumentReference>();
      for (const doc of documents.values()) {
        if (doc.ref.parent.id !== 'memories' || typeof doc.get('contentHash') !== 'string')
          continue;
        const ref = store.doc('memoryTombstones', doc.get('contentHash'));
        tombstoneRefs.set(ref.path, ref);
      }
      const tombstoneList = [...tombstoneRefs.values()];
      for (let offset = 0; offset < tombstoneList.length; offset += 200) {
        for (const snapshot of await tx.getAll(...tombstoneList.slice(offset, offset + 200)))
          documents.set(snapshot.ref.path, snapshot);
      }
      const edges = [...candidates.values()]
        .flatMap((doc) => {
          const edge = activeEdge(
            doc,
            documents,
            store,
            configuredAgentId,
            entity.id,
            extractionVersion,
            now,
            embeddingSpace,
          );
          return edge ? [edge] : [];
        })
        .sort(
          (a, b) =>
            Number(b.reviewStatus === 'confirmed') - Number(a.reviewStatus === 'confirmed') ||
            b.createdAt.getTime() - a.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .map(({ createdAt: _, ...edge }) => edge);
      return { entityId: entity.id, edges };
    },
    { readOnly: true },
  );
  // Revalidate agent, contact scope, and the durable erasure fence after the graph snapshot.
  if (!(await getFirestorePersonDetail(store, configuredAgentId, contactId)))
    throw new Error('Person graph contact changed during read');
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return result;
}
