import { type Query, type QueryDocumentSnapshot, Timestamp } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { FirestoreProfileLibraryRepository } from './profile-library.js';
import { FirestoreProfilePeopleReadRepository } from './profile-people-read.js';
import {
  collectProfileDocuments,
  FirestoreProfileReadLimitError,
  iterateProfileDocuments,
  ProfileReadBudget,
  ProfileReadWave,
} from './profile-read-budget.js';
import { documentKey, type InstallationStore } from './store.js';

type Row = Record<string, unknown>;
class Doc {
  readonly exists: boolean;
  constructor(
    readonly id: string,
    readonly row?: Row,
    readonly updateTime?: Timestamp,
    readonly onData?: () => void,
  ) {
    this.exists = row !== undefined;
  }
  data() {
    this.onData?.();
    return this.row;
  }
  get(key: string) {
    return this.row?.[key];
  }
}
function fixture(tables: Record<string, Row[]>) {
  const calls: Array<{ table: string; limit: number; filters: Array<[string, string, unknown]> }> =
    [];
  const queryDocuments: Record<string, number> = {};
  const decodedDocuments: Record<string, number> = {};
  const pointDocuments: Record<string, number> = {};
  const getAllBatches: Record<string, number> = {};
  const control = {
    repeat: false,
    invalidSize: false,
    missingContactUpdateTime: false,
    error: null as Error | null,
    getAllErrorOnce: null as Error | null,
    memoryErrorOnce: null as Error | null,
    memoryPageObserver: null as ((decodedCount: number) => void) | null,
    fence: 0,
    changed: false,
    holdFenceAt: 0,
    holdContacts: false,
  };
  let releaseHeldFence: (() => void) | undefined;
  const heldFence = new Promise<void>((resolve) => {
    releaseHeldFence = resolve;
  });
  let releaseHeldContacts: (() => void) | undefined;
  const heldContacts = new Promise<void>((resolve) => {
    releaseHeldContacts = resolve;
  });
  const contactUpdateTime = () =>
    control.missingContactUpdateTime ? undefined : new Timestamp(1_798_000_000, 123_456_789);
  class FakeQuery {
    constructor(
      readonly table: string,
      readonly filters: Array<[string, string, unknown]> = [],
      readonly cap = 400,
      readonly cursor = '',
    ) {}
    where(field: string, op: string, value: unknown) {
      return new FakeQuery(
        this.table,
        [...this.filters, [field, op, value]],
        this.cap,
        this.cursor,
      );
    }
    orderBy() {
      return this;
    }
    limit(cap: number) {
      return new FakeQuery(this.table, this.filters, cap, this.cursor);
    }
    startAfter(doc: Doc) {
      return new FakeQuery(this.table, this.filters, this.cap, doc.id);
    }
    async get() {
      calls.push({ table: this.table, limit: this.cap, filters: this.filters });
      if (this.table === 'memories') control.memoryPageObserver?.(decodedDocuments.memories ?? 0);
      if (control.error) throw control.error;
      if (this.table === 'memories' && control.memoryErrorOnce) {
        const error = control.memoryErrorOnce;
        control.memoryErrorOnce = null;
        throw error;
      }
      const docs = (tables[this.table] ?? [])
        .filter((row) =>
          this.filters.every(([field, op, value]) =>
            op === 'in' ? (value as unknown[]).includes(row[field]) : row[field] === value,
          ),
        )
        .map(
          (row) =>
            new Doc(
              documentKey(String(row.physicalId ?? row.id)),
              row,
              this.table === 'contacts' ? contactUpdateTime() : undefined,
              () => {
                decodedDocuments[this.table] = (decodedDocuments[this.table] ?? 0) + 1;
              },
            ),
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((doc) => control.repeat || doc.id > this.cursor)
        .slice(0, this.cap);
      queryDocuments[this.table] = (queryDocuments[this.table] ?? 0) + docs.length;
      return { docs, size: control.invalidSize ? this.cap : docs.length };
    }
  }
  const pointCalls: string[] = [];
  const store = {
    now: () => new Date('2026-10-25T00:00:00Z'),
    collection: (table: string) => new FakeQuery(table),
    doc: (table: string, id: string) => ({
      table,
      id,
      get: async () => {
        pointCalls.push(table);
        if (table === 'privacyErasureJobs') {
          control.fence++;
          if (control.fence === control.holdFenceAt) await heldFence;
          return control.changed && control.fence > 1
            ? new Doc(
                documentKey(id),
                { agentId: id, status: 'complete' },
                Timestamp.fromMillis(1000),
              )
            : new Doc(documentKey(id));
        }
        pointDocuments[table] = (pointDocuments[table] ?? 0) + 1;
        return new Doc(
          documentKey(id),
          tables[table]?.find((row) => row.id === id),
          table === 'contacts' ? contactUpdateTime() : undefined,
          () => {
            decodedDocuments[table] = (decodedDocuments[table] ?? 0) + 1;
          },
        );
      },
    }),
    db: {
      getAll: async (...refs: Array<{ table: string; id: string }>) => {
        const table = refs[0]?.table;
        if (table) getAllBatches[table] = (getAllBatches[table] ?? 0) + 1;
        if (table === 'contacts' && control.holdContacts) await heldContacts;
        if (table === 'contacts' && control.getAllErrorOnce) {
          const error = control.getAllErrorOnce;
          control.getAllErrorOnce = null;
          throw error;
        }
        return refs.map(({ table, id }) => {
          pointCalls.push(table);
          pointDocuments[table] = (pointDocuments[table] ?? 0) + 1;
          return new Doc(
            documentKey(id),
            tables[table]?.find((row) => String(row.physicalId ?? row.id) === id),
            table === 'contacts' ? contactUpdateTime() : undefined,
            () => {
              decodedDocuments[table] = (decodedDocuments[table] ?? 0) + 1;
            },
          );
        });
      },
    },
  } as unknown as InstallationStore;
  return {
    store,
    calls,
    control,
    pointCalls,
    queryDocuments,
    decodedDocuments,
    pointDocuments,
    getAllBatches,
    releaseFence: () => releaseHeldFence?.(),
    releaseContacts: () => releaseHeldContacts?.(),
  };
}
function rows(count: number, extra: Row = {}): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `row-${String(i).padStart(5, '0')}`,
    name: `Person ${i}`,
    ...extra,
  }));
}
function memory(extra: Row = {}): Row {
  return {
    agentId: 'owner',
    category: 'knowledge',
    content: 'Fact',
    createdAt: Timestamp.fromMillis(1000),
    expiresAt: null,
    quarantined: false,
    pinned: false,
    importance: 1,
    confidence: 1,
    subjectContactId: null,
    ...extra,
  };
}
const input = {
  state: 'in-use',
  filter: 'all',
  query: '',
  page: 1,
  pageSize: 60,
  now: new Date('2026-10-25'),
  extractionVersion: 1,
} as const;

describe('bounded actual profile repository reads (offline)', () => {
  it('requires native updateTime metadata for contact identity revisions', async () => {
    const f = fixture({ contacts: rows(1) });
    f.control.missingContactUpdateTime = true;
    await expect(
      new FirestoreProfilePeopleReadRepository(f.store, 'owner').listContacts(),
    ).rejects.toThrow('Contact identity revision is unavailable');
    expect(f.calls).toHaveLength(1);
  });

  it.each([199, 200, 9999, 10000])(
    'returns complete contacts for %i raw documents with bounded EOF proof',
    async (count) => {
      const f = fixture({ contacts: rows(count) });
      expect(
        await new FirestoreProfilePeopleReadRepository(f.store, 'owner').listContacts(),
      ).toHaveLength(count);
      expect(f.calls).toHaveLength(Math.floor(count / 200) + 1);
      if (count === 10000) expect(f.calls.at(-1)?.limit).toBe(1);
    },
  );

  it('charges malformed skipped contacts before decode; above-cap never returns partial/zero', async () => {
    const f = fixture({
      contacts: rows(10001).map((row) => ({ ...row, physicalId: row.id, id: 7 })),
    });
    await expect(
      new FirestoreProfilePeopleReadRepository(f.store, 'owner').listContacts(),
    ).rejects.toBeInstanceOf(FirestoreProfileReadLimitError);
    expect(f.calls).toHaveLength(51);
    expect(f.calls.at(-1)?.limit).toBe(1);
  });

  it('shares aggregate concurrent fanout budget and resets after the wave, including failure', async () => {
    const f = fixture({
      contacts: rows(6000),
      occasions: rows(6000, { agentId: 'owner', contactId: 'person', month: 1, day: 1 }),
    });
    const repo = new FirestoreProfilePeopleReadRepository(f.store, 'owner');
    const result = await Promise.allSettled([repo.listContacts(), repo.listOccasions('person')]);
    expect(result.every((entry) => entry.status === 'rejected')).toBe(true);
    expect(f.calls.reduce((sum, call) => sum + call.limit, 0)).toBeLessThanOrEqual(10001);
    expect(await repo.listContacts()).toHaveLength(6000);
  });

  it('preserves agent/subject filtering and exact fact totals below cap', async () => {
    const f = fixture({
      memories: [
        ...rows(251, memory({ subjectContactId: 'person' })),
        ...rows(2, memory({ agentId: 'foreign' })),
      ],
    });
    const result = await new FirestoreProfilePeopleReadRepository(f.store, 'owner').getFacts(
      'person',
      250,
    );
    expect(result.total).toBe(251);
    expect(result.rows).toHaveLength(250);
    expect(f.calls[0]?.filters).toEqual([
      ['agentId', '==', 'owner'],
      ['subjectContactId', '==', 'person'],
    ]);
  });

  it('bounds exact-total facts independently of the requested display slice', async () => {
    const f = fixture({ memories: rows(10001, memory({ subjectContactId: 'person' })) });
    await expect(
      new FirestoreProfilePeopleReadRepository(f.store, 'owner').getFacts('person', 250),
    ).rejects.toBeInstanceOf(FirestoreProfileReadLimitError);
    expect(f.calls).toHaveLength(51);
    expect(f.calls.at(-1)?.limit).toBe(1);
  });

  it('keeps physical owner-card reads owner scoped without a fallback', async () => {
    const f = fixture({
      ownerCards: [
        {
          id: 'owner',
          agentId: 'foreign',
          content: 'private',
          compiledAt: Timestamp.fromMillis(1),
        },
      ],
    });
    expect(
      await new FirestoreProfilePeopleReadRepository(f.store, 'owner').getOwnerCard(),
    ).toBeNull();
    expect(f.pointCalls).toEqual(['ownerCards']);
    expect(f.calls).toEqual([]);
  });

  it('propagates transport errors and rejects repeated/nonadvancing and inconsistent empty full pages', async () => {
    const f = fixture({ contacts: rows(201) });
    const repo = new FirestoreProfilePeopleReadRepository(f.store, 'owner');
    f.control.repeat = true;
    await expect(repo.listContacts()).rejects.toThrow('cursor did not advance');
    f.control.repeat = false;
    f.control.error = new Error('transport unavailable');
    await expect(repo.listContacts()).rejects.toBe(f.control.error);
    f.control.error = null;
    f.control.invalidSize = true;
    await expect(repo.listContacts()).rejects.toThrow('Invalid profile read page');
  });

  it('shares library memory scans, preserves owner filters and actual pre/post erasure fences', async () => {
    const contact = {
      id: 'person',
      name: 'Person',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      trust: 'owner',
      aliases: [],
      emails: [],
      phones: [],
      relationship: '',
      notes: '',
    };
    const f = fixture({
      memories: rows(401, memory({ subjectContactId: 'person' })),
      contacts: [contact],
    });
    const repo = new FirestoreProfileLibraryRepository(f.store);
    const [list, filters] = await Promise.all([
      repo.list('owner', input),
      repo.listFilters('owner'),
    ]);
    expect(list.total).toBe(401);
    expect(list.rows).toHaveLength(60);
    expect(filters.subjects).toEqual([{ id: 'person', label: 'Person', trust: 'owner' }]);
    expect(f.calls.filter((call) => call.table === 'memories')).toHaveLength(2);
    expect(
      f.calls.every((call) =>
        call.filters.some(([key, , value]) => key === 'agentId' && value === 'owner'),
      ),
    ).toBe(true);
    expect(f.pointCalls.filter((table) => table === 'privacyErasureJobs')).toHaveLength(4);
    f.control.fence = 0;
    f.control.changed = true;
    await expect(repo.listFilters('owner')).rejects.toThrow('Privacy erasure changed during read');
  });

  it('reuses the resolved memory scan only inside an asymmetric shared read wave', async () => {
    const f = fixture({ memories: rows(401, memory()) });
    f.control.holdFenceAt = 2;
    const repo = new FirestoreProfileLibraryRepository(f.store);
    const listPromise = repo.list('owner', input);
    const filtersPromise = repo.listFilters('owner');
    const list = await listPromise;
    expect(list.total).toBe(401);
    expect(f.queryDocuments.memories).toBe(401);
    f.releaseFence();
    const filters = await filtersPromise;

    expect(filters.subjects).toEqual([]);
    expect(f.queryDocuments.memories).toBe(401);
    expect(f.decodedDocuments.memories).toBe(401);
    expect(f.calls.filter((call) => call.table === 'memories')).toHaveLength(2);

    const priorQueries = f.queryDocuments.memories ?? 0;
    const priorDecodes = f.decodedDocuments.memories ?? 0;
    expect(await repo.listFilters('owner')).toEqual({ subjects: [], sources: [] });
    expect((f.queryDocuments.memories ?? 0) - priorQueries).toBe(401);
    expect((f.decodedDocuments.memories ?? 0) - priorDecodes).toBe(401);

    f.control.fence = 0;
    f.control.changed = true;
    await expect(repo.listFilters('owner')).rejects.toThrow('Privacy erasure changed during read');
  });

  it('singleflights overlapping wave contacts by owner, keeps getAll batching, and starts fresh next wave', async () => {
    const contacts = rows(401, {
      createdAt: new Date(0),
      updatedAt: new Date(0),
      trust: 'owner',
      aliases: [],
      emails: [],
      phones: [],
      relationship: '',
      notes: '',
    });
    const memories = contacts.map((contact, index) =>
      memory({ id: `memory-${String(index).padStart(5, '0')}`, subjectContactId: contact.id }),
    );
    const f = fixture({ memories, contacts });
    f.control.holdFenceAt = 2;
    const repo = new FirestoreProfileLibraryRepository(f.store);
    const listPromise = repo.list('owner', input);
    const filtersPromise = repo.listFilters('owner');
    const list = await listPromise;
    expect(list.rows[0]?.subject).toEqual({ id: 'row-00400', name: 'Person 400', trust: 'owner' });
    f.releaseFence();
    expect((await filtersPromise).subjects).toEqual([
      ...contacts
        .map((contact) => ({ id: String(contact.id), label: String(contact.name), trust: 'owner' }))
        .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
    ]);
    expect(f.pointDocuments.contacts).toBe(401);
    expect(f.getAllBatches.contacts).toBeLessThanOrEqual(3);

    await repo.listFilters('owner');
    expect(f.pointDocuments.contacts).toBe(802);
    expect(f.getAllBatches.contacts).toBeLessThanOrEqual(6);

    const pageOnly = fixture({
      memories,
      contacts,
    });
    await new FirestoreProfileLibraryRepository(pageOnly.store).list('owner', input);
    expect(pageOnly.pointDocuments.contacts).toBe(input.pageSize);
    expect(pageOnly.getAllBatches.contacts).toBe(1);

    const filtersOnly = fixture({ memories, contacts });
    await new FirestoreProfileLibraryRepository(filtersOnly.store).listFilters('owner');
    expect(filtersOnly.pointDocuments.contacts).toBe(401);
    expect(filtersOnly.getAllBatches.contacts).toBe(2);
  });

  it('keeps missing/invalid contacts and getAll failures wave local without hidden retry', async () => {
    const referenced = rows(3).map((row) => String(row.id));
    const contactRows = [
      {
        id: referenced[0],
        name: 'Person 0',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        trust: 'owner',
        aliases: [],
        emails: [],
        phones: [],
        relationship: '',
        notes: '',
      },
      {
        id: 'wrong-identity',
        physicalId: referenced[1],
        name: 'Must not leak',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        trust: 'owner',
        aliases: [],
        emails: [],
        phones: [],
        relationship: '',
        notes: '',
      },
    ];
    const f = fixture({
      memories: referenced.map((id, index) =>
        memory({ id: `memory-${index}`, subjectContactId: id }),
      ),
      contacts: contactRows,
    });
    const repo = new FirestoreProfileLibraryRepository(f.store);
    const failure = new Error('synthetic contact read interruption');
    f.control.getAllErrorOnce = failure;
    f.control.holdContacts = true;
    const listPromise = repo.list('owner', input);
    const filtersPromise = repo.listFilters('owner');
    const listResult = listPromise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    const filtersResult = filtersPromise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    for (let attempt = 0; attempt < 20 && !f.getAllBatches.contacts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(f.getAllBatches.contacts).toBe(1);
    f.releaseContacts();
    const outcomes = await Promise.all([listResult, filtersResult]);
    expect(outcomes.every((entry) => entry.status === 'rejected' && entry.reason === failure)).toBe(
      true,
    );
    expect(f.getAllBatches.contacts).toBe(1);
    f.control.holdContacts = false;
    expect((await repo.listFilters('owner')).subjects).toEqual([
      { id: referenced[0], label: 'Person 0', trust: 'owner' },
    ]);
    expect(f.getAllBatches.contacts).toBe(2);
    const firstContact = contactRows[0];
    if (!firstContact) throw new Error('Expected contact fixture');
    firstContact.name = 'Updated name';
    expect((await repo.listFilters('owner')).subjects).toEqual([
      { id: referenced[0], label: 'Updated name', trust: 'owner' },
    ]);
    contactRows.splice(0, 1);
    expect((await repo.listFilters('owner')).subjects).toEqual([]);
  });

  it('isolates simultaneous contact identities by agent inside a shared wave', async () => {
    const sharedContact = {
      id: 'shared',
      name: 'Shared ID',
      createdAt: new Date(0),
      updatedAt: new Date(0),
      trust: 'owner',
      aliases: [],
      emails: [],
      phones: [],
      relationship: '',
      notes: '',
    };
    const f = fixture({
      memories: [
        memory({ id: 'owner-memory', subjectContactId: 'shared' }),
        memory({ id: 'other-memory', agentId: 'other', subjectContactId: 'shared' }),
      ],
      contacts: [sharedContact],
    });
    const repo = new FirestoreProfileLibraryRepository(f.store);
    const [owner, other] = await Promise.all([
      repo.listFilters('owner'),
      repo.listFilters('other'),
    ]);
    expect(owner.subjects).toEqual([{ id: 'shared', label: 'Shared ID', trust: 'owner' }]);
    expect(other.subjects).toEqual([{ id: 'shared', label: 'Shared ID', trust: 'owner' }]);
    expect(f.pointDocuments.contacts).toBe(2);
    expect(f.getAllBatches.contacts).toBe(2);
  });

  it('charges only unique contact snapshots against the shared aggregate cap', async () => {
    const count = 5001;
    const contacts = rows(count, {
      createdAt: new Date(0),
      updatedAt: new Date(0),
      trust: 'owner',
      aliases: [],
      emails: [],
      phones: [],
      relationship: '',
      notes: '',
    });
    const memories = contacts.map((contact, index) =>
      memory({ id: `memory-${String(index).padStart(5, '0')}`, subjectContactId: contact.id }),
    );
    const f = fixture({ memories, contacts });
    await expect(
      new FirestoreProfileLibraryRepository(f.store).listFilters('owner'),
    ).rejects.toBeInstanceOf(FirestoreProfileReadLimitError);
    expect(f.queryDocuments.memories).toBe(5001);
    expect(f.pointDocuments.contacts).toBeLessThanOrEqual(4999);
    expect(f.getAllBatches.contacts).toBeLessThan(20);
  });

  it('keeps asymmetric near-budget public list and filters within the existing read cap', async () => {
    const f = fixture({ memories: rows(5000, memory()) });
    f.control.holdFenceAt = 2;
    const repo = new FirestoreProfileLibraryRepository(f.store);
    const listPromise = repo.list('owner', input);
    const filtersPromise = repo.listFilters('owner');
    const list = await listPromise;
    expect(list.total).toBe(5000);
    expect(list.rows).toHaveLength(input.pageSize);
    expect(f.queryDocuments.memories).toBe(5000);
    f.releaseFence();
    const filters = await filtersPromise;

    expect(filters).toEqual({ subjects: [], sources: [] });
    expect(f.queryDocuments.memories).toBe(5000);
    expect(f.decodedDocuments.memories).toBe(5000);
    expect(f.calls.filter((call) => call.table === 'memories')).toHaveLength(13);
    expect(f.pointDocuments.knowledgeGraphSources).toBe(input.pageSize);
  });

  it('shares a failed memory scan only within the wave and retries from a fresh wave', async () => {
    const f = fixture({ memories: rows(401, memory()) });
    const failure = new Error('synthetic memory scan interruption');
    f.control.holdFenceAt = 2;
    f.control.memoryErrorOnce = failure;
    const repo = new FirestoreProfileLibraryRepository(f.store);
    const listPromise = repo.list('owner', input);
    const filtersPromise = repo.listFilters('owner');

    await expect(listPromise).rejects.toBe(failure);
    expect(f.calls.filter((call) => call.table === 'memories')).toHaveLength(1);
    expect(f.queryDocuments.memories ?? 0).toBe(0);
    f.releaseFence();
    await expect(filtersPromise).rejects.toBe(failure);
    expect(f.calls.filter((call) => call.table === 'memories')).toHaveLength(1);
    expect(f.decodedDocuments.memories ?? 0).toBe(0);

    expect(await repo.listFilters('owner')).toEqual({ subjects: [], sources: [] });
    expect(f.queryDocuments.memories).toBe(401);
    expect(f.decodedDocuments.memories).toBe(401);
    expect(f.calls.filter((call) => call.table === 'memories')).toHaveLength(3);
  });

  it('keeps shared-wave memory scans isolated by owner and by store', async () => {
    const f = fixture({
      memories: [
        { ...memory(), id: 'owner-row-1' },
        { ...memory(), id: 'owner-row-2' },
        { ...memory({ agentId: 'other' }), id: 'other-row-1' },
      ],
    });
    f.control.holdFenceAt = 2;
    const repo = new FirestoreProfileLibraryRepository(f.store);
    const ownerListPromise = repo.list('owner', input);
    const otherFiltersPromise = repo.listFilters('other');
    const ownerList = await ownerListPromise;
    f.releaseFence();
    const otherFilters = await otherFiltersPromise;
    expect(ownerList.total).toBe(2);
    expect(otherFilters).toEqual({ subjects: [], sources: [] });
    expect(f.queryDocuments.memories).toBe(3);
    expect(f.decodedDocuments.memories).toBe(3);
    const memoryFilters = f.calls
      .filter((call) => call.table === 'memories')
      .map((call) => call.filters.find(([key]) => key === 'agentId')?.[2]);
    expect(memoryFilters).toEqual(['owner', 'other']);

    const firstStoreFixture = fixture({ memories: rows(3, memory()) });
    const secondStoreFixture = fixture({ memories: rows(3, memory()) });
    const firstRepository = new FirestoreProfileLibraryRepository(firstStoreFixture.store);
    const secondRepository = new FirestoreProfileLibraryRepository(secondStoreFixture.store);
    await Promise.all([
      firstRepository.listFilters('owner'),
      secondRepository.listFilters('owner'),
    ]);
    expect(firstStoreFixture.queryDocuments.memories).toBe(3);
    expect(firstStoreFixture.decodedDocuments.memories).toBe(3);
    expect(secondStoreFixture.queryDocuments.memories).toBe(3);
    expect(secondStoreFixture.decodedDocuments.memories).toBe(3);
  });

  it('accepts library exact-cap EOF and counts wrong-identity memory rows before skipping', async () => {
    const f = fixture({ memories: rows(10000, memory()) });
    expect(await new FirestoreProfileLibraryRepository(f.store).listFilters('owner')).toEqual({
      subjects: [],
      sources: [],
    });
    expect(f.calls).toHaveLength(26);
    expect(f.calls.at(-1)?.limit).toBe(1);
    const malformed = fixture({
      memories: rows(10001, memory()).map((row) => ({ ...row, physicalId: row.id, id: 'unbound' })),
    });
    await expect(
      new FirestoreProfileLibraryRepository(malformed.store).listFilters('owner'),
    ).rejects.toBeInstanceOf(FirestoreProfileReadLimitError);
    expect(malformed.calls).toHaveLength(26);
  });

  it('charges visible-page relation-in fanout to the same aggregate budget', async () => {
    const f = fixture({
      memories: rows(1, memory()),
      knowledgeGraphRelations: rows(10000, { agentId: 'owner', sourceMemoryId: 'row-00000' }),
    });
    await expect(
      new FirestoreProfileLibraryRepository(f.store).list('owner', input),
    ).rejects.toBeInstanceOf(FirestoreProfileReadLimitError);
    expect(f.calls.at(-1)?.filters).toContainEqual(['sourceMemoryId', 'in', ['row-00000']]);
    expect(f.calls.at(-1)?.limit).toBe(1);
  });

  it('bounds library memory scan and all-relation connectivity scan, never publishing truncated totals', async () => {
    const large = fixture({ memories: rows(10001, memory()) });
    await expect(
      new FirestoreProfileLibraryRepository(large.store).listFilters('owner'),
    ).rejects.toBeInstanceOf(FirestoreProfileReadLimitError);
    expect(large.calls.at(-1)?.limit).toBe(1);
    const relations = fixture({
      memories: rows(1, memory()),
      knowledgeGraphRelations: rows(10000, { agentId: 'owner' }),
    });
    await expect(
      new FirestoreProfileLibraryRepository(relations.store).list('owner', {
        ...input,
        connectivity: 'connected',
      }),
    ).rejects.toBeInstanceOf(FirestoreProfileReadLimitError);
    expect(relations.calls.at(-1)?.table).toBe('knowledgeGraphRelations');
  });
});

describe('shared raw budget enforcement', () => {
  it('counts missing getAll snapshots and limits requests including empty EOF reads', async () => {
    const budget = new ProfileReadBudget();
    for (let i = 0; i < 100; i++) await budget.page(400, async () => []);
    let dispatched = false;
    await expect(
      budget.page(1, async () => {
        dispatched = true;
        return [];
      }),
    ).rejects.toBeInstanceOf(FirestoreProfileReadLimitError);
    expect(dispatched).toBe(false);
    const missing = new ProfileReadBudget();
    await missing.records(10000, async () =>
      Array.from({ length: 10000 }, () => new Doc('missing')),
    );
    await expect(missing.records(1, async () => [new Doc('missing')])).rejects.toBeInstanceOf(
      FirestoreProfileReadLimitError,
    );
  });

  it('fresh wave after failure uses a new budget without retrying failed transport', async () => {
    const waves = new ProfileReadWave();
    const error = new Error('offline');
    await expect(
      waves.run((budget) =>
        budget.page(1, async () => {
          throw error;
        }),
      ),
    ).rejects.toBe(error);
    expect(await waves.run((budget) => budget.page(1, async () => []))).toEqual([]);
  });

  it('rejects an impossible empty full page before treating it as EOF', async () => {
    const q = {
      orderBy() {
        return this;
      },
      limit() {
        return this;
      },
      get: async () => ({ size: 200, docs: [] }),
    } as unknown as Query;
    await expect(collectProfileDocuments(q, 200, new ProfileReadBudget())).rejects.toThrow(
      'Invalid profile read page',
    );
  });

  it('validates a fetched page completely before yielding any snapshot', async () => {
    const docs = [{ id: 'b' }, { id: 'a' }] as QueryDocumentSnapshot[];
    const q = {
      orderBy() {
        return this;
      },
      limit() {
        return this;
      },
      get: async () => ({ size: docs.length, docs }),
    } as unknown as Query;
    let yielded = 0;
    await expect(async () => {
      for await (const _doc of iterateProfileDocuments(q, 2, new ProfileReadBudget())) yielded++;
    }).rejects.toThrow('Profile read cursor did not advance');
    expect(yielded).toBe(0);
  });

  it('does not publish a partial library result when a later streamed page fails cursor validation', async () => {
    const f = fixture({ memories: rows(401, memory()) });
    f.control.repeat = true;
    const repository = new FirestoreProfileLibraryRepository(f.store);
    await expect(repository.listFilters('owner')).rejects.toThrow('cursor did not advance');
    expect(f.queryDocuments.memories).toBe(800);
    expect(f.decodedDocuments.memories).toBe(400);
  });

  it('decodes each library memory page before fetching the next page', async () => {
    const f = fixture({ memories: rows(401, memory()) });
    const decodedBeforePage: number[] = [];
    f.control.memoryPageObserver = (decodedCount) => decodedBeforePage.push(decodedCount);
    const result = await new FirestoreProfileLibraryRepository(f.store).listFilters('owner');
    expect(result).toEqual({ subjects: [], sources: [] });
    expect(decodedBeforePage).toEqual([0, 400]);
    expect(f.queryDocuments.memories).toBe(401);
    expect(f.decodedDocuments.memories).toBe(401);
  });
});
