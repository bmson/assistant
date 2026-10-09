import {
  type EmbeddingSpace,
  type KnowledgeCleanupSource,
  type KnowledgeMapEdgeFilter,
  type KnowledgeMapEdgeRecord,
  type KnowledgeNeighborEdgeRecord,
  type KnowledgeWorkspaceEntity,
  type KnowledgeWorkspaceFocus,
  type KnowledgeWorkspaceReadRepository,
  type KnowledgeWorkspaceSnapshot,
  type Records,
  snapshotEmbeddingSpace,
} from '@assistant/persistence';
import { type DocumentSnapshot, FieldPath, type Query } from '@google-cloud/firestore';
import { graphSourceEligible } from './graph-source-eligibility.js';
import { assertConfiguredOwner } from './knowledge-graph-read.js';
import { embeddingSpaceKey } from './memory.js';
import { decodeMemoryRecord } from './memory-record.js';
import { getFirestorePersonDetail } from './people-directory.js';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 1000;
const MEMORY_LIMIT = 100_000;
const SOURCE_LIMIT = 100_000;
const ENTITY_LIMIT = 50_000;
const RELATION_LIMIT = 50_000;
const ASSERTION_LIMIT = 50_000;
const ASSERTION_EVIDENCE_LIMIT = 100_000;
/** Incident relations scanned per direction for one neighbourhood before failing explicitly. */
const NEIGHBOR_SCAN_LIMIT = 5_000;
const FOCUS_RELATION_LIMIT = 80;
/** Projection writers keep at most a handful of relations per source memory. */
const SOURCE_RELATION_LIMIT = 100;
const DUPLICATE_CANDIDATE_LIMIT = 500;
const CLEANUP_MEMORY_LIMIT = 100;
const CLEANUP_RELATION_LIMIT = 50;
const CLEANUP_SOURCE_LIMIT = 50;
const GET_ALL_BATCH = 300;

/**
 * Scans omit vectors and long text. Candidate sources get bounded vector
 * point reads before claiming eligibility; a space marker cannot prove readiness.
 */
const MEMORY_FIELDS = [
  'id',
  'agentId',
  'category',
  'quarantined',
  'expiresAt',
  'contentHash',
  'subjectContactId',
  'ownerConfirmed',
  'lastConsolidatedAt',
  'supersededById',
  'createdAt',
  'embeddingSpaceKey',
  'embeddingSpace',
];
const ENTITY_FIELDS = [
  'id',
  'agentId',
  'label',
  'preferredLabel',
  'kind',
  'canonicalKey',
  'contactId',
];
const RELATION_FIELDS = [
  'id',
  'agentId',
  'createdAt',
  'subjectEntityId',
  'objectEntityId',
  'predicate',
  'sourceMemoryId',
  'reviewStatus',
  'evidenceQuote',
  'validFrom',
  'validUntil',
  'assertionId',
];
const ASSERTION_FIELDS = [
  'id',
  'agentId',
  'semanticRevision',
  'lifecycle',
  'reviewStatus',
  'subjectEntityId',
  'predicate',
  'objectEntityId',
];
const ASSERTION_EVIDENCE_FIELDS = ['id', 'agentId', 'assertionId'];
const SOURCE_FIELDS = [
  'memoryId',
  'status',
  'contentHash',
  'extractionVersion',
  'subjectContactId',
];

type Memory = Pick<
  Records['memories'],
  | 'id'
  | 'agentId'
  | 'category'
  | 'quarantined'
  | 'expiresAt'
  | 'contentHash'
  | 'embeddingSpaceKey'
  | 'subjectContactId'
  | 'ownerConfirmed'
  | 'lastConsolidatedAt'
  | 'supersededById'
  | 'createdAt'
>;
type Entity = Pick<
  Records['knowledgeGraphEntities'],
  'id' | 'agentId' | 'label' | 'preferredLabel' | 'kind' | 'canonicalKey' | 'contactId'
>;
type Relation = Pick<
  Records['knowledgeGraphRelations'],
  | 'id'
  | 'agentId'
  | 'createdAt'
  | 'subjectEntityId'
  | 'objectEntityId'
  | 'predicate'
  | 'sourceMemoryId'
  | 'reviewStatus'
  | 'evidenceQuote'
  | 'validFrom'
  | 'validUntil'
  | 'assertionId'
>;
type Assertion = Pick<
  Records['knowledgeGraphAssertions'],
  | 'id'
  | 'agentId'
  | 'semanticRevision'
  | 'lifecycle'
  | 'reviewStatus'
  | 'subjectEntityId'
  | 'predicate'
  | 'objectEntityId'
>;
type Source = Pick<
  Records['knowledgeGraphSources'],
  'memoryId' | 'status' | 'contentHash' | 'extractionVersion' | 'subjectContactId'
>;

async function scan(
  query: Query,
  limit: number,
  label: string,
  visit: (doc: FirebaseFirestore.QueryDocumentSnapshot) => void,
): Promise<void> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let seen = 0;
  for (;;) {
    let page = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const rows = await page.get();
    seen += rows.size;
    if (seen > limit) throw new Error(`Knowledge workspace ${label} scan exceeds its limit`);
    for (const doc of rows.docs) visit(doc);
    if (rows.size < PAGE_SIZE) return;
    cursor = rows.docs.at(-1);
  }
}

/** Batched point reads with a field mask; never one RPC per row. */
async function readMany(
  store: InstallationStore,
  collection: string,
  ids: Iterable<string>,
  fieldMask: string[],
): Promise<Map<string, DocumentSnapshot>> {
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += GET_ALL_BATCH)
    batches.push(unique.slice(offset, offset + GET_ALL_BATCH));
  const result = new Map<string, DocumentSnapshot>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, batches.length) }, async () => {
      for (;;) {
        const batch = batches[next++];
        if (!batch) return;
        const docs = await store.db.getAll(...batch.map((id) => store.doc(collection, id)), {
          fieldMask,
        });
        batch.forEach((id, index) => {
          const doc = docs[index];
          if (doc?.exists) result.set(id, doc);
        });
      }
    }),
  );
  return result;
}

function validEntity(doc: DocumentSnapshot, agentId: string): Entity | null {
  const row = decodeRecord<Entity>(doc.data());
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== doc.id ||
    row.agentId !== agentId ||
    typeof row.label !== 'string' ||
    typeof row.kind !== 'string' ||
    typeof row.canonicalKey !== 'string' ||
    (row.preferredLabel != null && typeof row.preferredLabel !== 'string')
  )
    return null;
  return { ...row, preferredLabel: row.preferredLabel ?? null, contactId: row.contactId ?? null };
}

function validRelation(doc: DocumentSnapshot, agentId: string): Relation | null {
  const row = decodeRecord<Relation>(doc.data());
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== doc.id ||
    row.agentId !== agentId ||
    typeof row.subjectEntityId !== 'string' ||
    typeof row.objectEntityId !== 'string' ||
    typeof row.sourceMemoryId !== 'string' ||
    typeof row.predicate !== 'string' ||
    !(row.createdAt instanceof Date)
  )
    return null;
  return {
    ...row,
    evidenceQuote: typeof row.evidenceQuote === 'string' ? row.evidenceQuote : null,
    validFrom: row.validFrom ?? null,
    validUntil: row.validUntil ?? null,
    assertionId: typeof row.assertionId === 'string' ? row.assertionId : null,
  };
}

function validMemory(doc: DocumentSnapshot, agentId: string): Memory | null {
  const row = decodeMemoryRecord(doc.data());
  if (typeof row.id !== 'string' || documentKey(row.id) !== doc.id || row.agentId !== agentId)
    return null;
  return row;
}

function displayLabel(row: Entity): string {
  return row.preferredLabel || row.label;
}

function entityView(row: Entity): KnowledgeWorkspaceEntity {
  return { id: row.id, label: displayLabel(row), kind: row.kind, canonicalKey: row.canonicalKey };
}

function reviewStatus(value: string): 'unreviewed' | 'confirmed' | 'rejected' {
  return value === 'confirmed' || value === 'rejected' ? value : 'unreviewed';
}

function unexpired(memory: Memory, now: Date): boolean {
  return memory.expiresAt == null || (memory.expiresAt instanceof Date && memory.expiresAt > now);
}

/** Cheap candidate filter; actual source eligibility is validated below. */
function activeSource(
  memory: Memory | undefined,
  source: Source | undefined,
  extractionVersion: number,
  now: Date,
): boolean {
  return (
    !!memory &&
    !!source &&
    memory.category === 'knowledge' &&
    memory.quarantined === false &&
    unexpired(memory, now) &&
    typeof memory.embeddingSpaceKey === 'string' &&
    memory.embeddingSpaceKey.length > 0 &&
    source.status === 'ready' &&
    source.contentHash === memory.contentHash &&
    Number.isInteger(source.extractionVersion) &&
    source.extractionVersion >= extractionVersion
  );
}

function newestFirst(a: Relation, b: Relation): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id);
}

async function contentFor(
  store: InstallationStore,
  agentId: string,
  memoryIds: Iterable<string>,
): Promise<Map<string, string>> {
  const docs = await readMany(store, 'memories', memoryIds, ['id', 'agentId', 'content']);
  const content = new Map<string, string>();
  for (const [id, doc] of docs) {
    const row = decodeRecord<{ id?: unknown; agentId?: unknown; content?: unknown }>(doc.data());
    if (row.id === id && row.agentId === agentId && typeof row.content === 'string')
      content.set(id, row.content);
  }
  return content;
}

/** Owner knowledge workspace reads from bounded projections and batched point reads. */
export class FirestoreKnowledgeWorkspaceReadRepository implements KnowledgeWorkspaceReadRepository {
  readonly kind = 'knowledge-workspace-read-repository' as const;
  readonly embeddingSpace?: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
    embeddingSpace?: EmbeddingSpace,
  ) {
    this.embeddingSpace = embeddingSpace ? snapshotEmbeddingSpace(embeddingSpace) : undefined;
  }

  async snapshot(input: {
    extractionVersion: number;
    now: Date;
  }): Promise<KnowledgeWorkspaceSnapshot> {
    const { store, configuredAgentId: agentId } = this;
    const { extractionVersion, now } = input;
    await assertConfiguredOwner(store, agentId);
    const fence = await readPrivacyErasureFence(store, agentId);
    const memories = new Map<string, Memory>();
    const entities = new Map<string, Entity>();
    const relations: Relation[] = [];
    const assertions = new Map<string, Assertion>();
    const assertionEvidenceCounts = new Map<string, number>();
    const endpoints = new Set<string>();
    const sourceDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    const owned = (collection: string, fields: string[]) =>
      store
        .collection(collection)
        .where('agentId', '==', agentId)
        .select(...fields) as Query;
    await Promise.all([
      scan(owned('memories', MEMORY_FIELDS), MEMORY_LIMIT, 'memory', (doc) => {
        const row = validMemory(doc, agentId);
        if (row) memories.set(row.id, row);
      }),
      scan(owned('knowledgeGraphEntities', ENTITY_FIELDS), ENTITY_LIMIT, 'entity', (doc) => {
        const row = validEntity(doc, agentId);
        if (row) entities.set(row.id, row);
      }),
      scan(owned('knowledgeGraphRelations', RELATION_FIELDS), RELATION_LIMIT, 'relation', (doc) => {
        const subject = doc.get('subjectEntityId');
        const object = doc.get('objectEntityId');
        if (typeof subject === 'string') endpoints.add(subject);
        if (typeof object === 'string') endpoints.add(object);
        const row = validRelation(doc, agentId);
        if (row) relations.push(row);
      }),
      scan(
        owned('knowledgeGraphAssertions', ASSERTION_FIELDS),
        ASSERTION_LIMIT,
        'assertion',
        (doc) => {
          const row = decodeRecord<Assertion>(doc.data());
          if (
            typeof row.id === 'string' &&
            documentKey(row.id) === doc.id &&
            row.agentId === agentId &&
            typeof row.semanticRevision === 'number' &&
            typeof row.lifecycle === 'string' &&
            typeof row.reviewStatus === 'string' &&
            typeof row.subjectEntityId === 'string' &&
            typeof row.predicate === 'string' &&
            typeof row.objectEntityId === 'string'
          )
            assertions.set(row.id, row);
        },
      ),
      scan(
        owned('knowledgeGraphAssertionEvidence', ASSERTION_EVIDENCE_FIELDS),
        ASSERTION_EVIDENCE_LIMIT,
        'assertion evidence',
        (doc) => {
          const row = decodeRecord<{ id?: unknown; agentId?: unknown; assertionId?: unknown }>(
            doc.data(),
          );
          if (
            typeof row.id === 'string' &&
            documentKey(row.id) === doc.id &&
            row.agentId === agentId &&
            typeof row.assertionId === 'string'
          )
            assertionEvidenceCounts.set(
              row.assertionId,
              (assertionEvidenceCounts.get(row.assertionId) ?? 0) + 1,
            );
        },
      ),
      // Imported source checkpoints can lack agentId, so sources are scanned
      // within the installation and joined to owner memories by document ID.
      scan(
        store.collection('knowledgeGraphSources').select(...SOURCE_FIELDS) as Query,
        SOURCE_LIMIT,
        'graph source',
        (doc) => sourceDocs.push(doc),
      ),
    ]);
    const memoryIdByKey = new Map([...memories.keys()].map((id) => [documentKey(id), id]));
    const sources = new Map<string, Source>();
    for (const doc of sourceDocs) {
      const row = decodeRecord<Source>(doc.data());
      if (typeof row.memoryId === 'string' && row.memoryId === memoryIdByKey.get(doc.id))
        sources.set(row.memoryId, row);
    }

    const knowledge = [...memories.values()].filter((row) => row.category === 'knowledge');
    const memoryHealth = {
      totalUsable: 0,
      notYetOrganized: 0,
      awaitingReview: 0,
      ownerConfirmed: 0,
      lastOrganizedAt: null as Date | null,
    };
    let pendingSources = 0;
    for (const memory of knowledge) {
      if (!unexpired(memory, now)) continue;
      if (memory.quarantined === true) {
        memoryHealth.awaitingReview += 1;
        continue;
      }
      if (memory.quarantined !== false) continue;
      memoryHealth.totalUsable += 1;
      if (memory.lastConsolidatedAt == null) memoryHealth.notYetOrganized += 1;
      else if (
        memory.lastConsolidatedAt instanceof Date &&
        (!memoryHealth.lastOrganizedAt || memory.lastConsolidatedAt > memoryHealth.lastOrganizedAt)
      )
        memoryHealth.lastOrganizedAt = memory.lastConsolidatedAt;
      if (memory.ownerConfirmed === true) memoryHealth.ownerConfirmed += 1;
      const source = sources.get(memory.id);
      if (
        !source ||
        source.contentHash !== memory.contentHash ||
        (source.subjectContactId ?? null) !== (memory.subjectContactId ?? null) ||
        source.status === 'failed'
      )
        pendingSources += 1;
    }
    const blockedSources = [...sources.values()]
      .filter((source) => source.status === 'failed' || source.status === 'quarantined')
      .sort((a, b) => a.memoryId.localeCompare(b.memoryId));

    const candidates = relations.filter(
      (row: Relation) =>
        row.reviewStatus !== 'rejected' &&
        row.evidenceQuote !== null &&
        entities.has(row.subjectEntityId) &&
        entities.has(row.objectEntityId) &&
        activeSource(
          memories.get(row.sourceMemoryId),
          sources.get(row.sourceMemoryId),
          extractionVersion,
          now,
        ) &&
        !memories.get(row.sourceMemoryId)?.supersededById &&
        !!this.embeddingSpace &&
        memories.get(row.sourceMemoryId)?.embeddingSpaceKey ===
          embeddingSpaceKey(this.embeddingSpace),
    );
    // Only candidate source vectors are point-read, in bounded batches. A space
    // marker alone cannot prove that a vector exists or has valid dimensions.
    const eligible = new Set<string>();
    const candidateIds = [...new Set(candidates.map((row) => row.sourceMemoryId))];
    if (this.embeddingSpace) {
      for (let offset = 0; offset < candidateIds.length; offset += GET_ALL_BATCH) {
        const page = candidateIds.slice(offset, offset + GET_ALL_BATCH);
        const docs = await store.db.getAll(...page.map((id) => store.doc('memories', id)), {
          fieldMask: [...MEMORY_FIELDS, 'embedding'],
        });
        const tombstones = await store.db.getAll(
          ...page.map((id) => store.doc('memoryTombstones', memories.get(id)?.contentHash ?? id)),
        );
        for (const [index, doc] of docs.entries()) {
          const id = page[index];
          const source = id ? sources.get(id) : undefined;
          if (!id || !doc.exists || !source) continue;
          const memory = decodeMemoryRecord(doc.data());
          if (
            memory.id === id &&
            documentKey(id) === doc.id &&
            graphSourceEligible({
              memory,
              source,
              agentId,
              space: this.embeddingSpace,
              storedSpace: doc.get('embeddingSpace'),
              extractionVersion,
              now,
              tombstoned: tombstones[index]?.exists === true,
            })
          )
            eligible.add(id);
        }
      }
    }
    const active = candidates.filter((row) => eligible.has(row.sourceMemoryId)).sort(newestFirst);
    const activeIds = new Set(active.map((row) => row.id));
    const activeEntities = new Set(
      active.flatMap((row) => [row.subjectEntityId, row.objectEntityId]),
    );
    const orphanedEntities = [...entities.keys()].filter((id) => !endpoints.has(id)).length;

    const cleanupMemories = knowledge
      .filter(
        (row) =>
          row.quarantined === true ||
          (row.expiresAt instanceof Date && row.expiresAt <= now) ||
          (typeof row.supersededById === 'string' && row.supersededById.length > 0),
      )
      .sort(
        (a, b) =>
          (b.createdAt instanceof Date ? b.createdAt.getTime() : 0) -
            (a.createdAt instanceof Date ? a.createdAt.getTime() : 0) || a.id.localeCompare(b.id),
      )
      .slice(0, CLEANUP_MEMORY_LIMIT);
    const cleanupRelations = relations
      .filter(
        (row) =>
          (row.reviewStatus === 'unreviewed' || row.reviewStatus === 'rejected') &&
          memories.has(row.sourceMemoryId),
      )
      .sort(newestFirst)
      .slice(0, CLEANUP_RELATION_LIMIT);
    const cleanupContent = await contentFor(store, agentId, [
      ...cleanupMemories.map((row) => row.id),
      ...cleanupRelations.map((row) => row.sourceMemoryId),
    ]);
    const cleanup: KnowledgeCleanupSource = {
      memories: cleanupMemories.flatMap((row) => {
        const content = cleanupContent.get(row.id);
        return content === undefined
          ? []
          : [
              {
                id: row.id,
                content,
                quarantined: row.quarantined === true,
                supersededById: row.supersededById ?? null,
              },
            ];
      }),
      relations: cleanupRelations.flatMap((row) => {
        const content = cleanupContent.get(row.sourceMemoryId);
        return content === undefined
          ? []
          : [
              {
                id: row.id,
                memoryId: row.sourceMemoryId,
                content,
                reviewStatus: row.reviewStatus,
              },
            ];
      }),
      sources: blockedSources
        .slice(0, CLEANUP_SOURCE_LIMIT)
        .map((source) => ({ memoryId: source.memoryId, status: source.status })),
      orphanedEntities,
    };
    await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
    await assertConfiguredOwner(store, agentId);

    /** Hydrate only the drawn edges' source text, then recheck the erasure fence. */
    const records = async (rows: Relation[]): Promise<KnowledgeMapEdgeRecord[]> => {
      const content = await contentFor(
        store,
        agentId,
        rows.map((row) => row.sourceMemoryId),
      );
      await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
      return rows.flatMap((row) => {
        const subject = entities.get(row.subjectEntityId);
        const object = entities.get(row.objectEntityId);
        const sourceContent = content.get(row.sourceMemoryId);
        if (!subject || !object || sourceContent === undefined) return [];
        return [
          {
            id: row.id,
            predicate: row.predicate,
            reviewStatus: row.reviewStatus,
            subjectId: subject.id,
            subjectLabel: displayLabel(subject),
            subjectKind: subject.kind,
            subjectContactId: subject.contactId,
            objectId: object.id,
            objectLabel: displayLabel(object),
            objectKind: object.kind,
            objectContactId: object.contactId,
            sourceMemoryId: row.sourceMemoryId,
            sourceContent,
            evidenceQuote: row.evidenceQuote,
            validFrom: row.validFrom,
            validUntil: row.validUntil,
            assertionContext: (() => {
              const assertion = row.assertionId ? assertions.get(row.assertionId) : undefined;
              if (
                !assertion ||
                assertion.agentId !== agentId ||
                assertion.subjectEntityId !== row.subjectEntityId ||
                assertion.predicate !== row.predicate ||
                assertion.objectEntityId !== row.objectEntityId
              )
                return null;
              return {
                id: assertion.id,
                semanticRevision: assertion.semanticRevision,
                lifecycle: assertion.lifecycle,
                reviewStatus: assertion.reviewStatus,
                subjectEntityId: assertion.subjectEntityId,
                predicate: assertion.predicate,
                objectEntityId: assertion.objectEntityId,
                evidenceCount: assertionEvidenceCounts.get(assertion.id) ?? 0,
              };
            })(),
          },
        ];
      });
    };
    const matches = (row: Relation, filter: KnowledgeMapEdgeFilter) => {
      const subject = entities.get(row.subjectEntityId);
      const object = entities.get(row.objectEntityId);
      if (!subject || !object) return false;
      const query = filter.query.toLocaleLowerCase();
      return (
        (!query ||
          [displayLabel(subject), displayLabel(object), subject.label, object.label].some((label) =>
            label.toLocaleLowerCase().includes(query),
          )) &&
        (!filter.entityId || subject.id === filter.entityId || object.id === filter.entityId) &&
        (!filter.kind || subject.kind === filter.kind || object.kind === filter.kind) &&
        (filter.predicates.length === 0 || filter.predicates.includes(row.predicate)) &&
        (filter.review === 'all' || row.reviewStatus === filter.review) &&
        (!filter.sourceMemoryId || row.sourceMemoryId === filter.sourceMemoryId)
      );
    };

    return {
      memory: memoryHealth,
      graph: {
        activeEntities: activeEntities.size,
        activeRelations: active.length,
        orphanedEntities,
        pendingSources,
        failedSources: blockedSources.length,
      },
      cleanup,
      async mapEdges(filter, limit) {
        const matching = active.filter((row) => matches(row, filter));
        return { rows: await records(matching.slice(0, limit)), total: matching.length };
      },
      async interiorEdges(entityIds, limit) {
        const ids = new Set(entityIds);
        return records(
          active
            .filter((row) => ids.has(row.subjectEntityId) && ids.has(row.objectEntityId))
            .slice(0, limit),
        );
      },
      async focus(entityId): Promise<KnowledgeWorkspaceFocus | null> {
        const selected = entities.get(entityId);
        if (!selected) return null;
        const rank = (status: string) =>
          status === 'unreviewed' ? 0 : status === 'confirmed' ? 1 : 2;
        const incident = relations
          .filter(
            (row) =>
              (row.subjectEntityId === entityId || row.objectEntityId === entityId) &&
              entities.has(row.subjectEntityId) &&
              entities.has(row.objectEntityId) &&
              memories.has(row.sourceMemoryId),
          )
          .sort((a, b) => rank(a.reviewStatus) - rank(b.reviewStatus) || newestFirst(a, b))
          .slice(0, FOCUS_RELATION_LIMIT);
        const content = await contentFor(
          store,
          agentId,
          incident.map((row) => row.sourceMemoryId),
        );
        await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
        const label = displayLabel(selected).toLocaleLowerCase();
        const duplicates = [...entities.values()]
          .filter((row) => row.kind === selected.kind && row.id !== selected.id)
          .sort(
            (a, b) =>
              displayLabel(a)
                .toLocaleLowerCase()
                .localeCompare(displayLabel(b).toLocaleLowerCase()) || a.id.localeCompare(b.id),
          )
          .slice(0, DUPLICATE_CANDIDATE_LIMIT)
          .filter((row) => {
            const other = displayLabel(row).toLocaleLowerCase();
            const [shorter, longer] =
              label.length <= other.length ? [label, other] : [other, label];
            return shorter.length >= 3 && (shorter === longer || longer.startsWith(`${shorter} `));
          })
          .slice(0, 5)
          .map((row) => ({
            targetId: row.id,
            label: displayLabel(row),
            kind: row.kind,
            reason: 'matching name',
          }));
        return {
          selected: entityView(selected),
          duplicates,
          relations: incident.flatMap((row) => {
            const subject = entities.get(row.subjectEntityId);
            const object = entities.get(row.objectEntityId);
            const sourceContent = content.get(row.sourceMemoryId);
            if (!subject || !object || sourceContent === undefined) return [];
            return [
              {
                id: row.id,
                subject: entityView(subject),
                predicate: row.predicate,
                object: entityView(object),
                reviewStatus: reviewStatus(row.reviewStatus),
                inRecall: activeIds.has(row.id),
                source: { memoryId: row.sourceMemoryId, content: sourceContent },
              },
            ];
          }),
        };
      },
    };
  }

  async entity(entityId: string): Promise<KnowledgeWorkspaceEntity | null> {
    await assertConfiguredOwner(this.store, this.configuredAgentId);
    const doc = await this.store.doc('knowledgeGraphEntities', entityId).get();
    const row = doc.exists ? validEntity(doc, this.configuredAgentId) : null;
    return row ? entityView(row) : null;
  }

  async neighborhood(input: {
    entityId: string;
    limit: number;
    predicates: string[];
    extractionVersion: number;
    now: Date;
  }) {
    const { store, configuredAgentId: agentId } = this;
    await assertConfiguredOwner(store, agentId);
    const fence = await readPrivacyErasureFence(store, agentId);
    const entityDoc = await store.doc('knowledgeGraphEntities', input.entityId).get();
    const entity = entityDoc.exists ? validEntity(entityDoc, agentId) : null;
    if (!entity) return { entity: null, edges: [], total: 0 };
    const incident = (field: 'subjectEntityId' | 'objectEntityId') =>
      store
        .collection('knowledgeGraphRelations')
        .where('agentId', '==', agentId)
        .where(field, '==', entity.id)
        .select(...RELATION_FIELDS)
        .limit(NEIGHBOR_SCAN_LIMIT + 1)
        .get();
    const [outbound, inbound] = await Promise.all([
      incident('subjectEntityId'),
      incident('objectEntityId'),
    ]);
    if (outbound.size > NEIGHBOR_SCAN_LIMIT || inbound.size > NEIGHBOR_SCAN_LIMIT)
      throw new Error('Knowledge neighbourhood relation scan exceeds its limit');
    const candidates = new Map<string, Relation>();
    for (const doc of [...outbound.docs, ...inbound.docs]) {
      const row = validRelation(doc, agentId);
      if (
        row &&
        row.reviewStatus !== 'rejected' &&
        row.evidenceQuote !== null &&
        (input.predicates.length === 0 || input.predicates.includes(row.predicate))
      )
        candidates.set(row.id, row);
    }
    const rows = [...candidates.values()];
    const sourceIds = rows.map((row) => row.sourceMemoryId);
    const [memoryDocs, sourceDocs, entityDocs] = await Promise.all([
      readMany(store, 'memories', sourceIds, MEMORY_FIELDS),
      readMany(store, 'knowledgeGraphSources', sourceIds, SOURCE_FIELDS),
      readMany(
        store,
        'knowledgeGraphEntities',
        rows.flatMap((row) => [row.subjectEntityId, row.objectEntityId]),
        ENTITY_FIELDS,
      ),
    ]);
    const memory = (id: string) => {
      const doc = memoryDocs.get(id);
      const row = doc ? validMemory(doc, agentId) : null;
      return row?.id === id ? row : undefined;
    };
    const source = (id: string) => {
      const doc = sourceDocs.get(id);
      const row = doc ? decodeRecord<Source>(doc.data()) : undefined;
      return row?.memoryId === id ? row : undefined;
    };
    const endpoint = (id: string) => {
      const doc = entityDocs.get(id);
      const row = doc ? validEntity(doc, agentId) : null;
      return row?.id === id ? row : null;
    };
    const edges = rows
      .flatMap((row) => {
        const subject = endpoint(row.subjectEntityId);
        const object = endpoint(row.objectEntityId);
        if (
          !subject ||
          !object ||
          !activeSource(
            memory(row.sourceMemoryId),
            source(row.sourceMemoryId),
            input.extractionVersion,
            input.now,
          )
        )
          return [];
        const isOutbound = row.subjectEntityId === entity.id;
        return [{ row, edge: { isOutbound, other: isOutbound ? object : subject } }];
      })
      .sort(
        (a, b) =>
          Number(b.row.reviewStatus === 'confirmed') - Number(a.row.reviewStatus === 'confirmed') ||
          newestFirst(a.row, b.row),
      );
    const result = {
      entity: entityView(entity),
      edges: edges.slice(0, input.limit).map(
        ({ row, edge }): KnowledgeNeighborEdgeRecord => ({
          id: row.id,
          predicate: row.predicate,
          outbound: edge.isOutbound,
          reviewStatus: reviewStatus(row.reviewStatus),
          validFrom: row.validFrom,
          validUntil: row.validUntil,
          other: entityView(edge.other),
        }),
      ),
      total: edges.length,
    };
    await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
    await assertConfiguredOwner(store, agentId);
    return result;
  }

  async personEntity(contactId: string): Promise<{ entityId: string | null } | null> {
    const { store, configuredAgentId: agentId } = this;
    if (!(await getFirestorePersonDetail(store, agentId, contactId))) return null;
    const entities = await store
      .collection('knowledgeGraphEntities')
      .where('agentId', '==', agentId)
      .where('contactId', '==', contactId)
      .select(...ENTITY_FIELDS)
      .limit(2)
      .get();
    if (entities.size > 1) throw new Error('Person graph has ambiguous contact entities');
    const doc = entities.docs[0];
    if (!doc) return { entityId: null };
    const entity = validEntity(doc, agentId);
    if (!entity || entity.contactId !== contactId)
      throw new Error('Person graph has a malformed contact entity');
    return { entityId: entity.id };
  }

  async sourceImpact(input: { memoryId: string; extractionVersion: number; now: Date }) {
    const { store, configuredAgentId: agentId } = this;
    await assertConfiguredOwner(store, agentId);
    const fence = await readPrivacyErasureFence(store, agentId);
    const [memoryDoc, sourceDoc, relationDocs] = await Promise.all([
      store.doc('memories', input.memoryId).get(),
      store.doc('knowledgeGraphSources', input.memoryId).get(),
      store
        .collection('knowledgeGraphRelations')
        .where('agentId', '==', agentId)
        .where('sourceMemoryId', '==', input.memoryId)
        .select(...RELATION_FIELDS)
        .limit(SOURCE_RELATION_LIMIT + 1)
        .get(),
    ]);
    const memory = memoryDoc.exists ? validMemory(memoryDoc, agentId) : null;
    if (!memory || typeof memoryDoc.get('content') !== 'string') return null;
    if (relationDocs.size > SOURCE_RELATION_LIMIT)
      throw new Error('Knowledge source relation scan exceeds its limit');
    const relations = relationDocs.docs.flatMap((doc) => {
      const row = validRelation(doc, agentId);
      return row?.sourceMemoryId === input.memoryId ? [row] : [];
    });
    const sourceRow = sourceDoc.exists ? decodeRecord<Source>(sourceDoc.data()) : undefined;
    const source = sourceRow?.memoryId === input.memoryId ? sourceRow : undefined;
    const sourceActive = activeSource(memory, source, input.extractionVersion, input.now);
    const activeConnectionCount = relations.filter(
      (row) => sourceActive && row.reviewStatus !== 'rejected' && row.evidenceQuote !== null,
    ).length;
    // An endpoint is orphaned when only this source's relations reference it.
    // Reading one row past this source's own incident count proves otherwise.
    const sameSource = new Map<string, number>();
    for (const row of relations)
      for (const id of new Set([row.subjectEntityId, row.objectEntityId]))
        sameSource.set(id, (sameSource.get(id) ?? 0) + 1);
    const shared = await Promise.all(
      [...sameSource].map(async ([entityId, count]) => {
        const incident = (field: 'subjectEntityId' | 'objectEntityId') =>
          store
            .collection('knowledgeGraphRelations')
            .where('agentId', '==', agentId)
            .where(field, '==', entityId)
            .select('sourceMemoryId')
            .limit(count + 1)
            .get();
        const pages = await Promise.all([incident('subjectEntityId'), incident('objectEntityId')]);
        return pages.some((page) =>
          page.docs.some((doc) => doc.get('sourceMemoryId') !== input.memoryId),
        )
          ? null
          : entityId;
      }),
    );
    const entityDocs = await readMany(
      store,
      'knowledgeGraphEntities',
      shared.filter((id): id is string => id !== null),
      ENTITY_FIELDS,
    );
    const orphanedItems = [...entityDocs.values()]
      .flatMap((doc) => {
        const row = validEntity(doc, agentId);
        return row ? [{ id: row.id, label: displayLabel(row) }] : [];
      })
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const result = {
      content: memoryDoc.get('content') as string,
      connectionCount: relations.length,
      activeConnectionCount,
      orphanedItems,
    };
    await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
    await assertConfiguredOwner(store, agentId);
    return result;
  }
}
