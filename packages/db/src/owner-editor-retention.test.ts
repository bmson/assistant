import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from './client.js';
import { pruneExpiredPostgresOwnerEditorReceipts } from './owner-editor-retention.js';
import { agents, maintenanceCursors, ownerEditorOperations } from './schema.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherOwnerId = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
const baseNow = Date.parse('2026-10-25T12:00:00.000Z');
const replayMs = 24 * 60 * 60 * 1000;

function row(id: string, issuedAt: number, rowOwner = ownerId) {
  return { id, ownerId: rowOwner, formIssuedAt: new Date(issuedAt) };
}

function fixture(
  input: {
    rows?: ReturnType<typeof row>[];
    epochOwner?: string | null;
    ambiguousOwner?: boolean;
  } = {},
) {
  const events: string[] = [];
  const queries: Array<{ table: unknown; where?: unknown; limit?: number; forUpdate?: string }> =
    [];
  const deletes: Array<{ table: unknown; where: unknown }> = [];
  let maintenanceReads = 0;
  function queryBuilder(table?: unknown) {
    const state: {
      table?: unknown;
      where?: unknown;
      limit?: number;
      forUpdate?: string;
      ordering: unknown[];
    } = { table, ordering: [] };
    const query: Record<string, unknown> = {};
    query.from = (nextTable: unknown) => {
      state.table = nextTable;
      return query;
    };
    query.where = (condition: unknown) => {
      state.where = condition;
      return query;
    };
    query.for = (mode: string) => {
      state.forUpdate = mode;
      return query;
    };
    query.limit = (limit: number) => {
      state.limit = limit;
      return query;
    };
    query.orderBy = (...ordering: unknown[]) => {
      state.ordering = ordering;
      return query;
    };
    // biome-ignore lint/suspicious/noThenProperty: Drizzle select builders are thenable.
    query.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
      events.push(
        `read:${state.table === agents ? 'agents' : state.table === maintenanceCursors ? 'maintenance' : 'operations'}`,
      );
      queries.push({
        table: state.table,
        where: state.where,
        limit: state.limit,
        forUpdate: state.forUpdate,
      });
      try {
        if (state.table === agents)
          return Promise.resolve(
            input.ambiguousOwner && !state.forUpdate
              ? [{ id: ownerId }, { id: otherOwnerId }]
              : [{ id: ownerId }],
          ).then(resolve, reject);
        if (state.table === maintenanceCursors) {
          maintenanceReads += 1;
          const cursor =
            maintenanceReads === 2 && input.epochOwner !== null
              ? JSON.stringify({
                  ownerId: input.epochOwner ?? ownerId,
                  epoch,
                  ready: false,
                  privacyGenerationDigest: 'a'.repeat(64),
                })
              : null;
          return Promise.resolve(cursor ? [{ cursor }] : []).then(resolve, reject);
        }
        const pg = new PgDialect();
        const condition = pg.sqlToQuery(state.where as Parameters<PgDialect['sqlToQuery']>[0]);
        const [scopedOwner, cutoff] = condition.params as [string, Date];
        const cutoffTime = new Date(cutoff).getTime();
        const rows = (input.rows ?? [])
          .filter(
            (candidate) =>
              candidate.ownerId === scopedOwner && candidate.formIssuedAt.getTime() <= cutoffTime,
          )
          .sort(
            (a, b) =>
              a.formIssuedAt.getTime() - b.formIssuedAt.getTime() || a.id.localeCompare(b.id),
          )
          .slice(0, state.limit);
        return Promise.resolve(rows).then(resolve, reject);
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
    };
    return query;
  }
  const tx = {
    select: () => queryBuilder(),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        events.push('delete');
        deletes.push({ table, where: condition });
      },
    }),
  };
  const db = {
    transaction: async <T>(run: (transaction: unknown) => Promise<T>) => run(tx),
  } as unknown as Db;
  return { db, events, queries, deletes };
}

afterEach(() => vi.restoreAllMocks());

describe('bounded PostgreSQL owner editor receipt retention', () => {
  it('removes only owner rows issued at or before the 24-hour cutoff, in a 64-row page', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    const cutoff = baseNow - replayMs;
    const expired = Array.from({ length: 65 }, (_, i) =>
      row(`expired-${String(i).padStart(2, '0')}`, cutoff - 1000 + i),
    );
    const f = fixture({
      rows: [
        ...expired,
        row('boundary', cutoff),
        row('recent', cutoff + 1),
        row('foreign-owner', cutoff - 2000, otherOwnerId),
      ],
      epochOwner: ownerId,
    });

    await expect(
      pruneExpiredPostgresOwnerEditorReceipts(f.db, ownerId, new Date(baseNow - 5000)),
    ).resolves.toBe(64);

    const operationsRead = f.queries.find((query) => query.table === ownerEditorOperations);
    expect(operationsRead?.limit).toBe(64);
    expect(operationsRead?.forUpdate).toBe('update');
    const condition = new PgDialect().sqlToQuery(
      operationsRead?.where as Parameters<PgDialect['sqlToQuery']>[0],
    );
    expect(condition.sql).toContain('"owner_editor_operations"."agent_id" = $1');
    expect(condition.sql).toContain('"owner_editor_operations"."form_issued_at" <= $2');
    expect(condition.params).toEqual([ownerId, new Date(cutoff).toISOString()]);
    expect(
      new PgDialect().sqlToQuery(f.deletes[0]?.where as Parameters<PgDialect['sqlToQuery']>[0])
        .params,
    ).toEqual([ownerId, ...expired.slice(0, 64).map((candidate) => candidate.id)]);
    expect(f.events).toEqual([
      'read:agents',
      'read:maintenance',
      'read:agents',
      'read:maintenance',
      'read:operations',
      'delete',
    ]);
  });

  it('allows a missing epoch but rejects malformed or foreign-owner epoch before receipt reads', async () => {
    const missing = fixture({ rows: [], epochOwner: null });
    await expect(
      pruneExpiredPostgresOwnerEditorReceipts(missing.db, ownerId, new Date(baseNow)),
    ).resolves.toBe(0);
    expect(missing.events).toEqual([
      'read:agents',
      'read:maintenance',
      'read:agents',
      'read:maintenance',
      'read:operations',
    ]);

    const foreign = fixture({
      rows: [row('old', baseNow - replayMs - 1)],
      epochOwner: otherOwnerId,
    });
    await expect(
      pruneExpiredPostgresOwnerEditorReceipts(foreign.db, ownerId, new Date(baseNow)),
    ).rejects.toThrow('Editor epoch owner is unavailable');
    expect(foreign.queries.some((query) => query.table === ownerEditorOperations)).toBe(false);
    expect(foreign.deletes).toHaveLength(0);
  });

  it('never prunes a current preparing receipt based on a future caller clock', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    const f = fixture({ rows: [row('current-preparing', baseNow - 1000)] });
    expect(
      await pruneExpiredPostgresOwnerEditorReceipts(
        f.db,
        ownerId,
        new Date(baseNow + 2 * replayMs),
      ),
    ).toBe(0);
    expect(f.deletes).toHaveLength(0);
  });
  it('rejects ambiguous installation ownership after acquiring the privacy lock and before epoch/receipt reads', async () => {
    const f = fixture({ ambiguousOwner: true });
    await expect(
      pruneExpiredPostgresOwnerEditorReceipts(f.db, ownerId, new Date(baseNow)),
    ).rejects.toThrow('exactly one owner');
    expect(f.events).toEqual(['read:agents', 'read:maintenance', 'read:agents']);
    expect(f.deletes).toEqual([]);
  });
  it('rejects an invalid timestamp before entering the transaction', async () => {
    const f = fixture();
    await expect(
      pruneExpiredPostgresOwnerEditorReceipts(f.db, ownerId, new Date(Number.NaN)),
    ).rejects.toThrow('Editor receipt retention time is invalid');
    expect(f.events).toEqual([]);
  });
});
