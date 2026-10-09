import { createHash, randomUUID } from 'node:crypto';
import {
  CONSOLIDATION_CANDIDATE_LIMIT,
  CONSOLIDATION_WINDOW_LIMIT,
  type ConsolidationFact,
  type ConsolidationReview,
  canRewriteConsolidationFacts,
  type EmbeddingSpace,
  earliestConsolidationSource,
  type ImportUnitProvenance,
  type MemoryConsolidationRepository,
  type Records,
  snapshotEmbeddingSpace,
  validateEmbedding,
} from '@assistant/persistence';
import {
  type DocumentSnapshot,
  FieldValue,
  Filter,
  type Query,
  type QueryDocumentSnapshot,
} from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { decodeMemoryRecord } from './memory-record.js';
import { occasionDateKey, resolveOccasionIdentity } from './occasion-identity.js';
import {
  assertPrivacyErasureFenceUnchanged,
  privacyErasureIsActive,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Memory = Records['memories'];

function version(doc: QueryDocumentSnapshot): string {
  const time = doc.updateTime;
  if (!time) throw new Error('Memory has no version');
  return `${time.seconds}:${time.nanoseconds}`;
}

function importLineageId(source: string, memoryId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([source, memoryId]))
    .digest('hex');
}

function occasionImportLineageId(source: string, occasionId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([source, occasionId]))
    .digest('hex');
}

function importSourceKeyId(agentId: string, source: string): string {
  return createHash('sha256').update(`${agentId}\0${source}`).digest('hex');
}

function readImportUnitProvenance(value: unknown): ImportUnitProvenance[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Memory import provenance is malformed');
  return value.map((unit) => {
    if (
      !unit ||
      typeof unit !== 'object' ||
      !Number.isSafeInteger(unit.sourceOffset) ||
      unit.sourceOffset < 0 ||
      !Number.isSafeInteger(unit.unitOffset) ||
      unit.unitOffset < 0 ||
      (unit.observedAt !== null && typeof unit.observedAt !== 'string') ||
      (unit.authorEmail !== null && typeof unit.authorEmail !== 'string') ||
      typeof unit.header !== 'string' ||
      typeof unit.hasQuotedContent !== 'boolean' ||
      typeof unit.unitTextHash !== 'string'
    )
      throw new Error('Memory import provenance is malformed');
    return {
      sourceOffset: unit.sourceOffset,
      unitOffset: unit.unitOffset,
      observedAt: unit.observedAt,
      authorEmail: unit.authorEmail,
      header: unit.header,
      hasQuotedContent: unit.hasQuotedContent,
      unitTextHash: unit.unitTextHash,
    };
  });
}

function mergeImportUnitProvenance(...groups: ImportUnitProvenance[][]): ImportUnitProvenance[] {
  const byIdentity = new Map<string, ImportUnitProvenance>();
  for (const unit of groups.flat()) {
    const key = `${unit.sourceOffset}\0${unit.unitOffset}\0${unit.unitTextHash}`;
    byIdentity.set(key, unit);
  }
  return [...byIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, unit]) => unit);
}

function active(row: Memory, agentId: string, now: Date): boolean {
  return (
    row.agentId === agentId &&
    row.category === 'knowledge' &&
    !row.quarantined &&
    !row.supersededById &&
    (!row.expiresAt || row.expiresAt > now)
  );
}

function fact(doc: QueryDocumentSnapshot, agentId: string, now: Date): ConsolidationFact | null {
  const row = decodeMemoryRecord(doc.data());
  if (row.id !== doc.get('id') || documentKey(row.id) !== doc.id || !active(row, agentId, now))
    return null;
  return {
    id: row.id,
    agentId: row.agentId,
    subjectContactId: row.subjectContactId,
    content: row.content,
    kind: row.kind,
    confidence: row.confidence,
    importance: row.importance,
    domain: row.domain,
    ownerConfirmed: row.ownerConfirmed,
    pinned: row.pinned,
    lastConsolidatedAt: row.lastConsolidatedAt,
    createdAt: row.createdAt,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    version: version(doc),
  };
}

function eligibleQuery(store: InstallationStore, agentId: string): Query {
  const now = store.now();
  return store
    .collection('memories')
    .where('agentId', '==', agentId)
    .where('category', '==', 'knowledge')
    .where('quarantined', '==', false)
    .where('supersededById', '==', null)
    .where(Filter.or(Filter.where('expiresAt', '==', null), Filter.where('expiresAt', '>', now)));
}

function reviewOrder(a: ConsolidationFact, b: ConsolidationFact): number {
  return (
    (a.lastConsolidatedAt?.getTime() ?? -Infinity) -
      (b.lastConsolidatedAt?.getTime() ?? -Infinity) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}

/** Deterministic key retained for identifying records created by older releases. */
export function occasionDocumentId(
  agentId: string,
  contactId: string,
  occasion: { kind: string; month: number; day: number },
): string {
  const key = [agentId, contactId, occasion.kind, occasion.month, occasion.day].join('\u0000');
  const bytes = createHash('sha256').update(key).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Storage seam only: model decisions, occasions, card compilation, and dispatch stay in core. */
export class FirestoreMemoryConsolidationRepository implements MemoryConsolidationRepository {
  readonly kind = 'memory-consolidation-repository' as const;
  readonly space: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    space: EmbeddingSpace,
  ) {
    this.space = snapshotEmbeddingSpace(space);
  }

  private async owner(agentId: string): Promise<void> {
    if (!agentId) throw new Error('Consolidation requires an agent');
    const owner = await this.store.doc('agents', agentId).get();
    if (!owner.exists || owner.get('id') !== agentId || documentKey(agentId) !== owner.id)
      throw new Error('Consolidation agent is missing');
  }

  async candidates(agentId: string) {
    await this.owner(agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const now = this.store.now();
    const pending = await eligibleQuery(this.store, agentId)
      .where('lastConsolidatedAt', '==', null)
      .limit(CONSOLIDATION_CANDIDATE_LIMIT)
      .get();
    const standalone: ConsolidationFact[] = [];
    const seen = new Set<string>();
    let window: { subjectContactId: string; facts: ConsolidationFact[] } | null = null;
    for (const doc of pending.docs) {
      const candidate = fact(doc, agentId, now);
      if (!candidate || candidate.lastConsolidatedAt) continue;
      const subject = candidate.subjectContactId;
      if (!subject) {
        standalone.push(candidate);
      } else if (!seen.has(subject)) {
        seen.add(subject);
        const pendingForSubject = await eligibleQuery(this.store, agentId)
          .where('subjectContactId', '==', subject)
          .where('lastConsolidatedAt', '==', null)
          .limit(CONSOLIDATION_WINDOW_LIMIT)
          .get();
        // Explicitly fetch never-reviewed facts first. A person with more than
        // one page of dated facts must still rotate beyond the first page.
        const page =
          pendingForSubject.size < CONSOLIDATION_WINDOW_LIMIT
            ? await eligibleQuery(this.store, agentId)
                .where('subjectContactId', '==', subject)
                .limit(CONSOLIDATION_CANDIDATE_LIMIT)
                .get()
            : null;
        const byId = new Map(
          [...pendingForSubject.docs, ...(page?.docs ?? [])].map((row) => [row.id, row]),
        );
        const facts = [...byId.values()]
          .map((row) => fact(row, agentId, now))
          .filter((row): row is ConsolidationFact => Boolean(row))
          .sort(reviewOrder)
          .slice(0, CONSOLIDATION_WINDOW_LIMIT);
        if (facts.length === 1 && facts[0]?.id === candidate.id) standalone.push(candidate);
        else if (facts.length >= 2 && !window) window = { subjectContactId: subject, facts };
      }
      if (standalone.length >= CONSOLIDATION_WINDOW_LIMIT) break;
    }
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    const allFacts = [...standalone, ...(window?.facts ?? [])];
    const lineageByMemory = new Map<string, Map<string, ImportUnitProvenance[]>>();
    for (let offset = 0; offset < allFacts.length; offset += 30) {
      const group = allFacts.slice(offset, offset + 30);
      const lineage = await this.store
        .collection('memoryImportLineage')
        .where(
          'memoryId',
          'in',
          group.map((row) => row.id),
        )
        .get();
      for (const doc of lineage.docs) {
        const source = doc.get('source');
        const memoryId = doc.get('memoryId');
        const ownerId = doc.get('agentId');
        if (
          typeof source !== 'string' ||
          !source ||
          ownerId !== agentId ||
          typeof memoryId !== 'string' ||
          !group.some((row) => row.id === memoryId) ||
          doc.id !== documentKey(importLineageId(source, memoryId))
        )
          throw new Error('Memory import lineage is malformed');
        const sources = lineageByMemory.get(memoryId) ?? new Map();
        if (sources.has(source)) throw new Error('Memory import lineage is duplicated');
        sources.set(source, readImportUnitProvenance(doc.get('sourceUnitProvenance')));
        lineageByMemory.set(memoryId, sources);
      }
    }
    for (const row of allFacts) {
      const sources = lineageByMemory.get(row.id) ?? new Map();
      row.importSources = [...sources.keys()];
      row.importSourceProvenance = [...sources].map(([source, sourceUnitProvenance]) => ({
        source,
        sourceUnitProvenance,
      }));
    }
    return { standalone, window };
  }

  async stampStandalone(agentId: string, facts: ConsolidationFact[]): Promise<number> {
    if (facts.length > CONSOLIDATION_WINDOW_LIMIT || facts.some((row) => row.agentId !== agentId))
      throw new Error('Invalid standalone consolidation batch');
    if (!facts.length) return 0;
    await this.owner(agentId);
    return this.store.db.runTransaction(async (tx) => {
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (erasure.exists && privacyErasureIsActive(erasure.get('status')))
        throw new Error('Privacy erasure is in progress');
      const contributingSources = [
        ...new Set(facts.flatMap((fact) => fact.importSources ?? [])),
      ].sort();
      // Source state is part of the same transaction as derived facts and
      // lineage. A concurrent delete either waits for this publication (then
      // discovers it) or wins first and makes this review stale.
      if (contributingSources.length > 200)
        throw new Error('Consolidation has too many import sources to fence safely');
      for (const source of contributingSources) {
        const claimRef = this.store.doc('importSourceKeys', importSourceKeyId(agentId, source));
        const claim = await tx.get(claimRef);
        let sourceRow: DocumentSnapshot | null = null;
        if (claim.exists) {
          const sourceId = claim.get('sourceId');
          if (
            claim.get('agentId') !== agentId ||
            claim.get('source') !== source ||
            typeof sourceId !== 'string'
          )
            throw new Error('Consolidation import source identity claim is malformed');
          const candidate = await tx.get(this.store.doc('importSources', sourceId));
          if (candidate.exists) sourceRow = candidate;
        } else {
          const matches = await tx.get(
            this.store
              .collection('importSources')
              .where('agentId', '==', agentId)
              .where('source', '==', source)
              .limit(2),
          );
          if (matches.size !== 1) throw new Error('Consolidation import source is unavailable');
          sourceRow = matches.docs[0] ?? null;
        }
        if (
          !sourceRow?.exists ||
          sourceRow.get('id') !== sourceRow.id ||
          sourceRow.get('agentId') !== agentId ||
          sourceRow.get('source') !== source ||
          sourceRow.get('status') === 'purged'
        )
          throw new Error('An imported source changed while consolidation was in flight');
      }
      const docs = await tx.getAll(...facts.map((row) => this.store.doc('memories', row.id)));
      const now = this.store.now();
      for (let index = 0; index < docs.length; index++) {
        const doc = docs[index];
        const expected = facts[index];
        if (
          !doc?.exists ||
          !expected ||
          fact(doc as QueryDocumentSnapshot, agentId, now)?.version !== expected.version ||
          doc.get('lastConsolidatedAt') !== null
        )
          throw new Error('Standalone memory changed during consolidation');
      }
      const tombstones = await tx.getAll(
        ...docs.map((doc) => this.store.doc('memoryTombstones', String(doc?.get('contentHash')))),
      );
      if (tombstones.some((row) => row.exists)) throw new Error('Standalone memory was erased');
      // A person may gain a second fact after candidate selection. Recheck before stamping.
      for (const subject of new Set(
        facts.map((row) => row.subjectContactId).filter((id): id is string => Boolean(id)),
      )) {
        const peers = await tx.get(
          eligibleQuery(this.store, agentId).where('subjectContactId', '==', subject).limit(2),
        );
        if (peers.size !== 1) throw new Error('Standalone subject changed during consolidation');
      }
      for (const doc of docs) if (doc) tx.update(doc.ref, { lastConsolidatedAt: now });
      return docs.length;
    });
  }

  async applyReview(input: ConsolidationReview) {
    const { agentId, subjectContactId, facts } = input;
    if (
      !agentId ||
      !subjectContactId ||
      facts.length < 2 ||
      facts.length > CONSOLIDATION_WINDOW_LIMIT ||
      new Set(facts.map((row) => row.id)).size !== facts.length ||
      facts.some((row) => row.agentId !== agentId || row.subjectContactId !== subjectContactId)
    )
      throw new Error('Invalid consolidation review');
    const ids = new Set(facts.map((row) => row.id));
    const retiring = new Set(input.retirements.map((row) => row.id));
    const survivors = new Set(input.retirements.map((row) => row.supersededById));
    if (
      retiring.size !== input.retirements.length ||
      input.retirements.some((row) => retiring.has(row.supersededById)) ||
      input.merges.some((merge) => merge.memberIds.some((id) => survivors.has(id)))
    )
      throw new Error('Consolidation retirements must point directly to surviving facts');
    if (
      input.retirements.some(
        (row) => !ids.has(row.id) || !ids.has(row.supersededById) || row.id === row.supersededById,
      ) ||
      input.domainFixes.some((row) => !ids.has(row.id)) ||
      input.timeline.some((row) => !ids.has(row.id)) ||
      input.merges.some(
        (merge) => merge.memberIds.length < 2 || merge.memberIds.some((id) => !ids.has(id)),
      )
    )
      throw new Error('Consolidation decision references an unknown fact');
    if (
      input.merges.length > 15 ||
      new Set(input.merges.map((merge) => merge.id)).size !== input.merges.length ||
      new Set(input.merges.map((merge) => merge.contentHash)).size !== input.merges.length
    )
      throw new Error('Invalid consolidation merges');
    for (const merge of input.merges) {
      if (
        !merge.content.trim() ||
        merge.contentHash !== createHash('sha256').update(merge.content).digest('hex')
      )
        throw new Error('Invalid consolidation content hash');
      validateEmbedding(this.space, merge.embedding);
      if (merge.embeddingSpaceKey !== embeddingSpaceKey(this.space))
        throw new Error('Consolidation embedding space changed');
    }
    await this.owner(agentId);
    return this.store.db.runTransaction(async (tx) => {
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (erasure.exists && privacyErasureIsActive(erasure.get('status')))
        throw new Error('Privacy erasure is in progress');
      const docs = await tx.getAll(...facts.map((row) => this.store.doc('memories', row.id)));
      const now = this.store.now();
      const byId = new Map<string, QueryDocumentSnapshot>();
      for (let index = 0; index < facts.length; index++) {
        const doc = docs[index];
        const expected = facts[index];
        if (
          !doc?.exists ||
          !expected ||
          fact(doc as QueryDocumentSnapshot, agentId, now)?.version !== expected.version ||
          doc.get('subjectContactId') !== subjectContactId
        )
          throw new Error('Consolidation memory changed during review');
        byId.set(expected.id, doc as QueryDocumentSnapshot);
      }
      const tombstones = await tx.getAll(
        ...facts.map((row) =>
          this.store.doc('memoryTombstones', byId.get(row.id)?.get('contentHash')),
        ),
      );
      if (tombstones.some((row) => row.exists)) throw new Error('Consolidation memory was erased');
      const mergeRefs = input.merges.flatMap((merge) => [
        this.store.doc('memories', merge.id),
        this.store.doc('memoryContentHashes', merge.contentHash),
        this.store.doc('memoryTombstones', merge.contentHash),
      ]);
      const mergeChecks = mergeRefs.length ? await tx.getAll(...mergeRefs) : [];
      const mergeSourcePlans = input.merges.map((merge) => {
        const bySource = new Map<string, ImportUnitProvenance[][]>();
        for (const id of merge.memberIds) {
          for (const provenance of facts.find((fact) => fact.id === id)?.importSourceProvenance ??
            []) {
            const groups = bySource.get(provenance.source) ?? [];
            groups.push(provenance.sourceUnitProvenance);
            bySource.set(provenance.source, groups);
          }
        }
        return [...bySource].map(([source, groups]) => ({
          source,
          sourceUnitProvenance: mergeImportUnitProvenance(...groups),
        }));
      });
      const mergeLineageRefs = input.merges.flatMap((merge, index) =>
        (mergeSourcePlans[index] ?? []).map(({ source }) =>
          this.store.doc('memoryImportLineage', importLineageId(source, merge.id)),
        ),
      );
      const mergeLineageChecks = mergeLineageRefs.length
        ? await tx.getAll(...mergeLineageRefs)
        : [];
      let mergeLineageOffset = 0;
      for (let index = 0; index < input.merges.length; index++) {
        const merge = input.merges[index];
        for (const { source } of mergeSourcePlans[index] ?? []) {
          const lineage = mergeLineageChecks[mergeLineageOffset++];
          if (
            lineage?.exists &&
            (lineage.get('source') !== source || lineage.get('memoryId') !== merge?.id)
          )
            throw new Error('Consolidated memory import lineage conflicts with its identity');
        }
      }
      const occasionKeys = (input.occasions ?? []).map((occasion) =>
        [agentId, subjectContactId, occasion.kind, occasion.month, occasion.day].join('\u0000'),
      );
      if (new Set(occasionKeys).size !== occasionKeys.length)
        throw new Error('Duplicate consolidation occasions');
      const occasionResolutions = [];
      for (const occasion of input.occasions ?? [])
        occasionResolutions.push(
          await resolveOccasionIdentity(tx, this.store, agentId, {
            contactId: subjectContactId,
            kind: occasion.kind,
            month: occasion.month,
            day: occasion.day,
          }),
        );
      const occasionSourceIds = occasionResolutions.map((resolved) =>
        resolved?.snapshot ? String(resolved.snapshot.get('id')) : randomUUID(),
      );
      const occasionSources = [...new Set(facts.flatMap((fact) => fact.importSources ?? []))];
      const occasionLineagePlans = occasionResolutions.flatMap((resolved, index) => {
        if (resolved?.snapshot?.get('source') !== 'consolidation') return [];
        const occasionId = occasionSourceIds[index];
        if (!occasionId) return [];
        return occasionSources.map((source) => ({
          source,
          occasionId,
          ref: this.store.doc('occasionImportLineage', occasionImportLineageId(source, occasionId)),
        }));
      });
      // For new occasions, add plans now that the deterministic IDs are fixed.
      for (let index = 0; index < occasionResolutions.length; index++) {
        if (occasionResolutions[index]?.snapshot) continue;
        const occasionId = occasionSourceIds[index];
        if (!occasionId) continue;
        for (const source of occasionSources)
          occasionLineagePlans.push({
            source,
            occasionId,
            ref: this.store.doc(
              'occasionImportLineage',
              occasionImportLineageId(source, occasionId),
            ),
          });
      }
      const occasionLineageChecks = occasionLineagePlans.length
        ? await tx.getAll(...occasionLineagePlans.map((plan) => plan.ref))
        : [];
      for (let index = 0; index < occasionLineagePlans.length; index++) {
        const plan = occasionLineagePlans[index];
        const lineage = occasionLineageChecks[index];
        if (
          lineage?.exists &&
          (lineage.get('source') !== plan?.source || lineage.get('occasionId') !== plan?.occasionId)
        )
          throw new Error('Consolidated occasion import lineage conflicts with its identity');
      }
      const contact = occasionKeys.length
        ? await tx.get(this.store.doc('contacts', subjectContactId))
        : null;
      if (
        occasionKeys.length > 0 &&
        (!contact?.exists ||
          contact.get('id') !== subjectContactId ||
          (contact.get('agentId') !== undefined && contact.get('agentId') !== agentId))
      )
        throw new Error('Consolidation contact is missing');
      const retired: string[] = [];
      const merged: string[] = [];
      const domainsAssigned: string[] = [];
      let occasionsSaved = 0;
      const replacement = new Map(input.retirements.map((row) => [row.id, row.supersededById]));
      for (let index = 0; index < input.merges.length; index++) {
        const merge = input.merges[index];
        if (!merge) continue;
        if (mergeChecks.slice(index * 3, index * 3 + 3).some((row) => row?.exists)) continue;
        if (
          !merge.id ||
          !merge.contentHash ||
          new Set(merge.memberIds).size !== merge.memberIds.length ||
          merge.memberIds.some(
            (id) =>
              replacement.has(id) ||
              byId.get(id)?.get('ownerConfirmed') ||
              byId.get(id)?.get('pinned'),
          )
        )
          throw new Error('Invalid consolidation merge');
        const members = merge.memberIds.map((id) => facts.find((fact) => fact.id === id));
        if (
          members.some((fact) => !fact) ||
          !canRewriteConsolidationFacts(members as ConsolidationFact[])
        )
          throw new Error(
            'Consolidation must retain temporally scoped or uncertain facts separately',
          );
        const row: Memory = {
          id: merge.id,
          agentId,
          subjectContactId,
          createdAt: earliestConsolidationSource(members as ConsolidationFact[]),
          expiresAt: null,
          embedding: merge.embedding,
          embeddingSpaceKey: merge.embeddingSpaceKey,
          sourceTaskId: merge.sourceTaskId,
          kind: merge.kind,
          confidence: merge.confidence,
          contentHash: merge.contentHash,
          goalId: null,
          originTrust: 'assistant',
          category: 'knowledge',
          content: merge.content,
          importance: merge.importance,
          quarantined: false,
          domain: merge.domain,
          validFrom: null,
          validUntil: null,
          supersededById: null,
          ownerConfirmed: false,
          pinned: false,
          source: 'consolidation',
          lastAccessedAt: null,
          lastConsolidatedAt: now,
        };
        tx.create(
          this.store.doc('memories', merge.id),
          encodeRecord({
            ...row,
            embedding: FieldValue.vector(merge.embedding),
            embeddingSpace: embeddingSpaceKey(this.space),
            retrievalRevision: randomUUID(),
          }),
        );
        tx.create(this.store.doc('memoryContentHashes', merge.contentHash), { memoryId: merge.id });
        const planSources = mergeSourcePlans[index] ?? [];
        let lineageIndex = mergeSourcePlans
          .slice(0, index)
          .reduce((total, sources) => total + sources.length, 0);
        for (const { source, sourceUnitProvenance } of planSources) {
          const lineage = mergeLineageChecks[lineageIndex];
          const lineageRef = mergeLineageRefs[lineageIndex];
          if (!lineage?.exists && lineageRef)
            tx.create(
              lineageRef,
              encodeRecord({
                agentId,
                source,
                memoryId: merge.id,
                sourceUnitProvenance,
                createdAt: now,
              }),
            );
          lineageIndex += 1;
        }
        merged.push(merge.id);
        for (const id of merge.memberIds) replacement.set(id, merge.id);
      }
      for (const row of input.retirements) {
        const winner = byId.get(row.supersededById);
        const loser = byId.get(row.id);
        if (
          !winner ||
          !loser ||
          !canRewriteConsolidationFacts([
            facts.find((fact) => fact.id === row.id),
            facts.find((fact) => fact.id === row.supersededById),
          ] as ConsolidationFact[]) ||
          loser.get('pinned') ||
          (loser.get('ownerConfirmed') && !winner.get('ownerConfirmed'))
        )
          throw new Error('Invalid consolidation retirement');
      }
      for (const [id, supersededById] of replacement) {
        const doc = byId.get(id);
        if (!doc) throw new Error('Consolidation retirement is missing');
        tx.update(doc.ref, { expiresAt: now, supersededById, lastConsolidatedAt: now });
        retired.push(id);
      }
      for (const fix of input.domainFixes) {
        const doc = byId.get(fix.id);
        if (doc && !replacement.has(fix.id) && doc.get('domain') !== fix.domain) {
          tx.update(doc.ref, { domain: fix.domain });
          domainsAssigned.push(fix.id);
        }
      }
      for (const item of input.timeline) {
        const doc = byId.get(item.id);
        const original = facts.find((fact) => fact.id === item.id);
        if (original) {
          if (
            (item.validFrom && original.validFrom && item.validFrom < original.validFrom) ||
            (item.validUntil && original.validUntil && item.validUntil > original.validUntil)
          )
            throw new Error('Consolidation timeline cannot widen temporal truth');
          const from = item.validFrom ?? original.validFrom;
          const until = item.validUntil ?? original.validUntil;
          if (from && until && from > until) throw new Error('Consolidation timeline is inverted');
        }
        if (doc && !replacement.has(item.id) && (item.validFrom || item.validUntil))
          tx.update(
            doc.ref,
            encodeRecord({
              retrievalRevision: randomUUID(),
              ...(item.validFrom ? { validFrom: item.validFrom } : {}),
              ...(item.validUntil ? { validUntil: item.validUntil } : {}),
            }),
          );
      }
      for (let index = 0; index < (input.occasions ?? []).length; index += 1) {
        const occasion = input.occasions?.[index];
        const resolved = occasionResolutions[index];
        const existing = resolved?.snapshot;
        if (!occasion || !resolved || resolved.ambiguous || resolved.superseded) continue;
        const id = existing
          ? decodeRecord<Records['occasions']>(existing.data()).id
          : occasionSourceIds[index];
        if (!id) throw new Error('Consolidation occasion identity is missing');
        const ref = existing?.ref ?? this.store.doc('occasions', id);
        if (
          !Number.isInteger(occasion.month) ||
          occasion.month < 1 ||
          occasion.month > 12 ||
          !Number.isInteger(occasion.day) ||
          occasion.day < 1 ||
          occasion.day > 31
        )
          continue;
        if (existing?.exists) {
          const row = decodeRecord<Records['occasions']>(existing.data());
          if (
            row.id !== id ||
            row.agentId !== agentId ||
            row.contactId !== subjectContactId ||
            row.kind !== occasion.kind ||
            row.month !== occasion.month ||
            row.day !== occasion.day
          )
            throw new Error('Existing consolidation occasion is malformed');
          if (row.ownerConfirmed || row.originTrust === 'owner') {
            occasionsSaved += 1;
            if (!resolved.markerExists)
              tx.create(resolved.markerRef, occasionDateKey(agentId, row, row.id));
            continue;
          }
          const notes =
            !occasion.notes || row.notes.includes(occasion.notes)
              ? row.notes
              : row.notes
                ? `${row.notes}; ${occasion.notes}`
                : occasion.notes;
          tx.update(ref, { year: row.year ?? occasion.year, notes, updatedAt: now });
          if (!resolved.markerExists)
            tx.create(resolved.markerRef, occasionDateKey(agentId, row, row.id));
        } else {
          const row: Records['occasions'] = {
            id,
            agentId,
            contactId: subjectContactId,
            kind: occasion.kind,
            label: occasion.label,
            month: occasion.month,
            day: occasion.day,
            year: occasion.year,
            recurrence: 'annual',
            leadDays: 7,
            notes: occasion.notes,
            originTrust: 'assistant',
            quarantined: false,
            ownerConfirmed: false,
            source: 'consolidation',
            createdAt: now,
            updatedAt: now,
          };
          tx.create(ref, encodeRecord(row));
          tx.create(resolved.markerRef, occasionDateKey(agentId, row, id));
        }
        if (!existing || existing.get('source') === 'consolidation') {
          for (let sourceIndex = 0; sourceIndex < occasionLineagePlans.length; sourceIndex++) {
            const plan = occasionLineagePlans[sourceIndex];
            const lineage = occasionLineageChecks[sourceIndex];
            if (plan?.occasionId === id && !lineage?.exists)
              tx.create(
                plan.ref,
                encodeRecord({ agentId, source: plan.source, occasionId: id, createdAt: now }),
              );
          }
        }
        occasionsSaved += 1;
      }
      for (const doc of docs)
        if (doc && !replacement.has(String(doc.get('id'))))
          tx.update(doc.ref, { lastConsolidatedAt: now });
      tx.set(
        this.store.doc('ownerCards', agentId),
        encodeRecord({
          agentId,
          content: '',
          compiledAt: now,
          invalidatedAt: now,
        }),
      );
      return {
        retired,
        merged,
        domainsAssigned,
        ...(occasionsSaved > 0 ? { occasionsSaved } : {}),
      };
    });
  }
}
