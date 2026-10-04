import { expect, it } from 'vitest';
import { FirestoreShellStatusRepository } from './shell-status.js';
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

  select(...fields: string[]): FakeQuery {
    this.stats.projections.push(fields);
    return new FakeQuery(this.rows, this.stats, this.filters, this.pageSize, this.cursor);
  }

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

  startAfter(cursor: FakeDocument): FakeQuery {
    return new FakeQuery(this.rows, this.stats, this.filters, this.pageSize, cursor.id);
  }

  count(): { get: () => Promise<{ data: () => { count: number } }> } {
    return {
      get: async () => ({
        data: () => ({
          count: this.rows.filter(({ row }) =>
            this.filters.every(([field, value]) => row[field] === value),
          ).length,
        }),
      }),
    };
  }

  async get(): Promise<{ size: number; docs: FakeDocument[] }> {
    this.stats.pages += 1;
    const matching = this.rows
      .filter(({ row }) => this.filters.every(([field, value]) => row[field] === value))
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

it('pages imported-size source collections and preserves exact shell counts', async () => {
  const now = new Date('2026-09-23T12:00:00.000Z');
  const taskRows = Array.from({ length: 12_945 }, (_, index) => ({
    id: `task-${String(index).padStart(5, '0')}`,
    agentId: 'owner',
    status: index % 3 === 0 ? 'needs_attention' : index % 3 === 1 ? 'running' : 'done',
  }));
  const memoryRows = Array.from({ length: 4_519 }, (_, index) => ({
    id: `memory-${String(index).padStart(4, '0')}`,
    agentId: 'owner',
    category: index % 9 === 0 ? 'episode' : 'knowledge',
    quarantined: index % 7 === 0,
    expiresAt: index % 13 === 0 ? new Date(now.getTime() - 1) : null,
    ownerConfirmed: index % 2 === 0,
    lastConsolidatedAt: index % 4 === 0 ? now : null,
    content: 'large memory payload omitted from the shell projection',
  }));
  const approvalRows = [
    {
      id: 'owner-pending-a',
      taskId: taskRows[0]?.id,
      status: 'pending',
      expiresAt: new Date(now.getTime() + 60_000),
    },
    {
      id: 'owner-pending-b',
      taskId: taskRows[1]?.id,
      status: 'pending',
      expiresAt: new Date(now.getTime() + 60_000),
    },
    {
      id: 'unknown-task',
      taskId: 'missing',
      status: 'pending',
      expiresAt: new Date(now.getTime() + 60_000),
    },
    {
      id: 'resolved',
      taskId: taskRows[0]?.id,
      status: 'approved',
      expiresAt: new Date(now.getTime() + 60_000),
    },
  ];
  const data: Record<string, Entry[]> = {
    agents: entries([{ id: 'owner' }]),
    tasks: entries(taskRows),
    memories: entries(memoryRows),
    approvals: entries(approvalRows),
  };
  const stats = { largestPage: 0, pages: 0, projections: [] as string[][] };
  const store = {
    collection(name: string) {
      return new FakeQuery(data[name] ?? [], stats);
    },
    doc(collection: string, id: string) {
      const row = data[collection]?.find((entry) => entry.id === documentKey(id))?.row;
      const doc = new FakeDocument(documentKey(id), row);
      return { id: doc.id, collection, get: async () => doc };
    },
    db: {
      // Pending approvals' tasks are read in one batch, one or two fields each.
      async getAll(...args: Array<{ id: string; collection?: string }>) {
        return args
          .filter((arg) => arg.collection === 'tasks')
          .map((ref) => {
            const row = data.tasks?.find((entry) => entry.id === ref.id)?.row;
            return new FakeDocument(ref.id, row);
          });
      },
    },
    now: () => now,
  } as unknown as InstallationStore;
  const repository = new FirestoreShellStatusRepository(store, 'owner');
  const unexpiredKnowledge = memoryRows.filter(
    (memory) => memory.category === 'knowledge' && (!memory.expiresAt || memory.expiresAt > now),
  );
  const usable = unexpiredKnowledge.filter((memory) => !memory.quarantined);

  await expect(repository.load('owner')).resolves.toEqual({
    dashboard: {
      pendingApprovals: 2,
      needsAttention: taskRows.filter((task) => task.status === 'needs_attention').length,
      presence: 'attention',
    },
    memoryHealth: {
      totalUsable: usable.length,
      notYetOrganized: usable.filter((memory) => !memory.lastConsolidatedAt).length,
      awaitingReview: unexpiredKnowledge.filter((memory) => memory.quarantined).length,
      ownerConfirmed: usable.filter((memory) => memory.ownerConfirmed).length,
      lastOrganizedAt: now,
    },
  });
  expect(stats.largestPage).toBe(1000);
  // The memories and the pending approvals are paged; the 12,945 tasks are not
  // read at all — their statuses are counted, which used to take more than
  // twenty-five pages of every task the assistant had created.
  expect(stats.pages).toBeGreaterThanOrEqual(6);
  expect(stats.pages).toBeLessThan(12);
  expect(stats.projections).not.toContainEqual(['id', 'agentId', 'status']);
  expect(stats.projections).toContainEqual([
    'id',
    'agentId',
    'category',
    'expiresAt',
    'quarantined',
    'ownerConfirmed',
    'lastConsolidatedAt',
  ]);
  expect(stats.projections).toContainEqual(['id', 'taskId', 'expiresAt']);
});

it('rechecks the privacy erasure fence after the approval scan', async () => {
  const now = new Date('2026-09-23T12:00:00.000Z');
  const changedAt = { isEqual: () => false };
  let fenceReads = 0;
  const emptyQuery = {
    where() {
      return this;
    },
    select() {
      return this;
    },
    orderBy() {
      return this;
    },
    limit() {
      return this;
    },
    startAfter() {
      return this;
    },
    count() {
      return { get: async () => ({ data: () => ({ count: 0 }) }) };
    },
    async get() {
      return { size: 0, docs: [] };
    },
  };
  const store = {
    collection() {
      return emptyQuery;
    },
    doc(collection: string) {
      if (collection === 'agents') {
        return {
          async get() {
            return { exists: true, id: documentKey('owner'), get: () => 'owner' };
          },
        };
      }
      if (collection === 'privacyErasureJobs') {
        return {
          async get() {
            fenceReads += 1;
            return fenceReads < 3
              ? { exists: false }
              : {
                  exists: true,
                  updateTime: changedAt,
                  get(field: string) {
                    return field === 'agentId' ? 'owner' : 'complete';
                  },
                };
          },
        };
      }
      return {
        async get() {
          return { exists: false };
        },
      };
    },
    now: () => now,
  } as unknown as InstallationStore;

  await expect(new FirestoreShellStatusRepository(store, 'owner').load('owner')).rejects.toThrow(
    'Privacy erasure changed during read',
  );
  expect(fenceReads).toBe(3);
});
