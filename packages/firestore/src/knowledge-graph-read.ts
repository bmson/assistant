import {
  deriveSharedParentViews,
  type EmbeddingSpace,
  knowledgeAssertionEndpointView,
  type Records,
  snapshotEmbeddingSpace,
} from '@assistant/persistence';
import { graphSourceEligible } from './graph-source-eligibility.js';
import { decodeMemoryRecord } from './memory-record.js';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

type Entity = Records['knowledgeGraphEntities'];
type Relation = Records['knowledgeGraphRelations'];
type Assertion = Records['knowledgeGraphAssertions'];
type AssertionEvidence = Records['knowledgeGraphAssertionEvidence'];
type Memory = Records['memories'];
type Source = Records['knowledgeGraphSources'];
/** Firestore adds owner attribution to its installation ledger documents. */
type ModelCall = Records['modelCalls'] & { agentId?: string };

const PAGE_SIZE = 60;
const RELATION_LIMIT = 80;
export const RELATIVE_DATE =
  /\b(today|tomorrow|yesterday|(next|last|this)\s+(week|month|year)|(next|last|this|coming)\s+(mon|tues?|wed(nes)?|thur?s?|fri|satur|sun)day|(mon|tues?|wed(nes)?|thur?s?|fri|satur|sun)day)\b/i;

export async function assertConfiguredOwner(
  store: InstallationStore,
  agentId: string,
): Promise<void> {
  const agents = await store.collection('agents').limit(2).get();
  const owner = agents.docs[0];
  if (
    !agentId ||
    agents.size !== 1 ||
    !owner ||
    owner.get('id') !== agentId ||
    owner.id !== documentKey(agentId)
  )
    throw new Error('Knowledge graph requires exactly one configured agent');
}

async function byAgent<T extends { id: string; agentId: string }>(
  store: InstallationStore,
  collection: string,
  agentId: string,
  decode: (value: unknown) => T = (value) => decodeRecord<T>(value),
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = store.collection(collection).where('agentId', '==', agentId).limit(400);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      const row = decode(doc.data());
      if (row.agentId === agentId && typeof row.id === 'string' && documentKey(row.id) === doc.id)
        rows.push(row);
    }
    cursor = page.docs.at(-1);
    if (page.size < 400) return rows;
  }
}

async function sourcesFor(
  store: InstallationStore,
  memories: Memory[],
): Promise<Map<string, Source>> {
  const result = new Map<string, Source>();
  const ids = new Map(memories.map((memory) => [documentKey(memory.id), memory.id]));
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = store.collection('knowledgeGraphSources').limit(400);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      const row = decodeRecord<Source>(doc.data());
      // Imported source checkpoints can lack agentId. The owner memory and
      // exact document ID are the join authority, including for stale sources.
      if (typeof row.memoryId === 'string' && row.memoryId === ids.get(doc.id))
        result.set(row.memoryId, row);
    }
    cursor = page.docs.at(-1);
    if (page.size < 400) return result;
  }
}

function entityView(row: Entity) {
  return {
    id: row.id,
    label: row.preferredLabel ?? row.label,
    kind: row.kind,
    canonicalKey: row.canonicalKey,
  };
}

function validEntity(row: Entity): boolean {
  return (
    typeof row.label === 'string' &&
    typeof row.kind === 'string' &&
    typeof row.canonicalKey === 'string' &&
    (row.preferredLabel === null || typeof row.preferredLabel === 'string')
  );
}

function active(
  row: Relation,
  assertion: Assertion | undefined,
  memory: Memory | undefined,
  source: Source | undefined,
  extractionVersion: number,
  now: Date,
  space: EmbeddingSpace | undefined,
  tombstoned: boolean,
): boolean {
  return (
    !!memory &&
    (row.assertionId == null ||
      (assertion?.agentId === row.agentId &&
        assertion.lifecycle === 'current' &&
        assertion.reviewStatus !== 'rejected')) &&
    !!source &&
    !!space &&
    row.reviewStatus !== 'rejected' &&
    typeof row.evidenceQuote === 'string' &&
    graphSourceEligible({
      memory,
      source,
      agentId: row.agentId,
      space,
      storedSpace: memory.embeddingSpaceKey,
      extractionVersion,
      now,
      tombstoned,
    })
  );
}

function relationView(
  row: Relation,
  subject: Entity,
  object: Entity,
  memory: Memory,
  inRecall: boolean,
  assertion?: Assertion,
  evidenceCount = 0,
) {
  return {
    id: row.id,
    subject: entityView(subject),
    predicate: row.predicate,
    object: entityView(object),
    confidence: Number(row.confidence),
    reviewStatus:
      row.reviewStatus === 'confirmed' || row.reviewStatus === 'rejected'
        ? row.reviewStatus
        : 'unreviewed',
    reviewedAt: row.reviewedAt,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    inRecall,
    source: {
      memoryId: memory.id,
      content: memory.content,
      createdAt: memory.createdAt,
      ownerConfirmed: memory.ownerConfirmed,
      originTrust: memory.originTrust,
    },
    endpointViews:
      assertion?.lifecycle === 'current'
        ? [subject, object].flatMap((focus) => {
            const view = knowledgeAssertionEndpointView({
              assertionId: assertion.id,
              semanticRevision: assertion.semanticRevision,
              subjectEntityId: row.subjectEntityId,
              subjectLabel: entityView(subject).label,
              predicate: row.predicate,
              objectEntityId: row.objectEntityId,
              objectLabel: entityView(object).label,
              evidenceQuote: row.evidenceQuote ?? memory.content,
              evidenceCount,
              reviewStatus:
                assertion.reviewStatus === 'confirmed' || assertion.reviewStatus === 'rejected'
                  ? assertion.reviewStatus
                  : 'unreviewed',
              focusEntityId: focus.id,
            });
            return view ? [view] : [];
          })
        : [],
  };
}

function relationOrder(a: Relation, b: Relation): number {
  const rank = (status: string) => (status === 'unreviewed' ? 0 : status === 'confirmed' ? 1 : 2);
  return (
    rank(a.reviewStatus) - rank(b.reviewStatus) || b.createdAt.getTime() - a.createdAt.getTime()
  );
}

/** Owner-only graph browsing. Sources are scanned within the installation and joined to owner memories. */
export async function getFirestoreKnowledgeGraphOverview(
  store: InstallationStore,
  agentId: string,
  extractionVersion: number,
  input: {
    query?: string;
    kind?: string;
    entityId?: string;
    page?: number;
    pageSize?: number;
  } = {},
  now: Date = store.now(),
  batchLimit = 25,
  embeddingSpace?: EmbeddingSpace,
) {
  embeddingSpace = embeddingSpace ? snapshotEmbeddingSpace(embeddingSpace) : undefined;
  await assertConfiguredOwner(store, agentId);
  const fence = await readPrivacyErasureFence(store, agentId);
  const [entityRows, relationRows, memoryRows, assertionRows, evidenceRows] = await Promise.all([
    byAgent<Entity>(store, 'knowledgeGraphEntities', agentId),
    byAgent<Relation>(store, 'knowledgeGraphRelations', agentId),
    byAgent<Memory>(store, 'memories', agentId, decodeMemoryRecord),
    byAgent<Assertion>(store, 'knowledgeGraphAssertions', agentId),
    byAgent<AssertionEvidence>(store, 'knowledgeGraphAssertionEvidence', agentId),
  ]);
  const sources = await sourcesFor(store, memoryRows);
  const tombstoned = new Set<string>();
  const hashes = [
    ...new Set(
      memoryRows
        .map((row) => row.contentHash)
        .filter((hash) => typeof hash === 'string' && hash.length > 0),
    ),
  ];
  for (let offset = 0; offset < hashes.length; offset += 200) {
    const page = hashes.slice(offset, offset + 200);
    const docs = await store.db.getAll(...page.map((hash) => store.doc('memoryTombstones', hash)));
    for (const [index, doc] of docs.entries()) {
      const hash = page[index];
      if (doc.exists && hash) tombstoned.add(hash);
    }
  }
  const entities = new Map(entityRows.filter(validEntity).map((row) => [row.id, row]));
  const memories = new Map(memoryRows.map((row) => [row.id, row]));
  const assertions = new Map(assertionRows.map((row) => [row.id, row]));
  const evidenceCounts = new Map<string, number>();
  for (const evidence of evidenceRows)
    evidenceCounts.set(evidence.assertionId, (evidenceCounts.get(evidence.assertionId) ?? 0) + 1);
  const joined = relationRows.filter(
    (row) =>
      entities.has(row.subjectEntityId) &&
      entities.has(row.objectEntityId) &&
      memories.has(row.sourceMemoryId) &&
      row.createdAt instanceof Date,
  );
  const activeRows = joined.filter((row) =>
    active(
      row,
      row.assertionId ? assertions.get(row.assertionId) : undefined,
      memories.get(row.sourceMemoryId),
      sources.get(row.sourceMemoryId),
      extractionVersion,
      now,
      embeddingSpace,
      tombstoned.has(memories.get(row.sourceMemoryId)?.contentHash ?? ''),
    ),
  );
  const activeEntityIds = new Set(
    activeRows.flatMap((row) => [row.subjectEntityId, row.objectEntityId]),
  );
  const activeAssertionIds = new Set(
    activeRows.flatMap((row) => (row.assertionId ? [row.assertionId] : [])),
  );
  const sorted = [...entities.values()].sort(
    (a, b) =>
      entityView(a)
        .label.toLocaleLowerCase()
        .localeCompare(entityView(b).label.toLocaleLowerCase()) || a.id.localeCompare(b.id),
  );
  const query = (input.query ?? '').trim().slice(0, 120).toLocaleLowerCase();
  const matches = sorted.filter(
    (row) =>
      activeEntityIds.has(row.id) &&
      (!input.kind || row.kind === input.kind) &&
      (!query || entityView(row).label.toLocaleLowerCase().includes(query)),
  );
  const pageSize = Math.max(1, input.pageSize ?? PAGE_SIZE);
  const entityPages = Math.max(1, Math.ceil(matches.length / pageSize));
  const requestedPage =
    Number.isInteger(input.page) && (input.page ?? 0) > 0 ? (input.page ?? 1) : 1;
  const entityPage = Math.min(requestedPage, entityPages);
  const page = matches.slice((entityPage - 1) * pageSize, entityPage * pageSize).map(entityView);
  const selected = input.entityId ? entities.get(input.entityId) : entities.get(page[0]?.id ?? '');
  const incident = selected
    ? joined.filter(
        (row) => row.subjectEntityId === selected.id || row.objectEntityId === selected.id,
      )
    : [];
  const activeIncident = new Set(
    activeRows
      .filter((row) => row.subjectEntityId === selected?.id || row.objectEntityId === selected?.id)
      .map((row) => row.id),
  );
  const pendingMemories = memoryRows.filter((memory) => {
    const source = sources.get(memory.id);
    return (
      memory.category === 'knowledge' &&
      memory.quarantined === false &&
      (memory.expiresAt === null || (memory.expiresAt instanceof Date && memory.expiresAt > now)) &&
      (!source ||
        source.contentHash !== memory.contentHash ||
        source.subjectContactId !== memory.subjectContactId ||
        source.status === 'failed')
    );
  });
  const quarantinedSources = memoryRows.filter(
    (row) => sources.get(row.id)?.status === 'quarantined',
  ).length;
  const relationBySource = new Map<string, Relation[]>();
  for (const row of joined)
    relationBySource.set(row.sourceMemoryId, [
      ...(relationBySource.get(row.sourceMemoryId) ?? []),
      row,
    ]);
  const relativeDateSources = memoryRows.filter(
    (memory) =>
      memory.category === 'knowledge' &&
      !memory.quarantined &&
      sources.get(memory.id)?.status === 'ready' &&
      RELATIVE_DATE.test(memory.content) &&
      !(relationBySource.get(memory.id) ?? []).some((row) =>
        [entities.get(row.subjectEntityId), entities.get(row.objectEntityId)].some(
          (entity) => entity?.kind === 'date' && /^date:[0-9-]+$/.test(entity.canonicalKey),
        ),
      ),
  ).length;
  let meanCost: number | null = null;
  if (pendingMemories.length) {
    const calls = await store
      .collection('modelCalls')
      .where('agentId', '==', agentId)
      .where('role', '==', 'extract')
      .orderBy('createdAt', 'desc')
      .limit(200)
      .get();
    const recent = calls.docs
      .map((doc) => decodeRecord<ModelCall>(doc.data()))
      .filter(
        (row) =>
          row.role === 'extract' &&
          row.agentId === agentId &&
          row.createdAt instanceof Date &&
          Number.isFinite(Number(row.costUsd)),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 200);
    if (recent.length >= 10) {
      const total = recent.reduce((sum, row) => sum + Number(row.costUsd), 0);
      if (total > 0) meanCost = total / recent.length;
    }
  }
  const duplicateCandidates = selected
    ? sorted.filter((row) => row.kind === selected.kind && row.id !== selected.id).slice(0, 500)
    : [];
  const duplicates = selected
    ? duplicateCandidates
        .filter((row) => {
          const a = entityView(selected).label.toLocaleLowerCase();
          const b = entityView(row).label.toLocaleLowerCase();
          const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
          return shorter.length >= 3 && (shorter === longer || longer.startsWith(`${shorter} `));
        })
        .slice(0, 5)
        .map((row) => ({
          targetId: row.id,
          label: entityView(row).label,
          kind: row.kind,
          reason: 'matching name',
        }))
    : [];
  const result = {
    totalEntities: activeEntityIds.size,
    totalRelations: activeRows.length,
    unreviewedRelations: activeRows.filter((row) => row.reviewStatus === 'unreviewed').length,
    pendingSources: pendingMemories.length,
    quarantinedSources,
    pendingCostUsd: meanCost === null ? null : pendingMemories.length * meanCost,
    pendingRuns: Math.ceil(pendingMemories.length / batchLimit),
    relativeDateSources,
    entities: page,
    matchingEntities: matches.length,
    entityPage,
    entityPages,
    selected: selected ? entityView(selected) : null,
    relations: incident
      .sort(relationOrder)
      .slice(0, RELATION_LIMIT)
      .flatMap((row) => {
        const subject = entities.get(row.subjectEntityId);
        const object = entities.get(row.objectEntityId);
        const memory = memories.get(row.sourceMemoryId);
        return subject && object && memory
          ? [
              relationView(
                row,
                subject,
                object,
                memory,
                activeIncident.has(row.id),
                row.assertionId ? assertions.get(row.assertionId) : undefined,
                evidenceCounts.get(row.assertionId ?? '') ?? 0,
              ),
            ]
          : [];
      }),
    derivedRelations: deriveSharedParentViews(
      assertionRows
        .filter(
          (row) =>
            activeAssertionIds.has(row.id) &&
            row.lifecycle === 'current' &&
            (row.reviewStatus === 'confirmed' || row.reviewStatus === 'unreviewed'),
        )
        .map((row) => ({
          id: row.id,
          semanticRevision: row.semanticRevision,
          subjectEntityId: row.subjectEntityId,
          predicate: row.predicate,
          objectEntityId: row.objectEntityId,
          assertion: row.assertion,
          lifecycle: 'current' as const,
          reviewStatus:
            row.reviewStatus === 'confirmed' ? ('confirmed' as const) : ('unreviewed' as const),
        })),
      new Map(entityRows.map((row) => [row.id, entityView(row).label])),
    ).filter((row) => row.subjectEntityId === selected?.id || row.objectEntityId === selected?.id),
    derivedCoverage: 'complete' as const,
    selectedRelationTotal: incident.length,
    selectedActiveRelationTotal: activeIncident.size,
    duplicates,
  };
  await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
  await assertConfiguredOwner(store, agentId);
  return result;
}

/** Review keeps stale source-backed edges visible, matching the PostgreSQL audit queue. */
export async function getFirestoreKnowledgeGraphReviewQueue(
  store: InstallationStore,
  agentId: string,
  extractionVersion: number,
  now: Date = store.now(),
  embeddingSpace?: EmbeddingSpace,
) {
  embeddingSpace = embeddingSpace ? snapshotEmbeddingSpace(embeddingSpace) : undefined;
  await assertConfiguredOwner(store, agentId);
  const fence = await readPrivacyErasureFence(store, agentId);
  const [relations, assertionRows, evidenceRows] = await Promise.all([
    byAgent<Relation>(store, 'knowledgeGraphRelations', agentId),
    byAgent<Assertion>(store, 'knowledgeGraphAssertions', agentId),
    byAgent<AssertionEvidence>(store, 'knowledgeGraphAssertionEvidence', agentId),
  ]);
  const assertions = new Map(assertionRows.map((row) => [row.id, row]));
  const evidenceCounts = new Map<string, number>();
  for (const evidence of evidenceRows)
    evidenceCounts.set(evidence.assertionId, (evidenceCounts.get(evidence.assertionId) ?? 0) + 1);
  const pending = relations
    .filter(
      (row) =>
        row.reviewStatus === 'unreviewed' &&
        row.createdAt instanceof Date &&
        (row.assertionId == null ||
          (assertions.get(row.assertionId)?.lifecycle === 'current' &&
            assertions.get(row.assertionId)?.reviewStatus === 'unreviewed')),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 50);
  const ids = [
    ...new Set(
      pending.flatMap((row) => [row.subjectEntityId, row.objectEntityId, row.sourceMemoryId]),
    ),
  ];
  const docs = await Promise.all(
    ids.map(async (id) => ({
      id,
      entity: await store.doc('knowledgeGraphEntities', id).get(),
      memory: await store.doc('memories', id).get(),
      source: await store.doc('knowledgeGraphSources', id).get(),
    })),
  );
  const entities = new Map<string, Entity>();
  const memories = new Map<string, Memory>();
  const sources = new Map<string, Source>();
  for (const item of docs) {
    if (item.entity.exists) {
      const row = decodeRecord<Entity>(item.entity.data());
      if (row.id === item.id && row.agentId === agentId && validEntity(row))
        entities.set(item.id, row);
    }
    if (item.memory.exists) {
      const row = decodeMemoryRecord(item.memory.data());
      if (row.id === item.id && row.agentId === agentId) memories.set(item.id, row);
    }
    if (item.source.exists) {
      const row = decodeRecord<Source>(item.source.data());
      if (row.memoryId === item.id) sources.set(item.id, row);
    }
  }
  const tombstoned = new Set<string>();
  for (const memory of memories.values()) {
    if (
      typeof memory.contentHash === 'string' &&
      (await store.doc('memoryTombstones', memory.contentHash).get()).exists
    )
      tombstoned.add(memory.id);
  }
  const result = pending.flatMap((row) => {
    const subject = entities.get(row.subjectEntityId);
    const object = entities.get(row.objectEntityId);
    const memory = memories.get(row.sourceMemoryId);
    const assertion = row.assertionId ? assertions.get(row.assertionId) : undefined;
    return subject && object && memory
      ? [
          relationView(
            row,
            subject,
            object,
            memory,
            active(
              row,
              assertion,
              memory,
              sources.get(memory.id),
              extractionVersion,
              now,
              embeddingSpace,
              tombstoned.has(memory.id),
            ),
            assertion,
            evidenceCounts.get(assertion?.id ?? '') ?? 0,
          ),
        ]
      : [];
  });
  await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
  await assertConfiguredOwner(store, agentId);
  return result;
}

/** Resolve one owner's evidence row independently of browse and review page caps. */
export async function getFirestoreKnowledgeGraphRelation(
  store: InstallationStore,
  agentId: string,
  extractionVersion: number,
  relationId: string,
  now: Date = store.now(),
  embeddingSpace?: EmbeddingSpace,
) {
  embeddingSpace = embeddingSpace ? snapshotEmbeddingSpace(embeddingSpace) : undefined;
  await assertConfiguredOwner(store, agentId);
  const fence = await readPrivacyErasureFence(store, agentId);
  const relationDoc = await store.doc('knowledgeGraphRelations', relationId).get();
  if (!relationDoc.exists) return null;
  const relation = decodeRecord<Relation>(relationDoc.data());
  if (
    relation.id !== relationId ||
    documentKey(relation.id) !== relationDoc.id ||
    relation.agentId !== agentId
  )
    return null;
  const [subjectDoc, objectDoc, memoryDoc, sourceDoc, assertionDoc] = await store.db.getAll(
    store.doc('knowledgeGraphEntities', relation.subjectEntityId),
    store.doc('knowledgeGraphEntities', relation.objectEntityId),
    store.doc('memories', relation.sourceMemoryId),
    store.doc('knowledgeGraphSources', relation.sourceMemoryId),
    ...(relation.assertionId ? [store.doc('knowledgeGraphAssertions', relation.assertionId)] : []),
  );
  const subject = subjectDoc?.exists ? decodeRecord<Entity>(subjectDoc.data()) : null;
  const object = objectDoc?.exists ? decodeRecord<Entity>(objectDoc.data()) : null;
  const memory = memoryDoc?.exists ? decodeMemoryRecord(memoryDoc.data()) : null;
  const source = sourceDoc?.exists ? decodeRecord<Source>(sourceDoc.data()) : null;
  const assertion = assertionDoc?.exists ? decodeRecord<Assertion>(assertionDoc.data()) : undefined;
  const assertionEvidence = relation.assertionId
    ? await store
        .collection('knowledgeGraphAssertionEvidence')
        .where('agentId', '==', agentId)
        .where('assertionId', '==', relation.assertionId)
        .count()
        .get()
    : null;
  const ownedSource =
    source?.memoryId === relation.sourceMemoryId &&
    sourceDoc?.id === documentKey(relation.sourceMemoryId)
      ? source
      : undefined;
  const valid =
    subject &&
    object &&
    memory &&
    subject.id === relation.subjectEntityId &&
    object.id === relation.objectEntityId &&
    memory.id === relation.sourceMemoryId &&
    subject.agentId === agentId &&
    object.agentId === agentId &&
    memory.agentId === agentId &&
    subjectDoc?.id === documentKey(subject.id) &&
    objectDoc?.id === documentKey(object.id) &&
    memoryDoc?.id === documentKey(memory.id) &&
    validEntity(subject) &&
    validEntity(object);
  const tombstoned =
    !!memory &&
    typeof memory.contentHash === 'string' &&
    (await store.doc('memoryTombstones', memory.contentHash).get()).exists;
  const result = valid
    ? relationView(
        relation,
        subject,
        object,
        memory,
        active(
          relation,
          assertion,
          memory,
          ownedSource,
          extractionVersion,
          now,
          embeddingSpace,
          tombstoned,
        ),
        assertion,
        assertionEvidence?.data().count ?? 0,
      )
    : null;
  await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
  await assertConfiguredOwner(store, agentId);
  return result;
}
