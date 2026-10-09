import type {
  ApprovedToolCall,
  CachedToolCallInput,
  ClaimApprovedToolCallInput,
  ClaimApprovedToolCallResult,
  Records,
  ToolExecutionOutcome,
  ToolExecutionRepository,
} from '@assistant/persistence';
import {
  advanceExternalEffect,
  approvalPolicyFingerprint,
  idempotencyIdentityDigest,
  MAX_APPROVAL_POLICY_SNAPSHOT_ROWS,
  mcpApprovalBindingFingerprint,
  modelToolCallIdentityDigest,
  toolCallReceiptKeyId,
  toolCallReplayKeysForStart,
} from '@assistant/persistence';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import {
  approvalPolicies,
  approvals,
  contacts,
  conversations,
  mcpConnections,
  messages,
  rateLimits,
  tasks,
  toolCache,
  toolCallReceiptKeys,
  toolCallReceipts,
  toolCalls,
} from './schema.js';
import { lockPostgresToolCallReceiptKeys } from './tool-call-receipt-lock.js';

async function receiptForKey(
  db: Db,
  input: {
    id: string;
    kind: 'model_tool_call' | 'idempotency';
    digest: string;
    agentId: string;
    taskId: string;
  },
) {
  const [key] = await db
    .select()
    .from(toolCallReceiptKeys)
    .where(eq(toolCallReceiptKeys.id, input.id))
    .limit(1);
  if (
    !key ||
    key.kind !== input.kind ||
    key.digest !== input.digest ||
    key.agentId !== input.agentId ||
    (input.kind === 'model_tool_call' &&
      (key.agentId !== input.agentId || key.taskId !== input.taskId))
  )
    return null;
  const [receipt] = await db
    .select()
    .from(toolCallReceipts)
    .where(and(eq(toolCallReceipts.id, key.receiptId), eq(toolCallReceipts.agentId, input.agentId)))
    .limit(1);
  if (
    !receipt ||
    receipt.taskId !== input.taskId ||
    receipt.taskId !== key.taskId ||
    receipt.toolCallId !== key.receiptId ||
    receipt.id !== key.receiptId ||
    (input.kind === 'model_tool_call' && receipt.modelToolCallIdHash !== input.digest) ||
    (input.kind === 'idempotency' && receipt.idempotencyKeyHash !== input.digest)
  )
    return null;
  return typedReceipt(receipt);
}

function typedReceipt(value: unknown): Records['toolCallReceipts'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.agentId !== 'string' ||
    typeof row.taskId !== 'string' ||
    typeof row.toolCallId !== 'string' ||
    !(row.modelToolCallIdHash === null || typeof row.modelToolCallIdHash === 'string') ||
    !(row.idempotencyKeyHash === null || typeof row.idempotencyKeyHash === 'string') ||
    typeof row.toolName !== 'string' ||
    !['completed', 'failed', 'unknown', 'not_executed'].includes(String(row.effectOutcome)) ||
    !(row.recordedAt instanceof Date)
  )
    return null;
  return value as Records['toolCallReceipts'];
}

async function load(
  db: Db,
  agentId: string,
  taskId: string,
  toolCallId: string,
): Promise<ApprovedToolCall | null> {
  const [row] = await db
    .select({ toolCall: toolCalls, task: tasks, approval: approvals })
    .from(toolCalls)
    .innerJoin(tasks, and(eq(toolCalls.taskId, tasks.id), eq(tasks.agentId, agentId)))
    .leftJoin(approvals, eq(toolCalls.approvalId, approvals.id))
    .where(and(eq(toolCalls.id, toolCallId), eq(toolCalls.taskId, taskId)))
    .limit(1);
  if (!row) return null;
  if (row.toolCall.approvalId && !row.approval) return null;
  if (
    row.approval &&
    (row.approval.toolCallId !== row.toolCall.id ||
      row.approval.taskId !== row.task.id ||
      row.approval.status !== 'approved')
  )
    return null;
  return row;
}

export function createPostgresToolExecutionRepository(db: Db): ToolExecutionRepository {
  return {
    kind: 'tool-execution-repository',
    load: (agentId, taskId, toolCallId) => load(db, agentId, taskId, toolCallId),
    findByModelToolCallId: async (agentId, taskId, modelToolCallId) => {
      if (!modelToolCallId) return null;
      const rows = await db
        .select({ toolCall: toolCalls, approval: approvals })
        .from(toolCalls)
        .innerJoin(tasks, and(eq(toolCalls.taskId, tasks.id), eq(tasks.agentId, agentId)))
        .leftJoin(approvals, eq(toolCalls.approvalId, approvals.id))
        .where(
          and(
            eq(toolCalls.taskId, taskId),
            sql`${toolCalls.decision}->>'modelToolCallId' = ${modelToolCallId}`,
          ),
        )
        .limit(2);
      // Duplicate model ids make replay ambiguous; fail closed rather than
      // choosing whichever side effect happened to be returned first.
      const match = rows[0];
      return rows.length === 1 && match
        ? { toolCall: match.toolCall, approval: match.approval }
        : null;
    },
    findReceiptByToolCallId: async (agentId, taskId, toolCallId) => {
      const [receipt] = await db
        .select()
        .from(toolCallReceipts)
        .where(
          and(
            eq(toolCallReceipts.id, toolCallId),
            eq(toolCallReceipts.toolCallId, toolCallId),
            eq(toolCallReceipts.agentId, agentId),
            eq(toolCallReceipts.taskId, taskId),
          ),
        )
        .limit(1);
      return receipt ? typedReceipt(receipt) : null;
    },
    findReceiptByModelToolCallId: async (agentId, taskId, modelToolCallId) => {
      const digest = modelToolCallIdentityDigest(agentId, taskId, modelToolCallId);
      if (!digest) return null;
      return receiptForKey(db, {
        id: toolCallReceiptKeyId('model_tool_call', digest),
        kind: 'model_tool_call',
        digest,
        agentId,
        taskId,
      });
    },
    findReceiptByIdempotencyKey: async (agentId, taskId, idempotencyKey) => {
      const digest = idempotencyIdentityDigest(idempotencyKey);
      if (!digest) return null;
      return receiptForKey(db, {
        id: toolCallReceiptKeyId('idempotency', digest),
        kind: 'idempotency',
        digest,
        agentId,
        taskId,
      });
    },
    claim: async (input: ClaimApprovedToolCallInput): Promise<ClaimApprovedToolCallResult> =>
      db.transaction(async (tx) => {
        // Serialize effect claims with policy edits and privacy erasure. This
        // must be the first lock, followed by task → approval → toolCall.
        await lockPostgresPrivacyObservationFence(tx as unknown as Db, input.agentId);
        // Cancellation changes the task row and its lease together. Lock it
        // first so a claim and cancellation have one well-defined winner.
        const [lockedTask] = await tx
          .select({
            id: tasks.id,
            agentId: tasks.agentId,
            trust: tasks.trust,
            status: tasks.status,
          })
          .from(tasks)
          .where(eq(tasks.id, input.taskId))
          .for('update');
        if (!lockedTask || lockedTask.agentId !== input.agentId) return null;
        // Approval decisions lock the approval before its linked call; retain that lock order.
        const [approvalLink] = await tx
          .select({ approvalId: toolCalls.approvalId })
          .from(toolCalls)
          .where(and(eq(toolCalls.id, input.toolCallId), eq(toolCalls.taskId, input.taskId)))
          .limit(1);
        if (approvalLink?.approvalId)
          await tx
            .select({ id: approvals.id })
            .from(approvals)
            .where(eq(approvals.id, approvalLink.approvalId))
            .for('update');
        await tx
          .select({ id: toolCalls.id })
          .from(toolCalls)
          .where(and(eq(toolCalls.id, input.toolCallId), eq(toolCalls.taskId, input.taskId)))
          .for('update');
        const current = await load(
          tx as unknown as Db,
          input.agentId,
          input.taskId,
          input.toolCallId,
        );
        if (input.expectedTaskStatus && current?.task.status !== input.expectedTaskStatus)
          return null;
        if (current?.toolCall.status !== 'approved') return null;
        if (
          input.expectedApprovalId !== undefined &&
          current.toolCall.approvalId !== input.expectedApprovalId
        )
          return null;
        const markStaleAuthorization = async (): Promise<ClaimApprovedToolCallResult> => {
          // The failed receipt and refused claim commit together. Preserve the
          // reservation id from the caller's decision for crash reconciliation.
          const error = 'approval authority changed before execution; request fresh approval';
          const reservationId =
            typeof input.decision.reservationId === 'string' ? input.decision.reservationId : null;
          const modelToolCallId =
            typeof input.decision.modelToolCallId === 'string'
              ? input.decision.modelToolCallId
              : null;
          const [failed] = await tx
            .update(toolCalls)
            .set({
              status: 'failed',
              decision: {
                ...(reservationId ? { reservationId } : {}),
                ...(modelToolCallId ? { modelToolCallId } : {}),
              },
              result: null,
              error,
              finishedAt: input.startedAt ?? sql`now()`,
            })
            .where(
              and(
                eq(toolCalls.id, input.toolCallId),
                eq(toolCalls.taskId, input.taskId),
                eq(toolCalls.status, 'approved'),
                current.toolCall.approvalId
                  ? eq(toolCalls.approvalId, current.toolCall.approvalId)
                  : isNull(toolCalls.approvalId),
              ),
            )
            .returning({ id: toolCalls.id });
          return failed ? { type: 'stale_authorization', error } : null;
        };
        if (lockedTask.trust !== input.expectedTaskTrust) return markStaleAuthorization();
        if (
          input.expectedResolutionPayload !== undefined &&
          JSON.stringify(current.approval?.resolutionPayload ?? null) !==
            JSON.stringify(input.expectedResolutionPayload)
        )
          return markStaleAuthorization();
        if (
          !input.expectedPolicyFingerprint ||
          !/^[a-f0-9]{64}$/.test(input.expectedPolicyFingerprint)
        )
          return markStaleAuthorization();
        const policyRows = await tx
          .select()
          .from(approvalPolicies)
          .where(
            and(
              eq(approvalPolicies.agentId, input.agentId),
              eq(approvalPolicies.toolName, current.toolCall.toolName),
            ),
          )
          .orderBy(approvalPolicies.id)
          .limit(MAX_APPROVAL_POLICY_SNAPSHOT_ROWS + 1)
          .for('update');
        if (policyRows.length > MAX_APPROVAL_POLICY_SNAPSHOT_ROWS) return markStaleAuthorization();
        try {
          if (approvalPolicyFingerprint(policyRows) !== input.expectedPolicyFingerprint)
            return markStaleAuthorization();
        } catch {
          return markStaleAuthorization();
        }
        if (current.toolCall.toolName === 'mcp.call') {
          const binding = input.expectedMcpBinding;
          if (
            !binding ||
            binding.connectionId !== (input.args as { connectionId?: unknown }).connectionId ||
            !/^[a-f0-9]{64}$/.test(binding.fingerprint)
          )
            return markStaleAuthorization();
          const [connection] = await tx
            .select()
            .from(mcpConnections)
            .where(
              and(
                eq(mcpConnections.id, binding.connectionId),
                eq(mcpConnections.agentId, input.agentId),
              ),
            )
            .for('update');
          let bindingMatches = false;
          try {
            bindingMatches = Boolean(
              connection &&
                mcpApprovalBindingFingerprint(
                  connection,
                  String((input.args as { toolName?: unknown }).toolName),
                ) === binding.fingerprint,
            );
          } catch {
            bindingMatches = false;
          }
          if (!bindingMatches) return markStaleAuthorization();
        } else if (input.expectedMcpBinding) {
          return markStaleAuthorization();
        }
        const [claimed] = await tx
          .update(toolCalls)
          .set({
            status: 'executing',
            args: input.args,
            decision: input.decision,
            startedAt: input.startedAt ?? sql`now()`,
          })
          .where(
            and(
              eq(toolCalls.id, input.toolCallId),
              eq(toolCalls.taskId, input.taskId),
              eq(toolCalls.status, 'approved'),
            ),
          )
          .returning({ id: toolCalls.id });
        return claimed
          ? {
              ...current,
              toolCall: {
                ...current.toolCall,
                ...claimed,
                status: 'executing',
                args: input.args,
                decision: input.decision,
              },
            }
          : null;
      }),
    checkpointExternalEffect: async (input) =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .select({ call: toolCalls })
          .from(toolCalls)
          .innerJoin(tasks, eq(tasks.id, toolCalls.taskId))
          .where(
            and(
              eq(toolCalls.id, input.toolCallId),
              eq(toolCalls.taskId, input.taskId),
              eq(tasks.agentId, input.agentId),
              eq(toolCalls.status, 'executing'),
            ),
          )
          .for('update');
        if (!row) return false;
        const decision = (row.call.decision ?? {}) as Record<string, unknown>;
        const progress = advanceExternalEffect(decision.externalEffect, input.progress);
        await tx
          .update(toolCalls)
          .set({ decision: { ...decision, externalEffect: progress } })
          .where(eq(toolCalls.id, input.toolCallId));
        return true;
      }),
    outcome: async (input: ToolExecutionOutcome) => {
      if (!(await load(db, input.agentId, input.taskId, input.toolCallId))) return false;
      const [updated] = await db
        .update(toolCalls)
        .set({
          status: input.status,
          ...(input.result !== undefined ? { result: input.result } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          finishedAt: input.finishedAt ?? sql`now()`,
        })
        .where(
          and(
            eq(toolCalls.id, input.toolCallId),
            eq(toolCalls.taskId, input.taskId),
            input.fromStatus
              ? eq(toolCalls.status, input.fromStatus)
              : eq(toolCalls.status, 'executing'),
          ),
        )
        .returning({ id: toolCalls.id });
      return Boolean(updated);
    },
    contacts: () => db.select({ emails: contacts.emails, phones: contacts.phones }).from(contacts),
    underRateLimit: async (scope, toolName, now = new Date()) => {
      const [limit] = await db.select().from(rateLimits).where(eq(rateLimits.scope, scope));
      if (!limit) return true;
      const countSince = async (ms: number) => {
        const [row] = await db
          .select({ n: sql<number>`count(*)` })
          .from(toolCalls)
          .where(
            and(
              eq(toolCalls.toolName, toolName),
              eq(toolCalls.status, 'succeeded'),
              sql`${toolCalls.createdAt} >= ${new Date(now.getTime() - ms).toISOString()}::timestamptz`,
            ),
          );
        return Number(row?.n ?? 0);
      };
      if (limit.maxPerHour !== null && (await countSince(60 * 60_000)) >= limit.maxPerHour)
        return false;
      if (limit.maxPerDay !== null && (await countSince(24 * 60 * 60_000)) >= limit.maxPerDay)
        return false;
      return true;
    },
    cacheGet: async (cacheKey, now = new Date()) => {
      const [row] = await db
        .select({ result: toolCache.result })
        .from(toolCache)
        .where(
          and(
            eq(toolCache.cacheKey, cacheKey),
            sql`${toolCache.expiresAt} >= ${now.toISOString()}::timestamptz`,
          ),
        );
      return row ?? null;
    },
    cachePut: async (input) => {
      await db
        .insert(toolCache)
        .values({ ...input, result: input.result as Record<string, unknown> })
        .onConflictDoUpdate({
          target: toolCache.cacheKey,
          set: { result: input.result as Record<string, unknown>, expiresAt: input.expiresAt },
        });
    },
    start: async (input) => {
      const modelToolCallId = (input.decision as { modelToolCallId?: unknown } | null)
        ?.modelToolCallId;
      const keys = toolCallReplayKeysForStart({
        agentId: input.agentId,
        taskId: input.taskId,
        toolCallId: '00000000-0000-0000-0000-000000000000',
        modelToolCallId,
        idempotencyKey: input.idempotencyKey,
      });
      if (!keys) throw new Error('Tool replay identity is invalid');
      return db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx as unknown as Db, input.agentId);
        const [task] = await tx
          .select({ id: tasks.id, status: tasks.status })
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.agentId, input.agentId)))
          .for('update')
          .limit(1);
        if (!task || ['done', 'failed', 'cancelled'].includes(task.status)) return null;
        await lockPostgresToolCallReceiptKeys(tx as unknown as Db, keys);
        for (const key of keys) {
          const [existing] = await tx
            .select({ id: toolCallReceiptKeys.id })
            .from(toolCallReceiptKeys)
            .where(eq(toolCallReceiptKeys.id, key.id))
            .limit(1);
          if (existing) return null;
        }
        if (typeof modelToolCallId === 'string') {
          const [existing] = await tx
            .select({ id: toolCalls.id })
            .from(toolCalls)
            .where(
              and(
                eq(toolCalls.taskId, input.taskId),
                sql`${toolCalls.decision}->>'modelToolCallId' = ${modelToolCallId}`,
              ),
            )
            .limit(1);
          if (existing) return null;
        }
        const [row] = await tx
          .insert(toolCalls)
          .values({
            taskId: input.taskId,
            step: input.step,
            toolName: input.toolName,
            args: input.args,
            risk: 'autonomous',
            status: 'executing',
            idempotencyKey: input.idempotencyKey,
            decision: input.decision,
            startedAt: input.startedAt ?? new Date(),
          })
          .onConflictDoNothing({
            target: toolCalls.idempotencyKey,
            where: sql`${toolCalls.idempotencyKey} IS NOT NULL`,
          })
          .returning();
        if (!row) return null;
        const keyRecords = toolCallReplayKeysForStart({
          agentId: input.agentId,
          taskId: input.taskId,
          toolCallId: row.id,
          modelToolCallId,
          idempotencyKey: input.idempotencyKey,
        });
        if (!keyRecords) throw new Error('Tool replay identity changed during start');
        if (keyRecords.length) await tx.insert(toolCallReceiptKeys).values(keyRecords);
        return row;
      });
    },
    findIdempotent: async (agentId, taskId, idempotencyKey) => {
      const [row] = await db
        .select({ call: toolCalls })
        .from(toolCalls)
        .innerJoin(tasks, and(eq(toolCalls.taskId, tasks.id), eq(tasks.agentId, agentId)))
        .where(and(eq(toolCalls.idempotencyKey, idempotencyKey), eq(toolCalls.taskId, taskId)));
      return row?.call ?? null;
    },
    cached: async (input: CachedToolCallInput) => {
      const modelToolCallId = (input.decision as { modelToolCallId?: unknown } | null)
        ?.modelToolCallId;
      const placeholderKeys = toolCallReplayKeysForStart({
        agentId: input.agentId,
        taskId: input.taskId,
        toolCallId: '00000000-0000-0000-0000-000000000000',
        modelToolCallId,
        idempotencyKey: input.idempotencyKey,
      });
      if (!placeholderKeys) throw new Error('Tool replay identity is invalid');
      return db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(tx as unknown as Db, input.agentId);
        const [task] = await tx
          .select({ id: tasks.id, status: tasks.status })
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.agentId, input.agentId)))
          .for('update')
          .limit(1);
        if (!task || ['done', 'failed', 'cancelled'].includes(task.status))
          throw new Error('tool call task is not active and owned by agent');
        await lockPostgresToolCallReceiptKeys(tx as unknown as Db, placeholderKeys);
        for (const key of placeholderKeys) {
          const [existing] = await tx
            .select({ id: toolCallReceiptKeys.id })
            .from(toolCallReceiptKeys)
            .where(eq(toolCallReceiptKeys.id, key.id))
            .limit(1);
          if (existing) throw new Error('Tool call replay identity is already recorded');
        }
        const [row] = await tx
          .insert(toolCalls)
          .values({
            taskId: input.taskId,
            step: input.step,
            toolName: input.toolName,
            args: input.args,
            risk: 'autonomous',
            status: 'succeeded',
            idempotencyKey: input.idempotencyKey,
            decision: input.decision,
            result: input.result,
            startedAt: input.startedAt ?? new Date(),
            finishedAt: new Date(),
          })
          .returning();
        if (!row) throw new Error('failed to persist cached tool call');
        const keyRecords = toolCallReplayKeysForStart({
          agentId: input.agentId,
          taskId: input.taskId,
          toolCallId: row.id,
          modelToolCallId,
          idempotencyKey: input.idempotencyKey,
        });
        if (!keyRecords) throw new Error('Tool replay identity changed during cached call');
        if (keyRecords.length) await tx.insert(toolCallReceiptKeys).values(keyRecords);
        return row;
      });
    },
    parentIsMission: async (agentId, parentTaskId) => {
      const [row] = await db
        .select({ type: tasks.type })
        .from(tasks)
        .where(and(eq(tasks.id, parentTaskId), eq(tasks.agentId, agentId)));
      return row?.type === 'mission';
    },
    conversationGoalId: async (agentId, conversationId) => {
      const [row] = await db
        .select({ metadata: conversations.metadata })
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agentId)));
      const goalId = (row?.metadata as { goalId?: unknown } | null)?.goalId;
      return typeof goalId === 'string' ? goalId : null;
    },
    goalWorkEvidence: async (agentId, taskId) => {
      const rows = await db
        .select({
          toolName: toolCalls.toolName,
          status: toolCalls.status,
          result: toolCalls.result,
        })
        .from(toolCalls)
        .innerJoin(tasks, and(eq(toolCalls.taskId, tasks.id), eq(tasks.agentId, agentId)))
        .where(eq(toolCalls.taskId, taskId));
      return rows;
    },
    ownerMessageHistory: async (agentId, conversationId, before) => {
      const rows = await db
        .select({ text: messages.text })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(conversations.agentId, agentId),
            eq(conversations.channel, 'chat'),
            eq(conversations.trust, 'owner'),
            eq(messages.role, 'user'),
            eq(messages.origin, 'owner'),
            lte(messages.createdAt, before),
          ),
        )
        .orderBy(sql`${messages.createdAt} DESC`)
        .limit(4);
      return rows.reverse().map((row) => row.text);
    },
    searchResults: async (taskId) => {
      const rows = await db
        .select({ result: toolCalls.result })
        .from(toolCalls)
        .where(
          and(
            eq(toolCalls.taskId, taskId),
            eq(toolCalls.toolName, 'web.search'),
            eq(toolCalls.status, 'succeeded'),
          ),
        );
      return rows.map((row) => row.result);
    },
  };
}
