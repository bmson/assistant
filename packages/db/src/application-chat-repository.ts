import { createHash, randomUUID } from 'node:crypto';
import type {
  ApplicationChatMessage,
  ApplicationChatPersistence,
  ApplicationChatSuggestion,
  TaskLease,
} from '@assistant/persistence';
import {
  assertChatAdmissionOperationId,
  boundedChatConversationLimit,
  boundedChatMessageLimit,
  chatAdmissionCancellationPayload,
  chatAdmissionCancellationTrigger,
  chatAdmissionExternalEventId,
  chatAdmissionPayload,
  isChatAdmissionCancellationProjection,
  newTaskRecord,
  normalizeTaskBudget,
  recallSurfaceRefs,
  withChatAdmissionPhase,
} from '@assistant/persistence';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { Db } from './client.js';
import { createPostgresExecutionEvidenceRepository } from './execution-evidence-repository.js';
import { assertPostgresInstallationOwner } from './installation-owner.js';
import {
  assertPostgresPrivacyObservationFence,
  lockPostgresPrivacyObservationFence,
  postgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import {
  agents,
  approvals,
  budgets,
  conversations,
  goals,
  messages,
  models,
  recallSurfaces,
  suggestions,
  tasks,
  toolCalls,
} from './schema.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];
const GOAL_BLOCKED_PREFIX = 'Waiting on the owner:';
const DIRECT_CHAT_LEASE_MS = 10 * 60_000;

function conciseTitle(value: string | undefined): string | undefined {
  const title = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!title) return undefined;
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function ownedConversationWhere(agentId: string, conversationId: string) {
  return and(
    eq(conversations.id, conversationId),
    eq(conversations.agentId, agentId),
    eq(conversations.channel, 'chat'),
  );
}

async function assertRecalledMessagesCurrent(
  tx: Pick<Db, 'select'>,
  agentId: string,
  refs: ReturnType<typeof recallSurfaceRefs>,
) {
  const ids = [...new Set(refs.flatMap((ref) => ref.sourceMessageIds ?? []))];
  if (!ids.length) return;
  const rows = await tx
    .select({ id: messages.id, text: messages.text, hiddenAt: messages.hiddenAt })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(inArray(messages.id, ids), eq(conversations.agentId, agentId)))
    .for('share');
  const current = new Map(rows.map((row) => [row.id, row]));
  for (const ref of refs) {
    const sourceIds = ref.sourceMessageIds;
    if (!sourceIds?.length) continue;
    const sourceRows = sourceIds.map((id) => current.get(id));
    if (sourceRows.some((row) => !row || row.hiddenAt !== null))
      throw new Error('Recalled source changed before chat publication');
    if (ref.representation === 'message_excerpts') {
      const revision = createHash('sha256')
        .update(JSON.stringify(sourceRows.map((row, index) => [sourceIds[index], row?.text])))
        .digest('hex');
      if (revision !== ref.sourceRevision)
        throw new Error('Recalled source changed before chat publication');
    }
  }
}

async function assertRecallSourcesNotHidden(
  tx: Pick<Db, 'select'>,
  agentId: string,
  refs: ReturnType<typeof recallSurfaceRefs>,
) {
  for (const ref of refs) {
    const [current] = await tx
      .select({
        sourceRevision: recallSurfaces.sourceRevision,
        suppressedAt: recallSurfaces.suppressedAt,
      })
      .from(recallSurfaces)
      .where(and(eq(recallSurfaces.agentId, agentId), eq(recallSurfaces.sourceKey, ref.sourceKey)))
      .for('update')
      .limit(1);
    if (current?.suppressedAt && current.sourceRevision === ref.sourceRevision)
      throw new Error('Recalled source was hidden before chat publication');
  }
}

export function createPostgresApplicationChatPersistence(db: Db): ApplicationChatPersistence {
  async function owned(agentId: string, conversationId: string) {
    const [row] = await db
      .select()
      .from(conversations)
      .where(ownedConversationWhere(agentId, conversationId))
      .limit(1);
    return row ?? null;
  }

  return {
    kind: 'application-chat-persistence',

    async privacyObservationGeneration(agentId) {
      return postgresPrivacyObservationFence(db, agentId);
    },

    async resolveAgent() {
      const ownerId = await assertPostgresInstallationOwner(db);
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, ownerId))
        .orderBy(asc(agents.createdAt), asc(agents.id))
        .limit(1);
      if (!agent) throw new Error('no agent row — run pnpm seed');
      return agent;
    },

    async getOrCreatePrimaryConversation(agentId) {
      return db.transaction(async (tx) => {
        // Serialize both selection and legacy repair on the configured owner,
        // including the first call when no primary conversation exists yet.
        const owners = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, agentId))
          .for('update');
        if (!owners.length) throw new Error('Primary conversation owner is missing');
        const [existing] = await tx
          .select()
          .from(conversations)
          .where(and(eq(conversations.agentId, agentId), eq(conversations.isPrimary, true)))
          .limit(1);
        const ownerPurpose = (row: typeof conversations.$inferSelect) => {
          const metadata = row.metadata as Record<string, unknown>;
          return (
            row.channel === 'chat' &&
            row.trust === 'owner' &&
            !metadata.goalId &&
            (metadata.purpose === undefined || metadata.purpose === 'owner-chat')
          );
        };
        if (existing && ownerPurpose(existing)) {
          const [restored] = await tx
            .update(conversations)
            .set({
              archivedAt: null,
              metadata: { ...(existing.metadata as object), purpose: 'owner-chat' },
              updatedAt: sql`now()`,
            })
            .where(eq(conversations.id, existing.id))
            .returning();
          return restored ?? existing;
        }
        // Do not promote assistant-only background history to owner authority.
        // Repair its primary flag; retain its messages and original trust.
        if (existing)
          await tx
            .update(conversations)
            .set({ isPrimary: false, updatedAt: sql`now()` })
            .where(eq(conversations.id, existing.id));
        const [recent] = await tx
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.agentId, agentId),
              eq(conversations.channel, 'chat'),
              eq(conversations.trust, 'owner'),
              isNull(conversations.archivedAt),
              sql`${conversations.metadata}->>'goalId' IS NULL`,
              sql`(${conversations.metadata}->>'purpose' IS NULL OR ${conversations.metadata}->>'purpose' = 'owner-chat')`,
            ),
          )
          .orderBy(desc(conversations.updatedAt), desc(conversations.id))
          .limit(1);
        if (recent) {
          const [promoted] = await tx
            .update(conversations)
            .set({
              isPrimary: true,
              metadata: { ...(recent.metadata as object), purpose: 'owner-chat' },
              updatedAt: sql`now()`,
            })
            .where(eq(conversations.id, recent.id))
            .returning();
          if (promoted) return promoted;
        }
        const [created] = await tx
          .insert(conversations)
          .values({
            agentId,
            channel: 'chat',
            trust: 'owner',
            isPrimary: true,
            metadata: { purpose: 'owner-chat' },
          })
          .returning();
        if (!created) throw new Error('failed to create primary conversation');
        return created;
      });
    },

    async createConversation(agentId) {
      const [created] = await db
        .insert(conversations)
        .values({ agentId, channel: 'chat', trust: 'owner', metadata: { purpose: 'owner-chat' } })
        .returning();
      if (!created) throw new Error('failed to create conversation');
      return created;
    },

    getConversation: owned,

    async listConversations(agentId, input) {
      const limit = boundedChatConversationLimit(input.limit);
      const rows = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.agentId, agentId),
            eq(conversations.channel, 'chat'),
            input.archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt),
            input.after
              ? or(
                  lt(conversations.updatedAt, input.after.updatedAt),
                  and(
                    eq(conversations.updatedAt, input.after.updatedAt),
                    lt(conversations.id, input.after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const tail = page.at(-1);
      return {
        conversations: page,
        hasMore: rows.length > limit,
        nextCursor: tail ? { updatedAt: tail.updatedAt, id: tail.id } : null,
      };
    },

    async countConversations(agentId, archived) {
      const [row] = await db
        .select({ value: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.agentId, agentId),
            eq(conversations.channel, 'chat'),
            archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt),
          ),
        );
      return Number(row?.value ?? 0);
    },

    async listActiveConversationIds(agentId) {
      const rows = await db
        .selectDistinct({ conversationId: tasks.conversationId })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            isNotNull(tasks.conversationId),
            notInArray(tasks.status, TERMINAL_TASK_STATUSES),
          ),
        );
      return rows.map((row) => row.conversationId).filter((id): id is string => id !== null);
    },

    async archiveConversation(agentId, conversationId) {
      const conversation = await owned(agentId, conversationId);
      if (!conversation) throw new Error('chat not found');
      if (conversation.isPrimary) return 'primary';
      const [active] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            eq(tasks.conversationId, conversationId),
            notInArray(tasks.status, TERMINAL_TASK_STATUSES),
          ),
        )
        .limit(1);
      if (active) return 'active';
      await db
        .update(conversations)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(
          and(ownedConversationWhere(agentId, conversationId), isNull(conversations.archivedAt)),
        );
      return 'archived';
    },

    async restoreConversation(agentId, conversationId) {
      const [row] = await db
        .update(conversations)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(
          and(ownedConversationWhere(agentId, conversationId), isNotNull(conversations.archivedAt)),
        )
        .returning({ id: conversations.id });
      return Boolean(row);
    },

    async archiveInactiveConversations(agentId, olderThan, requestedLimit) {
      const limit = boundedChatConversationLimit(requestedLimit ?? 100);
      const candidates = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.agentId, agentId),
            eq(conversations.channel, 'chat'),
            eq(conversations.isPrimary, false),
            isNull(conversations.archivedAt),
            lt(conversations.updatedAt, olderThan),
          ),
        )
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(limit);
      if (!candidates.length) return 0;
      const archived = await db
        .update(conversations)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            inArray(
              conversations.id,
              candidates.map((candidate) => candidate.id),
            ),
            eq(conversations.agentId, agentId),
            isNull(conversations.archivedAt),
            sql`NOT EXISTS (
              SELECT 1 FROM ${tasks}
              WHERE ${tasks.conversationId} = ${conversations.id}
                AND ${tasks.agentId} = ${agentId}
                AND ${tasks.status} NOT IN ${TERMINAL_TASK_STATUSES}
            )`,
          ),
        )
        .returning({ id: conversations.id });
      return archived.length;
    },

    async setConversationModel(agentId, conversationId, modelId) {
      const [row] = await db
        .update(conversations)
        .set({ modelOverride: modelId, updatedAt: new Date() })
        .where(ownedConversationWhere(agentId, conversationId))
        .returning({ id: conversations.id });
      return Boolean(row);
    },

    async setConversationTitleIfEmpty(agentId, conversationId, title) {
      const [row] = await db
        .update(conversations)
        .set({ title })
        .where(and(ownedConversationWhere(agentId, conversationId), eq(conversations.title, '')))
        .returning({ id: conversations.id });
      return Boolean(row);
    },

    async markConversationRead(agentId, conversationId, readAt, settleSeconds = 30) {
      const threshold = new Date(readAt.getTime() - Math.max(0, settleSeconds) * 1000);
      const [row] = await db
        .update(conversations)
        .set({ lastReadAt: readAt })
        .where(
          and(
            ownedConversationWhere(agentId, conversationId),
            or(isNull(conversations.lastReadAt), lt(conversations.lastReadAt, threshold)),
          ),
        )
        .returning({ id: conversations.id });
      return Boolean(row);
    },

    async getGoalTitle(agentId, goalId) {
      const [goal] = await db
        .select({ title: goals.title })
        .from(goals)
        .where(and(eq(goals.id, goalId), eq(goals.agentId, agentId)))
        .limit(1);
      return goal?.title ?? null;
    },

    async clearGoalBlockedOnOwnerReply(agentId, goalId) {
      await db
        .update(goals)
        .set({ nextAction: '', updatedAt: sql`now()` })
        .where(
          and(
            eq(goals.id, goalId),
            eq(goals.agentId, agentId),
            like(goals.nextAction, `${GOAL_BLOCKED_PREFIX}%`),
          ),
        );
    },

    async countActiveTasks(agentId, conversationId) {
      const [row] = await db
        .select({ value: count() })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            eq(tasks.conversationId, conversationId),
            notInArray(tasks.status, TERMINAL_TASK_STATUSES),
          ),
        );
      return Number(row?.value ?? 0);
    },

    async getTaskStatus(agentId, conversationId, taskId) {
      const [task] = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.agentId, agentId),
            eq(tasks.conversationId, conversationId),
          ),
        )
        .limit(1);
      if (!task || isChatAdmissionCancellationProjection(task)) return null;
      return task.status;
    },

    async listTaskActivity(agentId, conversationId, taskId, requestedLimit = 3) {
      if ((await this.getTaskStatus(agentId, conversationId, taskId)) === null) return [];
      const limit = Math.max(1, Math.min(10, Math.floor(requestedLimit)));
      const rows = await db
        .select({
          toolName: toolCalls.toolName,
          status: toolCalls.status,
          step: toolCalls.step,
        })
        .from(toolCalls)
        .innerJoin(tasks, eq(toolCalls.taskId, tasks.id))
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.agentId, agentId),
            eq(tasks.conversationId, conversationId),
          ),
        )
        .orderBy(desc(toolCalls.createdAt), desc(toolCalls.id))
        .limit(limit);
      return rows.reverse();
    },

    async listEnabledModels() {
      return db
        .select({ id: models.id, label: models.label })
        .from(models)
        .where(
          and(
            eq(models.enabled, true),
            sql`${models.capabilities}->>'embedding' IS DISTINCT FROM 'true'`,
          ),
        )
        .orderBy(models.label);
    },

    async listMessages(agentId, conversationId, input = {}) {
      if (!(await owned(agentId, conversationId))) return null;
      const limit = boundedChatMessageLimit(input.limit);
      const createdAtExact = sql<string>`to_char(${messages.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
      const selection = { ...getTableColumns(messages), createdAtExact };
      if (input.after?.appendSequence) {
        const after = input.after;
        const rows = await db
          .select(selection)
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              isNull(messages.hiddenAt),
              sql`${messages.appendSequence} > ${after.appendSequence}`,
            ),
          )
          .orderBy(asc(messages.appendSequence))
          .limit(limit + 1);
        return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
      }
      if (input.fromStart || input.after) {
        const rows = await db
          .select(selection)
          .from(messages)
          .where(and(eq(messages.conversationId, conversationId), isNull(messages.hiddenAt)))
          .orderBy(asc(messages.appendSequence))
          .limit(limit + 1);
        return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
      }
      const rows = await db
        .select(selection)
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), isNull(messages.hiddenAt)))
        .orderBy(desc(messages.appendSequence))
        .limit(limit);
      return { messages: rows.reverse(), hasMore: false };
    },

    async listMessagesByIds(agentId, conversationId, ids) {
      if (!(await owned(agentId, conversationId))) return null;
      if (!ids.length) return [];
      return db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            inArray(messages.id, ids),
            isNull(messages.hiddenAt),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id));
    },

    async listRuntimeMessages(agentId, conversationId, taskIds, requestedLimit = 200) {
      if (!(await owned(agentId, conversationId))) return null;
      if (!taskIds.length) return [];
      const limit = boundedChatMessageLimit(requestedLimit);
      return db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            inArray(messages.taskId, taskIds),
            eq(messages.role, 'assistant'),
            isNull(messages.hiddenAt),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(limit);
    },

    async getTaskKinds(agentId, taskIds) {
      if (!taskIds.length) return new Map();
      const rows = await db
        .select({ id: tasks.id, type: tasks.type })
        .from(tasks)
        .where(and(eq(tasks.agentId, agentId), inArray(tasks.id, taskIds)));
      return new Map(rows.map((row) => [row.id, row.type]));
    },

    async getHydrationState(agentId, input) {
      const [approvalRows, taskApprovalRows, budgetRows, suggestionRows] = await Promise.all([
        input.approvalIds.length
          ? db
              .select({
                id: approvals.id,
                taskId: approvals.taskId,
                summary: approvals.summary,
                status: approvals.status,
                payload: approvals.payload,
                toolName: toolCalls.toolName,
                expiresAt: approvals.expiresAt,
              })
              .from(approvals)
              .innerJoin(tasks, eq(approvals.taskId, tasks.id))
              .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
              .where(and(eq(tasks.agentId, agentId), inArray(approvals.id, input.approvalIds)))
          : [],
        input.approvalTaskIds.length
          ? db
              .select({
                id: approvals.id,
                taskId: approvals.taskId,
                summary: approvals.summary,
                status: approvals.status,
                payload: approvals.payload,
                toolName: toolCalls.toolName,
                expiresAt: approvals.expiresAt,
              })
              .from(approvals)
              .innerJoin(tasks, eq(approvals.taskId, tasks.id))
              .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
              .where(
                and(eq(tasks.agentId, agentId), inArray(approvals.taskId, input.approvalTaskIds)),
              )
          : [],
        input.budgetTaskIds.length
          ? db
              .select({
                id: tasks.id,
                status: tasks.status,
                budgetUsdLimit: tasks.budgetUsdLimit,
              })
              .from(tasks)
              .where(and(eq(tasks.agentId, agentId), inArray(tasks.id, input.budgetTaskIds)))
          : [],
        input.suggestionIds.length
          ? db
              .select({
                id: suggestions.id,
                status: suggestions.status,
                expiresAt: suggestions.expiresAt,
                snoozedUntil: suggestions.snoozedUntil,
                acceptedTaskId: suggestions.acceptedTaskId,
                acceptedTaskStatus: tasks.status,
                acceptedTaskProgress: tasks.progress,
                acceptedTaskConversationId: tasks.conversationId,
              })
              .from(suggestions)
              .leftJoin(tasks, eq(tasks.id, suggestions.acceptedTaskId))
              .where(
                and(eq(suggestions.agentId, agentId), inArray(suggestions.id, input.suggestionIds)),
              )
          : [],
      ]);
      return {
        approvals: approvalRows,
        taskApprovals: taskApprovalRows,
        budgetTasks: budgetRows,
        suggestions: suggestionRows as ApplicationChatSuggestion[],
      };
    },

    async setMessageHidden(agentId, conversationId, messageId, hidden) {
      const [row] = await db
        .update(messages)
        .set({ hiddenAt: hidden ? new Date() : null })
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.conversationId, conversationId),
            sql`EXISTS (
              SELECT 1 FROM ${conversations}
              WHERE ${conversations.id} = ${conversationId}
                AND ${conversations.agentId} = ${agentId}
                AND ${conversations.channel} = 'chat'
            )`,
          ),
        )
        .returning({ id: messages.id });
      return Boolean(row);
    },

    async acknowledgeMessageDelivery(agentId, conversationId, messageId, clientId) {
      return db.transaction(async (tx) => {
        const [message] = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.id, messageId),
              eq(messages.conversationId, conversationId),
              eq(messages.role, 'assistant'),
              sql`EXISTS (
                SELECT 1 FROM ${conversations}
                WHERE ${conversations.id} = ${conversationId}
                  AND ${conversations.agentId} = ${agentId}
                  AND ${conversations.channel} = 'chat'
              )`,
            ),
          )
          .for('update')
          .limit(1);
        if (!message) return false;
        if (message.clientDeliveredBy) return message.clientDeliveredBy === clientId;
        if (!message.taskId) return false;
        const [task] = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.id, message.taskId),
              eq(tasks.agentId, agentId),
              eq(tasks.conversationId, conversationId),
              eq(tasks.type, 'chat_turn'),
              eq(tasks.trust, 'owner'),
              eq(tasks.status, 'done'),
            ),
          )
          .limit(1);
        const admission = task && chatAdmissionPayload(task);
        if (!task || !admission) return false;
        const [request] = await tx
          .select({ clientId: messages.clientId })
          .from(messages)
          .where(
            and(
              eq(messages.id, admission.triggerMessageId),
              eq(messages.conversationId, conversationId),
              eq(messages.taskId, task.id),
              eq(messages.role, 'user'),
              eq(messages.origin, 'owner'),
            ),
          )
          .limit(1);
        if (!request || request.clientId !== clientId) return false;
        const [updated] = await tx
          .update(messages)
          .set({ clientDeliveredAt: new Date(), clientDeliveredBy: clientId })
          .where(and(eq(messages.id, messageId), isNull(messages.clientDeliveredBy)))
          .returning({ id: messages.id });
        return Boolean(updated);
      });
    },

    async appendOwned(agentId, input) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(ownedConversationWhere(agentId, input.conversationId))
          .limit(1);
        if (!conversation) throw new Error('chat not found');
        const [row] = input.channelMessageId
          ? await tx
              .insert(messages)
              .values(input)
              .onConflictDoNothing({
                target: messages.channelMessageId,
                where: sql`${messages.channelMessageId} IS NOT NULL`,
              })
              .returning()
          : await tx.insert(messages).values(input).returning();
        if (row) {
          await tx
            .update(conversations)
            .set({ updatedAt: sql`now()` })
            .where(ownedConversationWhere(agentId, input.conversationId));
        }
        return row as ApplicationChatMessage | undefined;
      });
    },

    async cancelChatTurn(input) {
      assertChatAdmissionOperationId(input.clientOperationId);
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(ownedConversationWhere(input.agentId, input.conversationId))
          .limit(1);
        if (!conversation) throw new Error('chat not found');
        const externalEventId = chatAdmissionExternalEventId(input);
        const readExisting = async () => {
          const [existing] = await tx
            .select()
            .from(tasks)
            .where(eq(tasks.externalEventId, externalEventId))
            .limit(1)
            .for('update');
          if (!existing) return null;
          if (
            existing.agentId !== input.agentId ||
            existing.conversationId !== input.conversationId
          )
            throw new Error('Chat operation ID was already used for a different request');
          const cancellation = chatAdmissionCancellationPayload(existing);
          if (cancellation) {
            if (cancellation.clientOperationId !== input.clientOperationId)
              throw new Error('Chat operation ID was already used for a different request');
            return {
              kind: 'cancelled_before_admission',
              task: existing,
              status: 'cancelled',
              transitioned: false,
              effectStatus: 'not_started',
            } as const;
          }
          const admission = chatAdmissionPayload(existing);
          if (!admission || admission.clientOperationId !== input.clientOperationId)
            throw new Error('Chat operation ID was already used for a different request');
          const [message] = await tx
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.id, admission.triggerMessageId),
                eq(messages.conversationId, input.conversationId),
                eq(messages.role, 'user'),
                eq(messages.taskId, existing.id),
              ),
            )
            .limit(1);
          if (!message) throw new Error('Chat admission is missing its owner message');
          if (['done', 'failed', 'cancelled'].includes(existing.status))
            return {
              kind: 'admitted_task',
              task: existing,
              status: existing.status,
              transitioned: false,
              effectStatus: 'unknown',
            } as const;
          const [updated] = await tx
            .update(tasks)
            .set({
              status: 'cancelled',
              lockedUntil: null,
              leaseToken: null,
              runAfter: null,
              attempt: 0,
              updatedAt: sql`now()`,
            })
            .where(and(eq(tasks.id, existing.id), eq(tasks.agentId, input.agentId)))
            .returning();
          if (!updated) throw new Error('Chat task cancellation lost its locked row');
          return {
            kind: 'admitted_task',
            task: updated,
            status: 'cancelled',
            transitioned: true,
            effectStatus: 'unknown',
          } as const;
        };

        const existing = await readExisting();
        if (existing) return existing;
        const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
        if (!clock) throw new Error('Missing database clock');
        const tombstone = {
          ...newTaskRecord(
            {
              agentId: input.agentId,
              conversationId: input.conversationId,
              type: 'chat_turn',
              trust: 'owner',
              trigger: chatAdmissionCancellationTrigger(input),
              externalEventId,
            },
            randomUUID(),
            new Date(clock.now),
          ),
          status: 'cancelled' as const,
        };
        const [created] = await tx
          .insert(tasks)
          .values(tombstone)
          .onConflictDoNothing({
            target: tasks.externalEventId,
            where: sql`${tasks.externalEventId} IS NOT NULL`,
          })
          .returning();
        if (created)
          return {
            kind: 'cancelled_before_admission',
            task: created,
            status: 'cancelled',
            transitioned: true,
            effectStatus: 'not_started',
          } as const;
        const raced = await readExisting();
        if (raced) return raced;
        throw new Error('Chat cancellation conflict without an operation row');
      });
    },

    async admitChatTurn(input) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(ownedConversationWhere(input.agentId, input.conversationId))
          .limit(1);
        if (!conversation) throw new Error('chat not found');
        const externalEventId = chatAdmissionExternalEventId(input);
        const readExisting = async () => {
          const [existing] = await tx
            .select()
            .from(tasks)
            .where(eq(tasks.externalEventId, externalEventId))
            .limit(1)
            .for('update');
          if (!existing) return null;
          const cancellation = chatAdmissionCancellationPayload(existing);
          if (cancellation) {
            if (
              existing.agentId !== input.agentId ||
              existing.conversationId !== input.conversationId ||
              cancellation.clientOperationId !== input.clientOperationId
            )
              throw new Error('Chat operation ID was already used for a different request');
            return {
              kind: 'cancelled_before_admission',
              created: false,
              task: existing,
              status: 'cancelled',
              effectStatus: 'not_started',
            } as const;
          }
          const admission = chatAdmissionPayload(existing);
          if (
            existing.agentId !== input.agentId ||
            existing.conversationId !== input.conversationId ||
            !admission ||
            admission.clientOperationId !== input.clientOperationId ||
            admission.requestHash !== input.requestHash
          ) {
            throw new Error('Chat operation ID was already used for a different request');
          }
          const [message] = await tx
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.id, admission.triggerMessageId),
                eq(messages.conversationId, input.conversationId),
                eq(messages.role, 'user'),
              ),
            )
            .limit(1);
          if (!message) throw new Error('Chat admission is missing its owner message');
          return { kind: 'admitted', created: false, task: existing, message } as const;
        };
        const existing = await readExisting();
        if (existing) return existing;

        const [budget] = await tx.select().from(budgets).where(eq(budgets.scope, 'task_default'));
        const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
        if (!clock) throw new Error('Missing database clock');
        const now = new Date(clock.now);
        const messageId = randomUUID();
        const trigger = {
          source: 'chat',
          agentId: input.agentId,
          conversationId: input.conversationId,
          trust: 'owner',
          payload: {
            text: input.text,
            triggerMessageId: messageId,
            requestAt: now.toISOString(),
            intentRevision: 1,
            clientOperationId: input.clientOperationId,
            autonomous: input.autonomous,
            force: input.force,
            spoken: input.spoken,
            chatAdmission: {
              protocol: 'owner-chat-v1',
              clientOperationId: input.clientOperationId,
              requestHash: input.requestHash,
              triggerMessageId: messageId,
              phase: 'classifying',
            },
          },
        };
        const leaseToken = randomUUID();
        const task = newTaskRecord(
          {
            agentId: input.agentId,
            conversationId: input.conversationId,
            type: 'chat_turn',
            trust: 'owner',
            title: input.text,
            goalId: input.goalId,
            trigger,
            externalEventId,
            budgetUsdLimit: budget?.limitUsd ?? '0.50',
            autonomyGrant: input.autonomyGrant,
          },
          randomUUID(),
          now,
        );
        const lease: TaskLease = {
          ...task,
          status: 'running',
          updatedAt: now,
          lockedUntil: new Date(now.getTime() + DIRECT_CHAT_LEASE_MS),
          leaseToken,
        };
        const [created] = await tx
          .insert(tasks)
          .values(lease)
          .onConflictDoNothing({
            target: tasks.externalEventId,
            where: sql`${tasks.externalEventId} IS NOT NULL`,
          })
          .returning();
        if (!created) {
          const raced = await readExisting();
          if (raced) return raced;
          throw new Error('Chat admission conflict without an existing receipt');
        }
        const [message] = await tx
          .insert(messages)
          .values({
            id: messageId,
            conversationId: input.conversationId,
            taskId: created.id,
            role: 'user',
            origin: 'owner',
            clientId: input.clientId ?? null,
            clientDeliveredAt: null,
            clientDeliveredBy: null,
            parts: [{ type: 'text', text: input.text }],
            text: input.text,
          })
          .returning();
        if (!message) throw new Error('failed to persist chat admission message');
        await tx
          .update(conversations)
          .set({ updatedAt: now })
          .where(ownedConversationWhere(input.agentId, input.conversationId));
        return { kind: 'admitted', created: true, task: created, message, lease } as const;
      });
    },

    async queueAdmittedChatTurn(input) {
      return db.transaction(async (tx) => {
        const leaseToken = input.task.leaseToken;
        if (!leaseToken) return null;
        const [current] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, input.task.id), eq(tasks.agentId, input.agentId)))
          .limit(1);
        if (current?.status !== 'running' || current.leaseToken !== input.task.leaseToken)
          return null;
        const admission = chatAdmissionPayload(current);
        if (!admission || admission.phase === 'queued') return null;
        const [queued] = await tx
          .update(tasks)
          .set({
            status: 'pending',
            trigger: withChatAdmissionPhase(current.trigger, 'queued', input.triagedActionable),
            lockedUntil: null,
            leaseToken: null,
            queueGeneration: sql`${tasks.queueGeneration} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(tasks.id, input.task.id),
              eq(tasks.agentId, input.agentId),
              eq(tasks.status, 'running'),
              eq(tasks.leaseToken, leaseToken),
            ),
          )
          .returning({ id: tasks.id, queueGeneration: tasks.queueGeneration });
        return queued ?? null;
      });
    },

    async markChatTurnStreaming(input) {
      return db.transaction(async (tx) => {
        const leaseToken = input.task.leaseToken;
        if (!leaseToken) return false;
        const [current] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, input.task.id), eq(tasks.agentId, input.agentId)))
          .limit(1);
        if (current?.status !== 'running' || current.leaseToken !== input.task.leaseToken)
          return false;
        const admission = chatAdmissionPayload(current);
        if (!admission || admission.phase === 'queued') return false;
        const [updated] = await tx
          .update(tasks)
          .set({
            trigger: withChatAdmissionPhase(
              current.trigger,
              'streaming',
              false,
              input.triageOutcome,
            ),
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(tasks.id, input.task.id),
              eq(tasks.agentId, input.agentId),
              eq(tasks.status, 'running'),
              eq(tasks.leaseToken, leaseToken),
            ),
          )
          .returning({ id: tasks.id });
        return Boolean(updated);
      });
    },

    async createDirectChatTask(input) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(ownedConversationWhere(input.agentId, input.conversationId))
          .limit(1);
        if (!conversation) throw new Error('chat not found');
        const [budget] = await tx.select().from(budgets).where(eq(budgets.scope, 'task_default'));
        const now = new Date();
        const task = newTaskRecord(
          {
            agentId: input.agentId,
            conversationId: input.conversationId,
            type: 'chat_turn',
            trust: 'owner',
            goalId: input.goalId,
            title: conciseTitle(input.title),
            budgetUsdLimit: budget?.limitUsd ?? '0.50',
            trigger: { source: 'chat', conversationId: input.conversationId },
          },
          randomUUID(),
          now,
        );
        const lease: TaskLease = {
          ...task,
          status: 'running',
          updatedAt: now,
          lockedUntil: new Date(now.getTime() + DIRECT_CHAT_LEASE_MS),
          leaseToken: randomUUID(),
        };
        const [created] = await tx.insert(tasks).values(lease).returning();
        if (!created) throw new Error('failed to create chat task');
        return created as TaskLease;
      });
    },

    async completeDirectChatTask(input) {
      const leaseToken = input.task.leaseToken;
      if (!leaseToken) return false;
      return db.transaction(async (tx) => {
        const surfaced =
          input.status === 'done'
            ? input.messages.flatMap((message) =>
                message.role === 'assistant' ? recallSurfaceRefs(message.parts) : [],
              )
            : [];
        if (input.privacyObservationGeneration !== undefined) {
          const observed = await lockPostgresPrivacyObservationFence(tx, input.agentId);
          await assertPostgresPrivacyObservationFence(
            tx,
            input.agentId,
            input.privacyObservationGeneration,
          );
          if (observed !== input.privacyObservationGeneration)
            throw new Error('Privacy erasure changed during chat observation');
        } else if (surfaced.length > 0) {
          const [conversation] = await tx
            .select({ agentId: conversations.agentId })
            .from(conversations)
            .where(ownedConversationWhere(input.agentId, input.task.conversationId ?? ''))
            .limit(1);
          if (!conversation || conversation.agentId !== input.agentId)
            throw new Error('Chat completion conversation is outside the owner scope');
          await lockPostgresPrivacyObservationFence(tx, input.agentId);
        }
        if (input.status === 'done')
          await assertRecalledMessagesCurrent(tx, input.agentId, surfaced);
        if (input.status === 'done')
          await assertRecallSourcesNotHidden(tx, input.agentId, surfaced);
        const [completed] = await tx
          .update(tasks)
          .set({
            status: input.status,
            progress: input.progress,
            lockedUntil: null,
            leaseToken: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(tasks.id, input.task.id),
              eq(tasks.agentId, input.agentId),
              eq(tasks.status, 'running'),
              eq(tasks.leaseToken, leaseToken),
              gt(tasks.lockedUntil, sql`now()`),
            ),
          )
          .returning({ id: tasks.id });
        if (!completed) return false;
        const surfacedMessageIds = new Map<
          string,
          { messageId: string; ref: (typeof surfaced)[number] }
        >();
        for (const message of input.messages) {
          if (
            message.conversationId !== input.task.conversationId ||
            message.taskId !== input.task.id
          ) {
            throw new Error('Chat completion message does not match its task');
          }
          const [inserted] = await tx.insert(messages).values(message).returning({
            id: messages.id,
            createdAt: messages.createdAt,
          });
          if (!inserted) throw new Error('Chat completion message was not persisted');
          if (input.status === 'done' && message.role === 'assistant') {
            const refs = recallSurfaceRefs(message.parts);
            for (const ref of refs) {
              surfacedMessageIds.set(ref.sourceKey, { messageId: inserted.id, ref });
            }
          }
        }
        for (const { messageId, ref } of surfacedMessageIds.values()) {
          const [current] = await tx
            .select()
            .from(recallSurfaces)
            .where(
              and(
                eq(recallSurfaces.agentId, input.agentId),
                eq(recallSurfaces.sourceKey, ref.sourceKey),
              ),
            )
            .for('update')
            .limit(1);
          if (current) {
            const revised = current.sourceRevision !== ref.sourceRevision;
            await tx
              .update(recallSurfaces)
              .set({
                suppressedAt: revised ? null : current.suppressedAt,
                sourceRevision: ref.sourceRevision,
                kind: ref.kind,
                lastSurfacedAt: sql`now()`,
                lastMessageId: messageId,
                surfaceCount: current.surfaceCount + 1,
                version: current.version + (revised ? 1 : 0),
              })
              .where(eq(recallSurfaces.id, current.id));
            continue;
          }
          const [created] = await tx
            .insert(recallSurfaces)
            .values({
              agentId: input.agentId,
              sourceKey: ref.sourceKey,
              sourceRevision: ref.sourceRevision,
              kind: ref.kind,
              firstSurfacedAt: sql`now()`,
              lastSurfacedAt: sql`now()`,
              lastMessageId: messageId,
              surfaceCount: 1,
            })
            .onConflictDoNothing()
            .returning({ id: recallSurfaces.id });
          if (created) continue;
          const [raced] = await tx
            .select()
            .from(recallSurfaces)
            .where(
              and(
                eq(recallSurfaces.agentId, input.agentId),
                eq(recallSurfaces.sourceKey, ref.sourceKey),
              ),
            )
            .for('update')
            .limit(1);
          if (!raced) throw new Error('Recall surface changed during chat completion');
          const revised = raced.sourceRevision !== ref.sourceRevision;
          await tx
            .update(recallSurfaces)
            .set({
              suppressedAt: revised ? null : raced.suppressedAt,
              sourceRevision: ref.sourceRevision,
              kind: ref.kind,
              lastSurfacedAt: sql`now()`,
              lastMessageId: messageId,
              surfaceCount: raced.surfaceCount + 1,
              version: raced.version + (revised ? 1 : 0),
            })
            .where(eq(recallSurfaces.id, raced.id));
        }
        if (input.task.conversationId && input.messages.length) {
          await tx
            .update(conversations)
            .set({ updatedAt: sql`now()` })
            .where(ownedConversationWhere(input.agentId, input.task.conversationId));
        }
        return true;
      });
    },

    async raiseTaskBudget(agentId, taskId, requested) {
      if (normalizeTaskBudget(requested, 0.01) === null) {
        throw new Error(
          'task budget must be between $0.01 and $9,999.9999 with at most four decimal places',
        );
      }
      const [task] = await db
        .select({
          id: tasks.id,
          status: tasks.status,
          budgetUsdLimit: tasks.budgetUsdLimit,
          spentUsd: tasks.spentUsd,
        })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
        .limit(1);
      if (!task) throw new Error('activity item not found');
      if (task.status !== 'needs_attention') throw new Error('only stalled tasks can be retried');
      if (requested <= Number(task.budgetUsdLimit) || requested < Number(task.spentUsd)) {
        throw new Error('new task budget must be above its current cap and spend');
      }
      if (
        !(await createPostgresTaskRepository(db).wakeTask(task.id, { agentId, limit: requested }))
      ) {
        throw new Error('task changed before the budget increase could be applied');
      }
    },

    listConversationEvidence(agentId, conversationId, excludeTaskId) {
      return createPostgresExecutionEvidenceRepository(db).conversationEvidence({
        agentId,
        conversationId,
        excludeTaskId,
      });
    },
  };
}
