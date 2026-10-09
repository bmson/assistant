import { randomUUID } from 'node:crypto';
import {
  canonicalizeKnowledgeAssertionDirection,
  type EmbeddingSpace,
  knowledgeAssertionEvidenceId,
  knowledgeAssertionId,
  knowledgeAssertionSemanticKey,
  type OwnerGraphCorrectionTarget,
  type OwnerKnowledgeGraphEntityEndpoint,
  type OwnerKnowledgeGraphFactAtomicInput,
  type OwnerKnowledgeGraphFactContext,
  type OwnerKnowledgeGraphFactRepository,
  type OwnerKnowledgeGraphFactResult,
  type Records,
  snapshotEmbeddingSpace,
  validateEmbedding,
} from '@assistant/persistence';
import { type DocumentSnapshot, FieldValue, type Transaction } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { decodeMemoryRecord } from './memory-record.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { deterministicUuid } from './stable-id.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Contact = Records['contacts'];
type Entity = Records['knowledgeGraphEntities'];

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function namePrefixMatch(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 3 && (longer === shorter || longer.startsWith(`${shorter} `));
}

function betterLabel(existing: string, incoming: string): string {
  if (existing === incoming) return existing;
  const existingCased = /\p{Lu}/u.test(existing);
  const incomingCased = /\p{Lu}/u.test(incoming);
  if (existingCased !== incomingCased) return incomingCased ? incoming : existing;
  return incoming.length > existing.length ? incoming : existing;
}

function contactForLabel(contacts: Contact[], label: string): Contact | undefined {
  const key = normalized(label);
  if (!key) return undefined;
  const names = (contact: Contact) => [contact.name, ...contact.aliases];
  const exact = contacts.find((contact) => names(contact).some((name) => normalized(name) === key));
  if (exact) return exact;
  const prefixed = contacts.filter((contact) =>
    names(contact).some((name) => namePrefixMatch(key, normalized(name))),
  );
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

function identity<T extends { id: string }>(snapshot: DocumentSnapshot, row: T): boolean {
  return row.id.length > 0 && documentKey(row.id) === snapshot.id;
}

function entityDoc(snapshot: DocumentSnapshot, agentId: string): Entity | null {
  if (!snapshot.exists) return null;
  const row = decodeRecord<Entity>(snapshot.data());
  return identity(snapshot, row) && row.agentId === agentId ? row : null;
}

function deterministicEntityId(agentId: string, canonicalKey: string): string {
  return deterministicUuid('owner-knowledge-graph-entity', agentId, canonicalKey);
}

interface EntityWrite {
  id: string;
  row: Entity;
  snapshot: DocumentSnapshot | null;
  create: boolean;
}

/** Transactional writer for direct, owner-authored graph facts. */
export class FirestoreOwnerKnowledgeGraphFactRepository
  implements OwnerKnowledgeGraphFactRepository
{
  readonly kind = 'owner-knowledge-graph-fact-repository' as const;
  readonly embeddingSpace: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    embeddingSpace: EmbeddingSpace,
    readonly configuredAgentId: string,
  ) {
    this.embeddingSpace = snapshotEmbeddingSpace(embeddingSpace);
  }

  private async soleOwner(): Promise<OwnerKnowledgeGraphFactContext> {
    const owners = await this.store.collection('agents').limit(2).get();
    const owner = owners.docs[0];
    const agentId = owner?.get('id');
    if (
      owners.size !== 1 ||
      !owner ||
      typeof agentId !== 'string' ||
      !agentId ||
      documentKey(agentId) !== owner.id ||
      agentId !== this.configuredAgentId
    )
      throw new Error('Knowledge graph writes require exactly one configured owner');
    const agent = decodeRecord<Records['agents']>({
      id: agentId,
      ...owner.data(),
    });
    const contactSnapshot = await this.store.collection('contacts').get();
    const contacts = contactSnapshot.docs.flatMap((doc) => {
      const row = decodeRecord<Contact>(doc.data());
      return identity(doc, row) ? [row] : [];
    });
    return {
      agentId,
      timeZone: agent.timezone || 'UTC',
      locale: agent.locale || 'en',
      contacts: contacts.map(({ id, name, aliases }) => ({ id, name, aliases })),
    };
  }

  async context(agentId?: string): Promise<OwnerKnowledgeGraphFactContext> {
    const context = await this.soleOwner();
    if (agentId !== undefined && agentId !== context.agentId)
      throw new Error('Knowledge graph owner changed');
    return context;
  }

  async entity(
    agentId: string,
    entityId: string,
  ): Promise<OwnerKnowledgeGraphEntityEndpoint | null> {
    const context = await this.context(agentId);
    const snapshot = await this.store.doc('knowledgeGraphEntities', entityId).get();
    const row = entityDoc(snapshot, context.agentId);
    if (!row) return null;
    return {
      id: row.id,
      label: row.label,
      kind: row.kind as OwnerKnowledgeGraphEntityEndpoint['kind'],
      canonicalKey: row.canonicalKey,
      contactId: row.contactId,
      authoritativeLabel: Boolean(row.contactId) || row.kind === 'date',
    };
  }

  async correctionTarget(
    agentId: string,
    relationId: string,
  ): Promise<OwnerGraphCorrectionTarget | null> {
    const context = await this.context(agentId);
    const relationSnapshot = await this.store.doc('knowledgeGraphRelations', relationId).get();
    if (!relationSnapshot.exists) return null;
    const relation = decodeRecord<Records['knowledgeGraphRelations']>(relationSnapshot.data());
    if (
      !identity(relationSnapshot, relation) ||
      relation.agentId !== context.agentId ||
      relation.id !== relationId
    )
      return null;
    const memorySnapshot = await this.store.doc('memories', relation.sourceMemoryId).get();
    if (!memorySnapshot.exists) return null;
    const memory = decodeMemoryRecord(memorySnapshot.data());
    if (
      !identity(memorySnapshot, memory) ||
      memory.agentId !== context.agentId ||
      memory.id !== relation.sourceMemoryId
    )
      return null;
    return {
      relationId,
      sourceMemoryId: memory.id,
      sourceContentHash: memory.contentHash,
      reviewStatus: relation.reviewStatus,
      source: memory.source,
      sourceOriginTrust: memory.originTrust,
      sourceOwnerConfirmed: memory.ownerConfirmed,
      sourceSupersededById: memory.supersededById,
      sourceExpiresAt: memory.expiresAt,
      correctedByRelationId: relation.correctedByRelationId ?? null,
      correctionSourceContentHash: relation.correctionSourceContentHash ?? null,
      correctionDisposition:
        relation.correctionDisposition === 'whole_fact' ||
        relation.correctionDisposition === 'graph_only'
          ? relation.correctionDisposition
          : null,
    };
  }

  private async configuredOwnerInTransaction(tx: Transaction): Promise<string> {
    const owners = await tx.get(this.store.collection('agents').limit(2));
    const owner = owners.docs[0];
    const id = owner?.get('id');
    if (
      owners.size !== 1 ||
      !owner ||
      typeof id !== 'string' ||
      documentKey(id) !== owner.id ||
      id !== this.configuredAgentId
    )
      throw new Error('Knowledge graph writes require exactly one configured owner');
    return id;
  }

  private async resolveForWrite(
    tx: Transaction,
    agentId: string,
    endpoint: OwnerKnowledgeGraphEntityEndpoint,
    now: Date,
  ): Promise<EntityWrite> {
    if (endpoint.id) {
      const snapshot = await tx.get(this.store.doc('knowledgeGraphEntities', endpoint.id));
      const row = entityDoc(snapshot, agentId);
      if (!row || row.canonicalKey !== endpoint.canonicalKey || row.kind !== endpoint.kind)
        throw new Error('Knowledge graph endpoint changed during save');
      return { id: row.id, row, snapshot, create: false };
    }

    const aliasQuery = this.store
      .collection('knowledgeGraphEntityAliases')
      .where('agentId', '==', agentId)
      .where('canonicalKey', '==', endpoint.canonicalKey)
      .limit(2);
    const entityQuery = this.store
      .collection('knowledgeGraphEntities')
      .where('agentId', '==', agentId)
      .where('canonicalKey', '==', endpoint.canonicalKey)
      .limit(2);
    const [aliases, entities] = await Promise.all([tx.get(aliasQuery), tx.get(entityQuery)]);
    if (aliases.size > 1 || entities.size > 1)
      throw new Error('Knowledge graph canonical identity is ambiguous');
    let existingSnapshot: DocumentSnapshot | null = entities.docs[0] ?? null;
    const alias = aliases.docs[0];
    let aliasTarget = false;
    if (alias) {
      const aliasRow = decodeRecord<Records['knowledgeGraphEntityAliases']>(alias.data());
      if (
        !identity(alias, aliasRow) ||
        aliasRow.agentId !== agentId ||
        aliasRow.canonicalKey !== endpoint.canonicalKey
      )
        throw new Error('Knowledge graph alias ownership mismatch');
      existingSnapshot = await tx.get(this.store.doc('knowledgeGraphEntities', aliasRow.entityId));
      aliasTarget = true;
    }
    if (existingSnapshot) {
      const existing = entityDoc(existingSnapshot, agentId);
      if (!existing) throw new Error('Knowledge graph alias target belongs to another owner');
      const label = aliasTarget
        ? existing.label
        : endpoint.authoritativeLabel
          ? endpoint.label
          : betterLabel(existing.label, endpoint.label);
      return {
        id: existing.id,
        row: {
          ...existing,
          label,
          kind: aliasTarget ? existing.kind : endpoint.kind,
          contactId: aliasTarget ? existing.contactId : endpoint.contactId,
          updatedAt: now,
        },
        snapshot: existingSnapshot,
        create: false,
      };
    }
    const id = deterministicEntityId(agentId, endpoint.canonicalKey);
    const ref = this.store.doc('knowledgeGraphEntities', id);
    const collision = await tx.get(ref);
    if (collision.exists) {
      const existing = entityDoc(collision, agentId);
      if (!existing || existing.canonicalKey !== endpoint.canonicalKey)
        throw new Error('Knowledge graph deterministic identity collision');
      return {
        id,
        row: { ...existing, updatedAt: now },
        snapshot: collision,
        create: false,
      };
    }
    return {
      id,
      row: {
        id,
        createdAt: now,
        updatedAt: now,
        agentId,
        kind: endpoint.kind,
        canonicalKey: endpoint.canonicalKey,
        label: endpoint.label,
        preferredLabel: null,
        contactId: endpoint.contactId,
      },
      snapshot: null,
      create: true,
    };
  }

  async createAtomic(
    input: OwnerKnowledgeGraphFactAtomicInput,
  ): Promise<OwnerKnowledgeGraphFactResult> {
    if (input.embeddingSpaceKey !== embeddingSpaceKey(this.embeddingSpace))
      throw new Error('Knowledge graph embedding space changed');
    validateEmbedding(this.embeddingSpace, input.embedding);
    const memoryId = randomUUID();
    const relationId = randomUUID();
    const retrievalRevision = randomUUID();
    const memoryRef = this.store.doc('memories', memoryId);
    const hashRef = this.store.doc('memoryContentHashes', input.contentHash);
    const tombstoneRef = this.store.doc('memoryTombstones', input.contentHash);
    const sourceRef = this.store.doc('knowledgeGraphSources', memoryId);
    const erasureRef = this.store.doc('privacyErasureJobs', input.agentId);
    const correctionRelationRef = input.correction
      ? this.store.doc('knowledgeGraphRelations', input.correction.target.relationId)
      : null;
    const correctionMemoryRef = input.correction
      ? this.store.doc('memories', input.correction.target.sourceMemoryId)
      : null;
    return this.store.db.runTransaction(async (tx) => {
      const ownerId = await this.configuredOwnerInTransaction(tx);
      if (ownerId !== input.agentId) throw new Error('Knowledge graph owner changed');
      const [memory, hash, tombstone, erasure] = await tx.getAll(
        memoryRef,
        hashRef,
        tombstoneRef,
        erasureRef,
      );
      let oldRelationSnapshot: DocumentSnapshot | null = null;
      let oldMemorySnapshot: DocumentSnapshot | null = null;
      let oldAssertionSnapshot: DocumentSnapshot | null = null;
      if (correctionRelationRef && correctionMemoryRef) {
        const correctionSnapshots = await tx.getAll(correctionRelationRef, correctionMemoryRef);
        oldRelationSnapshot = correctionSnapshots[0] ?? null;
        oldMemorySnapshot = correctionSnapshots[1] ?? null;
      }
      let oldRelation: Records['knowledgeGraphRelations'] | null = null;
      let oldMemory: Records['memories'] | null = null;
      if (oldRelationSnapshot?.exists && oldMemorySnapshot?.exists) {
        oldRelation = decodeRecord<Records['knowledgeGraphRelations']>(oldRelationSnapshot.data());
        oldMemory = decodeMemoryRecord(oldMemorySnapshot.data());
        if (
          !identity(oldRelationSnapshot, oldRelation) ||
          !identity(oldMemorySnapshot, oldMemory) ||
          oldRelation.agentId !== input.agentId ||
          oldMemory.agentId !== input.agentId ||
          oldRelation.sourceMemoryId !== oldMemory.id
        )
          return { error: 'That relationship or its source changed. Review it again.' };
        if (oldRelation.assertionId) {
          oldAssertionSnapshot = await tx.get(
            this.store.doc('knowledgeGraphAssertions', oldRelation.assertionId),
          );
          if (!oldAssertionSnapshot.exists || oldAssertionSnapshot.get('agentId') !== input.agentId)
            throw new Error('Canonical knowledge assertion is missing or belongs to another owner');
        }
        if (oldRelation.correctedByRelationId) {
          const replacementSnapshot = await tx.get(
            this.store.doc('knowledgeGraphRelations', oldRelation.correctedByRelationId),
          );
          if (!replacementSnapshot.exists)
            throw new Error('Knowledge graph correction receipt is incomplete');
          const replacement = decodeRecord<Records['knowledgeGraphRelations']>(
            replacementSnapshot.data(),
          );
          if (
            replacement.agentId !== input.agentId ||
            documentKey(replacement.id) !== replacementSnapshot.id
          )
            throw new Error('Knowledge graph correction receipt is invalid');
          return {
            relationId: replacement.id,
            memoryId: replacement.sourceMemoryId,
            sourceDisposition:
              oldRelation.correctionDisposition === 'whole_fact' ? 'whole_fact' : 'graph_only',
            alreadyApplied: true,
          };
        }
        const target = input.correction?.target;
        if (
          !target ||
          oldRelation.reviewStatus !== target.reviewStatus ||
          oldMemory.id !== target.sourceMemoryId ||
          oldMemory.contentHash !== target.sourceContentHash ||
          (oldMemory.supersededById ?? null) !== target.sourceSupersededById ||
          (oldMemory.expiresAt?.getTime() ?? null) !==
            (target.sourceExpiresAt?.getTime() ?? null) ||
          !['confirmed', 'unreviewed'].includes(oldRelation.reviewStatus)
        )
          return {
            error:
              'The source changed while this relationship was being corrected. Review it again.',
          };
        if (input.correction?.disposition === 'whole_fact') {
          if (
            oldMemory.source !== 'knowledge-graph-owner' ||
            oldMemory.originTrust !== 'owner' ||
            !oldMemory.ownerConfirmed ||
            oldMemory.supersededById ||
            oldMemory.expiresAt
          )
            return {
              error: 'This source is not a standalone owner fact; choose graph-only correction.',
            };
          const siblingRelations = await tx.get(
            this.store
              .collection('knowledgeGraphRelations')
              .where('sourceMemoryId', '==', oldMemory.id),
          );
          if (siblingRelations.docs.some((doc) => doc.id !== oldRelationSnapshot?.id))
            return {
              error: 'This source supports other relationships; choose graph-only correction.',
            };
        }
      } else if (input.correction) {
        return { error: 'That relationship or its source no longer exists.' };
      }
      if (erasure?.exists) {
        if (
          erasure.get('agentId') !== input.agentId ||
          privacyErasureIsActive(erasure.get('status'))
        )
          throw new Error('Privacy erasure is in progress');
      }
      if (tombstone?.exists)
        return { error: 'This fact was previously removed, so it was not added again.' };
      if (hash?.exists || memory?.exists)
        return { error: 'That source fact is already in the knowledge library.' };

      const contactIds = [
        ...new Set(
          [input.subjectContactId, input.subject.contactId, input.object.contactId].filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ];
      const contactSnapshots = await Promise.all(
        contactIds.map((id) => tx.get(this.store.doc('contacts', id))),
      );
      if (
        contactSnapshots.some(
          (snapshot, index) => !snapshot.exists || snapshot.get('id') !== contactIds[index],
        )
      )
        throw new Error('A knowledge graph contact no longer exists');
      if (input.subject.matchedContactLabel || input.object.matchedContactLabel) {
        const contactRows = await tx.get(this.store.collection('contacts'));
        const contacts = contactRows.docs.flatMap((doc) => {
          const row = decodeRecord<Contact>(doc.data());
          return identity(doc, row) ? [row] : [];
        });
        for (const endpoint of [input.subject, input.object]) {
          if (
            endpoint.matchedContactLabel &&
            contactForLabel(contacts, endpoint.matchedContactLabel)?.id !== endpoint.contactId
          )
            throw new Error('Knowledge graph contact changed during save');
        }
      }

      const now = this.store.now();
      const cache = new Map<string, Promise<EntityWrite>>();
      const resolve = (endpoint: OwnerKnowledgeGraphEntityEndpoint) => {
        const key = endpoint.id ?? endpoint.canonicalKey;
        let result = cache.get(key);
        if (!result) {
          result = this.resolveForWrite(tx, input.agentId, endpoint, now);
          cache.set(key, result);
        }
        return result;
      };
      const [subject, object] = await Promise.all([resolve(input.subject), resolve(input.object)]);
      const fingerprint = fingerprintFor(
        input.subject.canonicalKey,
        input.predicate,
        input.object.canonicalKey,
      );
      const ownerMeaning = canonicalizeKnowledgeAssertionDirection({
        subjectEntityId: subject.id,
        predicate: input.predicate,
        objectEntityId: object.id,
        assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
        validFrom: null,
        validUntil: null,
      });
      const semanticKey = knowledgeAssertionSemanticKey(input.agentId, ownerMeaning);
      const assertionId = knowledgeAssertionId(input.agentId, semanticKey);
      const assertionRef = this.store.doc('knowledgeGraphAssertions', assertionId);
      const assertionSnapshot = await tx.get(assertionRef);
      const existingAssertion = assertionSnapshot.exists
        ? decodeRecord<Records['knowledgeGraphAssertions']>(assertionSnapshot.data())
        : null;
      if (existingAssertion && existingAssertion.agentId !== input.agentId)
        throw new Error('Canonical knowledge assertion belongs to another owner');
      const evidenceId = knowledgeAssertionEvidenceId(
        input.agentId,
        assertionId,
        memoryId,
        fingerprint,
      );
      const evidenceRef = this.store.doc('knowledgeGraphAssertionEvidence', evidenceId);
      const existingEvidenceSnapshot = await tx.get(evidenceRef);
      const existingEvidence = existingEvidenceSnapshot.exists
        ? decodeRecord<Records['knowledgeGraphAssertionEvidence']>(existingEvidenceSnapshot.data())
        : null;
      const relationRef = this.store.doc('knowledgeGraphRelations', relationId);
      const memoryRow: Records['memories'] = {
        id: memoryId,
        createdAt: input.createdAt,
        agentId: input.agentId,
        expiresAt: null,
        embedding: input.embedding,
        embeddingSpaceKey: input.embeddingSpaceKey,
        sourceTaskId: null,
        kind: 'fact',
        confidence: '1.00',
        contentHash: input.contentHash,
        goalId: null,
        originTrust: 'owner',
        category: 'knowledge',
        content: input.content,
        importance: 3,
        quarantined: false,
        subjectContactId: input.subjectContactId,
        domain: 'other',
        validFrom: null,
        validUntil: null,
        supersededById: null,
        ownerConfirmed: true,
        pinned: false,
        source: 'knowledge-graph-owner',
        lastAccessedAt: null,
        lastConsolidatedAt: null,
      };
      const sourceRow = {
        memoryId,
        agentId: input.agentId,
        contentHash: input.contentHash,
        subjectContactId: input.subjectContactId,
        extractionVersion: input.extractionVersion,
        status: 'ready',
        attempts: 0,
        lastError: null,
        nextRetryAt: null,
        retrievalRevision,
        createdAt: now,
        updatedAt: now,
      };
      const relationRow: Records['knowledgeGraphRelations'] = {
        id: relationId,
        createdAt: now,
        agentId: input.agentId,
        sourceFingerprint: fingerprint,
        confidence: '1.00',
        validFrom: null,
        validUntil: null,
        subjectEntityId: subject.id,
        predicate: input.predicate,
        assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
        assertionId,
        objectEntityId: object.id,
        sourceMemoryId: memoryId,
        evidenceQuote: input.content,
        ordinal: 1,
        reviewStatus: 'confirmed',
        reviewedAt: now,
        correctedByRelationId: null,
        correctionSourceContentHash: null,
        correctionDisposition: null,
      };
      if (hash?.exists || tombstone?.exists || memory?.exists)
        throw new Error('Knowledge graph write fence changed');
      for (const entity of new Set([subject, object])) {
        if (entity.snapshot) {
          if (
            entity.snapshot.get('label') !== entity.row.label ||
            entity.snapshot.get('kind') !== entity.row.kind ||
            entity.snapshot.get('contactId') !== entity.row.contactId
          )
            tx.update(entity.snapshot.ref, {
              label: entity.row.label,
              kind: entity.row.kind,
              contactId: entity.row.contactId,
              updatedAt: now,
            });
        } else if (entity.create) {
          tx.create(this.store.doc('knowledgeGraphEntities', entity.id), encodeRecord(entity.row));
        }
      }
      tx.create(
        memoryRef,
        encodeRecord({
          ...memoryRow,
          embedding: FieldValue.vector(input.embedding),
          embeddingSpaceKey: input.embeddingSpaceKey,
          embeddingSpace: embeddingSpaceKey(this.embeddingSpace),
          retrievalRevision,
        }),
      );
      tx.create(hashRef, { memoryId });
      tx.create(sourceRef, encodeRecord(sourceRow));
      const assertionRow: Records['knowledgeGraphAssertions'] = {
        id: assertionId,
        agentId: input.agentId,
        semanticKey,
        subjectEntityId: ownerMeaning.subjectEntityId,
        predicate: ownerMeaning.predicate,
        objectEntityId: ownerMeaning.objectEntityId,
        assertion: ownerMeaning.assertion,
        qualifiers: ('qualifiers' in ownerMeaning ? ownerMeaning.qualifiers : {}) as Record<
          string,
          string | number | boolean | null
        >,
        validFrom: ownerMeaning.validFrom,
        validUntil: ownerMeaning.validUntil,
        semanticRevision: existingAssertion?.semanticRevision ?? 1,
        evidenceRevision: (existingAssertion?.evidenceRevision ?? 0) + (existingEvidence ? 0 : 1),
        lifecycle: 'current',
        reviewStatus: existingAssertion?.reviewStatus ?? 'confirmed',
        reviewedRevision: existingAssertion?.reviewedRevision ?? 1,
        reviewedPayloadHash: existingAssertion?.reviewedPayloadHash ?? semanticKey,
        ownerAuthored: true,
        supersededById: existingAssertion?.supersededById ?? null,
        createdAt: existingAssertion?.createdAt ?? now,
        updatedAt: now,
      };
      const assertionData = encodeRecord(assertionRow);
      if (assertionSnapshot.exists) tx.set(assertionRef, assertionData);
      else tx.create(assertionRef, assertionData);
      const evidenceRow: Records['knowledgeGraphAssertionEvidence'] = {
        id: evidenceId,
        agentId: input.agentId,
        assertionId,
        sourceMemoryId: memoryId,
        sourceFingerprint: fingerprint,
        sourceContentHash: input.contentHash,
        evidenceQuote: input.content,
        sourceAuthor: 'owner',
        sourceTrust: 'owner',
        independent: false,
        spanStart: 0,
        spanEnd: input.content.length,
        extractionVersion: input.extractionVersion,
        evidenceRevision: (existingEvidence?.evidenceRevision ?? 0) + 1,
        observedAt: now,
        createdAt: existingEvidence?.createdAt ?? now,
      };
      tx.set(evidenceRef, encodeRecord(evidenceRow));
      tx.create(relationRef, encodeRecord(relationRow));
      if (input.correction && oldRelationSnapshot && oldMemorySnapshot) {
        tx.update(oldRelationSnapshot.ref, {
          reviewStatus: 'rejected',
          reviewedAt: now,
          correctedByRelationId: relationId,
          correctionSourceContentHash: input.correction.target.sourceContentHash,
          correctionDisposition: input.correction.disposition,
        });
        if (oldAssertionSnapshot?.exists) {
          const oldAssertion = decodeRecord<Records['knowledgeGraphAssertions']>(
            oldAssertionSnapshot.data(),
          );
          tx.update(oldAssertionSnapshot.ref, {
            reviewStatus: 'rejected',
            reviewedRevision: oldAssertion.semanticRevision,
            reviewedPayloadHash: oldAssertion.semanticKey,
            updatedAt: now,
          });
        }
        if (input.correction.disposition === 'whole_fact') {
          tx.update(oldMemorySnapshot.ref, {
            supersededById: memoryId,
            expiresAt: now,
          });
        }
      }
      return {
        memoryId,
        relationId,
        ...(input.correction ? { sourceDisposition: input.correction.disposition } : {}),
      };
    });
  }
}

function fingerprintFor(subjectKey: string, predicate: string, objectKey: string): string {
  return `${subjectKey}|${predicate}|${objectKey}`;
}
