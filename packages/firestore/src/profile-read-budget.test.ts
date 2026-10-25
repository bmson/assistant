import { type Query, Timestamp } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { FirestoreProfileLibraryRepository } from './profile-library.js';
import { FirestoreProfilePeopleReadRepository } from './profile-people-read.js';
import {
  collectProfileDocuments,
  FirestoreProfileReadLimitError,
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
  ) {
    this.exists = row !== undefined;
  }
  data() {
    return this.row;
  }
  get(key: string) {
    return this.row?.[key];
  }
}
function fixture(tables: Record<string, Row[]>) {
  const calls: Array<{ table: string; limit: number; filters: Array<[string, string, unknown]> }> =
    [];
  const control = {
    repeat: false,
    invalidSize: false,
    error: null as Error | null,
    fence: 0,
    changed: false,
  };
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
      if (control.error) throw control.error;
      const docs = (tables[this.table] ?? [])
        .filter((row) =>
          this.filters.every(([field, op, value]) =>
            op === 'in' ? (value as unknown[]).includes(row[field]) : row[field] === value,
          ),
        )
        .map((row) => new Doc(documentKey(String(row.physicalId ?? row.id)), row))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((doc) => control.repeat || doc.id > this.cursor)
        .slice(0, this.cap);
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
          return control.changed && control.fence > 1
            ? new Doc(
                documentKey(id),
                { agentId: id, status: 'complete' },
                Timestamp.fromMillis(1000),
              )
            : new Doc(documentKey(id));
        }
        return new Doc(
          documentKey(id),
          tables[table]?.find((row) => row.id === id),
        );
      },
    }),
    db: {
      getAll: async (...refs: Array<{ table: string; id: string }>) =>
        refs.map(({ table, id }) => {
          pointCalls.push(table);
          return new Doc(
            documentKey(id),
            tables[table]?.find((row) => row.id === id),
          );
        }),
    },
  } as unknown as InstallationStore;
  return { store, calls, control, pointCalls };
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
    const f = fixture({ memories: rows(401, memory()) });
    const repo = new FirestoreProfileLibraryRepository(f.store);
    const [list, filters] = await Promise.all([
      repo.list('owner', input),
      repo.listFilters('owner'),
    ]);
    expect(list.total).toBe(401);
    expect(list.rows).toHaveLength(60);
    expect(filters.subjects).toEqual([]);
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
});
