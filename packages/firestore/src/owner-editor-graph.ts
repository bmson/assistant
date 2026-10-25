import type { OwnerEditorPeopleReadSnapshot } from '@assistant/persistence';
import {
  canonicalizeKnowledgeAssertionDirection,
  knowledgeAssertionId,
  knowledgeAssertionSemanticKey,
  type OwnerEditorFamilyFields,
  ownerEditorSnapshotRevision,
  type Records,
} from '@assistant/persistence';
import { ownerFamilyEditorProjection } from '@assistant/persistence/owner-family-scope';
import { type DocumentSnapshot, Timestamp, type Transaction } from '@google-cloud/firestore';
import { assertConfiguredOwner } from './knowledge-graph-read.js';
import { decodeMemoryRecord } from './memory-record.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

function native(snapshot: DocumentSnapshot) {
  if (!snapshot.exists || !snapshot.updateTime)
    throw new Error('Editor snapshot has no native revision');
  return {
    id: snapshot.id,
    seconds: snapshot.updateTime.seconds,
    nanoseconds: snapshot.updateTime.nanoseconds,
  };
}
function row<T extends { id: string }>(snapshot: DocumentSnapshot): T {
  const value = decodeRecord<T>(snapshot.data());
  if (
    !snapshot.exists ||
    !value ||
    typeof value.id !== 'string' ||
    documentKey(value.id) !== snapshot.id
  )
    throw new Error('Editor snapshot identity mismatch');
  return value;
}
export async function firestoreOwnerEditorContext(store: InstallationStore, ownerId: string) {
  await assertConfiguredOwner(store, ownerId);
  const owner = await store.doc('agents', ownerId).get();
  if (!owner.exists || owner.get('id') !== ownerId) throw new Error('Configured owner changed');
  return {
    agentId: ownerId,
    timeZone: owner.get('timezone') || 'UTC',
    locale: owner.get('locale') || 'en',
  };
}
export async function readFirestoreOwnerEditorContact(
  store: InstallationStore,
  ownerId: string,
  id: string,
  tx?: Transaction,
) {
  const ref = store.doc('contacts', id);
  const doc = tx ? await tx.get(ref) : await ref.get();
  if (!doc.exists) return null;
  if (!doc.updateTime) throw new Error('Editor contact revision unavailable');
  const contact = row<Records['contacts']>(doc);
  if (
    typeof contact.name !== 'string' ||
    !contact.name.trim() ||
    typeof contact.trust !== 'string' ||
    !Array.isArray(contact.aliases) ||
    !contact.aliases.every((alias) => typeof alias === 'string')
  )
    throw new Error('Editor contact identity is malformed');
  if (doc.get('agentId') !== undefined && doc.get('agentId') !== ownerId) return null;
  return {
    ...contact,
    revision: ownerEditorSnapshotRevision({
      driver: 'firestore',
      ownerId,
      id: doc.id,
      updateTime: { seconds: doc.updateTime.seconds, nanoseconds: doc.updateTime.nanoseconds },
    }),
  };
}
export async function readFirestoreOwnerEditorGraphScope(
  store: InstallationStore,
  ownerId: string,
  relationId: string,
  tx?: Transaction,
) {
  const relationRef = store.doc('knowledgeGraphRelations', relationId);
  const targetDoc = tx ? await tx.get(relationRef) : await relationRef.get();
  if (!targetDoc.exists) return null;
  const relation = row<Records['knowledgeGraphRelations']>(targetDoc);
  if (relation.agentId !== ownerId || !relation.assertionId) return null;
  const sourceRef = store.doc('memories', relation.sourceMemoryId),
    assertionRef = store.doc('knowledgeGraphAssertions', relation.assertionId);
  const [sourceDoc, assertionDoc] = await Promise.all([
    tx ? tx.get(sourceRef) : sourceRef.get(),
    tx ? tx.get(assertionRef) : assertionRef.get(),
  ]);
  if (!sourceDoc.exists || !assertionDoc.exists) return null;
  const source = decodeMemoryRecord(sourceDoc.data()),
    assertion = row<Records['knowledgeGraphAssertions']>(assertionDoc);
  if (
    source.id !== relation.sourceMemoryId ||
    documentKey(source.id) !== sourceDoc.id ||
    source.agentId !== ownerId ||
    assertion.agentId !== ownerId
  )
    return null;
  const queries = [
    store
      .collection('knowledgeGraphAssertionEvidence')
      .where('assertionId', '==', assertion.id)
      .limit(2),
    store.collection('knowledgeGraphRelations').where('sourceMemoryId', '==', source.id).limit(2),
    store.collection('knowledgeGraphRelations').where('assertionId', '==', assertion.id).limit(2),
  ];
  const pages = await Promise.all(queries.map((query) => (tx ? tx.get(query) : query.get())));
  if (pages.some((page) => page.size !== page.docs.length || page.size > 2))
    throw new Error('Editor evidence read limit');
  const [evidencePage, sourcePage, canonicalPage] = pages;
  if (!evidencePage || !sourcePage || !canonicalPage)
    throw new Error('Incomplete editor evidence page');
  return firestoreGraphScope(ownerId, targetDoc, sourceDoc, assertionDoc, pages);
}
function firestoreGraphScope(
  ownerId: string,
  targetDoc: DocumentSnapshot,
  sourceDoc: DocumentSnapshot,
  assertionDoc: DocumentSnapshot,
  pages: { docs: DocumentSnapshot[] }[],
) {
  const relation = row<Records['knowledgeGraphRelations']>(targetDoc);
  const source = decodeMemoryRecord(sourceDoc.data());
  const assertion = row<Records['knowledgeGraphAssertions']>(assertionDoc);
  const [evidencePage, sourcePage, canonicalPage] = pages;
  if (!evidencePage || !sourcePage || !canonicalPage) throw new Error('Incomplete editor proof');
  const evidence = evidencePage.docs.map((doc) =>
    row<Records['knowledgeGraphAssertionEvidence']>(doc),
  );
  const sourceRelations = sourcePage.docs.map((doc) =>
    row<Records['knowledgeGraphRelations']>(doc),
  );
  const canonicalRelations = canonicalPage.docs.map((doc) =>
    row<Records['knowledgeGraphRelations']>(doc),
  );
  const rawFrom = sourceDoc.get('validFrom'),
    rawUntil = sourceDoc.get('validUntil');
  const sourcePrecisionLossless = [rawFrom, rawUntil].every(
    (value) => value === null || (value instanceof Timestamp && value.nanoseconds === 0),
  );
  const exact = [
    native(targetDoc),
    native(sourceDoc),
    native(assertionDoc),
    ...pages.flatMap((page) => page.docs.map(native)),
  ];
  return {
    ownerId,
    relation,
    source,
    assertion,
    evidence,
    sourceRelations,
    canonicalRelations,
    sourcePrecisionLossless,
    native: exact,
    revision: ownerEditorSnapshotRevision({ driver: 'firestore', ownerId, native: exact }),
  };
}
export async function readFirestoreOwnerEditorFamily(
  store: InstallationStore,
  ownerId: string,
  fields: OwnerEditorFamilyFields,
  targetId?: string,
  tx?: Transaction,
) {
  if (!tx) await assertConfiguredOwner(store, ownerId);
  const [subject, object] = await Promise.all([
    readFirestoreOwnerEditorContact(store, ownerId, fields.subjectContactId, tx),
    readFirestoreOwnerEditorContact(store, ownerId, fields.objectContactId, tx),
  ]);
  if (!subject || !object || subject.id === object.id) return null;
  const keys = [`contact:${subject.id}`, `contact:${object.id}`];
  // Reuse the existing canonical-key equality query shape; no new composite
  // index or implicit whole-directory resolution is needed for exact contacts.
  const pages = await Promise.all(
    keys.map(async (key) => {
      const entityQuery = store
        .collection('knowledgeGraphEntities')
        .where('agentId', '==', ownerId)
        .where('canonicalKey', '==', key)
        .limit(2);
      const aliasQuery = store
        .collection('knowledgeGraphEntityAliases')
        .where('agentId', '==', ownerId)
        .where('canonicalKey', '==', key)
        .limit(1);
      return Promise.all([
        tx ? tx.get(entityQuery) : entityQuery.get(),
        tx ? tx.get(aliasQuery) : aliasQuery.get(),
      ]);
    }),
  );
  if (
    pages.some(
      ([entities, aliases]) =>
        entities.size !== entities.docs.length || entities.size > 1 || aliases.size > 0,
    )
  )
    return null;
  const entities = pages.flatMap(([page]) =>
    page.docs.map((doc) => row<Records['knowledgeGraphEntities']>(doc)),
  );
  if (
    entities.some(
      (entity) =>
        entity.agentId !== ownerId ||
        entity.kind !== 'person' ||
        entity.canonicalKey !== `contact:${entity.contactId}`,
    )
  )
    return null;
  const left = entities.find((entity) => entity.contactId === subject.id),
    right = entities.find((entity) => entity.contactId === object.id);
  let canonicalRevision: string | null = null,
    canonicalConflict = false;
  let canonicalIds: { assertionId: string; relationId: string; memoryId: string } | null = null;
  if (left && right) {
    const meaning = canonicalizeKnowledgeAssertionDirection({
      subjectEntityId: left.id,
      objectEntityId: right.id,
      predicate: fields.predicate,
      assertion: {
        tense: fields.timing,
        polarity: 'positive' as const,
        modality: 'asserted' as const,
      },
      ...fields.validity,
    });
    const id = knowledgeAssertionId(ownerId, knowledgeAssertionSemanticKey(ownerId, meaning));
    const ref = store.doc('knowledgeGraphAssertions', id);
    const doc = tx ? await tx.get(ref) : await ref.get();
    if (doc.exists) {
      const assertion = row<Records['knowledgeGraphAssertions']>(doc);
      canonicalRevision = ownerEditorSnapshotRevision({
        driver: 'firestore',
        ownerId,
        native: native(doc),
      });
      canonicalConflict =
        assertion.agentId !== ownerId ||
        assertion.lifecycle !== 'current' ||
        assertion.reviewStatus !== 'confirmed' ||
        assertion.reviewedRevision !== assertion.semanticRevision ||
        assertion.reviewedPayloadHash !== assertion.semanticKey;
      const query = store
        .collection('knowledgeGraphRelations')
        .where('agentId', '==', ownerId)
        .where('assertionId', '==', id)
        .limit(1);
      const links = tx ? await tx.get(query) : await query.get();
      const link = links.docs[0];
      if (links.size === 1 && link) {
        const relation = row<Records['knowledgeGraphRelations']>(link);
        canonicalIds = {
          assertionId: id,
          relationId: relation.id,
          memoryId: relation.sourceMemoryId,
        };
      } else canonicalConflict = true;
    }
  }
  const canonicalScope = canonicalIds
    ? await readFirestoreOwnerEditorGraphScope(store, ownerId, canonicalIds.relationId, tx)
    : null;
  const target = targetId
    ? await readFirestoreOwnerEditorGraphScope(store, ownerId, targetId, tx)
    : null;
  return {
    subject,
    object,
    canonicalRevision,
    canonicalConflict,
    canonicalIds,
    canonicalScope,
    target,
    entities,
    fields,
  };
}

/** Fixed fanout: <=500 contacts, <=120 targets, <=240 rows per proof stream. No per-target queries. */
export async function firestoreOwnerEditorViewSnapshot(
  store: InstallationStore,
  ownerId: string,
  input: { contactId?: string; relationIds?: readonly string[] } = {},
  tx?: Transaction,
): Promise<OwnerEditorPeopleReadSnapshot> {
  if (!tx) {
    await assertConfiguredOwner(store, ownerId);
    return store.db.runTransaction((transaction) =>
      firestoreOwnerEditorViewSnapshot(store, ownerId, input, transaction),
    );
  }
  let raw = 0,
    rpc = 0;
  const charge = (count: number) => {
    raw += count;
    if (raw > 2048 || rpc > 64) throw new Error('Editor snapshot read limit');
  };
  const query = async (
    q: ReturnType<InstallationStore['collection']> | import('@google-cloud/firestore').Query,
  ) => {
    if (++rpc > 64) throw new Error('Editor snapshot read limit');
    const page = tx ? await tx.get(q) : await q.get();
    charge(page.docs.length);
    if (page.size !== page.docs.length) throw new Error('Malformed editor page');
    return page.docs;
  };
  const get = async (collection: string, ids: readonly string[]) => {
    if (!ids.length) return [];
    if (ids.length > 300 || ++rpc > 64) throw new Error('Editor snapshot read limit');
    // Charge missing snapshots before decoding; point batches never hide absent records.
    const refs = ids.map((id) => store.doc(collection, id));
    const docs = tx ? await tx.getAll(...refs) : await store.db.getAll(...refs);
    charge(docs.length);
    return docs;
  };
  const ids = [...new Set(input.relationIds ?? [])];
  if (ids.length > 120) throw new Error('Editor snapshot read limit');
  const contactDocs = await query(store.collection('contacts').limit(501));
  if (contactDocs.length > 500) throw new Error('Editor snapshot read limit');
  const people = contactDocs.map((doc) => {
    const value = row<Records['contacts']>(doc);
    if (
      (doc.get('agentId') !== undefined && doc.get('agentId') !== ownerId) ||
      typeof value.name !== 'string' ||
      !value.name.trim() ||
      typeof value.trust !== 'string' ||
      !Array.isArray(value.aliases) ||
      !value.aliases.every((alias) => typeof alias === 'string')
    )
      throw new Error('Malformed editor contact');
    const stamp = native(doc);
    return {
      ...value,
      revision: ownerEditorSnapshotRevision({
        driver: 'firestore',
        ownerId,
        id: stamp.id,
        updateTime: { seconds: stamp.seconds, nanoseconds: stamp.nanoseconds },
      }),
    };
  });
  const result: OwnerEditorPeopleReadSnapshot = {
    ownerId,
    people: people
      .filter((p) => p.trust !== 'owner')
      .map((p) => ({ contactId: p.id, name: p.name, revision: p.revision })),
    identity: null,
    corrections: [],
  };
  const identity = people.find((p) => p.id === input.contactId && p.trust !== 'owner');
  if (identity)
    result.identity = {
      contactId: identity.id,
      name: identity.name,
      aliases: identity.aliases,
      trust: identity.trust,
      revision: identity.revision,
    };
  const targetDocs = (await get('knowledgeGraphRelations', ids)).filter((doc) => doc.exists);
  const targets = targetDocs.map((doc) => row<Records['knowledgeGraphRelations']>(doc));
  if (targets.some((t) => t.agentId !== ownerId)) throw new Error('Foreign editor relation');
  const sourceIds = [...new Set(targets.map((t) => t.sourceMemoryId))],
    assertionIds = [...new Set(targets.flatMap((t) => (t.assertionId ? [t.assertionId] : [])))];
  const [sources, assertions, entityDocs] = await Promise.all([
    get('memories', sourceIds),
    get('knowledgeGraphAssertions', assertionIds),
    get('knowledgeGraphEntities', [
      ...new Set(targets.flatMap((t) => [t.subjectEntityId, t.objectEntityId])),
    ]),
  ]);
  const proof = async (collection: string, field: string, keys: string[]) => {
    const docs: DocumentSnapshot[] = [];
    for (let i = 0; i < keys.length; i += 30) {
      const page = await query(
        store
          .collection(collection)
          .where(field, 'in', keys.slice(i, i + 30))
          .orderBy('__name__')
          .limit(241 - docs.length),
      );
      docs.push(...page);
      if (docs.length > 240) throw new Error('Editor snapshot read limit');
    }
    return docs;
  };
  const [evidence, sourceRelations, canonicalRelations] = await Promise.all([
    proof('knowledgeGraphAssertionEvidence', 'assertionId', assertionIds),
    proof('knowledgeGraphRelations', 'sourceMemoryId', sourceIds),
    proof('knowledgeGraphRelations', 'assertionId', assertionIds),
  ]);
  const entities = entityDocs
    .filter((d) => d.exists)
    .map((d) => row<Records['knowledgeGraphEntities']>(d));
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i],
      targetDoc = targetDocs[i];
    if (!target || !targetDoc || !target.assertionId) continue;
    const source = sources.find((d) => d.exists && d.id === documentKey(target.sourceMemoryId)),
      assertion = assertions.find(
        (d) => d.exists && d.id === documentKey(target.assertionId ?? ''),
      );
    if (!source || !assertion) continue;
    const scope = firestoreGraphScope(ownerId, targetDoc, source, assertion, [
      { docs: evidence.filter((d) => d.get('assertionId') === target.assertionId) },
      { docs: sourceRelations.filter((d) => d.get('sourceMemoryId') === target.sourceMemoryId) },
      { docs: canonicalRelations.filter((d) => d.get('assertionId') === target.assertionId) },
    ]);
    const correction = ownerFamilyEditorProjection(scope, entities, people);
    if (correction) result.corrections.push(correction);
  }
  return result;
}
