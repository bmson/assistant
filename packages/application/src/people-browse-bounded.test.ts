import {
  contacts,
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  memories,
  occasions,
} from '@assistant/db';
import { describe, expect, it, vi } from 'vitest';
import { getPersonDossier, listPeopleDirectory, PeopleBrowseReadLimitError } from './people.js';

vi.mock('@assistant/core/chat', () => ({ getAgent: async () => ({ id: 'owner' }) }));

function fixture(occasionCounts: number[], edgeCount = 0) {
  const calls: Array<{ table: unknown; limit?: number; grouped: boolean }> = [];
  let occasionRead = 0;
  const person = {
    id: 'person',
    name: 'Person',
    identityAuthority: 'inferred',
    trust: 'known',
    relationship: 'friend',
    aliases: [],
    emails: [],
    phones: [],
    notes: '',
    createdAt: new Date('2026-10-26T12:00:00.000Z'),
    updatedAt: new Date('2026-10-26T12:00:00.000Z'),
  };
  const nativePerson = {
    id: 'person',
    name: 'Person',
    identity_authority: 'inferred',
    trust: 'known',
    relationship: 'friend',
    aliases: [],
    emails: [],
    phones: [],
    notes: '',
    created_at: '2026-10-26T12:00:00.000Z',
    updated_at: '2026-10-26T12:00:00.000Z',
  };
  const db = {
    select(fields?: Record<string, unknown>) {
      const call: (typeof calls)[number] = { table: undefined, grouped: false };
      calls.push(call);
      const query = {
        from(table: unknown) {
          call.table = table;
          return query;
        },
        where() {
          return query;
        },
        innerJoin() {
          return query;
        },
        orderBy() {
          return query;
        },
        groupBy() {
          call.grouped = true;
          return query;
        },
        limit(limit: number) {
          call.limit = limit;
          return query;
        },
        // biome-ignore lint/suspicious/noThenProperty: Drizzle query fixtures intentionally preserve its awaitable contract.
        then(resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) {
          try {
            let rows: unknown[] = [];
            if (call.table === contacts)
              rows = fields?.contact ? [{ contact: person, native: nativePerson }] : [person];
            if (call.table === memories && fields?.value) rows = [{ value: 0 }];
            if (call.table === occasions)
              rows = Array.from({ length: occasionCounts[occasionRead++] ?? 0 }, (_, i) => ({
                id: `occasion-${i}`,
                contactId: 'person',
                agentId: 'owner',
                kind: 'birthday',
                label: '',
                month: 1,
                day: 1,
                year: null,
                recurrence: 'yearly',
                leadDays: 7,
                quarantined: false,
              }));
            if (call.table === knowledgeGraphRelations)
              rows = Array.from({ length: edgeCount }, () => ({ contactId: null }));
            if (call.table === knowledgeGraphEntities) rows = [];
            return Promise.resolve(
              call.limit === undefined ? rows : rows.slice(0, call.limit),
            ).then(resolve, reject);
          } catch (error) {
            return Promise.reject(error).then(resolve, reject);
          }
        },
      };
      return query;
    },
  } as unknown as Db;
  return { db, calls };
}

describe('browse-only PostgreSQL directory output ceilings', () => {
  it.each([999, 1000])(
    'keeps complete %i-occasion directory output under the sentinel ceiling',
    async (count) => {
      const f = fixture([count]);
      expect(await listPeopleDirectory(f.db, { browseOnly: true })).toHaveLength(1);
      expect(f.calls.find((call) => call.table === occasions)?.limit).toBe(1001);
      expect(f.calls.find((call) => call.table === knowledgeGraphRelations)?.limit).toBe(10001);
      expect(f.calls).toHaveLength(5);
    },
  );
  it.each([
    [1001, 0],
    [0, 10001],
  ])(
    'fails raw occasion/edge overflow %i/%i before returning a partial summary',
    async (occasionCount, edgeCount) => {
      const f = fixture([occasionCount], edgeCount);
      await expect(listPeopleDirectory(f.db, { browseOnly: true })).rejects.toBeInstanceOf(
        PeopleBrowseReadLimitError,
      );
      expect(f.calls).toHaveLength(5);
    },
  );
  it('accepts exactly 10,000 edges and leaves default/mobile reads uncapped', async () => {
    const bounded = fixture([0], 10000);
    expect(await listPeopleDirectory(bounded.db, { browseOnly: true })).toHaveLength(1);
    const legacy = fixture([1001], 10001);
    expect(await listPeopleDirectory(legacy.db)).toHaveLength(1);
    expect(
      legacy.calls
        .filter((call) => call.table === occasions || call.table === knowledgeGraphRelations)
        .map((call) => call.limit),
    ).toEqual([undefined, undefined]);
  });
  it('also bounds the retained second dossier occasion read without an editor directory scan', async () => {
    const f = fixture([0, 1001]);
    await expect(
      getPersonDossier(f.db, 'person', { includeEditingSuggestions: false }),
    ).rejects.toMatchObject({ code: 'POSTGRES_PROFILE_OCCASION_LIMIT' });
    expect(f.calls.filter((call) => call.table === contacts)).toHaveLength(1);
    expect(f.calls.filter((call) => call.table === occasions).map((call) => call.limit)).toEqual([
      1001, 1001,
    ]);
  });
});
