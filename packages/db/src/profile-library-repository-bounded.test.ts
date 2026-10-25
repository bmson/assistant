import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import {
  createPostgresProfileLibraryRepository,
  PostgresProfileLibraryFilterLimitError,
} from './profile-library-repository.js';

function fakeDb(subjectCount: number, sourceCount: number, failure?: Error) {
  const streams: Array<{ where?: SQL; limit?: number; groups: unknown[]; order: unknown[] }> = [];
  const db = {
    select() {
      const index = streams.length;
      const captured: (typeof streams)[number] = { groups: [], order: [] };
      streams.push(captured);
      const query = {
        from() {
          return query;
        },
        innerJoin() {
          return query;
        },
        where(condition: SQL) {
          captured.where = condition;
          return query;
        },
        groupBy(...fields: unknown[]) {
          captured.groups = fields;
          return query;
        },
        orderBy(...fields: unknown[]) {
          captured.order = fields;
          return query;
        },
        async limit(limit: number) {
          captured.limit = limit;
          if (failure) throw failure;
          return Array.from(
            { length: Math.min(limit, index === 0 ? subjectCount : sourceCount) },
            (_, i) =>
              index === 0
                ? { id: `person-${i}`, label: `Person ${i}`, trust: 'known' }
                : { source: `source-${i}` },
          );
        },
      };
      return query;
    },
  } as unknown as Db;
  return { db, streams };
}

describe('PostgreSQL library grouped-filter output bound (offline)', () => {
  it.each([0, 999, 1000])(
    'returns complete %i-row streams using exactly the two existing queries',
    async (count) => {
      const f = fakeDb(count, count);
      const result = await createPostgresProfileLibraryRepository(f.db).listFilters('owner-agent');
      expect(result.subjects).toHaveLength(count);
      expect(result.sources).toHaveLength(count);
      expect(f.streams).toHaveLength(2);
      expect(f.streams.map((stream) => stream.limit)).toEqual([1001, 1001]);
      const conditions = f.streams.map((stream) => {
        if (!stream.where) throw new Error('Expected an owner-scoped filter predicate');
        return new PgDialect().sqlToQuery(stream.where);
      });
      expect(conditions.map((condition) => condition.params)).toEqual([
        ['owner-agent', 'knowledge'],
        ['owner-agent', 'knowledge'],
      ]);
      expect(conditions[1]?.sql).toContain('is not null');
      expect(f.streams.map((stream) => [stream.groups.length, stream.order.length])).toEqual([
        [3, 2],
        [1, 1],
      ]);
    },
  );

  it.each([
    [1001, 1],
    [1, 1001],
    [1001, 1001],
  ])(
    'rejects subject/source sentinel overflow %i/%i without extra count or fallback query',
    async (subjects, sources) => {
      const f = fakeDb(subjects, sources);
      await expect(
        createPostgresProfileLibraryRepository(f.db).listFilters('owner-agent'),
      ).rejects.toBeInstanceOf(PostgresProfileLibraryFilterLimitError);
      expect(f.streams).toHaveLength(2);
      expect(f.streams.map((stream) => stream.limit)).toEqual([1001, 1001]);
    },
  );

  it('propagates the original query error without replacing it with empty filters', async () => {
    const error = new Error('statement timeout');
    const f = fakeDb(1, 1, error);
    await expect(
      createPostgresProfileLibraryRepository(f.db).listFilters('owner-agent'),
    ).rejects.toBe(error);
    expect(f.streams).toHaveLength(2);
  });
});
