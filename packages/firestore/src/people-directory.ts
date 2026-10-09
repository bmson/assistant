import type { ProfileContact, Records } from '@assistant/persistence';
import { FieldPath, type Query } from '@google-cloud/firestore';
import { decodeMemoryRecord } from './memory-record.js';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { FirestoreProfilePeopleReadRepository } from './profile-people-read.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 400;
const MAX_ROWS = 100_000;
type MemoryDirectoryRow = Pick<
  Records['memories'],
  | 'id'
  | 'agentId'
  | 'subjectContactId'
  | 'category'
  | 'quarantined'
  | 'expiresAt'
  | 'createdAt'
  | 'validFrom'
  | 'contentHash'
>;

const MEMORY_DIRECTORY_FIELDS = [
  'id',
  'agentId',
  'subjectContactId',
  'category',
  'quarantined',
  'expiresAt',
  'createdAt',
  'validFrom',
  'contentHash',
];

async function byAgentValues<T extends { id: string; agentId: string }>(
  store: InstallationStore,
  collection: string,
  agentId: string,
  field: string,
  values: string[],
  fields?: string[],
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < values.length; offset += 30) {
    const selectedValues = values.slice(offset, offset + 30);
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query: Query = store
        .collection(collection)
        .where('agentId', '==', agentId)
        .where(field, 'in', selectedValues)
        .orderBy(FieldPath.documentId());
      if (fields) query = query.select(...fields);
      query = query.limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = decodeRecord<T>(doc.data());
        if (row.agentId !== agentId || !row.id || documentKey(row.id) !== doc.id)
          throw new Error(`People directory has a malformed ${collection} record`);
        rows.push(row);
      }
      if (rows.length > MAX_ROWS) throw new Error('People directory scan exceeds its limit');
      if (page.size < PAGE_SIZE) break;
      cursor = page.docs.at(-1);
    }
  }
  return rows;
}

export interface FirestorePersonDirectoryRow {
  contact: ProfileContact;
  factCount: number;
  birthday: Records['occasions'] | null;
  lastContactAt: Date | null;
  location: string | null;
}

const date = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());
const nullableDate = (value: unknown): value is Date | null => value === null || date(value);
const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function validateProjectionRows(
  memories: MemoryDirectoryRow[],
  occasions: Records['occasions'][],
  entities: Records['knowledgeGraphEntities'][],
  relations: Records['knowledgeGraphRelations'][],
): void {
  if (
    memories.some(
      (row) =>
        !nullableString(row.subjectContactId) ||
        typeof row.category !== 'string' ||
        typeof row.quarantined !== 'boolean' ||
        !nullableDate(row.expiresAt) ||
        !date(row.createdAt) ||
        !nullableDate(row.validFrom) ||
        typeof row.contentHash !== 'string',
    ) ||
    occasions.some(
      (row) =>
        typeof row.contactId !== 'string' ||
        typeof row.kind !== 'string' ||
        typeof row.quarantined !== 'boolean' ||
        !Number.isInteger(row.month) ||
        row.month < 1 ||
        row.month > 12 ||
        !Number.isInteger(row.day) ||
        row.day < 1 ||
        row.day > 31 ||
        (row.year !== null && !Number.isInteger(row.year)),
    ) ||
    entities.some(
      (row) =>
        !nullableString(row.contactId) ||
        typeof row.label !== 'string' ||
        !nullableString(row.preferredLabel),
    ) ||
    relations.some(
      (row) =>
        typeof row.subjectEntityId !== 'string' ||
        typeof row.objectEntityId !== 'string' ||
        typeof row.sourceMemoryId !== 'string' ||
        typeof row.predicate !== 'string' ||
        !nullableString(row.validUntil) ||
        typeof row.reviewStatus !== 'string' ||
        !nullableString(row.evidenceQuote),
    )
  )
    throw new Error('People directory contains a malformed projection record');
}

async function assertConfiguredOwner(store: InstallationStore, agentId: string): Promise<void> {
  const agents = await store.collection('agents').limit(2).get();
  const owner = agents.docs[0];
  if (
    !agentId ||
    agents.size !== 1 ||
    !owner ||
    owner.get('id') !== agentId ||
    owner.id !== documentKey(agentId)
  )
    throw new Error('People directory requires exactly one configured agent');
}

/** Complete contact directory; richer dossier data is not part of this read. */
export async function getFirestorePeopleDirectory(
  store: InstallationStore,
  configuredAgentId: string,
): Promise<ProfileContact[]> {
  await assertConfiguredOwner(store, configuredAgentId);
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const contacts = await new FirestoreProfilePeopleReadRepository(
    store,
    configuredAgentId,
  ).listContacts();
  if (
    contacts.some(
      (contact) =>
        !contact.id ||
        typeof contact.name !== 'string' ||
        typeof contact.relationship !== 'string' ||
        typeof contact.trust !== 'string',
    )
  )
    throw new Error('People directory contains a malformed contact');
  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return contacts.filter((contact) => contact.trust !== 'owner');
}

/** One saved contact; SQL graph, events, and mutation controls are not available here. */
export async function getFirestorePersonDetail(
  store: InstallationStore,
  configuredAgentId: string,
  contactId: string,
): Promise<ProfileContact | null> {
  await assertConfiguredOwner(store, configuredAgentId);
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const contact = await new FirestoreProfilePeopleReadRepository(
    store,
    configuredAgentId,
  ).getContact(contactId);
  if (
    contact &&
    (!contact.id ||
      typeof contact.name !== 'string' ||
      typeof contact.relationship !== 'string' ||
      typeof contact.trust !== 'string')
  )
    throw new Error('People detail contains a malformed contact');
  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return contact?.trust === 'owner' ? null : contact;
}

/** Mobile directory fields derived from the same owner-scoped Firestore records as SQL. */
export async function getFirestoreMobilePeopleDirectory(
  store: InstallationStore,
  configuredAgentId: string,
  now: Date,
  extractionVersion: number,
  contactsOverride?: ProfileContact[],
): Promise<FirestorePersonDirectoryRow[]> {
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const contacts =
    contactsOverride ?? (await getFirestorePeopleDirectory(store, configuredAgentId)).slice(0, 500);
  if (contacts.length === 0) {
    await assertConfiguredOwner(store, configuredAgentId);
    await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
    return [];
  }
  const contactIds = new Set(contacts.map((contact) => contact.id));
  const [memories, occasions, personEntities] = await Promise.all([
    // The full embedding vector is only needed for a small set of location
    // relation sources. Avoid transferring it with every directory fact.
    byAgentValues<MemoryDirectoryRow>(
      store,
      'memories',
      configuredAgentId,
      'subjectContactId',
      [...contactIds],
      MEMORY_DIRECTORY_FIELDS,
    ),
    byAgentValues<Records['occasions']>(store, 'occasions', configuredAgentId, 'contactId', [
      ...contactIds,
    ]),
    byAgentValues<Records['knowledgeGraphEntities']>(
      store,
      'knowledgeGraphEntities',
      configuredAgentId,
      'contactId',
      [...contactIds],
    ),
  ]);
  const relations = await byAgentValues<Records['knowledgeGraphRelations']>(
    store,
    'knowledgeGraphRelations',
    configuredAgentId,
    'subjectEntityId',
    personEntities.map((entity) => entity.id),
  );
  const entityIds = new Set(personEntities.map((entity) => entity.id));
  const relatedObjectIds = [
    ...new Set(
      relations.map((relation) => relation.objectEntityId).filter((id) => !entityIds.has(id)),
    ),
  ];
  const relatedEntities: Records['knowledgeGraphEntities'][] = [];
  for (let offset = 0; offset < relatedObjectIds.length; offset += 200) {
    const ids = relatedObjectIds.slice(offset, offset + 200);
    const snapshots = await store.db.getAll(
      ...ids.map((id) => store.doc('knowledgeGraphEntities', id)),
    );
    for (const snapshot of snapshots) {
      if (!snapshot.exists) continue;
      const entity = decodeRecord<Records['knowledgeGraphEntities']>(snapshot.data());
      if (
        entity.agentId !== configuredAgentId ||
        !entity.id ||
        documentKey(entity.id) !== snapshot.id
      )
        throw new Error('People directory has a malformed knowledge graph entity');
      relatedEntities.push(entity);
    }
  }
  if (relatedEntities.length + personEntities.length > MAX_ROWS)
    throw new Error('People directory scan exceeds its limit');
  const entities = [...personEntities, ...relatedEntities];
  validateProjectionRows(memories, occasions, entities, relations);
  const active = (memory: MemoryDirectoryRow) =>
    memory.quarantined === false &&
    (memory.expiresAt === null || (memory.expiresAt instanceof Date && memory.expiresAt > now));
  const factCounts = new Map<string, number>();
  const lastContacts = new Map<string, Date>();
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  for (const memory of memories) {
    const id = memory.subjectContactId;
    if (!id || !contactIds.has(id) || !active(memory)) continue;
    if (memory.category === 'knowledge') factCounts.set(id, (factCounts.get(id) ?? 0) + 1);
    if (memory.category === 'experience') {
      const occurredAt = memory.validFrom ?? memory.createdAt;
      if (!(occurredAt instanceof Date))
        throw new Error('People directory has an invalid event date');
      const previous = lastContacts.get(id);
      if (!previous || occurredAt > previous) lastContacts.set(id, occurredAt);
    }
  }
  const birthdays = new Map<string, Records['occasions']>();
  for (const occasion of occasions.sort(
    (a, b) => a.month - b.month || a.day - b.day || a.id.localeCompare(b.id),
  )) {
    if (
      occasion.kind === 'birthday' &&
      !occasion.quarantined &&
      contactIds.has(occasion.contactId) &&
      !birthdays.has(occasion.contactId)
    )
      birthdays.set(occasion.contactId, occasion);
  }
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const activeLocationRelations = relations.filter(
    (relation) =>
      relation.predicate === 'lives_in' &&
      relation.validUntil === null &&
      relation.reviewStatus !== 'rejected' &&
      relation.evidenceQuote != null &&
      contactIds.has(entityById.get(relation.subjectEntityId)?.contactId ?? ''),
  );
  const sourceIds = [
    ...new Set(
      activeLocationRelations
        .map((relation) => relation.sourceMemoryId)
        .filter((id) => memoryById.has(id)),
    ),
  ];
  const sourceIdByDocument = new Map(sourceIds.map((id) => [documentKey(id), id]));
  const sources = new Map<string, Records['knowledgeGraphSources']>();
  const locationMemories = new Map<string, Records['memories']>();
  for (let offset = 0; offset < sourceIds.length; offset += 200) {
    const ids = sourceIds.slice(offset, offset + 200);
    const [docs, memoryDocs] = await Promise.all([
      store.db.getAll(...ids.map((id) => store.doc('knowledgeGraphSources', id))),
      store.db.getAll(...ids.map((id) => store.doc('memories', id))),
    ]);
    for (const doc of docs) {
      if (!doc.exists) continue;
      const source = decodeRecord<Records['knowledgeGraphSources']>(doc.data());
      if (
        source.memoryId !== sourceIdByDocument.get(doc.id) ||
        typeof source.status !== 'string' ||
        typeof source.contentHash !== 'string' ||
        !Number.isSafeInteger(source.extractionVersion) ||
        source.extractionVersion < 0
      )
        throw new Error('People directory has a malformed graph source');
      sources.set(source.memoryId, source);
    }
    for (const doc of memoryDocs) {
      if (!doc.exists) continue;
      const memory = decodeMemoryRecord(doc.data());
      if (
        memory.id !== sourceIdByDocument.get(doc.id) ||
        memory.agentId !== configuredAgentId ||
        (memory.embedding !== null &&
          (!Array.isArray(memory.embedding) ||
            memory.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))))
      )
        throw new Error('People directory has a malformed location memory');
      if (memory.contentHash === memoryById.get(memory.id)?.contentHash)
        locationMemories.set(memory.id, memory);
    }
  }
  const locations = new Map<string, string>();
  for (const relation of activeLocationRelations.sort((a, b) => a.id.localeCompare(b.id))) {
    const subject = entityById.get(relation.subjectEntityId);
    const object = entityById.get(relation.objectEntityId);
    const memory = locationMemories.get(relation.sourceMemoryId);
    const source = sources.get(relation.sourceMemoryId);
    if (
      !subject?.contactId ||
      !object ||
      !memory ||
      !source ||
      memory.category !== 'knowledge' ||
      !active(memory) ||
      !memory.embedding ||
      source.status !== 'ready' ||
      source.contentHash !== memory.contentHash ||
      source.extractionVersion < extractionVersion ||
      locations.has(subject.contactId)
    )
      continue;
    locations.set(subject.contactId, object.preferredLabel ?? object.label);
  }
  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return contacts.map((contact) => ({
    contact,
    factCount: factCounts.get(contact.id) ?? 0,
    birthday: birthdays.get(contact.id) ?? null,
    lastContactAt: lastContacts.get(contact.id) ?? null,
    location: locations.get(contact.id) ?? null,
  }));
}

/** Reads and enriches one owner directory page without scanning all contacts. */
export async function getFirestoreMobilePeopleDirectoryPage(
  store: InstallationStore,
  configuredAgentId: string,
  now: Date,
  extractionVersion: number,
  input: { limit: number; after?: { name: string; id: string } },
) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new Error('People page size must be between 1 and 100');
  if (
    input.after &&
    (typeof input.after.name !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.after.id))
  )
    throw new Error('Invalid people continuation');
  await assertConfiguredOwner(store, configuredAgentId);
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  let query = store
    .collection('contacts')
    .orderBy('name', 'asc')
    .orderBy(FieldPath.documentId(), 'asc');
  if (input.after) query = query.startAfter(input.after.name, documentKey(input.after.id));
  const rawPageLimit = input.limit + 2;
  const snapshot = await query.limit(rawPageLimit).get();
  const rows = snapshot.docs.map((doc) => {
    const contact = decodeRecord<ProfileContact>(doc.data());
    if (
      !contact.id ||
      documentKey(contact.id) !== doc.id ||
      typeof contact.name !== 'string' ||
      typeof contact.relationship !== 'string' ||
      typeof contact.trust !== 'string'
    )
      throw new Error('People directory contains a malformed contact');
    return contact;
  });
  const eligible = rows.filter((contact) => contact.trust !== 'owner');
  const selected = eligible.slice(0, input.limit);
  const hasMore = eligible.length > input.limit || snapshot.size === rawPageLimit;
  const items = await getFirestoreMobilePeopleDirectory(
    store,
    configuredAgentId,
    now,
    extractionVersion,
    selected,
  );
  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  const tail = selected.length === input.limit ? selected.at(-1) : rows.at(-1);
  return {
    people: items,
    hasMore,
    nextCursor: hasMore && tail ? { name: tail.name, id: tail.id } : null,
  };
}
