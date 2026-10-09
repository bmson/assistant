import { randomInt } from 'node:crypto';
import type {
  ApprovalInbox,
  ApprovalInboxQuery,
  ApprovalNoticeGroup,
  ApprovalNoticeQuery,
  ApprovalRepository,
  ApprovalResolution,
  ApprovalWake,
  CreateApprovalInput,
  CreatedApproval,
  RememberableApproval,
  ResolveApprovalInput,
} from '@assistant/persistence';
import {
  approvalInboxLimit,
  approvalIsResolved,
  approvalSweepBatch,
  parkedApprovalIds,
} from '@assistant/persistence';
import { and, asc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { approvalPolicies, approvals, maintenanceCursors, tasks, toolCalls } from './schema.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_SUFFIX_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function validateApprovalTime(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error('Invalid approval time');
}

function approvalNoticeAgeMinutes(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 365 * 24 * 60)
    throw new Error('Invalid approval notice age');
  return value;
}

function randomCodeSuffix(): string {
  const pick = () => CODE_SUFFIX_ALPHABET.charAt(randomInt(CODE_SUFFIX_ALPHABET.length));
  return pick() + pick();
}

async function nextShortCode(db: Db): Promise<string> {
  const [row] = await db
    .select({
      next: sql<number>`coalesce(max(substring(${approvals.shortCode} from '^A([0-9]+)')::bigint), 0) + 1`,
    })
    .from(approvals);
  const next = Number(row?.next ?? 1);
  if (!Number.isSafeInteger(next) || next < 1)
    throw new Error('Invalid approval short code sequence');
  return `A${next}${randomCodeSuffix()}`;
}

function validateInboxTime(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error('Invalid approval inbox time');
}

export async function listApprovalInbox(
  db: Db,
  agentId: string,
  options: ApprovalInboxQuery = {},
): Promise<ApprovalInbox> {
  const recentLimit = approvalInboxLimit(options.recentLimit);
  const now = options.now ?? new Date();
  validateInboxTime(now);
  const [pending, resolved] = await Promise.all([
    db
      .select({
        approval: approvals,
        taskType: tasks.type,
        taskTrust: tasks.trust,
        toolName: toolCalls.toolName,
        decision: toolCalls.decision,
      })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
      .where(
        and(
          eq(tasks.agentId, agentId),
          eq(toolCalls.taskId, approvals.taskId),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, now),
        ),
      )
      .orderBy(asc(approvals.requestedAt), asc(approvals.id))
      .limit(50),
    db
      .select({
        id: approvals.id,
        taskId: approvals.taskId,
        shortCode: approvals.shortCode,
        summary: approvals.summary,
        status: approvals.status,
        requestedAt: approvals.requestedAt,
        resolvedAt: approvals.resolvedAt,
        resolvedVia: approvals.resolvedVia,
        expiresAt: approvals.expiresAt,
        edited: sql<boolean>`${approvals.resolutionPayload} IS NOT NULL`,
        taskType: tasks.type,
      })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .where(
        and(
          eq(tasks.agentId, agentId),
          or(
            inArray(approvals.status, ['approved', 'denied', 'expired']),
            and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, now)),
          ),
        ),
      )
      .orderBy(
        sql`coalesce(${approvals.resolvedAt}, ${approvals.expiresAt}) DESC`,
        sql`${approvals.id} DESC`,
      )
      .limit(recentLimit),
  ]);
  return {
    pending,
    resolved: resolved.map(({ taskType, ...approval }) => ({ approval, taskType })),
  };
}

export async function getRememberableApproval(
  db: Db,
  agentId: string,
  approvalId: string,
): Promise<RememberableApproval | null> {
  const [row] = await db
    .select({ approval: approvals, toolName: toolCalls.toolName })
    .from(approvals)
    .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
    .innerJoin(tasks, eq(approvals.taskId, tasks.id))
    .where(
      and(
        eq(approvals.id, approvalId),
        eq(approvals.status, 'pending'),
        gt(approvals.expiresAt, sql`clock_timestamp()`),
        eq(tasks.agentId, agentId),
        eq(toolCalls.taskId, approvals.taskId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Atomically create the approval, its gated tool call, and their link. */
export async function createApproval(db: Db, input: CreateApprovalInput): Promise<CreatedApproval> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('assistant:approval-codes'))`);
    const shortCode = await nextShortCode(tx as unknown as Db);
    const [toolCall] = await tx
      .insert(toolCalls)
      .values({
        taskId: input.taskId,
        step: input.step,
        toolName: input.toolName,
        args: input.args,
        risk: 'approval',
        status: 'awaiting_approval',
        decision: input.decision,
      })
      .returning({ id: toolCalls.id });
    if (!toolCall) throw new Error('failed to insert tool_call');

    const [approval] = await tx
      .insert(approvals)
      .values({
        taskId: input.taskId,
        toolCallId: toolCall.id,
        shortCode,
        summary: input.summary,
        payload: input.args,
        expiresAt: sql`now() + interval '24 hours'`,
      })
      .returning({ id: approvals.id, summary: approvals.summary, shortCode: approvals.shortCode });
    if (!approval) throw new Error('failed to insert approval');

    const [linked] = await tx
      .update(toolCalls)
      .set({ approvalId: approval.id })
      .where(eq(toolCalls.id, toolCall.id))
      .returning({ id: toolCalls.id });
    if (!linked) throw new Error('failed to link approval');

    return {
      toolCallId: toolCall.id,
      approvalId: approval.id,
      shortCode: approval.shortCode,
      summary: approval.summary,
    };
  });
}

/** Find old pending approvals missing their conversation delivery leg. */
export async function listStalledNotices(
  db: Db,
  options: ApprovalNoticeQuery = {},
): Promise<ApprovalNoticeGroup[]> {
  const limit = approvalSweepBatch(options.batch ?? 50);
  const olderThanMinutes = approvalNoticeAgeMinutes(options.olderThanMinutes ?? 5);
  const now = options.now ?? new Date();
  validateApprovalTime(now);
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000);
  const rows = await db
    .select({ approval: approvals, task: tasks, toolName: toolCalls.toolName })
    .from(approvals)
    .innerJoin(tasks, eq(approvals.taskId, tasks.id))
    .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
    .where(
      and(
        eq(approvals.status, 'pending'),
        sql`NOT ('conversation' = ANY(${approvals.notifiedChannels}))`,
        lte(approvals.requestedAt, cutoff),
        eq(tasks.status, 'waiting_approval'),
      ),
    )
    .orderBy(asc(approvals.requestedAt), asc(approvals.id))
    .limit(limit);

  const byTask = new Map<string, ApprovalNoticeGroup>();
  for (const row of rows) {
    const group = byTask.get(row.task.id) ?? { task: row.task, notices: [] };
    group.notices.push({ ...row.approval, toolName: row.toolName });
    byTask.set(row.task.id, group);
  }
  return [...byTask.values()];
}

/** Atomically union successful notification channels without dropping prior legs. */
export async function markApprovalNotified(
  db: Db,
  approvalIds: string[],
  channels: string[],
): Promise<void> {
  if (approvalIds.length === 0 || channels.length === 0) return;
  const uniqueChannels = [...new Set(channels)];
  const requested = sql`ARRAY[${sql.join(
    uniqueChannels.map((channel) => sql`${channel}`),
    sql`, `,
  )}]::text[]`;
  await db
    .update(approvals)
    .set({
      notifiedChannels: sql`(
        SELECT array_agg(
          value
          ORDER BY CASE value WHEN 'owner' THEN 0 WHEN 'conversation' THEN 1 ELSE 2 END, first_ord
        )
        FROM (
          SELECT value, min(ord) AS first_ord
          FROM unnest(${approvals.notifiedChannels} || ${requested}) WITH ORDINALITY AS item(value, ord)
          GROUP BY value
        ) AS merged
      )`,
    })
    .where(and(inArray(approvals.id, approvalIds), eq(approvals.status, 'pending')));
}

export async function resolveApproval(
  db: Db,
  input: ResolveApprovalInput,
): Promise<ApprovalResolution> {
  if (!input.approvalId && !input.shortCode) {
    return { ok: false, reason: 'approvalId or shortCode required' };
  }

  const resolution = await db.transaction(async (tx) => {
    if (input.policy && input.via === 'web') {
      await lockPostgresPrivacyObservationFence(tx as unknown as Db, input.policy.agentId);
    }
    const candidates = input.approvalId
      ? await tx
          .select({ id: approvals.id, taskId: approvals.taskId, toolCallId: approvals.toolCallId })
          .from(approvals)
          .where(eq(approvals.id, input.approvalId))
          .limit(1)
      : await tx
          .select({ id: approvals.id, taskId: approvals.taskId, toolCallId: approvals.toolCallId })
          .from(approvals)
          .where(
            and(
              eq(approvals.shortCode, input.shortCode as string),
              eq(approvals.status, 'pending'),
            ),
          )
          .limit(2);
    if (!input.approvalId && candidates.length > 1) return { ambiguous: true as const };
    const candidate = candidates[0];
    if (!candidate) return null;

    // Match task lifecycle and tool-claim paths: task lock first, then the
    // approval row. The initial lookup only discovers the task ID; all mutable
    // approval fields are re-read after both locks are held.
    const [task] = await tx
      .select({ id: tasks.id, agentId: tasks.agentId })
      .from(tasks)
      .where(eq(tasks.id, candidate.taskId))
      .for('update');
    if (!task) return null;

    const [pending] = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.id, candidate.id),
          eq(approvals.taskId, task.id),
          eq(approvals.toolCallId, candidate.toolCallId),
          eq(approvals.status, 'pending'),
        ),
      )
      .for('update');
    if (!pending) return null;

    // transaction_timestamp()/now() can be older than a deadline reached while
    // waiting for the task or approval lock. Use the strict wall-clock predicate
    // in the update below, after both rows are locked, as the authoritative test.
    if (!(pending.expiresAt instanceof Date) || !Number.isFinite(pending.expiresAt.getTime()))
      return null;

    if (input.policy && input.via === 'web') {
      const [linked] = await tx
        .select({ toolName: toolCalls.toolName })
        .from(toolCalls)
        .where(and(eq(toolCalls.id, pending.toolCallId), eq(toolCalls.taskId, task.id)))
        .limit(1);
      if (
        !linked ||
        input.policy.agentId !== task.agentId ||
        input.policy.toolName !== linked.toolName
      ) {
        throw new Error('Approval policy must match the task owner and tool');
      }
    }

    const [resolved] = await tx
      .update(approvals)
      .set({
        status: input.decision,
        resolvedAt: sql`clock_timestamp()`,
        resolvedVia: input.via,
        resolutionPayload: input.editedPayload ?? null,
      })
      .where(
        and(
          eq(approvals.id, pending.id),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning();
    if (!resolved) return null;

    await tx
      .update(toolCalls)
      .set({ status: input.decision })
      .where(eq(toolCalls.id, resolved.toolCallId));

    if (input.policy && input.via === 'web') {
      const [policy] = await tx
        .insert(approvalPolicies)
        .values({ ...input.policy, createdVia: 'approval_dialog' })
        .onConflictDoUpdate({
          target: [
            approvalPolicies.agentId,
            approvalPolicies.toolName,
            approvalPolicies.templateKey,
            approvalPolicies.match,
            approvalPolicies.effect,
          ],
          // Repeating Always/Never is also an explicit request to reactivate a
          // matching rule that was paused in Settings.
          set: { enabled: true, updatedAt: sql`clock_timestamp()` },
        })
        .returning();
      if (policy) {
        await tx
          .update(approvals)
          .set({ createdPolicyId: policy.id })
          .where(eq(approvals.id, resolved.id));
      }
    }

    // The task row is already locked. Only a task still parked on approval may
    // be woken; a late answer never resurrects a cancelled or completed task.
    const [woken] = await tx
      .update(tasks)
      .set({
        status: 'pending',
        runAfter: null,
        lockedUntil: null,
        queueGeneration: sql`${tasks.queueGeneration} + 1`,
        attempt: 0,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(eq(tasks.id, resolved.taskId), eq(tasks.status, 'waiting_approval')))
      .returning({ id: tasks.id, queueGeneration: tasks.queueGeneration });

    return { resolved, woken };
  });

  if (resolution && 'ambiguous' in resolution) {
    return { ok: false, reason: 'ambiguous approval code; use the approval ID' };
  }
  if (!resolution) {
    return { ok: false, reason: 'no pending approval matched (already resolved or expired?)' };
  }
  const { resolved, woken } = resolution;
  return {
    ok: true,
    taskId: resolved.taskId,
    toolCallId: resolved.toolCallId,
    approvalId: resolved.id,
    ...(woken ? { wake: { taskId: woken.id, generation: woken.queueGeneration } } : {}),
  };
}

/** Expire a bounded page of pending approvals and wake each parked task once. */
export async function expireStaleApprovals(
  db: Db,
  batch = 200,
  now = new Date(),
): Promise<ApprovalWake[]> {
  const limit = approvalSweepBatch(batch);
  validateApprovalTime(now);
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: approvals.id, taskId: approvals.taskId, toolCallId: approvals.toolCallId })
      .from(approvals)
      .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, now)))
      .orderBy(asc(approvals.expiresAt), asc(approvals.id))
      .limit(limit);
    if (candidates.length === 0) return [];

    // Keep every approval mutation on the same task→approval lock order as an
    // answer decision. Lock tasks in stable order before touching approval rows.
    const taskIds = [...new Set(candidates.map((row) => row.taskId))].sort();
    await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.id, taskIds))
      .orderBy(asc(tasks.id))
      .for('update');

    const candidateIds = candidates.map((row) => row.id);
    const expired = await tx
      .update(approvals)
      .set({ status: 'expired', resolvedAt: now })
      .where(
        and(
          inArray(approvals.id, candidateIds),
          eq(approvals.status, 'pending'),
          lte(approvals.expiresAt, now),
        ),
      )
      .returning({ id: approvals.id, taskId: approvals.taskId, toolCallId: approvals.toolCallId });
    if (expired.length === 0) return [];

    await tx
      .update(toolCalls)
      .set({ status: 'denied', error: 'approval expired' })
      .where(
        inArray(
          toolCalls.id,
          expired.map((approval) => approval.toolCallId),
        ),
      );

    const expiredTaskIds = [...new Set(expired.map((approval) => approval.taskId))];
    return tx
      .update(tasks)
      .set({
        status: 'pending',
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: sql`${tasks.queueGeneration} + 1`,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: now,
      })
      .where(and(inArray(tasks.id, expiredTaskIds), eq(tasks.status, 'waiting_approval')))
      .returning({ taskId: tasks.id, generation: tasks.queueGeneration });
  });
}

/** Wake parked tasks whose complete approval checkpoint has reached a terminal state. */
export async function resumeResolvedApprovals(
  db: Db,
  batch = 200,
  now = new Date(),
): Promise<ApprovalWake[]> {
  const limit = approvalSweepBatch(batch);
  validateApprovalTime(now);
  const candidates = await db.transaction(async (tx) => {
    await tx
      .insert(maintenanceCursors)
      .values({ name: 'approval-recovery', cursor: null })
      .onConflictDoNothing({ target: maintenanceCursors.name });
    const [cursor] = await tx
      .select()
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, 'approval-recovery'))
      .for('update');
    if (!cursor) throw new Error('Missing approval recovery cursor');

    let page = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, 'waiting_approval'),
          cursor.cursor ? gt(tasks.id, cursor.cursor) : undefined,
        ),
      )
      .orderBy(asc(tasks.id))
      .limit(limit);
    // A deleted task can leave the durable cursor beyond every remaining ID.
    // Wrap in this same allocation transaction so a cycle still makes
    // progress instead of spending one full invocation on an empty page.
    if (page.length === 0 && cursor.cursor !== null) {
      page = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.status, 'waiting_approval'))
        .orderBy(asc(tasks.id))
        .limit(limit);
    }
    const lastId = page.at(-1)?.id ?? null;
    await tx
      .update(maintenanceCursors)
      .set({ cursor: page.length === limit ? lastId : null, updatedAt: now })
      .where(eq(maintenanceCursors.name, 'approval-recovery'));
    return page;
  });

  const wakes: ApprovalWake[] = [];
  for (const candidate of candidates) {
    const wake = await db.transaction(async (tx) => {
      // Resolution and expiry both lock task before approval. This recovery
      // reader keeps that order by checking approval rows without row locks.
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, candidate.id)).for('update');
      if (task?.status !== 'waiting_approval') return null;
      const ids = parkedApprovalIds(task.state);
      if (!ids || ids.some((id) => !UUID_PATTERN.test(id))) return null;

      const rows = await tx
        .select({ id: approvals.id, taskId: approvals.taskId, status: approvals.status })
        .from(approvals)
        .where(inArray(approvals.id, ids));
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (
        rows.length !== ids.length ||
        ids.some((id) => {
          const approval = byId.get(id);
          return !approval || approval.taskId !== task.id || !approvalIsResolved(approval.status);
        })
      )
        return null;

      const [updated] = await tx
        .update(tasks)
        .set({
          status: 'pending',
          runAfter: null,
          lockedUntil: null,
          leaseToken: null,
          queueGeneration: sql`${tasks.queueGeneration} + 1`,
          attempt: 0,
          attentionNotifiedAt: null,
          updatedAt: now,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'waiting_approval')))
        .returning({ taskId: tasks.id, generation: tasks.queueGeneration });
      return updated ?? null;
    });
    if (wake) wakes.push(wake);
  }
  return wakes;
}

export function createPostgresApprovalRepository(db: Db): ApprovalRepository {
  return {
    kind: 'approval-repository',
    create: (input) => createApproval(db, input),
    getRememberable: (agentId, approvalId) => getRememberableApproval(db, agentId, approvalId),
    listInbox: (agentId, options) => listApprovalInbox(db, agentId, options),
    listStalledNotices: (options) => listStalledNotices(db, options),
    markNotified: (approvalIds, channels) => markApprovalNotified(db, approvalIds, channels),
    resolve: (input) => resolveApproval(db, input),
    expireStale: (batch, now) => expireStaleApprovals(db, batch, now),
    resumeResolved: (batch, now) => resumeResolvedApprovals(db, batch, now),
  };
}
