import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalizeKnowledgeAssertionDirection,
  type OwnerEditorApply,
  type OwnerEditorClaim,
  type OwnerEditorOperationRecord,
  type OwnerEditorReply,
  ownerEditorCommitRevision,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorReceipt,
  ownerEditorRecordMatches,
  ownerEditorRejected,
  ownerEditorRetired,
  ownerEditorSnapshotRevision,
  ownerEditorUnknown,
  parseOwnerEditorEpochCursor,
  type Records,
} from '@assistant/persistence';
import {
  type InactiveOwnerFamilyRejectionMarker,
  type InactiveOwnerFamilyRemovalRequest,
  parseInactiveOwnerFamilyRejectionMarker,
  parseInactiveOwnerFamilyRemovalCacheCursor,
  parseInactiveOwnerFamilyRemovalOperationRecord,
  parseInactiveOwnerFamilyRemovalRequest,
} from '@assistant/persistence/owner-family-rejection-storage';
import { planOwnerFamilyRemoval } from '@assistant/persistence/owner-family-removal';
import { eligibleOwnerFamilyCorrection } from '@assistant/persistence/owner-family-scope';
import {
  type DocumentSnapshot,
  FieldValue,
  type Query,
  Timestamp,
  type Transaction,
  VectorValue,
} from '@google-cloud/firestore';
import { decodeMemoryRecord } from './memory-record.js';
import { ownerEditorFirestorePrivacyToken } from './owner-editor-repository.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const epochName = (ownerId: string) => `owner-editor-epoch:${ownerId}`;
const cacheBarrierName = (ownerId: string) => `owner-source-rejection:${ownerId}`;
type Marker = InactiveOwnerFamilyRejectionMarker;

function validClock(value: unknown): number | null {
  try {
    if (!(value instanceof Date)) return null;
    const milliseconds = Date.prototype.getTime.call(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  } catch {
    return null;
  }
}

/** Process clocks are not Firestore transaction snapshot readTime. */
function currentTime(store: InstallationStore, supplied: unknown): Date | null {
  try {
    const processTime = validClock(store.now());
    const suppliedTime = validClock(supplied);
    return processTime === null || suppliedTime === null
      ? null
      : new Date(Math.max(processTime, suppliedTime));
  } catch {
    return null;
  }
}

function validExtractionVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validSourceFingerprint(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 512
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function contactMeaningKey(meaning: Marker['meaning']): string {
  return createHash('sha256')
    .update('owner-family-contact-meaning-v1\n')
    .update(stableJson(meaning))
    .digest('hex');
}

function requestHash(request: OwnerEditorApply): string {
  return createHash('sha256')
    .update('owner-editor-apply-v1\n')
    .update(stableJson(request))
    .digest('hex');
}

export function ownerFamilyRejectionMarkerId(
  installationLineageId: string,
  ownerId: string,
  sourceMemoryId: string,
): string {
  return createHash('sha256')
    .update('owner-family-source-rejection-v2\n')
    .update(stableJson([installationLineageId, ownerId, sourceMemoryId]))
    .digest('hex');
}

function exactValue(value: unknown): unknown {
  if (value instanceof Timestamp) return { $timestamp: [value.seconds, value.nanoseconds] };
  if (value instanceof VectorValue) return { $vector: value.toArray() };
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Invalid closure date');
    return { $date: value.toISOString() };
  }
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') };
  if (Array.isArray(value)) return value.map(exactValue);
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error('Unsupported closure value');
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, exactValue(entry)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error('Invalid closure number');
  return value;
}

type SnapshotReader = {
  tx: Transaction;
  docs: Map<string, DocumentSnapshot>;
  points: Map<string, DocumentSnapshot>;
  excludedFromClosure: Set<string>;
  queryResults: Map<string, DocumentSnapshot[]>;
  membership: Array<{ query: string; paths: string[] }>;
  readUnits: number;
};

function snapshotReader(tx: Transaction): SnapshotReader {
  return {
    tx,
    docs: new Map(),
    points: new Map(),
    excludedFromClosure: new Set(),
    queryResults: new Map(),
    membership: [],
    readUnits: 0,
  };
}

async function point(
  reader: SnapshotReader,
  ref: ReturnType<InstallationStore['doc']>,
  includeInClosure = true,
) {
  const cached = reader.points.get(ref.path);
  if (cached) {
    if (!includeInClosure) reader.excludedFromClosure.add(ref.path);
    return cached;
  }
  if (reader.readUnits >= 256) throw new Error('Owner family closure read bound reached');
  reader.readUnits += 1;
  const snapshot = await reader.tx.get(ref);
  remember(reader, snapshot);
  reader.points.set(ref.path, snapshot);
  if (!includeInClosure) reader.excludedFromClosure.add(ref.path);
  return snapshot;
}

function remember(reader: SnapshotReader, snapshot: DocumentSnapshot) {
  if (!snapshot.ref.path || (snapshot.exists && !snapshot.updateTime))
    throw new Error('Native closure revision unavailable');
  const previous = reader.docs.get(snapshot.ref.path);
  const previousTime = previous?.updateTime;
  const currentTime = snapshot.updateTime;
  if (
    previous &&
    (previous.exists !== snapshot.exists ||
      previousTime?.seconds !== currentTime?.seconds ||
      previousTime?.nanoseconds !== currentTime?.nanoseconds)
  )
    throw new Error('Inconsistent native closure read');
  reader.docs.set(snapshot.ref.path, snapshot);
  if (reader.docs.size > 256) throw new Error('Owner family closure read bound reached');
}

async function bounded(
  reader: SnapshotReader,
  query: Query,
  limit: number,
  name: string,
): Promise<DocumentSnapshot[]> {
  const cached = reader.queryResults.get(name);
  if (cached) {
    if (!reader.membership.some((entry) => entry.query === name))
      reader.membership.push({ query: name, paths: cached.map((doc) => doc.ref.path).sort() });
    return cached;
  }
  const remaining = 256 - reader.readUnits;
  if (remaining < 2) throw new Error('Owner family closure read bound reached');
  const queryLimit = Math.min(limit + 1, remaining - 1);
  reader.readUnits += 1;
  const page = await reader.tx.get(query.limit(queryLimit));
  reader.readUnits += page.docs.length;
  if (reader.readUnits > 256) throw new Error('Owner family closure read bound reached');
  if (page.size !== page.docs.length || page.size > limit)
    throw new Error(`${name} overflow or malformed query`);
  if (queryLimit < limit + 1 && page.size === queryLimit)
    throw new Error(`${name} incomplete because closure read budget was reached`);
  for (const doc of page.docs) remember(reader, doc);
  reader.membership.push({ query: name, paths: page.docs.map((doc) => doc.ref.path).sort() });
  reader.queryResults.set(name, page.docs);
  return page.docs;
}

function nativeRows(reader: SnapshotReader) {
  return [...reader.docs.values()]
    .filter((snapshot) => !reader.excludedFromClosure.has(snapshot.ref.path))
    .sort((left, right) => left.ref.path.localeCompare(right.ref.path))
    .map((snapshot) => {
      return {
        path: snapshot.ref.path,
        updateTime: snapshot.updateTime
          ? {
              seconds: snapshot.updateTime.seconds,
              nanoseconds: snapshot.updateTime.nanoseconds,
            }
          : null,
        exists: snapshot.exists,
        row: snapshot.exists ? exactValue(snapshot.data()) : null,
      };
    });
}

function closeRecord(
  row: OwnerEditorOperationRecord,
  result: OwnerEditorOperationRecord['result'],
  now: Date,
) {
  if (!result) throw new Error('Missing terminal result');
  return parseInactiveOwnerFamilyRemovalOperationRecord({
    ...row,
    status:
      result.outcome === 'saved' || result.outcome === 'unchanged'
        ? 'committed'
        : 'terminal_rejected',
    result,
    claimToken: null,
    claimExpiresAt: null,
    statusVersion: row.statusVersion + 1,
    updatedAt: now,
  });
}

function cursorData(snapshot: DocumentSnapshot, store: InstallationStore, ownerId: string) {
  if (!snapshot.exists || snapshot.get('name') !== cacheBarrierName(ownerId))
    throw new Error('Owner rejection protocol cursor unavailable');
  let raw: unknown;
  try {
    raw = JSON.parse(String(snapshot.get('cursor')));
  } catch {
    throw new Error('Owner rejection protocol cursor unavailable');
  }
  const parsed = parseInactiveOwnerFamilyRemovalCacheCursor(raw);
  if (parsed.ownerId !== ownerId || parsed.installationLineageId !== store.installationId)
    throw new Error('Owner rejection protocol lineage mismatch');
  return parsed;
}

async function closureInTransaction(
  store: InstallationStore,
  tx: Transaction,
  ownerId: string,
  relationId: string,
  expectedLineage: string,
  authority: OwnerEditorClaim['scope'],
  reader = snapshotReader(tx),
) {
  const owners = await bounded(reader, store.collection('agents').limit(2), 1, 'owner');
  const owner = owners[0];
  if (owners.length !== 1 || owner?.id !== documentKey(ownerId) || owner.get('id') !== ownerId)
    throw new Error('Configured owner unavailable');
  const [privacy, epoch, cacheCursor, relationDoc, ownerCard] = await Promise.all([
    point(reader, store.doc('privacyErasureJobs', ownerId)),
    point(reader, store.doc('maintenanceCursors', epochName(ownerId))),
    point(reader, store.doc('maintenanceCursors', cacheBarrierName(ownerId))),
    point(reader, store.doc('knowledgeGraphRelations', relationId)),
    point(reader, store.doc('ownerCards', ownerId)),
  ]);
  if (ownerCard.exists && ownerCard.get('agentId') !== ownerId)
    throw new Error('Owner card identity unavailable');
  if (!relationDoc.exists) throw new Error('Family relation unavailable');
  const relation = decodeRecord<Records['knowledgeGraphRelations']>(relationDoc.data());
  if (relation.agentId !== ownerId || relation.id !== relationId || !relation.assertionId)
    throw new Error('Family relation ownership or assertion unavailable');
  if (!epoch.exists || epoch.get('name') !== epochName(ownerId))
    throw new Error('Owner editor epoch unavailable');
  let epochRaw: unknown;
  try {
    epochRaw = JSON.parse(String(epoch.get('cursor')));
  } catch {
    throw new Error('Owner editor epoch unavailable');
  }
  const epochState = parseOwnerEditorEpochCursor(epochRaw);
  if (!epochState.ready || epochState.ownerId !== ownerId)
    throw new Error('Owner editor epoch unavailable');
  const privacyGeneration = ownerEditorFirestorePrivacyToken(privacy, ownerId);
  if (epochState.privacyGenerationDigest !== ownerEditorPrivacyDigest(privacyGeneration))
    throw new Error('Owner editor epoch is retired');
  const cache = cursorData(cacheCursor, store, ownerId);
  if (cache.installationLineageId !== expectedLineage)
    throw new Error('Owner rejection protocol lineage changed');
  if (
    authority.ownerId !== ownerId ||
    authority.epoch !== epochState.epoch ||
    authority.privacyGeneration !== privacyGeneration ||
    authority.command !== 'remove_owner_family_relationship' ||
    authority.targetId !== relationId
  )
    throw new Error('Removal operation authority changed');

  const sourceId = relation.sourceMemoryId;
  const assertionId = relation.assertionId;
  const markerKey = ownerFamilyRejectionMarkerId(store.installationId, ownerId, sourceId);
  const [marker, memoryDoc, assertionDoc, checkpointDoc, intentDoc] = await Promise.all([
    point(reader, store.doc('ownerFamilyClaimRejections', markerKey)),
    point(reader, store.doc('memories', sourceId)),
    point(reader, store.doc('knowledgeGraphAssertions', assertionId)),
    point(reader, store.doc('knowledgeGraphSources', sourceId)),
    point(reader, store.doc('graphDeletionIntents', sourceId)),
  ]);
  if (marker.exists) {
    const existing = parseInactiveOwnerFamilyRejectionMarker(decodeRecord(marker.data()));
    if (
      existing.id !== markerKey ||
      existing.ownerId !== ownerId ||
      existing.installationLineageId !== expectedLineage ||
      existing.sourceMemoryId !== sourceId ||
      existing.stableContactMeaningKey !== contactMeaningKey(existing.meaning)
    )
      throw new Error('Source rejection marker identity mismatch');
    return {
      reader,
      owner,
      privacyGeneration,
      epochState,
      cache,
      relation,
      markerKey,
      existingMarker: existing,
      rows: null,
      entities: [],
      contacts: [],
      checkpointRef: checkpointDoc.ref,
      assertionRef: assertionDoc.ref,
      relationRef: relationDoc.ref,
      ownerCardRef: ownerCard.ref,
    };
  }
  if (!memoryDoc.exists) throw new Error('Live owner family source unavailable');
  const source = decodeMemoryRecord(memoryDoc.data());
  const [hashDoc, tombstoneDoc] = await Promise.all([
    point(reader, store.doc('memoryContentHashes', source.contentHash)),
    point(reader, store.doc('memoryTombstones', source.contentHash)),
  ]);
  const sourceEvidence = await bounded(
    reader,
    store.collection('knowledgeGraphAssertionEvidence').where('sourceMemoryId', '==', sourceId),
    25,
    'source evidence',
  );
  const canonicalEvidence = await bounded(
    reader,
    store.collection('knowledgeGraphAssertionEvidence').where('assertionId', '==', assertionId),
    100,
    'canonical evidence',
  );
  const sourceRelations = await bounded(
    reader,
    store.collection('knowledgeGraphRelations').where('sourceMemoryId', '==', sourceId),
    25,
    'source relations',
  );
  const canonicalRelations = await bounded(
    reader,
    store.collection('knowledgeGraphRelations').where('assertionId', '==', assertionId),
    100,
    'canonical relations',
  );
  const semanticAssertions = await bounded(
    reader,
    store
      .collection('knowledgeGraphAssertions')
      .where('agentId', '==', ownerId)
      .where('semanticKey', '==', String(assertionDoc.get('semanticKey') ?? '')),
    100,
    'canonical assertions',
  );
  if (!memoryDoc.exists || !assertionDoc.exists || !checkpointDoc.exists)
    throw new Error('Live owner family closure unavailable');
  const assertion = decodeRecord<Records['knowledgeGraphAssertions']>(assertionDoc.data());
  const checkpoint = decodeRecord<
    Records['knowledgeGraphSources'] & { agentId?: string; retrievalRevision?: string }
  >(checkpointDoc.data());
  if (
    source.id !== sourceId ||
    source.agentId !== ownerId ||
    source.category !== 'knowledge' ||
    checkpoint.memoryId !== sourceId ||
    checkpoint.agentId !== ownerId ||
    checkpoint.status !== 'ready' ||
    checkpoint.contentHash !== source.contentHash ||
    typeof checkpoint.retrievalRevision !== 'string' ||
    !checkpoint.retrievalRevision ||
    typeof memoryDoc.get('retrievalRevision') !== 'string' ||
    checkpoint.retrievalRevision !== memoryDoc.get('retrievalRevision') ||
    !validExtractionVersion(checkpoint.extractionVersion) ||
    !validSourceFingerprint(relation.sourceFingerprint) ||
    source.quarantined ||
    source.expiresAt !== null ||
    source.supersededById !== null ||
    createHash('sha256').update(source.content).digest('hex') !== source.contentHash ||
    assertion.id !== assertionId ||
    assertion.agentId !== ownerId
  )
    throw new Error('Current source checkpoint or memory is unavailable');
  if (!hashDoc.exists || hashDoc.get('memoryId') !== sourceId)
    throw new Error('Memory content hash index is unavailable');
  if (tombstoneDoc.exists || intentDoc.exists)
    throw new Error('Deleted source cannot be rejected as current');
  if (
    sourceEvidence.length !== 1 ||
    canonicalEvidence.length !== 1 ||
    sourceRelations.length !== 1 ||
    canonicalRelations.length !== 1 ||
    semanticAssertions.length !== 1 ||
    semanticAssertions[0]?.id !== assertionDoc.id
  )
    throw new Error('Family support is shared or historical');
  const evidenceRows = canonicalEvidence.map((doc) =>
    decodeRecord<Records['knowledgeGraphAssertionEvidence']>(doc.data()),
  );
  if (
    evidenceRows.some(
      (row) =>
        !validExtractionVersion(row.extractionVersion) ||
        !validSourceFingerprint(row.sourceFingerprint) ||
        row.extractionVersion !== checkpoint.extractionVersion ||
        row.sourceFingerprint !== relation.sourceFingerprint ||
        row.sourceContentHash !== source.contentHash,
    )
  )
    throw new Error('Evidence extraction version is stale');

  const subjectEntityDoc = await point(
    reader,
    store.doc('knowledgeGraphEntities', relation.subjectEntityId),
  );
  const objectEntityDoc = await point(
    reader,
    store.doc('knowledgeGraphEntities', relation.objectEntityId),
  );
  if (!subjectEntityDoc.exists || !objectEntityDoc.exists)
    throw new Error('Family endpoint mapping unavailable');
  const entities = [subjectEntityDoc, objectEntityDoc].map((doc) =>
    decodeRecord<Records['knowledgeGraphEntities']>(doc.data()),
  );
  for (const entity of entities) {
    const entityPage = await bounded(
      reader,
      store
        .collection('knowledgeGraphEntities')
        .where('agentId', '==', ownerId)
        .where('canonicalKey', '==', entity.canonicalKey),
      1,
      `canonical endpoint:${entity.canonicalKey}`,
    );
    const aliases = await bounded(
      reader,
      store
        .collection('knowledgeGraphEntityAliases')
        .where('agentId', '==', ownerId)
        .where('canonicalKey', '==', entity.canonicalKey),
      0,
      `endpoint aliases:${entity.canonicalKey}`,
    );
    if (
      entityPage.length !== 1 ||
      aliases.length !== 0 ||
      entityPage[0]?.id !== (entity.id ? documentKey(entity.id) : '')
    )
      throw new Error('Family endpoint identity is ambiguous');
  }
  const contactIds = entities.map((entity) => entity.contactId);
  if (contactIds.some((id) => !id)) throw new Error('Family contact identity unavailable');
  const contactDocs = await Promise.all(
    contactIds.map((id) => {
      if (!id) throw new Error('Family contact identity unavailable');
      return point(reader, store.doc('contacts', id));
    }),
  );
  if (contactDocs.some((doc) => !doc.exists || !doc.updateTime))
    throw new Error('Family contact unavailable');
  const contacts = contactDocs.map((doc) => {
    if (!doc.updateTime) throw new Error('Family contact native revision unavailable');
    const row = decodeRecord<Records['contacts']>(doc.data());
    if (row.trust !== 'known') throw new Error('Family contact trust is unavailable');
    return {
      ...row,
      revision: ownerEditorSnapshotRevision({
        driver: 'firestore',
        ownerId,
        id: doc.id,
        updateTime: { seconds: doc.updateTime.seconds, nanoseconds: doc.updateTime.nanoseconds },
      }),
    };
  });
  const rawMemoryDatesLossless = ['validFrom', 'validUntil'].every((field) => {
    const value = memoryDoc.get(field);
    return value === null || (value instanceof Timestamp && value.nanoseconds === 0);
  });
  const evidence = evidenceRows;
  const rows = {
    ownerId,
    relation,
    source,
    assertion,
    evidence,
    sourceRelations: sourceRelations.map((doc) =>
      decodeRecord<Records['knowledgeGraphRelations']>(doc.data()),
    ),
    canonicalRelations: canonicalRelations.map((doc) =>
      decodeRecord<Records['knowledgeGraphRelations']>(doc.data()),
    ),
    sourcePrecisionLossless: rawMemoryDatesLossless,
    native: nativeRows(reader),
  };
  if (!eligibleOwnerFamilyCorrection(rows))
    throw new Error('Family claim is not eligible for exact rejection');
  const revision = ownerEditorSnapshotRevision({
    protocol: 'owner-family-source-rejection-closure-v2',
    installationLineageId: store.installationId,
    projectId: store.projectId ?? null,
    databaseId: store.databaseId,
    privacyGeneration,
    epoch: epochState,
    operationAuthority: {
      ownerId: authority.ownerId,
      epoch: authority.epoch,
      privacyGeneration: authority.privacyGeneration,
      command: authority.command,
      operationId: authority.operationId,
      targetId: authority.targetId,
      nonce: authority.nonce,
      issuedAt: authority.issuedAt,
      expiresAt: authority.expiresAt,
    },
    ownerCacheBarrier: cache,
    membership: reader.membership.sort((a, b) => a.query.localeCompare(b.query)),
    nativeRows: nativeRows(reader),
  });
  return {
    reader,
    owner,
    privacyGeneration,
    epochState,
    cache,
    relation,
    markerKey,
    existingMarker: null as Marker | null,
    rows: { ...rows, revision },
    entities,
    contacts,
    checkpointRef: checkpointDoc.ref,
    assertionRef: assertionDoc.ref,
    relationRef: relationDoc.ref,
    ownerCardRef: ownerCard.ref,
  };
}

/** Read-only server helper for a reviewed, operation-scoped exact closure. */
export async function readOwnerFamilyRejectionReview(input: {
  store: InstallationStore;
  ownerId: string;
  relationId: string;
  scope: OwnerEditorClaim['scope'];
}): Promise<{ revision: string } | null> {
  try {
    return await input.store.db.runTransaction(async (tx) => {
      const closure = await closureInTransaction(
        input.store,
        tx,
        input.ownerId,
        input.relationId,
        input.store.installationId,
        input.scope,
      );
      return closure.existingMarker || !closure.rows ? null : { revision: closure.rows.revision };
    });
  } catch {
    return null;
  }
}

/**
 * Inactive direct-import source contract. No HTTP/issuer/barrel is wired to this function.
 * The durable cursor must already exist in active protocol state; this never initializes it.
 */
export async function rejectOwnerFamilyClaimInFirestore(input: {
  store: InstallationStore;
  configuredOwnerId: string;
  claim: OwnerEditorClaim;
  request: OwnerEditorApply;
  now: Date;
}): Promise<OwnerEditorReply> {
  const { store, configuredOwnerId, claim } = input;
  if (!currentTime(store, input.now)) return ownerEditorUnknown(claim.scope);
  let request: InactiveOwnerFamilyRemovalRequest;
  try {
    request = parseInactiveOwnerFamilyRemovalRequest(input.request);
  } catch {
    return ownerEditorRejected(claim.scope, 'invalid_removal_request');
  }
  if (
    configuredOwnerId !== claim.scope.ownerId ||
    request.operationId !== claim.scope.operationId ||
    request.command !== claim.scope.command ||
    request.command !== 'remove_owner_family_relationship' ||
    claim.scope.targetId !== request.targetRelationId ||
    requestHash(request) !== claim.requestHash
  )
    return ownerEditorRejected(claim.scope, 'request_binding_mismatch');
  return store.db.runTransaction(async (tx) => {
    const reader = snapshotReader(tx);
    const now = currentTime(store, input.now);
    if (!now) return ownerEditorUnknown(claim.scope);
    const operationRef = store.doc('ownerEditorOperations', ownerEditorOperationId(claim.scope));
    const operationSnapshot = await point(reader, operationRef, false);
    if (!operationSnapshot.exists)
      return {
        version: 1,
        authority: 'unresolved',
        outcome: 'outcome_unknown',
        command: claim.scope.command,
        operationId: claim.scope.operationId,
        reason: 'receipt_missing',
      };
    const operation = parseInactiveOwnerFamilyRemovalOperationRecord(
      decodeRecord(operationSnapshot.data()),
    );
    if (
      operation.id !== ownerEditorOperationId(claim.scope) ||
      !ownerEditorRecordMatches(claim.scope, operation) ||
      operation.requestHash !== claim.requestHash ||
      operation.requestHash !== requestHash(request)
    )
      return ownerEditorRejected(claim.scope, 'request_binding_mismatch');
    const owners = await bounded(reader, store.collection('agents').limit(2), 1, 'owner');
    if (
      owners.length !== 1 ||
      owners[0]?.id !== documentKey(configuredOwnerId) ||
      owners[0]?.get('id') !== configuredOwnerId
    )
      return ownerEditorRejected(claim.scope, 'owner_unavailable');
    const [privacy, epoch, cacheSnapshot] = await Promise.all([
      point(reader, store.doc('privacyErasureJobs', configuredOwnerId)),
      point(reader, store.doc('maintenanceCursors', epochName(configuredOwnerId))),
      point(reader, store.doc('maintenanceCursors', cacheBarrierName(configuredOwnerId))),
    ]);
    if (!epoch?.exists || !epoch.updateTime || epoch.get('name') !== epochName(configuredOwnerId))
      return ownerEditorRejected(claim.scope, 'epoch_unavailable');
    let epochState: ReturnType<typeof parseOwnerEditorEpochCursor>;
    try {
      epochState = parseOwnerEditorEpochCursor(JSON.parse(String(epoch.get('cursor'))));
    } catch {
      return ownerEditorRejected(claim.scope, 'epoch_unavailable');
    }
    let generation: string | null;
    try {
      generation = privacy ? ownerEditorFirestorePrivacyToken(privacy, configuredOwnerId) : null;
    } catch {
      return ownerEditorRejected(claim.scope, 'privacy_or_epoch_unavailable');
    }
    if (
      (!generation && privacy?.exists) ||
      !epochState.ready ||
      epochState.ownerId !== configuredOwnerId ||
      epochState.epoch !== claim.scope.epoch ||
      epochState.privacyGenerationDigest !== ownerEditorPrivacyDigest(generation) ||
      generation !== claim.scope.privacyGeneration
    )
      return ownerEditorRejected(claim.scope, 'privacy_or_epoch_unavailable');
    let cache: ReturnType<typeof cursorData>;
    try {
      cache = cursorData(cacheSnapshot, store, configuredOwnerId);
    } catch {
      return ownerEditorRejected(claim.scope, 'source_rejection_protocol_unavailable');
    }
    if (now.getTime() >= claim.scope.issuedAt + 24 * 60 * 60 * 1000)
      return ownerEditorRetired(claim.scope);
    if (operation.status !== 'preparing') return ownerEditorReceipt(operation);
    if (
      operation.claimToken !== claim.claimToken ||
      operation.statusVersion !== claim.statusVersion ||
      !operation.claimExpiresAt ||
      operation.claimExpiresAt.getTime() <= now.getTime() ||
      claim.scope.expiresAt <= now.getTime()
    )
      return ownerEditorRejected(claim.scope, 'claim_changed');
    let closure: Awaited<ReturnType<typeof closureInTransaction>>;
    try {
      closure = await closureInTransaction(
        store,
        tx,
        configuredOwnerId,
        request.targetRelationId,
        store.installationId,
        claim.scope,
        reader,
      );
    } catch {
      return {
        version: 1,
        authority: 'unresolved',
        outcome: 'outcome_unknown',
        command: claim.scope.command,
        operationId: claim.scope.operationId,
        reason: 'receipt_unavailable',
      };
    }
    if (closure.existingMarker) {
      const rejected = closeRecord(
        operation,
        { outcome: 'conflict', reason: 'source_already_rejected' },
        now,
      );
      tx.update(store.doc('maintenanceCursors', epochName(configuredOwnerId)), {
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(operationRef, encodeRecord(rejected));
      return ownerEditorReceipt(rejected);
    }
    if (
      !closure.rows ||
      closure.rows.revision !== request.expectedTargetRevision ||
      closure.cache.revision !== cache.revision
    ) {
      const stale = closeRecord(
        operation,
        { outcome: 'conflict', reason: 'reviewed_closure_changed' },
        now,
      );
      tx.update(store.doc('maintenanceCursors', epochName(configuredOwnerId)), {
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(operationRef, encodeRecord(stale));
      return ownerEditorReceipt(stale);
    }
    const plan = planOwnerFamilyRemoval({
      request: {
        ownerId: configuredOwnerId,
        relationId: request.targetRelationId,
        expectedNativeScopeHash: request.expectedTargetRevision,
      },
      scope: closure.rows,
      entities: closure.entities,
      contacts: closure.contacts,
    });
    if (!plan) {
      const stale = closeRecord(
        operation,
        { outcome: 'conflict', reason: 'claim_no_longer_eligible' },
        now,
      );
      tx.update(store.doc('maintenanceCursors', epochName(configuredOwnerId)), {
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(operationRef, encodeRecord(stale));
      return ownerEditorReceipt(stale);
    }
    const contactForEntity = (id: string): string => {
      const contactId = closure.entities.find((candidate) => candidate.id === id)?.contactId;
      if (!contactId) throw new Error('Stable family contact mapping unavailable');
      return contactId;
    };
    // Normalize direction and symmetric ordering using stable contacts, not
    // the temporary graph entity IDs already verified by the pure planner.
    const canonicalMeaning = canonicalizeKnowledgeAssertionDirection({
      subjectEntityId: contactForEntity(closure.rows.relation.subjectEntityId),
      objectEntityId: contactForEntity(closure.rows.relation.objectEntityId),
      predicate: closure.rows.relation.predicate,
      assertion: closure.rows.relation.assertion,
      validFrom: closure.rows.relation.validFrom,
      validUntil: closure.rows.relation.validUntil,
      qualifiers: closure.rows.assertion.qualifiers,
    });
    const { tense, polarity, modality } = canonicalMeaning.assertion;
    if (polarity !== 'positive' || modality !== 'asserted' || tense === 'future')
      throw new Error('Family assertion is not an explicit positive claim');
    const meaning = {
      subjectContactId: canonicalMeaning.subjectEntityId,
      objectContactId: canonicalMeaning.objectEntityId,
      predicate: canonicalMeaning.predicate,
      assertion: { tense, polarity, modality },
      validFrom: canonicalMeaning.validFrom,
      validUntil: canonicalMeaning.validUntil,
      qualifiers: canonicalMeaning.qualifiers ?? {},
    };
    const meaningKey = contactMeaningKey(meaning);
    const marker = parseInactiveOwnerFamilyRejectionMarker({
      version: 2,
      id: closure.markerKey,
      installationLineageId: store.installationId,
      ownerId: configuredOwnerId,
      sourceMemoryId: plan.retained.sourceMemoryId,
      state: 'active',
      stableContactMeaningKey: meaningKey,
      meaning,
      original: {
        relationId: plan.target.relation.id,
        assertionId: plan.target.assertion.id,
        evidenceId: plan.target.evidence.id,
        subjectEntityId: closure.rows.relation.subjectEntityId,
        objectEntityId: closure.rows.relation.objectEntityId,
        sourceContentHash: plan.retained.sourceContentHash,
      },
      operationId: claim.scope.operationId,
      requestHash: claim.requestHash,
      reviewClosureHash: request.expectedTargetRevision,
      createdAt: now,
    });
    const markerBytes = Buffer.byteLength(stableJson(exactValue(marker)), 'utf8');
    if (markerBytes > 4096) throw new Error('Source rejection marker exceeds size limit');
    const result = {
      outcome: 'saved' as const,
      ids: {
        relationId: plan.target.relation.id,
        memoryId: plan.target.relation.sourceMemoryId,
        assertionId: plan.target.assertion.id,
      },
      revision: ownerEditorCommitRevision(claim, {
        relationId: plan.target.relation.id,
        memoryId: plan.target.relation.sourceMemoryId,
        assertionId: plan.target.assertion.id,
      }),
      refreshPending: true,
    };
    const terminal = closeRecord(operation, result, now);
    tx.create(store.doc('ownerFamilyClaimRejections', closure.markerKey), encodeRecord(marker));
    tx.update(closure.relationRef, { reviewStatus: 'rejected', reviewedAt: now });
    tx.update(closure.assertionRef, {
      lifecycle: 'retracted',
      semanticRevision: closure.rows.assertion.semanticRevision + 1,
      reviewStatus: 'unreviewed',
      reviewedRevision: null,
      reviewedPayloadHash: null,
      ownerAuthored: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      closure.ownerCardRef,
      encodeRecord({
        agentId: configuredOwnerId,
        content: '',
        compiledAt: now,
        invalidatedAt: now,
      }),
    );
    tx.update(closure.checkpointRef, { updatedAt: FieldValue.serverTimestamp() });
    tx.update(store.doc('maintenanceCursors', cacheBarrierName(configuredOwnerId)), {
      cursor: JSON.stringify({ ...closure.cache, revision: randomUUID() }),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(store.doc('maintenanceCursors', epochName(configuredOwnerId)), {
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(operationRef, encodeRecord(terminal));
    return ownerEditorReceipt(terminal);
  });
}
