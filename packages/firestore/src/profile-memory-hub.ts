import type {
  ProfileMemoryHubOverview,
  ProfileMemoryHubRepository,
  Records,
} from '@assistant/persistence';
import { FieldPath, type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { decodeMemoryRecord } from './memory-record.js';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 500;
const MAX_SCAN = 100_000;
const QUARANTINE_LIMIT = 100;
const RECALL_FEEDBACK_WINDOW_DAYS = 90;

/** Read every page or fail explicitly; overview counts must never be silently truncated. */
async function scanProfileCollection(query: Query): Promise<QueryDocumentSnapshot[]> {
  const rows: QueryDocumentSnapshot[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  while (true) {
    let page = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    rows.push(...snapshot.docs);
    if (rows.length > MAX_SCAN) throw new Error('Memory hub scan exceeds its explicit limit');
    if (snapshot.size < PAGE_SIZE) return rows;
    cursor = snapshot.docs.at(-1);
  }
}

/** Visit a complete owner collection without retaining all document bodies. */
async function visitProfileCollection(
  query: Query,
  visit: (doc: QueryDocumentSnapshot) => void,
): Promise<void> {
  let cursor: QueryDocumentSnapshot | undefined;
  let scanned = 0;
  while (true) {
    let page = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    scanned += snapshot.size;
    if (scanned > MAX_SCAN) throw new Error('Memory hub scan exceeds its explicit limit');
    for (const doc of snapshot.docs) visit(doc);
    if (snapshot.size < PAGE_SIZE) return;
    cursor = snapshot.docs.at(-1);
  }
}

function ownedProfileRow<T extends { id: string; agentId: string }>(
  doc: QueryDocumentSnapshot,
  agentId: string,
  decode: (value: unknown) => T = (value) => decodeRecord<T>(value),
): T {
  const row = decode(doc.data());
  if (!row.id || documentKey(row.id) !== doc.id || row.agentId !== agentId)
    throw new Error('Malformed or foreign Memory hub record');
  return row;
}

/** One bounded source snapshot reused by the hub and full mobile Profile. */
export interface ProfileHubSource {
  agentId: string;
  now: Date;
  contacts: Records['contacts'][];
  memories: Records['memories'][];
  feedback: Records['recallFeedback'][];
  tasks: Records['tasks'][];
  card: { content: string; compiledAt: Date } | null;
  fence: Awaited<ReturnType<typeof readPrivacyErasureFence>>;
}

export async function loadProfileHubSource(
  store: InstallationStore,
  pinnedAgentId?: string,
): Promise<ProfileHubSource> {
  const configured = pinnedAgentId ? null : await store.collection('agents').limit(2).get();
  if (configured && (configured.size !== 1 || !configured.docs[0]))
    throw new Error('Memory hub requires exactly one configured agent');
  const agentDoc = pinnedAgentId
    ? await store.doc('agents', pinnedAgentId).get()
    : configured?.docs[0];
  if (!agentDoc?.exists) throw new Error('Configured Memory hub agent is missing');
  const agentId = agentDoc.get('id');
  if (
    typeof agentId !== 'string' ||
    documentKey(agentId) !== agentDoc.id ||
    (pinnedAgentId !== undefined && agentId !== pinnedAgentId)
  )
    throw new Error('Configured agent record is malformed');
  const fence = await readPrivacyErasureFence(store, agentId);

  const [contactDocs, memoryDocs, feedbackDocs, taskDocs, cardDoc] = await Promise.all([
    scanProfileCollection(store.collection('contacts')),
    scanProfileCollection(store.collection('memories').where('agentId', '==', agentId)),
    scanProfileCollection(store.collection('recallFeedback').where('agentId', '==', agentId)),
    scanProfileCollection(store.collection('tasks').where('agentId', '==', agentId)),
    store.doc('ownerCards', agentId).get(),
  ]);
  const contacts = contactDocs.map((doc) => {
    const row = decodeRecord<Records['contacts']>(doc.data());
    if (!row.id || documentKey(row.id) !== doc.id) throw new Error('Malformed Memory hub contact');
    return row;
  });
  const memories = memoryDocs.map((doc) =>
    ownedProfileRow<Records['memories']>(doc, agentId, decodeMemoryRecord),
  );
  const feedback = feedbackDocs.map((doc) =>
    ownedProfileRow<Records['recallFeedback']>(doc, agentId),
  );
  const tasks = taskDocs.map((doc) => ownedProfileRow<Records['tasks']>(doc, agentId));
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
  const source = {
    agentId,
    now: store.now(),
    contacts,
    memories,
    feedback,
    tasks,
    card: rawCard
      ? { content: rawCard.content as string, compiledAt: rawCard.compiledAt as Date }
      : null,
    fence,
  };
  await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
  return source;
}

export function profileMemoryHubFromSource(source: ProfileHubSource): ProfileMemoryHubOverview {
  const { contacts, memories, feedback, tasks, card, now } = source;
  const owner = contacts.find((row) => row.trust === 'owner');
  const knowledge = memories.filter((row) => row.category === 'knowledge');
  const unexpired = knowledge.filter((row) => !row.expiresAt || row.expiresAt > now);
  const usable = unexpired.filter((row) => !row.quarantined);
  const organized = usable
    .map((row) => row.lastConsolidatedAt)
    .filter((date): date is Date => date instanceof Date)
    .sort((left, right) => right.getTime() - left.getTime());
  const review = unexpired.filter((row) => row.quarantined);
  const quarantined = review
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, QUARANTINE_LIMIT);
  const feedbackSince = new Date(now.getTime() - RECALL_FEEDBACK_WINDOW_DAYS * 86_400_000);
  const recentFeedback = feedback.filter((row) => row.createdAt >= feedbackSince);
  const rated = recentFeedback
    .map((row) => row.createdAt)
    .sort((a, b) => b.getTime() - a.getTime());
  const latestOrganizer = tasks
    .filter((row) => {
      const trigger = row.trigger as { payload?: { job?: unknown } } | null;
      return trigger?.payload?.job === 'memory.consolidate';
    })
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  return {
    ...(owner ? { owner } : {}),
    quarantined,
    memoryHealth: {
      totalUsable: usable.length,
      notYetOrganized: usable.filter((row) => !row.lastConsolidatedAt).length,
      awaitingReview: review.length,
      ownerConfirmed: usable.filter((row) => row.ownerConfirmed).length,
      lastOrganizedAt: organized[0] ?? null,
    },
    recallFeedback: {
      rated: recentFeedback.length,
      helpful: recentFeedback.filter((row) => row.verdict === 'helpful').length,
      notHelpful: recentFeedback.filter((row) => row.verdict === 'not_helpful').length,
      lastRatedAt: rated[0] ?? null,
      windowDays: RECALL_FEEDBACK_WINDOW_DAYS,
    },
    latestOrganizer: latestOrganizer
      ? {
          id: latestOrganizer.id,
          status: latestOrganizer.status,
          progress: latestOrganizer.progress,
          updatedAt: latestOrganizer.updatedAt,
        }
      : null,
    card: card ? { compiledAt: card.compiledAt, empty: card.content.trim() === '' } : null,
    ownerFactCount: owner ? usable.filter((row) => row.subjectContactId === owner.id).length : 0,
    peopleCount: contacts.filter((row) => row.trust !== 'owner').length,
  };
}

export class FirestoreProfileMemoryHubRepository implements ProfileMemoryHubRepository {
  readonly kind = 'profile-memory-hub-repository' as const;

  constructor(
    readonly store: InstallationStore,
    private readonly pinnedAgentId?: string,
  ) {}

  async load(): Promise<ProfileMemoryHubOverview> {
    const configured = await this.store.collection('agents').limit(2).get();
    if (configured.size !== 1 || !configured.docs[0])
      throw new Error('Memory hub requires exactly one configured agent');
    const agentDoc = configured.docs[0];
    const agentId = agentDoc.get('id');
    if (
      typeof agentId !== 'string' ||
      documentKey(agentId) !== agentDoc.id ||
      (this.pinnedAgentId !== undefined && agentId !== this.pinnedAgentId)
    )
      throw new Error('Memory hub requires one matching configured owner');

    const fence = await readPrivacyErasureFence(this.store, agentId);
    const now = this.store.now();
    let owner: Records['contacts'] | undefined;
    let peopleCount = 0;
    let totalUsable = 0;
    let notYetOrganized = 0;
    let awaitingReview = 0;
    let ownerConfirmed = 0;
    let lastOrganizedAt: Date | null = null;
    let ownerFactCount = 0;
    const quarantined: Records['memories'][] = [];
    let rated = 0;
    let helpful = 0;
    let notHelpful = 0;
    let lastRatedAt: Date | null = null;
    let latestOrganizer: Records['tasks'] | undefined;

    await visitProfileCollection(this.store.collection('contacts'), (doc) => {
      const contact = decodeRecord<Records['contacts']>(doc.data());
      if (!contact.id || documentKey(contact.id) !== doc.id)
        throw new Error('Malformed Memory hub contact');
      if (contact.trust === 'owner') owner ??= contact;
      else peopleCount += 1;
    });
    await visitProfileCollection(
      this.store.collection('memories').where('agentId', '==', agentId) as Query,
      (doc) => {
        const memory = ownedProfileRow<Records['memories']>(doc, agentId, decodeMemoryRecord);
        if (memory.category !== 'knowledge' || (memory.expiresAt && memory.expiresAt <= now))
          return;
        if (memory.quarantined) {
          awaitingReview += 1;
          quarantined.push(memory);
          quarantined.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
          if (quarantined.length > QUARANTINE_LIMIT) quarantined.pop();
          return;
        }
        totalUsable += 1;
        if (!memory.lastConsolidatedAt) notYetOrganized += 1;
        else if (memory.lastConsolidatedAt instanceof Date) {
          if (!lastOrganizedAt || memory.lastConsolidatedAt > lastOrganizedAt)
            lastOrganizedAt = memory.lastConsolidatedAt;
        }
        if (memory.ownerConfirmed) ownerConfirmed += 1;
        if (owner && memory.subjectContactId === owner.id) ownerFactCount += 1;
      },
    );
    const feedbackSince = new Date(now.getTime() - RECALL_FEEDBACK_WINDOW_DAYS * 86_400_000);
    await visitProfileCollection(
      this.store
        .collection('recallFeedback')
        .where('agentId', '==', agentId)
        .select('id', 'agentId', 'verdict', 'createdAt') as Query,
      (doc) => {
        const feedback = ownedProfileRow<Records['recallFeedback']>(doc, agentId);
        if (feedback.createdAt < feedbackSince) return;
        rated += 1;
        if (feedback.verdict === 'helpful') helpful += 1;
        if (feedback.verdict === 'not_helpful') notHelpful += 1;
        if (!lastRatedAt || feedback.createdAt > lastRatedAt) lastRatedAt = feedback.createdAt;
      },
    );
    await visitProfileCollection(
      this.store
        .collection('tasks')
        .where('agentId', '==', agentId)
        .select(
          'id',
          'agentId',
          'status',
          'progress',
          'trigger',
          'createdAt',
          'updatedAt',
        ) as Query,
      (doc) => {
        const task = ownedProfileRow<Records['tasks']>(doc, agentId);
        const trigger = task.trigger as { payload?: { job?: unknown } } | null;
        if (trigger?.payload?.job !== 'memory.consolidate') return;
        if (!latestOrganizer || task.createdAt > latestOrganizer.createdAt) latestOrganizer = task;
      },
    );
    const cardDoc = await this.store.doc('ownerCards', agentId).get();
    const card = cardDoc.exists
      ? decodeRecord<{ agentId?: unknown; content?: unknown; compiledAt?: unknown }>(cardDoc.data())
      : null;
    if (
      card &&
      (card.agentId !== agentId ||
        typeof card.content !== 'string' ||
        !(card.compiledAt instanceof Date))
    )
      throw new Error('Malformed Memory hub owner card');
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return {
      ...(owner ? { owner } : {}),
      quarantined,
      memoryHealth: {
        totalUsable,
        notYetOrganized,
        awaitingReview,
        ownerConfirmed,
        lastOrganizedAt,
      },
      recallFeedback: {
        rated,
        helpful,
        notHelpful,
        lastRatedAt,
        windowDays: RECALL_FEEDBACK_WINDOW_DAYS,
      },
      latestOrganizer: latestOrganizer
        ? {
            id: latestOrganizer.id,
            status: latestOrganizer.status,
            progress: latestOrganizer.progress,
            updatedAt: latestOrganizer.updatedAt,
          }
        : null,
      card: card
        ? { compiledAt: card.compiledAt as Date, empty: (card.content as string).trim() === '' }
        : null,
      ownerFactCount,
      peopleCount,
    };
  }
}
