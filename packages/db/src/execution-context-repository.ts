import {
  type ExecutionContextRepository,
  MAX_EXECUTION_SEED_MESSAGES,
  parseExactTimestamp,
} from '@assistant/persistence';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { agents, conversations, goals, messages, tasks } from './schema.js';

const exactMessageTime = sql<string>`to_char(${messages.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '000Z'`;
const MAX_FOLDED_REPLIES = 200;

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`Execution context limit must be between 1 and ${maximum}`);
  }
  return limit;
}

export function createPostgresExecutionContextRepository(db: Db): ExecutionContextRepository {
  return {
    kind: 'execution-context-repository',
    async getAgent(agentId) {
      const rows = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
      return rows[0] ?? null;
    },
    async getTask(agentId, taskId) {
      const [row] = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
        .limit(1);
      return row ?? null;
    },
    async getGoalStopState(agentId, goalId) {
      const [row] = await db
        .select({ status: goals.status, archivedAt: goals.archivedAt })
        .from(goals)
        .where(and(eq(goals.id, goalId), eq(goals.agentId, agentId)))
        .limit(1);
      return row ?? null;
    },
    async seedHistory({
      agentId,
      conversationId,
      before,
      throughMessageId,
      limit: requestedLimit,
    }) {
      const limit = boundedLimit(requestedLimit, 20, MAX_EXECUTION_SEED_MESSAGES);
      const rows = await db
        .select({ message: messages })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.agentId, agentId),
            inArray(messages.role, ['user', 'assistant']),
            throughMessageId
              ? sql`(${messages.createdAt}, ${messages.id}) <= (select pinned.created_at, pinned.id from ${messages} as pinned where pinned.id = ${throughMessageId} and pinned.conversation_id = ${conversationId})`
              : lt(messages.createdAt, before),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit);
      return rows.map(({ message }) => message).reverse();
    },
    async getInboundMessage({ agentId, conversationId, channelMessageId }) {
      const [row] = await db
        .select({ text: messages.text })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.agentId, agentId),
            eq(messages.channelMessageId, channelMessageId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async getLatestOwnerReplyCursor({ agentId, conversationId }) {
      const [row] = await db
        .select({
          createdAt: messages.createdAt,
          exactCreatedAt: exactMessageTime,
          id: messages.id,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.agentId, agentId),
            eq(conversations.channel, 'chat'),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(1);
      if (row) return { cursor: row };
      const [conversation] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.agentId, agentId),
            eq(conversations.channel, 'chat'),
          ),
        )
        .limit(1);
      return conversation ? { cursor: null } : null;
    },
    async getOwnerRepliesAfter({ agentId, conversationId, after, limit: requestedLimit }) {
      const limit = boundedLimit(requestedLimit, MAX_FOLDED_REPLIES, MAX_FOLDED_REPLIES);
      const exact = after.exactCreatedAt;
      if (exact) parseExactTimestamp(exact);
      const suppliedAt = exact ?? after.createdAt.toISOString();
      // Upgrade old millisecond checkpoints using their durable row identity.
      const at =
        after.id && (!exact || /\.\d{3}Z$/.test(exact))
          ? sql`coalesce((select pinned.created_at from ${messages} as pinned where pinned.id = ${after.id} and pinned.conversation_id = ${conversationId}), ${suppliedAt}::timestamptz)`
          : sql`${suppliedAt}::timestamptz`;
      const cursor = after.id
        ? sql`(${messages.createdAt}, ${messages.id}) > (${at}, ${after.id}::uuid)`
        : sql`${messages.createdAt} > ${at}`;
      const rows = await db
        .select({ message: messages, exactCreatedAt: exactMessageTime })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.agentId, agentId),
            eq(conversations.channel, 'chat'),
            eq(messages.role, 'user'),
            eq(messages.origin, 'owner'),
            cursor,
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(limit + 1);
      if (rows.length > limit) {
        throw new Error(`Owner reply window exceeded ${limit} messages`);
      }
      return rows.map(({ message, exactCreatedAt }) => ({ ...message, exactCreatedAt }));
    },
    async noticeIds(agentId, rows) {
      const notices = new Set<string>();
      const pending = new Map<string, string[]>();
      for (const row of rows) {
        if (row.role !== 'assistant') continue;
        if (hasNoticePart(row.parts)) {
          notices.add(row.id);
          continue;
        }
        if (!row.taskId) continue;
        pending.set(row.taskId, [...(pending.get(row.taskId) ?? []), row.id]);
      }
      if (pending.size === 0) return notices;
      const owning = await db
        .select({ id: tasks.id, type: tasks.type })
        .from(tasks)
        .where(and(eq(tasks.agentId, agentId), inArray(tasks.id, [...pending.keys()])));
      for (const task of owning) {
        if (task.type === 'chat_turn') continue;
        for (const id of pending.get(task.id) ?? []) notices.add(id);
      }
      return notices;
    },
  };
}

/** Keep this in lockstep with core/chat.ts; repositories cannot import core. */
const NOTICE_PART_TYPES = new Set(['notice', 'suggestion', 'approval-summary']);

function hasNoticePart(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  return parts.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const { type, data } = part as { type?: unknown; data?: unknown };
    if (typeof type !== 'string') return false;
    if (NOTICE_PART_TYPES.has(type)) return true;
    if (type !== 'data-card' || !data || typeof data !== 'object') return false;
    return (data as { kind?: unknown }).kind === 'proactive-alert';
  });
}
