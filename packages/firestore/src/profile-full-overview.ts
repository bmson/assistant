import type {
  ProfileOverviewRead,
  ProfileOverviewRepository,
  Records,
} from '@assistant/persistence';
import { FieldPath, type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { decodeMemoryRecord } from './memory-record.js';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { FirestoreProfileVoiceOverviewRepository } from './profile-overview.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 1000;
const MAX_SCAN = 100_000;
const PROFILE_CONTACT_LIMIT = 500;
const PROFILE_FACT_LIMIT = 250;
const QUARANTINE_LIMIT = 100;

/** Exact scan with projected rows; keep one page at a time until durable counters are validated. */
async function scanPages(
  query: Query,
  collection: string,
  visit: (doc: QueryDocumentSnapshot) => void,
): Promise<void> {
  let cursor: QueryDocumentSnapshot | undefined;
  let scanned = 0;
  while (true) {
    let page = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    scanned += snapshot.size;
    if (scanned > MAX_SCAN)
      throw new Error(`Profile ${collection} scan exceeds its explicit limit`);
    for (const doc of snapshot.docs) visit(doc);
    if (snapshot.size < PAGE_SIZE) return;
    cursor = snapshot.docs.at(-1);
  }
}

function contactView(row: Records['contacts']) {
  return {
    id: row.id,
    name: row.name,
    aliases: row.aliases,
    relationship: row.relationship,
    trust: row.trust,
  };
}

function memoryFact(row: Records['memories']): ProfileOverviewRead['ownerFacts'][number] {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    domain: row.domain,
    confidence: row.confidence,
    importance: row.importance,
    ownerConfirmed: row.ownerConfirmed,
    pinned: row.pinned,
    lastConsolidatedAt: row.lastConsolidatedAt,
    originTrust: row.originTrust,
    sourceTaskId: row.sourceTaskId,
    createdAt: row.createdAt,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
  };
}

function ownerFactOrder(left: Records['memories'], right: Records['memories']): number {
  return (
    Number(right.pinned) - Number(left.pinned) ||
    right.importance - left.importance ||
    Number(right.confidence) - Number(left.confidence) ||
    left.id.localeCompare(right.id)
  );
}

async function hydrateMemories(
  store: InstallationStore,
  agentId: string,
  rows: Records['memories'][],
): Promise<Map<string, Records['memories']>> {
  const hydrated = new Map<string, Records['memories']>();
  const refs = rows.map((row) => store.doc('memories', row.id));
  const batches: (typeof refs)[] = [];
  for (let offset = 0; offset < refs.length; offset += 100)
    batches.push(refs.slice(offset, offset + 100));
  // Only the fields the Profile shows and the change check compares. A memory
  // document also carries its embedding (1,536 numbers), which this view never
  // reads and which made 250 facts several megabytes to fetch. Batches run side
  // by side instead of in turn.
  const fieldMask = [
    'id',
    'content',
    ...PROFILE_MEMORY_FIELDS,
    'embeddingSpaceKey',
    'embeddingSpace',
  ];
  const read = await Promise.all(batches.map((batch) => store.db.getAll(...batch, { fieldMask })));
  for (const snapshot of read.flat()) {
    if (!snapshot.exists) throw new Error('Profile memory changed during read');
    const row = decodeMemoryRecord(snapshot.data());
    if (!row.id || documentKey(row.id) !== snapshot.id || row.agentId !== agentId)
      throw new Error('Malformed or foreign Profile memory');
    hydrated.set(row.id, row);
  }
  return hydrated;
}

const PROFILE_MEMORY_FIELDS = [
  'agentId',
  'category',
  'expiresAt',
  'quarantined',
  'ownerConfirmed',
  'lastConsolidatedAt',
  'subjectContactId',
  'createdAt',
  'kind',
  'domain',
  'confidence',
  'importance',
  'pinned',
  'originTrust',
  'sourceTaskId',
  'validFrom',
  'validUntil',
] as const;

function profileMemoryUnchanged(
  scanned: Records['memories'],
  hydrated: Records['memories'],
): boolean {
  return (
    scanned.embeddingSpaceKey === hydrated.embeddingSpaceKey &&
    PROFILE_MEMORY_FIELDS.every((field) => {
      const before = scanned[field];
      const after = hydrated[field];
      if (before instanceof Date || after instanceof Date)
        return (
          before instanceof Date && after instanceof Date && before.getTime() === after.getTime()
        );
      return before === after;
    })
  );
}

async function configuredAgent(store: InstallationStore, pinnedAgentId?: string): Promise<string> {
  const agents = pinnedAgentId ? null : await store.collection('agents').limit(2).get();
  if (agents && (agents.size !== 1 || !agents.docs[0]))
    throw new Error('Memory hub requires exactly one configured agent');
  const agent = pinnedAgentId ? await store.doc('agents', pinnedAgentId).get() : agents?.docs[0];
  if (!agent?.exists) throw new Error('Configured Memory hub agent is missing');
  const id = agent.get('id');
  if (
    typeof id !== 'string' ||
    documentKey(id) !== agent.id ||
    (pinnedAgentId !== undefined && id !== pinnedAgentId)
  )
    throw new Error('Configured agent record is malformed');
  return id;
}

/** Complete mobile Profile read, streamed so task and memory bodies do not accumulate. */
export class FirestoreProfileOverviewRepository implements ProfileOverviewRepository {
  readonly kind = 'profile-overview-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId?: string,
  ) {}

  async load(): Promise<ProfileOverviewRead> {
    const agentId = await configuredAgent(this.store, this.configuredAgentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const now = this.store.now();

    // These do not depend on the contact or memory scans, so they run beside
    // them instead of after them. The overview used to wait for four reads in
    // turn, one of them over every task the assistant had ever created.
    const organizerRead = this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('trigger.payload.job', '==', 'memory.consolidate')
      .select('id', 'agentId', 'trigger', 'createdAt', 'status', 'progress', 'updatedAt')
      .get();
    const cardRead = this.store.doc('ownerCards', agentId).get();
    const voiceRead = new FirestoreProfileVoiceOverviewRepository(
      this.store,
      this.configuredAgentId,
    ).load();
    // Awaited below; if an earlier read throws first, these must not surface as
    // unhandled rejections on their own.
    for (const pending of [organizerRead, cardRead, voiceRead]) pending.catch(() => {});

    const contacts: Records['contacts'][] = [];
    await scanPages(
      this.store
        .collection('contacts')
        .select('id', 'name', 'aliases', 'relationship', 'trust') as Query,
      'contact',
      (doc) => {
        const row = decodeRecord<Records['contacts']>(doc.data());
        if (!row.id || documentKey(row.id) !== doc.id)
          throw new Error('Malformed Memory hub contact');
        contacts.push(row);
        if (contacts.length > PROFILE_CONTACT_LIMIT)
          throw new Error('Profile contact count exceeds the view limit');
      },
    );
    contacts.sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
    const owner = contacts.find((contact) => contact.trust === 'owner');
    const people = contacts
      .filter((contact) => contact.trust !== 'owner')
      .map((contact) => ({ contact: contactView(contact), factCount: 0 }));
    const peopleById = new Map(people.map((person) => [person.contact.id, person]));

    let totalUsable = 0;
    let notYetOrganized = 0;
    let awaitingReview = 0;
    let ownerConfirmed = 0;
    let lastOrganizedAt: Date | null = null;
    const ownerFactMetadata: Records['memories'][] = [];
    const quarantined: Array<{ row: Records['memories']; order: number }> = [];
    let memoryOrder = 0;

    await scanPages(
      this.store
        .collection('memories')
        .where('agentId', '==', agentId)
        .select(
          'id',
          'agentId',
          'category',
          'expiresAt',
          'quarantined',
          'ownerConfirmed',
          'lastConsolidatedAt',
          'subjectContactId',
          'createdAt',
          'kind',
          'domain',
          'confidence',
          'importance',
          'pinned',
          'originTrust',
          'sourceTaskId',
          'embeddingSpaceKey',
          'embeddingSpace',
          'validFrom',
          'validUntil',
        ) as Query,
      'memory',
      (doc) => {
        const row = decodeMemoryRecord(doc.data());
        if (!row.id || documentKey(row.id) !== doc.id || row.agentId !== agentId)
          throw new Error('Malformed or foreign Memory hub record');
        const unexpired = !row.expiresAt || row.expiresAt > now;
        if (row.category !== 'knowledge' || !unexpired) return;

        if (row.quarantined) {
          awaitingReview += 1;
          quarantined.push({ row, order: memoryOrder++ });
          quarantined.sort(
            (left, right) =>
              right.row.createdAt.getTime() - left.row.createdAt.getTime() ||
              left.order - right.order,
          );
          if (quarantined.length > QUARANTINE_LIMIT) quarantined.pop();
          return;
        }

        totalUsable += 1;
        if (row.ownerConfirmed) ownerConfirmed += 1;
        if (!row.lastConsolidatedAt) notYetOrganized += 1;
        else if (row.lastConsolidatedAt instanceof Date) {
          if (!lastOrganizedAt || row.lastConsolidatedAt > lastOrganizedAt)
            lastOrganizedAt = row.lastConsolidatedAt;
        }
        if (row.subjectContactId) {
          const person = peopleById.get(row.subjectContactId);
          if (person) person.factCount += 1;
        }
        if (owner && row.subjectContactId === owner.id) {
          ownerFactMetadata.push(row);
          ownerFactMetadata.sort(ownerFactOrder);
          if (ownerFactMetadata.length > PROFILE_FACT_LIMIT) ownerFactMetadata.pop();
        }
      },
    );
    const selectedQuarantined = quarantined.map(({ row }) => row);
    const selectedMemoryMetadata = [...ownerFactMetadata, ...selectedQuarantined];
    const hydratedMemories = await hydrateMemories(this.store, agentId, [
      ...new Map(selectedMemoryMetadata.map((row) => [row.id, row])).values(),
    ]);
    const ownerFacts = ownerFactMetadata.map((row) => {
      const hydrated = hydratedMemories.get(row.id);
      if (!hydrated || !profileMemoryUnchanged(row, hydrated))
        throw new Error('Profile memory changed during read');
      return hydrated;
    });

    // The newest consolidation run, from the few tasks that are one, not from a
    // scan of every task.
    let latestOrganizerSource: {
      createdAt: Date;
      projection: NonNullable<ProfileOverviewRead['latestOrganizer']>;
    } | null = null;
    for (const doc of (await organizerRead).docs) {
      const row = decodeRecord<Records['tasks']>(doc.data());
      if (!row.id || documentKey(row.id) !== doc.id || row.agentId !== agentId)
        throw new Error('Malformed or foreign Memory hub record');
      if (!latestOrganizerSource || row.createdAt > latestOrganizerSource.createdAt)
        latestOrganizerSource = {
          createdAt: row.createdAt,
          projection: {
            id: row.id,
            status: row.status,
            progress: row.progress,
            updatedAt: row.updatedAt,
          },
        };
    }

    const cardDoc = await cardRead;
    const rawCard = cardDoc.exists
      ? decodeRecord<{ agentId?: unknown; content?: unknown; compiledAt?: unknown }>(cardDoc.data())
      : null;
    if (
      rawCard &&
      (rawCard.agentId !== agentId ||
        typeof rawCard.content !== 'string' ||
        !(rawCard.compiledAt instanceof Date))
    )
      throw new Error('Malformed Memory hub owner card');
    const voice = await voiceRead;
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);

    return {
      ...(owner ? { owner: contactView(owner) } : {}),
      people,
      ownerFacts: ownerFacts.map(memoryFact),
      quarantined: selectedQuarantined.map((row) => {
        const hydrated = hydratedMemories.get(row.id);
        if (!hydrated || !profileMemoryUnchanged(row, hydrated))
          throw new Error('Profile memory changed during read');
        return memoryFact(hydrated);
      }),
      card: rawCard
        ? { content: rawCard.content as string, compiledAt: rawCard.compiledAt as Date }
        : null,
      ...voice,
      memoryHealth: {
        totalUsable,
        notYetOrganized,
        awaitingReview,
        ownerConfirmed,
        lastOrganizedAt,
      },
      latestOrganizer: latestOrganizerSource?.projection ?? null,
    };
  }
}
