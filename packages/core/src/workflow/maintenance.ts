import {
  approvals,
  conversationSegments,
  costEvents,
  type Db,
  lockPostgresPrivacyObservationFence,
  lockPostgresToolCallReceiptKeys,
  memories,
  messages,
  modelCallAudit,
  modelCalls,
  tasks,
  toolCache,
  toolCallReceiptKeys,
  toolCallReceipts,
  toolCalls,
} from '@assistant/db';
import type {
  AgedHistoryCounts,
  CostRepository,
  MaintenanceRepository,
  RecallMetricsRepository,
} from '@assistant/persistence';
import {
  compactToolCallReceipt,
  embeddingSpaceIdentityKey,
  toolCallReceiptKeysForReceipt,
} from '@assistant/persistence';
import { and, eq, inArray, isNotNull, isNull, lt, lte, notExists, or, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { releaseStaleReservations } from '../cost.js';
import { purgeStaleLocations } from '../memory/location.js';
import { purgeStaleRecallMetrics } from '../memory/recall-metrics.js';
import type { ModelRouter } from '../model-router/router.js';
import { purgeStaleProactivePings } from '../proactive/nudge-policy.js';
import { purgeStaleDreamNotes } from './dream.js';

/**
 * Backfill embeddings for recent messages that lack them — this is what makes
 * conversations.search semantic instead of ILIKE-fallback. Runs from the
 * sweep; small batches keep cost negligible (~$0.02 per MILLION tokens).
 */
export async function backfillMessageEmbeddings(
  store: Db | MaintenanceRepository,
  router: Pick<ModelRouter, 'embed' | 'embeddingSpace'>,
  batch = 20,
): Promise<number> {
  const space = await router.embeddingSpace();
  const spaceKey = embeddingSpaceIdentityKey(space);
  if ('kind' in store && store.kind === 'maintenance-repository')
    return (store as MaintenanceRepository).embedMissingMessages({
      batch,
      embeddingSpaceKey: spaceKey,
      embed: (texts) =>
        router.embed(
          texts.map((text) => text.slice(0, 4000)),
          { expectedSpace: space },
        ),
    });
  const db = store as Db;
  const rows = await db
    .select({ id: messages.id, text: messages.text })
    .from(messages)
    .where(
      and(
        isNull(messages.embedding),
        or(eq(messages.role, 'user'), eq(messages.role, 'assistant')),
        sql`length(${messages.text}) > 20`,
        sql`(${messages.channelMessageId} is null or (${messages.channelMessageId} not like 'visual-qa:%' and ${messages.channelMessageId} not like 'readability-%'))`,
      ),
    )
    .orderBy(sql`${messages.createdAt} desc`)
    .limit(batch);
  if (rows.length === 0) return 0;

  const embeddings = await router.embed(
    rows.map((r) => r.text.slice(0, 4000)),
    {
      expectedSpace: space,
    },
  );
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const embedding = embeddings[i];
    if (!row || !embedding) continue;
    await db
      .update(messages)
      .set({ embedding, embeddingSpaceKey: spaceKey })
      .where(eq(messages.id, row.id));
  }
  return rows.length;
}

/**
 * Drop captured prompts and answers past the retention window.
 *
 * This table holds the owner's mail and conversations in the clear when capture
 * is on, so expiry is the point rather than housekeeping: keeping the record is
 * only defensible because it does not keep it for long. Batched like the other
 * purges so one sweep cannot take a long lock.
 */
export async function purgeStaleModelCallAudit(
  db: Db,
  retentionDays = 14,
  batch = 500,
): Promise<number> {
  const days = Number.isFinite(retentionDays) ? Math.max(1, Math.trunc(retentionDays)) : 14;
  const limit = Number.isFinite(batch) ? Math.max(1, Math.trunc(batch)) : 500;
  const stale = db
    .select({ id: modelCallAudit.id })
    .from(modelCallAudit)
    .where(lt(modelCallAudit.createdAt, sql`now() - make_interval(days => ${days})`))
    .limit(limit);
  const deleted = await db
    .delete(modelCallAudit)
    .where(inArray(modelCallAudit.id, stale))
    .returning({ id: modelCallAudit.id });
  return deleted.length;
}

/** The portable stores the expiry pass needs. */
export interface ExpiryStores {
  maintenance: MaintenanceRepository;
  costs: CostRepository;
  recallMetrics: RecallMetricsRepository;
}

/** Purge expired tool-cache rows and expired memories. */
export async function purgeExpired(
  store: Db | ExpiryStores,
  batch = 500,
): Promise<{
  cache: number;
  memories: number;
  reservations: number;
  locations: number;
  dreamNotes: number;
  recallMetrics: number;
  proactivePings: number;
  modelCallAudit: number;
}> {
  if ('maintenance' in store) {
    const config = loadConfig();
    // The same retention windows as the PostgreSQL purges below.
    const [purged, reservations, recallMetrics] = await Promise.all([
      store.maintenance.purgeExpired({
        batch,
        locationRetentionDays: config.LOCATION_RETENTION_DAYS,
        proactivePingRetentionDays: 90,
        auditRetentionDays: config.LLM_AUDIT_RETENTION_DAYS,
      }),
      releaseStaleReservations(store.costs, 120, batch),
      purgeStaleRecallMetrics(store.recallMetrics, 90, batch),
    ]);
    return { ...purged, reservations, recallMetrics };
  }
  const db = store as Db;
  const expiredCache = db
    .select({ id: toolCache.cacheKey })
    .from(toolCache)
    .where(lte(toolCache.expiresAt, sql`now()`))
    .limit(batch);
  const expiredMemories = db
    .select({ id: memories.id })
    .from(memories)
    .where(and(isNotNull(memories.expiresAt), lte(memories.expiresAt, sql`now()`)))
    .limit(batch);
  const [
    cacheRows,
    memoryRows,
    reservations,
    locations,
    dreamNotes,
    recallMetrics,
    pingLedger,
    auditRows,
  ] = await Promise.all([
    db
      .delete(toolCache)
      .where(inArray(toolCache.cacheKey, expiredCache))
      .returning({ id: toolCache.cacheKey }),
    db.delete(memories).where(inArray(memories.id, expiredMemories)).returning({ id: memories.id }),
    releaseStaleReservations(db, 120, batch),
    // Phase 15: location pings are transient — purge past the retention window.
    purgeStaleLocations(db, loadConfig().LOCATION_RETENTION_DAYS, batch),
    // Phase 20: dream notes are kept 7 days for inspection, then purged.
    purgeStaleDreamNotes(db, batch),
    // Operational counters do not need the owner's long-term history policy.
    purgeStaleRecallMetrics(db, 90, batch),
    // The nudge-policy ledger is telemetry, not history — same 90 days.
    purgeStaleProactivePings(db, 90, batch),
    // Captured prompts and answers hold the owner's mail in the clear, so the
    // owner's own retention window governs them, not a fixed operational one.
    purgeStaleModelCallAudit(db, loadConfig().LLM_AUDIT_RETENTION_DAYS, batch),
  ]);
  return {
    cache: cacheRows.length,
    memories: memoryRows.length,
    reservations,
    locations,
    dreamNotes,
    recallMetrics,
    proactivePings: pingLedger,
    modelCallAudit: auditRows,
  };
}

export type { AgedHistoryCounts } from '@assistant/persistence';

/**
 * Age-based retention for the four tables that otherwise grow without bound:
 * messages, tool_calls, model_calls, and cost_events. Ships disabled — both
 * retention knobs default to 0 (keep forever) because pruning the owner's
 * history is their policy call, not the platform's. Batched so a first run
 * against years of backlog drains across sweeps instead of locking tables.
 *
 * What survives its cutoff, and why:
 * - messages anchored by a conversation segment — the segment summary is the
 *   recall unit and references its message range by id.
 * - tool_calls referenced by an approval (the owner's decision record) or by
 *   a still-retained cost event; those become eligible once the cost ledger's
 *   own retention passes.
 */
export async function purgeAgedHistory(
  store: Db | MaintenanceRepository,
  overrides?: { historyDays?: number; costDays?: number; batch?: number },
): Promise<AgedHistoryCounts> {
  const config = loadConfig();
  const historyDays = overrides?.historyDays ?? config.HISTORY_RETENTION_DAYS;
  const costDays = overrides?.costDays ?? config.COST_RETENTION_DAYS;
  const batch = overrides?.batch ?? 1000;
  if ('kind' in store && store.kind === 'maintenance-repository')
    return (store as MaintenanceRepository).purgeAgedHistory({ historyDays, costDays, batch });
  const db = store as Db;
  const counts: AgedHistoryCounts = { messages: 0, toolCalls: 0, modelCalls: 0, costEvents: 0 };

  // Cost first: deleting an aged cost event frees its tool_call for the
  // history pass below within the same sweep.
  if (costDays > 0) {
    const costCutoff = sql`now() - make_interval(days => ${costDays})`;
    const agedCostEvents = db
      .select({ id: costEvents.id })
      .from(costEvents)
      .where(lte(costEvents.createdAt, costCutoff))
      .limit(batch);
    const deleted = await db
      .delete(costEvents)
      .where(inArray(costEvents.id, agedCostEvents))
      .returning({ id: costEvents.id });
    counts.costEvents = deleted.length;
  }

  if (historyDays > 0) {
    const cutoff = sql`now() - make_interval(days => ${historyDays})`;
    const agedMessages = db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          lte(messages.createdAt, cutoff),
          notExists(
            db
              .select({ one: sql`1` })
              .from(conversationSegments)
              .where(
                or(
                  eq(conversationSegments.startMessageId, messages.id),
                  eq(conversationSegments.endMessageId, messages.id),
                ),
              ),
          ),
        ),
      )
      .limit(batch);
    const agedToolCalls = db
      .select({ id: toolCalls.id })
      .from(toolCalls)
      .where(
        and(
          lte(toolCalls.createdAt, cutoff),
          inArray(toolCalls.status, ['succeeded', 'failed', 'denied']),
          // Execution receipts are not ordinary history. A parked or recently
          // settled task must retain its result/idempotency rows for recovery.
          sql`exists (
            select 1 from ${tasks} as retention_task
            where retention_task.id = ${toolCalls.taskId}
              and retention_task.status in ('done', 'failed', 'cancelled')
              and retention_task.updated_at <= ${cutoff}
              and jsonb_typeof(retention_task.state) = 'object'
              and (
                not (retention_task.state ? 'pendingFinal')
                or retention_task.state->'pendingFinal' = 'null'::jsonb
                or jsonb_typeof(retention_task.state->'pendingFinal') = 'object'
              )
              and (
                not (retention_task.state ? 'pendingJob')
                or retention_task.state->'pendingJob' = 'null'::jsonb
                or coalesce((
                  jsonb_typeof(retention_task.state->'pendingJob') = 'object'
                  and jsonb_typeof(retention_task.state->'pendingJob'->'dbToolCallId') = 'string'
                  and retention_task.state->'pendingJob'->>'dbToolCallId' <> ''
                  and retention_task.state->'pendingJob'->>'dbToolCallId' <> ${toolCalls.id}::text
                ), false)
              )
              and (
                not (retention_task.state ? 'pendingToolBatch')
                or retention_task.state->'pendingToolBatch' = 'null'::jsonb
                or coalesce((
                  jsonb_typeof(retention_task.state->'pendingToolBatch') = 'object'
                  and jsonb_typeof(retention_task.state->'pendingToolBatch'->'calls') = 'array'
                  and case
                    when jsonb_typeof(retention_task.state->'pendingToolBatch'->'calls') = 'array'
                    then jsonb_array_length(retention_task.state->'pendingToolBatch'->'calls') <= 1000
                    else false
                  end
                  and not exists (
                    select 1
                    from jsonb_array_elements(
                      case
                        when jsonb_typeof(retention_task.state->'pendingToolBatch'->'calls') = 'array'
                        then retention_task.state->'pendingToolBatch'->'calls'
                        else '[]'::jsonb
                      end
                    ) as checkpoint_call(value)
                    where jsonb_typeof(checkpoint_call.value) is distinct from 'object'
                      or checkpoint_call.value->>'status' is null
                      or checkpoint_call.value->>'status' not in ('queued', 'awaiting_approval', 'budget', 'job', 'settled')
                      or (
                        checkpoint_call.value ? 'dbToolCallId'
                        and (
                          jsonb_typeof(checkpoint_call.value->'dbToolCallId') is distinct from 'string'
                          or checkpoint_call.value->>'dbToolCallId' = ''
                        )
                      )
                  )
                  and not exists (
                    select 1
                    from jsonb_array_elements(
                      case
                        when jsonb_typeof(retention_task.state->'pendingToolBatch'->'calls') = 'array'
                        then retention_task.state->'pendingToolBatch'->'calls'
                        else '[]'::jsonb
                      end
                    ) as checkpoint_call(value)
                    where checkpoint_call.value->>'status' <> 'settled'
                      and checkpoint_call.value->>'dbToolCallId' = ${toolCalls.id}::text
                  )
                ), false)
              )
          )`,
          sql`not exists (
            with recursive receipt_dependents as (
              select id, parent_task_id, agent_id, status, updated_at, state from ${tasks} where parent_task_id = ${toolCalls.taskId}
              union
              select child.id, child.parent_task_id, child.agent_id, child.status, child.updated_at, child.state from ${tasks} as child
              join receipt_dependents as parent on child.parent_task_id = parent.id
            )
            select 1 from receipt_dependents
            where agent_id is distinct from (
                select root_task.agent_id from ${tasks} as root_task where root_task.id = ${toolCalls.taskId}
              )
              or status not in ('done', 'failed', 'cancelled')
              or updated_at > ${cutoff}
              or jsonb_typeof(state) is distinct from 'object'
              or (
                state ? 'pendingFinal'
                and state->'pendingFinal' <> 'null'::jsonb
                and jsonb_typeof(state->'pendingFinal') is distinct from 'object'
              )
              or (
                state ? 'pendingJob'
                and state->'pendingJob' <> 'null'::jsonb
                and not coalesce((
                  jsonb_typeof(state->'pendingJob') = 'object'
                  and jsonb_typeof(state->'pendingJob'->'dbToolCallId') = 'string'
                  and state->'pendingJob'->>'dbToolCallId' <> ''
                  and state->'pendingJob'->>'dbToolCallId' <> ${toolCalls.id}::text
                ), false)
              )
              or (
                state ? 'pendingToolBatch'
                and state->'pendingToolBatch' <> 'null'::jsonb
                and not coalesce((
                  jsonb_typeof(state->'pendingToolBatch') = 'object'
                  and jsonb_typeof(state->'pendingToolBatch'->'calls') = 'array'
                  and case
                    when jsonb_typeof(state->'pendingToolBatch'->'calls') = 'array'
                    then jsonb_array_length(state->'pendingToolBatch'->'calls') <= 1000
                    else false
                  end
                  and not exists (
                    select 1
                    from jsonb_array_elements(
                      case
                        when jsonb_typeof(state->'pendingToolBatch'->'calls') = 'array'
                        then state->'pendingToolBatch'->'calls'
                        else '[]'::jsonb
                      end
                    ) as checkpoint_call(value)
                    where jsonb_typeof(checkpoint_call.value) is distinct from 'object'
                      or checkpoint_call.value->>'status' is null
                      or checkpoint_call.value->>'status' not in ('queued', 'awaiting_approval', 'budget', 'job', 'settled')
                      or (
                        checkpoint_call.value ? 'dbToolCallId'
                        and (
                          jsonb_typeof(checkpoint_call.value->'dbToolCallId') is distinct from 'string'
                          or checkpoint_call.value->>'dbToolCallId' = ''
                        )
                      )
                  )
                  and not exists (
                    select 1
                    from jsonb_array_elements(
                      case
                        when jsonb_typeof(state->'pendingToolBatch'->'calls') = 'array'
                        then state->'pendingToolBatch'->'calls'
                        else '[]'::jsonb
                      end
                    ) as checkpoint_call(value)
                    where checkpoint_call.value->>'status' <> 'settled'
                      and checkpoint_call.value->>'dbToolCallId' = ${toolCalls.id}::text
                  )
                ), false)
              )
          )`,
          notExists(
            db
              .select({ one: sql`1` })
              .from(approvals)
              .where(eq(approvals.toolCallId, toolCalls.id)),
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(costEvents)
              .where(eq(costEvents.toolCallId, toolCalls.id)),
          ),
        ),
      )
      .limit(batch);
    const agedToolCallCandidates = await db
      .select({ id: toolCalls.id, taskId: tasks.id, agentId: tasks.agentId })
      .from(toolCalls)
      .innerJoin(tasks, eq(tasks.id, toolCalls.taskId))
      .where(inArray(toolCalls.id, agedToolCalls))
      .limit(batch);
    let compactedToolCalls = 0;
    const receiptRecordedAt = new Date();
    for (const candidate of agedToolCallCandidates) {
      const compacted = await db.transaction(async (tx) => {
        // Owner erasure serializes before the task/call locks and invalidates this writer.
        await lockPostgresPrivacyObservationFence(tx as unknown as Db, candidate.agentId);
        const [task] = await tx
          .select({ id: tasks.id, agentId: tasks.agentId })
          .from(tasks)
          .where(and(eq(tasks.id, candidate.taskId), eq(tasks.agentId, candidate.agentId)))
          .for('update')
          .limit(1);
        if (!task) return 0;
        const [current] = await tx
          .select({ toolCall: toolCalls, taskAgentId: tasks.agentId })
          .from(toolCalls)
          .innerJoin(tasks, eq(tasks.id, toolCalls.taskId))
          .where(and(eq(toolCalls.id, candidate.id), eq(tasks.agentId, candidate.agentId)))
          .for('update')
          .limit(1);
        if (!current || current.taskAgentId !== candidate.agentId) return 0;
        const [stillEligible] = await tx
          .select({ id: toolCalls.id })
          .from(toolCalls)
          .where(and(eq(toolCalls.id, candidate.id), inArray(toolCalls.id, agedToolCalls)))
          .limit(1);
        if (!stillEligible) return 0;
        const receipt = compactToolCallReceipt(current.toolCall, {
          agentId: candidate.agentId,
          recordedAt: receiptRecordedAt,
        });
        if (!receipt) return 0;
        const keys = toolCallReceiptKeysForReceipt(receipt);
        await lockPostgresToolCallReceiptKeys(tx as unknown as Db, keys);
        for (const key of keys) {
          const [existing] = await tx
            .select()
            .from(toolCallReceiptKeys)
            .where(eq(toolCallReceiptKeys.id, key.id))
            .limit(1);
          if (
            existing &&
            (existing.agentId !== key.agentId ||
              existing.taskId !== key.taskId ||
              existing.receiptId !== key.receiptId ||
              existing.kind !== key.kind ||
              existing.digest !== key.digest)
          )
            return 0;
        }
        await tx.insert(toolCallReceipts).values(receipt).onConflictDoNothing();
        const [savedReceipt] = await tx
          .select()
          .from(toolCallReceipts)
          .where(eq(toolCallReceipts.id, receipt.id))
          .limit(1);
        if (
          !savedReceipt ||
          savedReceipt.agentId !== receipt.agentId ||
          savedReceipt.taskId !== receipt.taskId ||
          savedReceipt.toolCallId !== receipt.toolCallId ||
          savedReceipt.modelToolCallIdHash !== receipt.modelToolCallIdHash ||
          savedReceipt.idempotencyKeyHash !== receipt.idempotencyKeyHash ||
          savedReceipt.toolName !== receipt.toolName ||
          savedReceipt.effectOutcome !== receipt.effectOutcome
        )
          return 0;
        if (keys.length) await tx.insert(toolCallReceiptKeys).values(keys).onConflictDoNothing();
        for (const key of keys) {
          const [savedKey] = await tx
            .select()
            .from(toolCallReceiptKeys)
            .where(eq(toolCallReceiptKeys.id, key.id))
            .limit(1);
          if (
            !savedKey ||
            savedKey.agentId !== key.agentId ||
            savedKey.taskId !== key.taskId ||
            savedKey.receiptId !== key.receiptId ||
            savedKey.kind !== key.kind ||
            savedKey.digest !== key.digest
          )
            return 0;
        }
        const deleted = await tx
          .delete(toolCalls)
          .where(and(eq(toolCalls.id, current.toolCall.id), eq(toolCalls.taskId, receipt.taskId)))
          .returning({ id: toolCalls.id });
        return deleted.length === 1 ? 1 : 0;
      });
      compactedToolCalls += compacted;
    }
    const agedModelCalls = db
      .select({ id: modelCalls.id })
      .from(modelCalls)
      .where(lte(modelCalls.createdAt, cutoff))
      .limit(batch);
    const [deletedMessages, deletedModelCalls] = await Promise.all([
      db.delete(messages).where(inArray(messages.id, agedMessages)).returning({ id: messages.id }),
      db
        .delete(modelCalls)
        .where(inArray(modelCalls.id, agedModelCalls))
        .returning({ id: modelCalls.id }),
    ]);
    counts.messages = deletedMessages.length;
    counts.toolCalls = compactedToolCalls;
    counts.modelCalls = deletedModelCalls.length;
  }

  return counts;
}
