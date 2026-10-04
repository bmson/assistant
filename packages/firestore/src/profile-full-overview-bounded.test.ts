import { expect, it } from 'vitest';
import { FirestoreProfileOverviewRepository } from './profile-full-overview.js';
import { documentKey, type InstallationStore } from './store.js';

type Row = Record<string, unknown>;
type Entry = { id: string; row: Row };

class FakeDocument {
  readonly exists: boolean;

  constructor(
    readonly id: string,
    private readonly row?: Row,
  ) {
    this.exists = row !== undefined;
  }

  get(field: string): unknown {
    return this.row?.[field];
  }

  data(): Row {
    return this.row ?? {};
  }
}

class FakeQuery {
  constructor(
    private readonly rows: Entry[],
    private readonly stats: { largestPage: number; pages: number; projections: string[][] },
    private readonly filters: Array<[string, unknown]> = [],
    private readonly pageSize = Number.MAX_SAFE_INTEGER,
    private readonly cursor?: string,
  ) {}

  where(field: string, _operator: string, value: unknown): FakeQuery {
    return new FakeQuery(this.rows, this.stats, [...this.filters, [field, value]], this.pageSize);
  }

  orderBy(): FakeQuery {
    return new FakeQuery(this.rows, this.stats, this.filters, this.pageSize, this.cursor);
  }

  limit(size: number): FakeQuery {
    this.stats.largestPage = Math.max(this.stats.largestPage, size);
    return new FakeQuery(this.rows, this.stats, this.filters, size, this.cursor);
  }

  select(...fields: string[]): FakeQuery {
    this.stats.projections.push(fields);
    return this;
  }

  startAfter(cursor: FakeDocument): FakeQuery {
    return new FakeQuery(this.rows, this.stats, this.filters, this.pageSize, cursor.id);
  }

  async get(): Promise<{ size: number; docs: FakeDocument[] }> {
    this.stats.pages += 1;
    const matching = this.rows
      .filter(({ row }) =>
        this.filters.every(
          ([field, value]) =>
            String(field)
              .split('.')
              .reduce<unknown>((at, key) => (at as Row | undefined)?.[key], row) === value,
        ),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const after = this.cursor ? matching.findIndex((entry) => entry.id === this.cursor) + 1 : 0;
    const docs = matching
      .slice(after, after + this.pageSize)
      .map(({ id, row }) => new FakeDocument(id, row));
    return { size: docs.length, docs };
  }
}

function entries(rows: Row[]): Entry[] {
  return rows.map((row) => ({ id: documentKey(String(row.id)), row }));
}

it('streams canary-sized workspace collections while preserving the full profile projection', async () => {
  const now = new Date('2026-09-23T12:00:00.000Z');
  const taskRows = Array.from({ length: 12_945 }, (_, index) => ({
    id: `task-${String(index).padStart(5, '0')}`,
    agentId: 'owner',
    status: 'done',
    progress: `${index}%`,
    updatedAt: new Date(now.getTime() + index),
    createdAt: new Date(now.getTime() + index),
    trigger:
      index % 4_000 === 0
        ? { payload: { job: 'memory.consolidate' } }
        : { payload: { job: 'other' } },
  }));
  const memoryRows = Array.from({ length: 4_519 }, (_, index) => ({
    id: `memory-${String(index).padStart(4, '0')}`,
    agentId: 'owner',
    category: index % 9 === 0 ? 'episode' : 'knowledge',
    quarantined: index % 7 === 0,
    expiresAt: index % 13 === 0 ? new Date(now.getTime() - 1) : null,
    ownerConfirmed: index % 2 === 0,
    lastConsolidatedAt: index % 4 === 0 ? new Date(now.getTime() - index) : null,
    subjectContactId: index < 80 ? 'owner-contact' : 'person-contact',
    createdAt: new Date(now.getTime() - index * 1_000),
    content: `memory body ${index}`,
    kind: 'fact',
    domain: 'work',
    confidence: (0.5 + (index % 50) / 100).toFixed(2),
    importance: index % 6,
    pinned: index % 11 === 0,
    originTrust: 'owner',
    sourceTaskId: null,
    validFrom: null,
    validUntil: null,
  }));
  const data: Record<string, Entry[]> = {
    agents: entries([{ id: 'owner' }]),
    contacts: entries([
      {
        id: 'owner-contact',
        name: 'Owner',
        trust: 'owner',
        aliases: [],
        relationship: '',
      },
      {
        id: 'person-contact',
        name: 'Person',
        trust: 'known',
        aliases: ['P'],
        relationship: 'friend',
      },
    ]),
    memories: entries(memoryRows),
    tasks: entries(taskRows),
    writingSamples: [],
    importSources: [],
  };
  const stats = { largestPage: 0, pages: 0, projections: [] as string[][] };
  const getAllMasks: string[][] = [];
  const store = {
    collection(name: string) {
      return new FakeQuery(data[name] ?? [], stats);
    },
    doc(collection: string, id: string) {
      const row = data[collection]?.find((entry) => entry.id === documentKey(id))?.row;
      const doc = new FakeDocument(documentKey(id), row);
      return { id: doc.id, get: async () => doc };
    },
    db: {
      async getAll(...args: Array<{ id: string } | { fieldMask: string[] }>) {
        const options = args.find((arg) => 'fieldMask' in arg) as
          | { fieldMask: string[] }
          | undefined;
        if (options) getAllMasks.push(options.fieldMask);
        const refs = args.filter((arg): arg is { id: string } => 'id' in arg);
        return refs.map((ref) => {
          const row = data.memories?.find((entry) => entry.id === ref.id)?.row;
          return new FakeDocument(ref.id, row);
        });
      },
    },
    now: () => now,
  } as unknown as InstallationStore;
  const repository = new FirestoreProfileOverviewRepository(store, 'owner');
  const activeKnowledge = memoryRows.filter(
    (row) => row.category === 'knowledge' && (!row.expiresAt || row.expiresAt > now),
  );
  const usable = activeKnowledge.filter((row) => !row.quarantined);
  const expectedOwnerFacts = usable
    .filter((row) => row.subjectContactId === 'owner-contact')
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        right.importance - left.importance ||
        Number(right.confidence) - Number(left.confidence),
    );
  const expectedQuarantined = activeKnowledge
    .filter((row) => row.quarantined)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, 100);

  const profile = await repository.load();
  expect(profile.owner).toMatchObject({ id: 'owner-contact', name: 'Owner' });
  expect(profile.people).toEqual([
    {
      contact: {
        id: 'person-contact',
        name: 'Person',
        aliases: ['P'],
        relationship: 'friend',
        trust: 'known',
      },
      factCount: usable.filter((row) => row.subjectContactId === 'person-contact').length,
    },
  ]);
  expect(profile.ownerFacts.map((row) => row.id)).toEqual(expectedOwnerFacts.map((row) => row.id));
  expect(profile.quarantined.map((row) => row.id)).toEqual(
    expectedQuarantined.map((row) => row.id),
  );
  expect(profile.memoryHealth).toEqual({
    totalUsable: usable.length,
    notYetOrganized: usable.filter((row) => !row.lastConsolidatedAt).length,
    awaitingReview: activeKnowledge.filter((row) => row.quarantined).length,
    ownerConfirmed: usable.filter((row) => row.ownerConfirmed).length,
    lastOrganizedAt: new Date(now.getTime() - 4),
  });
  expect(profile.latestOrganizer).toEqual({
    id: taskRows[12_000]?.id,
    status: 'done',
    progress: '12000%',
    updatedAt: taskRows[12_000]?.updatedAt,
  });
  expect(profile.voiceStats).toEqual({ total: 0, auto: 0, uploaded: 0 });
  expect(profile.card).toBeNull();
  expect(stats.largestPage).toBe(1000);
  // The memories are read in a handful of pages. The 12,945 tasks are not read at
  // all: the newest consolidation run comes from one targeted query, where it used
  // to take more than thirty pages of every task the assistant had created.
  expect(stats.pages).toBeGreaterThanOrEqual(6);
  expect(stats.pages).toBeLessThan(12);
  // Owner facts are fetched without their embeddings, in one read per hundred.
  expect(getAllMasks.length).toBeGreaterThan(0);
  for (const mask of getAllMasks) {
    expect(mask).toContain('content');
    expect(mask).not.toContain('embedding');
  }
  const memoryProjection = stats.projections.find((fields) => fields.includes('subjectContactId'));
  expect(memoryProjection).toBeDefined();
  expect(memoryProjection).not.toContain('content');
});
