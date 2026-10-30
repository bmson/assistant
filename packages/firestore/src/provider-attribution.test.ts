import { describe, expect, it } from 'vitest';
import { readProviderAttribution } from './provider-attribution.js';
import type { InstallationStore } from './store.js';

interface FakeRow {
  createdAt: Date;
  model: unknown;
  costUsd?: string;
  taskId?: string;
  prompt?: string;
}

class FakeDocument {
  constructor(
    readonly position: number,
    private readonly row: FakeRow,
  ) {}

  data() {
    return this.row;
  }
}

interface FakeQueryState {
  filters?: Array<{ field: string; op: string; value: unknown }>;
  selected?: string[];
  startPosition?: number | null;
  pageSize?: number | null;
}

interface FakeQueryTrace {
  reads: number;
  collections: number;
  selections: string[][];
  whereValues: Array<{ field: string; op: string; value: unknown }>;
  includeOutOfRangeRows: boolean;
  onFirstGet?: () => void;
}

class FakeQuery {
  private readonly filters: Array<{ field: string; op: string; value: unknown }> = [];
  private readonly selected: string[] = [];
  private readonly startPosition: number | null = null;
  private readonly pageSize: number | null = null;

  constructor(
    private readonly rows: FakeRow[],
    private readonly trace: FakeQueryTrace,
    state?: FakeQueryState,
  ) {
    Object.assign(this, state);
  }

  where(field: string, op: string, value: unknown): FakeQuery {
    this.trace.whereValues.push({ field, op, value });
    return this.next({ filters: [...this.filters, { field, op, value }] });
  }

  orderBy(_field: string): FakeQuery {
    return this.next({});
  }

  select(...fields: string[]): FakeQuery {
    this.trace.selections.push(fields);
    return this.next({ selected: fields });
  }

  startAfter(document: FakeDocument): FakeQuery {
    return this.next({ startPosition: document.position });
  }

  limit(value: number): FakeQuery {
    return this.next({ pageSize: value });
  }

  async get() {
    this.trace.reads += 1;
    const onFirstGet = this.trace.onFirstGet;
    this.trace.onFirstGet = undefined;
    onFirstGet?.();
    const lower = this.filters.find((filter) => filter.op === '>=')?.value as Date;
    const upper = this.filters.find((filter) => filter.op === '<')?.value as Date;
    const matching = this.rows
      .map((row, position) => ({ row, position }))
      .filter(
        ({ row }) =>
          this.trace.includeOutOfRangeRows ||
          !Number.isFinite(row.createdAt.getTime()) ||
          (row.createdAt >= lower && row.createdAt < upper),
      )
      .sort((a, b) => a.row.createdAt.getTime() - b.row.createdAt.getTime());
    const after = matching.slice((this.startPosition ?? -1) + 1);
    const docs = after
      .slice(0, this.pageSize ?? 0)
      .map(({ row }, index) => new FakeDocument((this.startPosition ?? -1) + index + 1, row));
    return { docs, size: docs.length };
  }

  private next(state: FakeQueryState): FakeQuery {
    return new FakeQuery(this.rows, this.trace, {
      filters: this.filters,
      selected: this.selected,
      startPosition: this.startPosition,
      pageSize: this.pageSize,
      ...state,
    });
  }
}

function fakeStore(
  rows: FakeRow[],
  options: { includeOutOfRangeRows?: boolean; onFirstGet?: () => void } = {},
) {
  const trace: FakeQueryTrace = {
    reads: 0,
    collections: 0,
    selections: [],
    whereValues: [],
    includeOutOfRangeRows: options.includeOutOfRangeRows ?? false,
    ...(options.onFirstGet ? { onFirstGet: options.onFirstGet } : {}),
  };
  const query = new FakeQuery(rows, trace);
  const store = {
    collection: () => {
      trace.collections += 1;
      return query;
    },
    now: () => now,
  } as unknown as InstallationStore;
  return { store, trace };
}

const startUtc = new Date('2026-10-01T00:00:00.000Z');
const endUtc = new Date('2026-10-02T00:00:00.000Z');
const now = new Date('2026-10-03T00:00:00.000Z');

describe('readProviderAttribution', () => {
  it('uses an inclusive start, exclusive end, and serializes only aggregate fields', async () => {
    const { store, trace } = fakeStore([
      {
        createdAt: startUtc,
        model: 'openai:gpt-x',
        costUsd: '0.9',
        taskId: 'private-task-id',
        prompt: 'private prompt text',
      },
      { createdAt: new Date('2026-10-01T04:00:00Z'), model: 'vendor/model-x' },
      { createdAt: new Date('2026-10-01T05:00:00Z'), model: 'vertex:model-x' },
      { createdAt: new Date('2026-10-01T06:00:00Z'), model: 'gw:gateway-1:model-x' },
      { createdAt: new Date('2026-10-01T07:00:00Z'), model: 'gw::malformed' },
      { createdAt: endUtc, model: 'openai:gpt-outside' },
    ]);

    const report = await readProviderAttribution({ store, startUtc, endUtc });

    expect(report).toEqual({
      startUtc: startUtc.toISOString(),
      endUtc: endUtc.toISOString(),
      complete: true,
      scannedCount: 5,
      pageCount: 1,
      counts: {
        openai: 1,
        openrouter: 1,
        vertex: 1,
        openai_compatible: 1,
        unknown: 1,
      },
    });
    expect(trace.selections).toEqual([['createdAt', 'model']]);
    expect(JSON.stringify(report)).not.toContain('private-task-id');
    expect(JSON.stringify(report)).not.toContain('private prompt text');
    expect(JSON.stringify(report)).not.toContain('0.9');
  });

  it.each([
    { label: 'invalid start', startUtc: new Date(Number.NaN), endUtc },
    { label: 'invalid end', startUtc, endUtc: new Date(Number.NaN) },
    { label: 'equal bounds', startUtc, endUtc: startUtc },
    { label: 'reversed bounds', startUtc: endUtc, endUtc: startUtc },
    { label: 'future end', startUtc: now, endUtc: new Date('2026-10-04T00:00:00Z') },
    {
      label: 'range over 31 days',
      startUtc: new Date('2026-09-01T00:00:00Z'),
      endUtc: new Date('2026-10-03T00:00:00Z'),
    },
  ])('rejects $label before opening Firestore', async ({ startUtc, endUtc }) => {
    const { store, trace } = fakeStore([]);
    await expect(readProviderAttribution({ store, startUtc, endUtc })).rejects.toThrow();
    expect(trace.collections).toBe(0);
    expect(trace.reads).toBe(0);
  });

  it('accepts an exact 31-day empty interval and completes on its first partial page', async () => {
    const { store, trace } = fakeStore([]);
    const report = await readProviderAttribution({
      store,
      startUtc: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
      endUtc: now,
    });

    expect(report).toMatchObject({ complete: true, scannedCount: 0, pageCount: 1 });
    expect(trace.reads).toBe(1);
  });

  it('completes after an exactly full page when the next page is empty', async () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({
      createdAt: new Date(startUtc.getTime() + index),
      model: 'vendor/model-x',
    }));
    const { store, trace } = fakeStore(rows);

    const report = await readProviderAttribution({ store, startUtc, endUtc });

    expect(report).toMatchObject({ complete: true, scannedCount: 250, pageCount: 2 });
    expect(trace.reads).toBe(2);
  });

  it('fails closed on invalid timestamps and out-of-range rows returned by the fake query', async () => {
    const invalidDateStore = fakeStore([
      { createdAt: new Date(Number.NaN), model: 'openai:gpt-x' },
    ]);
    await expect(
      readProviderAttribution({ store: invalidDateStore.store, startUtc, endUtc }),
    ).rejects.toThrow('outside the requested UTC interval');

    const outOfRangeStore = fakeStore([{ createdAt: endUtc, model: 'openai:gpt-x' }], {
      includeOutOfRangeRows: true,
    });
    await expect(
      readProviderAttribution({ store: outOfRangeStore.store, startUtc, endUtc }),
    ).rejects.toThrow('outside the requested UTC interval');
  });

  it('uses snapshotted date bounds if caller dates mutate while a paged read is pending', async () => {
    const callerStart = new Date(startUtc.getTime());
    const callerEnd = new Date(endUtc.getTime());
    const rows = Array.from({ length: 251 }, (_, index) => ({
      createdAt: new Date(startUtc.getTime() + index),
      model: 'openai:gpt-x',
    }));
    const { store, trace } = fakeStore(rows, {
      onFirstGet: () => {
        callerStart.setTime(now.getTime());
        callerEnd.setTime(now.getTime() + 24 * 60 * 60 * 1000);
      },
    });

    const report = await readProviderAttribution({
      store,
      startUtc: callerStart,
      endUtc: callerEnd,
    });

    expect(report).toMatchObject({
      startUtc: startUtc.toISOString(),
      endUtc: endUtc.toISOString(),
      complete: true,
      scannedCount: 251,
      pageCount: 2,
    });
    expect(trace.whereValues.map(({ value }) => (value as Date).toISOString())).toEqual([
      startUtc.toISOString(),
      endUtc.toISOString(),
    ]);
    expect(trace.reads).toBe(2);
  });

  it.each([5000, 5001])('stops at 20 pages and reports %s rows as incomplete', async (rowCount) => {
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      createdAt: new Date(startUtc.getTime() + index),
      model: 'openai:gpt-x',
    }));
    const { store, trace } = fakeStore(rows);

    const report = await readProviderAttribution({ store, startUtc, endUtc });

    expect(trace.reads).toBe(20);
    expect(report).toMatchObject({ complete: false, scannedCount: 5000, pageCount: 20 });
    expect(report.counts.openai).toBe(5000);
  });
});
