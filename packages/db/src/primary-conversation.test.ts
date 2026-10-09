import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createPostgresApplicationChatPersistence } from './application-chat-repository.js';
import { createDb } from './client.js';
import { agents, conversations } from './schema.js';

it.each([false, true])(
  'keeps Notifications separate from the primary owner chat (legacy primary=%s)',
  async (legacyPrimary) => {
    const url = process.env.DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    const db = createDb(url),
      agentId = randomUUID();
    try {
      await db.insert(agents).values({
        id: agentId,
        name: 'Primary race',
        email: `${agentId}@example.test`,
        workspacePrefix: `primary-${agentId}`,
      });
      const [notifications] = await db
        .insert(conversations)
        .values({
          agentId,
          channel: 'chat',
          trust: 'assistant',
          title: 'Notifications',
          isPrimary: legacyPrimary,
        })
        .returning();
      if (!notifications) throw new Error('Missing fixture');
      const repository = createPostgresApplicationChatPersistence(db);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => repository.getOrCreatePrimaryConversation(agentId)),
      );
      expect(new Set(results.map((row) => row.id)).size).toBe(1);
      expect(results[0]).toMatchObject({
        trust: 'owner',
        isPrimary: true,
        metadata: { purpose: 'owner-chat' },
      });
      expect(results[0]?.id).not.toBe(notifications.id);
      expect(
        (await db.select().from(conversations).where(eq(conversations.id, notifications.id)))[0],
      ).toMatchObject({ trust: 'assistant', isPrimary: false, title: 'Notifications' });
      expect(
        await db.select().from(conversations).where(eq(conversations.agentId, agentId)),
      ).toHaveLength(2);
    } finally {
      await db.delete(conversations).where(eq(conversations.agentId, agentId));
      await db.delete(agents).where(eq(agents.id, agentId));
      await db.$client.end();
    }
  },
);
