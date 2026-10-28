import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { postgresOwnerEditorViewSnapshot } from './owner-editor-graph.js';
import { postgresOwnerEditorContact } from './owner-editor-people.js';
import { agents, contacts } from './schema.js';

function fixture(count: number) {
  const ownerId = randomUUID(),
    calls: Array<{ table: unknown; limit: number }> = [];
  const rows = Array.from({ length: count }, (_, i) => ({
    contact: {
      id: randomUUID(),
      name: `Person ${i}`,
      aliases: [],
      trust: i === 0 ? 'owner' : 'unknown',
    },
    native: { id: `native-${i}`, updated_at: '2026-10-25T12:00:00.123456+00:00' },
  }));
  const db = {
    select() {
      let table: unknown;
      const chain = {
        from(value: unknown) {
          table = value;
          return chain;
        },
        where() {
          return chain;
        },
        orderBy() {
          return chain;
        },
        async limit(limit: number) {
          calls.push({ table, limit });
          if (table === agents) return [{ id: ownerId }];
          if (table === contacts) return rows.slice(0, limit);
          throw new Error('Unexpected editor query');
        },
      };
      return chain;
    },
  } as unknown as Db;
  return { db, ownerId, rows, calls };
}
describe('actual bounded PG editor snapshot reads offline', () => {
  it.each([1, 500])(
    'returns complete %i-row snapshot with exact native point CAS and no owner option',
    async (count) => {
      const f = fixture(count),
        first = f.rows[0];
      if (!first) throw new Error('fixture missing');
      const result = await postgresOwnerEditorViewSnapshot(f.db, f.ownerId, {
        contactId: first.contact.id,
      });
      expect(result.people).toHaveLength(count - 1);
      expect(result.identity).toBeNull();
      expect(result.corrections).toEqual([]);
      expect(f.calls).toEqual([
        { table: agents, limit: 2 },
        { table: contacts, limit: 501 },
      ]);
      first.contact.trust = 'unknown';
      const point = await postgresOwnerEditorContact(f.db, f.ownerId, first.contact.id);
      const snapshot = await postgresOwnerEditorViewSnapshot(f.db, f.ownerId, {
        contactId: first.contact.id,
      });
      expect(snapshot.identity?.revision).toBe(point?.revision);
      first.native.updated_at = '2026-10-25T12:00:00.123457+00:00';
      expect(
        (await postgresOwnerEditorViewSnapshot(f.db, f.ownerId, { contactId: first.contact.id }))
          .identity?.revision,
      ).not.toBe(point?.revision);
    },
  );
  it('fails whole editor on raw 501 sentinel before malformed rows decode', async () => {
    const f = fixture(501);
    f.rows[0]!.contact.name = '';
    await expect(postgresOwnerEditorViewSnapshot(f.db, f.ownerId)).rejects.toThrow('read limit');
    expect(f.calls).toHaveLength(2);
  });
  it('rejects malformed below-cap records and oversized requested fanout rather than partial options', async () => {
    const f = fixture(1);
    f.rows[0]!.contact.name = '';
    await expect(postgresOwnerEditorViewSnapshot(f.db, f.ownerId)).rejects.toThrow('Malformed');
    const before = f.calls.length;
    await expect(
      postgresOwnerEditorViewSnapshot(f.db, f.ownerId, {
        relationIds: Array.from({ length: 121 }, () => randomUUID()),
      }),
    ).rejects.toThrow('read limit');
    expect(f.calls.length - before).toBe(1);
  });
  it('propagates query failure, without a fallback snapshot', async () => {
    const db = {
      select() {
        throw new Error('offline query failed');
      },
    } as unknown as Db;
    await expect(postgresOwnerEditorViewSnapshot(db, randomUUID())).rejects.toThrow(
      'offline query failed',
    );
  });
});
