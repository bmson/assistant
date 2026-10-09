import { randomUUID } from 'node:crypto';
import {
  boundGraphRelationToSource,
  canonicalizeKnowledgeAssertionDirection,
  type KnowledgeGraphProjectionEntity,
  type KnowledgeGraphProjectionRelation,
  type KnowledgeGraphSyncClaim,
  type KnowledgeGraphSyncRepository,
  type KnowledgeGraphSyncSource,
  knowledgeAssertionEvidenceId,
  knowledgeAssertionId,
  knowledgeAssertionSemanticKey,
  type Records,
} from '@assistant/persistence';
import type { DocumentSnapshot, Query, Transaction } from '@google-cloud/firestore';
import { decodeMemoryRecord } from './memory-record.js';
import { deterministicUuid } from './stable-id.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const PAGE_SIZE = 100;
const RELATION_BOUND = 25;
const ALIAS_BOUND = 100;

type Memory = Records['memories'];
type GraphSource = Records['knowledgeGraphSources'] & {
  agentId?: string;
  retrievalRevision?: string;
  claimToken?: string;
};
type GraphEntity = Records['knowledgeGraphEntities'];
type GraphAlias = Records['knowledgeGraphEntityAliases'];
type GraphRelation = Records['knowledgeGraphRelations'];
type GraphAssertion = Records['knowledgeGraphAssertions'];
type GraphAssertionEvidence = Records['knowledgeGraphAssertionEvidence'];

function identity(snapshot: DocumentSnapshot, id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && documentKey(id) === snapshot.id;
}

function due(value: unknown, now: Date): boolean {
  return value instanceof Date ? value <= now : value === null || value === undefined;
}

function sourceNeedsSync(
  source: GraphSource | null,
  memory: Memory,
  retrievalRevision: string,
  extractionVersion: number,
  staleBefore: Date,
  now: Date,
): boolean {
  if (!source) return true;
  return (
    source.contentHash !== memory.contentHash ||
    source.retrievalRevision !== retrievalRevision ||
    source.subjectContactId !== memory.subjectContactId ||
    source.extractionVersion < extractionVersion ||
    (source.status === 'failed' && due(source.nextRetryAt, now)) ||
    (source.status === 'pending' && source.updatedAt < staleBefore)
  );
}

function betterLabel(existing: string, incoming: string): string {
  if (existing === incoming) return existing;
  const existingCased = /\p{Lu}/u.test(existing);
  const incomingCased = /\p{Lu}/u.test(incoming);
  if (incomingCased !== existingCased) return incomingCased ? incoming : existing;
  return incoming.length > existing.length ? incoming : existing;
}

function ownedMemory(
  snapshot: DocumentSnapshot,
  source: KnowledgeGraphSyncSource,
  now: Date,
): Memory | null {
  if (!snapshot.exists) return null;
  const memory = decodeMemoryRecord(snapshot.data());
  if (
    !identity(snapshot, memory.id) ||
    memory.id !== source.id ||
    memory.agentId !== source.agentId ||
    memory.content !== source.content ||
    memory.contentHash !== source.contentHash ||
    snapshot.get('retrievalRevision') !== source.retrievalRevision ||
    memory.subjectContactId !== source.subjectContactId ||
    (source.validFrom !== undefined &&
      (memory.validFrom?.getTime() ?? null) !== (source.validFrom?.getTime() ?? null)) ||
    (source.validUntil !== undefined &&
      (memory.validUntil?.getTime() ?? null) !== (source.validUntil?.getTime() ?? null)) ||
    memory.category !== 'knowledge' ||
    memory.quarantined ||
    (memory.expiresAt && memory.expiresAt <= now)
  )
    return null;
  return memory;
}

async function readFence(
  tx: Transaction,
  store: InstallationStore,
  source: KnowledgeGraphSyncSource,
  now: Date,
) {
  const memoryRef = store.doc('memories', source.id);
  const sourceRef = store.doc('knowledgeGraphSources', source.id);
  const intentRef = store.doc('graphDeletionIntents', source.id);
  const hashRef = store.doc('memoryContentHashes', source.contentHash);
  const tombstoneRef = store.doc('memoryTombstones', source.contentHash);
  const erasureRef = store.doc('privacyErasureJobs', source.agentId);
  const [memoryDoc, sourceDoc, intentDoc, hashDoc, tombstoneDoc, erasureDoc] = await tx.getAll(
    memoryRef,
    sourceRef,
    intentRef,
    hashRef,
    tombstoneRef,
    erasureRef,
  );
  const memory = memoryDoc ? ownedMemory(memoryDoc, source, now) : null;
  const live =
    Boolean(memory) &&
    !intentDoc?.exists &&
    !tombstoneDoc?.exists &&
    (!erasureDoc?.exists || erasureDoc.get('status') === 'complete') &&
    hashDoc?.exists === true &&
    hashDoc.get('memoryId') === source.id;
  const checkpoint = sourceDoc?.exists ? decodeRecord<GraphSource>(sourceDoc.data()) : null;
  return { live, memory, sourceDoc, sourceRef, checkpoint };
}

function currentClaim(
  checkpoint: GraphSource | null,
  source: KnowledgeGraphSyncSource,
  claim: KnowledgeGraphSyncClaim,
  extractionVersion: number,
): boolean {
  return Boolean(
    checkpoint &&
      checkpoint.memoryId === source.id &&
      checkpoint.agentId === source.agentId &&
      checkpoint.contentHash === source.contentHash &&
      checkpoint.retrievalRevision === source.retrievalRevision &&
      checkpoint.extractionVersion === extractionVersion &&
      checkpoint.status === 'pending' &&
      checkpoint.claimToken === claim.token,
  );
}

async function bounded(tx: Transaction, query: Query, limit: number, message: string) {
  const rows = await tx.get(query.limit(limit + 1));
  if (rows.size > limit) throw new Error(message);
  return rows.docs;
}

/** Firestore projection writer with source-version and deletion fencing. */
export class FirestoreKnowledgeGraphSyncRepository implements KnowledgeGraphSyncRepository {
  readonly kind = 'knowledge-graph-sync-repository' as const;

  constructor(readonly store: InstallationStore) {}

  now(): Date {
    return this.store.now();
  }

  async hydrateContactLabels(agentId?: string): Promise<void> {
    const contacts = await this.store.collection('contacts').get();
    const names = new Map(
      contacts.docs.flatMap((doc) => {
        const row = decodeRecord<Records['contacts']>(doc.data());
        return identity(doc, row.id) ? [[row.id, row.name] as const] : [];
      }),
    );
    const entities = await this.store.collection('knowledgeGraphEntities').get();
    let batch = this.store.db.batch();
    let writes = 0;
    for (const doc of entities.docs) {
      const row = decodeRecord<GraphEntity>(doc.data());
      const name = row.contactId ? names.get(row.contactId) : undefined;
      if (
        !identity(doc, row.id) ||
        (agentId && row.agentId !== agentId) ||
        !name ||
        row.label === name
      )
        continue;
      batch.update(doc.ref, { label: name, updatedAt: this.store.now() });
      writes += 1;
      if (writes === 450) {
        await batch.commit();
        batch = this.store.db.batch();
        writes = 0;
      }
    }
    if (writes > 0) await batch.commit();
  }

  async candidates(input: {
    agentId?: string;
    limit: number;
    extractionVersion: number;
    leaseMs: number;
    now: Date;
  }): Promise<KnowledgeGraphSyncSource[]> {
    const found: KnowledgeGraphSyncSource[] = [];
    let cursor: DocumentSnapshot | undefined;
    for (;;) {
      let query = this.store.collection('memories').orderBy('createdAt').limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      cursor = page.docs.at(-1);
      const eligible = page.docs.flatMap((doc) => {
        const memory = decodeMemoryRecord(doc.data());
        const retrievalRevision = doc.get('retrievalRevision');
        if (
          !identity(doc, memory.id) ||
          (input.agentId && memory.agentId !== input.agentId) ||
          memory.category !== 'knowledge' ||
          memory.quarantined ||
          (memory.expiresAt && memory.expiresAt <= input.now) ||
          typeof retrievalRevision !== 'string' ||
          !retrievalRevision
        )
          return [];
        return [{ doc, memory, retrievalRevision }];
      });
      for (let offset = 0; offset < eligible.length; offset += PAGE_SIZE) {
        const chunk = eligible.slice(offset, offset + PAGE_SIZE);
        const refs = chunk.flatMap(({ memory }) => [
          this.store.doc('knowledgeGraphSources', memory.id),
          this.store.doc('graphDeletionIntents', memory.id),
          this.store.doc('memoryContentHashes', memory.contentHash),
          this.store.doc('memoryTombstones', memory.contentHash),
        ]);
        const snapshots = await this.store.db.getAll(...refs);
        for (let index = 0; index < chunk.length; index += 1) {
          const candidate = chunk[index];
          if (!candidate) continue;
          const [sourceDoc, intentDoc, hashDoc, tombstoneDoc] = snapshots.slice(
            index * 4,
            index * 4 + 4,
          );
          if (
            intentDoc?.exists ||
            tombstoneDoc?.exists ||
            !hashDoc?.exists ||
            hashDoc.get('memoryId') !== candidate.memory.id
          )
            continue;
          const checkpoint = sourceDoc?.exists ? decodeRecord<GraphSource>(sourceDoc.data()) : null;
          if (
            !sourceNeedsSync(
              checkpoint,
              candidate.memory,
              candidate.retrievalRevision,
              input.extractionVersion,
              new Date(input.now.getTime() - input.leaseMs),
              input.now,
            )
          )
            continue;
          found.push({
            id: candidate.memory.id,
            agentId: candidate.memory.agentId,
            content: candidate.memory.content,
            contentHash: candidate.memory.contentHash,
            retrievalRevision: candidate.retrievalRevision,
            confidence: candidate.memory.confidence,
            originTrust: candidate.memory.originTrust,
            ownerConfirmed: candidate.memory.ownerConfirmed,
            subjectContactId: candidate.memory.subjectContactId,
            createdAt: candidate.memory.createdAt,
            validFrom: candidate.memory.validFrom,
            validUntil: candidate.memory.validUntil,
          });
          if (found.length === input.limit) return found;
        }
      }
      if (page.size < PAGE_SIZE) break;
    }
    return found;
  }

  async context(agentId: string) {
    const [agent, contacts] = await Promise.all([
      this.store.doc('agents', agentId).get(),
      this.store.collection('contacts').get(),
    ]);
    if (!agent.exists || agent.get('id') !== agentId || documentKey(agentId) !== agent.id)
      throw new Error('Knowledge graph source agent is missing');
    return {
      agentId,
      timeZone: typeof agent.get('timezone') === 'string' ? agent.get('timezone') || 'UTC' : 'UTC',
      locale: typeof agent.get('locale') === 'string' ? agent.get('locale') || 'en' : 'en',
      contacts: contacts.docs.flatMap((doc) => {
        const row = decodeRecord<Records['contacts']>(doc.data());
        return identity(doc, row.id) ? [{ id: row.id, name: row.name, aliases: row.aliases }] : [];
      }),
    };
  }

  async claim(input: {
    source: KnowledgeGraphSyncSource;
    extractionVersion: number;
    leaseMs: number;
    now: Date;
  }): Promise<KnowledgeGraphSyncClaim | null> {
    const token = randomUUID();
    return this.store.db.runTransaction(async (tx) => {
      const fence = await readFence(tx, this.store, input.source, input.now);
      if (!fence.live) return null;
      const checkpoint = fence.checkpoint;
      if (
        checkpoint &&
        (checkpoint.memoryId !== input.source.id ||
          (checkpoint.agentId !== undefined && checkpoint.agentId !== input.source.agentId))
      )
        throw new Error('Graph source belongs to another memory or agent');
      const changed =
        !checkpoint ||
        checkpoint.contentHash !== input.source.contentHash ||
        checkpoint.retrievalRevision !== input.source.retrievalRevision ||
        checkpoint.subjectContactId !== input.source.subjectContactId ||
        checkpoint.extractionVersion < input.extractionVersion;
      const claimable =
        !checkpoint ||
        changed ||
        (checkpoint.status === 'failed' && due(checkpoint.nextRetryAt, input.now)) ||
        (checkpoint.status === 'pending' &&
          checkpoint.updatedAt < new Date(input.now.getTime() - input.leaseMs));
      if (!claimable) return null;
      const attempts = changed ? 1 : checkpoint.attempts + 1;
      const value = encodeRecord({
        memoryId: input.source.id,
        agentId: input.source.agentId,
        contentHash: input.source.contentHash,
        retrievalRevision: input.source.retrievalRevision,
        subjectContactId: input.source.subjectContactId,
        extractionVersion: input.extractionVersion,
        status: 'pending',
        attempts,
        lastError: null,
        nextRetryAt: null,
        claimToken: token,
        createdAt: checkpoint?.createdAt ?? input.now,
        updatedAt: input.now,
      });
      if (fence.sourceDoc?.exists) tx.set(fence.sourceRef, value);
      else tx.create(fence.sourceRef, value);
      return { token, attempts };
    });
  }

  async fail(input: {
    source: KnowledgeGraphSyncSource;
    claim: KnowledgeGraphSyncClaim;
    extractionVersion: number;
    status: 'failed' | 'quarantined';
    lastError: string;
    nextRetryAt: Date | null;
    now: Date;
  }): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const fence = await readFence(tx, this.store, input.source, input.now);
      if (
        !fence.live ||
        !currentClaim(fence.checkpoint, input.source, input.claim, input.extractionVersion)
      )
        return false;
      tx.update(fence.sourceRef, {
        status: input.status,
        lastError: input.lastError,
        nextRetryAt: input.nextRetryAt,
        claimToken: null,
        updatedAt: input.now,
      });
      return true;
    });
  }

  async replaceProjection(input: {
    source: KnowledgeGraphSyncSource;
    claim: KnowledgeGraphSyncClaim;
    extractionVersion: number;
    relations: KnowledgeGraphProjectionRelation[];
    lastError?: string | null;
    now: Date;
  }): Promise<{ relationships: number; entities: number } | null> {
    if (input.relations.length > 5) throw new Error('Graph projection relation bound reached');
    return this.store.db.runTransaction(async (tx) => {
      const fence = await readFence(tx, this.store, input.source, input.now);
      if (
        !fence.live ||
        !fence.memory ||
        !currentClaim(fence.checkpoint, input.source, input.claim, input.extractionVersion)
      )
        return null;
      const relations = input.relations.flatMap((relation) => {
        const bounded = boundGraphRelationToSource(relation, fence.memory ?? input.source);
        return bounded ? [bounded] : [];
      });
      const prior = await bounded(
        tx,
        this.store
          .collection('knowledgeGraphRelations')
          .where('sourceMemoryId', '==', input.source.id),
        RELATION_BOUND,
        'Graph source relation bound reached',
      );
      if (prior.some((doc) => doc.get('agentId') !== input.source.agentId))
        throw new Error('Graph source relation belongs to another agent');

      const entityInputs = new Map<string, KnowledgeGraphProjectionEntity>();
      for (const relation of relations) {
        entityInputs.set(relation.subject.canonicalKey, relation.subject);
        entityInputs.set(relation.object.canonicalKey, relation.object);
      }
      const resolutionRows = await Promise.all(
        [...entityInputs.values()].map(async (entity) => {
          const [aliases, entities] = await Promise.all([
            bounded(
              tx,
              this.store
                .collection('knowledgeGraphEntityAliases')
                .where('agentId', '==', input.source.agentId)
                .where('canonicalKey', '==', entity.canonicalKey),
              1,
              'Duplicate graph entity alias',
            ),
            bounded(
              tx,
              this.store
                .collection('knowledgeGraphEntities')
                .where('agentId', '==', input.source.agentId)
                .where('canonicalKey', '==', entity.canonicalKey),
              1,
              'Duplicate graph entity identity',
            ),
          ]);
          return { entity, alias: aliases[0], direct: entities[0] };
        }),
      );
      const aliasEntityRefs = resolutionRows.flatMap(({ alias }) => {
        const entityId = alias?.get('entityId');
        return typeof entityId === 'string'
          ? [this.store.doc('knowledgeGraphEntities', entityId)]
          : [];
      });
      const contactRefs = [
        ...new Map(
          resolutionRows.flatMap(({ entity }) =>
            entity.contactId
              ? [[entity.contactId, this.store.doc('contacts', entity.contactId)] as const]
              : [],
          ),
        ).values(),
      ];
      const deterministicRefs = resolutionRows.flatMap(({ entity, alias, direct }) =>
        !alias && !direct
          ? [
              this.store.doc(
                'knowledgeGraphEntities',
                deterministicUuid(
                  'knowledge-graph-entity',
                  input.source.agentId,
                  entity.canonicalKey,
                ),
              ),
            ]
          : [],
      );
      const [aliasEntities, deterministicEntities, contactDocs] = await Promise.all([
        aliasEntityRefs.length > 0 ? tx.getAll(...aliasEntityRefs) : Promise.resolve([]),
        deterministicRefs.length > 0 ? tx.getAll(...deterministicRefs) : Promise.resolve([]),
        contactRefs.length > 0 ? tx.getAll(...contactRefs) : Promise.resolve([]),
      ]);
      const aliasEntityByPath = new Map(aliasEntities.map((doc) => [doc.ref.path, doc]));
      const deterministicEntityByPath = new Map(
        deterministicEntities.map((doc) => [doc.ref.path, doc]),
      );
      const contactsByPath = new Map(contactDocs.map((doc) => [doc.ref.path, doc]));
      const resolved = new Map<
        string,
        { id: string; ref: FirebaseFirestore.DocumentReference; existing?: GraphEntity }
      >();
      for (const { entity, alias, direct } of resolutionRows) {
        if (entity.contactId) {
          const contact = contactsByPath.get(this.store.doc('contacts', entity.contactId).path);
          if (!contact?.exists || contact.get('id') !== entity.contactId)
            throw new Error('Graph projection contact is missing');
        }
        let snapshot: DocumentSnapshot | undefined = direct;
        if (alias) {
          const row = decodeRecord<GraphAlias>(alias.data());
          if (row.agentId !== input.source.agentId || row.canonicalKey !== entity.canonicalKey)
            throw new Error('Graph alias identity mismatch');
          snapshot = aliasEntityByPath.get(
            this.store.doc('knowledgeGraphEntities', row.entityId).path,
          );
          if (!snapshot?.exists) throw new Error('Graph alias target is missing');
        } else if (!snapshot) {
          const id = deterministicUuid(
            'knowledge-graph-entity',
            input.source.agentId,
            entity.canonicalKey,
          );
          const candidate = deterministicEntityByPath.get(
            this.store.doc('knowledgeGraphEntities', id).path,
          );
          if (candidate?.exists) snapshot = candidate;
        }
        if (snapshot?.exists) {
          const row = decodeRecord<GraphEntity>(snapshot.data());
          if (
            !identity(snapshot, row.id) ||
            row.agentId !== input.source.agentId ||
            (!alias && row.canonicalKey !== entity.canonicalKey)
          )
            throw new Error('Graph entity belongs to another agent');
          resolved.set(entity.canonicalKey, { id: row.id, ref: snapshot.ref, existing: row });
        } else {
          const id = deterministicUuid(
            'knowledge-graph-entity',
            input.source.agentId,
            entity.canonicalKey,
          );
          resolved.set(entity.canonicalKey, {
            id,
            ref: this.store.doc('knowledgeGraphEntities', id),
          });
        }
      }

      const assertionPlans = relations.map((relation) => {
        const subject = resolved.get(relation.subject.canonicalKey);
        const object = resolved.get(relation.object.canonicalKey);
        if (!subject || !object) throw new Error('Graph assertion endpoint resolution failed');
        const meaning = canonicalizeKnowledgeAssertionDirection({
          subjectEntityId: subject.id,
          predicate: relation.predicate,
          objectEntityId: object.id,
          assertion: relation.assertion,
          validFrom: relation.validFrom,
          validUntil: relation.validUntil,
        });
        const semanticKey = knowledgeAssertionSemanticKey(input.source.agentId, meaning);
        const id = knowledgeAssertionId(input.source.agentId, semanticKey);
        const evidenceId = knowledgeAssertionEvidenceId(
          input.source.agentId,
          id,
          input.source.id,
          relation.sourceFingerprint,
        );
        return { relation, meaning, semanticKey, id, evidenceId };
      });
      const priorAssertionIds = [
        ...new Set(
          prior.flatMap((doc) => {
            const id = doc.get('assertionId');
            return typeof id === 'string' ? [id] : [];
          }),
        ),
      ];
      const assertionIds = [
        ...new Set([...priorAssertionIds, ...assertionPlans.map((plan) => plan.id)]),
      ];
      const [assertionDocs, priorEvidence, sourceEvidence] = await Promise.all([
        assertionIds.length > 0
          ? tx.getAll(...assertionIds.map((id) => this.store.doc('knowledgeGraphAssertions', id)))
          : Promise.resolve([]),
        Promise.all(
          priorAssertionIds.map((id) =>
            bounded(
              tx,
              this.store
                .collection('knowledgeGraphAssertionEvidence')
                .where('assertionId', '==', id),
              RELATION_BOUND * 4,
              'Graph assertion evidence bound reached',
            ),
          ),
        ),
        bounded(
          tx,
          this.store
            .collection('knowledgeGraphAssertionEvidence')
            .where('sourceMemoryId', '==', input.source.id),
          RELATION_BOUND,
          'Graph source assertion evidence bound reached',
        ),
      ]);
      const assertionById = new Map(assertionDocs.map((doc) => [doc.id, doc] as const));
      const priorEvidenceByAssertion = new Map(
        priorAssertionIds.map((id, index) => [id, priorEvidence[index] ?? []] as const),
      );
      for (const doc of assertionDocs) {
        if (doc.exists && doc.get('agentId') !== input.source.agentId)
          throw new Error('Graph assertion belongs to another agent');
      }
      for (const doc of sourceEvidence) {
        if (doc.get('agentId') !== input.source.agentId)
          throw new Error('Graph assertion evidence belongs to another agent');
      }

      for (const [canonicalKey, entity] of entityInputs) {
        const target = resolved.get(canonicalKey);
        if (!target) throw new Error('Graph entity resolution failed');
        // An alias may point to an entity that the owner retyped or merged.
        // Re-extraction must keep that curated identity and its current kind.
        if (target.existing && target.existing.canonicalKey !== entity.canonicalKey) continue;
        const label =
          !entity.authoritativeLabel && target.existing
            ? betterLabel(target.existing.label, entity.label)
            : entity.label;
        const value = encodeRecord({
          id: target.id,
          createdAt: target.existing?.createdAt ?? input.now,
          updatedAt: input.now,
          agentId: input.source.agentId,
          kind: entity.kind,
          canonicalKey: target.existing?.canonicalKey ?? entity.canonicalKey,
          label,
          preferredLabel: target.existing?.preferredLabel ?? null,
          contactId: entity.contactId,
        } satisfies GraphEntity);
        if (target.existing) tx.set(target.ref, value);
        else tx.create(target.ref, value);
      }

      const priorByFingerprint = new Map(
        prior.map((doc) => [String(doc.get('sourceFingerprint')), doc] as const),
      );
      const saved = new Set<string>();
      const activeAssertionIds = new Set(assertionPlans.map((plan) => plan.id));
      const activeEvidenceIds = new Set(assertionPlans.map((plan) => plan.evidenceId));
      const reviewStatusByAssertionId = new Map(
        assertionPlans.map((plan) => {
          const doc = assertionById.get(plan.id);
          const legacyStatus = priorByFingerprint
            .get(plan.relation.sourceFingerprint)
            ?.get('reviewStatus');
          return [
            plan.id,
            doc?.exists
              ? decodeRecord<GraphAssertion>(doc.data()).reviewStatus
              : legacyStatus === 'confirmed' || legacyStatus === 'rejected'
                ? legacyStatus
                : 'unreviewed',
          ] as const;
        }),
      );
      for (const plan of assertionPlans) {
        const assertionDoc = assertionById.get(plan.id);
        const existingAssertion = assertionDoc?.exists
          ? decodeRecord<GraphAssertion>(assertionDoc.data())
          : null;
        const evidenceSnapshot = sourceEvidence.find((doc) => doc.id === plan.evidenceId);
        const priorEvidenceRow = evidenceSnapshot?.exists
          ? decodeRecord<GraphAssertionEvidence>(evidenceSnapshot.data())
          : null;
        const assertionValue: GraphAssertion = {
          id: plan.id,
          agentId: input.source.agentId,
          semanticKey: plan.semanticKey,
          subjectEntityId: plan.meaning.subjectEntityId,
          predicate: plan.meaning.predicate,
          objectEntityId: plan.meaning.objectEntityId,
          assertion: plan.meaning.assertion,
          qualifiers: ('qualifiers' in plan.meaning
            ? (plan.meaning.qualifiers ?? {})
            : {}) as Record<string, string | number | boolean | null>,
          validFrom: plan.meaning.validFrom,
          validUntil: plan.meaning.validUntil,
          semanticRevision: existingAssertion?.semanticRevision ?? 1,
          evidenceRevision: (existingAssertion?.evidenceRevision ?? 0) + (priorEvidenceRow ? 0 : 1),
          lifecycle: 'current',
          reviewStatus:
            existingAssertion?.reviewStatus ??
            reviewStatusByAssertionId.get(plan.id) ??
            'unreviewed',
          reviewedRevision: existingAssertion?.reviewedRevision ?? null,
          reviewedPayloadHash: existingAssertion?.reviewedPayloadHash ?? null,
          ownerAuthored: existingAssertion?.ownerAuthored ?? false,
          supersededById: existingAssertion?.supersededById ?? null,
          createdAt: existingAssertion?.createdAt ?? input.now,
          updatedAt: input.now,
        };
        const assertionRef =
          assertionDoc?.ref ?? this.store.doc('knowledgeGraphAssertions', plan.id);
        // Deterministic assertion IDs can already exist for another source or
        // a concurrent identical extraction. We read it above, reject foreign
        // ownership, preserve its curation, and use set so transaction retry
        // semantics handle a concurrent first insert without ALREADY_EXISTS.
        tx.set(assertionRef, encodeRecord(assertionValue));
        const evidenceValue: GraphAssertionEvidence = {
          id: plan.evidenceId,
          agentId: input.source.agentId,
          assertionId: plan.id,
          sourceMemoryId: input.source.id,
          sourceFingerprint: plan.relation.sourceFingerprint,
          sourceContentHash: input.source.contentHash,
          evidenceQuote: plan.relation.evidenceQuote,
          sourceAuthor:
            input.source.ownerConfirmed && input.source.originTrust === 'owner'
              ? 'owner'
              : input.source.originTrust === 'other'
                ? 'other'
                : 'unknown',
          sourceTrust: input.source.originTrust ?? 'unknown',
          independent: false,
          spanStart: plan.relation.evidenceSpanStart ?? null,
          spanEnd: plan.relation.evidenceSpanEnd ?? null,
          extractionVersion: input.extractionVersion,
          evidenceRevision: (priorEvidenceRow?.evidenceRevision ?? 0) + 1,
          observedAt: input.now,
          createdAt: priorEvidenceRow?.createdAt ?? input.now,
        };
        const evidenceRef =
          evidenceSnapshot?.ref ??
          this.store.doc('knowledgeGraphAssertionEvidence', plan.evidenceId);
        tx.set(evidenceRef, encodeRecord(evidenceValue));
      }
      for (const priorEvidenceDoc of sourceEvidence) {
        if (!activeEvidenceIds.has(priorEvidenceDoc.id)) tx.delete(priorEvidenceDoc.ref);
      }
      for (const oldAssertionId of priorAssertionIds) {
        if (activeAssertionIds.has(oldAssertionId)) continue;
        const remainingEvidence = (priorEvidenceByAssertion.get(oldAssertionId) ?? []).filter(
          (doc) =>
            !sourceEvidence.some(
              (sourceDoc) => sourceDoc.id === doc.id && !activeEvidenceIds.has(doc.id),
            ),
        );
        if (remainingEvidence.length === 0) {
          const doc = assertionById.get(oldAssertionId);
          if (doc?.exists) {
            const row = decodeRecord<GraphAssertion>(doc.data());
            if (!row.ownerAuthored)
              tx.update(doc.ref, {
                lifecycle: 'retracted',
                semanticRevision: row.semanticRevision + 1,
                updatedAt: input.now,
              });
          }
        }
      }
      for (const plan of assertionPlans) {
        const relation = plan.relation;
        const subject = resolved.get(relation.subject.canonicalKey);
        const object = resolved.get(relation.object.canonicalKey);
        if (!subject || !object) throw new Error('Graph relation endpoint resolution failed');
        const existing = priorByFingerprint.get(relation.sourceFingerprint);
        const priorRow = existing ? decodeRecord<GraphRelation>(existing.data()) : null;
        const id =
          priorRow?.id ??
          deterministicUuid(
            'knowledge-graph-relation',
            input.source.id,
            relation.sourceFingerprint,
          );
        const ref = existing?.ref ?? this.store.doc('knowledgeGraphRelations', id);
        const value = encodeRecord({
          id,
          createdAt: priorRow?.createdAt ?? input.now,
          agentId: input.source.agentId,
          sourceFingerprint: relation.sourceFingerprint,
          confidence: relation.confidence,
          validFrom: relation.validFrom,
          validUntil: relation.validUntil,
          subjectEntityId: subject.id,
          predicate: relation.predicate,
          assertion: relation.assertion,
          assertionId: plan.id,
          objectEntityId: object.id,
          sourceMemoryId: input.source.id,
          evidenceQuote: relation.evidenceQuote,
          ordinal: relation.ordinal,
          reviewStatus: reviewStatusByAssertionId.get(plan.id) ?? 'unreviewed',
          reviewedAt: priorRow?.reviewedAt ?? null,
          correctedByRelationId: priorRow?.correctedByRelationId ?? null,
          correctionSourceContentHash: priorRow?.correctionSourceContentHash ?? null,
          correctionDisposition: priorRow?.correctionDisposition ?? null,
        } satisfies GraphRelation);
        if (existing) tx.set(ref, value);
        else tx.create(ref, value);
        saved.add(relation.sourceFingerprint);
      }
      for (const stale of prior) {
        if (!saved.has(String(stale.get('sourceFingerprint')))) tx.delete(stale.ref);
      }
      tx.update(fence.sourceRef, {
        status: 'ready',
        lastError: input.lastError ?? null,
        nextRetryAt: null,
        claimToken: null,
        updatedAt: input.now,
      });
      return { relationships: relations.length, entities: entityInputs.size };
    });
  }

  async removeOrphanedEntities(agentId?: string): Promise<number> {
    const entities = await this.store.collection('knowledgeGraphEntities').get();
    let removed = 0;
    for (const entity of entities.docs) {
      if (agentId && entity.get('agentId') !== agentId) continue;
      const didRemove = await this.store.db.runTransaction(async (tx) => {
        const [current, subjects, objects, aliases] = await Promise.all([
          tx.get(entity.ref),
          tx.get(
            this.store
              .collection('knowledgeGraphRelations')
              .where('subjectEntityId', '==', entity.get('id'))
              .limit(1),
          ),
          tx.get(
            this.store
              .collection('knowledgeGraphRelations')
              .where('objectEntityId', '==', entity.get('id'))
              .limit(1),
          ),
          tx.get(
            this.store
              .collection('knowledgeGraphEntityAliases')
              .where('entityId', '==', entity.get('id'))
              .limit(ALIAS_BOUND + 1),
          ),
        ]);
        if (!current.exists || !subjects.empty || !objects.empty) return false;
        if (aliases.size > ALIAS_BOUND) throw new Error('Graph entity alias cleanup bound reached');
        const owner = current.get('agentId');
        if (
          (agentId && owner !== agentId) ||
          aliases.docs.some((alias) => alias.get('agentId') !== owner)
        )
          throw new Error('Graph orphan ownership mismatch');
        for (const alias of aliases.docs) tx.delete(alias.ref);
        tx.delete(current.ref);
        return true;
      });
      if (didRemove) removed += 1;
    }
    return removed;
  }

  async pendingCount(input: {
    agentId?: string;
    extractionVersion: number;
    leaseMs: number;
    now: Date;
  }): Promise<number> {
    return (await this.candidates({ ...input, limit: Number.MAX_SAFE_INTEGER })).length;
  }

  async taskSpendUsd(taskId: string): Promise<number> {
    const rows = await this.store.collection('modelCalls').get();
    return rows.docs.reduce(
      (total, doc) => total + (doc.get('taskId') === taskId ? Number(doc.get('costUsd') ?? 0) : 0),
      0,
    );
  }
}
