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
  OwnerCallGrantOperationRepository,
  OwnerCallNumberGrantReview,
  OwnerCallOperationBinding,
  OwnerCallOperationRegisterInput,
  RememberableApproval,
  ResolveApprovalInput,
} from '@assistant/persistence';
import {
  approvalInboxLimit,
  approvalIsResolved,
  approvalSweepBatch,
  MAX_APPROVAL_POLICY_SNAPSHOT_ROWS,
  parkedApprovalIds,
  parsePhoneCallOwnerActionGrantMatch,
  parsePhoneCallOwnerActionIntent,
  parsePhoneCallToOwnerNumberGrantMatch,
  phoneCallOwnerActionGrantIsLive,
  phoneCallOwnerActionGrantMatches,
  phoneCallOwnerActionGrantScopeFingerprint,
  phoneCallOwnerNumberGrantFinalizationMatches,
  phoneCallOwnerNumberReviewSourceFingerprint,
  phoneCallToOwnerNumberGrantIsLive,
} from '@assistant/persistence';
import { and, asc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  admitOwnerCallGrantOperation,
  closeOwnerCallGrantOperation,
  commitOwnerCallGrantOperationInTransaction,
  discoverOwnerCallGrantOperationInTransaction,
  lockOwnerCallGrantOperationForFinalize,
  OwnerCallGrantOperationRollbackError,
  registerOwnerCallGrantOperation,
} from './owner-call-operation-repository.js';
import { readPostgresOwnerCallRequest } from './owner-call-request.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import {
  agents,
  approvalPolicies,
  approvals,
  maintenanceCursors,
  tasks,
  toolCalls,
} from './schema.js';

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
        reviewSourceArgs: toolCalls.args,
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
        toolName: toolCalls.toolName,
      })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .innerJoin(
        toolCalls,
        and(eq(toolCalls.id, approvals.toolCallId), eq(toolCalls.taskId, approvals.taskId)),
      )
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
    pending: await Promise.all(
      pending.map(async ({ reviewSourceArgs, ...item }) => ({
        ...item,
        ownerCallAdmissionAvailable:
          item.toolName === 'phone.call' &&
          Boolean(
            await readPostgresOwnerCallRequest(
              db,
              agentId,
              item.approval.taskId,
              'waiting_approval',
            ),
          ),
        ownerCallSourceFingerprint: phoneCallOwnerNumberReviewSourceFingerprint({
          args: reviewSourceArgs,
          payload: item.approval.payload,
          trust: item.taskTrust,
          toolName: item.toolName,
        }),
      })),
    ),
    resolved: resolved.map(({ taskType, toolName, ...approval }) => ({
      approval,
      taskType,
      ...(typeof toolName === 'string' ? { toolName } : {}),
    })),
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

export async function getOwnerCallNumberGrantReview(
  db: Db,
  agentId: string,
  approvalId: string,
): Promise<OwnerCallNumberGrantReview | null> {
  const [row] = await db
    .select({
      approval: approvals,
      toolCall: {
        id: toolCalls.id,
        taskId: toolCalls.taskId,
        toolName: toolCalls.toolName,
        args: toolCalls.args,
        status: toolCalls.status,
      },
      task: {
        id: tasks.id,
        agentId: tasks.agentId,
        trust: tasks.trust,
        status: tasks.status,
        trigger: tasks.trigger,
      },
      ownerTimeZone: agents.timezone,
    })
    .from(approvals)
    .innerJoin(tasks, eq(approvals.taskId, tasks.id))
    .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
    .innerJoin(agents, eq(tasks.agentId, agents.id))
    .where(
      and(
        eq(approvals.id, approvalId),
        eq(approvals.status, 'pending'),
        gt(approvals.expiresAt, sql`clock_timestamp()`),
        eq(tasks.agentId, agentId),
        eq(tasks.trust, 'owner'),
        eq(tasks.status, 'waiting_approval'),
        eq(toolCalls.taskId, approvals.taskId),
        eq(toolCalls.toolName, 'phone.call'),
        eq(toolCalls.status, 'awaiting_approval'),
      ),
    )
    .limit(1);
  if (!row) return null;
  const directOwnerRequest = await readPostgresOwnerCallRequest(
    db,
    agentId,
    row.task.id,
    'waiting_approval',
  );
  if (!directOwnerRequest) return null;
  const policies = await db
    .select()
    .from(approvalPolicies)
    .where(and(eq(approvalPolicies.agentId, agentId), eq(approvalPolicies.toolName, 'phone.call')))
    .limit(MAX_APPROVAL_POLICY_SNAPSHOT_ROWS + 1);
  if (policies.length > MAX_APPROVAL_POLICY_SNAPSHOT_ROWS) return null;
  const [clock] = await db.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  const repositoryNow =
    clock?.now instanceof Date
      ? clock.now
      : typeof clock?.now === 'string'
        ? new Date(clock.now)
        : null;
  if (
    !repositoryNow ||
    !Number.isFinite(repositoryNow.getTime()) ||
    !(row.approval.expiresAt instanceof Date) ||
    !Number.isFinite(row.approval.expiresAt.getTime()) ||
    row.approval.expiresAt <= repositoryNow
  )
    return null;
  const recipient = (row.toolCall.args as { brief?: { to?: unknown } })?.brief?.to;
  const existingActiveGrants = policies.flatMap((policy) => {
    const match =
      policy.templateKey === 'phone.call.owner_action.v2'
        ? parsePhoneCallOwnerActionGrantMatch(policy.match)
        : parsePhoneCallToOwnerNumberGrantMatch(policy.match);
    return policy.enabled &&
      policy.effect === 'allow' &&
      ['phone.call.to_owner_number.v1', 'phone.call.owner_action.v2'].includes(
        policy.templateKey,
      ) &&
      match &&
      match.recipientE164 === recipient &&
      (policy.templateKey === 'phone.call.owner_action.v2'
        ? phoneCallOwnerActionGrantIsLive(match, repositoryNow)
        : phoneCallToOwnerNumberGrantIsLive(
            match as import('@assistant/persistence').PhoneCallToOwnerNumberGrantMatch,
            repositoryNow,
          ))
      ? [{ policyId: policy.id, match }]
      : [];
  });
  return { ...row, repositoryNow, existingActiveGrants, directOwnerRequest };
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
  const hasOwnerNumberGrantPolicy = input.policy?.templateKey === 'phone.call.to_owner_number.v1';
  const hasOwnerActionGrantPolicy = input.policy?.templateKey === 'phone.call.owner_action.v2';
  if (
    hasOwnerNumberGrantPolicy !== Boolean(input.ownerCallNumberGrant) ||
    (input.ownerCallNumberGrant &&
      (input.decision !== 'approved' ||
        input.via !== 'web' ||
        !input.expectedAgentId ||
        !input.approvalId ||
        input.ownerCallNumberGrant.expectedAgentId !== input.expectedAgentId ||
        input.ownerCallNumberGrant.expectedApprovalId !== input.approvalId ||
        input.editedPayload !== undefined))
  )
    return { ok: false, reason: 'owner call grant review is invalid or changed' };

  const actionBinding = input.ownerCallActionGrant;
  const actionGrant = actionBinding
    ? parsePhoneCallOwnerActionGrantMatch(actionBinding.match)
    : null;
  const actionScopeFingerprint = actionBinding
    ? phoneCallOwnerActionGrantScopeFingerprint(actionBinding.match)
    : null;
  const actionIssuedAt = actionBinding ? Date.parse(actionBinding.reviewIssuedAt) : NaN;
  const actionReviewExpiresAt = actionBinding ? Date.parse(actionBinding.reviewExpiresAt) : NaN;
  if (
    hasOwnerActionGrantPolicy !== Boolean(actionBinding) ||
    (actionBinding &&
      (Boolean(input.ownerCallNumberGrant) ||
        input.decision !== 'approved' ||
        input.via !== 'web' ||
        !input.expectedAgentId ||
        !input.approvalId ||
        input.shortCode !== undefined ||
        input.editedPayload !== undefined ||
        actionBinding.expectedAgentId !== input.expectedAgentId ||
        actionBinding.expectedApprovalId !== input.approvalId ||
        actionBinding.operation.ownerId !== actionBinding.expectedAgentId ||
        actionBinding.operation.approvalId !== actionBinding.expectedApprovalId ||
        actionBinding.operation.taskId !== actionBinding.expectedTaskId ||
        actionBinding.operation.toolCallId !== actionBinding.expectedToolCallId ||
        actionBinding.operation.grantId !== actionGrant?.grantId ||
        actionBinding.operation.requestFingerprint !== actionBinding.sourceArgsFingerprint ||
        actionBinding.operation.grantScopeFingerprint !== actionScopeFingerprint ||
        !actionGrant ||
        !actionScopeFingerprint ||
        !input.policy ||
        input.policy.agentId !== actionBinding.expectedAgentId ||
        input.policy.toolName !== 'phone.call' ||
        input.policy.templateKey !== 'phone.call.owner_action.v2' ||
        input.policy.effect !== 'allow' ||
        JSON.stringify(parsePhoneCallOwnerActionGrantMatch(input.policy.match)) !==
          JSON.stringify(actionGrant) ||
        !Number.isFinite(actionIssuedAt) ||
        !Number.isFinite(actionReviewExpiresAt) ||
        actionReviewExpiresAt !== actionIssuedAt + 10 * 60_000 ||
        ![1, 7, 30].includes(actionBinding.validityDays) ||
        Date.parse(actionGrant?.expiresAt ?? '') !==
          actionIssuedAt + actionBinding.validityDays * 24 * 60 * 60_000))
  )
    return { ok: false, reason: 'owner call grant review is invalid or changed' };

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

    const ownerCallOperationLock = actionBinding
      ? await lockOwnerCallGrantOperationForFinalize(tx as never, actionBinding.operation)
      : null;
    if (actionBinding) {
      if (!ownerCallOperationLock || !ownerCallOperationLock.ok) return null;
      if (
        ownerCallOperationLock.operation.phase !== 'admitted' ||
        ownerCallOperationLock.operation.grantId !== actionGrant?.grantId
      )
        return null;
    }

    // Match task lifecycle and tool-claim paths: task lock first, then the
    // approval row. The initial lookup only discovers the task ID; all mutable
    // approval fields are re-read after both locks are held.
    const [task] = await tx
      .select({
        id: tasks.id,
        agentId: tasks.agentId,
        trust: tasks.trust,
        status: tasks.status,
        trigger: tasks.trigger,
      })
      .from(tasks)
      .where(eq(tasks.id, candidate.taskId))
      .for('update');
    if (!task || (input.expectedAgentId && task.agentId !== input.expectedAgentId)) return null;

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

    if (input.ownerCallNumberGrant) {
      const [linked] = await tx
        .select({
          id: toolCalls.id,
          taskId: toolCalls.taskId,
          approvalId: toolCalls.approvalId,
          toolName: toolCalls.toolName,
          status: toolCalls.status,
          args: toolCalls.args,
        })
        .from(toolCalls)
        .where(and(eq(toolCalls.id, pending.toolCallId), eq(toolCalls.taskId, task.id)))
        .for('update')
        .limit(1);
      const grant = parsePhoneCallToOwnerNumberGrantMatch(input.ownerCallNumberGrant.match);
      if (
        !linked ||
        !grant ||
        !input.policy ||
        input.policy.agentId !== task.agentId ||
        input.policy.toolName !== 'phone.call' ||
        input.policy.templateKey !== 'phone.call.to_owner_number.v1' ||
        input.policy.effect !== 'allow' ||
        JSON.stringify(parsePhoneCallToOwnerNumberGrantMatch(input.policy.match)) !==
          JSON.stringify(grant)
      )
        return null;
      const directOwnerRequest = await readPostgresOwnerCallRequest(
        tx as unknown as Db,
        task.agentId,
        task.id,
        'waiting_approval',
        true,
      );
      const [clock] = await tx.execute<{ now: Date | string }>(
        sql`select clock_timestamp() as now`,
      );
      const ownerCallNumberGrantNow =
        clock?.now instanceof Date ? clock.now : new Date(clock?.now ?? NaN);
      if (!Number.isFinite(ownerCallNumberGrantNow.getTime())) return null;
      if (
        process.env.PHONE_CALL_TO_OWNER_GRANT_ENABLED !== 'true' ||
        !phoneCallOwnerNumberGrantFinalizationMatches(
          input.ownerCallNumberGrant,
          {
            approvalId: pending.id,
            approvalStatus: pending.status,
            approvalExpiresAt: pending.expiresAt,
            agentId: task.agentId,
            approvalTaskId: pending.taskId,
            approvalToolCallId: pending.toolCallId,
            taskId: task.id,
            taskAgentId: task.agentId,
            taskTrust: task.trust,
            taskStatus: task.status,
            toolCallId: linked.id,
            toolTaskId: linked.taskId,
            toolApprovalId: linked.approvalId,
            toolName: linked.toolName,
            toolStatus: linked.status,
            toolArgs: linked.args,
            approvalPayload: pending.payload,
            directOwnerRequest,
          },
          ownerCallNumberGrantNow,
        )
      )
        return null;
    }

    if (actionBinding && actionGrant) {
      const [linked] = await tx
        .select({
          id: toolCalls.id,
          taskId: toolCalls.taskId,
          approvalId: toolCalls.approvalId,
          toolName: toolCalls.toolName,
          status: toolCalls.status,
          args: toolCalls.args,
        })
        .from(toolCalls)
        .where(and(eq(toolCalls.id, pending.toolCallId), eq(toolCalls.taskId, task.id)))
        .for('update')
        .limit(1);
      const [owner] = await tx
        .select({ phoneE164: agents.phoneE164 })
        .from(agents)
        .where(eq(agents.id, task.agentId))
        .limit(1);
      const directOwnerRequest = await readPostgresOwnerCallRequest(
        tx as unknown as Db,
        task.agentId,
        task.id,
        'waiting_approval',
        true,
      );
      const [clock] = await tx.execute<{ now: Date | string }>(
        sql`select clock_timestamp() as now`,
      );
      const checkedAt = clock?.now instanceof Date ? clock.now : new Date(clock?.now ?? NaN);
      const args = linked?.args;
      const brief =
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as { brief?: { to?: unknown; maxMinutes?: unknown } }).brief
          : null;
      const intent = persistedOwnerActionIntent(task);
      const sourceFingerprint = linked
        ? phoneCallOwnerNumberReviewSourceFingerprint(linked.args)
        : null;
      const approvalFingerprint = phoneCallOwnerNumberReviewSourceFingerprint(pending.payload);
      const scopeFingerprint = phoneCallOwnerActionGrantScopeFingerprint(actionGrant);
      const recipientMatches =
        intent?.recipientRequest.kind === 'explicit_number'
          ? intent.recipientRequest.recipientE164 === actionGrant.recipientE164
          : intent?.recipientRequest.kind === 'owner_self' &&
            typeof owner?.phoneE164 === 'string' &&
            owner.phoneE164 === actionGrant.recipientE164;
      const legacyProjection = {
        schemaVersion: 1 as const,
        grantId: actionGrant.grantId,
        recipientE164: actionGrant.recipientE164,
        maxMinutes: actionGrant.maxMinutes,
        expiresAt: actionGrant.expiresAt,
      };
      const { match: _actionMatch, operation: _operation, ...legacyFields } = actionBinding;
      if (
        !linked ||
        !owner ||
        !directOwnerRequest ||
        !intent ||
        !brief ||
        !recipientMatches ||
        !scopeFingerprint ||
        scopeFingerprint !== actionBinding.operation.grantScopeFingerprint ||
        sourceFingerprint !== actionBinding.sourceArgsFingerprint ||
        approvalFingerprint !== actionBinding.sourceArgsFingerprint ||
        !phoneCallOwnerActionGrantMatches(actionGrant, brief) ||
        !phoneCallOwnerActionGrantIsLive(actionGrant, checkedAt) ||
        process.env.PHONE_CALL_TO_OWNER_GRANT_ENABLED !== 'true' ||
        !ownerCallOperationLock?.ok ||
        ownerCallOperationLock.operation.reviewExpiresAt.getTime() !== actionReviewExpiresAt ||
        ownerCallOperationLock.operation.grantExpiresAt.getTime() !==
          Date.parse(actionGrant.expiresAt) ||
        !phoneCallOwnerNumberGrantFinalizationMatches(
          { ...legacyFields, match: legacyProjection },
          {
            approvalId: pending.id,
            approvalStatus: pending.status,
            approvalExpiresAt: pending.expiresAt,
            agentId: task.agentId,
            approvalTaskId: pending.taskId,
            approvalToolCallId: pending.toolCallId,
            taskId: task.id,
            taskAgentId: task.agentId,
            taskTrust: task.trust,
            taskStatus: task.status,
            toolCallId: linked.id,
            toolTaskId: linked.taskId,
            toolApprovalId: linked.approvalId,
            toolName: linked.toolName,
            toolStatus: linked.status,
            toolArgs: linked.args,
            approvalPayload: pending.payload,
            directOwnerRequest,
          },
          checkedAt,
        )
      )
        return null;
    }

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
          ...(input.ownerCallNumberGrant
            ? [sql`${input.ownerCallNumberGrant.reviewExpiresAt}::timestamptz > clock_timestamp()`]
            : []),
          ...(input.ownerCallActionGrant
            ? [sql`${input.ownerCallActionGrant.reviewExpiresAt}::timestamptz > clock_timestamp()`]
            : []),
        ),
      )
      .returning();
    if (!resolved) return null;

    await tx
      .update(toolCalls)
      .set({ status: input.decision })
      .where(eq(toolCalls.id, resolved.toolCallId));

    let createdPolicyId: string | undefined;
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
        createdPolicyId = policy.id;
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

    if (actionBinding) {
      if (!createdPolicyId || !woken || !ownerCallOperationLock?.ok)
        throw new OwnerCallGrantOperationRollbackError('corrupt_or_unavailable');
      await commitOwnerCallGrantOperationInTransaction(tx as never, ownerCallOperationLock, {
        createdPolicyId,
        wakeGeneration: woken.queueGeneration,
      });
    }

    return { resolved, woken, createdPolicyId };
  });

  if (resolution && 'ambiguous' in resolution) {
    return { ok: false, reason: 'ambiguous approval code; use the approval ID' };
  }
  if (!resolution) {
    return { ok: false, reason: 'no pending approval matched (already resolved or expired?)' };
  }
  const { resolved, woken, createdPolicyId } = resolution;
  const savedCallGrant = input.ownerCallActionGrant?.match ?? input.ownerCallNumberGrant?.match;
  return {
    ok: true,
    taskId: resolved.taskId,
    toolCallId: resolved.toolCallId,
    approvalId: resolved.id,
    ...(savedCallGrant && createdPolicyId
      ? {
          ownerCallNumberGrant: {
            policyId: createdPolicyId,
            grantId: savedCallGrant.grantId,
            expiresAt: savedCallGrant.expiresAt,
          },
        }
      : {}),
    ...(woken ? { wake: { taskId: woken.id, generation: woken.queueGeneration } } : {}),
  };
}

function persistedOwnerActionIntent(task: { trigger?: unknown }) {
  const trigger = task.trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null;
  const payload = (trigger as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const text = (payload as { text?: unknown }).text;
  return typeof text === 'string' ? parsePhoneCallOwnerActionIntent(text) : null;
}

async function readOwnedOwnerCallOperationContext(
  tx: Db,
  ownerId: string,
  approvalId: string,
  taskId?: string,
  toolCallId?: string,
) {
  const conditions = [
    eq(approvals.id, approvalId),
    eq(tasks.agentId, ownerId),
    eq(toolCalls.taskId, approvals.taskId),
    eq(toolCalls.id, approvals.toolCallId),
    eq(toolCalls.approvalId, approvals.id),
  ];
  if (taskId) conditions.push(eq(tasks.id, taskId));
  if (toolCallId) conditions.push(eq(toolCalls.id, toolCallId));
  const [row] = await tx
    .select({ approval: approvals, task: tasks, tool: toolCalls })
    .from(approvals)
    .innerJoin(tasks, eq(tasks.id, approvals.taskId))
    .innerJoin(toolCalls, eq(toolCalls.id, approvals.toolCallId))
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}

async function validatePostgresOwnerCallOperationReview(
  tx: Db,
  binding: OwnerCallOperationBinding,
  repositoryNow: Date,
): Promise<boolean> {
  if (process.env.PHONE_CALL_TO_OWNER_GRANT_ENABLED !== 'true') return false;
  const [row] = await tx
    .select({ approval: approvals, task: tasks, tool: toolCalls, ownerPhone: agents.phoneE164 })
    .from(approvals)
    .innerJoin(tasks, eq(tasks.id, approvals.taskId))
    .innerJoin(toolCalls, eq(toolCalls.id, approvals.toolCallId))
    .innerJoin(agents, eq(agents.id, tasks.agentId))
    .where(
      and(
        eq(approvals.id, binding.approvalId),
        eq(approvals.taskId, binding.taskId),
        eq(approvals.toolCallId, binding.toolCallId),
        eq(approvals.status, 'pending'),
        eq(tasks.id, binding.taskId),
        eq(tasks.agentId, binding.ownerId),
        eq(tasks.status, 'waiting_approval'),
        eq(tasks.trust, 'owner'),
        eq(toolCalls.id, binding.toolCallId),
        eq(toolCalls.taskId, binding.taskId),
        eq(toolCalls.approvalId, binding.approvalId),
        eq(toolCalls.toolName, 'phone.call'),
        eq(toolCalls.status, 'awaiting_approval'),
      ),
    )
    .limit(1);
  if (
    !row ||
    !(row.approval.expiresAt instanceof Date) ||
    row.approval.expiresAt <= repositoryNow ||
    !(repositoryNow instanceof Date) ||
    !Number.isFinite(repositoryNow.getTime())
  )
    return false;
  const argsFingerprint = phoneCallOwnerNumberReviewSourceFingerprint(row.tool.args);
  if (
    !argsFingerprint ||
    argsFingerprint !== binding.requestFingerprint ||
    argsFingerprint !== phoneCallOwnerNumberReviewSourceFingerprint(row.approval.payload)
  )
    return false;
  const args = row.tool.args;
  const brief =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { brief?: { to?: unknown; maxMinutes?: unknown } }).brief
      : null;
  const intent = persistedOwnerActionIntent(row.task);
  if (
    !intent ||
    !brief ||
    !Number.isSafeInteger(brief.maxMinutes) ||
    (intent.recipientRequest.kind === 'explicit_number'
      ? brief.to !== intent.recipientRequest.recipientE164
      : !row.ownerPhone || brief.to !== row.ownerPhone)
  )
    return false;
  const currentRequest = await readPostgresOwnerCallRequest(
    tx,
    binding.ownerId,
    binding.taskId,
    'waiting_approval',
    true,
  );
  return Boolean(currentRequest);
}

async function postgresOwnerOperationBindingOwned(
  tx: Db,
  binding: OwnerCallOperationBinding,
): Promise<boolean> {
  const row = await readOwnedOwnerCallOperationContext(
    tx,
    binding.ownerId,
    binding.approvalId,
    binding.taskId,
    binding.toolCallId,
  );
  return Boolean(
    row &&
      row.approval.id === binding.approvalId &&
      row.approval.taskId === binding.taskId &&
      row.approval.toolCallId === binding.toolCallId &&
      row.task.id === binding.taskId &&
      row.task.agentId === binding.ownerId &&
      row.tool.id === binding.toolCallId &&
      row.tool.taskId === binding.taskId &&
      row.tool.approvalId === binding.approvalId,
  );
}

function createPostgresOwnerCallOperationsRepository(db: Db): OwnerCallGrantOperationRepository {
  return {
    discover: (ownerId, approvalId) =>
      db.transaction(async (tx) => {
        const scopedTx = tx as unknown as Db;
        const row = await readOwnedOwnerCallOperationContext(scopedTx, ownerId, approvalId);
        if (
          !row ||
          row.approval.id !== approvalId ||
          row.task.agentId !== ownerId ||
          row.tool.taskId !== row.task.id ||
          row.tool.approvalId !== row.approval.id
        )
          return { kind: 'unavailable' };
        return discoverOwnerCallGrantOperationInTransaction(scopedTx, ownerId, approvalId);
      }),
    register: async (input: OwnerCallOperationRegisterInput) => {
      const result = await registerOwnerCallGrantOperation(db, {
        ...input,
        validateCurrentCall: (tx, binding, now) =>
          validatePostgresOwnerCallOperationReview(tx as unknown as Db, binding, now),
      });
      return result.ok
        ? { ok: true, operation: result.operation }
        : { ok: false, reason: result.reason };
    },
    admit: async (binding: OwnerCallOperationBinding) => {
      const result = await admitOwnerCallGrantOperation(db, {
        ...binding,
        validateCurrentCall: (tx, current, now) =>
          validatePostgresOwnerCallOperationReview(tx as unknown as Db, current, now),
      });
      return result.ok
        ? { ok: true, operation: result.operation }
        : { ok: false, reason: result.reason };
    },
    close: async (binding: OwnerCallOperationBinding) => {
      const result = await closeOwnerCallGrantOperation(db, {
        ...binding,
        validateCloseAuthority: (tx, current) =>
          postgresOwnerOperationBindingOwned(tx as unknown as Db, current),
      });
      return result.ok
        ? { ok: true, operation: result.operation }
        : { ok: false, reason: result.reason };
    },
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
    ownerCallOperations: createPostgresOwnerCallOperationsRepository(db),
    create: (input) => createApproval(db, input),
    getRememberable: (agentId, approvalId) => getRememberableApproval(db, agentId, approvalId),
    getOwnerCallNumberGrantReview: (agentId, approvalId) =>
      getOwnerCallNumberGrantReview(db, agentId, approvalId),
    listInbox: (agentId, options) => listApprovalInbox(db, agentId, options),
    listStalledNotices: (options) => listStalledNotices(db, options),
    markNotified: (approvalIds, channels) => markApprovalNotified(db, approvalIds, channels),
    resolve: (input) => resolveApproval(db, input),
    expireStale: (batch, now) => expireStaleApprovals(db, batch, now),
    resumeResolved: (batch, now) => resumeResolvedApprovals(db, batch, now),
  };
}
