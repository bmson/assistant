import type { Records } from '@assistant/persistence';
import { decodeMemoryRecord } from './memory-record.js';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const SCAN_LIMIT = 500;
const TIMELINE_LIMIT = 20;
type Occasion = Records['occasions'];

export interface FirestorePersonEvent {
  id: string;
  content: string;
  occurredAt: Date;
  dateIsRecordTime: boolean;
  kind: string;
  originTrust: string;
}

export interface FirestorePersonTemporalDetails {
  events: FirestorePersonEvent[];
  lastContactAt: Date | null;
  /** Raw, non-quarantined records for the shared application occasion presenter. */
  occasions: Occasion[];
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
    throw new Error('Person temporal read requires exactly one configured agent');
}

/**
 * Read the SQL dossier's rolling experience timeline and occasions from one installation.
 * Both queries fail closed at the scan bound rather than silently truncating newer events.
 */
export async function getFirestorePersonTemporalDetails(
  store: InstallationStore,
  configuredAgentId: string,
  contactId: string,
  now: Date,
): Promise<FirestorePersonTemporalDetails | null> {
  await assertConfiguredOwner(store, configuredAgentId);
  const fence = await readPrivacyErasureFence(store, configuredAgentId);
  const contactDoc = await store.doc('contacts', contactId).get();
  if (!contactDoc.exists) {
    await assertConfiguredOwner(store, configuredAgentId);
    await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
    return null;
  }
  const contact = decodeRecord<Records['contacts']>(contactDoc.data());
  if (
    contact.id !== contactId ||
    documentKey(contact.id) !== contactDoc.id ||
    typeof contact.trust !== 'string'
  )
    throw new Error('Person temporal read has a malformed contact');
  if (contact.trust === 'owner') {
    await assertConfiguredOwner(store, configuredAgentId);
    await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
    return null;
  }

  const [memoryDocs, occasionDocs] = await Promise.all([
    store
      .collection('memories')
      .where('agentId', '==', configuredAgentId)
      .where('subjectContactId', '==', contactId)
      .where('category', '==', 'experience')
      .limit(SCAN_LIMIT + 1)
      .get(),
    store
      .collection('occasions')
      .where('agentId', '==', configuredAgentId)
      .where('contactId', '==', contactId)
      .limit(SCAN_LIMIT + 1)
      .get(),
  ]);
  if (memoryDocs.size > SCAN_LIMIT || occasionDocs.size > SCAN_LIMIT)
    throw new Error('Person temporal read scan bound reached');

  const events = memoryDocs.docs.flatMap((doc) => {
    const row = decodeMemoryRecord(doc.data());
    if (
      row.id !== doc.get('id') ||
      documentKey(row.id) !== doc.id ||
      row.agentId !== configuredAgentId ||
      row.subjectContactId !== contactId ||
      row.category !== 'experience' ||
      !(row.createdAt instanceof Date) ||
      (row.validFrom !== null && !(row.validFrom instanceof Date)) ||
      (row.expiresAt !== null && !(row.expiresAt instanceof Date)) ||
      typeof row.quarantined !== 'boolean' ||
      typeof row.content !== 'string' ||
      typeof row.kind !== 'string' ||
      typeof row.originTrust !== 'string'
    )
      throw new Error('Person temporal read has a malformed experience');
    if (row.quarantined !== false || (row.expiresAt && row.expiresAt <= now)) return [];
    return [
      {
        id: row.id,
        content: row.content,
        occurredAt: row.validFrom ?? row.createdAt,
        dateIsRecordTime: row.validFrom === null,
        kind: row.kind,
        originTrust: row.originTrust,
      },
    ];
  });
  events.sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id),
  );

  const occasions = occasionDocs.docs.flatMap((doc) => {
    const row = decodeRecord<Occasion>(doc.data());
    if (
      row.id !== doc.get('id') ||
      documentKey(row.id) !== doc.id ||
      row.agentId !== configuredAgentId ||
      row.contactId !== contactId ||
      typeof row.kind !== 'string' ||
      typeof row.label !== 'string' ||
      !Number.isInteger(row.month) ||
      row.month < 1 ||
      row.month > 12 ||
      !Number.isInteger(row.day) ||
      row.day < 1 ||
      row.day > 31 ||
      !Number.isInteger(row.leadDays) ||
      row.leadDays < 0 ||
      (row.year !== null && !Number.isInteger(row.year)) ||
      typeof row.recurrence !== 'string' ||
      typeof row.quarantined !== 'boolean'
    )
      throw new Error('Person temporal read has a malformed occasion');
    return row.quarantined === false ? [row] : [];
  });
  occasions.sort((a, b) => a.month - b.month || a.day - b.day || a.id.localeCompare(b.id));

  await assertConfiguredOwner(store, configuredAgentId);
  await assertPrivacyErasureFenceUnchanged(store, configuredAgentId, fence);
  return {
    events: events.slice(0, TIMELINE_LIMIT),
    lastContactAt: events[0]?.occurredAt ?? null,
    occasions,
  };
}
