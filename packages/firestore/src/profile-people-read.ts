import type {
  ProfileContact,
  ProfileFact,
  ProfileOccasion,
  ProfilePeopleReadRepository,
} from '@assistant/persistence';
import {
  FieldPath,
  type Query,
  type QueryDocumentSnapshot,
  Timestamp,
} from '@google-cloud/firestore';
import { decodeMemoryRecord } from './memory-record.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 200;

async function collect<T extends { id: string }>(query: Query): Promise<T[]> {
  const rows: T[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let pageQuery = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) pageQuery = pageQuery.startAfter(cursor);
    const page = await pageQuery.get();
    for (const doc of page.docs) {
      const row = decodeRecord<Partial<T>>(doc.data());
      if (typeof row.id === 'string' && documentKey(row.id) === doc.id) rows.push(row as T);
    }
    if (page.size < PAGE_SIZE) return rows;
    cursor = page.docs.at(-1);
  }
}

type PreciseFact = { row: ProfileFact; seconds: number; nanoseconds: number };

async function collectFacts(query: Query): Promise<PreciseFact[]> {
  const rows: PreciseFact[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let pageQuery = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) pageQuery = pageQuery.startAfter(cursor);
    const page = await pageQuery.get();
    for (const doc of page.docs) {
      const row = decodeMemoryRecord(doc.data());
      if (documentKey(row.id) !== doc.id || !(row.createdAt instanceof Date)) continue;
      const createdAt = doc.get('createdAt');
      rows.push({
        row,
        seconds:
          createdAt instanceof Timestamp
            ? createdAt.seconds
            : Math.floor(row.createdAt.getTime() / 1000),
        nanoseconds:
          createdAt instanceof Timestamp
            ? createdAt.nanoseconds
            : (row.createdAt.getTime() % 1000) * 1_000_000,
      });
    }
    if (page.size < PAGE_SIZE) return rows;
    cursor = page.docs.at(-1);
  }
}

function profileFactOrder(a: PreciseFact, b: PreciseFact): number {
  return (
    Number(b.row.pinned) - Number(a.row.pinned) ||
    b.row.importance - a.row.importance ||
    Number(b.row.confidence) - Number(a.row.confidence) ||
    b.seconds - a.seconds ||
    b.nanoseconds - a.nanoseconds ||
    b.row.id.localeCompare(a.row.id)
  );
}

/** Installation-scoped profile reads with agent-scoped facts, card, and occasions. */
export class FirestoreProfilePeopleReadRepository implements ProfilePeopleReadRepository {
  readonly kind = 'profile-people-read-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  async getOwnerContact(): Promise<ProfileContact | null> {
    const rows = await collect<ProfileContact>(
      this.store.collection('contacts').where('trust', '==', 'owner'),
    );
    return rows.find((row) => row.trust === 'owner') ?? null;
  }

  async getContact(id: string): Promise<ProfileContact | null> {
    const doc = await this.store.doc('contacts', id).get();
    if (!doc.exists) return null;
    const row = decodeRecord<ProfileContact>(doc.data());
    return row.id === id ? row : null;
  }

  async listContacts(): Promise<ProfileContact[]> {
    const rows = await collect<ProfileContact>(this.store.collection('contacts'));
    return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async getFacts(
    contactId: string,
    limit: number,
  ): Promise<{ rows: ProfileFact[]; total: number }> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid profile fact limit');
    const now = this.store.now();
    const candidates = await collectFacts(
      this.store
        .collection('memories')
        .where('agentId', '==', this.agentId)
        .where('subjectContactId', '==', contactId),
    );
    const active = candidates.filter(
      ({ row }) =>
        row.agentId === this.agentId &&
        row.subjectContactId === contactId &&
        row.category === 'knowledge' &&
        row.quarantined === false &&
        (row.expiresAt === null || (row.expiresAt instanceof Date && row.expiresAt > now)),
    );
    active.sort(profileFactOrder);
    return { rows: active.slice(0, limit).map(({ row }) => row), total: active.length };
  }

  async getOwnerCard(): Promise<{ content: string; compiledAt: Date } | null> {
    const doc = await this.store.doc('ownerCards', this.agentId).get();
    if (!doc.exists) return null;
    const row = decodeRecord<{ agentId: string; content: string; compiledAt: Date }>(doc.data());
    return row.agentId === this.agentId &&
      typeof row.content === 'string' &&
      row.compiledAt instanceof Date
      ? { content: row.content, compiledAt: row.compiledAt }
      : null;
  }

  async listOccasions(contactId: string): Promise<ProfileOccasion[]> {
    const rows = await collect<ProfileOccasion>(
      this.store
        .collection('occasions')
        .where('agentId', '==', this.agentId)
        .where('contactId', '==', contactId),
    );
    return rows
      .filter((row) => row.agentId === this.agentId && row.contactId === contactId)
      .sort((a, b) => a.month - b.month || a.day - b.day || a.id.localeCompare(b.id));
  }
}
