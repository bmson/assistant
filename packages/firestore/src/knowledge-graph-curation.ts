import type {
  KnowledgeGraphCurationEntity,
  KnowledgeGraphCurationRepository,
  KnowledgeWorkspaceEntity,
  Records,
} from '@assistant/persistence';
import {
  canonicalizeKnowledgeAssertionDirection,
  knowledgeAssertionEvidenceId,
  knowledgeAssertionId,
  knowledgeAssertionSemanticKey,
} from '@assistant/persistence';
import {
  type DocumentReference,
  type DocumentSnapshot,
  FieldPath,
  type Query,
  type Transaction,
} from '@google-cloud/firestore';
import { assertConfiguredOwner, RELATIVE_DATE } from './knowledge-graph-read.js';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { deterministicUuid } from './stable-id.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Entity = Records['knowledgeGraphEntities'];
type Relation = Records['knowledgeGraphRelations'];
type Alias = Records['knowledgeGraphEntityAliases'];
type GraphAssertion = Records['knowledgeGraphAssertions'];
type GraphAssertionEvidence = Records['knowledgeGraphAssertionEvidence'];

const PAGE_SIZE = 1000;
const ENTITY_LIMIT = 50_000;
const RELATION_LIMIT = 50_000;
const SOURCE_LIMIT = 100_000;
/** Firestore commits at most 500 writes per transaction; merges stay well inside it. */
const MERGE_WRITE_LIMIT = 450;
const ALIAS_LIMIT = 100;
const CONCURRENCY = 8;

function ownedEntity(doc: DocumentSnapshot | undefined, agentId: string): Entity | null {
  if (!doc?.exists) return null;
  const row = decodeRecord<Entity>(doc.data());
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== doc.id ||
    row.agentId !== agentId ||
    typeof row.kind !== 'string' ||
    typeof row.label !== 'string' ||
    typeof row.canonicalKey !== 'string'
  )
    return null;
  return row;
}

function displayLabel(row: Pick<Entity, 'label' | 'preferredLabel'>): string {
  return row.preferredLabel || row.label;
}

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
    if (seen > limit) throw new Error(`Knowledge curation ${label} scan exceeds its limit`);
    for (const doc of rows.docs) visit(doc);
    if (rows.size < PAGE_SIZE) return;
    cursor = rows.docs.at(-1);
  }
}

async function eachLimited<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await work(items[index] as T);
      }
    }),
  );
  return results;
}

async function readMany(
  store: InstallationStore,
  collection: string,
  ids: string[],
  fieldMask: string[],
): Promise<Map<string, DocumentSnapshot>> {
  const unique = [...new Set(ids)];
  const batches = Array.from({ length: Math.ceil(unique.length / 300) }, (_, index) =>
    unique.slice(index * 300, index * 300 + 300),
  );
  const result = new Map<string, DocumentSnapshot>();
  await eachLimited(batches, async (batch) => {
    const docs = await store.db.getAll(...batch.map((id) => store.doc(collection, id)), {
      fieldMask,
    });
    batch.forEach((id, index) => {
      const doc = docs[index];
      if (doc?.exists) result.set(id, doc);
    });
  });
  return result;
}

async function bounded(tx: Transaction, query: Query, limit: number, message: string) {
  const rows = await tx.get(query.limit(limit + 1));
  if (rows.size > limit) throw new Error(message);
  return rows.docs;
}

/** Owner knowledge graph curation with owner, erasure, and identity fences in each transaction. */
export class FirestoreKnowledgeGraphCurationRepository implements KnowledgeGraphCurationRepository {
  readonly kind = 'knowledge-graph-curation-repository' as const;

  constructor(readonly store: InstallationStore) {}

  private async begin(tx: Transaction, agentId: string): Promise<void> {
    const owners = await tx.get(this.store.collection('agents').limit(2));
    if (
      !agentId ||
      owners.size !== 1 ||
      owners.docs[0]?.id !== documentKey(agentId) ||
      owners.docs[0]?.get('id') !== agentId
    )
      throw new Error('Knowledge graph requires exactly one configured agent');
    await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
  }

  private aliasFor(tx: Transaction, agentId: string, canonicalKey: string) {
    return bounded(
      tx,
      this.store
        .collection('knowledgeGraphEntityAliases')
        .where('agentId', '==', agentId)
        .where('canonicalKey', '==', canonicalKey),
      1,
      'Duplicate graph entity alias',
    );
  }

  /** Point `canonicalKey` at `entityId`, reusing an imported alias row when one exists. */
  private upsertAlias(
    tx: Transaction,
    existing: DocumentSnapshot | undefined,
    agentId: string,
    canonicalKey: string,
    entityId: string,
  ): void {
    if (existing) {
      const alias = decodeRecord<Alias>(existing.data());
      if (alias.agentId !== agentId || alias.canonicalKey !== canonicalKey)
        throw new Error('Graph alias identity mismatch');
      tx.update(existing.ref, { entityId });
      return;
    }
    const id = deterministicUuid('knowledge-graph-alias', agentId, canonicalKey);
    tx.create(this.store.doc('knowledgeGraphEntityAliases', id), {
      id,
      createdAt: this.store.now(),
      agentId,
      canonicalKey,
      entityId,
    });
  }

  async entity(agentId: string, entityId: string): Promise<KnowledgeGraphCurationEntity | null> {
    await assertConfiguredOwner(this.store, agentId);
    const row = ownedEntity(
      await this.store.doc('knowledgeGraphEntities', entityId).get(),
      agentId,
    );
    return row
      ? {
          id: row.id,
          kind: row.kind,
          label: row.label,
          canonicalKey: row.canonicalKey,
          contactId: row.contactId ?? null,
        }
      : null;
  }

  async rename(agentId: string, entityId: string, preferredLabel: string): Promise<boolean> {
    const ref = this.store.doc('knowledgeGraphEntities', entityId);
    return this.store.db.runTransaction(async (tx) => {
      await this.begin(tx, agentId);
      if (!ownedEntity(await tx.get(ref), agentId)) return false;
      tx.update(ref, { preferredLabel, updatedAt: this.store.now() });
      return true;
    });
  }

  async retype(
    agentId: string,
    input: {
      entityId: string;
      fromKey: string;
      kind: string;
      canonicalKey: string;
      contactId: string | null;
    },
  ): Promise<'updated' | 'missing' | 'changed' | 'conflict'> {
    const ref = this.store.doc('knowledgeGraphEntities', input.entityId);
    return this.store.db.runTransaction(async (tx) => {
      await this.begin(tx, agentId);
      const entity = ownedEntity(await tx.get(ref), agentId);
      if (!entity) return 'missing';
      if (entity.canonicalKey !== input.fromKey) return 'changed';
      const rekey = input.canonicalKey !== input.fromKey;
      const [holders, aliases] = rekey
        ? await Promise.all([
            tx.get(
              this.store
                .collection('knowledgeGraphEntities')
                .where('agentId', '==', agentId)
                .where('canonicalKey', '==', input.canonicalKey)
                .limit(2),
            ),
            this.aliasFor(tx, agentId, input.fromKey),
          ])
        : [null, []];
      if (holders?.docs.some((doc) => doc.id !== ref.id)) return 'conflict';
      if (rekey) this.upsertAlias(tx, aliases[0], agentId, input.fromKey, entity.id);
      tx.update(ref, {
        kind: input.kind,
        canonicalKey: input.canonicalKey,
        // The contact link only means something while the entity is a person.
        contactId: input.contactId,
        updatedAt: this.store.now(),
      });
      return 'updated';
    });
  }

  async merge(agentId: string, sourceId: string, targetId: string): Promise<boolean> {
    if (sourceId === targetId) return true;
    const relations = this.store.collection('knowledgeGraphRelations');
    return this.store.db.runTransaction(async (tx) => {
      await this.begin(tx, agentId);
      const [sourceDoc, targetDoc] = await tx.getAll(
        this.store.doc('knowledgeGraphEntities', sourceId),
        this.store.doc('knowledgeGraphEntities', targetId),
      );
      const source = ownedEntity(sourceDoc, agentId);
      const target = ownedEntity(targetDoc, agentId);
      // Either endpoint missing or owned by another agent: never re-point.
      if (!source || !target || !sourceDoc) return false;
      const incident = (field: 'subjectEntityId' | 'objectEntityId', entityId: string) =>
        bounded(
          tx,
          relations.where('agentId', '==', agentId).where(field, '==', entityId),
          MERGE_WRITE_LIMIT,
          'Knowledge merge relation bound reached',
        );
      const [pages, keyAliases, sourceAliases, assertionPages] = await Promise.all([
        Promise.all([
          incident('subjectEntityId', sourceId),
          incident('objectEntityId', sourceId),
          incident('subjectEntityId', targetId),
          incident('objectEntityId', targetId),
        ]),
        this.aliasFor(tx, agentId, source.canonicalKey),
        bounded(
          tx,
          this.store.collection('knowledgeGraphEntityAliases').where('entityId', '==', sourceId),
          ALIAS_LIMIT,
          'Graph entity alias merge bound reached',
        ),
        Promise.all([
          bounded(
            tx,
            this.store
              .collection('knowledgeGraphAssertions')
              .where('agentId', '==', agentId)
              .where('subjectEntityId', '==', sourceId),
            MERGE_WRITE_LIMIT,
            'Knowledge merge assertion bound reached',
          ),
          bounded(
            tx,
            this.store
              .collection('knowledgeGraphAssertions')
              .where('agentId', '==', agentId)
              .where('objectEntityId', '==', sourceId),
            MERGE_WRITE_LIMIT,
            'Knowledge merge assertion bound reached',
          ),
        ]),
      ]);
      if (sourceAliases.some((doc) => doc.get('agentId') !== agentId))
        throw new Error('Graph alias ownership mismatch');

      const assertionDocs = [
        ...new Map(assertionPages.flat().map((doc) => [doc.ref.path, doc])).values(),
      ];
      const assertionRows = assertionDocs.map((doc) => {
        const row = decodeRecord<GraphAssertion>(doc.data());
        if (row.agentId !== agentId || documentKey(row.id) !== doc.id)
          throw new Error('Canonical assertion ownership mismatch');
        return { doc, row };
      });
      const assertionPlans = assertionRows
        .filter(({ row }) => row.lifecycle === 'current')
        .map(({ doc, row }) => {
          const meaning = canonicalizeKnowledgeAssertionDirection({
            subjectEntityId: row.subjectEntityId === sourceId ? targetId : row.subjectEntityId,
            predicate: row.predicate,
            objectEntityId: row.objectEntityId === sourceId ? targetId : row.objectEntityId,
            assertion: row.assertion,
            validFrom: row.validFrom,
            validUntil: row.validUntil,
            qualifiers: row.qualifiers,
          });
          const semanticKey = knowledgeAssertionSemanticKey(agentId, meaning);
          return {
            doc,
            row,
            meaning,
            semanticKey,
            targetId: knowledgeAssertionId(agentId, semanticKey),
          };
        })
        .filter((plan) => plan.targetId !== plan.row.id);
      const targetAssertionDocs =
        assertionPlans.length > 0
          ? await tx.getAll(
              ...[...new Set(assertionPlans.map((plan) => plan.targetId))].map((id) =>
                this.store.doc('knowledgeGraphAssertions', id),
              ),
            )
          : [];
      const targetAssertionsById = new Map(
        targetAssertionDocs.map((doc) => {
          const row = decodeRecord<GraphAssertion>(doc.data());
          if (row.agentId !== agentId || documentKey(row.id) !== doc.id)
            throw new Error('Canonical assertion merge target ownership mismatch');
          return [row.id, doc] as const;
        }),
      );
      const evidenceByAssertion = await Promise.all(
        assertionPlans.map((plan) =>
          bounded(
            tx,
            this.store
              .collection('knowledgeGraphAssertionEvidence')
              .where('agentId', '==', agentId)
              .where('assertionId', '==', plan.row.id),
            MERGE_WRITE_LIMIT,
            'Knowledge merge assertion evidence bound reached',
          ),
        ),
      );
      const evidenceRows = evidenceByAssertion.flat();
      if (evidenceRows.some((doc) => doc.get('agentId') !== agentId))
        throw new Error('Canonical assertion evidence ownership mismatch');
      const evidenceTargetIds = evidenceRows.map((doc) => {
        const row = decodeRecord<GraphAssertionEvidence>(doc.data());
        const plan = assertionPlans.find((entry) => entry.row.id === row.assertionId);
        if (!plan) throw new Error('Canonical assertion merge evidence has no owner plan');
        return this.store.doc(
          'knowledgeGraphAssertionEvidence',
          knowledgeAssertionEvidenceId(
            agentId,
            plan.targetId,
            row.sourceMemoryId,
            row.sourceFingerprint,
          ),
        );
      });
      const evidenceTargetDocs =
        evidenceTargetIds.length > 0 ? await tx.getAll(...evidenceTargetIds) : [];
      const evidenceTargetByPath = new Map(
        evidenceTargetDocs.map((doc) => [doc.ref.path, doc] as const),
      );
      const assertionIdRemap = new Map(
        assertionPlans.map((plan) => [plan.row.id, plan.targetId] as const),
      );
      const assertionDecisions = new Map<string, Set<string>>();
      for (const plan of assertionPlans) {
        const statuses = assertionDecisions.get(plan.targetId) ?? new Set<string>();
        statuses.add(plan.row.reviewStatus);
        const targetDoc = targetAssertionsById.get(plan.targetId);
        if (targetDoc?.exists) {
          if (targetDoc.get('agentId') !== agentId)
            throw new Error('Canonical assertion merge target belongs to another owner');
          const targetRow = decodeRecord<GraphAssertion>(targetDoc.data());
          statuses.add(targetRow.reviewStatus);
        }
        if (statuses.has('confirmed') && statuses.has('rejected'))
          throw new Error(
            'Merge conflicts with owner decisions on canonical assertions; review those decisions first',
          );
        assertionDecisions.set(plan.targetId, statuses);
      }

      // Re-point every edge, then keep one survivor per semantic duplicate:
      // owner review state first, then confidence, then age, so a merge never
      // silently discards the owner's curation.
      const rows = new Map<string, { ref: DocumentReference; row: Relation; moved: boolean }>();
      for (const doc of pages.flat()) {
        if (rows.has(doc.ref.path)) continue;
        const row = decodeRecord<Relation>(doc.data());
        if (row.agentId !== agentId || documentKey(row.id) !== doc.id)
          throw new Error('Graph relation ownership mismatch');
        const moved = row.subjectEntityId === sourceId || row.objectEntityId === sourceId;
        rows.set(doc.ref.path, {
          ref: doc.ref,
          moved,
          row: {
            ...row,
            assertionId: row.assertionId
              ? (assertionIdRemap.get(row.assertionId) ?? row.assertionId)
              : null,
            subjectEntityId: row.subjectEntityId === sourceId ? targetId : row.subjectEntityId,
            objectEntityId: row.objectEntityId === sourceId ? targetId : row.objectEntityId,
          },
        });
      }
      const decisions = new Map<string, Set<string>>();
      for (const { row } of rows.values()) {
        const key = [row.subjectEntityId, row.predicate, row.objectEntityId, row.sourceMemoryId]
          .map((part) => JSON.stringify(part))
          .join('|');
        const statuses = decisions.get(key) ?? new Set<string>();
        statuses.add(row.reviewStatus);
        decisions.set(key, statuses);
        if (statuses.has('confirmed') && statuses.has('rejected'))
          throw new Error(
            'Merge conflicts with an owner-confirmed and owner-rejected assertion; review those decisions first',
          );
      }
      const rank = (status: string) => (status === 'rejected' ? 0 : status === 'confirmed' ? 1 : 2);
      const survivors = new Map<string, { ref: DocumentReference; row: Relation }>();
      const deleted: DocumentReference[] = [];
      for (const entry of [...rows.values()].sort(
        (a, b) =>
          rank(a.row.reviewStatus) - rank(b.row.reviewStatus) ||
          Number(b.row.confidence) - Number(a.row.confidence) ||
          a.row.createdAt.getTime() - b.row.createdAt.getTime() ||
          a.row.id.localeCompare(b.row.id),
      )) {
        const { row } = entry;
        if (row.subjectEntityId === targetId && row.objectEntityId === targetId) {
          deleted.push(entry.ref);
          continue;
        }
        const key = [row.subjectEntityId, row.predicate, row.objectEntityId, row.sourceMemoryId]
          .map((part) => JSON.stringify(part))
          .join('|');
        if (survivors.has(key)) deleted.push(entry.ref);
        else survivors.set(key, entry);
      }
      const moved = [...rows.values()].filter(
        (entry) => entry.moved && !deleted.includes(entry.ref),
      );
      const aliasWrites = new Set([
        ...keyAliases.map((doc) => doc.ref.path),
        ...sourceAliases.map((doc) => doc.ref.path),
      ]).size;
      if (
        moved.length +
          deleted.length +
          aliasWrites +
          2 +
          assertionPlans.length * 2 +
          evidenceRows.length * 2 >
        MERGE_WRITE_LIMIT
      )
        throw new Error('Knowledge merge write bound reached');

      const targetEvidenceCreated = new Set<string>();
      for (const oldEvidence of evidenceRows) {
        const evidence = decodeRecord<GraphAssertionEvidence>(oldEvidence.data());
        const plan = assertionPlans.find((entry) => entry.row.id === evidence.assertionId);
        if (!plan) throw new Error('Canonical assertion merge evidence has no owner plan');
        const targetRef = this.store.doc(
          'knowledgeGraphAssertionEvidence',
          knowledgeAssertionEvidenceId(
            agentId,
            plan.targetId,
            evidence.sourceMemoryId,
            evidence.sourceFingerprint,
          ),
        );
        const targetEvidence = evidenceTargetByPath.get(targetRef.path);
        if (!targetEvidence) throw new Error('Canonical assertion evidence lookup failed');
        if (targetEvidence.exists) {
          if (targetEvidence.get('agentId') !== agentId)
            throw new Error('Canonical assertion evidence target belongs to another owner');
          tx.delete(oldEvidence.ref);
        } else if (!targetEvidenceCreated.has(targetRef.path)) {
          const relocated: GraphAssertionEvidence = {
            ...evidence,
            id: targetRef.id,
            assertionId: plan.targetId,
          };
          tx.create(targetRef, encodeRecord(relocated));
          tx.delete(oldEvidence.ref);
          targetEvidenceCreated.add(targetRef.path);
        } else {
          tx.delete(oldEvidence.ref);
        }
      }
      for (const plan of assertionPlans) {
        const targetDoc = targetAssertionsById.get(plan.targetId);
        const targetRow = targetDoc?.exists ? decodeRecord<GraphAssertion>(targetDoc.data()) : null;
        const status =
          plan.row.reviewStatus !== 'unreviewed'
            ? plan.row.reviewStatus
            : (targetRow?.reviewStatus ?? 'unreviewed');
        const semanticRevision = targetRow?.semanticRevision ?? plan.row.semanticRevision + 1;
        const updated: GraphAssertion = {
          id: plan.targetId,
          agentId,
          semanticKey: plan.semanticKey,
          subjectEntityId: plan.meaning.subjectEntityId,
          predicate: plan.meaning.predicate,
          objectEntityId: plan.meaning.objectEntityId,
          assertion: plan.meaning.assertion,
          qualifiers: plan.meaning.qualifiers ?? {},
          validFrom: plan.meaning.validFrom,
          validUntil: plan.meaning.validUntil,
          semanticRevision,
          evidenceRevision: plan.row.evidenceRevision + (targetRow?.evidenceRevision ?? 0),
          lifecycle: 'current',
          reviewStatus: status,
          reviewedRevision: status === 'unreviewed' ? null : semanticRevision,
          reviewedPayloadHash: status === 'unreviewed' ? null : plan.semanticKey,
          ownerAuthored: plan.row.ownerAuthored || (targetRow?.ownerAuthored ?? false),
          supersededById: null,
          createdAt: targetRow?.createdAt ?? plan.row.createdAt,
          updatedAt: this.store.now(),
        };
        const targetRef =
          targetDoc?.ref ?? this.store.doc('knowledgeGraphAssertions', plan.targetId);
        if (targetDoc?.exists) tx.set(targetRef, encodeRecord(updated));
        else tx.create(targetRef, encodeRecord(updated));
        tx.update(plan.doc.ref, {
          lifecycle: 'superseded',
          supersededById: plan.targetId,
          semanticRevision: plan.row.semanticRevision + 1,
          updatedAt: this.store.now(),
        });
      }

      for (const entry of moved)
        tx.update(entry.ref, {
          subjectEntityId: entry.row.subjectEntityId,
          objectEntityId: entry.row.objectEntityId,
          assertionId: entry.row.assertionId,
        });
      for (const ref of deleted) tx.delete(ref);
      // Later extractions of the absorbed identity land on the survivor.
      this.upsertAlias(tx, keyAliases[0], agentId, source.canonicalKey, targetId);
      for (const alias of sourceAliases)
        if (alias.ref.path !== keyAliases[0]?.ref.path)
          tx.update(alias.ref, { entityId: targetId });
      tx.delete(sourceDoc.ref);
      return true;
    });
  }

  async removeOrphanedEntities(agentId: string): Promise<number> {
    await assertConfiguredOwner(this.store, agentId);
    const entityIds: string[] = [];
    const referenced = new Set<string>();
    const owned = (collection: string, ...fields: string[]) =>
      this.store
        .collection(collection)
        .where('agentId', '==', agentId)
        .select(...fields) as Query;
    await Promise.all([
      scan(owned('knowledgeGraphEntities', 'id'), ENTITY_LIMIT, 'entity', (doc) => {
        const id = doc.get('id');
        if (typeof id === 'string' && documentKey(id) === doc.id) entityIds.push(id);
      }),
      scan(
        owned('knowledgeGraphRelations', 'subjectEntityId', 'objectEntityId'),
        RELATION_LIMIT,
        'relation',
        (doc) => {
          referenced.add(String(doc.get('subjectEntityId')));
          referenced.add(String(doc.get('objectEntityId')));
        },
      ),
    ]);
    const relations = this.store.collection('knowledgeGraphRelations');
    const removed = await eachLimited(
      entityIds.filter((id) => !referenced.has(id)),
      (entityId) =>
        // Each candidate is re-proven orphaned inside its own delete transaction.
        this.store.db.runTransaction(async (tx) => {
          await this.begin(tx, agentId);
          const ref = this.store.doc('knowledgeGraphEntities', entityId);
          const [current, subjects, objects, aliases] = await Promise.all([
            tx.get(ref),
            tx.get(
              relations
                .where('agentId', '==', agentId)
                .where('subjectEntityId', '==', entityId)
                .limit(1),
            ),
            tx.get(
              relations
                .where('agentId', '==', agentId)
                .where('objectEntityId', '==', entityId)
                .limit(1),
            ),
            bounded(
              tx,
              this.store
                .collection('knowledgeGraphEntityAliases')
                .where('entityId', '==', entityId),
              ALIAS_LIMIT,
              'Graph entity alias cleanup bound reached',
            ),
          ]);
          if (!ownedEntity(current, agentId) || !subjects.empty || !objects.empty) return false;
          if (aliases.some((alias) => alias.get('agentId') !== agentId))
            throw new Error('Graph orphan ownership mismatch');
          for (const alias of aliases) tx.delete(alias.ref);
          tx.delete(ref);
          return true;
        }),
    );
    return removed.filter(Boolean).length;
  }

  async retryBlockedSources(agentId: string): Promise<number> {
    await assertConfiguredOwner(this.store, agentId);
    const blocked: string[] = [];
    await scan(
      this.store
        .collection('knowledgeGraphSources')
        .where('status', 'in', ['failed', 'quarantined'])
        .select('memoryId') as Query,
      SOURCE_LIMIT,
      'graph source',
      (doc) => {
        const memoryId = doc.get('memoryId');
        if (typeof memoryId === 'string' && documentKey(memoryId) === doc.id)
          blocked.push(memoryId);
      },
    );
    const retried = await eachLimited(blocked, (memoryId) =>
      this.store.db.runTransaction(async (tx) => {
        await this.begin(tx, agentId);
        const sourceRef = this.store.doc('knowledgeGraphSources', memoryId);
        const [memory, source] = await tx.getAll(this.store.doc('memories', memoryId), sourceRef);
        if (
          !memory?.exists ||
          memory.get('id') !== memoryId ||
          memory.get('agentId') !== agentId ||
          !source?.exists ||
          source.get('memoryId') !== memoryId ||
          !['failed', 'quarantined'].includes(source.get('status'))
        )
          return false;
        // A retry deadline due now, not a pending claim: the normal atomic
        // claim still owns the next extraction attempt.
        const now = this.store.now();
        tx.update(sourceRef, {
          status: 'failed',
          attempts: 0,
          lastError: null,
          nextRetryAt: now,
          updatedAt: now,
        });
        return true;
      }),
    );
    return retried.filter(Boolean).length;
  }

  /**
   * Ready, unquarantined knowledge sources whose text has relative date wording
   * but from which no canonical date entity was extracted.
   */
  private async relativeDateCandidates(agentId: string): Promise<string[]> {
    await assertConfiguredOwner(this.store, agentId);
    const worded: string[] = [];
    await scan(
      this.store
        .collection('memories')
        .where('agentId', '==', agentId)
        .select('id', 'agentId', 'category', 'quarantined', 'content') as Query,
      SOURCE_LIMIT,
      'memory',
      (doc) => {
        const id = doc.get('id');
        const content = doc.get('content');
        if (
          typeof id === 'string' &&
          documentKey(id) === doc.id &&
          doc.get('category') === 'knowledge' &&
          doc.get('quarantined') === false &&
          typeof content === 'string' &&
          RELATIVE_DATE.test(content)
        )
          worded.push(id);
      },
    );
    const sources = await readMany(this.store, 'knowledgeGraphSources', worded, [
      'memoryId',
      'status',
    ]);
    const ready = worded.filter((id) => {
      const doc = sources.get(id);
      return doc?.get('memoryId') === id && doc.get('status') === 'ready';
    });
    const relations = (
      await eachLimited(
        Array.from({ length: Math.ceil(ready.length / 30) }, (_, index) =>
          ready.slice(index * 30, index * 30 + 30),
        ),
        (batch) =>
          this.store
            .collection('knowledgeGraphRelations')
            .where('agentId', '==', agentId)
            .where('sourceMemoryId', 'in', batch)
            .select('sourceMemoryId', 'subjectEntityId', 'objectEntityId')
            .get(),
      )
    ).flatMap((page) => page.docs);
    const endpoints = await readMany(
      this.store,
      'knowledgeGraphEntities',
      relations.flatMap((doc) => [
        String(doc.get('subjectEntityId')),
        String(doc.get('objectEntityId')),
      ]),
      ['kind', 'canonicalKey'],
    );
    const dated = new Set(
      relations
        .filter((doc) =>
          [doc.get('subjectEntityId'), doc.get('objectEntityId')].some((id) => {
            const entity = endpoints.get(String(id));
            return (
              entity?.get('kind') === 'date' &&
              /^date:[0-9-]+$/.test(String(entity.get('canonicalKey')))
            );
          }),
        )
        .map((doc) => String(doc.get('sourceMemoryId'))),
    );
    return ready.filter((id) => !dated.has(id));
  }

  /** How many sources only a paid, anchored re-extraction could date. */
  async countRelativeDateSources(agentId: string): Promise<number> {
    return (await this.relativeDateCandidates(agentId)).length;
  }

  async requeueRelativeDateSources(agentId: string): Promise<number> {
    const requeued = await eachLimited(await this.relativeDateCandidates(agentId), (memoryId) =>
      this.store.db.runTransaction(async (tx) => {
        await this.begin(tx, agentId);
        const sourceRef = this.store.doc('knowledgeGraphSources', memoryId);
        const [memory, source] = await tx.getAll(this.store.doc('memories', memoryId), sourceRef);
        if (
          memory?.get('agentId') !== agentId ||
          memory.get('category') !== 'knowledge' ||
          memory.get('quarantined') !== false ||
          source?.get('memoryId') !== memoryId ||
          source.get('status') !== 'ready'
        )
          return false;
        const now = this.store.now();
        tx.update(sourceRef, {
          status: 'failed',
          attempts: 0,
          lastError: null,
          nextRetryAt: now,
          updatedAt: now,
        });
        return true;
      }),
    );
    return requeued.filter(Boolean).length;
  }

  /**
   * The owner's date entities that a relation still cites, each with the
   * earliest and latest creation time of the memories citing it.
   */
  async citedDateEntities(
    agentId: string,
  ): Promise<
    Array<{ id: string; label: string; canonicalKey: string; anchor: Date; lastAnchor: Date }>
  > {
    await assertConfiguredOwner(this.store, agentId);
    const dates = new Map<string, { label: string; canonicalKey: string }>();
    await scan(
      this.store
        .collection('knowledgeGraphEntities')
        .where('agentId', '==', agentId)
        .where('kind', '==', 'date')
        .select('id', 'label', 'canonicalKey') as Query,
      ENTITY_LIMIT,
      'entity',
      (doc) => {
        const id = doc.get('id');
        const label = doc.get('label');
        const canonicalKey = doc.get('canonicalKey');
        if (
          typeof id === 'string' &&
          documentKey(id) === doc.id &&
          typeof label === 'string' &&
          typeof canonicalKey === 'string'
        )
          dates.set(id, { label, canonicalKey });
      },
    );
    if (dates.size === 0) return [];
    const citing = new Map<string, Set<string>>();
    await scan(
      this.store
        .collection('knowledgeGraphRelations')
        .where('agentId', '==', agentId)
        .select('subjectEntityId', 'objectEntityId', 'sourceMemoryId') as Query,
      RELATION_LIMIT,
      'relation',
      (doc) => {
        const memoryId = doc.get('sourceMemoryId');
        if (typeof memoryId !== 'string') return;
        for (const entityId of [doc.get('subjectEntityId'), doc.get('objectEntityId')]) {
          if (typeof entityId !== 'string' || !dates.has(entityId)) continue;
          const set = citing.get(entityId) ?? new Set<string>();
          set.add(memoryId);
          citing.set(entityId, set);
        }
      },
    );
    const memories = await readMany(
      this.store,
      'memories',
      [...citing.values()].flatMap((set) => [...set]),
      ['agentId', 'createdAt'],
    );
    return [...citing.entries()].flatMap(([id, memoryIds]) => {
      const times = [...memoryIds].flatMap((memoryId) => {
        const memory = memories.get(memoryId);
        if (memory?.get('agentId') !== agentId) return [];
        const createdAt = decodeRecord<{ createdAt?: unknown }>(memory.data()).createdAt;
        return createdAt instanceof Date ? [createdAt.getTime()] : [];
      });
      const entity = dates.get(id);
      if (!entity || times.length === 0) return [];
      return [
        {
          id,
          ...entity,
          anchor: new Date(Math.min(...times)),
          lastAnchor: new Date(Math.max(...times)),
        },
      ];
    });
  }

  /**
   * Give a date entity its canonical key and label. The entity moves to the
   * document its new key derives, with its relations and aliases, so a later
   * extraction of the old relative wording creates a fresh node instead of
   * colliding with this one. Unlike a merge, the old wording is not aliased:
   * "Friday" means a different day to every memory that says it.
   */
  async recanonicalizeDate(
    agentId: string,
    input: { entityId: string; fromKey: string; canonicalKey: string; label: string },
  ): Promise<'updated' | 'missing' | 'changed' | 'conflict'> {
    const relations = this.store.collection('knowledgeGraphRelations');
    const sourceRef = this.store.doc('knowledgeGraphEntities', input.entityId);
    const targetId = deterministicUuid('knowledge-graph-entity', agentId, input.canonicalKey);
    return this.store.db.runTransaction(async (tx) => {
      await this.begin(tx, agentId);
      const entity = ownedEntity(await tx.get(sourceRef), agentId);
      if (!entity || entity.kind !== 'date') return 'missing';
      if (entity.canonicalKey !== input.fromKey) return 'changed';
      const holders = await tx.get(
        this.store
          .collection('knowledgeGraphEntities')
          .where('agentId', '==', agentId)
          .where('canonicalKey', '==', input.canonicalKey)
          .limit(2),
      );
      if (holders.docs.some((doc) => doc.id !== sourceRef.id)) return 'conflict';
      const now = this.store.now();
      if (targetId === entity.id) {
        tx.update(sourceRef, {
          canonicalKey: input.canonicalKey,
          label: input.label,
          updatedAt: now,
        });
        return 'updated';
      }
      const targetRef = this.store.doc('knowledgeGraphEntities', targetId);
      const [target, subjects, objects, aliases] = await Promise.all([
        tx.get(targetRef),
        bounded(
          tx,
          relations.where('agentId', '==', agentId).where('subjectEntityId', '==', entity.id),
          MERGE_WRITE_LIMIT,
          'Knowledge date re-key relation bound reached',
        ),
        bounded(
          tx,
          relations.where('agentId', '==', agentId).where('objectEntityId', '==', entity.id),
          MERGE_WRITE_LIMIT,
          'Knowledge date re-key relation bound reached',
        ),
        bounded(
          tx,
          this.store.collection('knowledgeGraphEntityAliases').where('entityId', '==', entity.id),
          ALIAS_LIMIT,
          'Graph entity alias re-key bound reached',
        ),
      ]);
      // A document at the new key's id that does not hold the key belongs to
      // something else; leave the entity for the owner rather than guess.
      if (target.exists) return 'conflict';
      if (aliases.some((doc) => doc.get('agentId') !== agentId))
        throw new Error('Graph alias ownership mismatch');
      const incident = new Map([...subjects, ...objects].map((doc) => [doc.ref.path, doc]));
      if (incident.size + aliases.length + 2 > MERGE_WRITE_LIMIT)
        throw new Error('Knowledge date re-key write bound reached');
      for (const doc of incident.values()) {
        const row = decodeRecord<Relation>(doc.data());
        if (row.agentId !== agentId) throw new Error('Graph relation ownership mismatch');
        tx.update(doc.ref, {
          subjectEntityId: row.subjectEntityId === entity.id ? targetId : row.subjectEntityId,
          objectEntityId: row.objectEntityId === entity.id ? targetId : row.objectEntityId,
        });
      }
      for (const alias of aliases) tx.update(alias.ref, { entityId: targetId });
      const { id: _previous, ...rest } = entity;
      tx.create(
        targetRef,
        encodeRecord({
          ...rest,
          id: targetId,
          canonicalKey: input.canonicalKey,
          label: input.label,
          updatedAt: now,
        }),
      );
      tx.delete(sourceRef);
      return 'updated';
    });
  }

  async searchEntities(
    agentId: string,
    input: { query: string; excludeId?: string; kind?: string; limit: number },
  ): Promise<KnowledgeWorkspaceEntity[]> {
    await assertConfiguredOwner(this.store, agentId);
    const query = input.query.toLocaleLowerCase();
    const rows: Entity[] = [];
    await scan(
      this.store
        .collection('knowledgeGraphEntities')
        .where('agentId', '==', agentId)
        .select('id', 'agentId', 'label', 'preferredLabel', 'kind', 'canonicalKey') as Query,
      ENTITY_LIMIT,
      'entity',
      (doc) => {
        const row = ownedEntity(doc, agentId);
        if (
          row &&
          row.id !== input.excludeId &&
          (!input.kind || row.kind === input.kind) &&
          (!query || displayLabel(row).toLocaleLowerCase().includes(query))
        )
          rows.push(row);
      },
    );
    return rows
      .map((row) => ({
        id: row.id,
        label: displayLabel(row),
        kind: row.kind,
        canonicalKey: row.canonicalKey,
      }))
      .sort(
        (a, b) =>
          a.label.toLocaleLowerCase().localeCompare(b.label.toLocaleLowerCase()) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, input.limit);
  }
}
