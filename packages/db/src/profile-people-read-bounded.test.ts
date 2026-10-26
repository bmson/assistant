import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import {
  createPostgresProfilePeopleReadRepository,
  PostgresProfileOccasionLimitError,
} from './profile-people-read-repository.js';

function fixture(count: number, failure?: Error) {
  const state: { limit?: number; where?: SQL; order: unknown[]; reads: number } = {
    order: [],
    reads: 0,
  };
  const rows = Array.from({ length: count }, (_, id) => ({ id: String(id) }));
  const query = {
    from() {
      return query;
    },
    where(condition: SQL) {
      state.where = condition;
      return query;
    },
    orderBy(...fields: unknown[]) {
      state.order = fields;
      return query;
    },
    limit(limit: number) {
      state.limit = limit;
      return query;
    },
    // biome-ignore lint/suspicious/noThenProperty: Drizzle query fixtures intentionally preserve its awaitable contract.
    then(resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) {
      state.reads++;
      return (
        failure
          ? Promise.reject(failure)
          : Promise.resolve(state.limit === undefined ? rows : rows.slice(0, state.limit))
      ).then(resolve, reject);
    },
  };
  return { db: { select: () => query } as unknown as Db, state };
}
describe('browse-only profile occasion output bound', () => {
  it.each([0, 999, 1000])(
    'returns complete %i-row output in one owner-scoped ordered query',
    async (count) => {
      const f = fixture(count);
      expect(
        await createPostgresProfilePeopleReadRepository(f.db, 'owner', undefined, {
          browseOnly: true,
        }).listOccasions('person'),
      ).toHaveLength(count);
      expect(f.state.limit).toBe(1001);
      expect(f.state.reads).toBe(1);
      expect(f.state.order).toHaveLength(3);
      if (!f.state.where) throw new Error('Expected an owner-scoped occasion predicate');
      expect(new PgDialect().sqlToQuery(f.state.where).params).toEqual(['owner', 'person']);
    },
  );
  it('rejects raw sentinel overflow without publishing partial output or querying a fallback', async () => {
    const f = fixture(1001);
    await expect(
      createPostgresProfilePeopleReadRepository(f.db, 'owner', undefined, {
        browseOnly: true,
      }).listOccasions('person'),
    ).rejects.toBeInstanceOf(PostgresProfileOccasionLimitError);
    expect(f.state.reads).toBe(1);
  });
  it('preserves uncapped default/editor behavior and propagates query failure', async () => {
    const legacy = fixture(1001);
    expect(
      await createPostgresProfilePeopleReadRepository(legacy.db, 'owner').listOccasions('person'),
    ).toHaveLength(1001);
    expect(legacy.state.limit).toBeUndefined();
    const error = new Error('statement timeout');
    const f = fixture(0, error);
    await expect(
      createPostgresProfilePeopleReadRepository(f.db, 'owner', undefined, {
        browseOnly: true,
      }).listOccasions('person'),
    ).rejects.toBe(error);
    expect(f.state.reads).toBe(1);
  });
});
