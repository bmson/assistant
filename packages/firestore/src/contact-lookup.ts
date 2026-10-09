import { createHash, randomUUID } from 'node:crypto';
import type { ContactLookupRepository, ContactLookupRow, Records } from '@assistant/persistence';
import type { DocumentReference, Transaction } from '@google-cloud/firestore';
import { assertPrivacyErasureGenerationInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/** Contacts are read whole; an installation past this bound fails instead of matching a subset. */
const CONTACT_SCAN_LIMIT = 5000;
const ASSISTANT_ALIASES = new Set(['assistant', 'ai bot', 'b bot', 'the assistant', 'bot']);

function namePrefixMatch(left: string, right: string): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 3 && (shorter === longer || longer.startsWith(`${shorter} `));
}

async function ownedContacts(
  store: InstallationStore,
  agentId: string,
): Promise<Records['contacts'][]> {
  const page = await store
    .collection('contacts')
    .limit(CONTACT_SCAN_LIMIT + 1)
    .get();
  if (page.size > CONTACT_SCAN_LIMIT) throw new Error('Firestore contact scan exceeded bound');
  return page.docs.flatMap((doc) => {
    const row = decodeRecord<Records['contacts'] & { agentId?: unknown }>(doc.data());
    // Contacts are installation-scoped; a record tagged for another owner is never matched.
    if (
      typeof row.id !== 'string' ||
      documentKey(row.id) !== doc.id ||
      typeof row.name !== 'string' ||
      (row.agentId !== undefined && row.agentId !== agentId)
    )
      return [];
    return [row];
  });
}

/**
 * Attribute a fact's subject to a contact: the owner, an existing person by
 * name or alias prefix, or a new name to create. Null for no subject (blank,
 * the assistant itself, or an owner who has no contact row).
 */
export function matchSubjectContact(
  rows: Records['contacts'][],
  subject: string,
): { contactId: string } | { create: string } | null {
  const name = subject.trim();
  if (!name || ASSISTANT_ALIASES.has(name.toLowerCase())) return null;
  const owner = rows.find((row) => row.trust === 'owner');
  const lower = name.toLowerCase();
  const exact = rows.filter((row) =>
    [row.name, ...(row.aliases ?? [])].some(
      (candidate) => candidate.trim().toLowerCase() === lower,
    ),
  );
  if (lower !== 'owner') {
    if (exact.length > 1) return null;
    if (exact[0]) return { contactId: exact[0].id };
    const prefixes = rows.filter((row) =>
      [row.name, ...(row.aliases ?? [])].some((candidate) =>
        namePrefixMatch(lower, candidate.toLowerCase()),
      ),
    );
    if (prefixes.length > 1) return null;
  }
  const ownerMatch = owner
    ? [owner.name, ...(owner.aliases ?? [])].find((candidate) =>
        namePrefixMatch(lower, candidate.toLowerCase()),
      )
    : undefined;
  if (lower === 'owner' || ownerMatch) return owner ? { contactId: owner.id } : null;
  const match = rows
    .filter((row) => row.trust !== 'owner')
    .find((row) =>
      [row.name, ...(row.aliases ?? [])].some((candidate) =>
        namePrefixMatch(lower, candidate.toLowerCase()),
      ),
    );
  return match ? { contactId: match.id } : { create: name };
}

/** The uniqueness marker that makes concurrent creation of one new name converge. */
export function contactNameRef(store: InstallationStore, name: string): DocumentReference {
  return store.doc(
    'contactNames',
    createHash('sha256').update(name.trim().toLowerCase()).digest('hex'),
  );
}

/**
 * Stage an auto-created, untrusted contact and its name marker. The caller has
 * already read the marker in this transaction and found it absent.
 */
export function stageNewContact(
  tx: Transaction,
  store: InstallationStore,
  input: { name: string; relationship?: string; now: Date; replaceMarker?: boolean; id?: string },
): string {
  const id = input.id ?? randomUUID();
  const contact: Records['contacts'] = {
    id,
    name: input.name.trim(),
    createdAt: input.now,
    updatedAt: input.now,
    trust: 'unknown',
    aliases: [],
    emails: [],
    phones: [],
    relationship: input.relationship?.trim() ?? '',
    notes: '',
  };
  tx.create(store.doc('contacts', id), encodeRecord(contact));
  if (input.replaceMarker)
    tx.set(contactNameRef(store, input.name), { contactId: id, createdAt: input.now });
  else tx.create(contactNameRef(store, input.name), { contactId: id, createdAt: input.now });
  return id;
}

/**
 * Resolve who a fact or occasion is about, like memory.save does: "owner" or
 * the owner's name is the owner contact, another name prefix-matches a saved
 * contact, and a new name becomes an unknown-trust contact reserved by name so
 * concurrent saves share it. Assistant aliases resolve to no one.
 */
export async function resolveFirestoreSubjectContact(
  store: InstallationStore,
  agentId: string,
  subject: string,
  relationship?: string,
  observedPrivacyGeneration?: string | null,
): Promise<string | null> {
  const matched = matchSubjectContact(await ownedContacts(store, agentId), subject);
  if (!matched || 'contactId' in matched) return matched?.contactId ?? null;
  const keyRef = contactNameRef(store, matched.create);
  return store.db.runTransaction(async (tx) => {
    if (observedPrivacyGeneration !== undefined)
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        store,
        agentId,
        observedPrivacyGeneration,
      );
    const existing = await tx.get(keyRef);
    if (existing.exists) {
      const contactId = existing.get('contactId');
      const target =
        typeof contactId === 'string' ? await tx.get(store.doc('contacts', contactId)) : undefined;
      if (
        target?.exists &&
        target.get('id') === contactId &&
        (target.get('agentId') === undefined || target.get('agentId') === agentId) &&
        [
          target.get('name'),
          ...(Array.isArray(target.get('aliases')) ? target.get('aliases') : []),
        ].some(
          (name) =>
            typeof name === 'string' && name.trim().toLowerCase() === matched.create.toLowerCase(),
        )
      )
        return contactId;
    }
    return stageNewContact(tx, store, {
      name: matched.create,
      relationship,
      now: store.now(),
      replaceMarker: existing.exists,
    });
  });
}

/** Word-boundary name and alias lookup over saved contacts, for outbound addressing. */
export class FirestoreContactLookupRepository implements ContactLookupRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async findByName(input: { agentId: string; query: string }): Promise<ContactLookupRow[]> {
    if (input.agentId !== this.configuredAgentId)
      throw new Error('Contact lookup is outside the configured Firestore agent');
    const lower = input.query.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    if (lower.length < 2) return [];
    const rows = await ownedContacts(this.store, input.agentId);
    return rows
      .filter((contact) =>
        [contact.name, ...(contact.aliases ?? [])].some((candidate) =>
          namePrefixMatch(lower, candidate.toLocaleLowerCase()),
        ),
      )
      .map((contact) => ({
        name: contact.name,
        emails: Array.isArray(contact.emails)
          ? contact.emails.filter((value): value is string => typeof value === 'string')
          : [],
        phones: Array.isArray(contact.phones)
          ? contact.phones.filter((value): value is string => typeof value === 'string')
          : [],
        relationship: typeof contact.relationship === 'string' ? contact.relationship : '',
      }));
  }
}
