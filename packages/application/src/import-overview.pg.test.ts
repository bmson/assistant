import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { agents, createDb, importSources } from '@assistant/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getImportOverview } from './imports.js';
import type { WorkspacePort } from './workspace.js';

const databaseUrl = process.env.DATABASE_URL;

function testUrl(): string {
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return databaseUrl;
}

describe('PostgreSQL import overview pagination', () => {
  const db = createDb(testUrl());
  const ids = Array.from({ length: 51 }, () => randomUUID());
  let sources: string[] = [];
  let ownerId = '';
  let afterSource = '';

  beforeAll(async () => {
    const owners = await db.select({ id: agents.id }).from(agents).limit(2);
    if (owners.length !== 1 || !owners[0]) throw new Error('Test requires one configured agent');
    ownerId = (await getAgent(db)).id;
    const [tail] = await db
      .select({ source: importSources.source })
      .from(importSources)
      .where(eq(importSources.agentId, ownerId))
      .orderBy(desc(importSources.source))
      .limit(1);
    afterSource = tail?.source ?? '';
    sources = ids.map(
      (id, index) => `${afterSource}~api09-${String(index).padStart(3, '0')}-${id}`,
    );
    await db.insert(importSources).values(
      ids.map((id, index) => ({
        id,
        agentId: ownerId,
        source: sources[index] as string,
        workspacePath: `import/${id}.txt`,
        kind: 'text',
        status: 'done',
      })),
    );
  });

  afterAll(async () => {
    await db
      .delete(importSources)
      .where(and(eq(importSources.agentId, ownerId), inArray(importSources.id, ids)));
    await db.$client.end();
  });

  it('reads every source once across bounded owner-scoped pages', async () => {
    const workspace = {
      listPage: async (_path: string, _input: { cursor: string | null; limit: number }) => ({
        items: [],
        hasMore: false,
        nextCursor: null,
        consistency: 'process-snapshot' as const,
      }),
    } as unknown as WorkspacePort;
    const first = await getImportOverview(db, workspace, { sourceCursor: afterSource || null });
    expect(first.sourceAvailability.status).toBe('available');
    expect(first.sources).toHaveLength(50);
    expect(first.sourcePagination).toMatchObject({ hasMore: true });
    expect(first.sourcePagination.nextCursor).toBe(sources.slice().sort()[49]);
    const second = await getImportOverview(db, workspace, {
      sourceCursor: first.sourcePagination.nextCursor,
    });
    expect(second.sources).toHaveLength(1);
    expect(second.sources[0]?.source).toBe(sources.slice().sort()[50]);
    expect(second.sourcePagination).toEqual({
      consistency: 'live-keyset',
      hasMore: false,
      nextCursor: null,
    });
    expect(new Set([...first.sources, ...second.sources].map((source) => source.id)).size).toBe(51);
  });
});
