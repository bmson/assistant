import {
  type EmbeddingSpace,
  type GraphRecallRepository,
  type GraphRelation,
  type GraphSnapshotRelation,
  type GraphSnapshotRepository,
  historyLimit,
  type Records,
  snapshotEmbeddingSpace,
  validateEmbedding,
  validateEmbeddingSpace,
} from '@assistant/persistence';
import type { DocumentSnapshot, Query, Transaction } from '@google-cloud/firestore';
import { graphSourceEligible } from './graph-source-eligibility.js';
import { embeddingSpaceKey } from './memory.js';
import { decodeMemoryRecord } from './memory-record.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const RELATION_BOUND = 1000;
type Relation = Records['knowledgeGraphRelations'];
/** Entity and source-memory fields only the graph snapshot tool reports. */
type Detailed = GraphRelation & {
  detail: Pick<
    GraphSnapshotRelation,
    'subjectKind' | 'objectKind' | 'source' | 'ownerConfirmed'
  > & {
    memoryConfidence: string;
  };
};
const plain = ({ detail: _, ...row }: Detailed): GraphRelation => row;

function identity(snapshot: DocumentSnapshot, id: string): boolean {
  return snapshot.exists && typeof id === 'string' && documentKey(id) === snapshot.id;
}

/** Two-hop traversal over verified current sources, without exposing foreign or erased evidence. */
export class FirestoreGraphRecallRepository
  implements GraphRecallRepository, GraphSnapshotRepository
{
  readonly kind = 'graph-recall-repository' as const;
  readonly space: EmbeddingSpace;
  constructor(
    readonly store: InstallationStore,
    space: EmbeddingSpace,
  ) {
    this.space = snapshotEmbeddingSpace(space);
    validateEmbeddingSpace(this.space);
  }

  private async relations(tx: Transaction, queries: Query[]): Promise<DocumentSnapshot[]> {
    const result = new Map<string, DocumentSnapshot>();
    for (const query of queries) {
      const page = await tx.get(query.limit(RELATION_BOUND + 1));
      if (page.size > RELATION_BOUND) throw new Error('Graph relation scan bound reached');
      for (const row of page.docs) result.set(row.id, row);
      if (result.size > RELATION_BOUND) throw new Error('Graph relation scan bound reached');
    }
    return [...result.values()];
  }

  private async hydrate(
    tx: Transaction,
    candidates: DocumentSnapshot[],
    agentId: string,
    extractionVersion: number,
    similarities?: Map<string, { similarity: number; updateTime: DocumentSnapshot['updateTime'] }>,
  ): Promise<Detailed[]> {
    const relations = candidates.flatMap((doc) => {
      const row = decodeRecord<Relation>(doc.data());
      if (
        !identity(doc, row.id) ||
        row.agentId !== agentId ||
        row.reviewStatus === 'rejected' ||
        !row.assertion ||
        row.assertion.modality === 'unverified' ||
        typeof row.evidenceQuote !== 'string' ||
        typeof row.sourceMemoryId !== 'string' ||
        typeof row.subjectEntityId !== 'string' ||
        typeof row.objectEntityId !== 'string'
      )
        return [];
      return [row];
    });
    if (relations.length === 0) return [];
    const refs = new Map<string, FirebaseFirestore.DocumentReference>();
    for (const row of relations) {
      for (const [collection, id] of [
        ['memories', row.sourceMemoryId],
        ['knowledgeGraphSources', row.sourceMemoryId],
        ['knowledgeGraphEntities', row.subjectEntityId],
        ['knowledgeGraphEntities', row.objectEntityId],
      ] as const) {
        const ref = this.store.doc(collection, id);
        refs.set(ref.path, ref);
      }
    }
    // Keep every batch below the RPC document-count limit, at the same read-only transaction snapshot.
    const documents = new Map<string, DocumentSnapshot>();
    const allRefs = [...refs.values()];
    for (let offset = 0; offset < allRefs.length; offset += 200) {
      for (const snapshot of await tx.getAll(...allRefs.slice(offset, offset + 200)))
        documents.set(snapshot.ref.path, snapshot);
    }
    const read = (collection: string, id: string) =>
      documents.get(this.store.doc(collection, id).path);
    const memorySnapshots = relations.flatMap((row) => {
      const snapshot = read('memories', row.sourceMemoryId);
      return snapshot?.exists && typeof snapshot.get('contentHash') === 'string' ? [snapshot] : [];
    });
    const tombstoneRefs = [
      ...new Map(
        memorySnapshots.map((snapshot) => {
          const ref = this.store.doc('memoryTombstones', snapshot.get('contentHash'));
          return [ref.path, ref] as const;
        }),
      ).values(),
    ];
    const tombstones = new Set<string>();
    for (let offset = 0; offset < tombstoneRefs.length; offset += 200) {
      for (const snapshot of await tx.getAll(...tombstoneRefs.slice(offset, offset + 200)))
        if (snapshot.exists) tombstones.add(snapshot.ref.path);
    }
    const now = this.store.now();
    return relations.flatMap((row) => {
      const memoryDoc = read('memories', row.sourceMemoryId),
        sourceDoc = read('knowledgeGraphSources', row.sourceMemoryId);
      const subjectDoc = read('knowledgeGraphEntities', row.subjectEntityId),
        objectDoc = read('knowledgeGraphEntities', row.objectEntityId);
      if (!memoryDoc?.exists || !sourceDoc?.exists || !subjectDoc?.exists || !objectDoc?.exists)
        return [];
      const memory = decodeMemoryRecord(memoryDoc.data());
      const source = decodeRecord<Records['knowledgeGraphSources']>(sourceDoc.data());
      const subject = decodeRecord<Records['knowledgeGraphEntities']>(subjectDoc.data());
      const object = decodeRecord<Records['knowledgeGraphEntities']>(objectDoc.data());
      if (
        !identity(memoryDoc, memory.id) ||
        memory.id !== row.sourceMemoryId ||
        !graphSourceEligible({
          memory,
          source,
          agentId,
          space: this.space,
          storedSpace: memoryDoc.get('embeddingSpace'),
          extractionVersion,
          now,
          tombstoned: tombstones.has(this.store.doc('memoryTombstones', memory.contentHash).path),
        }) ||
        !identity(subjectDoc, subject.id) ||
        !identity(objectDoc, object.id) ||
        subject.id !== row.subjectEntityId ||
        object.id !== row.objectEntityId ||
        subject.agentId !== agentId ||
        object.agentId !== agentId
      )
        return [];
      const score = similarities?.get(memory.id);
      if (similarities && (!score?.updateTime || !memoryDoc.updateTime?.isEqual(score.updateTime)))
        return [];
      return [
        {
          relationId: row.id,
          subjectEntityId: subject.id,
          subjectLabel: subject.preferredLabel ?? subject.label,
          predicate: row.predicate,
          assertion: row.assertion,
          objectEntityId: object.id,
          objectLabel: object.preferredLabel ?? object.label,
          sourceMemoryId: memory.id,
          content: memory.content,
          evidenceQuote: row.evidenceQuote,
          createdAt: memory.createdAt,
          confidence: row.confidence,
          validFrom: row.validFrom,
          validUntil: row.validUntil,
          ...(score ? { similarity: score.similarity } : {}),
          detail: {
            subjectKind: subject.kind,
            objectKind: object.kind,
            source: memory.source,
            memoryConfidence: memory.confidence,
            ownerConfirmed: memory.ownerConfirmed,
          },
        },
      ];
    });
  }

  async seeds(input: Parameters<GraphRecallRepository['seeds']>[0]): Promise<GraphRelation[]> {
    return (await this.nearest(input)).map(plain);
  }

  /** The graph snapshot tool's view: the same verified seeds, with entity kinds and memory trust. */
  async snapshot(
    input: Parameters<GraphSnapshotRepository['snapshot']>[0],
  ): Promise<GraphSnapshotRelation[]> {
    return (await this.nearest(input)).map((row) => ({
      id: row.relationId,
      subjectId: row.subjectEntityId,
      subjectLabel: row.subjectLabel,
      subjectKind: row.detail.subjectKind,
      predicate: row.predicate,
      assertion: row.assertion,
      objectId: row.objectEntityId,
      objectLabel: row.objectLabel,
      objectKind: row.detail.objectKind,
      sourceMemoryId: row.sourceMemoryId,
      sourceMemory: row.content,
      source: row.detail.source,
      memoryConfidence: row.detail.memoryConfidence,
      ownerConfirmed: row.detail.ownerConfirmed,
      evidenceQuote: row.evidenceQuote,
      relationshipConfidence: row.confidence,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      similarity: Number(row.similarity),
    }));
  }

  private async nearest(input: Parameters<GraphRecallRepository['seeds']>[0]): Promise<Detailed[]> {
    historyLimit(input.limit);
    validateEmbedding(this.space, input.embedding);
    const candidateLimit = Math.min(200, Math.max(40, input.limit * 8));
    const memories = await this.store
      .collection('memories')
      .where('agentId', '==', input.agentId)
      .where('category', '==', 'knowledge')
      .where('quarantined', '==', false)
      .where('embeddingSpace', '==', embeddingSpaceKey(this.space))
      .findNearest({
        vectorField: 'embedding',
        queryVector: input.embedding,
        distanceMeasure: 'COSINE',
        limit: candidateLimit,
        distanceResultField: 'vectorDistance',
      })
      .get();
    if (memories.empty) return [];
    const scores = new Map(
      memories.docs.flatMap((doc) => {
        const id = doc.get('id'),
          similarity = 1 - Number(doc.get('vectorDistance'));
        return typeof id === 'string' && identity(doc, id) && Number.isFinite(similarity)
          ? [[id, { similarity, updateTime: doc.updateTime }] as const]
          : [];
      }),
    );
    return this.store.db.runTransaction(
      async (tx) => {
        const erasure = await tx.get(this.store.doc('privacyErasureJobs', input.agentId));
        if (erasure.exists && privacyErasureIsActive(erasure.get('status'))) return [];
        const ids = [...scores.keys()],
          queries: Query[] = [];
        for (let offset = 0; offset < ids.length; offset += 30)
          queries.push(
            this.store
              .collection('knowledgeGraphRelations')
              .where('agentId', '==', input.agentId)
              .where('sourceMemoryId', 'in', ids.slice(offset, offset + 30)),
          );
        const rows = await this.hydrate(
          tx,
          await this.relations(tx, queries),
          input.agentId,
          input.extractionVersion,
          scores,
        );
        rows.sort(
          (a, b) =>
            Number(b.similarity) - Number(a.similarity) || a.relationId.localeCompare(b.relationId),
        );
        if (rows.length < input.limit && memories.size === candidateLimit)
          throw new Error('Graph vector candidate bound reached');
        return rows.slice(0, input.limit);
      },
      { readOnly: true },
    );
  }

  async connected(
    input: Parameters<GraphRecallRepository['connected']>[0],
  ): Promise<GraphRelation[]> {
    historyLimit(input.limit);
    if (input.entityIds.length === 0) return [];
    if (input.entityIds.length > 100 || input.sourceMemoryIds.length > 100)
      throw new Error('Graph traversal bound reached');
    return this.store.db.runTransaction(
      async (tx) => {
        const erasure = await tx.get(this.store.doc('privacyErasureJobs', input.agentId));
        if (erasure.exists && privacyErasureIsActive(erasure.get('status'))) return [];
        const queries: Query[] = [];
        for (let offset = 0; offset < input.entityIds.length; offset += 30) {
          const ids = input.entityIds.slice(offset, offset + 30);
          for (const field of ['subjectEntityId', 'objectEntityId'])
            queries.push(
              this.store
                .collection('knowledgeGraphRelations')
                .where('agentId', '==', input.agentId)
                .where(field, 'in', ids),
            );
        }
        const candidates = (await this.relations(tx, queries)).filter(
          (row) => !input.sourceMemoryIds.includes(row.get('sourceMemoryId')),
        );
        const rows = await this.hydrate(tx, candidates, input.agentId, input.extractionVersion);
        return rows
          .map(plain)
          .sort(
            (a, b) =>
              Number(b.confidence) - Number(a.confidence) ||
              b.createdAt.getTime() - a.createdAt.getTime() ||
              a.relationId.localeCompare(b.relationId),
          )
          .slice(0, input.limit);
      },
      { readOnly: true },
    );
  }
}
