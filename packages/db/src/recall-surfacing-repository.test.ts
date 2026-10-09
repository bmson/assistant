import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresMessageRepository } from './message-repository.js';
import { createPostgresRecallSurfacingRepository } from './recall-surfacing-repository.js';
import { agents, conversations, messages, recallSurfaces } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

describe('PostgreSQL recall surfacing ledger', () => {
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const conversationId = randomUUID();
  const foreignConversationId = randomUUID();
  const sourceKey = 'a'.repeat(64);
  const sourceRevision = 'b'.repeat(64);
  let db: Db;
  let dbUp = false;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      await db.select({ id: agents.id }).from(agents).limit(1);
      dbUp = true;
    } catch {
      console.warn('recall-surfacing-repository.test: database unreachable — skipping');
      return;
    }
    await db.insert(agents).values(
      [agentId, foreignAgentId].map((id) => ({
        id,
        name: 'Recall surface owner',
        email: `${id}@test.local`,
        workspacePrefix: `tests/${id}`,
      })),
    );
    await db.insert(conversations).values([
      { id: conversationId, agentId, channel: 'chat' },
      { id: foreignConversationId, agentId: foreignAgentId, channel: 'chat' },
    ]);
  });

  afterAll(async () => {
    if (!dbUp) return;
    await db
      .delete(recallSurfaces)
      .where(inArray(recallSurfaces.agentId, [agentId, foreignAgentId]));
    await db
      .delete(messages)
      .where(inArray(messages.conversationId, [conversationId, foreignConversationId]));
    await db
      .delete(conversations)
      .where(inArray(conversations.id, [conversationId, foreignConversationId]));
    await db.delete(agents).where(inArray(agents.id, [agentId, foreignAgentId]));
  });

  it('records source digests with assistant message commit and owner control is revision-fenced', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const append = createPostgresMessageRepository(db);
    const assistant = await append.append({
      conversationId,
      role: 'assistant',
      origin: 'assistant',
      text: 'A remembered detail.',
      parts: [
        { type: 'text', text: 'A remembered detail.' },
        {
          type: 'recall',
          sources: [{ surfaceKey: sourceKey, sourceRevision, kind: 'chat' }],
        },
      ],
    });
    expect(assistant).toBeDefined();
    const repository = createPostgresRecallSurfacingRepository(db);
    expect(await repository.suppressed(agentId, [sourceKey])).toEqual(new Set());
    const rows = await repository.list(agentId);
    expect(rows).toEqual([
      expect.objectContaining({
        sourceKey,
        sourceRevision,
        kind: 'chat',
        lastMessageId: assistant?.id,
        surfaceCount: 1,
        suppressedAt: null,
      }),
    ]);
    const hidden = await repository.setSuppressed({
      agentId,
      sourceKey,
      expectedSourceRevision: sourceRevision,
      suppressed: true,
      expectedVersion: 1,
    });
    expect(hidden).toEqual({ ok: true, version: 2 });
    expect(await repository.suppressed(agentId, [sourceKey])).toEqual(new Set([sourceKey]));
    expect(
      await repository.suppressed(agentId, [sourceKey], { [sourceKey]: 'd'.repeat(64) }),
    ).toEqual(new Set());
    expect(
      await repository.suppressed(agentId, [sourceKey], { [sourceKey]: sourceRevision }),
    ).toEqual(new Set([sourceKey]));
    await expect(
      repository.setSuppressed({
        agentId,
        sourceKey,
        expectedSourceRevision: 'c'.repeat(64),
        suppressed: false,
        expectedVersion: 2,
      }),
    ).resolves.toEqual({ ok: false });
    const revised = 'd'.repeat(64);
    await append.append({
      conversationId,
      role: 'assistant',
      origin: 'assistant',
      text: 'A corrected remembered detail.',
      parts: [
        {
          type: 'recall',
          sources: [{ surfaceKey: sourceKey, sourceRevision: revised, kind: 'chat' }],
        },
      ],
    });
    expect(await repository.suppressed(agentId, [sourceKey], { [sourceKey]: revised })).toEqual(
      new Set(),
    );
    expect(await repository.list(agentId)).toEqual([
      expect.objectContaining({
        sourceRevision: revised,
        suppressedAt: null,
        version: 3,
        surfaceCount: 2,
      }),
    ]);
    await expect(
      repository.setSuppressed({
        agentId: foreignAgentId,
        sourceKey,
        expectedSourceRevision: sourceRevision,
        suppressed: false,
      }),
    ).resolves.toEqual({ ok: false });
  });

  it('refuses arbitrary control keys that were never surfaced', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await expect(
      createPostgresRecallSurfacingRepository(db).setSuppressed({
        agentId,
        sourceKey: 'f'.repeat(64),
        suppressed: true,
      }),
    ).resolves.toEqual({ ok: false });
  });
});
