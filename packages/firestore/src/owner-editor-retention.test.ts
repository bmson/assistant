import { randomUUID } from 'node:crypto';
import {
  type OwnerEditorOperationRecord,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
} from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirestoreMaintenanceRepository } from './maintenance.js';
import { pruneExpiredFirestoreOwnerEditorReceipts } from './owner-editor-retention.js';
import { documentKey, type InstallationStore } from './store.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherOwnerId = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
const baseNow = new Date('2026-10-25T12:00:00.000Z');
const replayMs = 24 * 60 * 60 * 1000;
const digest = 'a'.repeat(64);

function operation(issuedAt: Date, overrides: Partial<OwnerEditorOperationRecord> = {}) {
  const scope = {
    ownerId,
    sessionDigest: digest,
    epoch,
    privacyGeneration: null,
    command: 'create_person' as const,
    operationId: randomUUID(),
    targetId: null,
    nonce: randomUUID(),
    issuedAt: issuedAt.getTime(),
    expiresAt: issuedAt.getTime() + 10 * 60_000,
  };
  return {
    id: ownerEditorOperationId(scope),
    ownerId,
    epoch,
    privacyGenerationDigest: ownerEditorPrivacyDigest(null),
    operationId: scope.operationId,
    requestHash: 'b'.repeat(64),
    scopeDigest: ownerEditorScopeDigest(scope),
    command: scope.command,
    protocolVersion: 1 as const,
    formIssuedAt: issuedAt,
    formExpiresAt: new Date(scope.expiresAt),
    claimToken: '55555555-5555-4555-8555-555555555555',
    claimExpiresAt: new Date(issuedAt.getTime() + 60_000),
    status: 'preparing' as const,
    statusVersion: 1,
    result: null,
    createdAt: issuedAt,
    updatedAt: issuedAt,
    ...overrides,
  };
}

function fixture(
  options: {
    rows?: Array<{ physicalId?: string; row: ReturnType<typeof operation> }>;
    epochOwner?: string | null;
    epochReady?: boolean;
  } = {},
) {
  const values = new Map<string, Record<string, unknown>>();
  const events: string[] = [];
  const deletions: string[] = [];
  let readsAfterWrite = false;
  let wrote = false;
  const put = (table: string, physicalId: string, value: Record<string, unknown>) => {
    values.set(`${table}/${physicalId}`, value);
  };

  class Ref {
    readonly id: string;
    constructor(
      readonly table: string,
      readonly logicalId: string,
    ) {
      this.id = documentKey(logicalId);
    }
    get snapshotPath() {
      return `${this.table}/${this.id}`;
    }
  }
  class Snapshot {
    readonly exists: boolean;
    readonly ref: Ref;
    constructor(table: string, physicalId: string) {
      this.ref = Object.assign(Object.create(Ref.prototype) as Ref, {
        table,
        logicalId: physicalId,
        id: physicalId,
      });
      this.exists = values.has(`${table}/${physicalId}`);
    }
    get id() {
      return this.ref.id;
    }
    data() {
      return values.get(this.ref.snapshotPath);
    }
    get(field: string) {
      return this.data()?.[field];
    }
  }
  class Query {
    readonly filters: Array<[string, string, unknown]> = [];
    readonly orderings: Array<[string, 'asc' | 'desc']> = [];
    cap: number | undefined;
    constructor(readonly table: string) {}
    where(field: string, operator: string, expected: unknown) {
      this.filters.push([field, operator, expected]);
      return this;
    }
    orderBy(field: string, direction: 'asc' | 'desc') {
      this.orderings.push([field, direction]);
      return this;
    }
    limit(cap: number) {
      this.cap = cap;
      return this;
    }
    async get() {
      checkRead();
      events.push(`query:${this.table}`);
      if (this.cap === undefined) throw new Error('Unbounded query in retention fake');
      let rows = [...values.entries()]
        .filter(([key]) => key.startsWith(`${this.table}/`))
        .filter(([, row]) =>
          this.filters.every(([field, operator, expected]) => {
            const value = row[field];
            if (operator === '==') return value === expected;
            if (operator === '<=') {
              const left = value instanceof Date ? value.getTime() : Number.NaN;
              const right = expected instanceof Date ? expected.getTime() : Number.NaN;
              return left <= right;
            }
            return false;
          }),
        )
        .map(([key, row]) => ({ physicalId: key.slice(`${this.table}/`.length), row }));
      for (const [field, direction] of [...this.orderings].reverse()) {
        rows = rows.sort((a, b) => {
          const av = a.row[field];
          const bv = b.row[field];
          const cmp =
            av instanceof Date && bv instanceof Date
              ? av.getTime() - bv.getTime()
              : String(av).localeCompare(String(bv));
          return direction === 'asc' ? cmp : -cmp;
        });
      }
      const docs = rows
        .slice(0, this.cap)
        .map(({ physicalId }) => new Snapshot(this.table, physicalId));
      return { docs, size: docs.length, empty: docs.length === 0 };
    }
  }
  function checkRead() {
    if (wrote) {
      readsAfterWrite = true;
      throw new Error('Firestore read after first retention delete');
    }
  }
  const store = {
    now: () => baseNow,
    doc: (table: string, id: string) => new Ref(table, id),
    collection: (table: string) => new Query(table),
    db: {
      async runTransaction<T>(run: (tx: unknown) => Promise<T>) {
        wrote = false;
        const pending: Ref[] = [];
        const tx = {
          async get(ref: Ref | Query) {
            checkRead();
            if (ref instanceof Query) return ref.get();
            events.push(`get:${ref.table}`);
            return new Snapshot(ref.table, ref.id);
          },
          async getAll(...refs: Ref[]) {
            checkRead();
            events.push('getAll:privacy-and-epoch');
            return refs.map((ref) => new Snapshot(ref.table, ref.id));
          },
          delete(ref: Ref) {
            wrote = true;
            pending.push(ref);
            events.push(`delete:${ref.table}`);
          },
        };
        const result = await run(tx as never);
        for (const ref of pending) {
          values.delete(ref.snapshotPath);
          deletions.push(ref.logicalId);
        }
        return result;
      },
    },
  } as unknown as InstallationStore;

  put('agents', documentKey(ownerId), { id: ownerId });
  if (options.epochOwner !== null) {
    const name = `owner-editor-epoch:${ownerId}`;
    put('maintenanceCursors', documentKey(name), {
      name,
      cursor: JSON.stringify({
        ownerId: options.epochOwner ?? ownerId,
        epoch,
        ready: options.epochReady ?? false,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      }),
    });
  }
  for (const entry of options.rows ?? []) {
    const record = entry.row;
    const physicalId = entry.physicalId ?? documentKey(record.id);
    put('ownerEditorOperations', physicalId, record);
  }

  return {
    store,
    values,
    events,
    deletions,
    get readsAfterWrite() {
      return readsAfterWrite;
    },
    seed(table: string, id: string, row: Record<string, unknown>) {
      put(table, documentKey(id), row);
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('bounded Firestore owner editor receipt retention', () => {
  it('deletes only rows at or before the replay cutoff in a 50-row page, with metadata reads first', async () => {
    const cutoff = baseNow.getTime() - replayMs;
    const oldRows = Array.from({ length: 51 }, (_, i) => ({
      row: operation(
        new Date(cutoff - 1000 + i),
        i === 0
          ? {
              claimToken: null,
              claimExpiresAt: null,
              status: 'committed',
              statusVersion: 2,
              result: {
                outcome: 'saved',
                ids: { contactId: '44444444-4444-4444-8444-444444444444' },
                revision: 'c'.repeat(64),
              },
            }
          : {},
      ),
    }));
    const exactBoundary = { row: operation(new Date(cutoff)) };
    const recent = { row: operation(new Date(cutoff + 1)) };
    const f = fixture({ rows: [...oldRows, exactBoundary, recent] });

    await expect(
      pruneExpiredFirestoreOwnerEditorReceipts(
        f.store,
        ownerId,
        new Date(baseNow.getTime() - 5000),
      ),
    ).resolves.toBe(50);

    expect(f.deletions).toHaveLength(50);
    expect(f.events.slice(0, 3)).toEqual([
      'query:agents',
      'getAll:privacy-and-epoch',
      'query:ownerEditorOperations',
    ]);
    expect(f.events.slice(3)).toEqual(
      Array.from({ length: 50 }, () => 'delete:ownerEditorOperations'),
    );
    expect(f.readsAfterWrite).toBe(false);
    const remaining = [...f.values.entries()]
      .filter(([key]) => key.startsWith('ownerEditorOperations/'))
      .map(([, value]) => value);
    expect(remaining).toHaveLength(3);
    expect(
      remaining.map((row) => (row.formIssuedAt as Date).getTime()).sort((a, b) => a - b),
    ).toEqual([cutoff - 1000 + 50, cutoff, cutoff + 1]);
  });

  it('allows absent or disabled epochs for retention, but rejects a foreign epoch before query/delete', async () => {
    const absent = fixture({
      epochOwner: null,
      rows: [{ row: operation(new Date(baseNow.getTime() - replayMs - 1)) }],
    });
    await expect(
      pruneExpiredFirestoreOwnerEditorReceipts(absent.store, ownerId, baseNow),
    ).resolves.toBe(1);

    const disabled = fixture({
      epochReady: false,
      rows: [{ row: operation(new Date(baseNow.getTime() - replayMs - 1)) }],
    });
    await expect(
      pruneExpiredFirestoreOwnerEditorReceipts(disabled.store, ownerId, baseNow),
    ).resolves.toBe(1);

    const foreign = fixture({
      epochOwner: otherOwnerId,
      rows: [{ row: operation(new Date(baseNow.getTime() - replayMs - 1)) }],
    });
    await expect(
      pruneExpiredFirestoreOwnerEditorReceipts(foreign.store, ownerId, baseNow),
    ).rejects.toThrow('Editor epoch owner is unavailable');
    expect(foreign.events).not.toContain('query:ownerEditorOperations');
    expect(foreign.deletions).toHaveLength(0);
  });

  it('fails closed on wrong physical document identity before any delete', async () => {
    const expired = operation(new Date(baseNow.getTime() - replayMs - 1));
    const f = fixture({
      rows: [{ row: expired, physicalId: documentKey('different-logical-id') }],
    });
    await expect(
      pruneExpiredFirestoreOwnerEditorReceipts(f.store, ownerId, baseNow),
    ).rejects.toThrow('Editor receipt physical identity is unavailable');
    expect(f.deletions).toHaveLength(0);
  });

  it('rejects invalid maintenance batches before receipt reads or mutations', async () => {
    const f = fixture({ rows: [{ row: operation(new Date(baseNow.getTime() - replayMs - 1)) }] });
    const maintenance = new FirestoreMaintenanceRepository(f.store, ownerId, {
      provider: 'test',
      model: 'unit',
      dimensions: 3,
      revision: '1',
    });
    await expect(
      maintenance.purgeExpired({
        batch: 0,
        locationRetentionDays: 30,
        proactivePingRetentionDays: 90,
        auditRetentionDays: 14,
      }),
    ).rejects.toThrow('Invalid maintenance batch');
    expect(f.events).toEqual([]);
    expect(f.deletions).toEqual([]);
  });
  it('never prunes a current preparing receipt based on a future caller clock', async () => {
    const f = fixture({ rows: [{ row: operation(new Date(baseNow.getTime() - 1000)) }] });
    expect(
      await pruneExpiredFirestoreOwnerEditorReceipts(
        f.store,
        ownerId,
        new Date(baseNow.getTime() + 2 * replayMs),
      ),
    ).toBe(0);
    expect(f.deletions).toHaveLength(0);
    expect([...f.values.keys()].some((key) => key.startsWith('ownerEditorOperations/'))).toBe(true);
  });
  it('rejects invalid time before opening a transaction', async () => {
    const f = fixture();
    await expect(
      pruneExpiredFirestoreOwnerEditorReceipts(f.store, ownerId, new Date(Number.NaN)),
    ).rejects.toThrow('Editor receipt retention time is invalid');
    expect(f.events).toHaveLength(0);
  });
});
