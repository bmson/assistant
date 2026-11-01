import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { CallBriefSchema, decryptStoredCredential, encryptStoredCredential } from '@assistant/core';
import { resolveApproval } from '@assistant/core/workflow/approvals';
import type {
  DirectOwnerCallRequestBinding,
  OwnerCallActionGrantMatch,
  OwnerCallNumberGrantReview,
  OwnerCallOperationBinding,
} from '@assistant/persistence';
import {
  parsePhoneCallOwnerActionGrantMatch,
  phoneCallOwnerActionGrantScopeFingerprint,
  phoneCallOwnerNumberReviewSourceFingerprint,
} from '@assistant/persistence';
import { z } from 'zod';
import { type ApprovalDecisionStore, ownerApprovalRepository } from './approvals.js';

export const OWNER_CALL_GRANT_ACKNOWLEDGEMENT = 'owner_call_action_and_limits_any_answerer_v2';
export const OWNER_CALL_GRANT_CLOSE_ACKNOWLEDGEMENT = 'close_this_permission_operation_only_v1';
export const OWNER_CALL_GRANT_VALIDITY_DAYS = [1, 7, 30] as const;
export const OWNER_CALL_GRANT_DEFAULT_VALIDITY_DAYS = 7;
const REVIEW_TTL_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const PURPOSE = 'phone.call.owner_action.review.v2';
const CLOSE_PURPOSE = 'owner-call-grant-close.v1';
const UNKNOWN =
  'The result is not confirmed. Check this permission operation before reviewing again.';
const CHANGED = 'This review expired or changed. Check the permission operation.';

export const OwnerCallGrantLimitsSchema = z
  .object({
    maxCallsPerHour: z.number().int().min(1).max(100),
    maxCallsPerDay: z.number().int().min(1).max(100),
    maxCostUsdMicrosPerCall: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxCostUsdMicrosPerDay: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(
    (v) =>
      v.maxCallsPerHour <= v.maxCallsPerDay &&
      v.maxCostUsdMicrosPerCall <= v.maxCostUsdMicrosPerDay,
  );
export type OwnerCallGrantLimits = z.infer<typeof OwnerCallGrantLimitsSchema>;
export const OWNER_CALL_GRANT_DEFAULT_LIMITS: OwnerCallGrantLimits = {
  maxCallsPerHour: 1,
  maxCallsPerDay: 3,
  maxCostUsdMicrosPerCall: 1_000_000,
  maxCostUsdMicrosPerDay: 3_000_000,
};
const OperationSchema = z
  .object({
    ownerId: z.string().min(1),
    approvalId: z.string().uuid(),
    grantId: z.string().uuid(),
    taskId: z.string().uuid(),
    toolCallId: z.string().uuid(),
    slotGeneration: z.number().int().positive(),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    grantScopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const DirectRequestSchema = z
  .object({
    recipientRequest: z
      .union([
        z
          .object({
            kind: z.literal('explicit_number'),
            recipientE164: z.string().regex(/^\+[1-9]\d{6,14}$/),
          })
          .strict(),
        z.object({ kind: z.literal('owner_self') }).strict(),
      ])
      .nullable(),
    agentId: z.string().min(1),
    taskId: z.string().min(1),
    conversationId: z.string().min(1),
    ownerMessageId: z.string().min(1),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    clientOperationId: z.string().uuid(),
    taskTriggerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    ownerMessageFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const ReviewTokenSchema = z
  .object({
    schemaVersion: z.literal(2),
    purpose: z.literal(PURPOSE),
    ownerId: z.string().min(1),
    approvalId: z.string().uuid(),
    taskId: z.string().uuid(),
    toolCallId: z.string().uuid(),
    taskTrust: z.literal('owner'),
    sourceArgsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    directOwnerRequest: DirectRequestSchema,
    issuedAt: z.iso.datetime(),
    reviewExpiresAt: z.iso.datetime(),
    validityDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
    grant: z.custom<OwnerCallActionGrantMatch>(
      (v) => parsePhoneCallOwnerActionGrantMatch(v) !== null,
    ),
    operation: OperationSchema,
  })
  .strict();
const CloseTokenSchema = z
  .object({
    purpose: z.literal(CLOSE_PURPOSE),
    operation: OperationSchema,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
type ReviewToken = z.infer<typeof ReviewTokenSchema>;
type Store = ApprovalDecisionStore;

function enabled(): boolean {
  return (
    loadConfig().PHONE_CALL_TO_OWNER_GRANT_ENABLED &&
    process.env.PHONE_CALL_TO_OWNER_GRANT_ENABLED === 'true'
  );
}
function validTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return value;
  } catch {
    return 'UTC';
  }
}
function currentBrief(review: OwnerCallNumberGrantReview) {
  const args = review.toolCall.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const parsed = CallBriefSchema.safeParse((args as { brief?: unknown }).brief);
  return parsed.success ? parsed.data : null;
}
function fingerprintReview(review: OwnerCallNumberGrantReview): string | null {
  const tool = phoneCallOwnerNumberReviewSourceFingerprint(review.toolCall.args);
  return tool && tool === phoneCallOwnerNumberReviewSourceFingerprint(review.approval.payload)
    ? tool
    : null;
}
function decodeReview(value: string, now: number): ReviewToken | null {
  if (value.length > 32_768 || !value.startsWith('v2.')) return null;
  const parsed = ReviewTokenSchema.safeParse(JSON.parse(decryptStoredCredential(value)));
  if (!parsed.success) return null;
  const t = parsed.data,
    issued = Date.parse(t.issuedAt),
    deadline = Date.parse(t.reviewExpiresAt);
  const scope = phoneCallOwnerActionGrantScopeFingerprint(t.grant);
  return issued <= now &&
    deadline > now &&
    deadline === issued + REVIEW_TTL_MS &&
    Date.parse(t.grant.expiresAt) === issued + t.validityDays * DAY_MS &&
    t.operation.ownerId === t.ownerId &&
    t.operation.approvalId === t.approvalId &&
    t.operation.taskId === t.taskId &&
    t.operation.toolCallId === t.toolCallId &&
    t.operation.grantId === t.grant.grantId &&
    t.operation.requestFingerprint === t.sourceArgsFingerprint &&
    t.operation.grantScopeFingerprint === scope
    ? t
    : null;
}
export type OwnerCallGrantPreviewResult =
  | {
      ok: true;
      reviewToken: string;
      approvalId: string;
      brief: ReturnType<typeof CallBriefSchema.parse>;
      grant: OwnerCallActionGrantMatch;
      validityDays: 1 | 7 | 30;
      reviewExpiresAt: string;
      ownerTimeZone: string;
      configuredMaxMinutes: number;
      existingActiveGrants: OwnerCallNumberGrantReview['existingActiveGrants'];
    }
  | { ok: false; reason: string };

/** Explicit review registers durable metadata before returning any mutation capability. */
export async function previewOwnerCallNumberGrant(
  store: Store,
  approvalId: string,
  validityDays: number,
  rawLimits: unknown = OWNER_CALL_GRANT_DEFAULT_LIMITS,
): Promise<OwnerCallGrantPreviewResult> {
  if (!enabled()) return { ok: false, reason: 'Reusable owner-number calls are disabled.' };
  const limits = OwnerCallGrantLimitsSchema.safeParse(rawLimits);
  if (
    !limits.success ||
    !(OWNER_CALL_GRANT_VALIDITY_DAYS as readonly number[]).includes(validityDays)
  )
    return { ok: false, reason: 'Choose supported permission limits and review again.' };
  try {
    const { agentId, approvals } = await ownerApprovalRepository(store);
    const operations = approvals.ownerCallOperations;
    if (!operations)
      return {
        ok: false,
        reason: 'Permission recovery is unavailable. Approve only this call instead.',
      };
    const state = await operations.discover(agentId, approvalId);
    if (
      state.kind === 'unavailable' ||
      (state.kind === 'current' && ['registered', 'admitted'].includes(state.operation.phase))
    )
      return { ok: false, reason: UNKNOWN };
    const review = await approvals.getOwnerCallNumberGrantReview?.(agentId, approvalId);
    if (
      review?.task.trust !== 'owner' ||
      !review.directOwnerRequest ||
      !(review.repositoryNow instanceof Date) ||
      !Number.isFinite(review.repositoryNow.getTime())
    )
      return { ok: false, reason: CHANGED };
    const brief = currentBrief(review),
      fingerprint = fingerprintReview(review);
    if (!brief || !fingerprint || brief.maxMinutes > loadConfig().CALL_MAX_MINUTES)
      return { ok: false, reason: CHANGED };
    const issuedAt = review.repositoryNow;
    const grant = parsePhoneCallOwnerActionGrantMatch({
      schemaVersion: 2,
      grantId: randomUUID(),
      action: 'phone.call',
      recipientE164: brief.to,
      maxMinutes: brief.maxMinutes,
      ...limits.data,
      expiresAt: new Date(issuedAt.getTime() + validityDays * DAY_MS).toISOString(),
    });
    if (!grant) return { ok: false, reason: CHANGED };
    const scopeFingerprint = phoneCallOwnerActionGrantScopeFingerprint(grant);
    if (!scopeFingerprint) return { ok: false, reason: CHANGED };
    const registered = await operations.register({
      ownerId: agentId,
      approvalId,
      grantId: grant.grantId,
      taskId: review.task.id,
      toolCallId: review.toolCall.id,
      expectedSlotGeneration: state.kind === 'empty' ? 0 : state.slot.generation,
      requestFingerprint: fingerprint,
      grantScopeFingerprint: scopeFingerprint,
      reviewExpiresAt: new Date(issuedAt.getTime() + REVIEW_TTL_MS),
      grantExpiresAt: new Date(grant.expiresAt),
      replaceUnadmittedRegistration: false,
    });
    if (!registered.ok) return { ok: false, reason: UNKNOWN };
    const operation: OwnerCallOperationBinding = {
      ownerId: agentId,
      approvalId,
      grantId: grant.grantId,
      taskId: review.task.id,
      toolCallId: review.toolCall.id,
      slotGeneration: registered.operation.slotGeneration,
      requestFingerprint: fingerprint,
      grantScopeFingerprint: scopeFingerprint,
    };
    const token: ReviewToken = {
      schemaVersion: 2,
      purpose: PURPOSE,
      ownerId: agentId,
      approvalId,
      taskId: review.task.id,
      toolCallId: review.toolCall.id,
      taskTrust: 'owner',
      sourceArgsFingerprint: fingerprint,
      directOwnerRequest: review.directOwnerRequest as DirectOwnerCallRequestBinding,
      issuedAt: issuedAt.toISOString(),
      reviewExpiresAt: registered.operation.reviewExpiresAt.toISOString(),
      validityDays: validityDays as 1 | 7 | 30,
      grant,
      operation,
    };
    return {
      ok: true,
      reviewToken: encryptStoredCredential(JSON.stringify(token)),
      approvalId,
      brief,
      grant,
      validityDays: token.validityDays,
      reviewExpiresAt: token.reviewExpiresAt,
      ownerTimeZone: validTimeZone(review.ownerTimeZone),
      configuredMaxMinutes: loadConfig().CALL_MAX_MINUTES,
      existingActiveGrants: review.existingActiveGrants,
    };
  } catch {
    return { ok: false, reason: UNKNOWN };
  }
}

/** Never replay FINALIZE: an admitted or committed unknown outcome is recovered by point read. */
export async function approveOwnerCallNumberGrant(
  store: Store,
  approvalId: string,
  reviewToken: string,
  acknowledgement: string,
) {
  if (!enabled())
    return { ok: false as const, reason: 'Reusable owner-number calls are disabled.' };
  if (acknowledgement !== OWNER_CALL_GRANT_ACKNOWLEDGEMENT)
    return { ok: false as const, reason: CHANGED };
  try {
    const identity = await ownerApprovalRepository(store);
    const token = decodeReview(reviewToken, Date.now());
    if (
      !token ||
      token.ownerId !== identity.agentId ||
      token.approvalId !== approvalId ||
      !identity.approvals.ownerCallOperations
    )
      return { ok: false as const, reason: CHANGED };
    const admitted = await identity.approvals.ownerCallOperations.admit(token.operation);
    if (!admitted.ok) return { ok: false as const, reason: UNKNOWN };
    const result = await resolveApproval(identity.approvals, {
      approvalId,
      expectedAgentId: identity.agentId,
      decision: 'approved',
      via: 'web',
      policy: {
        agentId: identity.agentId,
        toolName: 'phone.call',
        templateKey: 'phone.call.owner_action.v2',
        match: token.grant as unknown as Record<string, unknown>,
        effect: 'allow',
      },
      ownerCallActionGrant: {
        expectedApprovalId: token.approvalId,
        expectedAgentId: token.ownerId,
        expectedTaskId: token.taskId,
        expectedToolCallId: token.toolCallId,
        sourceArgsFingerprint: token.sourceArgsFingerprint,
        directOwnerRequest: token.directOwnerRequest,
        reviewIssuedAt: token.issuedAt,
        reviewExpiresAt: token.reviewExpiresAt,
        validityDays: token.validityDays,
        match: token.grant,
        operation: token.operation,
      },
    });
    if (
      !result.ok ||
      result.ownerCallNumberGrant?.grantId !== token.grant.grantId ||
      result.ownerCallNumberGrant.expiresAt !== token.grant.expiresAt
    )
      return { ok: false as const, reason: UNKNOWN };
    return result;
  } catch {
    return { ok: false as const, reason: UNKNOWN };
  }
}

export type OwnerCallGrantOperationStatus =
  | { ok: false; reason: string }
  | { ok: true; status: 'none'; permission: 'unconfirmed'; availability: 'unchecked' }
  | {
      ok: true;
      status: 'registered' | 'admitted' | 'committed' | 'closed_no_effect' | 'rejected_no_effect';
      grantId: string;
      permission: 'saved' | 'not_saved' | 'unconfirmed';
      availability: 'unchecked';
      closeToken: string | null;
      checkedAt: string;
    };

/** Owner-scoped discovery survives cleared storage; absence never resolves an expected operation. */
export async function checkOwnerCallGrantOperation(
  store: Store,
  approvalId: string,
  expectedGrantId?: string,
): Promise<OwnerCallGrantOperationStatus> {
  try {
    const { agentId, approvals } = await ownerApprovalRepository(store);
    const state = await approvals.ownerCallOperations?.discover(agentId, approvalId);
    if (!state || state.kind === 'unavailable' || (state.kind === 'empty' && expectedGrantId))
      return { ok: false, reason: UNKNOWN };
    if (state.kind === 'empty')
      return { ok: true, status: 'none', permission: 'unconfirmed', availability: 'unchecked' };
    const op = state.operation;
    if (expectedGrantId && op.grantId !== expectedGrantId) return { ok: false, reason: UNKNOWN };
    const operation: OwnerCallOperationBinding = {
      ownerId: op.ownerId,
      approvalId: op.approvalId,
      grantId: op.grantId,
      taskId: op.taskId,
      toolCallId: op.toolCallId,
      slotGeneration: op.slotGeneration,
      requestFingerprint: op.requestFingerprint,
      grantScopeFingerprint: op.grantScopeFingerprint,
    };
    const now = new Date();
    const closeToken = ['registered', 'admitted'].includes(op.phase)
      ? encryptStoredCredential(
          JSON.stringify({
            purpose: CLOSE_PURPOSE,
            operation,
            issuedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + REVIEW_TTL_MS).toISOString(),
          }),
        )
      : null;
    return {
      ok: true,
      status: op.phase,
      grantId: op.grantId,
      permission:
        op.phase === 'committed'
          ? 'saved'
          : ['closed_no_effect', 'rejected_no_effect'].includes(op.phase)
            ? 'not_saved'
            : 'unconfirmed',
      availability: 'unchecked',
      closeToken,
      checkedAt: now.toISOString(),
    };
  } catch {
    return { ok: false, reason: UNKNOWN };
  }
}

/** Explicit close affects only this metadata operation; it never denies or cancels a call. */
export async function closeOwnerCallGrantOperation(
  store: Store,
  approvalId: string,
  closeToken: string,
  acknowledgement: string,
) {
  if (acknowledgement !== OWNER_CALL_GRANT_CLOSE_ACKNOWLEDGEMENT || closeToken.length > 16_384)
    return { ok: false as const, reason: CHANGED };
  try {
    const { agentId, approvals } = await ownerApprovalRepository(store);
    const parsed = CloseTokenSchema.safeParse(JSON.parse(decryptStoredCredential(closeToken)));
    if (
      !parsed.success ||
      parsed.data.operation.ownerId !== agentId ||
      parsed.data.operation.approvalId !== approvalId ||
      Date.parse(parsed.data.issuedAt) > Date.now() ||
      Date.parse(parsed.data.expiresAt) <= Date.now() ||
      Date.parse(parsed.data.expiresAt) !== Date.parse(parsed.data.issuedAt) + REVIEW_TTL_MS ||
      !approvals.ownerCallOperations
    )
      return { ok: false as const, reason: CHANGED };
    const result = await approvals.ownerCallOperations.close(parsed.data.operation);
    return result.ok
      ? checkOwnerCallGrantOperation(store, approvalId, parsed.data.operation.grantId)
      : { ok: false as const, reason: UNKNOWN };
  } catch {
    return { ok: false as const, reason: UNKNOWN };
  }
}
