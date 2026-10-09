import type {
  ProfileLibraryInput,
  ProfileLibraryRecord,
  ProfileLibraryRepository,
  Records,
} from '@assistant/persistence';
import { Timestamp } from '@google-cloud/firestore';
import { decodeMemoryRecord } from './memory-record.js';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

async function allByAgent<T extends { id: string; agentId: string }>(
  store: InstallationStore,
  collection: string,
  agentId: string,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = store.collection(collection).where('agentId', '==', agentId).limit(400);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      const row = decodeRecord<T>(doc.data());
      if (row.agentId === agentId && documentKey(row.id) === doc.id) rows.push(row);
    }
    cursor = page.docs.at(-1);
    if (page.size < 400) return rows;
  }
}

async function getRecords<T>(
  store: InstallationStore,
  collection: string,
  ids: readonly string[],
  identity: (row: T) => string,
): Promise<Map<string, T>> {
  const rows = new Map<string, T>();
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += 300) {
    batches.push(unique.slice(offset, offset + 300));
  }
  // Keep Firestore RPCs parallel without flooding a large installation with
  // hundreds of simultaneous getAll calls.
  let nextBatch = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, batches.length) }, async () => {
      for (;;) {
        const index = nextBatch++;
        const batch = batches[index];
        if (!batch) return;
        const docs = await store.db.getAll(...batch.map((id) => store.doc(collection, id)));
        for (const doc of docs) {
          if (!doc.exists) continue;
          const row = decodeRecord<T>(doc.data());
          const id = identity(row);
          if (documentKey(id) === doc.id) rows.set(id, row);
        }
      }
    }),
  );
  return rows;
}

async function relationsForMemories(
  store: InstallationStore,
  agentId: string,
  memoryIds: readonly string[],
): Promise<Records['knowledgeGraphRelations'][]> {
  const ids = [...new Set(memoryIds)];
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += 30) {
    batches.push(ids.slice(offset, offset + 30));
  }
  const pages = await Promise.all(
    batches.map((batch) =>
      store
        .collection('knowledgeGraphRelations')
        .where('agentId', '==', agentId)
        .where('sourceMemoryId', 'in', batch)
        .get(),
    ),
  );
  const rows: Records['knowledgeGraphRelations'][] = [];
  for (const page of pages) {
    for (const doc of page.docs) {
      const row = decodeRecord<Records['knowledgeGraphRelations']>(doc.data());
      if (row.agentId === agentId && documentKey(row.id) === doc.id) rows.push(row);
    }
  }
  return rows;
}

type MemoryRow = {
  memory: Records['memories'];
  createdSeconds: number;
  createdNanos: number;
  expiresAtMillis: number | null;
};

function compareMemory(a: MemoryRow, b: MemoryRow) {
  return (
    Number(b.memory.pinned) - Number(a.memory.pinned) ||
    Number(b.memory.ownerConfirmed) - Number(a.memory.ownerConfirmed) ||
    b.memory.importance - a.memory.importance ||
    b.createdSeconds - a.createdSeconds ||
    b.createdNanos - a.createdNanos ||
    (a.memory.id < b.memory.id ? 1 : a.memory.id > b.memory.id ? -1 : 0)
  );
}

function matches(row: MemoryRow, input: ProfileLibraryInput) {
  const { memory } = row;
  if (memory.category !== 'knowledge') return false;
  if (row.expiresAtMillis != null && row.expiresAtMillis <= input.now.getTime()) return false;
  if (input.state === 'review') {
    if (!memory.quarantined) return false;
  } else if (memory.quarantined) return false;
  if (input.state !== 'review' && input.filter === 'verified' && !memory.ownerConfirmed)
    return false;
  if (input.state !== 'review' && input.filter === 'untidied' && memory.lastConsolidatedAt)
    return false;
  if (input.query && !memory.content.toLowerCase().includes(input.query.toLowerCase()))
    return false;
  if (input.subjectId && memory.subjectContactId !== input.subjectId) return false;
  if (input.domain && memory.domain !== input.domain) return false;
  if (input.source && memory.source !== input.source) return false;
  if (
    input.ageDays &&
    row.createdSeconds * 1000 + row.createdNanos / 1_000_000 <=
      input.now.getTime() - input.ageDays * 86_400_000
  )
    return false;
  return true;
}

export class FirestoreProfileLibraryRepository implements ProfileLibraryRepository {
  readonly kind = 'profile-library-repository' as const;
  private readonly memoryReads = new Map<string, Promise<MemoryRow[]>>();

  constructor(readonly store: InstallationStore) {}

  private memories(agentId: string): Promise<MemoryRow[]> {
    const existing = this.memoryReads.get(agentId);
    if (existing) return existing;
    const read = this.readMemories(agentId).finally(() => {
      if (this.memoryReads.get(agentId) === read) this.memoryReads.delete(agentId);
    });
    this.memoryReads.set(agentId, read);
    return read;
  }

  private async readMemories(agentId: string): Promise<MemoryRow[]> {
    const rows: MemoryRow[] = [];
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store.collection('memories').where('agentId', '==', agentId).limit(400);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const memory = decodeMemoryRecord(doc.data());
        if (memory.agentId !== agentId || documentKey(memory.id) !== doc.id) continue;
        const rawCreatedAt = doc.get('createdAt');
        const rawExpiresAt = doc.get('expiresAt');
        if (rawCreatedAt instanceof Timestamp) {
          // PostgreSQL's JS projection is a millisecond Date. Keep that public
          // shape while retaining native nanos below for deterministic order.
          memory.createdAt = new Date(Math.floor(rawCreatedAt.toMillis()));
        }
        rows.push({
          memory,
          createdSeconds:
            rawCreatedAt instanceof Timestamp
              ? rawCreatedAt.seconds
              : Math.floor(memory.createdAt.getTime() / 1000),
          createdNanos:
            rawCreatedAt instanceof Timestamp
              ? rawCreatedAt.nanoseconds
              : (memory.createdAt.getTime() % 1000) * 1_000_000,
          expiresAtMillis:
            rawExpiresAt instanceof Timestamp
              ? rawExpiresAt.toMillis()
              : (memory.expiresAt?.getTime() ?? null),
        });
      }
      cursor = page.docs.at(-1);
      if (page.size < 400) return rows;
    }
  }

  async listFilters(agentId: string) {
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const memories = (await this.memories(agentId))
      .map((row) => row.memory)
      .filter((row) => row.category === 'knowledge');
    const contacts = await getRecords<Records['contacts']>(
      this.store,
      'contacts',
      memories.flatMap((row) => (row.subjectContactId ? [row.subjectContactId] : [])),
      (row) => row.id,
    );
    const subjectIds = new Set(
      memories.flatMap((row) => (row.subjectContactId ? [row.subjectContactId] : [])),
    );
    const result = {
      subjects: [...subjectIds]
        .flatMap((id) => {
          const contact = contacts.get(id);
          return contact ? [{ id, label: contact.name, trust: contact.trust }] : [];
        })
        .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
      sources: [...new Set(memories.flatMap((row) => (row.source ? [row.source] : [])))].sort(),
    };
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }

  async list(agentId: string, input: ProfileLibraryInput) {
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const connectivity = input.connectivity ?? 'all';
    let candidates = (await this.memories(agentId)).filter((row) => matches(row, input));
    const activeCounts = new Map<string, number>();
    let sources: Map<string, Records['knowledgeGraphSources']>;
    if (connectivity !== 'all') {
      // Connectivity changes filtering and totals, so all candidate records
      // are needed. Keep the complete path for those less common filters.
      sources = await getRecords<Records['knowledgeGraphSources']>(
        this.store,
        'knowledgeGraphSources',
        candidates.map((row) => row.memory.id),
        (row) => row.memoryId,
      );
      const relations = await allByAgent<Records['knowledgeGraphRelations']>(
        this.store,
        'knowledgeGraphRelations',
        agentId,
      );
      const candidatesById = new Map(candidates.map((row) => [row.memory.id, row.memory]));
      for (const relation of relations) {
        const memory = candidatesById.get(relation.sourceMemoryId);
        const source = sources.get(relation.sourceMemoryId);
        if (
          memory &&
          !memory.quarantined &&
          memory.embedding &&
          source?.status === 'ready' &&
          source.contentHash === memory.contentHash &&
          source.extractionVersion >= input.extractionVersion &&
          relation.reviewStatus !== 'rejected' &&
          relation.evidenceQuote != null
        ) {
          activeCounts.set(memory.id, (activeCounts.get(memory.id) ?? 0) + 1);
        }
      }
      if (connectivity === 'connected') {
        candidates = candidates.filter((row) => (activeCounts.get(row.memory.id) ?? 0) > 0);
      } else {
        candidates = candidates.filter((row) => (activeCounts.get(row.memory.id) ?? 0) === 0);
      }
    }
    candidates.sort(compareMemory);
    const total = candidates.length;
    const totalPages = Math.max(1, Math.ceil(total / input.pageSize));
    const page = Math.min(Math.max(1, input.page), totalPages);
    const pageRows = candidates.slice((page - 1) * input.pageSize, page * input.pageSize);
    if (connectivity === 'all') {
      // The usual library view only needs graph status for the visible page.
      // Fetching every candidate's source and scanning every graph relation
      // made a normal page read proportional to the entire graph.
      sources = await getRecords<Records['knowledgeGraphSources']>(
        this.store,
        'knowledgeGraphSources',
        pageRows.map((row) => row.memory.id),
        (row) => row.memoryId,
      );
      const relations = await relationsForMemories(
        this.store,
        agentId,
        pageRows.map((row) => row.memory.id),
      );
      const pageMemories = new Map(pageRows.map((row) => [row.memory.id, row.memory]));
      for (const relation of relations) {
        const memory = pageMemories.get(relation.sourceMemoryId);
        const source = sources.get(relation.sourceMemoryId);
        if (
          memory?.embedding &&
          !memory.quarantined &&
          source?.status === 'ready' &&
          source.contentHash === memory.contentHash &&
          source.extractionVersion >= input.extractionVersion &&
          relation.reviewStatus !== 'rejected' &&
          relation.evidenceQuote != null
        ) {
          activeCounts.set(memory.id, (activeCounts.get(memory.id) ?? 0) + 1);
        }
      }
    }
    const contacts = await getRecords<Records['contacts']>(
      this.store,
      'contacts',
      pageRows.flatMap((row) => (row.memory.subjectContactId ? [row.memory.subjectContactId] : [])),
      (row) => row.id,
    );
    const rows: ProfileLibraryRecord[] = pageRows.map(({ memory }) => {
      const contact = memory.subjectContactId ? contacts.get(memory.subjectContactId) : null;
      const source = sources.get(memory.id);
      return {
        memory,
        subject: contact ? { id: contact.id, name: contact.name, trust: contact.trust } : null,
        connectionCount: activeCounts.get(memory.id) ?? 0,
        source: source
          ? {
              status: source.status,
              contentHash: source.contentHash,
              extractionVersion: source.extractionVersion,
            }
          : null,
      };
    });
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return { rows, total, page, totalPages };
  }
}
