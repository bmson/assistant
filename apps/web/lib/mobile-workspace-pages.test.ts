import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeMobileWorkspaceCursor,
  encodeMobileWorkspaceCursor,
  parseMobileWorkspacePageLimit,
} from './mobile-workspace-pages.js';
import { getDb, getMobileWorkspaceSectionPage } from './server.js';

describe('mobile workspace page cursors', () => {
  it('round trips a section and owner-bound keyset cursor', () => {
    const ownerId = randomUUID();
    const cursor = {
      version: 1 as const,
      section: 'chats' as const,
      ownerId,
      afterId: randomUUID(),
      updatedAt: '2026-10-07T12:00:00.000Z',
      archived: true,
    };
    const token = encodeMobileWorkspaceCursor(cursor);
    expect(
      decodeMobileWorkspaceCursor(token, { section: 'chats', ownerId, archived: true }),
    ).toEqual(cursor);
  });

  it('rejects a cursor replayed across owners, sections, or archive scopes', () => {
    const ownerId = randomUUID();
    const token = encodeMobileWorkspaceCursor({
      version: 1,
      section: 'chats',
      ownerId,
      afterId: randomUUID(),
      updatedAt: '2026-10-07T12:00:00.000Z',
      archived: false,
    });
    expect(() =>
      decodeMobileWorkspaceCursor(token, {
        section: 'chats',
        ownerId: randomUUID(),
        archived: false,
      }),
    ).toThrow('does not match');
    expect(() => decodeMobileWorkspaceCursor(token, { section: 'skills', ownerId })).toThrow(
      'does not match',
    );
    expect(() =>
      decodeMobileWorkspaceCursor(token, { section: 'chats', ownerId, archived: true }),
    ).toThrow('Invalid chat continuation');
  });

  it('rejects malformed UUID groupings and noncanonical chat timestamps before queries', () => {
    const ownerId = randomUUID();
    const cursor = {
      version: 1 as const,
      section: 'chats' as const,
      ownerId,
      afterId: randomUUID(),
      updatedAt: '2026-10-07T12:00:00.000Z',
      archived: false,
    };
    for (const afterId of ['-'.repeat(36), 'a'.repeat(36), { value: cursor.afterId }]) {
      const token = Buffer.from(JSON.stringify({ ...cursor, afterId })).toString('base64url');
      expect(() =>
        decodeMobileWorkspaceCursor(token, { section: 'chats', ownerId, archived: false }),
      ).toThrow('does not match');
    }
    for (const updatedAt of ['1', '2026-02-30T12:00:00.000Z']) {
      const token = encodeMobileWorkspaceCursor({ ...cursor, updatedAt });
      expect(() =>
        decodeMobileWorkspaceCursor(token, { section: 'chats', ownerId, archived: false }),
      ).toThrow('Invalid chat continuation');
    }
  });

  it('bounds pages and rejects malformed limits', () => {
    expect(parseMobileWorkspacePageLimit(null)).toBe(50);
    expect(parseMobileWorkspacePageLimit('100')).toBe(100);
    for (const value of ['0', '-1', '101', '1.2', '']) {
      expect(() => parseMobileWorkspacePageLimit(value)).toThrow('1–100');
    }
  });

  it('binds import source and workspace-file cursors to their stream and owner', () => {
    const ownerId = randomUUID();
    const sourceToken = encodeMobileWorkspaceCursor({
      version: 1,
      section: 'import-sources',
      ownerId,
      afterId: 'archive-2026-10',
    });
    expect(
      decodeMobileWorkspaceCursor(sourceToken, { section: 'import-sources', ownerId }).afterId,
    ).toBe('archive-2026-10');
    const filesToken = encodeMobileWorkspaceCursor({
      version: 1,
      section: 'import-files',
      ownerId,
      afterId: 'opaque-provider-continuation',
    });
    expect(
      decodeMobileWorkspaceCursor(filesToken, { section: 'import-files', ownerId }).afterId,
    ).toBe('opaque-provider-continuation');
    expect(() =>
      decodeMobileWorkspaceCursor(filesToken, {
        section: 'import-files',
        ownerId: randomUUID(),
      }),
    ).toThrow('does not match');
    expect(() =>
      decodeMobileWorkspaceCursor(filesToken, { section: 'import-sources', ownerId }),
    ).toThrow('does not match');
  });

  it('allows bounded wrapped provider continuations within the mobile cursor envelope', () => {
    const ownerId = randomUUID();
    const opaque = `ey${'x'.repeat(5_300)}`;
    const token = encodeMobileWorkspaceCursor({
      version: 1,
      section: 'import-files',
      ownerId,
      afterId: opaque,
    });
    expect(token.length).toBeLessThanOrEqual(8_192);
    expect(decodeMobileWorkspaceCursor(token, { section: 'import-files', ownerId }).afterId).toBe(
      opaque,
    );
  });

  it('pages real PostgreSQL skill rows through the server composition with exact continuation', async () => {
    if (!process.env.ASSISTANT_TEST_TARGET_TOKEN)
      throw new Error('Requires the isolated test database allocator');
    const db = getDb();
    const ids = Array.from({ length: 5 }, () => randomUUID()).sort();
    const ownerRows = await db.$client.unsafe('SELECT id FROM agents ORDER BY id LIMIT 1');
    const ownerId = String(ownerRows[0]?.id ?? '');
    if (!ownerId) throw new Error('The isolated database seed is missing its owner');

    try {
      for (const id of ids) {
        await db.$client.unsafe(
          `INSERT INTO skills (id, agent_id, name, steps, origin_trust, owner_authored)
           VALUES ($1, $2, $3, $4, 'owner', true)`,
          [id, ownerId, `API-09 page ${id}`, 'safe test row'],
        );
      }

      const fixtureIds = new Set<string>(ids);
      const collected: string[] = [];
      let cursor: string | null = null;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = await getMobileWorkspaceSectionPage({
          section: 'skills',
          archived: false,
          limit: 2,
          cursor,
        });
        collected.push(
          ...page.items
            .filter(
              (row): row is Extract<(typeof page.items)[number], { id: string }> => 'id' in row,
            )
            .map((row) => row.id)
            .filter((id) => fixtureIds.has(id)),
        );
        expect(page.hasMore).toBe(Boolean(page.nextCursor));
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }
      expect(collected).toEqual(ids);
      expect(new Set(collected).size).toBe(ids.length);
    } finally {
      for (const id of ids) await db.$client.unsafe('DELETE FROM skills WHERE id = $1', [id]);
    }
  });

  it('pages more than one source batch through the PostgreSQL import server composition', async () => {
    if (!process.env.ASSISTANT_TEST_TARGET_TOKEN)
      throw new Error('Requires the isolated test database allocator');
    const db = getDb();
    const ids = Array.from({ length: 51 }, () => randomUUID());
    const prefix = `api09-${randomUUID()}`;
    const ownerRows = await db.$client.unsafe('SELECT id FROM agents ORDER BY id LIMIT 1');
    const ownerId = String(ownerRows[0]?.id ?? '');
    if (!ownerId) throw new Error('The isolated database seed is missing its owner');

    try {
      for (const [index, id] of ids.entries()) {
        await db.$client.unsafe(
          `INSERT INTO import_sources (id, agent_id, source, workspace_path, kind, status)
           VALUES ($1, $2, $3, $4, 'text', 'done')`,
          [id, ownerId, `${prefix}-${String(index).padStart(3, '0')}`, `import/${id}.txt`],
        );
      }
      const expected = new Set<string>(ids);
      const collected: string[] = [];
      let cursor: string | null = null;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = await getMobileWorkspaceSectionPage({
          section: 'import-sources',
          archived: false,
          limit: 50,
          cursor,
        });
        collected.push(
          ...page.items
            .filter(
              (row): row is Extract<(typeof page.items)[number], { id: string }> => 'id' in row,
            )
            .map((row) => row.id)
            .filter((id) => expected.has(id)),
        );
        expect(page.hasMore).toBe(Boolean(page.nextCursor));
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }
      expect(collected).toHaveLength(51);
      expect(new Set(collected)).toEqual(expected);
    } finally {
      await db.$client.unsafe('DELETE FROM import_sources WHERE agent_id = $1 AND source LIKE $2', [
        ownerId,
        `${prefix}-%`,
      ]);
    }
  }, 30_000);
});
