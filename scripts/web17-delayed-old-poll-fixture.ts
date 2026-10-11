import { randomUUID } from 'node:crypto';
import { encodeMessageCursor } from '@assistant/core/chat';
import { conversations, createDb, tasks } from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';

export function createWeb17Fixture(databaseUrl: string) {
  const db = createDb(databaseUrl, { max: 2, statementTimeoutMs: 10_000 });
  const createdConversations: string[] = [];
  const createdTasks: string[] = [];

  return {
    registerConversation(conversationId: string): void {
      createdConversations.push(conversationId);
    },
    async insertTerminalTask(conversationId: string, status: string): Promise<string> {
      const [conversation] = await db
        .select({ agentId: conversations.agentId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!conversation) throw new Error('Server-created conversation has no owning agent');
      const id = randomUUID();
      await db.insert(tasks).values({
        id,
        agentId: conversation.agentId,
        conversationId,
        type: 'chat_turn',
        status,
        trust: 'owner',
        externalEventId: `web17-${id}`,
        title: `WEB-17 delayed poll ${status}`,
      });
      createdTasks.push(id);
      return id;
    },
    cursorAt(createdAt: Date): string {
      return encodeMessageCursor({ createdAt, id: randomUUID() });
    },
    async cleanup(): Promise<void> {
      if (createdTasks.length) await db.delete(tasks).where(inArray(tasks.id, createdTasks));
      if (createdConversations.length) {
        await db.delete(conversations).where(inArray(conversations.id, createdConversations));
      }
      await db.$client.end();
    },
  };
}
