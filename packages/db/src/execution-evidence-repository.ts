import type { ExecutionEvidenceRepository, ResponseCheckInput } from '@assistant/persistence';
import { evidenceLimit, taskEvidenceLimit } from '@assistant/persistence';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { approvals, conversations, messages, responseChecks, tasks, toolCalls } from './schema.js';

function evidence(row: typeof toolCalls.$inferSelect) {
  return {
    id: row.id,
    toolName: row.toolName,
    status: row.status,
    args: row.args,
    result: row.result,
    error: row.error,
    step: row.step,
  };
}

function bounded<T>(rows: T[], max: number): T[] {
  if (rows.length > max) throw new Error(`Execution evidence exceeds the ${max}-row bound`);
  return rows;
}

function requestedLimit(maxRows: number | undefined): number | undefined {
  return maxRows === undefined ? undefined : evidenceLimit(maxRows);
}

export function createPostgresExecutionEvidenceRepository(db: Db): ExecutionEvidenceRepository {
  return {
    kind: 'execution-evidence-repository',
    async taskEvidence({ agentId, taskId, maxRows }) {
      const max = taskEvidenceLimit(maxRows);
      const query = db
        .select({ toolCall: toolCalls })
        .from(toolCalls)
        .innerJoin(tasks, and(eq(toolCalls.taskId, tasks.id), eq(tasks.agentId, agentId)))
        .where(eq(toolCalls.taskId, taskId))
        .orderBy(toolCalls.step, toolCalls.createdAt, toolCalls.id);
      const rows = await query.limit(max + 1);
      const values = rows.map(({ toolCall }) => evidence(toolCall));
      return bounded(values, max);
    },
    async conversationEvidence({ agentId, conversationId, excludeTaskId, maxRows }) {
      const max = requestedLimit(maxRows);
      const [conversation] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agentId)))
        .limit(1);
      if (!conversation)
        throw new Error('Execution evidence conversation is missing or outside the owner scope');
      const [excluded] = await db
        .select({ id: tasks.id, conversationId: tasks.conversationId })
        .from(tasks)
        .where(and(eq(tasks.id, excludeTaskId), eq(tasks.agentId, agentId)))
        .limit(1);
      if (!excluded || excluded.conversationId !== conversationId)
        throw new Error('Execution evidence task is outside the conversation scope');
      const query = db
        .select({ toolCall: toolCalls })
        .from(toolCalls)
        .innerJoin(tasks, eq(toolCalls.taskId, tasks.id))
        .where(
          and(
            eq(tasks.agentId, agentId),
            eq(tasks.conversationId, conversationId),
            ne(toolCalls.taskId, excludeTaskId),
          ),
        )
        // Newest first, so a thread past the window keeps its recent history
        // instead of failing every later turn; returned oldest first.
        .orderBy(desc(toolCalls.createdAt), desc(toolCalls.step), desc(toolCalls.id))
        .limit(evidenceLimit(max));
      return (await query).reverse().map(({ toolCall }) => evidence(toolCall));
    },
    async hasConversationToolCall({ agentId, conversationId, toolName, documentId }) {
      const [match] = await db
        .select({ id: toolCalls.id })
        .from(toolCalls)
        .innerJoin(tasks, eq(toolCalls.taskId, tasks.id))
        .where(
          and(
            eq(tasks.agentId, agentId),
            eq(tasks.conversationId, conversationId),
            eq(toolCalls.toolName, toolName),
            eq(toolCalls.status, 'succeeded'),
            sql`coalesce(${toolCalls.result}->>'ok', 'true') <> 'false'`,
            sql`coalesce(${toolCalls.result}->>'deliveryStatus', '') <> 'unknown'`,
            sql`${toolCalls.args}->>'documentId' = ${documentId}`,
          ),
        )
        .limit(1);
      return Boolean(match);
    },
    async finalMessageExists({ agentId, taskId, conversationId, text }) {
      const [task] = await db
        .select({ id: tasks.id, conversationId: tasks.conversationId })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
        .limit(1);
      if (!task) throw new Error('Execution evidence task is missing or outside the owner scope');
      if (conversationId) {
        const [conversation] = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agentId)))
          .limit(1);
        if (!conversation)
          throw new Error('Execution final-message conversation is outside the owner scope');
        if (task.conversationId !== null && task.conversationId !== conversationId)
          throw new Error('Execution final-message conversation does not match its task');
      }
      const predicates: Parameters<typeof and> = [
        eq(messages.taskId, taskId),
        eq(messages.role, 'assistant'),
        eq(messages.origin, 'assistant'),
        eq(messages.text, text),
        eq(conversations.agentId, agentId),
      ];
      if (conversationId) {
        predicates.push(eq(messages.conversationId, conversationId));
      }
      const [row] = await db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(and(...predicates))
        .limit(1);
      return Boolean(row);
    },
    async hasOutboundReply({ agentId, taskId }) {
      const [row] = await db
        .select({ id: toolCalls.id })
        .from(toolCalls)
        .innerJoin(tasks, and(eq(toolCalls.taskId, tasks.id), eq(tasks.agentId, agentId)))
        .where(
          and(
            eq(toolCalls.taskId, taskId),
            inArray(toolCalls.toolName, ['gmail.send', 'gmail.create_draft']),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    async checklistDecisions({ agentId, taskId }) {
      const rows = await db
        .select({ toolCallId: approvals.toolCallId, status: approvals.status })
        .from(approvals)
        .innerJoin(tasks, and(eq(approvals.taskId, tasks.id), eq(tasks.agentId, agentId)))
        .where(eq(approvals.taskId, taskId));
      return rows;
    },
    async recordResponseCheck({ agentId, check }: { agentId: string; check: ResponseCheckInput }) {
      const [owned] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, check.taskId), eq(tasks.agentId, agentId)))
        .limit(1);
      if (!owned) throw new Error('Execution evidence task is missing or outside the owner scope');
      const inserted = await db
        .insert(responseChecks)
        .values(check)
        .onConflictDoNothing({ target: responseChecks.taskId })
        .returning({ taskId: responseChecks.taskId });
      return inserted.length > 0;
    },
  };
}
