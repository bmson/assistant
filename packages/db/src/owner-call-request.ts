import { directOwnerCallRequestBinding } from '@assistant/persistence';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversations, messages, tasks } from './schema.js';

/** Read the exact admitted owner message; a task lock fences changes at execution. */
export async function readPostgresOwnerCallRequest(
  db: Db,
  agentId: string,
  taskId: string,
  lifecycle: 'running' | 'waiting_approval',
  locked = false,
) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
    .limit(1);
  if (!task?.conversationId) return null;
  // Lock the conversation before reading the latest message. Every publication updates this row.
  const query = db
    .select({ id: conversations.id, agentId: conversations.agentId })
    .from(conversations)
    .where(and(eq(conversations.id, task.conversationId), eq(conversations.agentId, agentId)))
    .limit(1);
  const [conversation] = locked ? await query.for('update') : await query;
  const messageQuery = db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, task.conversationId),
        eq(messages.taskId, task.id),
        eq(messages.role, 'user'),
        eq(messages.origin, 'owner'),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  const [message] = locked ? await messageQuery.for('update') : await messageQuery;
  return directOwnerCallRequestBinding(task, conversation ?? null, message ?? null, lifecycle);
}
